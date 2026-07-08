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

  it("rejects unsupported issue paths", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/issues/new")).toBeUndefined();
  });
});
