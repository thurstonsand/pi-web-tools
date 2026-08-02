import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { type CappedResult, listWithCap } from "./pagination.ts";
import { escapeTableCell, requestOptions } from "./shared.ts";
import type { CommitListTarget } from "./urls.ts";

const COMMIT_LIST_LIMIT = 100;
const EXCERPT_LIMIT = 20;

type CommitListItem = RestEndpointMethodTypes["repos"]["listCommits"]["response"]["data"][number];

type ResolvedCommitList = {
  ref?: string | undefined;
  path?: string | undefined;
};

export async function fetchCommitList(
  octokit: Octokit,
  target: CommitListTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const resolved = await resolveCommitList(octokit, target, signal);
  const commits = await listWithCap(COMMIT_LIST_LIMIT, async (page, perPage) => {
    const response = await listCommits(octokit, target, resolved, page, perPage, signal);
    return response.data;
  });

  const scope = [resolved.ref ?? "default branch", resolved.path].filter(Boolean).join(" ");
  const title = `${target.owner}/${target.repo} commits: ${scope}`;

  return {
    kind: "github.commit_list",
    source: "github",
    url: target.url,
    title,
    facts: [
      `${commits.items.length} commit${commits.items.length === 1 ? "" : "s"}${commits.truncated ? ` shown (capped at ${COMMIT_LIST_LIMIT})` : ""}`,
      `ref: ${resolved.ref ?? "default branch"}`,
      ...(resolved.path ? [`path: ${resolved.path}`] : []),
    ],
    excerpt: renderCommitListExcerpt(commits.items),
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "commits.md",
        renderCommitListMarkdown(title, commits),
      ),
    ],
  };
}

// GitHub's commits URL packs ref and path into one slash-separated tail, and a
// ref may itself contain slashes, so the split is only knowable by asking the
// API which candidate yields commits.
async function resolveCommitList(
  octokit: Octokit,
  target: CommitListTarget,
  signal: AbortSignal | undefined,
): Promise<ResolvedCommitList> {
  if (target.parts.length === 0) return {};
  if (target.parts.length === 1) return { ref: target.parts[0] };

  for (let index = 1; index <= target.parts.length; index += 1) {
    const candidate: ResolvedCommitList = {
      ref: target.parts.slice(0, index).join("/"),
      path: target.parts.slice(index).join("/") || undefined,
    };
    try {
      const response = await listCommits(octokit, target, candidate, 1, 1, signal);
      if (response.data.length > 0) return candidate;
    } catch {
      // Try the next possible ref/path split.
    }
  }
  throw new Error("Could not resolve GitHub commits URL ref/path split.");
}

async function listCommits(
  octokit: Octokit,
  target: CommitListTarget,
  resolved: ResolvedCommitList,
  page: number,
  perPage: number,
  signal: AbortSignal | undefined,
) {
  return await octokit.rest.repos.listCommits({
    owner: target.owner,
    repo: target.repo,
    ...(resolved.ref ? { sha: resolved.ref } : {}),
    ...(resolved.path ? { path: resolved.path } : {}),
    page,
    per_page: perPage,
    ...requestOptions(signal),
  });
}

function renderCommitListExcerpt(items: CommitListItem[]): string | undefined {
  if (items.length === 0) return undefined;
  return items
    .slice(0, EXCERPT_LIMIT)
    .map((item) => `${item.sha.slice(0, 12)} ${commitSummary(item)}`)
    .join("\n");
}

function renderCommitListMarkdown(title: string, commits: CappedResult<CommitListItem>): string {
  const lines = [
    `# ${title}`,
    "",
    "| Commit | Summary | Author | Date | URL |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of commits.items) {
    lines.push(
      `| ${item.sha.slice(0, 12)} | ${escapeTableCell(commitSummary(item))} | ${escapeTableCell(
        item.author?.login ?? item.commit.author?.name ?? "unknown",
      )} | ${escapeTableCell(item.commit.author?.date ?? "unknown")} | ${escapeTableCell(item.html_url)} |`,
    );
  }
  if (commits.truncated) lines.push("", `[commits capped at ${COMMIT_LIST_LIMIT}]`);
  return `${lines.join("\n")}\n`;
}

function commitSummary(item: CommitListItem): string {
  return item.commit.message.split("\n", 1)[0] || item.sha;
}
