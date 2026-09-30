import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type ParallelClient from "parallel-web";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createWebSearchTool } from "../extensions/web-tools/search.ts";

describe("web_search structured content", () => {
  it("matches the output schema with absent Parallel fields as null", async () => {
    const client = {
      search: async () => ({
        results: [
          { url: "https://a.example", title: "A", publish_date: "2026-09-01", excerpts: ["a"] },
          { url: "https://b.example" },
        ],
        warnings: [{ message: "partial" }],
      }),
    } as unknown as ParallelClient;
    const tool = createWebSearchTool(async () => client);

    const result = await tool.execute(
      "call",
      { objective: "test" },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );

    if (!tool.outputSchema) throw new Error("web_search declares no outputSchema");
    expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toEqual({
      results: [
        { url: "https://a.example", title: "A", publish_date: "2026-09-01", excerpts: ["a"] },
        { url: "https://b.example", title: null, publish_date: null, excerpts: [] },
      ],
      warnings: [{ message: "partial", type: null }],
    });
  });
});
