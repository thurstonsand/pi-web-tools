import path from "node:path";
import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { escapeTableCell, isRecord, requestOptions } from "./shared.ts";
import type { DirectoryTarget, FileTarget, GitHubRepo, RefPathTarget } from "./urls.ts";

const DIRECTORY_LIMIT = 1000;
const RAW_CONTENT_LIMIT = 100 * 1024 * 1024;

interface GitHubDirectoryEntry {
  type: string;
  name: string;
  path: string;
  size?: number | undefined;
  sha?: string | undefined;
  html_url?: string | undefined;
  download_url?: string | null | undefined;
}

type GetContentData = RestEndpointMethodTypes["repos"]["getContent"]["response"]["data"];
type ContentFile = {
  type?: string;
  size?: number | undefined;
  name?: string;
  path?: string | undefined;
  sha?: string | undefined;
  content?: string;
  encoding?: string | undefined;
  url?: string | undefined;
  html_url?: string | null;
  download_url?: string | null | undefined;
};

type DirectoryEntryResponse = Extract<GetContentData, unknown[]>[number];
type DirectoryResponse = {
  type?: string;
  size?: number | undefined;
  name?: string;
  path?: string | undefined;
  sha?: string | undefined;
  entries?: DirectoryEntryResponse[] | undefined;
  url?: string | undefined;
  html_url?: string | null;
};

export async function fetchFile(
  octokit: Octokit,
  target: FileTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  return buildFileDocument(
    "github.file",
    target,
    await getContentFile(octokit, target, signal),
    signal,
    artifactDir,
  );
}

export async function fetchReadme(
  octokit: Octokit,
  target: GitHubRepo & { url: string },
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.repos.getReadme({
    owner: target.owner,
    repo: target.repo,
    mediaType: { format: "object" },
    ...requestOptions(signal),
  });
  return buildFileDocument(
    "github.readme",
    target,
    response.data as ContentFile,
    signal,
    artifactDir,
  );
}

async function buildFileDocument(
  kind: "github.file" | "github.readme",
  target: GitHubRepo & { url: string; ref?: string | undefined; path?: string },
  item: ContentFile,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const sourcePath = item.path ?? target.path ?? item.name ?? "README";
  const content = await readContentFile(item, signal);
  const body = await writeDocumentBody(
    artifactDir,
    target.url,
    item.name ?? path.basename(sourcePath),
    content,
  );
  return {
    kind,
    source: "github",
    url: target.url,
    link: item.html_url ?? undefined,
    title:
      kind === "github.readme"
        ? `${target.owner}/${target.repo} README`
        : `${target.owner}/${target.repo}:${sourcePath}`,
    facts: [
      `repo ${target.owner}/${target.repo}`,
      ...(target.ref ? [`ref ${target.ref}`] : []),
      `path ${sourcePath}`,
      ...(Buffer.isBuffer(content) ? ["binary"] : []),
      ...(kind === "github.readme"
        ? [`whole repository: git clone https://github.com/${target.owner}/${target.repo}.git`]
        : []),
    ],
    excerpt: Buffer.isBuffer(content) ? undefined : content,
    bodies: [body],
  };
}

export async function fetchDirectory(
  octokit: Octokit,
  target: DirectoryTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.repos.getContent({
    owner: target.owner,
    repo: target.repo,
    path: target.path,
    ...(target.ref ? { ref: target.ref } : {}),
    mediaType: { format: "object" },
    ...requestOptions(signal),
  });
  const directory = normalizeDirectoryResponse(response.data);
  const entries = (directory.entries ?? []).map(normalizeDirectoryEntry);
  const likelyIncomplete = entries.length >= DIRECTORY_LIMIT;
  const title = `${target.owner}/${target.repo}:${target.path || "/"}`;
  return {
    kind: "github.directory",
    source: "github",
    url: target.url,
    title,
    link: directory.html_url ?? undefined,
    facts: [
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
      ...(likelyIncomplete ? ["listing may be incomplete"] : []),
    ],
    excerpt: entries
      .map((entry) => (entry.type === "dir" ? `${entry.name}/` : entry.name))
      .join(", "),
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "listing.md",
        renderDirectoryMarkdown(title, entries, likelyIncomplete),
      ),
    ],
  };
}

