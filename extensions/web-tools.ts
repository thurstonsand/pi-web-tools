import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./web-tools/fetch.ts";
import { createGitHubAuth } from "./web-tools/fetchers/github/auth.ts";
import { createGitHubFetcher } from "./web-tools/fetchers/github/index.ts";
import { createLocalFetcher } from "./web-tools/fetchers/local/local.ts";
import { createTrafilaturaExtractor } from "./web-tools/fetchers/local/local-extractor.ts";
import { createFetchWorkerClient } from "./web-tools/fetchers/local/worker-connection.ts";
import {
  createParallelFetcher,
  hasParallelApiKey,
  loadParallelConstructor,
} from "./web-tools/fetchers/parallel.ts";
import { createWebSearchTool } from "./web-tools/search.ts";
import { loadWebToolsSettings } from "./web-tools/settings.ts";
import { getErrorMessage } from "./web-tools/shared.ts";

export default async function parallelWebTools(pi: ExtensionAPI) {
  // parallel-web is optional and only useful with an API key; without either,
  // Parallel drops out of both the search tool and the fetch fallback chain.
  const Parallel = hasParallelApiKey() ? await loadParallelConstructor() : null;
  if (Parallel) pi.registerTool(createWebSearchTool(Parallel));
  const settings = loadWebToolsSettings();
  const workerClient = createFetchWorkerClient(settings.fetch.browser);
  pi.registerTool(
    createWebFetchTool([
      createGitHubFetcher(createGitHubAuth()),
      ...(Parallel ? [createParallelFetcher(Parallel)] : []),
      createLocalFetcher(workerClient, createTrafilaturaExtractor()),
    ]),
  );
  pi.registerCommand("open-browser", {
    description: "Open the fetch browser to log into sites for authenticated fetching",
    handler: async (_args, ctx) => {
      try {
        await workerClient.openBrowser();
        ctx.ui.notify(
          "Interactive browser open — log in as needed, then quit Chrome to resume fetching",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`open-browser failed: ${getErrorMessage(error)}`, "error");
      }
    },
  });
}
