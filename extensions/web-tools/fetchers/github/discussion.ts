import type { Octokit } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { requestOptions } from "./shared.ts";
import type { DiscussionTarget } from "./urls.ts";

const DISCUSSION_COMMENT_LIMIT = 100;
const DISCUSSION_REPLY_LIMIT = 100;

type DiscussionAuthor = { login: string } | null;

type DiscussionComment = {
  author: DiscussionAuthor;
  body: string;
  createdAt: string;
  updatedAt: string;
  isAnswer: boolean;
  replies: {
    nodes: DiscussionReply[];
    pageInfo: { hasNextPage: boolean };
  };
};

type DiscussionReply = {
  author: DiscussionAuthor;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type Discussion = {
  title: string;
  number: number;
  url: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  answerChosenAt: string | null;
  author: DiscussionAuthor;
  category: { name: string };
  labels: { nodes: Array<{ name: string }> };
  comments: {
    nodes: DiscussionComment[];
    pageInfo: { hasNextPage: boolean };
  };
};

type DiscussionQuery = {
  repository: {
    discussion: Discussion | null;
  } | null;
};

const DISCUSSION_QUERY = `
  query Discussion($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) {
        title
        number
        url
        body
        createdAt
        updatedAt
        answerChosenAt
        author { login }
        category { name }
        labels(first: 100) { nodes { name } }
        comments(first: ${DISCUSSION_COMMENT_LIMIT}) {
          nodes {
            author { login }
            body
            createdAt
            updatedAt
            isAnswer
            replies(first: ${DISCUSSION_REPLY_LIMIT}) {
              nodes {
                author { login }
                body
                createdAt
                updatedAt
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

export async function fetchDiscussion(
  octokit: Octokit,
  target: DiscussionTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.graphql<DiscussionQuery>(DISCUSSION_QUERY, {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    ...requestOptions(signal),
  });
  const discussion = response.repository?.discussion;
  if (!discussion) {
    throw new Error(`GitHub discussion #${target.number} was not found.`);
  }
  const repliesTruncated = discussion.comments.nodes.some(
    (comment) => comment.replies.pageInfo.hasNextPage,
  );
  const commentsTruncated = discussion.comments.pageInfo.hasNextPage;

  return {
    kind: "github.discussion",
    source: "github",
    url: target.url,
    link: discussion.url,
    title: `${target.owner}/${target.repo}#${discussion.number}: ${discussion.title}`,
    facts: [
      `category ${discussion.category.name}`,
      ...(discussion.author?.login ? [`by ${discussion.author.login}`] : []),
      discussion.answerChosenAt ? "answered" : "unanswered",
      `${discussion.comments.nodes.length} comment${discussion.comments.nodes.length === 1 ? "" : "s"}`,
      ...(discussion.labels.nodes.length > 0
        ? [`labels ${discussion.labels.nodes.map((label) => label.name).join(", ")}`]
        : []),
      ...(commentsTruncated || repliesTruncated ? ["conversation capped; see discussion.md"] : []),
    ],
    excerpt: discussion.body || discussion.comments.nodes[0]?.body,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "discussion.md",
        renderDiscussionMarkdown(discussion, commentsTruncated),
      ),
    ],
  };
}

function renderDiscussionMarkdown(discussion: Discussion, commentsTruncated: boolean): string {
  const lines = [
    `# ${discussion.title}`,
    "",
    `- Author: ${discussion.author?.login ?? "unknown"}`,
    `- Category: ${discussion.category.name}`,
    `- Created: ${discussion.createdAt}`,
    `- Updated: ${discussion.updatedAt}`,
    `- Answered: ${discussion.answerChosenAt ? `yes, at ${discussion.answerChosenAt}` : "no"}`,
    `- URL: ${discussion.url}`,
    "",
    "## Body",
    "",
    discussion.body || "(no body)",
    "",
    "## Comments",
  ];

  if (discussion.comments.nodes.length === 0) lines.push("", "(none)");
  for (const comment of discussion.comments.nodes) {
    lines.push(
      "",
      `### ${comment.author?.login ?? "unknown"} at ${comment.createdAt}${comment.isAnswer ? " (answer)" : ""}`,
      "",
      comment.body,
    );
    for (const reply of comment.replies.nodes) {
      lines.push(
        "",
        `#### Reply from ${reply.author?.login ?? "unknown"} at ${reply.createdAt}`,
        "",
        reply.body,
      );
    }
    if (comment.replies.pageInfo.hasNextPage) {
      lines.push("", `[replies capped at ${DISCUSSION_REPLY_LIMIT}]`);
    }
  }
  if (commentsTruncated) lines.push("", `[comments capped at ${DISCUSSION_COMMENT_LIMIT}]`);
  return `${lines.join("\n")}\n`;
}
