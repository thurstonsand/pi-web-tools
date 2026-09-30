import { inspect } from "node:util";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as parallel from "../extensions/web-tools/fetchers/parallel.ts";
import { createWebSearchTool } from "../extensions/web-tools/search.ts";
import { loadWebToolsSettings } from "../extensions/web-tools/settings.ts";
import webTools from "../extensions/web-tools.ts";

const command = 'printf "%s\\n" "$WEB_TOOLS_TEST_KEY"';

function configure(apiKeyCommand: unknown) {
  const settings = {
    theme: "dark",
    webTools: { parallel: { apiKeyCommand } },
  };
  vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory(settings));
}

function fakeParallel() {
  const search = vi.fn().mockResolvedValue({ results: [] });
  const construct = vi.fn();
  const extract = vi.fn().mockResolvedValue({ results: [], errors: [] });
  const Parallel = class {
    search = search;
    extract = extract;
    constructor(options: { apiKey: string }) {
      construct(options);
    }
  } as unknown as parallel.ParallelConstructor;
  return { Parallel, construct, search, extract };
}

beforeEach(() => {
  vi.stubEnv("PARALLEL_API_KEY", undefined);
  vi.stubEnv("WEB_TOOLS_TEST_KEY", "fake-command-key");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Parallel API key command", () => {
  it("registers search without resolving credentials at startup, then resolves per call", async () => {
    configure(command);
    const { Parallel, construct, search } = fakeParallel();
    vi.spyOn(parallel, "loadParallelConstructor").mockResolvedValue(Parallel);
    const resolve = vi.spyOn(parallel, "createParallelClient");
    const pi = { registerTool: vi.fn(), registerCommand: vi.fn() };

    await webTools(pi as unknown as ExtensionAPI);

    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(resolve).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    const tool = pi.registerTool.mock.calls[0]?.[0];
    await tool.execute("first", { objective: "test" });
    vi.stubEnv("WEB_TOOLS_TEST_KEY", "rotated-fake-key");
    await tool.execute("second", { objective: "test again" });

    expect(construct.mock.calls).toEqual([
      [{ apiKey: "fake-command-key" }],
      [{ apiKey: "rotated-fake-key" }],
    ]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(process.env.PARALLEL_API_KEY).toBeUndefined();
  });

  it("resolves extraction credentials only when the fetcher runs", async () => {
    const { Parallel, construct, extract } = fakeParallel();
    const createClient = vi.fn((signal: AbortSignal | undefined) =>
      parallel.createParallelClient(Parallel, command, signal),
    );
    const fetcher = parallel.createParallelFetcher(createClient);
    expect(fetcher.canFetch("https://example.com")).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await fetcher.fetch({
      urls: ["https://example.com"],
      artifactDir: "/unused-no-results",
      signal,
      ctx: {} as ExtensionContext,
    });
    expect(createClient).toHaveBeenCalledExactlyOnceWith(signal);
    expect(construct).toHaveBeenCalledWith({ apiKey: "fake-command-key" });
    expect(extract).toHaveBeenCalledOnce();
    expect(process.env.PARALLEL_API_KEY).toBeUndefined();
  });

  it("omits search and the SDK when no credential source is configured", async () => {
    configure(undefined);
    const load = vi.spyOn(parallel, "loadParallelConstructor");
    const pi = { registerTool: vi.fn(), registerCommand: vi.fn() };
    await webTools(pi as unknown as ExtensionAPI);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["web_fetch"]);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the SDK optional even when a command is configured", async () => {
    configure(command);
    vi.spyOn(parallel, "loadParallelConstructor").mockResolvedValue(null);
    const resolve = vi.spyOn(parallel, "createParallelClient");
    const pi = { registerTool: vi.fn(), registerCommand: vi.fn() };
    await webTools(pi as unknown as ExtensionAPI);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(["web_fetch"]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("prefers the environment key without executing the configured command", async () => {
    vi.stubEnv("PARALLEL_API_KEY", "fake-env-key");
    const { Parallel, construct } = fakeParallel();
    await parallel.createParallelClient(Parallel, "exit 99", undefined);
    expect(construct).toHaveBeenCalledWith({ apiKey: "fake-env-key" });
    expect(process.env.PARALLEL_API_KEY).toBe("fake-env-key");
  });

  it("fails without a configured source", async () => {
    const { Parallel, construct } = fakeParallel();
    await expect(parallel.createParallelClient(Parallel, undefined, undefined)).rejects.toThrow(
      "Parallel credentials are not configured",
    );
    expect(construct).not.toHaveBeenCalled();
  });

  it.each([`${command}; ${command} >&2; exit 7`, "missing-web-tools-credential-command"])(
    "does not expose command, stdout, stderr, or causes on failure",
    async (failingCommand) => {
      const { Parallel, construct } = fakeParallel();
      const error = await parallel
        .createParallelClient(Parallel, failingCommand, undefined)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error)).toContain("Parallel API key command failed");
      expect(inspect(error)).not.toContain("fake-command-key");
      expect(inspect(error)).not.toContain(failingCommand);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(construct).not.toHaveBeenCalled();
    },
  );

  it.each(["printf ''", "printf 'first\\nsecond\\n'"])(
    "rejects empty or multiline output",
    async (invalidCommand) => {
      const { Parallel, construct } = fakeParallel();
      await expect(
        parallel.createParallelClient(Parallel, invalidCommand, undefined),
      ).rejects.toThrow("Parallel API key command must return a single nonempty key");
      expect(construct).not.toHaveBeenCalled();
    },
  );

  it("closes stdin instead of allowing a credential command to prompt", async () => {
    const { Parallel } = fakeParallel();
    await expect(parallel.createParallelClient(Parallel, "read key", undefined)).rejects.toThrow(
      "Parallel API key command failed",
    );
  });

  it("passes cancellation to credential resolution without exposing subprocess details", async () => {
    const { Parallel, construct } = fakeParallel();
    const controller = new AbortController();
    controller.abort();
    await expect(
      parallel.createParallelClient(Parallel, command, controller.signal),
    ).rejects.toThrow("Parallel API key command failed");
    expect(construct).not.toHaveBeenCalled();
  });

  it("does not resolve a key for invalid search arguments", async () => {
    const createClient = vi.fn();
    const tool = createWebSearchTool(createClient);
    await expect(
      tool.execute(
        "invalid",
        { objective: "test", after_date: "invalid" },
        undefined,
        undefined,
        {} as ExtensionToolContext,
      ),
    ).rejects.toThrow("Invalid after_date");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("Parallel settings boundary", () => {
  it("reads the command from global settings without running it", () => {
    configure(command);
    expect(loadWebToolsSettings().parallel.apiKeyCommand).toBe(command);
  });

  it.each(["", "  ", 42, ["command"]])("rejects an invalid command setting", (invalidCommand) => {
    configure(invalidCommand);
    expect(loadWebToolsSettings).toThrow("Invalid settings");
  });
});
