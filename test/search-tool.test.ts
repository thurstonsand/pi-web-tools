import type { ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import type ParallelClient from "parallel-web";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("web_search result rows", () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  const render = () =>
    toolWithResponse(undefined)
      .renderResult?.(
        {
          content: [],
          details: { count: 1, results: [{ url: "https://a.example/page", title: "A page" }] },
        },
        { expanded: false, isPartial: false },
        { fg: (_color: string, text: string) => text } as unknown as Theme,
        { state: {}, isError: false, invalidate: vi.fn() } as never,
      )
      .render(80)
      .join("\n");

  it("links each title to its result when the terminal supports hyperlinks", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    expect(render()).toContain("\x1b]8;;https://a.example/page\x1b\\1. A page\x1b]8;;\x1b\\");
  });

  it("leaves titles as plain text when the terminal does not support hyperlinks", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    expect(render()).toContain("1. A page");
    expect(render()).not.toContain("\x1b]8;;");
  });
});
