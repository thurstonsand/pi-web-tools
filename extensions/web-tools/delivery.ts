import path from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { FetchedDocument, RoutedFetchResult, UrlOutcome } from "./contract.ts";
import { summarizeExcerpt } from "./shared.ts";

const EXCERPT_LENGTH = 260;

export type DeliveryResult = {
  text: string;
  resolved: UrlOutcome[];
  failed: UrlOutcome[];
};

export function deliverFetchResults(result: RoutedFetchResult): DeliveryResult {
  const resolved = result.outcomes.filter((outcome) => outcome.document);
  const failed = result.outcomes.filter((outcome) => !outcome.document);
  const sections: string[] = [];

  for (const [index, outcome] of resolved.entries()) {
    if (outcome.document) {
      sections.push(renderDocument(index, outcome.document, result.artifactRoot));
    }
  }

  if (failed.length > 0) {
    sections.push(
      [
        "Failed:",
        ...failed.map((outcome) => `- ${outcome.url}: ${formatAttemptTrail(outcome)}`),
      ].join("\n"),
    );
  }

  return {
    text: sections.join("\n\n") || "No extracted results.",
    resolved,
    failed,
  };
}

function renderDocument(index: number, document: FetchedDocument, artifactRoot: string): string {
  const lines = [`${index + 1}. ${document.title}`];
  if (document.facts.length > 0) lines.push(`   ${document.facts.join(" · ")}`);
  lines.push(`   ${document.link ?? document.url}`);

  const firstBody = document.bodies[0];
  if (firstBody) {
    lines.push(`   bodies (in ${path.join(artifactRoot, path.dirname(firstBody.path))}/):`);
    for (const body of document.bodies) {
      lines.push(
        `   - ${body.name} (${body.lines.toLocaleString()} lines, ${formatSize(body.bytes)})`,
      );
    }
  }

  // Providers choose what an excerpt says; delivery unconditionally bounds how
  // much of it reaches the context window.
  const excerpt = summarizeExcerpt(document.excerpt, EXCERPT_LENGTH);
  if (excerpt) lines.push(`   excerpt: ${excerpt}`);

  // Highlights are objective-steered answers — the content the agent asked
  // for. They are deliberately exempt from the excerpt cap.
  if (document.highlights?.length) {
    lines.push("   highlights:");
    for (const highlight of document.highlights) {
      lines.push(`   - ${highlight.replaceAll("\n", "\n     ")}`);
    }
  }

  return lines.join("\n");
}

function formatAttemptTrail(outcome: UrlOutcome): string {
  if (outcome.attempts.length === 0) return "no fetcher could handle this URL";
  return outcome.attempts.map((attempt) => `${attempt.source}: ${attempt.reason}`).join(" → ");
}
