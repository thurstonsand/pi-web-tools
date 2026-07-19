import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { listWithCap } from "./pagination.ts";
import { escapeTableCell, requestOptions } from "./shared.ts";
import type { RepositoryCollectionTarget } from "./urls.ts";

const COLLECTION_LIMIT = 100;

type Release = RestEndpointMethodTypes["repos"]["listReleases"]["response"]["data"][number];
type Tag = RestEndpointMethodTypes["repos"]["listTags"]["response"]["data"][number];
type Branch = RestEndpointMethodTypes["repos"]["listBranches"]["response"]["data"][number];
type CollectionKind = "github.release_list" | "github.tag_list" | "github.branch_list";

type CollectionSpec<Item> = {
  kind: CollectionKind;
  fetchPage(page: number, perPage: number): Promise<Item[]>;
  excerpt(item: Item): string;
  render(items: Item[], truncated: boolean): string;
};

export async function fetchRepositoryCollection(
  octokit: Octokit,
  target: RepositoryCollectionTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  switch (target.collection) {
    case "releases":
      return await fetchCollection(target, artifactDir, {
        kind: "github.release_list",
        async fetchPage(page, perPage) {
          const response = await octokit.rest.repos.listReleases({
            owner: target.owner,
            repo: target.repo,
            page,
            per_page: perPage,
            ...requestOptions(signal),
          });
          return response.data;
        },
        excerpt: (release) => release.name || release.tag_name,
        render: (releases, truncated) => renderReleases(target, releases, truncated),
      });
    case "tags":
      return await fetchCollection(target, artifactDir, {
        kind: "github.tag_list",
        async fetchPage(page, perPage) {
          const response = await octokit.rest.repos.listTags({
            owner: target.owner,
            repo: target.repo,
            page,
            per_page: perPage,
            ...requestOptions(signal),
          });
          return response.data;
        },
        excerpt: (tag) => tag.name,
        render: (tags, truncated) => renderTags(target, tags, truncated),
      });
    case "branches":
      return await fetchCollection(target, artifactDir, {
        kind: "github.branch_list",
        async fetchPage(page, perPage) {
          const response = await octokit.rest.repos.listBranches({
            owner: target.owner,
            repo: target.repo,
            page,
            per_page: perPage,
            ...requestOptions(signal),
          });
          return response.data;
        },
        excerpt: (branch) => branch.name,
        render: (branches, truncated) => renderBranches(target, branches, truncated),
      });
  }
}

async function fetchCollection<Item>(
  target: RepositoryCollectionTarget,
  artifactDir: string,
  spec: CollectionSpec<Item>,
): Promise<FetchedDocument> {
  const result = await listWithCap(COLLECTION_LIMIT, spec.fetchPage);
  return {
    kind: spec.kind,
    source: "github",
    url: target.url,
    title: `${target.owner}/${target.repo} ${target.collection}`,
    facts: [
      `${result.items.length} ${target.collection}${result.truncated ? ` shown (capped at ${COLLECTION_LIMIT})` : ""}`,
    ],
    excerpt: result.items.map(spec.excerpt).join("\n") || undefined,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "listing.md",
        spec.render(result.items, result.truncated),
      ),
    ],
  };
}

function renderReleases(
  target: RepositoryCollectionTarget,
  releases: Release[],
  truncated: boolean,
): string {
  const lines = [
    `# ${target.owner}/${target.repo} releases`,
    "",
    "| Name | Tag | State | Published | Author | Assets | URL |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
  ];
  for (const release of releases) {
    const state = release.draft ? "draft" : release.prerelease ? "prerelease" : "published";
    lines.push(
      `| ${escapeTableCell(release.name ?? "")} | ${escapeTableCell(release.tag_name)} | ${state} | ${release.published_at ?? ""} | ${escapeTableCell(release.author?.login ?? "")} | ${release.assets.length} | ${escapeTableCell(release.html_url)} |`,
    );
  }
  appendCap(lines, truncated);
  return `${lines.join("\n")}\n`;
}

function renderTags(target: RepositoryCollectionTarget, tags: Tag[], truncated: boolean): string {
  const lines = [
    `# ${target.owner}/${target.repo} tags`,
    "",
    "| Tag | Commit | Archive |",
    "| --- | --- | --- |",
  ];
  for (const tag of tags) {
    lines.push(
      `| ${escapeTableCell(tag.name)} | ${tag.commit.sha} | ${escapeTableCell(tag.zipball_url)} |`,
    );
  }
  appendCap(lines, truncated);
  return `${lines.join("\n")}\n`;
}

function renderBranches(
  target: RepositoryCollectionTarget,
  branches: Branch[],
  truncated: boolean,
): string {
  const lines = [
    `# ${target.owner}/${target.repo} branches`,
    "",
    "| Branch | Commit | Protected |",
    "| --- | --- | --- |",
  ];
  for (const branch of branches) {
    lines.push(
      `| ${escapeTableCell(branch.name)} | ${branch.commit.sha} | ${branch.protected ? "yes" : "no"} |`,
    );
  }
  appendCap(lines, truncated);
  return `${lines.join("\n")}\n`;
}

function appendCap(lines: string[], truncated: boolean): void {
  if (truncated) lines.push("", `[listing capped at ${COLLECTION_LIMIT} items]`);
}
