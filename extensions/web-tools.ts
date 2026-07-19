import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./web-tools/fetch.ts";
import { createGitHubAuth } from "./web-tools/fetchers/github/auth.ts";
import { createGitHubFetcher } from "./web-tools/fetchers/github/index.ts";
import { createLocalFetcher } from "./web-tools/fetchers/local/local.ts";
import { createRehypeExtractor } from "./web-tools/fetchers/local/local-extractor.ts";
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
  const githubFetcher = createGitHubFetcher(createGitHubAuth());
  if (Parallel) pi.registerTool(createWebSearchTool(Parallel));
  const workerClient = createFetchWorkerClient(() => loadWebToolsSettings().fetch);
  pi.registerTool(
    createWebFetchTool([
      githubFetcher,
      ...(Parallel ? [createParallelFetcher(Parallel)] : []),
      createLocalFetcher(workerClient, createRehypeExtractor()),
    ]),
  );
  pi.registerCommand("browser", {
    description: "Fetch browser: `open` for interactive login, `restart` to apply settings",
    handler: async (args, ctx) => {
      try {
        switch (args?.trim() || "open") {
          case "open":
            await workerClient.openBrowser();
            ctx.ui.notify(
              "Interactive browser open — log in as needed, then quit Chrome to resume fetching",
              "info",
            );
            break;
          case "restart":
            await workerClient.restart();
            ctx.ui.notify(
              "Fetch worker stopped — the next fetch relaunches it with current settings",
              "info",
            );
            break;
          default:
            ctx.ui.notify("usage: /browser [open|restart]", "error");
        }
      } catch (error) {
        ctx.ui.notify(`browser command failed: ${getErrorMessage(error)}`, "error");
      }
    },
  });
}
