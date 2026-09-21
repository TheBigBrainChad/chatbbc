# ChatBBC upstream reliability port, 2026-09-19

Completed and verified for pull-request review.

Worktree: `.worktrees/chatbbc-upstream-reliability` on branch `chatbbc-upstream-reliability`.
Base: `02277c8` (native-final remount). Pinned upstream tip: `962d040`.
Committed on the feature branch. No install, package, or merge.

## What landed

| Group | Result |
|---|---|
| #297 `61ef5aa` response identity, queue intent, ten images | Ported/adapted. Renderer queue is `src/renderer/outbox-view.ts`; styles in `src/renderer/styles/`. Shared `MAX_INPUT_IMAGES=10` and `queuedFollowup`/`manualInput`. Fork remount fix retained. |
| #300 `d22ed91` Continue custody | Ported. Recovery rows cannot be edited/reordered; cancellation remains. Locales es/zh-CN/zh-TW. |
| #310 `23bd73b` browser, adoption, interim, Windows | Ported owned browser/Windows/MCP files. Response adoption/interim in store/recorder/content. Windows native unverified on Linux. |
| #312 `16a7981` native receipts | Ported into Fiber helper version 13. Automatic compaction waits for exact native enclosing receipts. |
| #313 `29fd55d` GVDB | URL mirrored; SHA/size/commit retained. Upstream 2.1.14 release title excluded. |
| #316 `81bd56c`/`647f23e` wakes and journal | Ported live-slot vs parked history, wake inspection, 60s `/events`, fiber health gap, marked-replacement notices. Fixture drain in session tests. |

Docs updated: `AGENTS.md`, `CHANGELOG.md` (2.1.17 Fixed), `CONTRIBUTORS.md`, this worklog.

Excluded: upstream version/release notes, historical worklogs as accomplishments, #311 discovery, #279 Core attachment, recursive primes/embedded browser.

## Checks that actually ran

Passed:
- `npm run verify`: privacy, notices and typecheck passed; 220 test files passed with 5,361 tests, 13 files / 136 tests skipped; the isolated shutdown suite passed 6 tests.
- `npm run build`: main, preload and renderer production bundles completed.
- `npx electron scripts/verify-input-queue.cjs .tmp/message-send-20260918/ui --ozone-platform=x11 --disable-gpu --in-process-gpu`: 15 checks passed. The harness now opens the real collapsed composer-status disclosure before editing its queued row.
- `COS_TEST_CHROMIUM=/usr/bin/chromium node scripts/verify-browser-control.mjs`: 25 checks passed in real isolated Chromium, including viewport and full-page screenshots.
- `npx vitest run test/browser-control-extension.test.ts test/browser-control.test.ts test/browser-control-page.test.ts test/browser-control-navigation.test.ts test/tools-browser.test.ts`: 47 tests passed.
- `npx vitest run test/renderer-timeline.test.ts`: 181 tests passed.
- Focused imported suites covered response identity, completion order, chronology, input/images, bridge, worker/extension recovery, browser control, Windows/computer boundaries and MCP result budgets.

Repairs found during verification:
- The queue smoke clicked an Edit control inside a collapsed disclosure, producing a zero-width textarea. The smoke now follows the visible disclosure path before editing.
- Chromium 152 could indefinitely throttle `Page.captureScreenshot` after background input/layout work. Screenshot capture now owns a temporary one-pixel screencast that wakes the compositor and is stopped in `finally`; it neither selects the tab nor retries input.
- `/activity/detail` returned a raw hydrated tool call while activity polling returned its timeline projection. The exact revision now uses the same turn-origin projection without disk reads or history scans.
- Pre-PR review found that deliberate page closure did not suppress the shared Goal/input pickup sweep. `/closed` now revokes the session's silence input and dismissed sessions are excluded from owed pickups; the focused regression fails before the repair and passes after it.

Not exercised:
- Signed-in ChatGPT, an installed packaged app, or native Windows runtime behavior.
