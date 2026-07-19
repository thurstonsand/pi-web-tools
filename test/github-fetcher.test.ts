import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createGitHubFetcher } from "../extensions/web-tools/fetchers/github/index.ts";

describe("GitHub fetcher authentication", () => {
  it("declines Discussions without making an unauthenticated GraphQL request", async () => {
    const getToken = vi.fn(async () => undefined);
    const fetcher = createGitHubFetcher({ getToken });

    const result = await fetcher.fetch({
      urls: ["https://github.com/vercel/next.js/discussions/41745"],
      artifactDir: "/tmp/pi-web-tools-test",
      ctx: {} as ExtensionContext,
    });

    expect(result).toEqual({ documents: [], failures: [], warnings: [] });
  });

  it("advertises Discussions without resolving auth during construction", () => {
    const getToken = vi.fn(async () => "token");
    const fetcher = createGitHubFetcher({ getToken });

    expect(fetcher.promptGuidelines[0]).toContain("Discussions");
    expect(getToken).not.toHaveBeenCalled();
  });
});
