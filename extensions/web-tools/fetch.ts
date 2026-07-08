import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { FetchWarning, UrlOutcome, WebFetcher } from "./contract.ts";
import { deliverFetchResults } from "./delivery.ts";
import { fetchDocuments } from "./router.ts";
import { formatWarnings, getErrorMessage } from "./shared.ts";

type FetchWebDetails = {
  count?: number;
  artifactRoot?: string;
  resolved?: UrlOutcome[];
  failed?: UrlOutcome[];
  warnings?: FetchWarning[] | null;
};

type RenderableToolResult<TDetails> = {
  content: Array<{ type: string; text?: string }>;
  details?: TDetails;
  isError?: boolean;
};

const fetchWebParameters = Type.Object({
  urls: Type.Array(Type.String({ description: "A URL to extract." }), {
    description: "One or more URLs to extract.",
    minItems: 1,
    maxItems: 10,
  }),
  objective: Type.Optional(
    Type.String({
      description: "Optional extraction goal. Source-native fetchers ignore it.",
    }),
  ),
});

export function createFetchWebTool(
  fetchers: WebFetcher[],
): ToolDefinition<typeof fetchWebParameters, FetchWebDetails> {
  return {
    name: "fetch_web",
    label: "Fetch Web",
    description:
      "Fetch specific URLs. Every document's content is written as native files (markdown, patches, source files) under a per-call artifact directory; the tool result is a digest with per-document facts, file paths, and a short excerpt.",
    promptSnippet:
      "Use when you already have a specific URL and need the page contents or source-native artifacts.",
    promptGuidelines: [
      "GitHub URLs use a source-native fetcher: issues, PRs, repos, individual files, and directories return structured responses.",
      "Repo issue/PR lists and searches are fetchable via github.com/{owner}/{repo}/issues or /pulls, optionally with ?q= in GitHub search syntax, returning up to 100 matches.",
    ],
    parameters: fetchWebParameters,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Fetching ${params.urls.length} URL(s) from the web...`,
          },
        ],
        details: {},
      });

      try {
        const result = await fetchDocuments(fetchers, params.urls, params.objective, signal, ctx);
        const delivery = deliverFetchResults(result);
        return {
          content: [{ type: "text", text: delivery.text }],
          details: {
            count: delivery.resolved.length,
            artifactRoot: result.artifactRoot,
            resolved: delivery.resolved,
            failed: delivery.failed,
            warnings: result.warnings.length > 0 ? result.warnings : null,
          },
        };
      } catch (error) {
        throw new Error(`fetch_web failed: ${getErrorMessage(error)}`);
      }
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("fetch_web"));

      if (context.isPartial) {
        const primaryUrl = args.urls.find((url: string) => url.trim())?.trim() ?? "";
        const extraUrls = Math.max(args.urls.filter((url: string) => url.trim()).length - 1, 0);
        if (primaryUrl) {
          text += theme.fg("toolTitle", " ");
          text += theme.fg("muted", primaryUrl);
        }
        if (extraUrls > 0) {
          text += theme.fg("dim", ` +${extraUrls} more`);
        }
      }

      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const renderedResult = result as RenderableToolResult<FetchWebDetails>;
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      if (context.isError) {
        const text =
          renderedResult.content[0]?.type === "text"
            ? (renderedResult.content[0].text ?? "Fetch failed")
            : "Fetch failed";
        return new Text(theme.fg("error", text), 0, 0);
      }

      const details = (renderedResult.details ?? {}) as FetchWebDetails;
      const count = details.count ?? details.resolved?.length ?? 0;
      let text = theme.fg("success", `${count} document${count === 1 ? "" : "s"} fetched`);
      if (details.artifactRoot) text += `\n${theme.fg("dim", details.artifactRoot)}`;

      const warningLines = formatWarnings(details.warnings);
      if (warningLines.length > 0) {
        text += `\n${theme.fg("warning", expanded ? "Warnings:" : `Warnings: ${warningLines.length}`)}`;
        if (expanded) {
          for (const warning of warningLines) text += `\n${theme.fg("warning", `- ${warning}`)}`;
        }
      }

      const failedCount = details.failed?.length ?? 0;
      if (failedCount > 0) {
        text += `\n${theme.fg("error", `${failedCount} URL${failedCount === 1 ? "" : "s"} failed`)}`;
        if (expanded) {
          for (const outcome of details.failed ?? []) {
            text += `\n${theme.fg("error", `- ${outcome.url}`)}`;
          }
        }
      }

      for (const outcome of details.resolved ?? []) {
        const document = outcome.document;
        if (!document) continue;
        text += `\n${theme.fg("accent", `[${document.kind}] ${document.title}`)}`;
        for (const body of document.bodies) {
          const location = details.artifactRoot
            ? `${details.artifactRoot}/${body.path}`
            : body.path;
          text += `\n${theme.fg("dim", `   ${location}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  };
}
