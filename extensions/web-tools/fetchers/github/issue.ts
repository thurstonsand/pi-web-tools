import type { Octokit } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { type CappedResult, listWithCap } from "./pagination.ts";
import { isString, requestOptions } from "./shared.ts";
import type { IssueTarget, PullRequestTarget } from "./urls.ts";

export const ISSUE_COMMENT_LIMIT = 200;

export interface GitHubIssueComment {
  id: number;
  author?: string | undefined;
  author_association?: string | undefined;
  body?: string | null | undefined;
  html_url?: string | undefined;
  created_at?: string | null | undefined;
  updated_at?: string | null | undefined;
}

type GitHubIssueRenderModel = {
  title: string;
  url: string;
  html_url?: string | undefined;
  state: string;
  state_reason?: string | null | undefined;
  author?: string | undefined;
  created_at: string;
  updated_at: string;
  body?: string | null | undefined;
  comments: GitHubIssueComment[];
  comments_truncated: boolean;
};

export async function fetchIssue(
  octokit: Octokit,
  target: IssueTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.issues.get({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.number,
    mediaType: { format: "full" },
    ...requestOptions(signal),
  });
  const issue = response.data;
  const comments = await listIssueComments(octokit, target, ISSUE_COMMENT_LIMIT, signal);
  const labels = issue.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter(isString);
  const model: GitHubIssueRenderModel = {
    title: `${target.owner}/${target.repo}#${target.number}: ${issue.title}`,
    url: target.url,
    html_url: issue.html_url,
    state: issue.state,
    state_reason: issue.state_reason,
    author: issue.user?.login,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    body: issue.body,
    comments: comments.items,
    comments_truncated: comments.truncated,
  };
  return {
    kind: "github.issue",
    source: "github",
    url: target.url,
    link: issue.html_url,
    title: model.title,
    facts: [
      `${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ""}`,
      ...(issue.user?.login ? [`by ${issue.user.login}`] : []),
      `${issue.comments} comment${issue.comments === 1 ? "" : "s"}`,
      ...(comments.truncated ? [`comments capped at ${ISSUE_COMMENT_LIMIT}`] : []),
      ...(labels.length > 0 ? [`labels ${labels.join(", ")}`] : []),
    ],
    excerpt: issue.body ?? comments.items[0]?.body ?? undefined,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "conversation.md",
        renderIssueMarkdown(model),
      ),
    ],
  };
}

export async function listIssueComments(
  octokit: Octokit,
  target: IssueTarget | PullRequestTarget,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CappedResult<GitHubIssueComment>> {
  const result = await listWithCap(limit, async (page, perPage) => {
    const response = await octokit.rest.issues.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      page,
      per_page: perPage,
      mediaType: { format: "full" },
      ...requestOptions(signal),
    });
    return response.data.map((comment) => ({
      id: comment.id,
      author: comment.user?.login,
      author_association: comment.author_association,
      body: comment.body,
      html_url: comment.html_url,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    }));
  });
  return result;
}

function renderIssueMarkdown(issue: GitHubIssueRenderModel): string {
  const lines = [
    `# ${issue.title}`,
    "",
    `- State: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ""}`,
    `- Author: ${issue.author ?? "unknown"}`,
    `- Created: ${issue.created_at}`,
    `- Updated: ${issue.updated_at}`,
    `- URL: ${issue.html_url ?? issue.url}`,
    "",
    "## Body",
    "",
    issue.body ?? "(no body)",
  ];
  appendIssueComments(lines, issue.comments, issue.comments_truncated);
  return lines.join("\n");
}

export function appendIssueComments(
  lines: string[],
  comments: GitHubIssueComment[],
  truncated: boolean,
  title = "Comments",
): void {
  lines.push("", `## ${title}`);
  if (comments.length === 0) {
    lines.push("", "(none)");
  }
  for (const comment of comments) {
    lines.push(
      "",
      `### ${comment.author ?? "unknown"} at ${comment.created_at ?? "unknown time"}`,
      "",
      comment.body ?? "",
    );
  }
  if (truncated) lines.push("", "[comments truncated]");
}
