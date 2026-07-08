import { Octokit } from "@octokit/rest";
import type { FetchedDocument, FetcherResult, FetchFailure, WebFetcher } from "../../contract.ts";
import { getErrorMessage } from "../../shared.ts";
import type { GitHubAuth } from "./auth.ts";
import { fetchDirectory, fetchFile, fetchReadme, resolveRefPath } from "./content.ts";
import { fetchIssue } from "./issue.ts";
import { fetchListing } from "./listing.ts";
import { fetchPullRequest } from "./pull-request.ts";
import { isGitHubUrl, parseGitHubUrl } from "./urls.ts";

type ResolverResult =
  | { status: "resolved"; document: FetchedDocument }
  | { status: "unsupported"; reason?: string }
  | { status: "failed"; reason: string };

// Any console output corrupts pi's interactive TUI (its differential renderer
// cannot recover from writes it did not make), so octokit must never log.
// The top-level `log` alone is not enough: @octokit/request resolves its logger
// from the per-request options (`request.log || console`) when emitting API
// deprecation warnings, so the silent logger has to be passed at both levels.
const SILENT_OCTOKIT_LOG = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createGitHubFetcher(auth: GitHubAuth): WebFetcher {
  let clientPromise: Promise<Octokit> | undefined;

  async function getClient(): Promise<Octokit> {
    clientPromise ??= createClient();
    return await clientPromise;
  }

  async function createClient(): Promise<Octokit> {
    const token = await auth.getToken();
    return new Octokit({
      ...(token ? { auth: token } : {}),
      userAgent: "pi-web-tools",
      log: SILENT_OCTOKIT_LOG,
      request: { log: SILENT_OCTOKIT_LOG },
    });
  }

  async function fetchOne(
    url: string,
    octokit: Octokit,
    signal: AbortSignal | undefined,
    artifactDir: string,
  ): Promise<ResolverResult> {
    try {
      return await fetchGitHubUrl(octokit, url, signal, artifactDir);
    } catch (error) {
      return {
        status: "failed",
        reason: getErrorMessage(error),
      };
    }
  }

  return {
    source: "github",
    canFetch: isGitHubUrl,
    async fetch({ urls, signal, artifactDir }): Promise<FetcherResult> {
      if (signal?.aborted) throw new Error("Fetch cancelled.");
      const octokit = await getClient();
      const results = await Promise.all(
        urls.map(async (url) => ({
          url,
          result: await fetchOne(url, octokit, signal, artifactDir),
        })),
      );
      const documents: FetchedDocument[] = [];
      const failures: FetchFailure[] = [];

      for (const { url, result } of results) {
        if (result.status === "resolved") {
          documents.push(result.document);
        } else if (result.status === "failed") {
          failures.push({ url, reason: result.reason });
        }
      }

      return { documents, failures, warnings: [] };
    },
  };
}

async function fetchGitHubUrl(
  octokit: Octokit,
  url: string,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<ResolverResult> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return { status: "unsupported", reason: "Unsupported GitHub URL." };

  switch (parsed.type) {
    case "file":
      return {
        status: "resolved",
        document: await fetchFile(octokit, parsed.target, signal, artifactDir),
      };
    case "readme":
      return {
        status: "resolved",
        document: await fetchReadme(octokit, parsed.target, signal, artifactDir),
      };
    case "directory":
      return {
        status: "resolved",
        document: await fetchDirectory(octokit, parsed.target, signal, artifactDir),
      };
    case "issue":
      return {
        status: "resolved",
        document: await fetchIssue(octokit, parsed.target, signal, artifactDir),
      };
    case "pull_request":
      return {
        status: "resolved",
        document: await fetchPullRequest(octokit, parsed.target, signal, artifactDir),
      };
    case "issue_list":
    case "pull_request_list":
      return {
        status: "resolved",
        document: await fetchListing(octokit, parsed.target, signal, artifactDir),
      };
    case "ambiguous_file": {
      const resolved = await resolveRefPath(octokit, parsed.target, "file", signal);
      return {
        status: "resolved",
        document: await fetchFile(octokit, { ...resolved, url }, signal, artifactDir),
      };
    }
    case "ambiguous_directory": {
      const resolved = await resolveRefPath(octokit, parsed.target, "directory", signal);
      return {
        status: "resolved",
        document: await fetchDirectory(octokit, { ...resolved, url }, signal, artifactDir),
      };
    }
  }
}
