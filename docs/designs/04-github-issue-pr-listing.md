# GitHub issue/PR listing URLs

## Status

Accepted

## Decision Summary

`web_fetch` learns two new GitHub URL shapes — `github.com/{owner}/{repo}/issues` and `/pulls`, with an optional `?q=` in GitHub's search syntax — resolved natively through the Search API into a capped listing document. Listing and search are deliberately one feature: GitHub's own list pages carry their entire query language in the URL, so one resolver backed by `GET /search/issues` covers both. The tradeoff accepted: search has its own, tighter rate-limit bucket, and results cap at one API page (100), pushing the agent to refine queries rather than paginate.

## Problem Statement / Background

Doc 01 gave `web_fetch` native resolvers for single issues and PRs, but a bare list URL (`github.com/owner/repo/issues`) falls through `parseGitHubUrl` unclaimed and cascades to Parallel or the local browser — an HTML scrape of a client-side-rendered page, the exact failure mode doc 01 exists to eliminate. `pulls` isn't recognized as a marker at all. The agent has no native way to answer "what's open in this repo?" or "find the issue about X" without already knowing the number.

Concrete scenario: the agent is debugging a dependency and wants open issues mentioning a symptom. Today it must scrape or guess issue numbers. With this design it fetches `github.com/dep/repo/issues?q=extraction+failed` and receives a table of matches with numbers, titles, and URLs — each row chaining naturally into the existing single-issue resolver.

Timing note: GitHub's search migration to "advanced search" completed September 4, 2025; `GET /search/issues` now serves advanced syntax by default with no opt-in parameter. There is no newer endpoint to wait for.

## Goals

- Bare `/issues` and `/pulls` URLs return the repo's open items, capped, as a listing document.
- `?q=` URLs execute GitHub's full search syntax (labels, authors, dates, full-text, `sort:`) with results matching what github.com itself would show.
- Listing rows carry enough to chain: number, title, state, author, labels, comment count, updated date, URL.
- The tool's `promptGuidelines` teach that issue/PR listing and search are possible and what the URL shapes look like.

## Non-Goals

- No global search (`github.com/search?q=…`) — deferred until a real need appears; the API call is identical, only the `repo:` qualifier is absent.
- No pagination past 100 results; the digest reports the total so the agent narrows the query instead.
- No `sort:` translation into API `sort`/`order` parameters — the qualifier works inside `q` (verified live: `sort:created-asc` and `sort:comments-desc` reorder results as expected).
- No `web_search` involvement; this is a `web_fetch` URL shape per doc 01's routing model.

## Exposed Shape

New URL shapes claimed by the GitHub fetcher:

| URL | Effective query |
| --- | --- |
| `/{owner}/{repo}/issues` | `repo:o/r is:issue state:open` |
| `/{owner}/{repo}/pulls` | `repo:o/r is:pr state:open` |
| `/{owner}/{repo}/issues?q=label:bug` | `repo:o/r is:issue label:bug` |
| `/{owner}/{repo}/pulls?q=is:merged` | `repo:o/r is:merged` |
| `/{owner}/{repo}/issues?q=is:closed extraction` | `repo:o/r is:closed extraction` |

Also claimed while touching the parser: `/{owner}/{repo}/pulls/{n}` as a single-PR URL (github.com redirects it to `/pull/{n}`).

Document shape (`github.issue_list` / `github.pull_request_list` by tab):

- Title: `owner/repo issues: <effective query>` (resp. `pulls:`).
- Facts: total match count from `total_count`, shown count when capped (`342 matches, showing first 100`), the effective query.
- Excerpt: the numbered title list, same policy as directory listings.
- One body, `listing.md`: a table of number, title, state, author, labels, comments, updated, URL.

`promptGuidelines` gains one line: repo issue/PR list pages are fetchable natively — `github.com/{owner}/{repo}/issues` or `/pulls`, optionally with `?q=` in GitHub search syntax, returning up to 100 matches.

## Design Decisions

### 1. URL shapes, not a new tool

Listing rides the existing `web_fetch` contract as a new internal resolver, per doc 01's "new shape = new resolver" rule. Agents already produce these URLs naturally; a dedicated `search_github` tool would duplicate the GitHub entry point and contradict doc 01's non-goal of keeping search routing out of the tool surface.

### 2. Search API as the sole backend

`search.issuesAndPullRequests` (`GET /search/issues`) accepts the same `q` syntax as the web UI, so one code path serves bare lists and arbitrary searches. The plain list endpoints (`issues.listForRepo`, `pulls.list`) were rejected: simple filters only, and `listForRepo` mixes PRs into issues — two code paths and a behavioral seam for less capability. Post-migration advanced-search semantics apply: spaces between `repo:`/`org:`/`user:` qualifiers mean AND, harmless here since exactly one `repo:` qualifier is ever injected.

### 3. Query merge mirrors github.com

Bare paths get the tab's type qualifier plus `state:open` — what the tab shows by default. An explicit `?q=` gets `repo:` always, the type qualifier only when the query lacks one, and **no state default**: `q=label:bug` searches all states, exactly like typing in GitHub's search box. Forcing `state:open` onto explicit queries would make "find that closed issue" silently return nothing. Type-qualifier detection treats `is:issue`/`is:pr`/`type:issue`/`type:pr` as explicit, and `is:merged`/`is:unmerged` as PR-implying (they can only match PRs; injecting `is:pr` on top would be noise). The user's `q` text passes through verbatim — no rewriting.

