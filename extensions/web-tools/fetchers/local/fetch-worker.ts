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
import {
  ensureFetchWorkerDir,
  getFetchWorkerPidPath,
  getFetchWorkerSocketPath,
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

const profileDirArg = process.argv[2];
const executablePath = process.argv[3];
if (!profileDirArg) {
  console.error("usage: node fetch-worker.ts <profileDir> [executablePath]");
  process.exit(1);
}
const profileDir = profileDirArg;

// ── browser ───────────────────────────────────────────────────────────────────

let contextPromise: Promise<BrowserContext> | null = null;
let interactiveContext: BrowserContext | null = null;
let interactiveOpen = false;

async function getContext(): Promise<BrowserContext> {
  contextPromise ??= launchContext();
  try {
    return await contextPromise;
  } catch (error) {
    contextPromise = null;
    throw error;
  }
}

async function launchContext(): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      acceptDownloads: true,
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
    });
    context.on("close", () => {
      contextPromise = null;
    });
    return context;
  } catch (error) {
    throw new Error(
      `could not launch browser: ${errorMessage(error)}` +
        (executablePath
          ? ""
          : " — install Google Chrome or set webTools.fetch.browser.executablePath"),
    );
  }
}

// ── page slots ────────────────────────────────────────────────────────────────

let availableSlots = MAX_CONCURRENT_PAGES;
const slotWaiters: Array<() => void> = [];

async function withPageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (availableSlots > 0) {
    availableSlots -= 1;
  } else {
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  }
  try {
    return await work();
  } finally {
    const next = slotWaiters.shift();
    if (next) next();
    else availableSlots += 1;
  }
}

// ── fetching ──────────────────────────────────────────────────────────────────

async function handleFetch(url: string, downloadDir: string): Promise<WorkerFetchResult> {
  if (interactiveOpen) {
    throw new Error("interactive browser is open — quit Chrome to resume fetching");
  }
  const context = await getContext();
  await mkdir(downloadDir, { recursive: true });
  return withPageSlot(async () => {
    const page = await context.newPage();
    try {
      return await fetchWithPage(page, url, downloadDir);
    } finally {
      await page.close().catch(() => {});
    }
  });
}

async function fetchWithPage(
  page: Page,
  url: string,
  downloadDir: string,
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

  // Route on document.contentType, not the response header: the header is set
  // at the whims of the delivery mechanism (react.dev's service worker serves
  // navigations with no content-type at all), while document.contentType is
  // literally the MIME type the renderer committed to when parsing the
  // document — including "application/pdf" inside the PDF viewer.
  const contentType =
    (await page.evaluate(() => document.contentType).catch(() => null)) ??
    (await response.headerValue("content-type")) ??
    "";
  const finalUrl = page.url();

  if (isHtmlContentType(contentType)) {
    // Give SPAs a moment to settle, but never fail a page over lingering
    // network activity.
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_GRACE_MS }).catch(() => {});
    const html = await page.content();
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
  if (!apiResponse.ok()) {
    throw new Error(`HTTP ${apiResponse.status()} while downloading ${finalUrl}`);
  }
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

// The persistent profile admits one browser instance, so the headless context
// must close before the headed one launches. The context's close event — fired
// when the user quits Chrome — is what resumes normal operation.
async function handleOpenBrowser(): Promise<void> {
  if (interactiveOpen) {
    throw new Error("interactive browser is already open");
  }
  const headless = contextPromise ? await contextPromise.catch(() => null) : null;
  contextPromise = null;
  await headless?.close().catch(() => {});

  interactiveOpen = true;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    interactiveContext = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      acceptDownloads: true,
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
    });
    interactiveContext.on("close", () => {
      interactiveContext = null;
      interactiveOpen = false;
      resetIdleTimer();
    });
  } catch (error) {
    interactiveOpen = false;
    resetIdleTimer();
    throw new Error(`could not open the interactive browser: ${errorMessage(error)}`);
  }
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
  if (interactiveOpen) return;
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
    if (contextPromise) {
      const context = await contextPromise.catch(() => null);
      await context?.close().catch(() => {});
    }
    await interactiveContext?.close().catch(() => {});
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
    send(socket, { id: request.id, event: "status", stage: "fetching" });
    try {
      const completion = await handleFetch(request.url, request.downloadDir);
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

const server = createServer((socket) => {
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
