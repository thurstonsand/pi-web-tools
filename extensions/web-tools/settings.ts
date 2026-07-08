import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "../shared/typebox.ts";

const BROWSER_SETTINGS_SCHEMA = Type.Object({
  executablePath: Type.Optional(Type.String()),
  profileDir: Type.Optional(Type.String()),
});

const WEB_TOOLS_SETTINGS_SCHEMA = Type.Object({
  fetch: Type.Optional(
    Type.Object({
      browser: Type.Optional(BROWSER_SETTINGS_SCHEMA),
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

export interface WebToolsSettings {
  fetch: {
    browser: FetchBrowserSettings;
  };
}

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

export function resolveWebToolsSettings(fileSettings: WebToolsFileSettings): WebToolsSettings {
  const browser = fileSettings.fetch?.browser ?? {};
  return {
    fetch: {
      browser: {
        executablePath: normalizeAbsolutePath(browser.executablePath, "executablePath"),
        profileDir:
          normalizeAbsolutePath(browser.profileDir, "profileDir") ?? getDefaultProfileDir(),
      },
    },
  };
}

export function loadWebToolsSettings(): WebToolsSettings {
  const globalSettings = SettingsManager.create(process.cwd()).getGlobalSettings();
  const parsed = parseTypeBoxValue(ROOT_SETTINGS_SCHEMA, globalSettings, "Invalid settings");
  return resolveWebToolsSettings(parsed.webTools ?? {});
}
