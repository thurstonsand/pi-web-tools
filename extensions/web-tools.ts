import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./web-tools/fetch.ts";
import { createGitHubAuth } from "./web-tools/fetchers/github/auth.ts";
import { createGitHubFetcher } from "./web-tools/fetchers/github/index.ts";
import { createLocalFetcher } from "./web-tools/fetchers/local/local.ts";
import { createTrafilaturaExtractor } from "./web-tools/fetchers/local/local-extractor.ts";
import { createFetchWorkerClient } from "./web-tools/fetchers/local/worker-connection.ts";
import { createParallelFetcher, hasParallelApiKey } from "./web-tools/fetchers/parallel.ts";
import { webSearchTool } from "./web-tools/search.ts";
import { loadWebToolsSettings } from "./web-tools/settings.ts";
import { getErrorMessage } from "./web-tools/shared.ts";

export default function parallelWebTools(pi: ExtensionAPI) {
  // Without a Parallel key there is no search backend; an unregistered tool is
  // more honest than a permanently erroring one.
  if (hasParallelApiKey()) pi.registerTool(webSearchTool);
  const settings = loadWebToolsSettings();
  const workerClient = createFetchWorkerClient(settings.fetch.browser);
  pi.registerTool(
    createWebFetchTool([
      createGitHubFetcher(createGitHubAuth()),
      createParallelFetcher(),
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
