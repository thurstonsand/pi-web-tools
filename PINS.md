# Downgrade pins

`main` plus pins for environments whose registry mirror lags npm. Install with `pi install git:github.com/thurstonsand/pi-web-tools@downgrade`; everywhere else use `npm:@thurstonsand/pi-web-tools` at latest.

| Package                  | Pinned     | `main` wants                     | Pinned on  | Recheck after |
| ------------------------ | ---------- | -------------------------------- | ---------- | ------------- |
| `playwright-core`        | `1.61.1`   | `^1.61.0`, resolving to `1.62.1` | 2026-08-03 | 2026-10-03    |
| `@octokit/core`          | `7.0.6`    | `7.0.7`, via `@octokit/rest`     | 2026-08-03 | 2026-10-03    |
| `@octokit/graphql`       | `9.0.3`    | `9.0.4`, via `@octokit/core`     | 2026-08-03 | 2026-10-03    |
| `@octokit/request`       | `10.0.11`  | `10.0.13`, via `@octokit/core`   | 2026-08-03 | 2026-10-03    |
| `@octokit/request-error` | `7.1.0`    | `7.1.1`, via `@octokit/core`     | 2026-08-03 | 2026-10-03    |
| `@octokit/endpoint`      | `11.0.3`   | `11.0.4`, via `@octokit/request` | 2026-08-04 | 2026-10-04    |
