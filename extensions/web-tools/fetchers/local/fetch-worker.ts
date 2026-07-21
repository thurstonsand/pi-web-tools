import { unlinkSync, writeFileSync } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
// This file runs as a standalone process via `node fetch-worker.ts`, never
// through pi's loader: the host process must not import a browser driver
// (jiti under bun crashes on its transitive import tree), so playwright-core
// lives here and nowhere else. Runtime imports must name the real `.ts` file
// for Node to resolve.
import {
  type BrowserContext,
  chromium,
  type Download,
  type Page,
  type Response,
} from "playwright-core";
import { BrowserSession } from "./browser-session.ts";
import { throwForHttpError } from "./http-status.ts";
import {
  ensureFetchWorkerDir,
  getFetchWorkerPidPath,
  getFetchWorkerSocketPath,
  type WorkerConfig,
  type WorkerEvent,
  type WorkerFetchResult,
  type WorkerRequest,
} from "./worker-protocol.ts";

ensureFetchWorkerDir();

const SOCK = getFetchWorkerSocketPath();
const PIDFILE = getFetchWorkerPidPath();
const NAVIGATION_TIMEOUT_MS = 15_000; // 15s
const NETWORK_IDLE_GRACE_MS = 2_000; // 2s
const IDLE_EXIT_MS = 5 * 60 * 1000; // 5min
const MAX_CONCURRENT_PAGES = 6;
const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024; // 100MB

const configArg = process.argv[2];
if (!configArg) {
  console.error("usage: node fetch-worker.ts <config-json>");
  process.exit(1);
}
const config = JSON.parse(configArg) as WorkerConfig;
const { profileDir, executablePath } = config;

// ── browser ───────────────────────────────────────────────────────────────────

async function probeUserAgent(context: BrowserContext): Promise<string | null> {
  try {
    const page = await context.newPage();
    const userAgent = await Promise.race([
      page.evaluate(() => navigator.userAgent),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    await page.close().catch(() => {});
    return userAgent;
  } catch {
    return null;
  }
}

async function launchPersistent(headless: boolean, userAgent?: string): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless,
    acceptDownloads: true,
    ...(userAgent ? { userAgent } : {}),
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
  });
}

const browserSession = new BrowserSession<BrowserContext>({
  launcher: {
    launch: launchPersistent,
    probeUserAgent,
  },
  maxConcurrentPages: MAX_CONCURRENT_PAGES,
  interactiveConflictMessage: "interactive browser is open — quit Chrome to resume fetching",
  headlessLaunchError: (error) =>
    new Error(
      `could not launch browser: ${errorMessage(error)}` +
        (executablePath
          ? ""
          : " — install Google Chrome or set webTools.fetch.browser.executablePath"),
    ),
  headedLaunchError: (error) =>
    new Error(`${CHALLENGE_BLOCKED_MESSAGE} (headed escalation failed: ${errorMessage(error)})`),
  interactiveLaunchError: (error) =>
    new Error(`could not open the interactive browser: ${errorMessage(error)}`),
  onInteractiveStateChange: (open) => {
    if (open && idleTimer) clearTimeout(idleTimer);
    if (!open) resetIdleTimer();
  },
});

// ── fetching ──────────────────────────────────────────────────────────────────

async function handleFetch(
  url: string,
  downloadDir: string,
  onStarted: () => void,
): Promise<WorkerFetchResult> {
  await mkdir(downloadDir, { recursive: true });
  return browserSession.fetch({
    onStarted,
    shouldEscalate: (error) => error instanceof ChallengeUnresolvedError,
    headless: (context) =>
      fetchInContext(context, url, downloadDir, {
        waitSecs: config.challenge.headlessWaitSecs,
        escalatable: config.challenge.escalation === "headed",
      }),
    headed: (context) => {
      const startedAt = Date.now();
      return fetchInContext(context, url, downloadDir, {
        waitSecs: config.challenge.headedWaitSecs,
        startedAt,
        escalatable: false,
      });
    },
  });
}

async function fetchInContext(
  context: BrowserContext,
  url: string,
  downloadDir: string,
  challengeWait: ChallengeWait,
): Promise<WorkerFetchResult> {
  const page = await context.newPage();
  try {
    return await fetchWithPage(page, url, downloadDir, challengeWait);
  } finally {
    await page.close().catch(() => {});
  }
}

interface ChallengeWait {
  waitSecs: number;
  // When set, the budget clock started here (headed attempts: at navigation,
  // since the whole attempt exists only because of the challenge). Otherwise
  // it starts at challenge detection.
  startedAt?: number;
  escalatable: boolean;
}

