import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const TOKEN_FILE_NAME = "github-token";

export interface GitHubAuth {
  getToken(): Promise<string | undefined>;
}

// The resolved token is cached for the extension's lifetime. GH_TOKEN cannot
// change without restarting pi (process env is frozen at launch), and gh CLI
// OAuth tokens do not expire, so re-resolving per fetch buys nothing.
export function createGitHubAuth(): GitHubAuth {
  let tokenPromise: Promise<string | undefined> | undefined;
  return {
    getToken() {
      tokenPromise ??= resolveGitHubToken();
      return tokenPromise;
    },
  };
}

async function resolveGitHubToken(): Promise<string | undefined> {
  if (process.env.GH_TOKEN?.trim()) {
    return process.env.GH_TOKEN.trim();
  }

  try {
    const token = (await readFile(path.join(getAgentDir(), TOKEN_FILE_NAME), "utf8")).trim();
    if (token) return token;
  } catch {
    // Token file is optional.
  }

  try {
    const result = await execFileAsync("gh", ["auth", "token"], { timeout: 5_000 });
    const token = result.stdout.trim();
    if (token) return token;
  } catch {
    // gh is optional.
  }

  return undefined;
}
