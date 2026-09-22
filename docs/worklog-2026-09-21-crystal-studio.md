# Worklog — Crystal Studio rich outputs (2026-09-21/22)

Branch: `feature/crystal-studio`. Scope: Rich Outputs plan plus the source-level parts of Cutover.
No version bump, tag, publish or install was performed.

## Changed owners

| Fact | Owner | Lifetime |
| --- | --- | --- |
| Native generated image | `session/store.ts` `native_image` shard, keyed by provider message + asset | Session history |
| Image set projection | `shared/chronology.ts::imageSetsForTimeline` | Derived per read |
| Human download batch | `src/main/generated-asset-downloads.ts` | Process memory, bounded |
| Download terminal receipt | Extension `generatedAssetResults` in `storage.local` | Survives browser restart |
| Original transfer | `src/main/generated-assets.ts` chunk transfers | One wait, 120 s bound |
| Agent asset handle | `src/main/generated-assets.ts` opaque handle map | 15 min, 256 handles |
| Static artifact | `shared/static-artifact.ts` sanitizer, `renderer/static-artifact.ts` sandboxed iframe | Per render |
| Rich action status | `src/main/rich-actions.ts` | Session-owned |

## Behaviors added

- Human `Download original` / `Download all originals` for one asset or a whole multi-image response,
  through Chrome's own downloader, with five truthful states: requested, started, complete, failed,
  unconfirmed.
- A batch offer exists only while exactly one live Chrome document is proven for that conversation.
  An ambiguous or truncated document report produces no offer.
- Core `generated_assets` `list`/`save`: one opaque handle per canonical asset, preview save through
  the existing session asset reader, original save through companion-streamed offset-checked chunks.
- Static artifact rendering stays scriptless, networkless and sandboxed; unsupported native controls
  remain inert.

## Verification actually performed

| Level | Evidence |
| --- | --- |
| Source tests | `test/generated-asset-downloads.test.ts`, `test/generated-assets.test.ts`, `test/extension.test.ts`, `test/bridge.test.ts`, `test/content-script.test.ts`, `test/rich-image.test.ts`, `test/preload-images.test.ts`, `test/sidebar-resize.test.ts`, `test/backend-recording.test.ts` pass. |
| Typecheck | `npm run typecheck` passes. |
| Full suite | `npm test -- --run`: 236 files passed, 13 skipped; 6,089 tests passed, 136 skipped, 0 failed. |
| Privacy | `npm run verify:privacy` exits 0 (350 commits, 16 tags). |
| Notices | `npm run verify:notices` exits 0 (157 production packages, 7 catalog entries, 731 pinned native sources). |
| Build | `npm run build` exits 0; renderer and main bundles emit. |
| Electron | `verify-crystal-rich-outputs.cjs`, `verify-crystal-accessibility.cjs`, `verify-crystal-performance.cjs`, `verify-crystal-shell.cjs`, `verify-crystal-workspace.cjs`, `verify-chat-width.cjs`, `verify-history-scroll.cjs`, `verify-composer-layout.cjs` all exit 0. |
| Package / installed payload | `npm run dist` was run for Linux; see the ledger for its output. Nothing was installed or published. |
| Signed-in ChatGPT | **Not run.** No signed-in session or companion was available. Live choice mutation, live download, live original save and live multi-image generation remain unverified. |

## Known unsupported or unverified

- Native rich controls (radio, checkbox, select, Continue) remain inert. No selector is inferred.
- Rich action dispatch and Retry Capture remain unavailable; the status ledger is read-only.
- The provider original save path is source- and Electron-verified only; it has never fetched a real
  signed image from a signed-in page.
- `free image storage`, canonical cleanup tombstones and session deletion keep their existing owners;
  this worklog makes no claim about live cleanup behavior.

## Design spec status

`docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`: **In implementation**.
It moves to Implemented only after Cutover Task 4 and signed-in acceptance succeed.
