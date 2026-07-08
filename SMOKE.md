# Smoke test

Run Pi against the dev checkout:

```sh
pi -e /Users/thurstonsand/Develop/pi-web-tools/extensions/web-tools.ts
```

Checklist:

- `fetch_web` a GitHub README URL.
- `fetch_web` a GitHub file URL.
- `fetch_web` a GitHub directory URL.
- `fetch_web` a GitHub issue URL.
- `fetch_web` a GitHub pull request URL.
- `fetch_web` `https://github.com/{owner}/{repo}/issues` and confirm an open issue listing.
- `fetch_web` `https://github.com/{owner}/{repo}/pulls?q=is:merged` and confirm a merged PR listing.
- `fetch_web` an issue search with full-text `?q=`.
- `fetch_web` a listing with `sort:created-asc` in `?q=` and confirm ascending order.
- `fetch_web` a zero-match issue search and confirm a valid `0 matches` document.
- `fetch_web` an invalid GitHub issue query and confirm the failure trail falls through.
- `search_web` a current web query.
- `fetch_web` a non-GitHub page through Parallel.
- With Parallel unavailable, fetch a non-GitHub page through the local browser fallback.
