# GitHub-aware web fetch routing

> Migrated from ansiblonomicon `docs/designs/17-github-aware-web-fetch-routing.md`. File paths and module names updated to the pi-web-tools layout (see `03-pi-web-tools-repo-extraction.md`); decisions and prose otherwise unchanged.

## Status

Draft

## Decision Summary

`web_fetch` becomes a source-routed fetch tool: an ordered chain of source fetchers resolves each URL, with GitHub served natively through Octokit and Parallel as the terminal fallback. Every source materializes its results as named native-format files on disk — fetchers own disk writes — and the tool result is a compact digest per document: facts, file paths with sizes, and a capped excerpt. Content is never inlined into the tool result. The key tradeoff is accepted deliberately: even a small document costs a follow-up read, in exchange for a uniform model, stable re-greppable artifacts, a context window that holds only what the agent chose to read, and a contract that scales to repository-sized retrieval.

## Problem Statement / Background

The consumer of `web_fetch` output is a coding agent. Its reading tools are line-oriented — read with offsets, grep, standard diff tooling — and its context budget is the scarcest resource in a session. Delivery must therefore answer two questions well: is the content in a form those tools can operate on, and does the tool result carry enough signal to decide what is worth reading?

Two failure patterns motivate this design:

- **Generic web extraction is the wrong backend for repository content.** A GitHub file, directory, issue, or pull request has a precise API surface. Scraping the HTML page for `github.com/owner/repo/pull/123` yields worse structure at higher cost than three REST calls, and it cannot produce a usable unified diff at all.
- **Opaque persistence wastes the agent's context.** If fetched content lands on disk as a serialized envelope (JSON-escaped strings, metadata wrappers), the agent pays full token cost to read escape-sequence noise, and grep is useless against it. And content inlined into a tool result is permanent context pollution: a 26KB conversation sits in the window for the rest of the session even if the agent needed one line of it. Observed agent behavior settles the design: agents go back to source files with grep to recall specific details *even when the full document was previously loaded into context* — a stable file is worth more than inlined bytes.

Concrete scenario: the agent is asked to review a dependency's pull request. Ideal delivery is the PR conversation rendered as markdown and the diff as a `.patch` file it can grep by filename, plus a digest telling it exactly what exists, how big it is, and what it's about. Anything else (escaped JSON, a paginated HTML scrape, a 400KB diff dumped into context) is overhead on every single fetch for the lifetime of the tool.

The routing layer must also be ready for more source fetchers — GitLab is the expected second provider — without each addition rewriting the router or the delivery path.

## Goals

- Route `web_fetch` URLs through source-native APIs when a source fetcher claims them, falling back to Parallel for everything else.
- Deliver all results through one source-agnostic contract: a digest in the tool result, native-format files on disk.
- Materialize every document's content as files, unconditionally; never inline content into the tool result.
- Support GitHub files, repo README, directory listings, issues, and pull requests (including diffs) in the first GitHub fetcher.
- Account for every requested URL in the tool result: either a document or a failure with its attempt trail.
- Keep adding a provider cheap: one new module, one entry in the fetcher array.

## Non-Goals

- No `web_search` routing; it remains Parallel-only.
- No GitHub Enterprise host support.
- No recursive directory/repo content fetching by default; tree URLs list entries only.
- No model-generated summaries in the initial implementation (deferred; see Phase 3).
- No persisted structured metadata (JSON sidecars); the digest in the tool result is the metadata.

## Exposed Shape

### Terminology

- **Source fetcher** — a module that claims URLs for one backend (`github`, `parallel`, later `gitlab`), resolves them into documents, and writes their content to disk. Fetchers own disk writes.
- **Document** — the result of resolving one URL: digest fields plus one or more bodies on disk.
- **Digest** — the compact description of a document in the tool result: title, facts, link, body files with sizes, capped excerpt. The digest is all the agent's context ever receives. `kind`/`source` exist in the contract and details but are not shown to the agent — it wants answers, not provenance.
- **Body** — one named, native-format file of a document (`conversation.md`, `diff.patch`, `README.md`). A document may have several.
- **Artifact directory** — the per-call directory holding all bodies: `/tmp/pi-fetch/{timestamp}/{url-slug}/`.
- **Attempt** — a recorded failure of one source fetcher for one URL. A URL may accumulate attempts and still succeed via a later fetcher.

