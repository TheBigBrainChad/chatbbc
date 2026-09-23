# Worklog — Crystal Studio Rich Outputs and Cutover (2026-09-21–23)

Branch: `feature/crystal-studio`. Scope: Rich Outputs, renderer Cutover and Linux package evidence.
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
| Source tests | Focused nine-file Rich Outputs run: 1,693 passed. Download/renderer late-receipt regressions: 34 passed; generated-asset save: 10 passed. Rich lifecycle four-file run: 91 passed. Cutover renderer and declaration suites also passed. |
| Typecheck | `npm run typecheck` exits 0 for the current source. |
| Full suite | `npm test -- --run`: 236 files passed, 13 skipped; 6,100 tests passed, 136 skipped, 0 failed. |
| Privacy | `npm run verify:privacy` exits 0 (352 commits, 16 tags). |
| Notices | `npm run verify:notices` exits 0 (159 production packages, 7 catalog entries, 731 pinned native sources and patches). |
| Build | `npm run build` exits 0; current renderer and main bundles emit. |
| Electron | `verify-crystal-glass.cjs`, `verify-crystal-rich-outputs.cjs`, `verify-crystal-accessibility.cjs`, `verify-crystal-performance.cjs`, `verify-crystal-shell.cjs`, `verify-crystal-workspace.cjs`, `verify-chat-width.cjs`, `verify-history-scroll.cjs`, `verify-composer-layout.cjs` exit 0. Glass fixture deliberately crashes two renderers and checks readable backing; Wayland Viz pixel capture and compositor blur were not available. |
| Live Omarchy / dev Electron | Launched `out/main/index.js` with disposable `XDG_CONFIG_HOME` and bridge ports disabled; in the actual app enabled Follow this desktop. With desktop `Lumon`, observed `data-theme=dark`, sidebar `#1b2d40`, accent `#8bc9eb`, `glass=hyprland-blur`; after `omarchy theme set 'Flexoki Light'`, the same live document changed to `data-theme=light`, sidebar `#E6E4D9`, accent `#205ea6`, while manual HEX fields retained their saved dark values. Screenshots confirmed readable dark and light surfaces. Restored `Lumon` and observed the original dark tokens again. CDP page pixels and `glass` mode do not prove the native compositor blurred pixels behind the window. |
| Package / installed payload | Current `npm run dist` exits 0 for Linux x64 and arm64 (AppImage and DEB per arch). `smoke-packaged-runtime.mjs --platform linux --arch x64` decodes PNG/WebP and exercises node-pty/tree-sitter; arm64 resource smoke passes without native execution on x64. Both packaged extension background files hash-match source; x64 asar main contains the current crash handler, bounded download retention and generated-asset save errors; renderer contains the live Appearance and download controls. Nothing was installed or published. |
| Signed-in ChatGPT | **Not run.** Prior managed page showed Log in; current relay attach timed out. Live choice mutation, real original pixel fidelity, browser download completion, original save and live multi-image generation remain unverified. |

## Post-review safety corrections (2026-09-23)

- Claimed downloads now become `unconfirmed` after 15 minutes without a terminal receipt or
  live browser custody; a current custody report extends that deadline without creating a new
  browser action. The first regression failed before the fix and passed after. An exact live
  report at the elapsed deadline is checked before expiry.
- Generated-asset saves use Create permission and a new destination only. Existing paths are
  refused, including when Edit is enabled. A staged file is linked into place atomically with
  no replacement; `EEXIST` reports `DESTINATION_CHANGED`. This is narrower than replacing an
  unchanged destination, because Node's ordinary rename cannot atomically compare its revision
  and preserve an external writer's later change. The regression for a file created exactly
  at publication failed before the fix and passed afterward.
- Save publication rechecks current approved roots, Create permission and the session binding
  after asynchronous preparation. A transfer that crosses a durable A→B rebind formerly
  published bytes; its new fail-first regression now refuses that stale handle.
- The rich-media recapture test had assumed that a pending pixel receipt implied an available
  receipt had already entered the page-local queue. The corrected test waits for available,
  then retains a Fiber reply listener until a second distinct available capture is observed.
  The isolated `test/content-script.test.ts` run passed (757 tests).
- Focused `test/generated-assets.test.ts` passed (9 tests) after the new binding fence.
  A combined nine-file source run before the recapture test correction had one failure in that
  test (line 1936); no post-correction full-suite or package result is claimed by this row.

### Second review and renderer-loss ruling

- A later receipt review found two further races. A burst of 64 silent claims now retains
  those exact tokens in a separate bounded 64-batch terminal allowance while new requests
  reclaim active capacity. A late old-batch receipt corrects its own batch but cannot replace
  a newer retry's asset state in the renderer. Both behavioral regressions failed before and
  passed after correction; `test/generated-asset-downloads.test.ts` and
  `test/rich-image.test.ts` passed together (34 tests).
- A save on an approved filesystem without hard links cannot simultaneously promise atomic
  publication and no replacement through Node's file APIs. `destination_unsupported` now
  identifies that refusal; no partial destination is created. The unsupported-link regression
  failed before the diagnostic and `test/generated-assets.test.ts` passed afterward (10 tests).
  This is a filesystem limitation, not an implicit grant to overwrite or expose partial bytes.
- Electron Wayland compositor disconnection exits Chromium; it does not leave a recoverable
  transparent BrowserWindow. A renderer crash *is* observable without a navigation event.
  The glass fixture first failed on a transparent backing after a deliberate renderer crash.
  Main now restores a readable backing on `render-process-gone`, fenced to the owning window.
  The fixture and main use the same registration function; a missing function failed before
  integration. The isolated fixture cannot prove a live Hyprland blur rule, provider flow
  or installed application. The post-integration rerun passed both glass modes, first paint,
  reload, renderer loss, hit testing and zero layout delta. Wayland Viz pixel capture was
  unavailable, so this is native backing/DOM/geometry evidence rather than captured pixels.
