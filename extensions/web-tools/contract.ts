import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FetchWarning = {
  message: string;
  type?: string;
};

export interface DocumentBody {
  name: string;
  path: string; // relative to the call's artifact root; fetchers cannot address outside it
  lines: number;
  bytes: number;
}

export interface FetchedDocument {
  kind: string;
  source: string;
  url: string;
  link?: string | undefined;
  title: string;
  facts: string[];
  excerpt?: string | undefined;
  highlights?: string[] | undefined; // objective-steered spans; rendered in full, never capped
  bodies: DocumentBody[];
}

export interface FetchFailure {
  url: string;
  reason: string;
}

export interface FailedAttempt extends FetchFailure {
  source: string;
}

export interface FetcherRequest {
  urls: string[];
  artifactDir: string;
  objective?: string | undefined;
  signal?: AbortSignal | undefined;
  ctx: ExtensionContext;
}

export interface FetcherResult {
  documents: FetchedDocument[];
  failures: FetchFailure[];
  warnings: FetchWarning[];
}

export interface WebFetcher {
  source: string;
  promptGuidelines: string[];
  canFetch(url: string): boolean;
  fetch(request: FetcherRequest): Promise<FetcherResult>;
}

export interface UrlOutcome {
  url: string;
  document?: FetchedDocument | undefined;
  attempts: FailedAttempt[];
}

export interface RoutedFetchResult {
  outcomes: UrlOutcome[];
  warnings: FetchWarning[];
  artifactRoot: string;
}
