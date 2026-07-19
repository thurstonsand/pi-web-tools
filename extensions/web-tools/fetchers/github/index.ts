import { Octokit } from "@octokit/rest";
import type { FetchedDocument, FetcherResult, FetchFailure, WebFetcher } from "../../contract.ts";
import { getErrorMessage } from "../../shared.ts";
import { fetchActionRun, fetchActionRunList } from "./action-run.ts";
import type { GitHubAuth } from "./auth.ts";
import { fetchCommit } from "./commit.ts";
import { fetchDirectory, fetchFile, fetchReadme, resolveRefPath } from "./content.ts";
import { fetchDiscussion } from "./discussion.ts";
import { fetchIssue } from "./issue.ts";
import { fetchListing } from "./listing.ts";
import { fetchPullRequest } from "./pull-request.ts";
import { fetchLatestRelease, fetchRelease } from "./release.ts";
import { fetchRepositoryCollection } from "./repository-collection.ts";
import { isGitHubUrl, type ParsedGitHubUrl, parseGitHubUrl } from "./urls.ts";

type ResolverResult =
  | { status: "resolved"; document: FetchedDocument }
  | { status: "unsupported" }
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
    clientPromise ??= auth.getToken().then(
      (token) =>
        new Octokit({
          ...(token ? { auth: token } : {}),
          userAgent: "pi-web-tools",
          log: SILENT_OCTOKIT_LOG,
          request: { log: SILENT_OCTOKIT_LOG },
        }),
    );
    return await clientPromise;
  }

  async function fetchOne(
    url: string,
    octokit: Octokit,
    signal: AbortSignal | undefined,
    artifactDir: string,
  ): Promise<ResolverResult> {
    try {
      const parsed = parseGitHubUrl(url);
      if (!parsed) return { status: "unsupported" };
      if (parsed.type === "discussion" && !(await auth.getToken())) {
        return { status: "unsupported" };
      }
      return {
        status: "resolved",
        document: await resolveGitHubUrl(octokit, parsed, signal, artifactDir),
      };
    } catch (error) {
      return {
        status: "failed",
        reason: getErrorMessage(error),
      };
    }
  }

  return {
    source: "github",
    promptGuidelines: [
      "Use web_fetch directly on GitHub URLs for source-native API results: repos, files, and directories; issues, PRs, and Discussions with their conversations; commits and patches; tagged and latest releases with asset metadata; Actions runs with jobs and artifacts; and issue, PR, release, tag, branch, and Actions-run listings.",
    ],
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

async function resolveGitHubUrl(
  octokit: Octokit,
  parsed: ParsedGitHubUrl,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  switch (parsed.type) {
    case "file":
      return await fetchFile(octokit, parsed.target, signal, artifactDir);
    case "readme":
      return await fetchReadme(octokit, parsed.target, signal, artifactDir);
    case "directory":
      return await fetchDirectory(octokit, parsed.target, signal, artifactDir);
    case "issue":
      return await fetchIssue(octokit, parsed.target, signal, artifactDir);
    case "pull_request":
      return await fetchPullRequest(octokit, parsed.target, signal, artifactDir);
    case "release":
      return await fetchRelease(octokit, parsed.target, signal, artifactDir);
    case "latest_release":
      return await fetchLatestRelease(octokit, parsed.target, signal, artifactDir);
    case "commit":
      return await fetchCommit(octokit, parsed.target, signal, artifactDir);
    case "repository_collection":
      return await fetchRepositoryCollection(octokit, parsed.target, signal, artifactDir);
    case "action_run":
      return await fetchActionRun(octokit, parsed.target, signal, artifactDir);
    case "action_run_list":
      return await fetchActionRunList(octokit, parsed.target, signal, artifactDir);
    case "discussion":
      return await fetchDiscussion(octokit, parsed.target, signal, artifactDir);
    case "issue_list":
    case "pull_request_list":
      return await fetchListing(octokit, parsed.target, signal, artifactDir);
    case "ambiguous_file": {
      const resolved = await resolveRefPath(octokit, parsed.target, "file", signal);
      return await fetchFile(octokit, { ...resolved, url: parsed.target.url }, signal, artifactDir);
    }
    case "ambiguous_directory": {
      const resolved = await resolveRefPath(octokit, parsed.target, "directory", signal);
      return await fetchDirectory(
        octokit,
        { ...resolved, url: parsed.target.url },
        signal,
        artifactDir,
      );
    }
  }
}
