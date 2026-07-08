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
