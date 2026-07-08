import type { Octokit } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import {
  appendIssueComments,
  type GitHubIssueComment,
  ISSUE_COMMENT_LIMIT,
  listIssueComments,
} from "./issue.ts";
import { type CappedResult, listWithCap } from "./pagination.ts";
import { escapeTableCell, requestOptions, truncateUtf8Bytes } from "./shared.ts";
import type { PullRequestTarget } from "./urls.ts";

const PR_REVIEW_LIMIT = 100;
const PR_REVIEW_COMMENT_LIMIT = 200;
const PR_FILE_LIMIT = 300;
const PATCH_TEXT_LIMIT = 400_000;

interface GitHubRefSummary {
  label?: string | undefined;
  ref?: string | undefined;
  sha?: string | undefined;
  repo?: string | undefined;
  owner?: string | undefined;
}

interface GitHubReview {
  id: number;
  author?: string | undefined;
  author_association?: string | undefined;
  body?: string | null | undefined;
  state?: string | undefined;
  html_url?: string | undefined;
  submitted_at?: string | null | undefined;
  commit_id?: string | undefined;
}

interface GitHubReviewComment {
  id: number;
  pull_request_review_id?: number | null | undefined;
  author?: string | undefined;
  author_association?: string | undefined;
  body?: string | null | undefined;
  path?: string | undefined;
  diff_hunk?: string | undefined;
  line?: number | null | undefined;
  original_line?: number | null | undefined;
  html_url?: string | undefined;
  created_at?: string | null | undefined;
  updated_at?: string | null | undefined;
}

interface GitHubPullRequestFile {
  sha?: string | undefined;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url?: string | undefined;
  raw_url?: string | undefined;
  contents_url?: string | undefined;
  previous_filename?: string | undefined;
  patch_truncated?: boolean | undefined;
  patch?: string | undefined;
}

type GitHubPullRequestRenderModel = {
  issue_comments_truncated: boolean;
  reviews_truncated: boolean;
  review_comments_truncated: boolean;
  files_truncated: boolean;
  title: string;
  url: string;
  html_url?: string | undefined;
  state: string;
  author?: string | undefined;
  draft: boolean;
  merged?: boolean | undefined;
  base: GitHubRefSummary;
  head: GitHubRefSummary;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  body?: string | null | undefined;
  issue_comments: GitHubIssueComment[];
  reviews: GitHubReview[];
  review_comments: GitHubReviewComment[];
  files: GitHubPullRequestFile[];
};

export async function fetchPullRequest(
  octokit: Octokit,
  target: PullRequestTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.pulls.get({
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
    mediaType: { format: "full" },
    ...requestOptions(signal),
  });
  const pr = response.data;
  const [issueComments, reviews, reviewComments, files] = await Promise.all([
    listIssueComments(octokit, target, ISSUE_COMMENT_LIMIT, signal),
    listPullRequestReviews(octokit, target, PR_REVIEW_LIMIT, signal),
    listPullRequestReviewComments(octokit, target, PR_REVIEW_COMMENT_LIMIT, signal),
    listPullRequestFiles(octokit, target, PR_FILE_LIMIT, signal),
  ]);
  const model: GitHubPullRequestRenderModel = {
    issue_comments_truncated: issueComments.truncated,
    reviews_truncated: reviews.truncated,
    review_comments_truncated: reviewComments.truncated,
    files_truncated: files.truncated,
    title: `${target.owner}/${target.repo}#${target.number}: ${pr.title}`,
    url: target.url,
    html_url: pr.html_url,
    state: pr.state,
    author: pr.user?.login,
    draft: pr.draft ?? false,
    merged: pr.merged ?? undefined,
    base: normalizeRefSummary(pr.base),
    head: normalizeRefSummary(pr.head),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changed_files: pr.changed_files ?? 0,
    commits: pr.commits ?? 0,
    body: pr.body,
    issue_comments: issueComments.items,
    reviews: reviews.items,
    review_comments: reviewComments.items,
    files: files.items,
  };
  return {
    kind: "github.pull_request",
    source: "github",
    url: target.url,
    link: pr.html_url,
    title: model.title,
    facts: [
      `${pr.state}${pr.draft ? " draft" : ""}${pr.merged ? " merged" : ""}`,
      ...(pr.user?.login ? [`by ${pr.user.login}`] : []),
      `+${pr.additions ?? 0} -${pr.deletions ?? 0}`,
      `${pr.changed_files ?? 0} file${(pr.changed_files ?? 0) === 1 ? "" : "s"}`,
      `${issueComments.items.length} issue comment${issueComments.items.length === 1 ? "" : "s"}`,
      `${reviews.items.length} review${reviews.items.length === 1 ? "" : "s"}`,
      ...(issueComments.truncated ||
      reviews.truncated ||
      reviewComments.truncated ||
      files.truncated
        ? ["some lists capped; see conversation.md markers"]
        : []),
    ],
    excerpt: pr.body ?? issueComments.items[0]?.body ?? undefined,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "conversation.md",
        renderPullRequestMarkdown(model),
      ),
      await writeDocumentBody(
        artifactDir,
        target.url,
        "diff.patch",
        renderPullRequestPatch(files.items),
      ),
    ],
  };
}

