import Parallel from "parallel-web";
import type { FetchedDocument, FetchWarning, WebFetcher } from "../contract.ts";
import { formatWarnings, writeDocumentBody } from "../shared.ts";

export const API_KEY_ENV = "PARALLEL_API_KEY";
export const DEFAULT_SEARCH_MODE: "basic" | "advanced" = "advanced";
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_MAX_RESULTS = 8;

export function hasParallelApiKey(): boolean {
  return Boolean(process.env[API_KEY_ENV]);
}

export function getParallelClient(): Parallel {
  const apiKey = process.env[API_KEY_ENV];
  if (!apiKey) {
    throw new Error(`${API_KEY_ENV} is not set`);
  }
  return new Parallel({ apiKey });
}

export function normalizeSearchQueries(
  searchQueries: string[] | undefined,
  objective: string,
): string[] {
  const cleaned = (searchQueries ?? []).map((query) => query.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : [objective];
}

export function clampMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(maxResults, 1), MAX_MAX_RESULTS);
}

export function validateAfterDate(afterDate: string | undefined): string | undefined {
  if (!afterDate) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(afterDate)) {
    throw new Error(`Invalid after_date: ${afterDate}. Expected YYYY-MM-DD.`);
  }

  const date = new Date(`${afterDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== afterDate) {
    throw new Error(
      `Invalid after_date: ${afterDate}. Expected a real calendar date in YYYY-MM-DD format.`,
    );
  }
  return afterDate;
}

export function formatExtractErrors(
  errors:
    | Array<{
        url: string;
        error_type?: string | null;
        http_status_code?: number | null;
        content?: string | null;
      }>
    | undefined
    | null,
): string[] {
  if (!errors?.length) return [];
  return errors.map(formatParallelError);
}

export function buildSearchSummary(
  results: Array<{
    title?: string | null;
    url: string;
    publish_date?: string | null;
    excerpts?: string[] | null;
  }>,
  warnings?: Array<{ message?: string | null; type?: string | null }> | null,
): string {
  const warningLines = formatWarnings(warnings);
  const resultText =
    results.length === 0
      ? "No results."
      : results
          .map((result, index) => {
            const title = result.title?.trim() || result.url;
            const publishDate = result.publish_date ? ` (${result.publish_date})` : "";
            const excerpts = (result.excerpts ?? []).map((excerpt, excerptIndex) => {
              const prefix =
                result.excerpts && result.excerpts.length > 1
                  ? `   Excerpt ${excerptIndex + 1}: `
                  : "   ";
              return `${prefix}${excerpt}`;
            });
            return [`${index + 1}. ${title}${publishDate}`, `   ${result.url}`, ...excerpts].join(
              "\n",
            );
          })
          .join("\n\n");

  if (warningLines.length === 0) return resultText;
  return [`Warnings:`, ...warningLines.map((warning) => `- ${warning}`), "", resultText].join("\n");
}

export interface ParallelDocument extends FetchedDocument {
  kind: "parallel.page";
  source: "parallel";
}

export type ParallelFetchResultItem = {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
  full_content?: string | null;
};

export type ParallelFetchWarning = {
  message?: string | null;
  type?: string | null;
};

export type ParallelFetchError = {
  url: string;
  error_type?: string | null;
  http_status_code?: number | null;
  content?: string | null;
};

export function createParallelFetcher(): WebFetcher {
  return {
    source: "parallel",
    canFetch: () => hasParallelApiKey(),
    async fetch({ urls, objective, artifactDir }) {
      const client = getParallelClient();
      const result = await client.extract({
        urls,
        ...(objective ? { objective } : {}),
        advanced_settings: { full_content: true },
      });

      const results = Array.isArray(result.results)
        ? (result.results as ParallelFetchResultItem[])
        : [];
      const warnings = Array.isArray(result.warnings)
        ? normalizeParallelWarnings(result.warnings as ParallelFetchWarning[])
        : [];
      const errors = Array.isArray(result.errors) ? (result.errors as ParallelFetchError[]) : [];

      // Positional url mapping is only trustworthy when every url produced a
      // result; with partial errors the results array shrinks and indexes
      // would misattribute content, so fall back to the item's own url.
      const aligned = results.length === urls.length;
      const documents = await Promise.all(
        results.map(async (item, index): Promise<ParallelDocument> => {
          const requestedUrl = aligned ? (urls[index] ?? item.url) : item.url;
          const body = await writeDocumentBody(
            artifactDir,
            requestedUrl,
            "content.md",
            item.full_content ?? "",
          );
          return {
            kind: "parallel.page",
            source: "parallel",
            url: requestedUrl,
            ...(item.url !== requestedUrl ? { link: item.url } : {}),
            title: item.title?.trim() || item.url,
            facts: item.publish_date ? [`published ${item.publish_date}`] : [],
            // With an objective, Parallel's excerpts are the steered answer the
            // agent asked for — deliver all of them uncapped as highlights.
            ...(objective ? { highlights: item.excerpts ?? [] } : { excerpt: item.excerpts?.[0] }),
            bodies: [body],
          };
        }),
      );
      return {
        documents,
        warnings,
        failures: errors.map((error) => ({
          url: error.url,
          reason: formatParallelError(error),
        })),
      };
    },
  };
}

function normalizeParallelWarnings(warnings: ParallelFetchWarning[]): FetchWarning[] {
  return formatWarnings(warnings).map((message) => ({ type: "parallel", message }));
}

function formatParallelError(error: ParallelFetchError): string {
  const bits = [];
  if (error.error_type) bits.push(`type=${error.error_type}`);
  if (error.http_status_code != null) bits.push(`status=${error.http_status_code}`);
  if (error.content?.trim()) bits.push(`content=${error.content.trim()}`);
  return bits.join(" | ") || "extraction failed";
}
