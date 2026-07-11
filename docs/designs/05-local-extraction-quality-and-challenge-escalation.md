# Local extraction quality and challenge escalation

## Status

Accepted

## Decision Summary

The local fetcher's extractor becomes a rehype (unified) pipeline — pruning, cleanup, and HTML→markdown conversion in TypeScript, in-process — replacing trafilatura entirely. The fetch worker gains two retrieval capabilities: shadow piercing (serializing open shadow roots into the captured HTML) and challenge escalation (deterministic bot-wall detection with an optional headed retry on the shared profile). The key tradeoff: the worker takes on the full retrieval saga — including briefly popping a visible browser window — in exchange for a local fetch path whose output quality matches the Parallel gold standard and whose bot-wall behavior is deterministic rather than heuristic.

## Problem Statement / Background

A 14-page eval (docs sites, SPAs, table-layout forums, news, Q&A, interactive pages) scored the local fetch pipeline against Parallel's extraction as gold standard, measuring 5-word-shingle recall/precision and fenced-code-line fidelity. Findings:

- **Trafilatura, the current extractor, is the pipeline's biggest quality loss.** It dropped code blocks and whole sections on 10 of 13 scorable pages (mean recall 0.45 on pruned input vs 0.69–0.72 for every general-purpose converter). On the Cloudflare Workers docs it kept 5.4KB of a 14KB page — losing every code snippet, warning, and later section. Extraction heuristics tuned for articles are the wrong tool for documentation.
- **A rehype-remark pipeline with three unconditional fixes matched or beat every alternative** (turndown, markdownify, Go html-to-markdown v2), reaching mean recall .91 / precision .93 against gold, including perfect scores on the table-layout pages that break naive conversion.
- **Two quality gaps live in the fetch stage, unreachable by any converter.** Browser-rendered MDN contains zero `<pre>` elements — hydration moves code into shadow roots that `page.content()` cannot see (the plain HTTP response had all nine). And Cloudflare bot walls served "Just a moment…" to the headless worker on stackoverflow.com and npmjs.com while Parallel retrieved both.
- **Bot walls are deterministically detectable and tiered.** Cloudflare marks challenge responses with a `cf-mitigated: challenge` header. Some challenges auto-resolve headless in ~5s; others never resolve headless but pass instantly in a headed browser. Implementation testing traced the second class to the user agent itself: stock headless Chrome announces `HeadlessChrome/…`, and that token alone drew the wall — the same profile fetched npmjs.com cleanly headless, cold, once the token was dropped. (The eval-era hypothesis that a headed pass persists a `cf_clearance` cookie which unblocks headless did not reproduce: no clearance cookie was ever written.)

Design 02 anticipated the extractor swap ("trafilatura today, defuddle when it clears artifactory") behind the `local-extractor.ts` seam; the eval replaced the intended successor with a better-measured one.

## Goals

- Local page extraction at Parallel-gold quality: complete content, faithful code blocks, readable structure, output size at parity.
- Web-component (shadow DOM) content survives capture.
- Challenged fetches succeed without user action where possible, and fail with an actionable message where not.
- No added latency or behavior change for unchallenged pages.
- Drop the uvx/trafilatura runtime dependency.

## Non-Goals

- No stealth/anti-detect dependencies (Patchright, Camoufox, playwright-extra). Version-fresh system Chrome plus profile cookies covers the observed cases; stealth is an escalation path for a future design if evidence demands it.
- No challenge detection for non-Cloudflare vendors (DataDome, PerimeterX) in this pass. The detection seam accommodates them later.
- No hard-coded per-site wait lists or content heuristics. Detection and waiting are signal-driven only.
- No rewriting of relative links to absolute. Agents can resolve relative links against the document URL themselves.
- No multiple selectable extractors. One extractor; the seam remains for testability, not pluggability.
- No post-conversion formatting pass (see Alternatives: prettier).

## Exposed Shape

### Agent-facing surface

Unchanged: `local.page` documents with one `content.md` body, digest-only tool results. Only the markdown quality changes. Failure reasons gain one new shape: a challenged, unescalatable fetch fails with a reason naming the bot wall and pointing at `/open-browser`.

