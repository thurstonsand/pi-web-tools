const GITHUB_HOST = "github.com";
const RAW_GITHUB_HOST = "raw.githubusercontent.com";
const API_GITHUB_HOST = "api.github.com";

export type GitHubRepo = {
  owner: string;
  repo: string;
};

export type FileTarget = GitHubRepo & {
  url: string;
  ref?: string | undefined;
  path: string;
};

export type DirectoryTarget = GitHubRepo & {
  url: string;
  ref?: string | undefined;
  path: string;
};

export type IssueTarget = GitHubRepo & {
  url: string;
  number: number;
};

export type PullRequestTarget = GitHubRepo & {
  url: string;
  number: number;
};

export type ListTarget = GitHubRepo & {
  url: string;
  tab: "issues" | "pulls";
  q?: string;
};

export type RefPathTarget = GitHubRepo & {
  marker: "blob" | "tree" | "raw";
  parts: string[];
  url: string;
};

export function parseGitHubUrl(
  url: string,
):
  | { type: "file"; target: FileTarget }
  | { type: "readme"; target: GitHubRepo & { url: string } }
  | { type: "directory"; target: DirectoryTarget }
  | { type: "issue"; target: IssueTarget }
  | { type: "pull_request"; target: PullRequestTarget }
  | { type: "issue_list"; target: ListTarget }
  | { type: "pull_request_list"; target: ListTarget }
  | { type: "ambiguous_file"; target: RefPathTarget }
  | { type: "ambiguous_directory"; target: RefPathTarget }
  | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (host === RAW_GITHUB_HOST) {
    const [owner, repo, ...rest] = parts;
    if (!owner || !repo || rest.length < 2) return undefined;
    return { type: "ambiguous_file", target: { owner, repo, marker: "raw", parts: rest, url } };
  }

  if (host === API_GITHUB_HOST) {
    const [reposMarker, owner, repo, contentsMarker, ...pathParts] = parts;
    if (reposMarker !== "repos" || !owner || !repo || contentsMarker !== "contents") {
      return undefined;
    }
    const ref = parsed.searchParams.get("ref") ?? undefined;
    const contentPath = pathParts.join("/");
    if (!contentPath) return undefined;
    return {
      type: "file",
      target: { owner, repo, ref, path: contentPath, url },
    };
  }

  if (host !== GITHUB_HOST) return undefined;

  const [owner, repo, marker, numberOrRef, ...rest] = parts;
  if (!owner || !repo) return undefined;

  if (!marker) {
    return { type: "readme", target: { owner, repo, url } };
  }

  if (marker === "issues" || marker === "pull" || marker === "pulls") {
    if (!numberOrRef) {
      if (marker === "pull") return undefined;
      const q = parsed.searchParams.get("q") ?? undefined;
      return {
        type: marker === "issues" ? "issue_list" : "pull_request_list",
        target: {
          owner,
          repo,
          tab: marker === "issues" ? "issues" : "pulls",
          ...(q ? { q } : {}),
          url,
        },
      };
    }

    const number = Number.parseInt(numberOrRef, 10);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    return marker === "issues"
      ? { type: "issue", target: { owner, repo, number, url } }
      : { type: "pull_request", target: { owner, repo, number, url } };
  }

  if ((marker === "blob" || marker === "raw") && numberOrRef && rest.length > 0) {
    return {
      type: "ambiguous_file",
      target: { owner, repo, marker, parts: [numberOrRef, ...rest], url },
    };
  }

  if (marker === "tree" && numberOrRef) {
    return {
      type: "ambiguous_directory",
      target: { owner, repo, marker, parts: [numberOrRef, ...rest], url },
    };
  }

  return undefined;
}

export function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return [GITHUB_HOST, RAW_GITHUB_HOST, API_GITHUB_HOST].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
