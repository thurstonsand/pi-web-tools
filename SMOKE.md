# Smoke test

Run Pi against the dev checkout:

```sh
pi -e /Users/thurstonsand/Develop/pi-web-tools/extensions/web-tools.ts
```

Checklist:

- `web_fetch` a GitHub README URL.
- `web_fetch` a GitHub file URL.
- `web_fetch` a GitHub directory URL.
- `web_fetch` a GitHub issue URL.
- `web_fetch` a GitHub pull request URL.
- `web_fetch` `https://github.com/{owner}/{repo}/issues` and confirm an open issue listing.
- `web_fetch` `https://github.com/{owner}/{repo}/pulls?q=is:merged` and confirm a merged PR listing.
- `web_fetch` an issue search with full-text `?q=`.
- `web_fetch` a listing with `sort:created-asc` in `?q=` and confirm ascending order.
- `web_fetch` a zero-match issue search and confirm a valid `0 matches` document.
- `web_fetch` an invalid GitHub issue query and confirm the failure trail falls through.
- `web_search` a current web query.
- `web_fetch` a non-GitHub page through Parallel.
- With Parallel unavailable, fetch a non-GitHub page through the local browser fallback.
- With Parallel unavailable, fetch a docs page with code (e.g. Cloudflare Workers secrets) locally and confirm fenced, language-tagged code blocks in `content.md`.
- With Parallel unavailable, fetch an MDN reference page locally and confirm its example code blocks survive (shadow piercing).
- With Parallel unavailable, fetch `https://www.npmjs.com/package/turndown` on a cold profile and confirm it succeeds headless without a visible browser window.
- With `webTools.fetch.challenge.escalation: "never"` and a page that keeps challenging, confirm the per-URL failure names the bot wall and points at `/browser open`.
- Send more than six local URLs in one batch and confirm only six report `started` before a page slot is released; all results complete.
- Keep a worker connection open for at least 10 seconds and confirm heartbeats arrive about every 5 seconds.
- `/browser restart` waits for the old worker to exit; the next fetch respawns it with current settings and a different PID.
