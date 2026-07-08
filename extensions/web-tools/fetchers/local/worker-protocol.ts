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

export type WorkerRequest =
  | { id: string; op: "fetch"; url: string; downloadDir: string }
  | { id: string; op: "open-browser" };

export interface WorkerStatusEvent {
  id: string;
  event: "status";
  stage: string;
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
  | FetchResultEvent
  | OpenBrowserResultEvent
  | WorkerErrorEvent;
