import { describe, expect, it, vi } from "vitest";
import {
  type BrowserContextHandle,
  type BrowserFetch,
  type BrowserLauncher,
  BrowserSession,
} from "../extensions/web-tools/fetchers/local/browser-session.ts";

class EscalationRequired extends Error {}

class FakeContext implements BrowserContextHandle {
  readonly closed = deferred<void>();
  private readonly closeListeners: Array<() => void> = [];
  closeCount = 0;

  constructor(
    readonly headless: boolean,
    readonly userAgent: string | undefined,
  ) {}

  on(event: "close", listener: () => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    if (this.closeCount > 0) return;
    this.closeCount += 1;
    for (const listener of this.closeListeners) listener();
    this.closed.resolve();
  }
}

class FakeLauncher implements BrowserLauncher<FakeContext> {
  readonly launches: FakeContext[] = [];
  readonly launchCalls: Array<{ headless: boolean; userAgent: string | undefined }> = [];
  probeResult: string | null = "Chrome/1";
  nextLaunch: Promise<FakeContext> | null = null;
  nextLaunchError: Error | null = null;

  async launch(headless: boolean, userAgent?: string): Promise<FakeContext> {
    this.launchCalls.push({ headless, userAgent });
    if (this.nextLaunch) {
      const launch = this.nextLaunch;
      this.nextLaunch = null;
      const context = await launch;
      this.launches.push(context);
      return context;
    }
    if (this.nextLaunchError) {
      const error = this.nextLaunchError;
      this.nextLaunchError = null;
      throw error;
    }
    const context = new FakeContext(headless, userAgent);
    this.launches.push(context);
    return context;
  }

