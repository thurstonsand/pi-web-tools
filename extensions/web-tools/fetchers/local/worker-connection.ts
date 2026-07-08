import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { basename, delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { FetchBrowserSettings } from "../../settings.ts";
import {
  ensureFetchWorkerDir,
  getFetchWorkerPidPath,
  getFetchWorkerSocketPath,
  getFetchWorkerSpawnLockPath,
  type WorkerEvent,
  type WorkerFetchResult,
  type WorkerRequest,
} from "./worker-protocol.ts";

const WORKER_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "fetch-worker.ts");
const SPAWN_CONNECT_ATTEMPTS = 30; // x100ms
const SPAWN_LOCK_STALE_MS = 10_000;
// Comfortably above the worker's 15s navigation timeout; a request that blows
// past this is a zombie worker, not a slow page.
const REQUEST_DEADLINE_MS = 60_000;

export interface FetchWorkerClient {
  fetch(url: string, downloadDir: string): Promise<WorkerFetchResult>;
  openBrowser(): Promise<void>;
}

// pi ships as a compiled binary, so process.execPath points at pi, not node.
// Spawning it would relaunch pi with fetch-worker.ts as a prompt. Resolve a
// real node interpreter instead.
function resolveNode(): string | null {
  if (basename(process.execPath).toLowerCase().startsWith("node")) {
    return process.execPath;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Cross-session spawn lock
function acquireSpawnLock(): boolean {
  ensureFetchWorkerDir();
  const lockPath = getFetchWorkerSpawnLockPath();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isSpawnLockStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {}
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(lockPath: string): boolean {
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(lockPath, "utf8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    return !Number.isFinite(createdAt) || Date.now() - createdAt > SPAWN_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(getFetchWorkerSpawnLockPath());
  } catch {}
}

type PendingRequest = {
  resolve: (event: WorkerEvent) => void;
  reject: (error: Error) => void;
  deadline: NodeJS.Timeout;
};

export function createFetchWorkerClient(settings: FetchBrowserSettings): FetchWorkerClient {
  const socketPath = getFetchWorkerSocketPath();
  let sock: Socket | null = null;
  let connecting: Promise<Socket> | null = null;
  const pending = new Map<string, PendingRequest>();

  function connectOnce(): Promise<Socket | null> {
    return new Promise((resolve) => {
      const candidate = connect(socketPath, () => resolve(candidate));
      candidate.on("error", () => {
        if (sock === candidate) sock = null;
        resolve(null);
      });
      candidate.on("close", () => {
        if (sock === candidate) sock = null;
        failAllPending(new Error("fetch worker connection closed"));
      });
    });
  }

  function attachReader(socket: Socket): void {
    const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    rl.on("line", (line) => {
      let event: WorkerEvent;
      try {
        event = JSON.parse(line) as WorkerEvent;
      } catch {
        return;
      }
      if (event.event === "status") return;
      const request = pending.get(event.id);
      if (!request) return;
      pending.delete(event.id);
      clearTimeout(request.deadline);
      request.resolve(event);
    });
  }

  function failAllPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.deadline);
      request.reject(error);
    }
    pending.clear();
  }

  async function ensureConnected(): Promise<Socket> {
    if (sock && !sock.destroyed) return sock;
    // Single-flight: a batch fires its URLs concurrently, and each one racing
    // through here would spawn its own worker.
    connecting ??= establishConnection().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function establishConnection(): Promise<Socket> {
    let socket = await connectOnce();
    if (!socket) {
      const spawnedHere = acquireSpawnLock();
      try {
        if (spawnedHere) {
          const node = resolveNode();
          if (!node) throw new Error("no node interpreter found to spawn the fetch worker");
          const child = spawn(
            node,
            [
              WORKER_PATH,
              settings.profileDir,
              ...(settings.executablePath ? [settings.executablePath] : []),
            ],
            { detached: true, stdio: "ignore" },
          );
          child.unref();
        }
        for (let attempt = 0; attempt < SPAWN_CONNECT_ATTEMPTS && !socket; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          socket = await connectOnce();
        }
        if (!socket) throw new Error("fetch worker did not start");
      } finally {
        if (spawnedHere) releaseSpawnLock();
      }
    }

    sock = socket;
    attachReader(socket);
    return socket;
  }

  async function terminateWorker(): Promise<void> {
    sock?.destroy();
    sock = null;
    try {
      const pid = Number.parseInt(await readFile(getFetchWorkerPidPath(), "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch {}
  }

  async function request(payload: WorkerRequest): Promise<WorkerEvent> {
    const socket = await ensureConnected();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        pending.delete(payload.id);
        // A hung worker would stall every later request too; put it down so
        // the next fetch respawns clean.
        void terminateWorker();
        reject(new Error(`fetch worker did not respond within ${REQUEST_DEADLINE_MS / 1000}s`));
      }, REQUEST_DEADLINE_MS);
      pending.set(payload.id, { resolve, reject, deadline });
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  }

  return {
    async fetch(url, downloadDir) {
      const event = await request({ id: randomUUID(), op: "fetch", url, downloadDir });
      if (event.event === "error") throw new Error(event.reason);
      if (event.event !== "result" || event.op !== "fetch") {
        throw new Error("fetch worker returned a malformed result");
      }
      const { id, event: _event, op, ...result } = event;
      return result;
    },
    async openBrowser() {
      const event = await request({ id: randomUUID(), op: "open-browser" });
      if (event.event === "error") throw new Error(event.reason);
    },
  };
}
