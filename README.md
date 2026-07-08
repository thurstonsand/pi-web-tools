# @thurstonsand/pi-web-tools

Pi extension package for `search_web` and `fetch_web`.

`fetch_web` routes GitHub URLs through source-native resolvers for repositories, files, directories, issues, pull requests, and issue/PR listings. Other pages fall back through Parallel and the local browser fetcher.

## Install

```bash
pi install npm:@thurstonsand/pi-web-tools
```

For local development from a clone:

```bash
pi -e ./extensions/web-tools.ts
```

## Tools

- `search_web`: Parallel-backed web search.
- `fetch_web`: URL fetch with GitHub-native artifacts, Parallel extraction, and local browser fallback.

## Development

```bash
mise run check
```

See `DEV.md` and `SMOKE.md`.
