import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "../shared/typebox.ts";

const BROWSER_SETTINGS_SCHEMA = Type.Object({
  executablePath: Type.Optional(Type.String()),
  profileDir: Type.Optional(Type.String()),
});

const CHALLENGE_SETTINGS_SCHEMA = Type.Object({
  escalation: Type.Optional(Type.Union([Type.Literal("headed"), Type.Literal("never")])),
  headlessWaitSecs: Type.Optional(Type.Number()),
  headedWaitSecs: Type.Optional(Type.Number()),
});

const WEB_TOOLS_SETTINGS_SCHEMA = Type.Object({
  fetch: Type.Optional(
    Type.Object({
      browser: Type.Optional(BROWSER_SETTINGS_SCHEMA),
      challenge: Type.Optional(CHALLENGE_SETTINGS_SCHEMA),
    }),
  ),
});

const ROOT_SETTINGS_SCHEMA = Type.Object({
  webTools: Type.Optional(WEB_TOOLS_SETTINGS_SCHEMA),
});

type WebToolsFileSettings = Static<typeof WEB_TOOLS_SETTINGS_SCHEMA>;

export interface FetchBrowserSettings {
  executablePath: string | undefined;
  profileDir: string;
}

export interface FetchChallengeSettings {
  escalation: "headed" | "never";
  headlessWaitSecs: number;
  headedWaitSecs: number;
}

export interface FetchSettings {
  browser: FetchBrowserSettings;
  challenge: FetchChallengeSettings;
}

export interface WebToolsSettings {
  fetch: FetchSettings;
}

const DEFAULT_HEADLESS_WAIT_SECS = 10;
const DEFAULT_HEADED_WAIT_SECS = 20;

export function getDefaultProfileDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "browser-profile");
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function normalizeAbsolutePath(value: string | undefined, key: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const expanded = expandHome(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`webTools.fetch.browser.${key} must be an absolute path or start with "~/".`);
  }
  return path.normalize(expanded);
}

function normalizeWaitSecs(value: number | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`webTools.fetch.challenge.${key} must be a positive number of seconds.`);
  }
  return value;
}

export function resolveWebToolsSettings(fileSettings: WebToolsFileSettings): WebToolsSettings {
  const browser = fileSettings.fetch?.browser ?? {};
  const challenge = fileSettings.fetch?.challenge ?? {};
  return {
    fetch: {
      browser: {
        executablePath: normalizeAbsolutePath(browser.executablePath, "executablePath"),
        profileDir:
          normalizeAbsolutePath(browser.profileDir, "profileDir") ?? getDefaultProfileDir(),
      },
      challenge: {
        escalation: challenge.escalation ?? "headed",
        headlessWaitSecs: normalizeWaitSecs(
          challenge.headlessWaitSecs,
          "headlessWaitSecs",
          DEFAULT_HEADLESS_WAIT_SECS,
        ),
        headedWaitSecs: normalizeWaitSecs(
          challenge.headedWaitSecs,
          "headedWaitSecs",
          DEFAULT_HEADED_WAIT_SECS,
        ),
      },
    },
  };
}

export function loadWebToolsSettings(): WebToolsSettings {
  const globalSettings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return resolveWebToolsSettings(parsed.webTools ?? {});
}
