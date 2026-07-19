import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import type { FetchedDocument } from "../../contract.ts";
import { writeDocumentBody } from "../../shared.ts";
import { escapeTableCell, requestOptions } from "./shared.ts";
import type { GitHubRepo, ReleaseTarget } from "./urls.ts";

type GitHubRelease = RestEndpointMethodTypes["repos"]["getReleaseByTag"]["response"]["data"];

export async function fetchRelease(
  octokit: Octokit,
  target: ReleaseTarget,
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.repos.getReleaseByTag({
    owner: target.owner,
    repo: target.repo,
    tag: target.tag,
    ...requestOptions(signal),
  });
  return await buildReleaseDocument(target, response.data, artifactDir);
}

export async function fetchLatestRelease(
  octokit: Octokit,
  target: GitHubRepo & { url: string },
  signal: AbortSignal | undefined,
  artifactDir: string,
): Promise<FetchedDocument> {
  const response = await octokit.rest.repos.getLatestRelease({
    owner: target.owner,
    repo: target.repo,
    ...requestOptions(signal),
  });
  return await buildReleaseDocument(target, response.data, artifactDir);
}

async function buildReleaseDocument(
  target: GitHubRepo & { url: string },
  release: GitHubRelease,
  artifactDir: string,
): Promise<FetchedDocument> {
  const title = release.name || release.tag_name;
  return {
    kind: "github.release",
    source: "github",
    url: target.url,
    link: release.html_url,
    title: `${target.owner}/${target.repo} ${title}`,
    facts: [
      `tag ${release.tag_name}`,
      ...(release.draft ? ["draft"] : []),
      ...(release.prerelease ? ["prerelease"] : []),
      ...(release.author?.login ? [`by ${release.author.login}`] : []),
      ...(release.published_at ? [`published ${release.published_at}`] : []),
      `${release.assets.length} asset${release.assets.length === 1 ? "" : "s"}`,
    ],
    excerpt: release.body ?? undefined,
    bodies: [
      await writeDocumentBody(
        artifactDir,
        target.url,
        "release.md",
        renderReleaseMarkdown(release),
      ),
    ],
  };
}

function renderReleaseMarkdown(release: GitHubRelease): string {
  const lines = [
    `# ${release.name || release.tag_name}`,
    "",
    `- Tag: ${release.tag_name}`,
    `- Target: ${release.target_commitish}`,
    `- Author: ${release.author?.login ?? "unknown"}`,
    `- Created: ${release.created_at}`,
    `- Published: ${release.published_at ?? "not published"}`,
    `- Draft: ${release.draft ? "yes" : "no"}`,
    `- Prerelease: ${release.prerelease ? "yes" : "no"}`,
    `- URL: ${release.html_url}`,
    "",
    "## Release notes",
    "",
    release.body ?? "(no release notes)",
    "",
    "## Assets",
    "",
  ];

  if (release.assets.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }

  lines.push(
    "| Name | Content type | Size | Downloads | URL |",
    "| --- | --- | ---: | ---: | --- |",
  );
  for (const asset of release.assets) {
    lines.push(
      `| ${escapeTableCell(asset.name)} | ${escapeTableCell(asset.content_type)} | ${asset.size} | ${asset.download_count} | ${escapeTableCell(asset.browser_download_url)} |`,
    );
  }
  return lines.join("\n");
}