async function getContentFile(
  octokit: Octokit,
  target: FileTarget,
  signal: AbortSignal | undefined,
): Promise<ContentFile> {
  const response = await octokit.rest.repos.getContent({
    owner: target.owner,
    repo: target.repo,
    path: target.path,
    ...(target.ref ? { ref: target.ref } : {}),
    mediaType: { format: "object" },
    ...requestOptions(signal),
  });
  if (Array.isArray(response.data)) {
    throw new Error(`Expected file but GitHub returned a directory: ${target.path}`);
  }
  const item = response.data as ContentFile;
  if (item.type === "dir") {
    throw new Error(`Expected file but GitHub returned a directory: ${target.path}`);
  }
  return item;
}

function normalizeDirectoryResponse(value: unknown): DirectoryResponse {
  if (Array.isArray(value)) {
    return { type: "dir", entries: value as DirectoryEntryResponse[] };
  }
  if (!isRecord(value)) throw new Error("GitHub returned an invalid directory response.");
  const directory = value as DirectoryResponse;
  if (Array.isArray(directory.entries)) return directory;
  throw new Error("GitHub returned a file where a directory was expected.");
}

function normalizeDirectoryEntry(entry: DirectoryEntryResponse): GitHubDirectoryEntry {
  return {
    type: entry.type ?? "unknown",
    name: entry.name ?? path.basename(entry.path ?? ""),
    path: entry.path ?? entry.name ?? "",
    size: entry.size,
    sha: entry.sha,
    html_url: entry.html_url ?? undefined,
    download_url: entry.download_url,
  };
}

async function readContentFile(
  item: ContentFile,
  signal: AbortSignal | undefined,
): Promise<string | Buffer> {
  if (item.encoding === "base64" && item.content) {
    return decodeTextOrBuffer(Buffer.from(item.content.replace(/\n/g, ""), "base64"));
  }
  if (item.content) return item.content;
  if (item.download_url) return await fetchRawContent(item.download_url, signal);

  throw new Error(
    `GitHub did not return inline content for ${item.path ?? item.name ?? "file"}; the file may be too large.`,
  );
}

async function fetchRawContent(
  url: string,
  signal: AbortSignal | undefined,
): Promise<string | Buffer> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`GitHub raw download failed with HTTP ${response.status}.`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > RAW_CONTENT_LIMIT) {
    throw new Error(`GitHub raw file exceeds ${RAW_CONTENT_LIMIT} byte limit.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > RAW_CONTENT_LIMIT) {
    throw new Error(`GitHub raw file exceeds ${RAW_CONTENT_LIMIT} byte limit.`);
  }
  return decodeTextOrBuffer(buffer);
}

function decodeTextOrBuffer(buffer: Buffer): string | Buffer {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return buffer;
  }
}

export async function resolveRefPath(
  octokit: Octokit,
  target: RefPathTarget,
  expected: "file" | "directory",
  signal: AbortSignal | undefined,
): Promise<GitHubRepo & { ref: string; path: string }> {
  for (let index = 1; index < target.parts.length; index += 1) {
    const ref = target.parts.slice(0, index).join("/");
    const contentPath = target.parts.slice(index).join("/");
    try {
      const response = await octokit.rest.repos.getContent({
        owner: target.owner,
        repo: target.repo,
        path: contentPath,
        ref,
        mediaType: { format: "object" },
        ...requestOptions(signal),
      });
      const contentData = response.data as unknown;
      const isDirectory =
        Array.isArray(contentData) || (isRecord(contentData) && contentData.type === "dir");
      if ((expected === "directory" && isDirectory) || (expected === "file" && !isDirectory)) {
        return { owner: target.owner, repo: target.repo, ref, path: contentPath };
      }
    } catch {
      // Try the next possible ref/path split.
    }
  }
  throw new Error(`Could not resolve GitHub ${target.marker} URL ref/path split.`);
}

function renderDirectoryMarkdown(
  title: string,
  entries: GitHubDirectoryEntry[],
  incomplete: boolean,
): string {
  const lines = [`# ${title}`, "", "| Type | Path | Size |", "| --- | --- | --- |"];
  for (const entry of entries) {
    lines.push(
      `| ${escapeTableCell(entry.type)} | ${escapeTableCell(entry.path)} | ${entry.size ?? ""} |`,
    );
  }
  if (incomplete) lines.push("", "[listing may be incomplete: GitHub returned 1,000 entries]");
  return lines.join("\n");
}
