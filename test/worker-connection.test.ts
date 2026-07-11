import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("node:net", () => ({
  connect: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { createFetchWorkerClient } from "../extensions/web-tools/fetchers/local/worker-connection.ts";

class FakeSocket extends Duplex {
  readonly writes: string[] = [];

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk.toString());
    callback();
  }

  feed(event: unknown): void {
    this.push(`${JSON.stringify(event)}\n`);
  }
}

const settings = () => ({
  browser: {
    executablePath: undefined,
    profileDir: "/tmp/browser-session-test-profile",
  },
  challenge: {
    escalation: "headed" as const,
    headlessWaitSecs: 10,
    headedWaitSecs: 20,
  },
});

function connectTo(socket: FakeSocket): void {
  vi.mocked(connect).mockImplementation(((_path: string, listener: () => void) => {
    queueMicrotask(listener);
    return socket;
  }) as unknown as typeof connect);
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true));
}

describe("fetch worker connection liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(connect).mockReset();
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockRejectedValue(new Error("no pid"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("terminates a silent worker with a pending request", async () => {
    const socket = new FakeSocket();
    connectTo(socket);
    const client = createFetchWorkerClient(settings);

    const fetch = client.fetch("https://example.com", "/tmp/worker-connection-test");
    const rejection = expect(fetch).rejects.toThrow("fetch worker connection closed");
    await until(() => socket.writes.length === 1);

    await vi.advanceTimersByTimeAsync(20_001);

    await rejection;
    expect(socket.destroyed).toBe(true);
  });

  it("keeps a slow worker alive while heartbeats continue", async () => {
    const socket = new FakeSocket();
    connectTo(socket);
    const client = createFetchWorkerClient(settings);

    const fetch = client.fetch("https://example.com", "/tmp/worker-connection-test");
    await until(() => socket.writes.length === 1);

    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      socket.feed({ event: "heartbeat" });
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.destroyed).toBe(false);
    }
    socket.feed({
      id: JSON.parse(socket.writes[0] ?? "{}").id,
      event: "result",
      op: "fetch",
      finalUrl: "https://example.com/",
      file: "/tmp/worker-connection-test/page.html",
      contentType: "text/html",
      bytes: 1,
    });

    await expect(fetch).resolves.toMatchObject({ finalUrl: "https://example.com/" });
    expect(socket.destroyed).toBe(false);
  });

  it("waits for the old worker to exit before restart completes", async () => {
    vi.mocked(readFile).mockResolvedValue("321\n" as never);
    let aliveChecks = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        aliveChecks += 1;
        if (aliveChecks >= 3) throw new Error("ESRCH");
      }
      return true;
    });
    const client = createFetchWorkerClient(settings);

    let completed = false;
    const restart = client.restart().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    await restart;

    expect(kill).toHaveBeenCalledWith(321, "SIGTERM");
    expect(aliveChecks).toBe(3);
  });
});
