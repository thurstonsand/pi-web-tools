import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalUrl,
  createParallelFetcher,
  type ParallelConstructor,
} from "../extensions/web-tools/fetchers/parallel.ts";

const ctx = {} as ExtensionContext;

function fakeParallel(extractResult: unknown): ParallelConstructor {
  return class {
    beta = {
      extract: async () => extractResult,
    };
    extract = async () => extractResult;
  } as unknown as ParallelConstructor;
}

describe("canonicalUrl", () => {
  it("tolerates percent-encoding drift", () => {
    expect(canonicalUrl("https://en.wikipedia.org/wiki/Transformer_%28deep%29")).toBe(
      canonicalUrl("https://en.wikipedia.org/wiki/Transformer_(deep)"),
    );
  });

  it("ignores trailing slashes and fragments", () => {
    expect(canonicalUrl("https://example.com/a/#top")).toBe(canonicalUrl("https://example.com/a"));
  });

  it("passes through non-urls unchanged", () => {
    expect(canonicalUrl("not a url")).toBe("not a url");
  });
});

describe("createParallelFetcher", () => {
  let artifactDir: string;

  beforeEach(async () => {
    process.env.PARALLEL_API_KEY = "test-key";
    artifactDir = await mkdtemp(path.join(tmpdir(), "parallel-fetch-test-"));
  });

  afterEach(() => {
    delete process.env.PARALLEL_API_KEY;
  });

  it("matches results to requested urls when returned out of order", async () => {
    const urls = ["https://example.com/first", "https://example.com/second"];
    const fetcher = createParallelFetcher(
      fakeParallel({
        results: [
          { url: "https://example.com/second", full_content: "second content" },
          { url: "https://example.com/first", full_content: "first content" },
        ],
      }),
    );

    const { documents } = await fetcher.fetch({ urls, artifactDir, ctx });

    expect(documents.map((doc) => doc.url)).toEqual([
      "https://example.com/second",
      "https://example.com/first",
    ]);
    const firstBody = documents.find((doc) => doc.url === "https://example.com/first")?.bodies[0];
    expect(firstBody).toBeDefined();
    if (!firstBody) return;
    const body = await readFile(path.join(artifactDir, firstBody.path), "utf8");
    expect(body).toBe("first content");
    expect(firstBody.path).toContain("example-com-first");
  });

  it("maps percent-encoded result urls back to the requested url", async () => {
    const requested = "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)";
    const fetcher = createParallelFetcher(
      fakeParallel({
        results: [
          {
            url: "https://en.wikipedia.org/wiki/Transformer_%28deep_learning_architecture%29",
            full_content: "wiki content",
          },
        ],
      }),
    );

    const { documents } = await fetcher.fetch({ urls: [requested], artifactDir, ctx });

    expect(documents[0]?.url).toBe(requested);
  });

  it("falls back to the item url when nothing matches", async () => {
    const fetcher = createParallelFetcher(
      fakeParallel({
        results: [{ url: "https://redirected.example.com/", full_content: "content" }],
      }),
    );

    const { documents } = await fetcher.fetch({
      urls: ["https://example.com/original"],
      artifactDir,
      ctx,
    });

    expect(documents[0]?.url).toBe("https://redirected.example.com/");
  });
});
