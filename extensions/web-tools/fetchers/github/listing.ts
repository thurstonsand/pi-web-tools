import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { escapeTableCell, isString, requestOptions } from "./shared.ts";
import type { ListTarget } from "./urls.ts";

const LISTING_LIMIT = 100;

type SearchIssueItem =
  RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["response"]["data"]["items"][number];

export async function fetchListing(
  octokit: Octokit,
  target: ListTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const query = buildListQuery(target);
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    per_page: LISTING_LIMIT,
    ...requestOptions(signal),
  });
  const items = response.data.items;
  const title = `${target.owner}/${target.repo} ${target.tab}: ${query}`;
  const total = response.data.total_count;
  const capped = total > items.length;

  return {
    kind: target.tab === "issues" ? "github.issue_list" : "github.pull_request_list",
    source: "github",
    url: target.url,
    title,
    facts: [
      capped ? `${total} matches, showing first ${items.length}` : `${total} matches`,
      `query: ${query}`,
    ],
    excerpt: renderListingExcerpt(items),
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "listing.md",
        renderListingMarkdown(title, items),
      ),
    ],
  };
}

function renderListingExcerpt(items: SearchIssueItem[]): string | undefined {
  if (items.length === 0) return undefined;
  return items.map((item) => `#${item.number} ${item.title}`).join("\n");
}

function renderListingMarkdown(title: string, items: SearchIssueItem[]): string {
  const lines = [
    `# ${title}`,
    "",
    "| Number | Title | State | Author | Labels | Comments | Updated | URL |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- |",
  ];
  for (const item of items) {
    lines.push(
      `| #${item.number} | ${escapeTableCell(item.title)} | ${escapeTableCell(formatListingState(item))} | ${escapeTableCell(item.user?.login ?? "")} | ${escapeTableCell(
        item.labels
          .map((label) => label.name)
          .filter(isString)
          .join(", "),
      )} | ${item.comments} | ${escapeTableCell(item.updated_at)} | ${escapeTableCell(item.html_url)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatListingState(item: SearchIssueItem): string {
  return `${item.state}${item.draft ? " draft" : ""}`;
}

export function buildListQuery(target: ListTarget): string {
  const repoQualifier = `repo:${target.owner}/${target.repo}`;
  const userQuery = target.q?.trim();
  if (!userQuery) {
    return `${repoQualifier} ${target.tab === "issues" ? "is:issue" : "is:pr"} state:open`;
  }

  const typeQualifier = hasTypeQualifier(userQuery)
    ? undefined
    : target.tab === "issues"
      ? "is:issue"
      : "is:pr";
  return [repoQualifier, typeQualifier, userQuery].filter(isPresent).join(" ");
}

function hasTypeQualifier(query: string): boolean {
  return /(?:^|\s)(?:is:(?:issue|pr|merged|unmerged)|type:(?:issue|pr))(?:\s|$)/i.test(query);
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}
