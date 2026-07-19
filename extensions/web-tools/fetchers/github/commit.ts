import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { type CappedResult, listWithCap } from "./pagination.ts";
import { escapeTableCell, requestOptions, truncateUtf8Bytes } from "./shared.ts";
import type { CommitTarget } from "./urls.ts";

const COMMIT_FILE_LIMIT = 300;
const COMMIT_COMMENT_LIMIT = 100;
const PATCH_TEXT_LIMIT = 400_000;

type CommitResponse = RestEndpointMethodTypes["repos"]["getCommit"]["response"]["data"];
type CommitFile = {
  sha?: string | null | undefined;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  previous_filename?: string | undefined;
  patch?: string | undefined;
  patch_truncated: boolean;
};
type CommitComment =
  RestEndpointMethodTypes["repos"]["listCommentsForCommit"]["response"]["data"][number];

export async function fetchCommit(
  octokit: Octokit,
  target: CommitTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const [response, files, comments] = await Promise.all([
    octokit.rest.repos.getCommit({
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
      per_page: 1,
      ...requestOptions(signal),
    }),
    listCommitFiles(octokit, target, signal),
    listCommitComments(octokit, target, signal),
  ]);
  const commit = response.data;
  const summary = commit.commit.message.split("\n", 1)[0] || commit.sha;
  const author = commit.author?.login ?? commit.commit.author?.name;

  return {
    kind: "github.commit",
    source: "github",
    url: target.url,
    link: commit.html_url,
    title: `${target.owner}/${target.repo}@${commit.sha.slice(0, 12)}: ${summary}`,
    facts: [
      ...(author ? [`by ${author}`] : []),
      ...(commit.commit.author?.date ? [`authored ${commit.commit.author.date}`] : []),
      `+${commit.stats?.additions ?? 0} -${commit.stats?.deletions ?? 0}`,
      `${files.items.length} file${files.items.length === 1 ? "" : "s"}${files.truncated ? ` shown (capped at ${COMMIT_FILE_LIMIT})` : ""}`,
      `${comments.items.length} comment${comments.items.length === 1 ? "" : "s"}`,
      ...(commit.commit.verification?.verified ? ["verified signature"] : []),
    ],
    excerpt: commit.commit.message,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "commit.md",
        renderCommitMarkdown(commit, files, comments),
      ),
      await writeDocumentBody(artifactDir, target.url, "diff.patch", renderCommitPatch(files)),
    ],
  };
}

async function listCommitFiles(
  octokit: Octokit,
  target: CommitTarget,
  signal: AbortSignal | undefined,
): Promise<CappedResult<CommitFile>> {
  let patchBytes = 0;
  return await listWithCap(COMMIT_FILE_LIMIT, async (page, perPage) => {
    const response = await octokit.rest.repos.getCommit({
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
      page,
      per_page: perPage,
      ...requestOptions(signal),
    });
    return (response.data.files ?? []).map((file) => {
      const patch = file.patch;
      let cappedPatch = patch;
      let patchTruncated = false;
      if (patch) {
        const remaining = PATCH_TEXT_LIMIT - patchBytes;
        if (remaining <= 0) {
          cappedPatch = undefined;
          patchTruncated = true;
        } else if (Buffer.byteLength(patch, "utf8") > remaining) {
          cappedPatch = truncateUtf8Bytes(patch, remaining);
          patchBytes = PATCH_TEXT_LIMIT;
          patchTruncated = true;
        } else {
          patchBytes += Buffer.byteLength(patch, "utf8");
        }
      }
      return { ...file, patch: cappedPatch, patch_truncated: patchTruncated };
    });
  });
}

async function listCommitComments(
  octokit: Octokit,
  target: CommitTarget,
  signal: AbortSignal | undefined,
): Promise<CappedResult<CommitComment>> {
  return await listWithCap(COMMIT_COMMENT_LIMIT, async (page, perPage) => {
    const response = await octokit.rest.repos.listCommentsForCommit({
      owner: target.owner,
      repo: target.repo,
      commit_sha: target.ref,
      page,
      per_page: perPage,
      ...requestOptions(signal),
    });
    return response.data;
  });
}

function renderCommitMarkdown(
  commit: CommitResponse,
  files: CappedResult<CommitFile>,
  comments: CappedResult<CommitComment>,
): string {
  const lines = [
    `# ${commit.commit.message.split("\n", 1)[0] || commit.sha}`,
    "",
    `- Commit: ${commit.sha}`,
    `- Author: ${commit.author?.login ?? commit.commit.author?.name ?? "unknown"}`,
    `- Authored: ${commit.commit.author?.date ?? "unknown"}`,
    `- Committer: ${commit.committer?.login ?? commit.commit.committer?.name ?? "unknown"}`,
    `- Committed: ${commit.commit.committer?.date ?? "unknown"}`,
    `- URL: ${commit.html_url}`,
    "",
    "## Message",
    "",
    commit.commit.message,
    "",
    "## Files",
    "",
    "| File | Status | Additions | Deletions | Changes |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  for (const file of files.items) {
    lines.push(
      `| ${escapeTableCell(file.filename)} | ${file.status} | ${file.additions} | ${file.deletions} | ${file.changes} |`,
    );
  }
  if (files.truncated) lines.push("", `[files capped at ${COMMIT_FILE_LIMIT}]`);

  lines.push("", "## Comments");
  if (comments.items.length === 0) lines.push("", "(none)");
  for (const comment of comments.items) {
    lines.push(
      "",
      `### ${comment.user?.login ?? "unknown"} at ${comment.created_at}`,
      "",
      comment.body,
    );
  }
  if (comments.truncated) lines.push("", `[comments capped at ${COMMIT_COMMENT_LIMIT}]`);
  return `${lines.join("\n")}\n`;
}

function renderCommitPatch(files: CappedResult<CommitFile>): string {
  const lines: string[] = [];
  for (const file of files.items) {
    lines.push(
      `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`,
      `# status: ${file.status}; additions: ${file.additions}; deletions: ${file.deletions}`,
    );
    if (file.patch) lines.push(file.patch);
    else lines.push("[patch unavailable]");
    if (file.patch_truncated) lines.push("[patch truncated]");
    lines.push("");
  }
  if (files.truncated) lines.push(`[files capped at ${COMMIT_FILE_LIMIT}]`, "");
  return lines.join("\n");
}
