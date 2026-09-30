import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createLocalFetcher } from "../extensions/web-tools/fetchers/local/local.ts";

describe("createLocalFetcher", () => {
  it("addresses a downloaded file by its absolute path under the artifact directory", async () => {
    const fetcher = createLocalFetcher(
      {
        fetch: async () => ({
          finalUrl: "https://example.com/report.pdf",
          name: "report.pdf",
          contentType: "application/pdf",
          bytes: 2048,
        }),
        openBrowser: async () => {},
        restart: async () => {},
      },
      { name: "unused", extractToMarkdown: async () => "" },
    );

    const { documents } = await fetcher.fetch({
      urls: ["https://example.com/report.pdf"],
      artifactDir: "/tmp/pi-fetch/run",
      ctx: {} as ExtensionContext,
    });

    expect(documents[0]?.bodies).toEqual([
      {
        name: "report.pdf",
        path: "/tmp/pi-fetch/run/example-com-report-pdf/report.pdf",
        lines: 0,
        bytes: 2048,
      },
    ]);
  });
});
