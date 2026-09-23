# ChatBBC 2.1.20 release, 2026-09-23

Release branch: `release-2.1.20`, based on merged PR #10 at `17ab1b9`.

## Scope

- Bump the app and companion from 2.1.19 to 2.1.20. Bridge protocol stays 17.
- Document Crystal Studio, response-owned galleries, generated-image download/save, and
  the selected-chat Save preview fence.
- Publish only through the tag-scoped `publish.yml` workflow.
- Do not arm production `begin`/`elect`/`arm`. Do not install or mutate live userData.

## Local verification

Passed on the merged feature tree immediately before this version bump:

- `npm run verify` EXIT0: privacy 352 commits / 16 tags; notices 159 packages, 7 catalog
  entries, 731 native sources; typecheck passed; 235 files / 6,114 tests passed
  (13 files / 136 skipped); shutdown 6/6.
- `npm run build` EXIT0.
- `npm run dist` EXIT0 for Linux x64 and arm64. x64 packaged-runtime smoke decoded PNG/WebP
  and ran node-pty/tree-sitter. Arm64 resource smoke passed; native execution was skipped
  on the x64 host.
- `node scripts/verify-crystal-rich-outputs.cjs` EXIT0 and did not claim signed-in acceptance.

The version bump is metadata and documentation. After the bump:

- Release metadata assertion: `package.json`, both root lockfile versions,
  `extension/manifest.json`, and `APP_VERSION` all equal `2.1.20`; the top changelog
  entry is 2.1.20; release notes title is `Crystal Studio`; bridge protocol stays 17.
- `npm run verify:tunnel-current`: pinned tunnel-client `v0.0.14` matches OpenAI's current
  release.
- `node scripts/check-release-absent.mjs` with `GITHUB_REPOSITORY=TheBigBrainChad/chatbbc`
  and tag `v2.1.20`: release does not exist.
- Focused version-agreement tests in `test/extension.test.ts` and `test/packaging.test.ts`:
  2 passed / 287 skipped.
- `git diff --check` EXIT0.

## Publication evidence

Pending the release PR, `v2.1.20` tag, tag-scoped `publish.yml` run, and public artifact
inspection. Signed-in provider acceptance was not run.
