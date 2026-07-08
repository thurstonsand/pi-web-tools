# pi-web-tools repo extraction

## Status

Accepted

## Decision Summary

The `parallel-web-tools` pi extension moves out of ansiblonomicon's chezmoi tree into its own public repository, `pi-web-tools`, renamed to shed the Parallel-specific identity it outgrew and restructured to follow the established `pi-*` sibling template (pi-permissions being the most evolved reference). The repo starts with fresh history; ansiblonomicon retains the pre-extraction history. The key tradeoff: the extension gains a release pipeline, tests, and a parseable structure at the cost of a one-time migration and a cutover touching every consumer (macOS dev path, OpenClaw npm install, lint tooling).

## Problem Statement / Background

The extension began as a thin Parallel wrapper deployed as chezmoi-managed source files under `~/.pi/agent/extensions/parallel-web-tools`. It is now a source-routed fetch stack with three fetchers (GitHub via Octokit, Parallel, local browser), a worker process, and ~20 flat files — `github.ts` alone is 1,100 lines. The chezmoi deployment model has no tests, no release versioning, no CI, and forces special-casing in ansiblonomicon's lint tooling (`scripts/pi-lint.sh` skips it because its registry deps can't install in that context).

The sibling repos (`pi-sessions`, `pi-permissions`, `pi-librarian`) already solved all of this with a shared template: strict TypeScript tooling, vitest, tag-driven npm publishing via GitHub Actions with OIDC trusted publishing, and a documented agent-file convention. New feature work (GitHub issue/PR listing, `docs/designs/04`) is the forcing function: rather than growing `github.ts` further in the wrong home, extract first so the feature lands in its final structure.

## Goals

- The extension lives in a standalone public repo named `pi-web-tools`, published as `@thurstonsand/pi-web-tools` on npm.
- Repo structure, tooling strictness, release strategy, and agent files match the `pi-*` sibling conventions.
- `github.ts` is decomposed by resolver concern under a `github/` folder.
- All web-tools design docs live in this repo; ansiblonomicon's copies are removed.
- Every current consumer keeps working after cutover: macOS loads the dev checkout, OpenClaw installs from npm.
- Tool names (`fetch_web`, `search_web`), the `webTools` settings key, and runtime behavior are unchanged — this is a relocation and reorganization, not a rewrite.

## Non-Goals

- No behavior changes to fetching, routing, delivery, or auth (the issue/PR listing feature is `docs/designs/04`, implemented after extraction).
- No git history preservation via `filter-repo`; ansiblonomicon remains the historical record.
- No exhaustive test suite; tests are seeded for pure logic (URL parsing) with the harness in place for growth.
- No work-machine rollout; that is a manual post-publish experiment.

## Exposed Shape

Package identity:

- GitHub: `github.com/thurstonsand/pi-web-tools`, public, MIT.
- npm: `@thurstonsand/pi-web-tools`, `publishConfig.access: public`, versioned by git tag only.
- pi entry: `"pi": { "extensions": ["./extensions/web-tools.ts"] }`.

Repository layout:

```
extensions/web-tools.ts              — entry (current index.ts)
extensions/web-tools/
  contract.ts  router.ts  delivery.ts  fetch.ts  search.ts  settings.ts  shared.ts
  fetchers/
    parallel.ts
    local/       — local.ts, local-extractor.ts, fetch-worker.ts,
                   worker-connection.ts, worker-protocol.ts
    github/      — index.ts (factory + canFetch + dispatch), urls.ts (URL parsing),
                   auth.ts, content.ts (file/readme/directory), issue.ts,
                   pull-request.ts, pagination.ts (listWithCap)
extensions/shared/typebox.ts
test/*.test.ts
docs/designs/    — 01 (routing), 02 (local backend), 03 (this doc), 04 (listing)
docs/release.md
scripts/extract-release-notes.sh
.github/workflows/{ci,release}.yml
.agents/skills/npm-release/  (+ .claude/skills symlink)
AGENTS.md  CONTEXT.md  DEV.md  SMOKE.md  CHANGELOG.md  README.md  LICENSE
biome.json  tsconfig.json  vitest.config.ts  mise.toml  .envrc  renovate.json
```

Consumption:

- macOS (dev): `"/Users/thurstonsand/Develop/pi-web-tools"` in pi's `packages` list (settings.json.tmpl), matching the other siblings.
- OpenClaw/Linux: `"npm:@thurstonsand/pi-web-tools"`.
- Work (later, manual): `"git:github.com/thurstonsand/pi-web-tools"`.

## Design Decisions

### 1. Fresh history, ansiblonomicon as the historical record

The new repo starts at an initial commit importing current code. `git filter-repo` extraction would drag chezmoi-era path prefixes through every historical commit while the reorganization immediately invalidates those paths for blame purposes. History stays queryable where it happened.