### Extractor seam (`local-extractor.ts`)

- `extractToMarkdown(htmlPath: string, url: string): Promise<string>` — url is context (error messages, future needs), not a link-rewriting input.
- Owns: hast-level pruning, cleanup stages, markdown conversion. Runs in the extension host; pure-JS import tree (unified ecosystem — verified available: unified 11, rehype-parse 9, rehype-remark 10, remark-gfm 4, remark-stringify 11, unist-util-visit 5).
- Input contract: the worker's captured HTML, which may contain declarative shadow templates (`<template shadowrootmode>`); the extractor must see through them.

### Worker wire protocol (`worker-protocol.ts`)

- Ops unchanged (`fetch`, `open-browser`). The worker handles challenges internally; the extension never sees a "challenged" intermediate state.
- Spawn argv gains challenge configuration (escalation mode, wait budgets). Settings changes take effect when the worker next restarts (idle exit after 5min), matching the existing behavior of `executablePath`.

### Settings (`settings.ts`)

```
webTools.fetch.challenge:
  escalation: "headed" | "never"   # default "headed"
  headlessWaitSecs: number          # default 10
  headedWaitSecs: number            # default 20
```

### Principle (recorded in AGENTS.md)

The worker owns page retrieval — everything needed to turn a URL into bytes on disk, bot-wall challenges included. The extension decides what to fetch and owns all post-processing of captured artifacts.

## Design Decisions

### 1. rehype pipeline replaces trafilatura outright

One extractor, no fallback chain. Trafilatura's failure mode — silently dropping content that exists in the captured HTML — is strictly worse than a converter's worst case, and a conversion pipeline cannot return empty output on non-empty HTML the way an extraction heuristic can, so a fallback would have nothing to catch. Removing it also drops the uvx runtime dependency. Pipeline stages, all unconditional and site-agnostic:

1. **Parse** (`rehype-parse`).
2. **Strip `<base>` elements** — a relative `<base href="/">` (angular.dev, explorabl.es) crashes hast-util-to-mdast's URL resolution; removing the element prevents resolution entirely, which also keeps links as-authored.
3. **Unwrap declarative shadow templates** — splice `template[shadowrootmode]` content into the parent; hast parks template children in a `content` fragment that hast-util-to-mdast never visits. Verified: recovers all 71 gold code lines on MDN (from 0).
4. **Prune** to the first `<main>`, else `<article>`, else `<body>`. The single biggest quality lever in the eval: 42KB → 14KB (Parallel parity) with no recall loss on content pages.
5. **Cruft strip** — comments, `script`/`style`/`noscript`, `[aria-hidden="true"]` elements, empty anchors (heading permalinks).
6. **Demote layout tables** — any table whose cells contain block content becomes divs. GFM tables cannot hold block content; without this, table-layout pages (Hacker News, paulgraham.com) collapse into a handful of giant rows. This stage alone took rehype from worst to best on those pages (HN 0.84→1.00 recall).
7. **Code-block handling** — `pre` content captured as line-faithful text (handles div-per-line highlighters like Expressive Code/Shiki, which turndown corrupts by fusing lines); fence language recovered from `data-language` or `language-*` classes.
8. **Convert and serialize** (`rehype-remark` → `remark-gfm` with `tablePipeAlign: false` → `remark-stringify`). Pipe alignment padded HN's table cells with 150KB of literal spaces; disabling it is lossless.

### 2. Pruning happens in the extractor, on the hast tree

Not in the worker's live DOM. Follows the worker-ownership principle: pruning is post-processing of a captured artifact, so it belongs in the extension where it is unit-testable with HTML fixtures. Consequence: the worker always writes the full page HTML, so pruning mistakes are recoverable from the artifact.

### 3. Shadow piercing is always on

The worker serializes with `document.documentElement.getHTML({ shadowRoots: <all open roots, collected recursively> })`, feature-detected with fallback to `page.content()`. Unconditional — no heuristic to decide when piercing is "needed". The cost is capture size (MDN: 86KB → 219KB), which pruning reclaims. Closed shadow roots remain unreachable; accepted.

### 4. Challenge detection is deterministic: the `cf-mitigated: challenge` response header

