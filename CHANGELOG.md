# Changelog

All notable changes to this project will be documented in this file.

## 0.4.4

Deprecated in favour of [pi-librarian](https://github.com/thurstonsand/pi-librarian), which ships `web_search` and `web_fetch` from 0.7.0 and grants them to its research runs too.

### Changed

- Deprecated. Uninstall this package before installing pi-librarian, since both register the same tool names, and move `webTools.*` settings to `librarian.web.*`.

## 0.4.3

Targets pi 1.4.0.

### Added

- `web_fetch` URLs and `web_search` result titles are clickable links in terminals that support hyperlinks.

### Fixed

- `web_fetch` reads GitHub pull request listings filtered by `is:merged` or `is:unmerged` through the GitHub API again, instead of falling back to the scraped page.

## 0.4.2

Targets pi 1.2.0.

### Changed

- Requires pi 1.1 or newer. Finished `web_fetch` and `web_search` results show the duration pi records for the call; calls pi rejects before they run, such as those with invalid arguments, show no duration.
- `web_fetch` and `web_search` rows time themselves like pi's own tool rows: `Elapsed` while running, `Took` once finished, and durations of a minute or more read as `1m 30s`.

### Fixed

- `web_fetch` and `web_search` show the tool's recorded duration after a session is reloaded, instead of `0.0s`.

## 0.4.1

Targets pi 1.0.4.

### Changed

- Verified against pi 1.0. The extension needed no changes, and the pi peer dependencies remain unpinned.

## 0.4.0

Targets pi 0.99.1.

### Added

- `web_fetch` and `web_search` declare read-only tool annotations and an output schema, and return matching `structuredContent` alongside the text digest.

### Changed

- Document body paths in tool details are absolute.
- Validate Parallel search and extract responses at the edge, so malformed responses fail with a clear error.

### Fixed

- `pi -p` exits on its own after a local browser fetch instead of hanging on the idle fetch worker connection.

## 0.3.0

### Added

- Configure `webTools.parallel.apiKeyCommand` in global pi settings to retrieve Parallel credentials only when a search or extraction runs. `PARALLEL_API_KEY` still takes precedence.

### Changed

- Create Parallel clients per request instead of at startup, allowing credential commands to return fresh keys without changing the process environment.
- Refresh dependencies and align development tooling with Node 24.

## 0.2.5

### Fixed

- GitHub commit and pull request URLs ending in `.diff` or `.patch` now resolve to the same structured `web_fetch` document as their plain form, instead of falling through to a general web fetcher.

## 0.2.4

### Added

- API-backed `web_fetch` documents for GitHub commit history, optionally scoped by ref and file path.

## 0.2.3

### Fixed

- Local browser fallback now reports HTTP 4xx and 5xx responses as failures instead of extracting error pages as successful documents.

## 0.2.2

### Added

- API-backed `web_fetch` documents for commits; tagged, latest, and repository releases; tag and branch listings; GitHub Actions runs and listings; and Discussions.
- Native commit patches, release asset metadata, Actions jobs and artifacts, and threaded Discussion conversations as bounded on-disk artifacts.

## 0.2.1

### Changed

- Updated the optional `parallel-web` dependency to 1.1.0.
- Refreshed the TypeScript, Biome, and pi development toolchain, and consolidated repository automation around mise.

## 0.2.0

Improved local retrieval quality and made tool activity easier to follow in pi.

### Added

- Automatic headed-browser escalation for Cloudflare bot-wall challenges, configurable through `webTools.fetch.challenge`.
- Collapsed and expanded `web_search`/`web_fetch` views with elapsed timing, warning summaries, and per-URL fetch failures.

### Changed

- Replaced the local fetcher's trafilatura extraction with a rehype pipeline that preserves documentation structure, fenced code blocks, tables, and open shadow-root content.
- Refined completed search and fetch results around their primary artifacts: search titles and fetched URLs, with supporting URLs, titles, paths, warnings, and failure trails available when expanded.

## 0.1.3

Made the Parallel backend fully optional.

### Changed

- `parallel-web` is now an optional dependency, loaded lazily. Without `PARALLEL_API_KEY` or the installed SDK, Parallel is left out of both `web_search` and the `web_fetch` fallback chain.
- Pinned `playwright-core` to 1.61.0 and `@octokit/request` to 10.0.8.

## 0.1.2

Tightened `web_fetch`/`web_search` tool descriptions and prompt guidance for clarity.

## 0.1.1

First release of `pi-web-tools`.

### Added

- `web_fetch` and `web_search` tools for pi, with a GitHub/Parallel/local fetcher chain.
- `/open-browser` command for authenticated local browsing.