### 2. pi-permissions as the template

Of the three siblings, pi-permissions is the most evolved: mise+direnv bootstrap, actionlint, scoped npm name, mise-delegated package scripts. Adopt it wholesale with two deviations toward pi-sessions: keep a real `SMOKE.md` (this extension has the richest manual-verification matrix; docs 01/02 validation sections seed it) and keep `CLAUDE.md` as a one-line `@AGENTS.md` include. `CHANGELOG.md` uses Keep-a-Changelog format because `extract-release-notes.sh` parses `## [X.Y.Z]` headings — pi-librarian's looser `RELEASE.md` variant is a known divergence, not a second option.

Tooling strictness carried over verbatim: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `NodeNext` resolution, `allowImportingTsExtensions`; biome with 100-column lines, double quotes, trailing commas; husky + lint-staged running `biome check --write` pre-commit.

### 3. `github.ts` decomposed by resolver, renderers colocated

The split follows the doc-01 principle that a source is one fetcher with internal resolvers: `urls.ts` owns `parseGitHubUrl` and target types; `content.ts`, `issue.ts`, `pull-request.ts` each own their resolver *and its markdown rendering* — no grab-bag `render.ts`, because renderers change with their resolver, not with each other. `pagination.ts` holds `listWithCap`. `index.ts` composes the fetcher and dispatches parsed URLs to resolvers. The local browser fetcher's five files get the same treatment under `fetchers/local/`.

### 4. Migrated design docs are renumbered and path-corrected, not rewritten

Docs 17/18 from ansiblonomicon become 01/02 here. File path references and cross-doc numbers are updated to the post-extraction layout so the docs stay contextually valid — a reader following doc 01's module map must land on real files. Decisions, rationale, and prose are otherwise untouched, and each migrated doc carries a one-line migration note under its title. No other retroactive editing of accepted designs.

### 5. Agent file authorship split

