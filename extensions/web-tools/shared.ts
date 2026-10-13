import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentBody, FetchWarning } from "./contract.ts";

export const TMP_DIR = "/tmp/pi-fetch";

export interface ToolTimingState {
  startedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

export function startToolTiming(state: ToolTimingState, executionStarted: boolean): void {
  if (executionStarted) state.startedAt ??= Date.now();
}

// The render clock only drives the live counter; a final result shows pi's recorded durationMs.
export function updateToolTiming(
  state: ToolTimingState,
  isPartial: boolean,
  invalidate: () => void,
): void {
  if (isPartial) {
    state.interval ??= setInterval(invalidate, 1000);
    return;
  }
  clearInterval(state.interval);
  delete state.interval;
}

export function formatElapsed(state: ToolTimingState): string {
  if (state.startedAt === undefined) throw new Error("tool timing read before execution started");
  return formatSeconds(Date.now() - state.startedAt);
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function summarizeExcerpt(text: string | undefined, maxLength = 220): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function formatWarnings(warnings: FetchWarning[] | undefined | null): string[] {
  if (!warnings?.length) return [];
  return warnings
    .map((warning) => {
      const type = warning.type ? `[${warning.type}] ` : "";
      const message = warning.message.trim();
      return message ? `${type}${message}` : undefined;
    })
    .filter((warning): warning is string => Boolean(warning));
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function writeDocumentBody(
  artifactDir: string,
  url: string,
  name: string,
  content: string | Buffer,
): Promise<DocumentBody> {
  const filePath = path.join(artifactDir, slugify(url) || "document", safeArtifactName(name));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return {
    name,
    path: filePath,
    lines: countLines(content),
    bytes: Buffer.isBuffer(content) ? content.byteLength : Buffer.byteLength(content, "utf8"),
  };
}

function countLines(content: string | Buffer): number {
  if (Buffer.isBuffer(content)) return 0;
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  if (content.endsWith("\n")) lines -= 1;
  return lines;
}

function safeArtifactName(name: string): string {
  const normalized = path.normalize(name).replace(/^([/\\])+/, "");
  const parts = normalized.split(path.sep).filter((part) => part && part !== "." && part !== "..");
  return parts.join(path.sep) || "body";
}