async function fetchWithPage(
  page: Page,
  url: string,
  downloadDir: string,
  challengeWait: ChallengeWait,
): Promise<WorkerFetchResult> {
  const downloadPromise = page
    .waitForEvent("download", { timeout: NAVIGATION_TIMEOUT_MS })
    .catch(() => null);

  let response: Response | null;
  try {
    response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  } catch (error) {
    // A response that becomes a download aborts navigation; anything else is a
    // real failure.
    const download = await downloadPromise;
    if (!download) throw error;
    return saveDownload(download, downloadDir);
  }
  if (!response) throw new Error("navigation returned no response");

  if (response.headers()["cf-mitigated"] === "challenge") {
    const deadlineAt = (challengeWait.startedAt ?? Date.now()) + challengeWait.waitSecs * 1000;
    response = await resolveChallenge(page, deadlineAt, challengeWait.escalatable);
  }

  const finalUrl = page.url();
  throwForHttpError(response.status(), finalUrl);

  // Route on document.contentType, not the response header: the header is set
  // at the whims of the delivery mechanism (react.dev's service worker serves
  // navigations with no content-type at all), while document.contentType is
  // literally the MIME type the renderer committed to when parsing the
  // document — including "application/pdf" inside the PDF viewer.
  const contentType =
    (await page.evaluate(() => document.contentType).catch(() => null)) ??
    (await response.headerValue("content-type")) ??
    "";

  if (isHtmlContentType(contentType)) {
    // Give SPAs a moment to settle, but never fail a page over lingering
    // network activity.
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_GRACE_MS }).catch(() => {});
    const html = await capturePageHtml(page);
    const bytes = Buffer.byteLength(html, "utf8");
    assertWithinCap(bytes);
    const file = path.join(downloadDir, "page.html");
    await writeFile(file, html);
    const title = (await page.title()).trim();
    return { finalUrl, file, contentType, bytes, ...(title ? { title } : {}) };
  }

  // The rendered page for a non-HTML response is Chrome's viewer shim (e.g.
  // the PDF embedder), not the payload. Refetch the real bytes through the
  // context's request client, which shares the profile's cookies.
  const apiResponse = await page
    .context()
    .request.get(finalUrl, { timeout: NAVIGATION_TIMEOUT_MS });
  throwForHttpError(apiResponse.status(), finalUrl);
  const body = await apiResponse.body();
  assertWithinCap(body.byteLength);
  const headers = apiResponse.headers();
  const file = path.join(downloadDir, payloadFilename(headers["content-disposition"], finalUrl));
  await writeFile(file, body);
  return {
    finalUrl,
    file,
    contentType: headers["content-type"] ?? contentType,
    bytes: body.byteLength,
  };
}

const CHALLENGE_BLOCKED_MESSAGE =
  "blocked by a bot-detection challenge (cloudflare) — run `/browser open` to resolve it manually";

class ChallengeUnresolvedError extends Error {
  constructor() {
    super(CHALLENGE_BLOCKED_MESSAGE);
  }
}

// Cloudflare marks challenge interstitials with a `cf-mitigated: challenge`
// response header. Success triggers a fresh main-frame navigation without the
// header — the same signal as detection, so no title or body heuristics. A
// failing challenge produces no "gave up" signal; the wait budget is the only
// honest terminator. The budget is one merged clock: the challenge wait and
// the post-resolution load draw from the same deadline, so a fast step's
// leftover spills into the next.
async function resolveChallenge(
  page: Page,
  deadlineAt: number,
  escalatable: boolean,
): Promise<Response> {
  const remainingMs = () => Math.max(deadlineAt - Date.now(), 1);
  const response = await page
    .waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        response.frame() === page.mainFrame() &&
        response.headers()["cf-mitigated"] !== "challenge",
      { timeout: remainingMs() },
    )
    .catch(() => null);
  if (!response) {
    if (escalatable) throw new ChallengeUnresolvedError();
    throw new Error(CHALLENGE_BLOCKED_MESSAGE);
  }
  await page.waitForLoadState("load", { timeout: remainingMs() }).catch(() => {});
  return response;
}

async function handleOpenBrowser(): Promise<void> {
  await browserSession.openInteractive();
}

// Hydrated pages park content in open shadow roots that page.content() cannot
// see; getHTML serializes them as declarative shadow templates, which the
// extractor unwraps. Feature-detected: older Chrome falls back to the plain
// serialization.
async function capturePageHtml(page: Page): Promise<string> {
  const pierced = await page
    .evaluate(() => {
      if (typeof document.documentElement.getHTML !== "function") return null;
      const collect = (root: Document | ShadowRoot, acc: ShadowRoot[]): ShadowRoot[] => {
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            acc.push(el.shadowRoot);
            collect(el.shadowRoot, acc);
          }
        }
        return acc;
      };
      return document.documentElement.getHTML({ shadowRoots: collect(document, []) });
    })
    .catch(() => null);
  return pierced ?? (await page.content());
}