CONTEXT.md (domain glossary — source fetcher, document, digest, body, attempt, artifact directory, largely doc 01's terminology section) and DEV.md (commands, no-build note, code style, gotchas — notably the silent-Octokit-logger TUI constraint) are drafted during extraction. AGENTS.md is scaffolded as a neutral section outline only (project context pointer, ethos, core principles, code style pointer); the owner authors its content — ethos is first-person and not delegable.

### 6. Tag-driven npm publish with OIDC trusted publishing

`release.yml` triggers on `v*` tags, derives the version from the tag (`npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version`), and publishes via the `npm` GitHub environment with `id-token: write` — no npm tokens, no version bumps in commits; `package.json` version is deliberately stale. The `.agents/skills/npm-release` skill drives the release ritual. One-time manual setup: create the `npm` environment on the GitHub repo and link the trusted publisher on npmjs.com, mirroring pi-permissions' settings.

### 7. Cutover is a single ansiblonomicon change, applied after first publish

All ansiblonomicon edits land as one reviewable change once `v0.1.0` exists on npm, so no consumer ever points at a package that isn't there:

- `chezmoi/private_dot_pi/agent/settings.json.tmpl` — add the darwin-path/npm conditional line for pi-web-tools alongside the other siblings.
- Delete `chezmoi/private_dot_pi/agent/extensions/parallel-web-tools/`.
- `ansible/openclaw.config.yml` — remove `parallel-web-tools` from `pi_local_extension_package_dirs` (the npm-install loop in `openclaw.yml` no-ops on the empty list; the settings.json.tmpl npm entry covers OpenClaw).
- `scripts/pi-lint.sh` — delete the parallel-web-tools skip special case.
- Remove `docs/designs/17-*.md` and `18-*.md` (migrated here).

`pyproject.toml`'s lockfile list references the extensions-workspace lock, which stays (other extensions still use it); parallel-web-tools' own nested lockfile leaves with its directory.

## Edge Cases & Failure Modes

- **npm publish fails on first release (trusted-publisher misconfig):** cutover hasn't happened; nothing is broken. Fix the environment linkage and re-tag per the release skill's failed-tag exception.
- **OpenClaw applies before first publish:** prevented by sequencing — the cutover commit lands only after `npm view @thurstonsand/pi-web-tools` succeeds.
- **macOS pi loads both copies during transition:** the dev checkout and the chezmoi copy would register duplicate tools. The cutover commit removes the chezmoi copy in the same change that adds the dev path; `chezmoi apply` makes it atomic locally.
- **Import-path churn breaks the worker spawn:** `fetch-worker.ts` is spawned by file path from `worker-connection.ts`; the reorganization must update that path reference and SMOKE.md exercises the browser fetch path to prove it.
- **Renovate opens PRs against pinned pi peer deps:** same behavior as siblings; grouped weekly PRs, handled manually.

## Alternatives

### Preserve history with `git filter-repo`

- **Status:** Rejected
- **Decision:** Provenance in blame does not survive the immediate reorganization anyway; chezmoi path prefixes pollute every commit; ansiblonomicon's history remains authoritative.

### Implement the listing feature first, extract second

- **Status:** Rejected
- **Decision:** Double handling — the feature code would be written into `github.ts` and immediately moved/split. Extraction first means the `github/` decomposition happens once and the feature lands in its final home.

### Keep the extraction design doc in ansiblonomicon

- **Status:** Rejected
- **Decision:** The web-tools design corpus lives with the code it describes; splitting it across repos makes the sequence (01→04) unreadable. Ansiblonomicon's docs index simply loses the two migrated entries.

### Stay in chezmoi, reorganize in place

- **Status:** Rejected
- **Decision:** Solves the flat-file problem but none of the structural ones: no tests, no CI, no versioned releases for OpenClaw, and the lint special case persists. The sibling template exists precisely for extensions that reach this size.

## Implementation Plan

- [ ] Phase 1: Repo bootstrap (pi-web-tools)
  - Goal: A standalone repo with the full sibling template, docs, and agent files — no extension code yet.
  - Files: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `mise.toml`, `.envrc`, `renovate.json`, `.husky/`, `.github/workflows/{ci,release}.yml`, `scripts/extract-release-notes.sh`, `.agents/skills/npm-release/` + `.claude/skills` symlink, `docs/release.md`, `CHANGELOG.md`, `LICENSE`, `README.md`, `AGENTS.md` (outline), `CLAUDE.md`, `CONTEXT.md`, `DEV.md`, `SMOKE.md` (skeleton), migrated `docs/designs/01,02` + this doc.
  - Work: Copy template files from pi-permissions/pi-sessions adjusting names; author CONTEXT.md and DEV.md first passes; scaffold AGENTS.md outline for owner authorship; create the GitHub repo (`gh repo create thurstonsand/pi-web-tools --public`), replicate the `npm` environment settings from pi-permissions, push.
  - Validation: `mise run check` passes on the empty scaffold (no-op test run acceptable); CI workflow green on GitHub.

- [ ] Phase 2: Code move and reorganization
  - Goal: All extension code relocated into the new layout, compiling strictly, with seeded tests.
  - Files: `extensions/web-tools.ts`, `extensions/web-tools/**` per the Exposed Shape, `extensions/shared/typebox.ts`, `test/urls.test.ts`, `SMOKE.md` (filled), `package.json` (deps: `@octokit/rest`, `parallel-web`, `playwright-core`; dev/peer deps per sibling baseline).
  - Work: Move files into the fetcher-folder structure; split `github.ts` into `github/{index,urls,auth,content,issue,pull-request,pagination}.ts`; fix the worker spawn path; update all import specifiers; seed vitest tests for `parseGitHubUrl`; fill SMOKE.md from docs 01/02 validation matrices.
  - Validation: `mise run check` (biome + tsc strict + vitest) green; SMOKE.md pass with `pi -e ~/Develop/pi-web-tools` covering one URL per GitHub kind, a Parallel page, a local-browser fetch, and a failure trail.

- [ ] Phase 3: First release
  - Goal: `@thurstonsand/pi-web-tools@0.1.0` live on npm via the tag pipeline.
  - Files: `CHANGELOG.md`.
  - Work: Run the npm-release skill: changelog entry, `npm pack --dry-run` review, annotated `v0.1.0` tag, watch the release workflow, verify `npm view @thurstonsand/pi-web-tools`.
  - Validation: `pi install npm:@thurstonsand/pi-web-tools` loads the extension in a clean environment.

- [ ] Phase 4: ansiblonomicon cutover
  - Goal: Ansiblonomicon consumes the new package everywhere; the chezmoi copy is gone.
  - Files: `chezmoi/private_dot_pi/agent/settings.json.tmpl`, `chezmoi/private_dot_pi/agent/extensions/parallel-web-tools/` (deleted), `ansible/openclaw.config.yml`, `scripts/pi-lint.sh`, `docs/designs/17-*.md`/`18-*.md` (deleted).
  - Work: Apply the Decision 7 edit list as one change.
  - Validation: `uv run poe lint` green; `uv run poe cz-diff` shows the extension dir removal + settings line; `chezmoi apply` locally, restart pi, confirm `fetch_web`/`search_web` register once from the dev checkout; `uv run poe openclaw --check` clean.

- [ ] Phase 5: Issue/PR listing feature
  - Goal: Implement `docs/designs/04-github-issue-pr-listing.md` in the new structure.
  - Files: `extensions/web-tools/fetchers/github/{listing,urls,index}.ts`, `extensions/web-tools/fetch.ts` (promptGuidelines), `test/`.
  - Work/Validation: Per doc 04's implementation plan.