Cloudflare publishes this header on challenge responses precisely so tooling can react. No title sniffing, no body heuristics, no URL lists, and — critically — zero added latency for pages that don't send the header. Non-CF vendors have analogous markers and can join at the same seam later.

### 5. The headless user agent drops the "Headless" token

The worker probes `navigator.userAgent` once per process; if it contains `HeadlessChrome`, it relaunches with the token replaced by `Chrome` and caches the result. This is not a stealth dependency (see Non-Goals) — it is one launch option normalizing the single blatant self-identification that empirically accounted for every never-resolves-headless wall in the corpus. With it, the npm-class wall stops challenging at all; escalation becomes the fallback for walls with deeper checks rather than the routine path.

### 6. Challenge waiting is event-driven with fixed budgets

When the header fires, the worker waits for the navigation the challenge itself triggers on success (title/URL change), bounded by `headlessWaitSecs` (10). A failing challenge produces no observable "gave up" signal — it just keeps probing — so a budget is the only honest terminator. The budget asymmetry is deliberate: giving up early costs a visible browser window (escalation); waiting costs silent seconds. Observed: successful resolutions cluster around 5s.

### 7. Escalation swaps the shared profile to a headed browser, inline in the worker

When the headless wait expires and escalation is `"headed"`, the worker: waits for in-flight peer fetches to drain, closes the headless context, launches headed on the same profile (the existing `/open-browser` dance), re-navigates, waits up to `headedWaitSecs` (20), captures in the headed context, closes it, and lazily relaunches headless on the next fetch. Fetches arriving mid-escalation queue rather than fail.

Same-profile swap preserves design 02's profile-lock invariant (one browser instance per profile, enforced in the worker) and keeps whatever clearance the wall grants in the persistent profile. Whether subsequent headless fetches to that site pass depends on the vendor honoring its clearance for the headless client; for the observed walls the durable fix is the UA normalization above. The cost — concurrent fetches stall during an escalation — is bounded by the wait budgets and paid only when a bot wall is actively blocking a fetch.

### 8. The worker decides escalation; the extension never re-issues

Escalation policy config is passed at worker spawn, and the whole detect→wait→escalate→capture saga happens inside one `fetch` op. This is the worker-ownership principle applied: retrieval belongs to the worker; a challenge is a retrieval concern. It also keeps the wire protocol unchanged and gives the saga a single 60s client deadline to live within (10 + 20s budgets fit).

## Edge Cases & Failure Modes

- **Challenge resolves within the headless budget:** capture proceeds normally; no escalation, no user-visible effect but the wait itself.
- **Challenge unresolved and escalation is `"never"`:** per-URL failure — `blocked by a bot-detection challenge (cloudflare) — run /open-browser to resolve it manually`.
- **Challenge unresolved and headed launch fails (no display, SSH):** same failure path as `"never"`; the launch error is appended to the reason.
- **Challenge unresolved even headed:** per-URL failure after `headedWaitSecs`; headed context closes; headless resumes.
- **Interactive browser already open when a challenged fetch wants to escalate:** fetch fails with the existing "interactive browser is open" reason; the user is mid-login, which likely resolves the wall anyway.
- **`getHTML` unavailable (older Chrome):** silent fallback to `page.content()`; behavior equals today's.
- **Slotted content duplication:** flattening shadow templates keeps both the shadow tree and the host's light-DOM children, so slotted content can appear twice. Not observed in the eval; accepted as a known limitation rather than pre-engineered around.
- **Page with no `main`/`article`:** prune falls back to `body`; eval pages of this shape (HN, paulgraham.com) scored 1.00/1.00 via the layout-table stage.
- **Settings changed mid-session:** stale worker until idle-exit restart (5min); consistent with `executablePath` behavior.

## Alternatives

### Other converters: turndown, markdownify, Go html-to-markdown v2

