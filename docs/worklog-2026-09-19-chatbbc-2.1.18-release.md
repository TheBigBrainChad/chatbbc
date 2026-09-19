# ChatBBC 2.1.18 release, 2026-09-19

Release branch: `release-2.1.18`, based on merged PR #5 at `8b7d75b`.

## Scope

- Bump the app and companion from 2.1.17 to 2.1.18 without changing bridge protocol 15.
- Move the upstream reliability catch-up out of the already-published 2.1.17 changelog section.
- Add reviewed release notes for the response identity, queue/Continue custody, browser control, compaction receipt, worker wake, journal deadline, screenshot, and GVDB source-mirror changes.
- Publish only through the tag-scoped `publish.yml` workflow.

## Local verification

Passed on the release candidate:

- Release metadata assertion: `package.json`, both root lockfile versions, `extension/manifest.json`, and `APP_VERSION` all equal `2.1.18`; the top changelog entry is 2.1.18 and release notes contain a publishable `##` title.
- `npm run verify:tunnel-current`: pinned tunnel-client `v0.0.14` matches OpenAI's current release.
- `node scripts/check-release-absent.mjs` with repository/tag credentials: release `v2.1.18` does not exist.
- `npm run verify`: privacy, notices, typecheck, 220 test files / 5,361 tests, and the isolated 6-test shutdown suite passed; 13 files / 136 tests were skipped by their declared platform/runtime conditions.
- `npm run build`: main, preload, and renderer bundles completed.

## Publication evidence

Pending the reviewed release PR, `v2.1.18` tag, tag-scoped `publish.yml` run, and public artifact inspection.
