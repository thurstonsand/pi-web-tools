import { describe, expect, it } from "vitest";
import type { WebFetcher } from "../extensions/web-tools/contract.ts";
import { createWebFetchTool } from "../extensions/web-tools/fetch.ts";

const fetcher: WebFetcher = {
  source: "test",
  promptGuidelines: ["Fetcher-specific guidance."],
  canFetch: () => false,
  async fetch() {
    return { documents: [], failures: [], warnings: [] };
  },
};

describe("web_fetch prompt guidance", () => {
  it("assembles fetcher guidance with its own general guidance", () => {
    const tool = createWebFetchTool([fetcher]);

    expect(tool.promptGuidelines).toEqual([
      "Fetcher-specific guidance.",
      "Use web_fetch when you already have a specific URL and need more than search snippets.",
    ]);
  });
});
