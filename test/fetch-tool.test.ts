import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
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

describe("web_fetch structured content", () => {
  it("matches the output schema and addresses bodies absolutely", async () => {
    const tool = createWebFetchTool([
      {
        source: "test",
        promptGuidelines: [],
        canFetch: (url) => url.startsWith("https://ok."),
        async fetch({ urls }) {
          return {
            documents: urls.map((url) => ({
              kind: "page",
              source: "test",
              url,
              link: undefined,
              title: "OK",
              facts: ["1 body"],
              excerpt: undefined,
              bodies: [{ name: "page.md", path: "ok/page.md", lines: 3, bytes: 42 }],
            })),
            failures: [],
            warnings: [{ message: "slow" }],
          };
        },
      },
    ]);

    const result = await tool.execute(
      "call",
      { urls: ["https://ok.example", "https://nope.example"] },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );

    if (!tool.outputSchema) throw new Error("web_fetch declares no outputSchema");
    expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toEqual({
      documents: [
        {
          url: "https://ok.example",
          kind: "page",
          source: "test",
          title: "OK",
          facts: ["1 body"],
          bodies: [
            {
              name: "page.md",
              path: expect.stringMatching(/^\/.+\/ok\/page\.md$/),
              lines: 3,
              bytes: 42,
            },
          ],
        },
      ],
      failed: [{ url: "https://nope.example", attempts: [] }],
      warnings: [{ message: "slow" }],
    });
  });
});