async function saveDownload(download: Download, downloadDir: string): Promise<WorkerFetchResult> {
  const file = path.join(downloadDir, sanitizeFilename(download.suggestedFilename()));
  await download.saveAs(file);
  const { size } = await stat(file);
  if (size > MAX_PAYLOAD_BYTES) {
    await unlink(file).catch(() => {});
    throw new Error(`response is ${size} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  return {
    finalUrl: download.url(),
    file,
    contentType: "application/octet-stream",
    bytes: size,
  };
}

function isHtmlContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}

function assertWithinCap(bytes: number): void {
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`response is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
}

function payloadFilename(disposition: string | undefined, finalUrl: string): string {
  const dispositionName = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  if (dispositionName) return sanitizeFilename(decodeURIComponent(dispositionName));
  try {
    const urlName = path.posix.basename(new URL(finalUrl).pathname);
    if (urlName) return sanitizeFilename(urlName);
  } catch {}
  return "download";
}

function sanitizeFilename(name: string): string {
  const cleaned = path.basename(name.trim()).replace(/[/\\]/g, "-");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

let inflight = 0;
let idleTimer: NodeJS.Timeout | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  // A login session must never be killed by the idle timer; the interactive
  // context's close event re-arms it.
  if (browserSession.isInteractiveOpen) return;
  idleTimer = setTimeout(() => {
    if (inflight > 0) {
      resetIdleTimer();
      return;
    }
    void shutdown(0);
  }, IDLE_EXIT_MS);
}

let cleanedUp = false;
async function shutdown(code: number): Promise<never> {
  if (!cleanedUp) {
    cleanedUp = true;
    server.close();
    for (const file of [SOCK, PIDFILE]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    await browserSession.close();
  }
  process.exit(code);
}

// ── socket server ─────────────────────────────────────────────────────────────

function send(socket: Socket, event: WorkerEvent): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
}

async function handleRequest(socket: Socket, request: WorkerRequest): Promise<void> {
  if (request.op === "fetch") {
    inflight += 1;
    resetIdleTimer();
    send(socket, { id: request.id, event: "status", stage: "queued" });
    try {
      const completion = await handleFetch(request.url, request.downloadDir, () =>
        send(socket, {
          id: request.id,
          event: "status",
          stage: "started",
          budgetSecs: config.challenge.headlessWaitSecs + config.challenge.headedWaitSecs,
        }),
      );
      send(socket, { id: request.id, event: "result", op: "fetch", ...completion });
    } catch (error) {
      send(socket, { id: request.id, event: "error", reason: errorMessage(error) });
    } finally {
      inflight -= 1;
      resetIdleTimer();
    }
    return;
  }
  if (request.op === "open-browser") {
    try {
      await handleOpenBrowser();
      send(socket, { id: request.id, event: "result", op: "open-browser" });
    } catch (error) {
      send(socket, { id: request.id, event: "error", reason: errorMessage(error) });
    }
    return;
  }
  // Unreachable for well-typed requests, but the wire is not the type system.
  const { id, op } = request as { id: string; op: string };
  send(socket, { id, event: "error", reason: `unknown op: ${op}` });
}

// Spawn races between sessions resolve here: if a live worker already answers
// on the socket, this instance is the loser and exits instead of stealing the
// socket path out from under the winner. Only a dead worker's stale socket
// gets cleaned up.
const existingWorkerAnswered = await new Promise<boolean>((resolve) => {
  const probe = connect(SOCK, () => {
    probe.destroy();
    resolve(true);
  });
  probe.on("error", () => resolve(false));
});
if (existingWorkerAnswered) process.exit(0);
try {
  unlinkSync(SOCK);
} catch {}

const HEARTBEAT_INTERVAL_MS = 5_000;

const server = createServer((socket) => {
  const heartbeat = setInterval(() => send(socket, { event: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  socket.on("close", () => clearInterval(heartbeat));
  const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    let request: WorkerRequest;
    try {
      request = JSON.parse(line) as WorkerRequest;
    } catch {
      return;
    }
    void handleRequest(socket, request);
  });
  socket.on("error", () => {});
});

// Losing a bind race (another worker grabbed the socket between the probe and
// here) is a normal outcome, not a crash.
server.on("error", () => process.exit(0));

server.listen(SOCK, () => {
  writeFileSync(PIDFILE, `${process.pid}\n`);
  resetIdleTimer();
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
