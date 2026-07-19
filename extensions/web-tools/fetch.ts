import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { FetchWarning, UrlOutcome, WebFetcher } from "./contract.ts";
import { deliverFetchResults } from "./delivery.ts";
import { fetchDocuments } from "./router.ts";
import {
  formatToolDuration,
  formatWarnings,
  getErrorMessage,
  startToolTiming,
  type ToolTimingState,
  updateToolTiming,
} from "./shared.ts";

type WebFetchDetails = {
  count?: number;
  artifactRoot?: string;
  outcomes?: UrlOutcome[];
  resolved?: UrlOutcome[];
  failed?: UrlOutcome[];
  warnings?: FetchWarning[] | null;
};

type RenderableToolResult<TDetails> = {
  content: Array<{ type: string; text?: string }>;
  details?: TDetails;
  isError?: boolean;
};

function formatAttemptTrail(outcome: UrlOutcome): string {
  if (outcome.attempts.length === 0) return "no fetcher could handle this URL";
  return outcome.attempts.map((attempt) => `${attempt.source}: ${attempt.reason}`).join(" → ");
}

const webFetchParameters = Type.Object({
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

export function createWebFetchTool(fetchers: WebFetcher[]) {
  return defineTool({
    name: "web_fetch",
    label: "Fetch Web",
    description:
      "Fetch specific URLs. Every document's content is written as native files (markdown, patches, source files) under a per-call artifact directory; the tool result is a digest with per-document facts, file paths, and a short excerpt.",
    promptSnippet: "Fetch contents of URLs",
    promptGuidelines: [
      ...fetchers.flatMap((fetcher) => fetcher.promptGuidelines),
      "Use web_fetch when you already have a specific URL and need more than search snippets.",
    ],
    parameters: webFetchParameters,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Fetching ${params.urls.length} URL(s) from the web...`,
          },
        ],
        details: {} satisfies WebFetchDetails,
      });

      try {
        const result = await fetchDocuments(fetchers, params.urls, params.objective, signal, ctx);
        const delivery = deliverFetchResults(result);
        return {
          content: [{ type: "text", text: delivery.text }],
          details: {
            count: delivery.resolved.length,
            artifactRoot: result.artifactRoot,
            outcomes: result.outcomes,
            resolved: delivery.resolved,
            failed: delivery.failed,
            warnings: result.warnings.length > 0 ? result.warnings : null,
          } satisfies WebFetchDetails,
        };
      } catch (error) {
        throw new Error(`web_fetch failed: ${getErrorMessage(error)}`);
      }
    },
    renderCall(args, theme, context) {
      const state = context.state as ToolTimingState;
      startToolTiming(state, context.executionStarted);

      let text = theme.fg("toolTitle", theme.bold("web_fetch"));
      if (!context.isPartial) return new Text(text, 0, 0);

      const urls = args.urls.map((url: string) => url.trim()).filter(Boolean);
      if (context.expanded) {
        for (const [index, url] of urls.entries()) {
          text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("accent", url)}`;
        }
      } else if (urls[0]) {
        text += `\n${theme.fg("dim", "1.")} ${theme.fg("accent", urls[0])}`;
        if (urls.length > 1) text += theme.fg("dim", `  [+${urls.length - 1} more]`);
      }

      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as ToolTimingState;
      updateToolTiming(state, isPartial, context.isError, context.invalidate);
      const duration = formatToolDuration(state);
      const renderedResult = result as RenderableToolResult<WebFetchDetails>;
      if (isPartial) {
        return new Text(
          `${theme.fg("warning", "Extracting...")} ${theme.fg("dim", duration)}`,
          0,
          0,
        );
      }
      if (context.isError) {
        const error =
          renderedResult.content[0]?.type === "text"
            ? (renderedResult.content[0].text ?? "Fetch failed")
            : "Fetch failed";
        return new Text(
          `${theme.fg("error", error)}\n${theme.fg("dim", `Extracted in ${duration}`)}`,
          0,
          0,
        );
      }

      const details = (renderedResult.details ?? {}) as WebFetchDetails;
      const count = details.count ?? details.resolved?.length ?? 0;
      const failedCount = details.failed?.length ?? 0;
      let text = theme.fg("success", `${count} document${count === 1 ? "" : "s"}`);
      if (failedCount > 0) {
        text += theme.fg("toolOutput", ", ");
        text += theme.fg("error", `${failedCount} failed`);
      }

      const outcomes = details.outcomes ?? [...(details.resolved ?? []), ...(details.failed ?? [])];
      for (const [index, outcome] of outcomes.entries()) {
        const document = outcome.document;
        if (document) {
          text += `\n${theme.fg("dim", `${index + 1}. [${document.kind}]`)} ${theme.fg("accent", outcome.url)}`;
          if (expanded) {
            text += `\n${theme.fg("muted", `   ${document.title}`)}`;
            for (const body of document.bodies) {
              const location = details.artifactRoot
                ? `${details.artifactRoot}/${body.path}`
                : body.path;
              text += `\n${theme.fg("dim", `   ${location}`)}`;
            }
          }
          continue;
        }

        text += `\n${theme.fg("dim", `${index + 1}.`)} ${theme.fg("error", "[failed]")} ${theme.fg("accent", outcome.url)}`;
        if (expanded) text += `\n${theme.fg("error", `   ${formatAttemptTrail(outcome)}`)}`;
      }

      const warningLines = formatWarnings(details.warnings);
      if (warningLines.length > 0) {
        text += `\n${theme.fg("warning", expanded ? "Warnings:" : `Warnings: ${warningLines.length}`)}`;
        if (expanded) {
          for (const warning of warningLines) text += `\n${theme.fg("warning", `- ${warning}`)}`;
        }
      }
      text += `\n${theme.fg("dim", `Extracted in ${duration}`)}`;

      return new Text(text, 0, 0);
    },
  });
}