- Current focused source run (11 files): 1,853 passed, 36 skipped before these second-review
  corrections. `npm run typecheck`, `verify:privacy` (352 commits, 16 tags), and
  `verify:notices` (159 production packages, seven catalog entries, 731 native source
  archives and patches) exited 0 after the documentation and custody edits.
- The production-module `verify-crystal-rich-outputs.cjs` fixture exited 0 and explicitly
  reported signed-in choice/download/save acceptance not run. `verify-crystal-accessibility.cjs`
  exited 0 for shell/stage, keyboard semantics, labels, reduced motion and 360px layout.

## Known unsupported or unverified

- Native rich controls (radio, checkbox, select, Continue) remain inert. No selector is inferred.
- Rich action dispatch and Retry Capture remain unavailable; the status ledger is read-only.
- The provider original save path is source- and Electron-verified only; it has never fetched a real
  signed image from a signed-in page.
- Native compositor blur and installed-app GUI acceptance remain unverified; the live
  theme switch above exercised the development app, not an installed payload.
- `free image storage`, canonical cleanup tombstones and session deletion keep their existing owners;
  this worklog makes no claim about live cleanup behavior.

## Stopped on request (2026-09-23)

HEAD remains `73871df`. The working tree is dirty; `.tmp/` is unrelated scratch. Nothing was
committed, installed, tagged, or published.

Verified before this stop: `npm run verify:ci` exited 0 (235 files / 6,094 tests passed, plus
the separate shutdown suite). Linux x64/arm64 packages and packaged-runtime smoke passed.
A disposable development Electron window followed Omarchy from `Lumon` (dark, sidebar
`#1b2d40`) to `Flexoki Light` (light, sidebar `#E6E4D9`) and back. Native compositor blur and
installed-app GUI were not proven. Signed-in ChatGPT acceptance was not run.

A final review then found five defects. Uncommitted edits exist for preview WebP filenames,
human preview save helpers, bounded renderer download history, explicit selection above 20
images, and durable download-receipt IDs in extension status. Those edits are not validated.
`sessions:saveGeneratedAssetPreviews` is called by preload/renderer but has no handler in
`src/main/ipc.ts`, so the visible Save preview path is not complete. A later continuation
confirmed that absence and stopped again before adding the handler. No additional validation
was run. Do not merge.

## Resumed implementation and whole-branch review (2026-09-23)

The stopped snapshot above is historical. The missing `sessions:saveGeneratedAssetPreviews`
handler is now wired to the current-main-frame selection witness, canonical image-set membership,
the human Save As/folder picker and the existing no-replace WebP writer. Single-image and
multi-image IPC tests exercise actual saved bytes; cancellation, foreign senders, noncanonical
assets and an A→B→A selection race remain negative cases. The extension's status includes
terminal download receipt IDs under its bound; when the roster exceeds 100 it omits the field
rather than presenting a truncated list as complete. Main accepts an exact claimed terminal
receipt after a status reconstruction. Renderer download history is bounded, and sets over 20
images require an explicit selection of at most 20.

The final read-only review found three applicable gallery presentation regressions. Fail-first
tests showed that timeline regrouping lost the selected IDs, Save-dialog progress/result
disappeared when its toolbar was replaced, and a preview removal failed to repaint its
placeholder while an availability revision broke the translated Save label. The gallery DOM
now owns selection and a weakly held Save presentation through regrouping/canonical hydration;
preview status and locale bindings reconcile in place. The three regressions and adjacent
gallery tests pass (28 tests). Two other review claims did not describe reachable states:
`ipc.ts` reports cancellation only before entering the writer, whose returned result always
has `cancelled: false`; and `generated-asset-downloads.ts` assigns each batch a process-monotonic
`createdAt`, so batches in one live renderer/main lifetime do not tie.

| Level | Evidence after resumed changes |
|---|---|
| Source and tests | `npm run verify` exited 0: privacy checked 352 commits/16 tags; notices checked 159 production packages, seven catalog entries and 731 native-source items; typecheck passed; Vitest passed 235 files/6,114 tests plus the separate six-test shutdown suite (13 files/136 tests skipped). `test/ipc.test.ts -t 'human-selected generated preview save IPC'` passed four cases. `git diff --check` exited 0. |
| Electron fixture and build | `node scripts/verify-crystal-rich-outputs.cjs` exited 0 for the production renderer's gallery/Save path and explicitly reported signed-in behavior not run. `npm run build` exited 0 for main, preload and renderer. A temporary browser visual fixture showed 21-image selection at 900px and 390px, two selected IDs and a partial Save count; its file/tab/server were removed afterward. |
| Package | `npm run dist` exited 0 for Linux x64 and arm64 AppImage/DEB. The x64 packaged-runtime smoke decoded PNG/WebP and ran node-pty/tree-sitter; the arm64 smoke verified resources but skipped native execution on this x64 host. Packaged `extension/background.js` hashes match source for both architectures; both asars contain `sessions:saveGeneratedAssetPreviews` and the selected-preview renderer control. No package was installed. |
| Provider | Signed-in ChatGPT acceptance was **not run**: the managed page showed Log in; a final passive relay attach reported that its extension never connected, without navigating the user's tab. Native choice postconditions, provider-original pixel fidelity, installed companion downloads and real provider gallery generation remain unverified. Unsupported rich controls remain inert. |

Gate 3 and the final branch/integration step remain blocked on a real signed-in companion.
No version bump, commit, installation, tag or publish was performed.

## Design spec status

`docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`: **In implementation**.
It moves to Implemented only after Cutover Task 4 and signed-in acceptance succeed.
