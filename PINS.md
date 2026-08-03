# Downgrade pins

`main` plus pins for environments whose registry mirror lags npm. Install with `pi install git:github.com/thurstonsand/pi-web-tools@downgrade`; everywhere else use `npm:@thurstonsand/pi-web-tools` at latest.

| Package                  | Pinned    | `main` wants                     | Pinned on  | Recheck after |
| ------------------------ | --------- | -------------------------------- | ---------- | ------------- |
| `playwright-core`        | `1.63.0`  | `^1.61.0`, resolving to `1.63.0` | 2026-10-04 | 2026-12-04    |
| `@octokit/core`          | `7.0.7`   | `7.0.8`, via `@octokit/rest`     | 2026-10-04 | 2026-12-04    |
| `@octokit/graphql`       | `9.0.4`   | `9.0.5`, via `@octokit/core`     | 2026-10-04 | 2026-12-04    |
| `@octokit/request`       | `10.0.13` | `10.0.16`, via `@octokit/core`   | 2026-10-04 | 2026-12-04    |
| `@octokit/request-error` | `7.1.1`   | `7.1.2`, via `@octokit/core`     | 2026-10-04 | 2026-12-04    |
| `@octokit/endpoint`      | `11.0.4`  | `11.0.5`, via `@octokit/request` | 2026-10-04 | 2026-12-04    |
| `json-with-bigint`       | `3.5.11`  | `3.5.12`, via `@octokit/request` | 2026-10-04 | 2026-12-04    |
