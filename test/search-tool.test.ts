import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type ParallelClient from "parallel-web";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createWebSearchTool } from "../extensions/web-tools/search.ts";

function toolWithResponse(response: unknown) {
  const client = { search: async () => response } as unknown as ParallelClient;
  return createWebSearchTool(async () => client);
}

describe("web_search structured content", () => {
  it("omits fields Parallel returns as null", async () => {
    const tool = toolWithResponse({
      results: [
        { url: "https://a.example", title: "A", publish_date: "2026-09-01", excerpts: ["a"] },
        { url: "https://b.example", title: null, publish_date: null, excerpts: [] },
      ],
      warnings: [{ message: "partial", type: "warning" }],
    });

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
        { url: "https://b.example", excerpts: [] },
      ],
      warnings: [{ message: "partial", type: "warning" }],
    });
  });

  it("rejects a response that does not match Parallel's contract", async () => {
    const tool = toolWithResponse({ results: [{ url: "https://a.example" }] });

    await expect(
      tool.execute("call", { objective: "test" }, undefined, undefined, {} as ExtensionToolContext),
    ).rejects.toThrow(
      "Parallel search failed: Parallel search response: /results/0 must have required properties excerpts",
    );
  });
});