### 4. Cap at one API page (100), report the total

One Search API call, no pagination loop. `total_count` lets the digest say what was missed, and a query refinement answers better than page 2 ever does — a 200-row table is a smell that the query needed narrowing.

Rate limits get no design accommodation beyond ordinary failure handling, and deliberately no agent-facing language: promptGuidelines, facts, and the digest stay silent about the search quota. The agent gets unfettered use; if real usage ever exhausts the bucket, that is the moment to reconsider, not before.

## Edge Cases & Failure Modes

- **Search rate limit exhausted:** ordinary failed attempt; the URL cascades to Parallel/local scraping per doc 01 routing. Accepted as the existing degraded path.
- **Zero matches:** valid document — `0 matches`, empty table, no failure.
- **`q` with invalid syntax:** GitHub returns 422; failed attempt with the API message in the trail, then cascade.
- **`sort:` qualifier:** passes through and works (verified); no translation layer.
- **1,000-result API ceiling:** irrelevant at a 100-item cap; `total_count` still reports the true total.
- **`/issues?q=is:pr`:** honored — the explicit type qualifier wins over the tab. Mirrors github.com.

## Alternatives

### Dedicated `search_github` tool

- **Status:** Rejected
- **Decision:** Breaks the everything-is-a-URL model, adds a second GitHub entry point, contradicts doc 01's non-goals. Structured params buy nothing the `q` syntax doesn't already express.

### List endpoints (`issues.listForRepo` / `pulls.list`), or hybrid with Search only for `?q=`

- **Status:** Rejected
- **Decision:** Simple filters only; `listForRepo` returns PRs mixed into issues while Search does not — a subtle behavioral seam between the bare and `?q=` paths. The hybrid's rate-limit benefit doesn't justify two rendering paths.

### Global search URLs (`github.com/search?q=…&type=issues`)

- **Status:** Open (deferred)
- **Retained discussion:** Same API underneath, one more parse branch; the `repo:` qualifier simply isn't injected.
- **Next step:** Add when a real workflow needs cross-repo search from the agent.

## Implementation Plan

- [ ] Phase 1: Listing resolver end to end
  - Goal: `/issues`, `/pulls`, and `?q=` URLs resolve natively into listing documents; `pulls/{n}` resolves as a single PR. The tool surface is not yet updated — behavior is additive and invisible until a list URL is fetched.
  - Files: `extensions/web-tools/fetchers/github/urls.ts`, `extensions/web-tools/fetchers/github/listing.ts` (new), `extensions/web-tools/fetchers/github/index.ts`, `test/github-urls.test.ts`, `test/github-listing.test.ts`.
  - Work:
    - `urls.ts`: an `issues`/`pulls` marker with no trailing segment parses to `{ type: "issue_list" | "pull_request_list", target: ListTarget }`, where `ListTarget = GitHubRepo & { url: string; tab: "issues" | "pulls"; q?: string }`; `q` read from the query string (`URLSearchParams` already decodes `+` as space). A `pulls` marker with a numeric segment parses as the existing `pull_request` type (github.com redirects `/pulls/{n}` to `/pull/{n}`). Non-numeric segments like `/issues/new` keep falling through to unsupported.
    - `listing.ts`: `buildListQuery(target)` as a pure function implementing Decision 3 — always inject `repo:owner/name`; inject the tab's `is:issue`/`is:pr` unless the query already contains `is:issue`, `is:pr`, `type:issue`, `type:pr`, `is:merged`, or `is:unmerged`; add `state:open` only when `q` is absent; user text passes through verbatim. Call `search.issuesAndPullRequests` with the merged query, `per_page: 100`, and the tool's abort signal.
    - Document assembly: kind by tab; title `owner/repo issues: <effective query>` (resp. `pulls:`); facts per the Exposed Shape (`total_count`, shown count when capped, effective query); excerpt as numbered `#123 Title` lines (delivery caps as usual); one body `listing.md` — a table of number, title, state (plus draft for PRs), author, labels, comments, updated date, URL.
    - `index.ts`: dispatch the two new parse types to the listing resolver.
    - Tests: URL-parse cases (bare `/issues`, bare `/pulls`, `?q=` variants, `pulls/{n}`, `/issues/new` rejection) and merge-rule cases (type injection on bare paths, explicit type qualifier wins, `is:merged` implies PR, `state:open` only when bare, verbatim pass-through including `sort:`).
  - Validation: `mise run check`; live smoke against a busy public repo: bare `/issues` returns open issues; `/pulls?q=is:merged` returns merged PRs; a full-text `q` finds a known issue; `sort:created-asc` visibly reorders; a zero-match query yields a `0 matches` document; an invalid `q` shows the 422 attempt trail and cascades.

- [ ] Phase 2: Tool surface, smoke, and release
  - Goal: The capability is discoverable by the agent and shipped to npm consumers.
  - Files: `extensions/web-tools/fetch.ts`, `SMOKE.md`, `CHANGELOG.md`.
  - Work: Add the promptGuidelines line — repo issue/PR lists and search are fetchable via `github.com/{owner}/{repo}/issues` or `/pulls`, optionally with `?q=` in GitHub search syntax, up to 100 matches; no rate-limit caveats per Decision 4. Extend SMOKE.md with the listing checklist from Phase 1's validation. Changelog entry; cut a minor release via the npm-release skill.
  - Validation: SMOKE.md pass on the dev checkout; release workflow green; `pi install npm:@thurstonsand/pi-web-tools` on a clean environment lists a repo's issues natively.
