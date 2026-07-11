import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getFetchWorkerDir(): string {
  return join(homedir(), ".pi", "agent", "fetch-worker");
}

export function ensureFetchWorkerDir(): string {
  const dir = getFetchWorkerDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function getFetchWorkerSocketPath(): string {
  return join(getFetchWorkerDir(), "worker.sock");
}

export function getFetchWorkerPidPath(): string {
  return join(getFetchWorkerDir(), "worker.pid");
}

export function getFetchWorkerSpawnLockPath(): string {
  return join(getFetchWorkerDir(), "spawn.lock");
}

// Passed to the worker as a single JSON argv; settings changes apply when the
// worker next restarts (idle exit), matching executablePath behavior.
export interface WorkerConfig {
  profileDir: string;
  executablePath?: string;
  challenge: WorkerChallengeConfig;
}

export interface WorkerChallengeConfig {
  escalation: "headed" | "never";
  headlessWaitSecs: number;
  headedWaitSecs: number;
}

export type WorkerRequest =
  | { id: string; op: "fetch"; url: string; downloadDir: string }
  | { id: string; op: "open-browser" };

// "queued" on receipt; "started" once past the worker's page slots and any
// escalation gate — the client's request deadline arms on "started", sized by
// budgetSecs: the total challenge budget this worker will honor. The worker is
// canonical for retrieval timing — its config may predate the client's current
// settings, or come from another session entirely.
export type WorkerStatusEvent =
  | { id: string; event: "status"; stage: "queued" }
  | { id: string; event: "status"; stage: "started"; budgetSecs: number };

// Sent every few seconds per connection; the worker proves its own liveness
// independently of how long its work takes. A client with pending requests
// treats prolonged total silence as a wedged worker.
export interface WorkerHeartbeatEvent {
  event: "heartbeat";
}

export interface WorkerFetchResult {
  finalUrl: string;
  file: string;
  contentType: string;
  bytes: number;
  title?: string;
}

export interface FetchResultEvent extends WorkerFetchResult {
  id: string;
  event: "result";
  op: "fetch";
}

export interface OpenBrowserResultEvent {
  id: string;
  event: "result";
  op: "open-browser";
}

export interface WorkerErrorEvent {
  id: string;
  event: "error";
  reason: string;
}

export type WorkerEvent =
  | WorkerStatusEvent
  | WorkerHeartbeatEvent
  | FetchResultEvent
  | OpenBrowserResultEvent
  | WorkerErrorEvent;