### Tool result

The tool result is plain text: one digest per document, no content. Example for `web_fetch(urls: ["https://github.com/octokit/rest.js/pull/607", "https://github.com/octokit/rest.js/issues/1"])`:

```
1. octokit/rest.js#607: build(deps): Bump http-proxy-middleware…
   closed merged · by dependabot[bot] · +327 -497 · 1 file · 0 issue comments · 1 review
   https://github.com/octokit/rest.js/pull/607
   bodies (in /tmp/pi-fetch/2026-07-06T12-57-08-183Z/github-com-octokit-rest-js-pull-607/):
   - conversation.md (260 lines, 25.9KB)
   - diff.patch (1,273 lines, 46.0KB)
   excerpt: Bumps http-proxy-middleware to 3.0.7 and updates ancestor dependency…

2. octokit/rest.js README
   repo octokit/rest.js · path README.md · whole repository: git clone https://github.com/octokit/rest.js.git
   https://github.com/octokit/rest.js/blob/main/README.md
   bodies (in /tmp/pi-fetch/2026-07-06T12-57-08-183Z/github-com-octokit-rest-js/):
   - README.md (78 lines, 2.9KB)
   excerpt: # rest.js > GitHub REST API client for JavaScript…
```

Rules the agent can rely on:

- Every requested URL appears exactly once: as a numbered document or in a `Failed:` section listing the attempt trail (`github: 404 Not Found → parallel: extraction failed`).
- Content is never inlined. Full results live in the listed files; the digest's line/byte counts say whether to read whole or grep.
- Every document carries a capped excerpt when one can be produced — the opening post, the entry list, the file head — enough to decide whether the files are worth opening.
- The tool result carries no warnings section; fetcher diagnostics (rate limits, recovered attempts) go to `details` for the TUI and debugging, not to the agent.

### Artifact layout

Every document is materialized, unconditionally: one directory per requested URL (slugified — unique within a call by construction), bodies under their own names.

```
/tmp/pi-fetch/{ISO-timestamp}/
  github-com-octokit-rest-js-pull-607/
    conversation.md
    diff.patch
  github-com-octokit-rest-js-issues-1/
    conversation.md
```

Native formats throughout: markdown renders as `.md`, diffs as `.patch`, repository files keep their real filename and extension, binary files are raw bytes. Stability is the point: agents demonstrably return to source files with grep even after content has been in context, and a stable path prevents re-fetching.

### Tool prompt surface

The tool description and `promptGuidelines` teach the contract: content is never inlined — read or grep the listed files; the digest's facts and excerpt are often enough to decide whether a file is worth reading; `objective` steers Parallel extraction and is ignored by source-native fetchers.

## Design Decisions

### 1. Ordered source fetchers with a claim-and-cascade router

The router walks an injected array — `[GitHubFetcher, ParallelFetcher]`, later `[GitHubFetcher, GitLabFetcher, ParallelFetcher]` — composed once at extension load in `web-tools.ts`. It tracks one outcome record per requested URL (`{ url, document?, attempts[] }`). For each fetcher it filters the still-unresolved URLs by `canFetch(url)`, hands over the claimed batch, and folds the returned documents and failures into the outcomes; any URL still without a document cascades to the next fetcher, whether the previous one failed on it or simply could not interpret it. Parallel claims everything, making it the terminal fallback.

A fetcher owns its batch strategy internally: Parallel uses its native multi-URL extract call; GitHub fans out with `Promise.all` per URL. The router does not prescribe concurrency.

Each source is one fetcher with internal resolvers, not one fetcher per URL shape. Auth, client setup, host detection, pagination, and error normalization stay in one module per source; a new GitHub URL shape is a new internal resolver, not a new top-level unit.