  async probeUserAgent(): Promise<string | null> {
    return this.probeResult;
  }
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSession(
  launcher: FakeLauncher,
  options: { maxConcurrentPages?: number; onInteractiveStateChange?(open: boolean): void } = {},
): BrowserSession<FakeContext> {
  return new BrowserSession({
    launcher,
    maxConcurrentPages: options.maxConcurrentPages ?? 2,
    interactiveConflictMessage: "interactive conflict",
    headlessLaunchError: (error) => new Error(`headless: ${message(error)}`),
    headedLaunchError: (error) => new Error(`headed: ${message(error)}`),
    interactiveLaunchError: (error) => new Error(`interactive: ${message(error)}`),
    ...(options.onInteractiveStateChange
      ? { onInteractiveStateChange: options.onInteractiveStateChange }
      : {}),
  });
}

function operation<Result>(
  onStarted: () => void,
  headless: (context: FakeContext) => Promise<Result>,
  headed: (context: FakeContext) => Promise<Result> = headless,
): BrowserFetch<FakeContext, Result> {
  return {
    onStarted,
    headless,
    headed,
    shouldEscalate: (error) => error instanceof EscalationRequired,
  };
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("BrowserSession", () => {
  it("hands a released page slot directly to the oldest waiter", async () => {
    const launcher = new FakeLauncher();
    const session = createSession(launcher);
    const started: string[] = [];
    const work = [deferred<string>(), deferred<string>(), deferred<string>()];

    const fetches = work.map((result, index) =>
      session.fetch(
        operation(
          () => started.push(String(index)),
          () => result.promise,
        ),
      ),
    );

    await until(() => started.length === 2);
    expect(started).toEqual(["0", "1"]);

    work[0]?.resolve("zero");
    await until(() => started.length === 3);
    expect(started).toEqual(["0", "1", "2"]);

    work[1]?.resolve("one");
    work[2]?.resolve("two");
    await expect(Promise.all(fetches)).resolves.toEqual(["zero", "one", "two"]);
  });

  it("drains peers, blocks new fetches during escalation, then releases them", async () => {
    const launcher = new FakeLauncher();
    const session = createSession(launcher);
    const challenge = deferred<string>();
    const peer = deferred<string>();
    const headed = deferred<string>();
    const newcomer = deferred<string>();
    const started: string[] = [];

    const challengedFetch = session.fetch(
      operation(
        () => started.push("challenge"),
        () => challenge.promise,
        () => headed.promise,
      ),
    );
    const peerFetch = session.fetch(
      operation(
        () => started.push("peer"),
        () => peer.promise,
      ),
    );
    await until(() => started.length === 2);

    challenge.reject(new EscalationRequired());
    await flushMicrotasks();
    const newcomerFetch = session.fetch(
      operation(
        () => started.push("newcomer"),
        () => newcomer.promise,
      ),
    );
    await Promise.resolve();
    expect(started).toEqual(["challenge", "peer"]);

    peer.resolve("peer result");
    await until(() => launcher.launchCalls.some((call) => !call.headless));
    expect(started).toEqual(["challenge", "peer"]);

    headed.resolve("headed result");
    await until(() => started.includes("newcomer"));
    newcomer.resolve("new result");

    await expect(Promise.all([challengedFetch, peerFetch, newcomerFetch])).resolves.toEqual([
      "headed result",
      "peer result",
      "new result",
    ]);
  });

  it("releases the escalation gate when headed launch fails", async () => {
    const launcher = new FakeLauncher();
    const session = createSession(launcher);
    const challenge = deferred<string>();
    const newcomer = deferred<string>();
    let newcomerStarted = false;

    const challengedFetch = session.fetch(
      operation(
        () => {},
        () => challenge.promise,
      ),
    );
    await until(() => launcher.launchCalls.length === 1);
    launcher.nextLaunchError = new Error("no display");
    challenge.reject(new EscalationRequired());
    await expect(challengedFetch).rejects.toThrow("headed: no display");

    const newcomerFetch = session.fetch(
      operation(
        () => {
          newcomerStarted = true;
        },
        () => newcomer.promise,
      ),
    );
    await until(() => newcomerStarted);
    newcomer.resolve("recovered");
    await expect(newcomerFetch).resolves.toBe("recovered");
  });

  it("lets the second simultaneous challenge retry headless after one escalation", async () => {
    const launcher = new FakeLauncher();
    const session = createSession(launcher);
    const attempts = new Map<string, number>();
    let headedCalls = 0;

    const fetchOne = (name: string) =>
      session.fetch(
        operation(
          () => {},
          async () => {
            const attempt = (attempts.get(name) ?? 0) + 1;
            attempts.set(name, attempt);
            if (attempt === 1) throw new EscalationRequired();
            return `${name} headless`;
          },
          async () => {
            headedCalls += 1;
            return `${name} headed`;
          },
        ),
      );

    const results = await Promise.all([fetchOne("first"), fetchOne("second")]);

    expect(headedCalls).toBe(1);
    expect(results.filter((result) => result.endsWith(" headed"))).toHaveLength(1);
    expect(results.filter((result) => result.endsWith(" headless"))).toHaveLength(1);
  });

  it("rejects every request sharing a failed headless launch", async () => {
    const launcher = new FakeLauncher();
    const launch = deferred<FakeContext>();
    launcher.nextLaunch = launch.promise;
    const session = createSession(launcher, { maxConcurrentPages: 1 });

    const fetches = Array.from({ length: 3 }, () =>
      session.fetch(
        operation(
          () => {},
          async () => "unreachable",
        ),
      ),
    );
    await until(() => launcher.launchCalls.length === 1);
    launch.reject(new Error("boom"));

    const results = await Promise.allSettled(fetches);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(message(result.reason)).toBe("headless: boom");
    }
    expect(launcher.launchCalls).toHaveLength(1);
  });

  it("moves active work to interactive ownership until that browser closes", async () => {
    const launcher = new FakeLauncher();
    const states: boolean[] = [];
    const session = createSession(launcher, {
      onInteractiveStateChange: (open) => states.push(open),
    });

    const activeFetch = session.fetch(
      operation(
        () => {},
        async (context) => {
          await context.closed.promise;
          throw new Error("context closed");
        },
      ),
    );
    await until(() => launcher.launches.length === 1);

    await session.openInteractive();
    expect(session.isInteractiveOpen).toBe(true);
    await expect(activeFetch).rejects.toThrow("context closed");
    await expect(
      session.fetch(
        operation(
          () => {},
          async () => "unreachable",
        ),
      ),
    ).rejects.toThrow("interactive conflict");

    const interactive = launcher.launches.at(-1);
    await interactive?.close();
    expect(session.isInteractiveOpen).toBe(false);
    await expect(
      session.fetch(
        operation(
          () => {},
          async () => "resumed",
        ),
      ),
    ).resolves.toBe("resumed");
    expect(states).toEqual([true, false]);
  });

  it("normalizes HeadlessChrome once and reuses the resulting user agent", async () => {
    const launcher = new FakeLauncher();
    launcher.probeResult = "Mozilla HeadlessChrome/123";
    const session = createSession(launcher);

    await session.fetch(
      operation(
        () => {},
        async () => "first",
      ),
    );
    await session.close();
    await session.fetch(
      operation(
        () => {},
        async () => "second",
      ),
    );

    expect(launcher.launchCalls).toEqual([
      { headless: true, userAgent: undefined },
      { headless: true, userAgent: "Mozilla Chrome/123" },
      { headless: true, userAgent: "Mozilla Chrome/123" },
    ]);
  });
});
