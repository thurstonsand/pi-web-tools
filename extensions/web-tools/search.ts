import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  buildSearchSummary,
  clampMaxResults,
  createParallelClient,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MODE,
  normalizeSearchQueries,
  type ParallelConstructor,
  validateAfterDate,
} from "./fetchers/parallel.ts";
import { formatWarnings, getErrorMessage, summarizeExcerpt } from "./shared.ts";

type SearchResultItem = {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
};

type SearchWarning = {
  message?: string | null;
  type?: string | null;
};

type WebSearchDetails = {
  objective?: string;
  count?: number;
  results?: SearchResultItem[];
  warnings?: SearchWarning[] | null;
};

type RenderableToolResult<TDetails> = {
  content: Array<{ type: string; text?: string }>;
  details?: TDetails;
  isError?: boolean;
};

const webSearchParameters = Type.Object({
  objective: Type.String({
    description: "What you want to learn from the web search.",
  }),
  search_queries: Type.Optional(
    Type.Array(Type.String({ description: "A search query string." }), {
      description:
        "Specific search queries to run. If omitted, the objective is used as a single query.",
      minItems: 1,
      maxItems: 8,
    }),
  ),
  max_results: Type.Optional(
    Type.Integer({
      description: `Upper bound on results to return. Defaults to ${DEFAULT_MAX_RESULTS}; capped at 8.`,
      minimum: 1,
      maximum: 8,
    }),
  ),
  after_date: Type.Optional(
    Type.String({
      description:
        "Only include results published on or after this RFC 3339 date (YYYY-MM-DD). Set it when recent results matter.",
    }),
  ),
});

export function createWebSearchTool(Parallel: ParallelConstructor) {
  return defineTool({
    name: "web_search",
    label: "Search Web",
    description: "Search the web and return relevant results with excerpts.",
    promptSnippet: "Search the web for sources and current information",
    promptGuidelines: ["Prefer a focused objective and 1-5 specific queries for web_search."],
    parameters: webSearchParameters,
    execute: async (_toolCallId, params, _signal, onUpdate) => {
      const searchQueries = normalizeSearchQueries(params.search_queries, params.objective);

      onUpdate?.({
        content: [{ type: "text", text: `Searching the web for: ${params.objective}` }],
        details: { objective: params.objective } satisfies WebSearchDetails,
      });

      try {
        const client = createParallelClient(Parallel);
        const afterDate = validateAfterDate(params.after_date);
        const result = await client.search({
          objective: params.objective,
          search_queries: searchQueries,
          mode: DEFAULT_SEARCH_MODE,
          advanced_settings: {
            max_results: clampMaxResults(params.max_results),
            ...(afterDate ? { source_policy: { after_date: afterDate } } : {}),
          },
        });

        const results = Array.isArray(result.results) ? (result.results as SearchResultItem[]) : [];
        const warnings = Array.isArray(result.warnings)
          ? (result.warnings as SearchWarning[])
          : null;
        return {
          content: [{ type: "text", text: buildSearchSummary(results, warnings) }],
          details: {
            objective: params.objective,
            count: results.length,
            results,
            warnings,
          } satisfies WebSearchDetails,
        };
      } catch (error) {
        throw new Error(`Parallel search failed: ${getErrorMessage(error)}`);
      }
    },
    renderCall(args, theme) {
      const primaryQuery = (
        args.search_queries?.find((query: string) => query.trim()) ?? args.objective
      ).trim();
      const extraQueries = Math.max(
        (args.search_queries?.filter((query: string) => query.trim()).length ?? 1) - 1,
        0,
      );

      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("muted", primaryQuery);
      if (extraQueries > 0) {
        text += theme.fg("dim", ` +${extraQueries} more`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const renderedResult = result as RenderableToolResult<WebSearchDetails>;
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }
      if (context.isError) {
        const text =
          renderedResult.content[0]?.type === "text"
            ? (renderedResult.content[0].text ?? "Search failed")
            : "Search failed";
        return new Text(theme.fg("error", text), 0, 0);
      }

      const details = (renderedResult.details ?? {}) as WebSearchDetails;
      const count = details.count ?? details.results?.length ?? 0;
      let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
      const warningLines = formatWarnings(details.warnings);
      if (warningLines.length > 0) {
        text += `\n${theme.fg("warning", expanded ? "Warnings:" : `Warnings: ${warningLines.length}`)}`;
        if (expanded) {
          for (const warning of warningLines) {
            text += `\n${theme.fg("warning", `- ${warning}`)}`;
          }
        }
      }

      if (details.results?.length) {
        for (const [index, item] of details.results.entries()) {
          const title = item.title?.trim() || item.url;
          const publishDate = item.publish_date ? ` (${item.publish_date})` : "";
          const excerpt = summarizeExcerpt(item.excerpts?.[0], expanded ? 240 : 120);
          text += `\n${theme.fg("accent", `${index + 1}. ${title}${publishDate}`)}`;
          text += `\n${theme.fg("dim", item.url)}`;
          if (excerpt) text += `\n${theme.fg("muted", excerpt)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
