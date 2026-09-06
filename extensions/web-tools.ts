import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./web-tools/fetch.ts";
import { createGitHubAuth } from "./web-tools/fetchers/github/auth.ts";
import { createGitHubFetcher } from "./web-tools/fetchers/github/index.ts";
import { createLocalFetcher } from "./web-tools/fetchers/local/local.ts";
import { createRehypeExtractor } from "./web-tools/fetchers/local/local-extractor.ts";
import { createFetchWorkerClient } from "./web-tools/fetchers/local/worker-connection.ts";
import {
  createParallelClient,
  createParallelFetcher,
  hasParallelCredentials,
  loadParallelConstructor,
} from "./web-tools/fetchers/parallel.ts";
import { createWebSearchTool } from "./web-tools/search.ts";
import { loadWebToolsSettings } from "./web-tools/settings.ts";
import { getErrorMessage } from "./web-tools/shared.ts";

export default async function parallelWebTools(pi: ExtensionAPI) {
  const { apiKeyCommand } = loadWebToolsSettings().parallel;
  const Parallel = hasParallelCredentials(apiKeyCommand) ? await loadParallelConstructor() : null;
  const createClient = Parallel
    ? (signal: AbortSignal | undefined) => createParallelClient(Parallel, apiKeyCommand, signal)
    : null;
  const githubFetcher = createGitHubFetcher(createGitHubAuth());
  if (createClient) pi.registerTool(createWebSearchTool(createClient));
  const workerClient = createFetchWorkerClient(() => loadWebToolsSettings().fetch);
  pi.registerTool(
    createWebFetchTool([
      githubFetcher,
      ...(createClient ? [createParallelFetcher(createClient)] : []),
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