### 2. Structural document contract owned by `contract.ts`

A dedicated `contract.ts` module defines the entire cross-module type surface. Providers and the router both import it; nothing imports provider types — the import graph enforces the boundary rather than discipline.

```ts
interface FetchedDocument {
  kind: string;           // "<source>.<shape>", e.g. "github.pull_request", "parallel.page"
  source: string;
  url: string;            // the URL as requested
  link?: string;          // canonical html link when it differs from url
  title: string;
  facts: string[];        // pre-rendered one-line digest facts, provider-authored
  excerpt?: string;       // provider-authored preview; delivery caps it before rendering
  highlights?: string[];  // objective-steered answers; rendered in full, never capped
  bodies: DocumentBody[];
}

interface DocumentBody {
  name: string;           // artifact filename: "conversation.md", "diff.patch", "index.ts"
  path: string;           // absolute path — the fetcher already wrote it
  lines: number;          // 0 for binary
  bytes: number;
}

interface FetchFailure {
  url: string;
  reason: string;
}

interface FailedAttempt extends FetchFailure {
  source: string;            // stamped by the router from fetcher.source
}

interface FetcherResult {
  documents: FetchedDocument[];
  failures: FetchFailure[];  // resolvable-but-failed; unclaimed URLs are simply absent
  warnings: FetchWarning[];
}

interface WebFetcher {
  source: string;
  canFetch(url: string): boolean;
  fetch(request: FetcherRequest): Promise<FetcherResult>;
}

interface UrlOutcome {
  url: string;
  document?: FetchedDocument;
  attempts: FailedAttempt[];
}

interface RoutedFetchResult {
  outcomes: UrlOutcome[];    // request order; one entry per requested URL
  warnings: FetchWarning[];  // fetcher-level diagnostics; surfaced in details only
  artifactRoot: string;
}
```

`FetcherRequest` carries `artifactDir` — the per-call root the router allocated. A fetcher writes each document's bodies under `{artifactDir}/{slugify(url)}/` via the shared `writeDocumentBody` helper and returns paths and stats, never content. Note there is no content field anywhere in the contract: multi-megabyte payloads never cross a module boundary, and leaking body content into session details is structurally impossible.

`kind` and `source` are open strings, not a closed union. Nothing downstream switches on provider-specific variants: the digest is pre-rendered by the provider into `title`/`facts`, and bodies are opaque named content. This is what keeps a new provider to one module plus one array entry — the tradeoff is that downstream code cannot type-narrow into provider fields, which is accepted because no downstream consumer needs to.

