# Local web fetch backend

> Migrated from ansiblonomicon `docs/designs/18-local-web-fetch-backend.md`. File paths and doc numbers updated to the pi-web-tools layout (see `03-pi-web-tools-repo-extraction.md`); decisions and prose otherwise unchanged.

## Status

Accepted

## Decision Summary

`fetch_web` gains a terminal **local fetcher**: a singleton worker process driving the system-installed Chrome via `playwright-core`, with trafilatura extraction behind a swappable seam. The fetcher chain becomes `[github, parallel, local]` unconditionally — Parallel's availability (key present) is expressed at claim time via `canFetch`, so a missing key or a Parallel outage both cascade per-URL to the local backend. The key tradeoff: a resident browser worker and a hard requirement on a system browser, in exchange for a Parallel-free, authentication-capable fetch path on every machine — including the work machine, where Parallel is not allowed at all.

## Problem Statement / Background

The work machine cannot use Parallel. Today that means `fetch_web`'s terminal fetcher is dead there: any URL the GitHub fetcher doesn't claim has no resolution path. The interim answer was a fork of [pi-web-fetch](https://github.com/georgebashi/pi-web-fetch) registered as a separate pi package at work — which surfaced the constraints this design must honor:

- **The pi host process cannot import a browser driver.** At work, pi runs under bun and its extension loader resolves the extension's import graph through jiti with `tryNative: false`. Puppeteer's transitive import tree hard-crashed the host. The fork's fix — browser automation in a separate worker process spawned with `node`, speaking newline-delimited JSON — is the load-bearing architecture, not a workaround, and it is driver-agnostic: playwright's import tree is the same class of hazard.
- **Authenticated fetching matters.** The fork added a persistent isolated Chrome profile and an `/open-browser` command to log into sites interactively (SSO'd internal pages Parallel could never reach). Retiring the fork without losing this means the login flow is in scope.
- **One tool, one contract.** Running the fork alongside `parallel-web-tools` means two competing web-fetch tools per session, and the fork's inline delivery contradicts the always-materialize contract of `docs/designs/01-github-aware-web-fetch-routing.md`. This design absorbs the fork's capabilities into the design-01 fetcher chain, and the fork retires.

Concrete scenario: at work, the agent is asked to check an internal Confluence page and a public library's docs. Parallel is absent (no key). The GitHub fetcher claims neither URL; the local fetcher renders both in headless Chrome — the Confluence page authenticated by cookies from a one-time `/open-browser` login — extracts clean markdown, and delivers digests plus `content.md` files exactly as any other source fetcher would.

## Goals

- `fetch_web` resolves any public (and, with a logged-in profile, authenticated) web page with no Parallel dependency, on every deploy target.
- Parallel failures — missing key, outage, per-URL extraction errors — cascade to the local fetcher instead of failing the URL.
- The local fetcher conforms fully to the design-01 contract: always-materialize, digest-only tool result, provider-authored excerpt.
- No browser-driver code is ever imported by the pi host process.
- The HTML→markdown extractor is swappable behind one seam (trafilatura today, defuddle when it clears work artifactory).
- Interactive-login parity with the pi-web-fetch fork: persistent profile, `/open-browser`, single-instance lock semantics.
- The `~/code/pi-web-fetch` work fork is retired from the package list.

## Non-Goals

- No local `search_web` backend. Without `PARALLEL_API_KEY`, `search_web` is simply not registered.
- No `objective` steering in the local fetcher; that remains deferred to design 01's Phase 3 ephemeral-session direction.
- No fetch cache. Always-materialize already leaves stable artifacts; the fork's 15-minute cache served a re-prompt workflow this contract doesn't have.
- No managed/downloaded browsers. The system browser is required (see Decision 3).
- No local-only URL allowlist in this pass; recorded as an Open alternative below.
- No OpenClaw provisioning in this pass; the design accounts for it (Decision 3) but the implementation plan excludes it.
- No extension rename. `parallel-web-tools` is now a misnomer; renaming touches settings templates and deploy config and happens as a separate task.

## Exposed Shape

### Terminology

- **Local fetcher** — the terminal source fetcher (`source: "local"`, kind `local.page`, module `local.ts`). Named for intent — no external service — not mechanism; the internals (driver, extractor) are expected to change.
- **Fetch worker** — the singleton standalone process (`node fetch-worker.ts`) that owns playwright-core and the browser. The only process that ever touches a browser driver.
- **Interactive browser** — the headed browser launched on the shared profile via `/open-browser` so the user can authenticate logins.
- **Profile lock** — the invariant that exactly one browser instance may use the persistent profile at a time. Enforced in the worker, which launches both modes.
- **Extractor** — the HTML→markdown seam inside the extension (`local-extractor.ts`). Trafilatura via uvx today; defuddle is the intended drop-in.

### Agent-facing surface

The tool result shape is unchanged from design 01. A locally-fetched document is one of two kinds:

- **`local.page`** — an HTML page: one body `content.md` (extracted markdown), title from the rendered page's `<title>`, excerpt from the head of the extracted markdown (delivery caps it as usual).
- **`local.file`** — a non-HTML response (PDF, archive, raw data): one body holding the raw bytes under the URL's filename (or a content-disposition name), title from that filename. No excerpt; facts carry the content type and size. HTML parsing is a footprint-reducing helper, not a gate — if the agent asked for a PDF, it gets the PDF.
- `link`: the final URL when redirects (including cross-host) moved the request; redirects are followed, not surfaced.
- failures carry actionable reasons in the attempt trail, e.g. `parallel: no API key → local: page load timed out after 15s` or `local: interactive browser is open — quit Chrome to resume fetching`.

### User-facing surface

- **`/open-browser`** — pi command registered by the extension. Closes the headless browser if running, opens a headed browser on the persistent profile. Fetches from **all** pi sessions error while it is open; quitting the browser restores fetching.
- **Settings** — configured through pi's `settings.json` (chezmoi-templated per host), not a separate config file and not env vars. The top-level key is `webTools` — one namespace for the whole extension, with per-tool sections so future `search` settings have a home without a second top-level key. Browser config nests under `fetch.browser` (named for what it configures; `local` said too little), keeping room for fetch-wide settings beside it:

  ```jsonc
  "webTools": {
    "fetch": {
      "browser": {
        "executablePath": "/usr/bin/chromium",        // optional; default: playwright channel "chrome" discovery
        "profileDir": "~/.pi/agent/browser-profile"   // optional; this is the default
      }
    }
  }
  ```

  The implementation mirrors pi-librarian's settings module: a TypeBox schema over `SettingsManager.getGlobalSettings()` with an optional root key and a resolve step that expands `~`, validates paths, and applies defaults. The module exports the resolved top-level `WebToolsSettings` object, injected once at composition time.

  Browser resolution order: `webTools.fetch.browser.executablePath` → playwright `channel: "chrome"` auto-discovery (finds `Google Chrome.app` on macOS) → error naming the settings key.

## Design Decisions

### 1. Local is terminal; Parallel availability is a claim-time concern

The chain is `[github, parallel, local]` on every machine, composed once in `web-tools.ts`. Parallel's `canFetch` returns `false` when `PARALLEL_API_KEY` is unset and `true` otherwise — no conditional array composition, no environment branching in the router. This buys the case branching couldn't: when the key exists but Parallel is down or fails a specific URL, the failure becomes a per-URL attempt and the local fetcher recovers it.

The local fetcher claims `http(s)` URLs only; other schemes go unclaimed and surface in the Failed section. URLs are passed to the browser as-is — no `http`→`https` rewriting; the browser's own upgrade behavior applies.

`search_web` registration in `web-tools.ts` remains gated on the key: without Parallel there is no search backend, and an unregistered tool is more honest than a permanently erroring one.

### 2. Router throw-isolation

`router.ts` currently awaits `fetcher.fetch()` bare; a throwing fetcher kills the whole tool call, including documents already resolved by earlier fetchers. With anything behind Parallel this is untenable — and it is already a latent bug (`getParallelClient()` throws when the key is unset). The router catches fetcher-level throws and folds them into a failed attempt for every URL in that fetcher's claimed batch. "Fallback" is only real because of this.

### 3. `playwright-core` driving the system browser — managed browsers rejected

The driver is playwright (confirmed present in work artifactory), imported as **`playwright-core`** — the package without browser-download machinery. There is no `playwright install`, no browser cache, no download step in any deploy pipeline. The system browser is a hard requirement, provisioned by Ansible like all other software on these machines:

- Personal macOS: `cask "google-chrome"` (already in `ansible/Brewfile`).
- Work macOS: same cask, already present in `ansible/Brewfile.work`.
- OpenClaw (Debian, headless): deferred — not provisioned in this pass. When it is: Debian's `chromium` apt package, `webTools.fetch.browser.executablePath` templated to `/usr/bin/chromium`.

Rationale: every target is Ansible-provisioned and this repo's standing rule is that Ansible owns software installation — a driver-managed browser cache is a second package manager. Branded Chrome is also strictly better for the authenticated-login flow than a bare Chromium build. The accepted risk: Chrome self-updates while `playwright-core` stays pinned, so a protocol-drift breakage window exists across major Chrome bumps; playwright commits to stable-channel support and `poe ts:update-deps` keeps the pin current.

One binary serves both headless and interactive modes. This is not a convenience: a Chrome profile written by one version cannot be safely opened by an older one, so headless and headed must be the same executable.

### 4. Singleton fetch worker over a unix socket

The fetch worker follows the glimpse-companion pattern (`glimpse-companion/companion/connection.ts`), which is proven on every target including work: a standalone TypeScript file spawned as `node fetch-worker.ts` (native type-stripping; node ≥ 22.18 on all targets), detached, `stdio: "ignore"`, listening on a unix socket, speaking newline-delimited JSON. Standalone-process imports name real `.ts` files, per the companion's convention. The socket, pidfile, and spawn lock live under `~/.pi/agent/fetch-worker/` (created `0700`), home-anchored after pi-sessions' broker rather than tmpdir: tmpdir follows `TMPDIR`, so processes launched with divergent environments would resolve different socket paths and spawn duplicate workers contending for the single-instance profile.

Singleton — not a per-session child — for a structural reason: multiple pi sessions run concurrently (glimpse exists because they do), and the persistent profile admits exactly one browser instance. Per-session workers would race `launchPersistentContext` and the losers would fail cold. One worker means the profile lock, the interactive-browser state, and the idle timer live in one place and serve every session. Spawn races are closed with a `wx`-flag spawn lock after pi-sessions' broker (the socket file only exists once the worker calls `listen()`, so during startup a failed connect is indistinguishable from no worker): one session spawns, the rest wait on the connect loop. Within a session, connection establishment is single-flight so a concurrent batch cannot spawn per-URL workers. The worker itself probes the socket at startup and exits if a live worker answers.

Protocol (requests correlated by id; one JSON object per line):

- `{id, op: "fetch", url, downloadDir}` → zero or more `{id, event: "status", stage}` → terminal `{id, event: "result", op: "fetch", finalUrl, file, contentType, bytes, title?}` or `{id, event: "error", reason}`. The worker always writes the payload to `downloadDir` — rendered HTML and raw downloads alike; content bytes never ride the socket. `title` is present for HTML pages, read from the rendered DOM. Result events echo `op` as the discriminant between the two result shapes.
- `{id, op: "open-browser"}` → `{id, event: "result", op: "open-browser"}` or `{id, event: "error", reason}`

Lifecycle: lazy spawn on first local fetch; one idle timer; after 5 minutes without requests the worker closes the browser and exits. The timer is suspended while the interactive browser is open — a login session must never be killed by an idle timer. The next fetch respawns the worker.

The extension side defends against a zombie worker with deadlines of its own: a short connect timeout (with stale-socket cleanup at spawn, companion-style) and a per-request deadline comfortably above the worker's navigation timeout. A request that exceeds its deadline fails that URL, and the extension terminates the suspect worker via the pidfile the worker writes next to its socket, so the next fetch respawns clean instead of queueing behind a hung process.

Concurrency: the worker pools pages (tabs) inside the single persistent context — up to 6 concurrent, requests beyond that queue for a free tab. Sessions multiplex transparently. Page navigation uses a 15-second timeout.

### 5. Minimal worker, contract-shaped extension

The worker's job is exactly URL resolution to a file on disk: rendered HTML written as `page.html`, non-HTML responses streamed under their natural filename (content-disposition, else URL basename), both into the fetcher-provided `downloadDir` and capped at 100MB to match the GitHub fetcher's ceiling. The worker writes as the fetcher's arm — design 01's "fetchers own disk writes" holds, with the pen held one process over, because content over the socket is the worse design at any size. Extraction, excerpt authoring, digest fields, and the `content.md` write happen in the extension-side local fetcher (`local.ts`), which stays shaped like every other source fetcher: for HTML it streams `page.html` into the extractor's stdin (the page never sits in extension memory either), writes `content.md`, and deletes the intermediate; for non-HTML the worker-written file simply becomes the document's body. Two consequences drove this split:

- The extractor seam stays in TypeScript on the extension side, where defuddle can later slot in. (Note for that day: defuddle needs a DOM library in Node, which is itself an import tree the work loader must survive — verify before swapping.)
- The worker's dependency surface is `playwright-core` and nothing else, minimizing the code that runs outside pi's supervision.

Trafilatura runs as a child process — `uvx trafilatura --markdown --formatting` — which is loader-safe (no imports). There is no runner detection at all: pi-web-fetch probed uvx/uv/pipx/pip-run for portability across unknown machines, but this repo's targets are Ansible-provisioned and uv always ships `uvx`. A missing `uvx` is an actionable per-URL failure, not a fallback branch. Empty extraction output fails the URL with a stated reason; there is no raw-HTML fallback body.

### 6. Persistent profile and the interactive-login flow

The profile lives at `~/.pi/agent/browser-profile/` (settings-overridable), isolated from the user's normal browsing profile, starting empty. All fetches run through it, so cookies acquired via interactive login authenticate subsequent headless fetches.

`/open-browser` routes through the worker: close the headless context if running, `launchPersistentContext` again with `headless: false` on the same profile. Because the worker launches both modes, linkage is direct — it holds the context object and receives the `close` event when the browser exits, which resumes the idle timer and headless availability. While the interactive browser is open, every fetch request from every session fails fast with: _"interactive browser is open — quit Chrome to resume fetching."_ The wording matters on macOS, where closing windows does not quit the app or release the profile.

## Edge Cases & Failure Modes

- **No system browser installed / discovery fails:** local fetch fails with a reason naming `webTools.fetch.browser.executablePath`; other fetchers' documents are unaffected (Decision 2).
- **Parallel key present but service down:** Parallel's claimed URLs fail per-URL; local recovers them; the recovered attempt trail is visible in `details` only.
- **Interactive browser open:** all fetches fail fast with the quit instruction; no queueing behind a login session of unbounded length.
- **User closes Chrome windows but not the app (macOS):** profile stays locked; the error text already instructs a full quit.
- **Worker crashes mid-batch:** in-flight requests error; the batch's claimed URLs become failed attempts; the next fetch respawns the worker. A stale socket file from a killed worker is detected and cleaned at spawn, companion-style.
- **Two sessions spawn the worker simultaneously:** socket bind race; the loser connects to the winner.
- **Page load exceeds 15s / navigation error:** per-URL failure with the driver's reason.
- **Zombie worker (socket connects, requests hang):** the per-request deadline fails the URL; the extension terminates the worker via its pidfile; the next fetch respawns clean.
- **Navigation yields non-HTML (PDF, download):** delivered as `local.file` — raw bytes on disk, no excerpt, content type and size in the facts. Chrome's PDF viewer swallows the original response, so the worker refetches the bytes through the context's request client (same cookies, no renderer).
- **Response with no usable content-type header (e.g. service-worker-served navigations):** routing trusts `document.contentType` — the MIME type the renderer committed to — over the response header, which is set at the whims of the delivery mechanism.
- **Non-HTML response exceeds the 100MB cap:** per-URL failure with the size in the reason, matching the GitHub fetcher's ceiling.
- **Trafilatura extracts nothing:** per-URL failure ("no content extracted"), not an empty document.
- **`/open-browser` on headless OpenClaw:** the headed launch fails (no display); the error surfaces to the user. Acceptable — logins happen on machines with screens.
- **Chrome major-version bump breaks pinned playwright-core:** local fetches fail with driver errors until `poe ts:update-deps` refreshes the pin; GitHub and Parallel paths unaffected.
- **Non-http(s) scheme:** unclaimed by every fetcher; appears in the Failed section.

## Alternatives

### Branch fetcher composition on key presence

- **Status:** Rejected (superseded during design)
- **Decision or open issue:** The first-draft shape — `[github, parallel]` with a key, `[github, local]` without — encodes availability in composition, so a Parallel outage with a key present still dead-ends. Expressing availability in `canFetch` gets the same no-key behavior plus per-URL outage recovery, with no branching.

### Managed playwright browsers (`playwright install`)

- **Status:** Rejected
- **Decision or open issue:** A version-locked Chromium and independence from system software are the benefits; neither matters when every target is Ansible-provisioned, and both cost a CDN download step (unverified inside the work perimeter), a browser cache outside package management, and a bare Chromium that looks like an automation harness to login flows.

### Puppeteer

- **Status:** Rejected
- **Decision or open issue:** The fork's `fetch-worker.mjs` and pi-web-fetch's `browser-pool.ts` would port nearly verbatim, and puppeteer has proof-of-life at work. Playwright won on merits once artifactory presence was confirmed: `launchPersistentContext` is first-class (one call for profile + context — the heart of this design), and `channel: "chrome"` makes the system-browser requirement declarative instead of path-probing.

### Force-local URL patterns

- **Status:** Open (deferred feature)
- **Decision or open issue:** A settings list of URL patterns (`webTools.fetch.forceLocal`; exact key TBD now that browser config lives under `fetch.browser`) whose matches skip the line entirely and go straight to the local fetcher — for private or auth-gated URLs where the persistent profile holds the auth. Mechanism: a composition-time wrapper declines matching URLs on every fetcher ahead of local; no router change. The privacy property is structural: matched URLs are never sent to Parallel's API at all.
- **Next step:** Implement after the initial rollout proves the local path; needs the settings field and the declining wrapper in `web-tools.ts` composition.

### Defuddle as the extractor

- **Status:** Open
- **Decision or open issue:** Preferred on fit — TypeScript-native, in-process, markdown output, and its "more forgiving" extraction bias is right for always-materialize (recall beats precision when content lands on disk for grepping). Blocked: not approved in work artifactory.
- **Retained discussion:** The extractor seam exists specifically so this swap is one module. Defuddle in Node needs a DOM library (linkedom/jsdom), whose import tree must survive the work loader — verify alongside artifactory approval.
- **Next step:** When defuddle clears artifactory, implement it behind the seam and compare output on a fixed URL set before switching the default.

### Extraction inside the worker

- **Status:** Rejected
- **Decision or open issue:** A `url → markdown` worker would keep the extension filesystem-adjacent code smaller, but it moves the extractor seam into the one process that should stay minimal, and couples the defuddle swap to worker deployment. The worker stays browser-only.

### Per-session worker child process

- **Status:** Rejected
- **Decision or open issue:** Simpler spawn model, but concurrent pi sessions would race for the single-instance profile. The singleton socket model has direct house precedent (glimpse-companion) and centralizes profile-lock semantics.

### pi-web-fetch subsystems: hook system, LLM sub-agent, 15-minute cache, inline delivery

- **Status:** Rejected
- **Decision or open issue:** The hook system duplicates the router's per-source dispatch (its flagship GitHub-redirect hook is obsolete against the native GitHub fetcher). The LLM sub-agent and inline delivery contradict design 01's ratified decisions (single-completion summaries rejected; never inline). The cache served a re-prompt workflow that always-materialize replaces with stable artifacts.

## Implementation Plan

- [x] Phase 1: Router throw-isolation and claim-time Parallel availability
  - Goal: The cascade survives a throwing fetcher; a missing `PARALLEL_API_KEY` produces clean per-URL failures instead of killing the tool call; `search_web` is not registered without the key. Independently shippable — on a keyless machine, `fetch_web` degrades to GitHub-only with honest Failed entries rather than crashing.
  - Files: `router.ts`, `fetchers/parallel.ts`, `web-tools.ts`.
  - Work: Wrap `fetcher.fetch()` in the router; a throw becomes a `FailedAttempt` for every URL in that fetcher's claimed batch. Parallel's `canFetch` returns key presence. `web-tools.ts` registers `search_web` only when the key is set.
  - Validation: `uv run poe lint:pi`. Smoke with `PARALLEL_API_KEY` unset: a GitHub URL resolves normally; a plain web URL lands in the Failed section with a `parallel` attempt absent (unclaimed) and no crash; with the key set, behavior is unchanged.

- [x] Phase 2: Settings module, fetch worker, and the headless local fetcher
  - Goal: The `[github, parallel, local]` chain works end to end headless: any web page becomes a `local.page` with `content.md`, any non-HTML response a `local.file`, on system Chrome, with the worker's full lifecycle (lazy spawn, idle exit, zombie defense).
  - Files: `settings.ts` (new), `fetchers/local/fetch-worker.ts` (new), `fetchers/local/worker-connection.ts` (new), `fetchers/local/local.ts` (new), `fetchers/local/local-extractor.ts` (new), `web-tools.ts`, `package.json` / `package-lock.json` (`playwright-core`).
  - Work: Settings module on the pi-librarian pattern (`webTools.fetch.browser.{executablePath, profileDir}`). Worker: unix socket server + pidfile + stale-socket cleanup, browser resolution (settings → `channel: "chrome"` → error), `launchPersistentContext`, 6-tab pool with queueing, 15s navigation timeout, HTML→`page.html` / non-HTML→natural filename into `downloadDir`, 100MB cap, 5-minute idle exit. Connection client: companion-style spawn (`node fetch-worker.ts`, detached, `stdio: "ignore"`), cross-session spawn lock, connect timeout, per-request deadline, pidfile termination of hung workers. Local fetcher: claims http(s), per-document `downloadDir`, streams `page.html` into `uvx trafilatura --markdown --formatting` stdin via the extractor seam, writes `content.md`, deletes the intermediate, authors head excerpt; `local.file` passthrough with content-type/size facts. Compose the chain in `web-tools.ts`; extend the tool description to mention local rendering.
  - Validation: `uv run poe lint:pi`. Smoke on a personal Mac: JS-rendered page → clean `content.md`; direct PDF URL → raw `local.file` on disk; unreachable URL → failure with reason; `PARALLEL_API_KEY` unset → local catches what GitHub doesn't claim; 8-URL batch shows queueing past 6 tabs; second concurrent pi session multiplexes onto the same worker; worker exits after idle (shorten the timer temporarily to observe).

- [x] Phase 3: Interactive login
  - Goal: Fork parity — `/open-browser`, profile-lock semantics, idle-timer suspension during login.
  - Files: `fetchers/local/fetch-worker.ts`, `fetchers/local/worker-connection.ts`, `web-tools.ts` (command registration).
  - Work: `open-browser` op: close the headless context, relaunch headed on the same profile, resume on the context `close` event; all fetch requests error with the quit instruction while it is open; idle timer suspended. Register the `/open-browser` pi command with user-facing feedback.
  - Validation: Manual: `/open-browser`, log into a cookie-gated site, quit the browser, headless fetch of the same site returns authenticated content; fetching while the browser is open fails fast with the quit message from a _different_ pi session too.

- [ ] Phase 4: Rollout
  - Goal: The work machine is fully served and the fork is retired; personal machines gain the fallback with zero settings.
  - Files: `chezmoi/private_dot_pi/agent/settings.json.tmpl` (remove `~/code/pi-web-fetch` from work packages; add a `webTools` block only if Chrome discovery misses).
  - Work: Remove the fork package entry (the google-chrome cask turned out to already be in `ansible/Brewfile.work`); confirm `playwright-core` resolves through work artifactory under the `--omit=dev` install path.
  - Validation: `uv run poe cz-diff` before applying. On the work machine: apply, start pi, fetch an auth-gated internal URL end to end. OpenClaw is explicitly out of scope (Non-Goals).
