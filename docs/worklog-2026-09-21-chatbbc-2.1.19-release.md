# ChatBBC 2.1.19 release, 2026-09-21

Release branch: `release-2.1.19`, based on merged PR #8 at `a4ecdb3`.

## Scope

- Bump the app and companion from 2.1.18 to 2.1.19. Bridge protocol stays 17.
- Document bounded rich capture, PAGE recapture, Recording Off observation fences,
  inert native actions, Linux ALSA order, and the tracked GVDB archive.
- Publish only through the tag-scoped `publish.yml` workflow.
- Do not arm production `begin`/`elect`/`arm`. Do not install or mutate live userData.

## Local verification

Passed on the release candidate:

- Release metadata assertion: `package.json`, both root lockfile versions, `extension/manifest.json`, and `APP_VERSION` all equal `2.1.19`; the top changelog entry is 2.1.19; release notes title is `Bounded rich capture`.
- Identity: `APP_TITLE = ChatBBC`, `APP_SLUG = chatbbc`, `BRIDGE_PROTOCOL = 17`.
- `npm run verify:tunnel-current`: pinned tunnel-client `v0.0.14` matches OpenAI's current release.
- `node scripts/check-release-absent.mjs` with `GITHUB_REPOSITORY=TheBigBrainChad/chatbbc` and tag `v2.1.19`: release does not exist.
- `TMPDIR=.tmp-verify-2.1.19 env -u APPIMAGE npm run verify` EXIT0 (log `2026-09-21-2.1.19-full-verify.log`): privacy 281 commits / 15 tags; notices 157 packages / 7 catalog / 731 pinned; typecheck passed. Main **230 files / 5,922 tests** passed (13 files / 136 tests skipped). Shutdown **6/6**.
- `env -u APPIMAGE npm run build` EXIT0 (log `2026-09-21-2.1.19-source-build.log`).
- Focused version-agreement tests in `test/extension.test.ts` and `test/packaging.test.ts`: 2 passed / 278 skipped.
- `git diff --check` EXIT0.

## Publication evidence

Pending the reviewed release PR, `v2.1.19` tag, tag-scoped `publish.yml` run, and public artifact inspection.
