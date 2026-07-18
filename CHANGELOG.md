# Changelog

All notable changes to this project will be documented in this file.

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
