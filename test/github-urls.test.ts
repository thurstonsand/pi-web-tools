import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "../extensions/web-tools/fetchers/github/urls.ts";

describe("parseGitHubUrl", () => {
  it("claims bare issue and pull request lists", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/issues")).toMatchObject({
      type: "issue_list",
      target: { owner: "owner", repo: "repo", tab: "issues" },
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/pulls")).toMatchObject({
      type: "pull_request_list",
      target: { owner: "owner", repo: "repo", tab: "pulls" },
    });
  });

  it("decodes q parameters", () => {
    expect(
      parseGitHubUrl("https://github.com/owner/repo/issues?q=is%3Aclosed+extraction"),
    ).toMatchObject({
      type: "issue_list",
      target: { q: "is:closed extraction" },
    });
  });

  it("claims tagged releases", () => {
    expect(
      parseGitHubUrl("https://github.com/handy-computer/transcribe.cpp/releases/tag/v0.1.3"),
    ).toEqual({
      type: "release",
      target: {
        owner: "handy-computer",
        repo: "transcribe.cpp",
        tag: "v0.1.3",
        url: "https://github.com/handy-computer/transcribe.cpp/releases/tag/v0.1.3",
      },
    });
  });

  it("preserves slashes in release tags", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/releases/tag/release%2Fv1")).toMatchObject(
      {
        type: "release",
        target: { tag: "release/v1" },
      },
    );
  });

  it("claims commits", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/commit/deadbeef")).toMatchObject({
      type: "commit",
      target: { owner: "owner", repo: "repo", ref: "deadbeef" },
    });
  });

  it("claims repository collections and the latest release", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/releases")).toMatchObject({
      type: "repository_collection",
      target: { collection: "releases" },
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/releases/latest")).toMatchObject({
      type: "latest_release",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/tags")).toMatchObject({
      type: "repository_collection",
      target: { collection: "tags" },
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/branches")).toMatchObject({
      type: "repository_collection",
      target: { collection: "branches" },
    });
  });

  it("claims Actions run collections, runs, and their subpages", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/actions")).toMatchObject({
      type: "action_run_list",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/actions/runs")).toMatchObject({
      type: "action_run_list",
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/actions/runs/123456")).toMatchObject({
      type: "action_run",
      target: { runId: 123456 },
    });
    expect(
      parseGitHubUrl("https://github.com/owner/repo/actions/runs/123456/job/789"),
    ).toMatchObject({
      type: "action_run",
      target: { runId: 123456 },
    });
  });

  it("claims discussions", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/discussions/42")).toMatchObject({
      type: "discussion",
      target: { number: 42 },
    });
  });

  it("accepts /pulls/{number} as a pull request", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/pulls/123")).toMatchObject({
      type: "pull_request",
      target: { number: 123 },
    });
  });

  it("keeps native issue and pull request resolution on tab URLs", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/pull/123/files")).toMatchObject({
      type: "pull_request",
      target: { number: 123 },
    });
    expect(parseGitHubUrl("https://github.com/owner/repo/issues/456/comments")).toMatchObject({
      type: "issue",
      target: { number: 456 },
    });
  });

  it("rejects unsupported and malformed paths", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/issues/new")).toBeUndefined();
    expect(parseGitHubUrl("https://github.com/owner/repo/releases/tag")).toBeUndefined();
    expect(parseGitHubUrl("https://github.com/owner/repo/commit/deadbeef/files")).toBeUndefined();
    expect(parseGitHubUrl("https://github.com/owner/repo/actions/runs/123abc")).toBeUndefined();
    expect(parseGitHubUrl("https://github.com/owner/repo/discussions/42abc")).toBeUndefined();
  });
});