- **Status:** Rejected
- **Decision:** turndown silently fuses div-per-line code (`SECRET_KEY="value"API_TOKEN=…`) and drops fencing on bare `<pre>` (0 of 588 code lines on Sphinx docs) — disqualifying failure modes for a coding agent. markdownify scored well on recall but is the noisiest (link-title duplication, worst unpruned precision) and adds a Python runtime dependency. The Go library tied rehype on aggregate scores but injects blank lines into code, requires shipping a compiled binary, and offers no plugin seam — every one of rehype's eval failures was fixable inside the pipeline; the Go library's weren't reachable.
- **Discussion:** Full scoreboard and per-page scores preserved in the eval artifacts (`/tmp/pi-local-compare/shootout/`, summarized in the session handoff doc).

### Defuddle (Obsidian's Readability successor)

- **Status:** Rejected
- **Decision:** Ran through the same 14-page battery (full-page input, `markdown: true`): mean recall .77 / precision .95 vs rehype's .85/.90 on clean pages. Best-in-class noise removal, but it is the same architectural class as trafilatura — an extraction heuristic — and it exhibits the class's failure mode: dropped 12 of 44 gold code lines on the Cloudflare docs page (rehype: 42) and lost a third of shapes.inc. Its precision edge is exactly what the cruft-strip stage closes without sacrificing completeness. Also requires jsdom in the host import tree.
- **Discussion:** Design 02 named defuddle the intended trafilatura successor; this measurement retires that intention.

### Prettier post-conversion pass

