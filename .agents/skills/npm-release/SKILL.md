---
name: npm-release
description: Prepare, tag, publish, and verify an npm release for this repo. Use when the user wants to release pi-web-tools to npm.
---

# npm Release

Use this skill when preparing and publishing a new release for `pi-web-tools`.

## Release model

- Release from `main`.
- npm publishing is tag-driven through `.github/workflows/release.yml`.
- Use `CHANGELOG.md` for human release notes.
- Use the exact same release-note text from `CHANGELOG.md` for the annotated git tag body.
- Stable releases are `vX.Y.Z` tags.
- Stable package tags are immutable. Never force-push a stable release tag.
- The GitHub Action uses npm Trusted Publishing through OIDC.
- The `downgrade` branch tracks `main` with specific downgrades needed for a limited environment.

## 1. Inspect release state

- Check the current git state before touching anything. If the working tree has unrelated changes, leave them alone. If release-relevant changes are uncommitted, ask whether they belong in the release before proceeding.
- Inspect changes since the latest stable tag
- Summarize:
  - user-facing features and fixes
  - package, install, or release changes
  - API changes
  - documentation updates
  - likely semver bump: patch, minor, or major

Ask the user to confirm the target version unless they already specified it.

## 2. Prepare release notes

Update `CHANGELOG.md` with a new top entry:

```md
## X.Y.Z

Short release summary.

### Added

- User-facing change.

### Changed

- Package or install change.

### Fixed

- User-facing fix.
```

Omit empty sections. Do not list every internal refactor. If the user edits the notes, preserve their wording.

If release mechanics change, update `docs/release.md`.

## 3. Verify locally

Run the full gate and inspect package contents:

```sh
mise run check
npm pack --dry-run
```

Do not proceed on failures. Fix them or report the blocker.

## 4. Commit release prep

Stage only release-relevant files and commit.

If hooks modify staged files, the commit will fail, ensure the hook is resolved then recommit.

## 5. Push main

Push the release prep commit to `main`

## 6. Create and push the stable tag

Use the final `CHANGELOG.md` entry for the tag notes:

```sh
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/pi-web-tools-v${VERSION}-notes.md"
cat "/tmp/pi-web-tools-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/pi-web-tools-v${VERSION}-notes.md"
git push origin "v${VERSION}"
```

Do not force-push a stable tag. If a tag already exists, stop and inspect; do not overwrite it.

## 7. Watch GitHub Actions publishing

The tag should trigger the Release workflow.

- Use the `gh` tool to find the release (`gh run list --workflow Release`)
- Watch the release action to completion
- The workflow should run CI, set the package version from the tag, and publish to npm with the `latest` dist-tag.
- If there is an error, inform the user what went wrong, including a proposed fix when feasible.

## 8. Final verification

Confirm npm and git remote state:

```sh
VERSION=X.Y.Z
npm view @thurstonsand/pi-web-tools version dist-tags --json
git ls-remote --tags origin "v${VERSION}"
git status --short
```

## 9. Rebase the `downgrade` branch

The constrained environment installs this package with `pi install git:github.com/thurstonsand/pi-web-tools@downgrade`, and `pi update` hard-resets that clone to the branch tip. The branch must therefore carry the release, or that install stays on the previous version.

Find where the branch is checked out with `git worktree list`. If nothing has it, ask the user how to proceed rather than choosing for them — create a worktree, and where, or switch the main worktree to the branch and back afterward.

```sh
git fetch origin
git rebase "v${VERSION}"
git push --force-with-lease origin downgrade
```

Force-pushing is correct here. Pi resets rather than pulls, so rewritten history costs the downstream install nothing.

For the same reason, the branch keeps a single pin commit on top of `main`. Amend it when pins change instead of stacking new commits — the history is rewritten at every release anyway, and a flat branch makes the diff against `main` the whole story.

The branch diverges from `main` in `package-lock.json`, and in `package.json` wherever a pin needs it — a transitive pin needs an `overrides` entry, and a direct pin needs a narrowed range once `main`'s range stops admitting the pinned version. Never merge a lockfile conflict by hand — take the release side, then re-apply every pin listed in `PINS.md` and confirm with `npm ls` before pushing.

### Check pin freshness

Read `PINS.md` on the `downgrade` branch. Confirm each row's `main` wants column still describes what the release actually resolves to — it drifts every time a range or a transitive resolution moves, and a stale column hides the fact that a pin is now doing more work than it was meant to.

Then check the `recheck after` dates. If any have passed, do not silently rebase past them — report which pins are due, so the user can retest the unpinned version in the constrained environment with `npm view <pkg> versions` against the mirror. They either drop the pin or renew it.

Set `recheck after` two months out whenever a pin is added or renewed. Long enough that it does not nag at every release, short enough that a mirror catching up gets noticed while the version gap is still small.

## 10. Final report

Final report should include:

- npm version published
- release commit hash and tag
- workflow watched and whether it passed
- verification status
- `downgrade` branch rebased and pushed, plus any pins now due for recheck
- any follow-up work or issues encountered
