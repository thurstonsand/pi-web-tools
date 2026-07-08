# Changelog

All notable changes to this project will be documented in this file.

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