- **Status:** Rejected
- **Decision:** Byte-level no-op after remark-stringify (prettier's markdown engine is remark), and it preserves fenced code verbatim so it cannot repair conversion-stage damage. Tested on 8 diverse pages.

### Ephemeral headed profile + cookie transplant (escalation without pausing peers)

- **Status:** Rejected
- **Decision:** Preserving the single-profile invariant beat preserving concurrency during a rare event. The transplant introduces a new invariant (two profiles, cookie sync between them) and its cross-profile `cf_clearance` viability was unverified; the profile swap reuses the proven `/open-browser` mechanism.

### Extension-side escalation policy (worker returns typed "challenge" failure; extension re-issues with a headed flag)

- **Status:** Rejected
- **Decision:** Contradicts the worker-owns-retrieval principle settled in this design; would put a retrieval decision in the extension and grow the wire protocol for no capability gain.

### Absolute link rewriting

- **Status:** Rejected
- **Decision:** Not worth a transformation stage; agents resolve relative links against the document URL. Deleting `<base>` elements (needed anyway for the crash fix) keeps links as-authored.

### Non-focus-stealing escalation window

- **Status:** Open
- **Open Issue:** The headed escalation window activates Chrome and steals focus. No supported Playwright path launches headed-without-focus; the referenced computer-use projects don't achieve invisibility either (open-codex-computer-use captures *backgrounded but on-screen* windows via ScreenCaptureKit and has explicit focus-stealing recovery paths; its browser sibling uses Chrome extension APIs — `active: false, focused: false` — unavailable to a Playwright launch).
- **Discussion:** Full invisibility may also be self-defeating: challenge scripts consult visibility and interaction signals, and an occluded window on macOS reports itself hidden. Partial mitigations exist — small window via `--window-size`/`--window-position`, or macOS-side focus restoration to the previous app after launch.
- **Next step:** Test whether a challenge resolves in an unfocused/backgrounded headed window; if yes, focus restoration is a cheap polish item.

## Implementation Plan

Reference implementations from the eval live outside the repo and inform but do not gate the phases: pipeline prototype `/tmp/pi-local-compare/shootout/rehype.mjs` (+ `rehype-shadow-test.mjs`), worker experiments `fetch-experiments.mjs` / `detect-challenge.mjs`, scoring harness `score.py` with per-page artifacts under `eval/`.

- [x] Phase 1: rehype extractor replaces trafilatura
  - Goal: `local.page` markdown at eval-proven quality; uvx dependency gone; loader-safety risk retired.
  - Files: `package.json`, `extensions/web-tools/fetchers/local/local-extractor.ts`, `extensions/web-tools/fetchers/local/local.ts` (pass `url` to the seam), `extensions/web-tools.ts`, `test/local-extractor.test.ts`, `test/fixtures/*.html`, `README.md` (line 67 Trafilatura mention), `DEV.md` if gotchas change.
  - Work: add unified/rehype-parse/rehype-remark/remark-gfm/remark-stringify/unist-util-visit; implement `createRehypeExtractor()` with the eight stages (Decision 1); change the seam to `extractToMarkdown(htmlPath, url)`; delete `createTrafilaturaExtractor`.
  - Validation: **first**, before any porting — `pi -e` smoke to prove the unified import tree survives the host loader (the one assumption that can reshape the design; if it fails, the extractor moves behind a child process and the plan is revised). Then fixture tests per stage: relative-`<base>` page (no crash, links as-authored), layout table (no giant GFM rows), div-per-line code (line-faithful fence + language), shadow template (content visible), prune fallback chain (`main`→`article`→`body`), aria-hidden/comments/empty-anchor stripping. `mise run check`. SMOKE.md pass against the Cloudflare secrets page; spot-compare `content.md` to the eval reference output.

- [x] Phase 2: shadow piercing in the worker
  - Goal: hydrated web-component content survives capture.
  - Files: `extensions/web-tools/fetchers/local/fetch-worker.ts`.
  - Work: replace the `page.content()` capture with an evaluated `getHTML({ shadowRoots })` over recursively collected open roots, feature-detected with `page.content()` fallback.
  - Validation: smoke-fetch the MDN flatMap page — `content.md` contains the nine code blocks (zero today); a non-shadow page (go.dev blog) is byte-comparable to before. `mise run check`.

- [x] Phase 3: challenge detection and headless wait
  - Goal: challenged fetches deterministically detected; auto-resolving walls pass; the rest fail actionably. No escalation yet — and no escalation *setting* yet, so nothing half-implemented is exposed.
  - Files: `extensions/web-tools/fetchers/local/fetch-worker.ts`, `worker-protocol.ts` + `worker-connection.ts` (spawn argv), `extensions/web-tools/settings.ts`, `test/settings` coverage if present.
  - Work: read the main-frame response's `cf-mitigated` header; on `challenge`, wait event-driven (title/URL change) up to `headlessWaitSecs`; on expiry fail with the wall-naming `/open-browser` message. Add `webTools.fetch.challenge.headlessWaitSecs` (default 10) and plumb it through spawn argv.
  - Validation: smoke vs npmjs.com → typed failure with actionable reason; healthy-page smoke shows zero added latency; after a manual `/open-browser` visit to npm, the same fetch passes headless (cookie persistence). `mise run check`.

- [x] Phase 4: headed escalation
  - Goal: npm-class walls pass without user action when policy allows.
  - Files: `extensions/web-tools/fetchers/local/fetch-worker.ts`, `extensions/web-tools/settings.ts`, `README.md` (document the pop-up behavior and the setting).
  - Work: add `challenge.escalation` (`"headed"`|`"never"`, default `"headed"`) and `headedWaitSecs` (default 20); escalation saga per Decision 6 — drain in-flight peers, swap the profile to headed, re-navigate, wait, capture there, swap back lazily; queue fetches arriving mid-escalation; headed-launch failure falls through to the Phase 3 failure path with the launch error appended.
  - Validation: smoke vs npmjs.com on a cold profile → window pops, fetch succeeds, follow-up fetch passes headless with no window; `escalation: "never"` → Phase 3 failure text; concurrent-fetch smoke (challenged URL + two healthy URLs in one call) completes all three. `mise run check`.

- [x] Phase 5: close out
  - Goal: docs and design state reflect reality.
  - Files: `docs/designs/05-...md` (status → Accepted), `CONTEXT.md`, `SMOKE.md` (add MDN shadow case and challenge cases to the script).
  - Work: verify CONTEXT.md terms match shipped behavior; sweep for stale trafilatura/uvx references; record the unfocused-window test result on the Open alternative if performed.
  - Validation: `mise run check`; full SMOKE.md pass.

### Implementation notes (deviations from the plan)

- Phase 1 additionally taught the aria-hidden strip to spare subtrees containing an alt-bearing `<img>`: Wikipedia renders math as aria-hidden fallback images whose `alt` carries the LaTeX, and stripping them cost 0.12 recall on that page.
- Phase 4 surfaced that the eval-era `cf_clearance` persistence claim was wrong (no clearance cookie is written) and that the `HeadlessChrome` UA token was itself the trigger for never-resolves-headless walls. Decision 5 (headless UA normalization) was added; with it the npm-class wall stops challenging entirely and escalation is a genuine fallback. Post-fix validation: cold profile, `escalation: "never"`, npmjs.com fetched headless in 3.0s with no challenge.
- The client request deadline rose from 60s to 120s: an escalation is two navigations plus both wait budgets plus peer drain.
- The eval reference for pipeline quality: production extractor scored recall .854 / precision .934 vs the prototype's .848/.904 over the 10 clean-gold corpus pages.

### Post-acceptance refinements (review)

- The client request deadline became dynamic — `30s base + headlessWaitSecs + headedWaitSecs` (defaults land on 60s) — and arms only when the worker reports a fetch `started`, so time queued behind page slots or an escalation doesn't count. Liveness while queued is guaranteed by unqueued peers' deadlines plus socket-close rejection.
- Challenge budgets became merged clocks per stage rather than per-step timeouts: everything downstream of detection (challenge wait, post-resolution load) draws from one deadline, and the headed attempt's clock starts at its navigation. Fast steps donate leftover budget to slow ones.
- `/open-browser` became `/browser open`; `/browser restart` stops the worker so the next fetch respawns with freshly loaded settings.
- Validated against a synthetic challenge server (deterministic `cf-mitigated` + delayed reload), since UA normalization removed every live wall from the test corpus.
- Second review round: the worker became canonical for retrieval timing — `started` carries the `budgetSecs` it will honor (fixing client/worker deadline skew across settings changes and sessions) and the worker heartbeats every 5s per connection, so the client's liveness rule is settings-free: 20s of total socket silence with requests pending means a wedged worker, which is put down. Liveness is traffic-based rather than duration-based because only the worker knows how long its work honestly takes. The UA probe's unbounded `page.evaluate` — the concrete immortal-zombie path — is bounded at 10s. `/browser restart` waits for the old worker to exit (SIGTERM → poll → SIGKILL at 5s) so the next fetch cannot race a dying socket. A request that waited out another request's escalation retries headless before opening its own window (escalation as profile recovery).
- Addendum completion: the concurrency state moved from module globals into the driver-free `BrowserSession`, with deterministic fake-launcher tests. Live validation exercised six-slot handoff across an eight-fetch batch, 5s heartbeats, the restart PID barrier, headless challenge auto-resolution, and both headless-only and headed challenge expiry. The first live launch also caught and removed a Node strip-types-incompatible parameter property that TypeScript and Vitest legitimately accept.

## Addendum: Remaining Work

Post-acceptance worker follow-up, in dependency order:

1. [x] **Extract the worker's state owner.** `BrowserSession` now owns browser context lifecycle, page slots, the drain/escalation gate, interactive ownership, UA normalization, and browser shutdown. Its launcher is injected; `fetch-worker.ts` retains Playwright page retrieval and socket protocol plumbing. The extraction intentionally preserves the existing sequencing and failure messages.
2. [x] **Concurrency test suite.** Deterministic fake-launcher coverage now exercises slot handoff under contention; escalation peer draining, admission blocking, and gate release on success and failure; simultaneous challenges and the post-escalation headless retry; shared launch failure; interactive ownership during active work; and UA normalization. Connection tests separately prove that silence fires the stall watchdog, heartbeats keep slow work alive, and restart waits for process exit. No Chrome or OS socket is involved in these tests; live worker smokes remain the integration evidence.
3. **Test the unfocused-escalation hypothesis** (see the Open alternative above): whether a challenge resolves in a backgrounded headed window. If yes, focus restoration after the pop-up is a cheap polish item.
4. **File the upstream `hast-util-to-mdast` issue**: a relative `<base href>` crashes URL resolution (`new URL(url, "/")`); the fix is a one-line unresolvable-base guard. Our base-strip stage stays regardless — links should remain as-authored.
5. **Second challenge vendor, when evidence arrives.** The detection seam is header-based and CF-only by choice; a DataDome/PerimeterX marker joins at the same spot in `fetchWithPage`, and the blocked-message vendor name becomes parameterized then, not before.
