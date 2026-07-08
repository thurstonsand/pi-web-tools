import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentBody } from "./contract.ts";

export const TMP_DIR = "/tmp/pi-fetch";

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function summarizeExcerpt(text: string | undefined, maxLength = 220): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function formatWarnings(
  warnings: Array<{ message?: string | null; type?: string | null }> | undefined | null,
): string[] {
  if (!warnings?.length) return [];
  return warnings
    .map((warning) => {
      const type = warning.type ? `[${warning.type}] ` : "";
      const message = warning.message?.trim();
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
  const relativePath = path.join(slugify(url) || "document", safeArtifactName(name));
  const filePath = path.join(artifactDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return {
    name,
    path: relativePath,
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