There is exactly one failure channel: `failures`. Provider-native error shapes (Parallel's extract errors, Octokit exceptions) are normalized to `{ url, reason }` inside the provider; the router stamps `fetcher.source` when folding them into the per-URL outcome, so a provider cannot mislabel its own failures. The `UrlOutcome` is the pipeline's unit of truth: the Failed section (`document` absent) renders the attempt trail; attempts on resolved URLs are debugging detail, surfaced in `details` only — the agent doesn't care which fetcher answered.

### 3. Always-materialize delivery: files plus digest, never inline

Fetchers write every body to disk as they resolve, unconditionally. Delivery is a pure formatter: it renders digests from the paths and stats fetchers returned, and touches neither content nor the filesystem. There is no inline budget, no size threshold, no per-body decision anywhere.

Why fetchers own disk writes: a fetcher should not have to reason about presentation — "will this fit in context?" is not its concern, and the only thing it needs is a folder. Owning the write also lets a fetcher stream large payloads (a 100MB raw download need never be fully buffered) and is what makes repository-scale retrieval structurally possible: a future checkout resolver just writes a tree into its document directory.

Why nothing inlines, ever — including small documents:

- Inlined content is permanent context pollution; a file read is transient and targeted. The agent pays only for what it chooses to read or grep.
- Stable paths prevent re-fetching: agents observably return to source files with grep to recall details even when the full document was previously in context.
- One uniform model. No budget arithmetic, no ordering bias between URLs, no "was this inlined or not" case analysis for the agent or the code.

The accepted cost: every fetch, however small, takes a follow-up read. Chosen with eyes open — the round trip buys determinism and a clean context window.

Excerpts: since delivery never sees content, providers author the excerpt at fetch time, while the content is in hand — the opening post for issues/PRs, the entry list for directories, the full content string for files/READMEs. Excerpts cross the contract **uncapped**; delivery caps unconditionally at render time. The cap is lossy by design: the uncapped excerpt survives in `details`, and the file on disk is the source of truth.

`highlights` are the exception, deliberately: they carry objective-steered answers — content the agent explicitly asked for by passing `objective` — and delivery renders every highlight in full. Capping them would defeat the steering.

### 4. Native-format artifacts, no envelopes

Bodies are plain files in their native format. There is no JSON wrapper, no metadata sidecar, no serialized document object on disk. Metadata lives in the digest; content lives in files that read, grep, and diff tooling handle natively. If a future consumer needs machine-readable results, that is a new requirement to design against — it does not exist today, and the agent's tools are strictly worse against envelopes.

### 5. GitHub fetcher: URL shapes and resolvers

`canFetch` claims hosts `github.com`, `raw.githubusercontent.com`, and `api.github.com`. Internal resolvers by URL shape:

| Shape | Resolution |
| --- | --- |
| `github.com/{owner}/{repo}` | README via `repos.getReadme` |
| `github.com/{owner}/{repo}/blob\|raw/{ref}/{path}` | file via `repos.getContent` |
| `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` | file |
| `api.github.com/repos/{owner}/{repo}/contents/{path}?ref=` | file |
| `github.com/{owner}/{repo}/tree/{ref}/{path}` | directory listing |
| `github.com/{owner}/{repo}/issues/{n}` | issue + comments |
| `github.com/{owner}/{repo}/pull/{n}` | PR + comments + reviews + review comments + files/patches |

Refs containing slashes make `{ref}/{path}` splits ambiguous in `blob`/`tree`/`raw` URLs. Resolution probes candidate splits longest-path-first via `repos.getContent` until one matches the expected type (file vs directory). Unresolvable URLs become unhandled and cascade to Parallel.

Document shapes per kind:

- **`github.file` / `github.readme`** — one body named with the file's own basename; content decoded from base64. When the contents API omits inline content (files over ~1MB), fall back to fetching `download_url`, capped at 100MB — GitHub's own raw-content ceiling; beyond that, record a failed attempt. Content that is not valid UTF-8 is written raw as binary (no excerpt, `binary` fact). Facts: repo, ref, path; a repo-root README additionally carries the escape hatch `whole repository: git clone https://github.com/{owner}/{repo}.git`, pointing the agent at the right tool for repo-scale retrieval without this tool pretending to be it.
- **`github.directory`** — one body `listing.md`: a table of type/path/size. Facts: entry count, and an incompleteness note when the contents API returns its 1,000-entry maximum.
- **`github.issue`** — one body `conversation.md`: title, state, labels, assignees, dates, body, comments. Facts: state (+reason), author, label list, comment count.
- **`github.pull_request`** — two bodies. `conversation.md`: metadata, PR body, issue comments, reviews, review comments with their diff hunks, and a changed-files table. `diff.patch`: concatenated per-file patches in unified diff format with `--- a/…` / `+++ b/…` headers, so file paths are greppable and standard diff tooling works. Facts: state/draft/merged, author, `+adds -dels`, file count, comment and review counts.

Excerpt policy per kind: issues and pull requests set `excerpt` to the opening post (body, else first comment) so the preview skips the rendered metadata bullets; directories set the entry-name list with `dir/` markers (`src/, docs/, package.json, …`); files and READMEs set the content itself — the head of it is the right preview, and delivery's cap does the trimming.

Pagination caps, enforced by a shared capped-list helper: issue comments 200, PR reviews 100, PR review comments 200, PR files 300, total patch text 400KB. A capped list is marked truncated only when more items actually exist (probe past the cap; a list of exactly the cap size is not truncated). Truncation is stated in both the rendered body and the facts.

All Octokit calls receive the tool's `AbortSignal` via `request: { signal }`.

### 6. GitHub auth: optional, injected, cached for the extension's lifetime

Auth is a `GitHubAuth` dependency (`fetchers/github/auth.ts`) injected into `createGitHubFetcher` and composed in `web-tools.ts` alongside the fetcher array. Resolution order:

1. `GH_TOKEN` environment variable
2. Token file `github-token` under pi's agent dir (via `getAgentDir()`, never a hardcoded `~/.pi/agent`)
3. `gh auth token` (5s timeout)
4. Anonymous client

The token file is used as-is, with no permission gating. The agent dir it lives in is user-private already (chezmoi deploys `~/.pi` with the `private_` prefix, so the directory is 0700 and group/other cannot traverse into it); a mode check on the child file would be redundant. Do not add one.

The resolved token is cached once, whichever source produced it. `GH_TOKEN` cannot change without a pi restart (process env is frozen at launch), and gh CLI OAuth tokens (`gho_…`) do not expire — they behave as API keys — so re-resolving per fetch buys nothing.

Client: `@octokit/rest`, `userAgent: "pi-parallel-web-tools"`, constructed lazily once per fetcher instance, with a silent logger passed at both the constructor and `request` levels — `@octokit/request` resolves its deprecation-warning logger from per-request options (`request.log || console`), and any console write corrupts pi's differential TUI renderer.

### 7. Parallel fetcher: terminal fallback, native objective steering

Parallel claims every URL and uses its native multi-URL `extract` with `full_content: true`. Results map to `parallel.page` documents with one body, `content.md`; facts carry the publish date. The `objective` tool parameter passes through to Parallel, which tailors excerpts natively — and the presence of an objective changes their delivery class: without one, the first excerpt becomes the document's capped `excerpt`; with one, *all* excerpts become `highlights`, delivered uncapped, because they are the answer the agent asked for. Parallel's per-URL extract errors normalize to failures.

Source-native fetchers ignore `objective` — silently, with no warning noise. Objective-steered processing of source-native results is Phase 3.

### 8. Module layout

```
extensions/web-tools.ts   — extension entry; composes auth + fetcher array, registers tools
extensions/web-tools/
  contract.ts             — the cross-module type surface (documents, fetchers, outcomes)
  router.ts               — claim-and-cascade routing over per-URL outcomes
  delivery.ts             — pure digest/Failed-section formatter over routed outcomes
  shared.ts               — cross-tool string/format helpers (used by search.ts too)
  fetch.ts                — createWebFetchTool(fetchers) tool factory + TUI rendering
  search.ts               — web_search (unchanged behavior)
  fetchers/
    github/               — GitHub fetcher: Octokit, URL parsing, resolvers, rendering
    github/auth.ts        — GitHubAuth token resolution, cached, injected via web-tools.ts
    parallel.ts           — Parallel client + fetcher (web_search helpers included)
```

The rule that matters: providers import from `contract.ts`/`shared.ts` only. No provider imports from a sibling provider or from the router, so `fetchers/gitlab.ts` starts clean.

### 9. Objective-steered summarization via ephemeral session (deferred)

When source-native fetches get large — a whole PR, later a whole repository tree — the right summarizer is not a single completion call over raw text. The deferred design is an ephemeral pi session: spawn a bounded agent with read/grep tools over the artifact directory, steered by `objective`, and return its findings as the digest. That is what makes repository-scale fetching viable without loading the tree into the caller's context. Recorded as direction only; it must not shape Phase 1/2 code beyond keeping the delivery layer source-agnostic.

## Edge Cases & Failure Modes

- **GitHub URL of unsupported shape:** unhandled by the GitHub fetcher; cascades to Parallel.
- **GitHub API failure (404, rate limit, network):** `FailedAttempt` recorded; URL cascades to Parallel. If Parallel succeeds, the document is delivered normally — the recovered attempt is visible only in `details`.
- **All fetchers fail for a URL:** the URL appears in the `Failed:` section with its full attempt trail.
- **No GitHub token:** anonymous client; public content works until unauthenticated rate limits bite, which surface as ordinary failed attempts.
- **File too large for inline API content:** `download_url` fallback up to 100MB, matching GitHub's raw-content ceiling; beyond that GitHub cannot serve it either — failed attempt with the reason in the trail.
- **Binary file:** written raw; digest notes byte size, no excerpt, `binary` fact.
- **Directory at the contents-API 1,000-entry ceiling:** listing delivered with an incompleteness note in facts and body.
- **List exactly at a pagination cap:** not marked truncated; truncation requires evidence of more items.
- **Ref/path split unresolvable (deleted branch, bad path):** unhandled; cascades to Parallel.
- **Abort during fetch:** `AbortSignal` reaches Octokit and Parallel requests; the tool raises promptly instead of finishing the batch.

## Alternatives

### JSON envelope persistence for all results

- **Status:** Rejected
- **Decision:** The only consumer is the agent, whose tools are line-oriented; JSON-escaped content defeats read offsets, grep, and diff tooling while costing full tokens to read. Envelope consistency benefits code that does not exist.
- **Discussion:** If a machine consumer ever appears, add structured output as a new requirement rather than pre-paying for it on every agent read.

### Partial inlining via head/tail truncation (bash-tool parity)

- **Status:** Rejected
- **Decision:** A partially inlined body looks complete enough to reason over and isn't. Files force the correct behavior — grep is the right tool anyway.

### Inline-or-elide with a shared per-call budget

- **Status:** Rejected (implemented, then replaced)
- **Decision:** The first delivery layer inlined bodies that fit a 50KB/2000-line per-call budget and elided the rest. Replaced by always-materialize because: inlined content pollutes context permanently while a read is transient and targeted; agents observably re-grep source files even when content was already in context, so the stable file is the asset and the inlined copy is redundant; the budget engine, ordering bias between URLs, and dual presentation states all delete under the uniform model; and body-as-in-memory-string could never scale to repository-sized retrieval.
- **Discussion:** The surviving cost is a follow-up read even for tiny documents. If that round trip ever proves painful in practice, inlining small bodies could return as a pure delivery-layer presentation choice (reading back from disk) without touching the fetcher contract.

### Delivery-owned disk writes

- **Status:** Rejected
- **Decision:** Having delivery write elided bodies kept fetchers filesystem-free, but it forced content to cross the module boundary in memory and made fetchers implicitly presentation-aware. Fetchers now own writes unconditionally: they need only a folder, can stream large payloads, and a future checkout resolver writes a tree like any other body. Delivery owns presentation only.

### Closed discriminated union of document types in the router

- **Status:** Rejected
- **Decision:** A closed union means circular type imports and a router edit per provider, purchasing type-narrowing that no downstream consumer uses. The digest is provider-rendered precisely so downstream code never needs variant fields.

### One top-level fetcher per GitHub URL shape

- **Status:** Rejected
- **Decision:** Scatters auth, client setup, pagination, and error normalization across modules. Internal resolvers give the same per-shape modularity inside one source boundary.

### `gh` CLI as the primary GitHub client

- **Status:** Rejected
- **Decision:** Shelling out per API call, untyped output, and a hard CLI dependency. `gh auth token` remains the sanctioned boundary for auth only.

### Single-completion model summaries (`webFetch.summary.model`)

- **Status:** Rejected in favor of the ephemeral-session direction (Decision 9)
- **Discussion:** A second model summarizing what the digest and a targeted read already cover buys little at document scale. Where summarization matters (repo-scale content), a single completion over concatenated text is the wrong shape; a tool-using ephemeral session over the artifact directory is.
- **Next step:** Design the ephemeral-session summarizer when repository-scale fetching (Phase 4) becomes concrete.

## Implementation Plan

- [x] Phase 1: Delivery contract, router, and provider adaptation
  - Goal: The structural document contract, unified failure channel, and always-materialize delivery replace envelope persistence end to end; both existing providers conform.
  - Files: `contract.ts` (new), `router.ts`, `delivery.ts` (new), `shared.ts` (new), `fetchers/github/auth.ts` (new), `fetchers/parallel.ts`, `fetchers/github/`, `fetch.ts`, `web-tools.ts`, `search.ts` (imports only), package manifests.
  - Work: Define the document/fetcher/outcome contract in `contract.ts` (root-relative path bodies, no content field); move cross-tool helpers plus `writeDocumentBody` to `shared.ts`; router allocates the per-call artifact root and passes `artifactDir` to fetchers; fetchers write every body as they resolve (GitHub: `conversation.md`, `listing.md`, `diff.patch`, file basename; Parallel: `content.md`); delivery renders digests, uncapped `highlights`, and the Failed section only; providers author uncapped excerpts per the Decision 5 policy; update the tool description/`promptGuidelines` and TUI rendering.
  - Validation: `uv run poe lint:pi`; real smoke tests: every GitHub kind lands on disk with correct digest paths/counts, a web page via Parallel (plain and objective-steered), and a nonexistent URL showing the attempt trail.

- [x] Phase 2: GitHub document quality and correctness
  - Goal: PR diffs delivered as `diff.patch`, digest facts per kind, and the known correctness gaps closed.
  - Files: `fetchers/github/`, `delivery.ts`.
  - Work: Build `diff.patch` from per-file patches with proper unified-diff headers under the 400KB cap; author per-kind facts (issue state/labels/comments; PR adds/dels/files/reviews; file repo/ref/path; directory entry count; repo-root git-clone escape hatch); binary detection writing raw bytes; `download_url` fallback for oversized files with the 100MB cap; pass `AbortSignal` into every Octokit call; fix capped-list truncation to require evidence of more items; byte-safe cuts wherever content is sliced.
  - Validation: `uv run poe lint:pi`; real smoke tests against public GitHub: file, README, directory, issue, PR with multi-file diff (grep a filename inside `diff.patch`), and an unsupported GitHub URL falling back to Parallel.

- [ ] Phase 3 (deferred): Combined objective-steered summarization via ephemeral pi session
  - Goal: A single, combined answer across **all** fetched documents in the call, regardless of source — an ephemeral tool-using session reads/greps the whole artifact directory (GitHub conversations, diffs, Parallel pages together) and produces one objective-steered summary. This is deliberately what Parallel's extract cannot do: its steering is strictly per-URL, and no per-source fetcher ever sees the other sources' results.
  - Files: new summarizer module; `delivery.ts` integration point.
  - Work: Design first (session bounds, tool allowlist, budget, failure isolation; whether Parallel's Task API is an alternative backend worth comparing); summarization failure must never fail the fetch.
  - Validation: To be defined by that design.

- [ ] Phase 4 (deferred): Repository-scale fetching
  - Goal: Explicit recursive tree support (`git.getTree` with `recursive`), materializing a repo subtree into the artifact directory, paired with Phase 3 so the caller's context receives a digest, not a tree.
  - Files: `fetchers/github/` resolver addition.
  - Work: Tree SHA resolution, truncated-response handling, blob-fetch caps, binary skipping.
  - Validation: Public-repo smoke tests for small and truncated trees.

- [ ] Phase 5 (deferred): Parallel session continuity via `session_id`
  - Goal: Determine whether passing Parallel's optional `session_id` ("track calls across separate search and extract calls… may give better contextual results") measurably improves `web_search` → `web_fetch` workflows, and wire it if so.
  - Files: `fetchers/parallel.ts`, `search.ts`, possibly `contract.ts` if the session handle needs to cross the tool boundary.
  - Work: Investigate first — what scope should a session cover (one pi session? one search-then-fetch chain?), where the identifier lives, and whether extract results actually differ with it. Only then plumb it through both tools.
  - Validation: Side-by-side extract results with and without `session_id` on a search-then-fetch sequence; adopt only if the difference is real.