async function listPullRequestReviews(
  octokit: Octokit,
  target: PullRequestTarget,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CappedResult<GitHubReview>> {
  return listWithCap(limit, async (page, perPage) => {
    const response = await octokit.rest.pulls.listReviews({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      page,
      per_page: perPage,
      mediaType: { format: "full" },
      ...requestOptions(signal),
    });
    return response.data.map((review) => ({
      id: review.id,
      author: review.user?.login,
      author_association: review.author_association,
      body: review.body,
      state: review.state,
      html_url: review.html_url,
      submitted_at: review.submitted_at,
      commit_id: review.commit_id ?? undefined,
    }));
  });
}

async function listPullRequestReviewComments(
  octokit: Octokit,
  target: PullRequestTarget,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CappedResult<GitHubReviewComment>> {
  return listWithCap(limit, async (page, perPage) => {
    const response = await octokit.rest.pulls.listReviewComments({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      page,
      per_page: perPage,
      mediaType: { format: "full" },
      ...requestOptions(signal),
    });
    return response.data.map((comment) => ({
      id: comment.id,
      pull_request_review_id: comment.pull_request_review_id,
      author: comment.user?.login,
      author_association: comment.author_association,
      body: comment.body,
      path: comment.path,
      diff_hunk: comment.diff_hunk,
      line: comment.line,
      original_line: comment.original_line,
      html_url: comment.html_url,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    }));
  });
}

async function listPullRequestFiles(
  octokit: Octokit,
  target: PullRequestTarget,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CappedResult<GitHubPullRequestFile>> {
  let patchBytes = 0;
  return listWithCap(limit, async (page, perPage) => {
    const response = await octokit.rest.pulls.listFiles({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      page,
      per_page: perPage,
      ...requestOptions(signal),
    });
    return response.data.map((file) => {
      const patch = file.patch;
      let patch_truncated = false;
      let cappedPatch = patch;
      if (patch) {
        const remaining = PATCH_TEXT_LIMIT - patchBytes;
        if (remaining <= 0) {
          cappedPatch = undefined;
          patch_truncated = true;
        } else if (Buffer.byteLength(patch, "utf8") > remaining) {
          cappedPatch = truncateUtf8Bytes(patch, remaining);
          patch_truncated = true;
          patchBytes = PATCH_TEXT_LIMIT;
        } else {
          patchBytes += Buffer.byteLength(patch, "utf8");
        }
      }
      return {
        sha: file.sha ?? undefined,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: file.blob_url,
        raw_url: file.raw_url,
        contents_url: file.contents_url,
        previous_filename: file.previous_filename,
        patch_truncated,
        patch: cappedPatch,
      };
    });
  });
}

function normalizeRefSummary(ref: {
  label?: string | undefined;
  ref?: string | undefined;
  sha?: string | undefined;
  repo?: { name?: string; owner?: { login?: string } } | null;
}): GitHubRefSummary {
  return {
    label: ref.label,
    ref: ref.ref,
    sha: ref.sha,
    repo: ref.repo?.name,
    owner: ref.repo?.owner?.login,
  };
}

function renderPullRequestMarkdown(pr: GitHubPullRequestRenderModel): string {
  const lines = [
    `# ${pr.title}`,
    "",
    `- State: ${pr.state}${pr.draft ? " (draft)" : ""}${pr.merged ? " (merged)" : ""}`,
    `- Author: ${pr.author ?? "unknown"}`,
    `- Base: ${pr.base.label ?? pr.base.ref ?? "unknown"}`,
    `- Head: ${pr.head.label ?? pr.head.ref ?? "unknown"}`,
    `- Changes: +${pr.additions} -${pr.deletions} across ${pr.changed_files} file(s)`,
    `- Commits: ${pr.commits}`,
    `- URL: ${pr.html_url ?? pr.url}`,
    "",
    "## Body",
    "",
    pr.body ?? "(no body)",
  ];

  appendIssueComments(lines, pr.issue_comments, pr.issue_comments_truncated, "Issue comments");
  appendReviews(lines, pr.reviews, pr.reviews_truncated);
  appendReviewComments(lines, pr.review_comments, pr.review_comments_truncated);
  appendPullRequestFiles(lines, pr.files, pr.files_truncated);
  return lines.join("\n");
}

function appendReviews(lines: string[], reviews: GitHubReview[], truncated: boolean): void {
  lines.push("", "## Reviews");
  if (reviews.length === 0) lines.push("", "(none)");
  for (const review of reviews) {
    lines.push(
      "",
      `### ${review.state ?? "review"} by ${review.author ?? "unknown"}`,
      "",
      review.body ?? "",
    );
  }
  if (truncated) lines.push("", "[reviews truncated]");
}

function appendReviewComments(
  lines: string[],
  comments: GitHubReviewComment[],
  truncated: boolean,
): void {
  lines.push("", "## Review comments");
  if (comments.length === 0) lines.push("", "(none)");
  for (const comment of comments) {
    lines.push(
      "",
      `### ${comment.path ?? "unknown path"} by ${comment.author ?? "unknown"}`,
      "",
      comment.diff_hunk ? `\`\`\`diff\n${comment.diff_hunk}\n\`\`\`\n` : "",
      comment.body ?? "",
    );
  }
  if (truncated) lines.push("", "[review comments truncated]");
}

function renderPullRequestPatch(files: GitHubPullRequestFile[]): string {
  return files
    .flatMap((file) => {
      if (!file.patch) return [];
      const oldPath = file.previous_filename ?? file.filename;
      return [
        `diff --git a/${oldPath} b/${file.filename}`,
        `--- a/${oldPath}`,
        `+++ b/${file.filename}`,
        file.patch,
        file.patch_truncated ? "[patch truncated]" : "",
      ];
    })
    .filter(Boolean)
    .join("\n");
}

function appendPullRequestFiles(
  lines: string[],
  files: GitHubPullRequestFile[],
  truncated: boolean,
): void {
  lines.push("", "## Files", "", "| Status | File | + | - |", "| --- | --- | ---: | ---: |");
  for (const file of files) {
    lines.push(
      `| ${escapeTableCell(file.status)} | ${escapeTableCell(file.filename)} | ${file.additions} | ${file.deletions} |`,
    );
  }
  if (truncated) lines.push("", "[files truncated]");
}
