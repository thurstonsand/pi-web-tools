import { unlink } from "node:fs/promises";
import path from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { FetchedDocument, FetcherResult, FetchFailure, WebFetcher } from "../../contract.ts";
import { getErrorMessage, slugify, writeDocumentBody } from "../../shared.ts";
import type { Extractor } from "./local-extractor.ts";
import type { FetchWorkerClient } from "./worker-connection.ts";
import type { WorkerFetchResult } from "./worker-protocol.ts";

export function createLocalFetcher(client: FetchWorkerClient, extractor: Extractor): WebFetcher {
  async function fetchOne(url: string, artifactDir: string): Promise<FetchedDocument> {
    const slug = slugify(url) || "document";
    const downloadDir = path.join(artifactDir, slug);
    const result = await client.fetch(url, downloadDir);
    if (isHtmlContentType(result.contentType)) {
      return buildPageDocument(url, artifactDir, result);
    }
    return buildFileDocument(url, slug, result);
  }

  async function buildPageDocument(
    url: string,
    artifactDir: string,
    result: WorkerFetchResult,
  ): Promise<FetchedDocument> {
    const markdown = (await extractor.extractToMarkdown(result.file)).trim();
    if (!markdown) throw new Error(`${extractor.name} extracted no content`);
    const body = await writeDocumentBody(artifactDir, url, "content.md", `${markdown}\n`);
    await unlink(result.file);
    return {
      kind: "local.page",
      source: "local",
      url,
      ...(result.finalUrl !== url ? { link: result.finalUrl } : {}),
      title: result.title || result.finalUrl,
      facts: [],
      excerpt: markdown,
      bodies: [body],
    };
  }

  function buildFileDocument(
    url: string,
    slug: string,
    result: WorkerFetchResult,
  ): FetchedDocument {
    const name = path.basename(result.file);
    return {
      kind: "local.file",
      source: "local",
      url,
      ...(result.finalUrl !== url ? { link: result.finalUrl } : {}),
      title: name,
      facts: [result.contentType, formatSize(result.bytes)],
      bodies: [{ name, path: path.join(slug, name), lines: 0, bytes: result.bytes }],
    };
  }

  return {
    source: "local",
    canFetch: isHttpUrl,
    async fetch({ urls, artifactDir, signal }): Promise<FetcherResult> {
      const documents: FetchedDocument[] = [];
      const failures: FetchFailure[] = [];
      await Promise.all(
        urls.map(async (url) => {
          if (signal?.aborted) {
            failures.push({ url, reason: "Fetch cancelled." });
            return;
          }
          try {
            documents.push(await fetchOne(url, artifactDir));
          } catch (error) {
            failures.push({ url, reason: getErrorMessage(error) });
          }
        }),
      );
      return { documents, failures, warnings: [] };
    },
  };
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isHtmlContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "text/html" || mime === "application/xhtml+xml";
}
