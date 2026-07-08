import { describe, expect, it } from "vitest";
import { buildListQuery } from "../extensions/web-tools/fetchers/github/listing.ts";

describe("buildListQuery", () => {
  const base = { owner: "owner", repo: "repo", url: "https://github.com/owner/repo/issues" };

  it("adds type and open state for bare issue and pull tabs", () => {
    expect(buildListQuery({ ...base, tab: "issues" })).toBe("repo:owner/repo is:issue state:open");
    expect(buildListQuery({ ...base, tab: "pulls" })).toBe("repo:owner/repo is:pr state:open");
  });

  it("does not add state:open to explicit searches", () => {
    expect(buildListQuery({ ...base, tab: "issues", q: "label:bug" })).toBe(
      "repo:owner/repo is:issue label:bug",
    );
  });

  it("honors explicit type qualifiers", () => {
    expect(buildListQuery({ ...base, tab: "issues", q: "is:pr is:merged" })).toBe(
      "repo:owner/repo is:pr is:merged",
    );
    expect(buildListQuery({ ...base, tab: "pulls", q: "type:issue crash" })).toBe(
      "repo:owner/repo type:issue crash",
    );
  });

  it("treats merged qualifiers as PR-implying", () => {
    expect(buildListQuery({ ...base, tab: "pulls", q: "is:merged sort:created-asc" })).toBe(
      "repo:owner/repo is:merged sort:created-asc",
    );
  });
});
