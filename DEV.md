# Development

## Environment

This repo uses mise for tool versions, task execution, and local environment setup. `direnv allow` activates mise and runs the bootstrap flow so Node and npm dependencies are ready; no further action should be needed to begin development.

## Commands

```sh
mise run lint
mise run format
mise run typecheck
mise run test
mise run check      # full verification gate
```

Single test file or name pattern:

```sh
mise run test -- test/github-urls.test.ts
mise run test -- -t "injects the tab type qualifier"
```

No build step — pi loads extensions directly from TypeScript source.

## Smoke test

Load the package into a live pi session and follow SMOKE.md:

```sh
pi -e /Users/thurstonsand/Develop/pi-web-tools
```

## Code style

- Use TypeBox for runtime type safety at settings and protocol boundaries
- Compose dependencies at the entrypoint (`extensions/web-tools.ts`) and inject via factory parameters; no module-level singletons
- Avoid `Pick`, `Omit`, `Partial`, `ReturnType`, and other utility-type derivations unless clearly justified

## Gotchas

- Browser-driver import trees crash pi's host loader (bun + jiti). `playwright-core` is imported only by `fetchers/local/fetch-worker.ts`, which runs as a standalone `node` process.

## Project structure

- entry: `extensions/web-tools.ts` — composes GitHub auth + the `[github, parallel, local]` fetcher chain, registers `fetch_web`/`search_web` tools and `/open-browser` command
- core: `extensions/web-tools/` — `contract.ts` (cross-module types), `router.ts` (claim-and-cascade), `delivery.ts` (digest rendering), `settings.ts`
- fetchers: `extensions/web-tools/fetchers/`
