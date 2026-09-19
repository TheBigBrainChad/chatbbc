# ChatBBC Upstream Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, if available. This handoff is self-contained for a non-OMP agent: no OMP tools, session history, internal URIs, delegation, or skill installation are required. Follow the numbered tasks sequentially with your own editing tools.

**Goal:** Integrate the recent upstream correctness and usability fixes into ChatBBC without undoing its branding, local features, or concurrent rich-response implementation.

**Architecture:** Selectively port missing behavior from pinned upstream commits into the existing authoritative owners. Preserve durable local-session identity, exact request/document/turn ownership, serialized outbox custody, and one-attempt browser opening/send authority. Do not replace whole files or introduce a parallel recovery subsystem.

**Tech Stack:** Electron, TypeScript, vanilla renderer JavaScript/DOM, Chromium MV3 extension, Vitest, npm.

**Spec:** This document's Scope and acceptance criteria implement the user's request to adopt recent upstream fixes quickly with limited repeated testing. Read the repository's current `AGENTS.md` for product invariants and the concurrent `docs/superpowers/specs/2026-09-18-chatbbc-rich-responses-design.md` for overlapping ownership; do not implement that other plan twice.

## Global constraints

- Product name: **ChatBBC**, never restore Chat On Steroids in new UI, prompts, manifests, packaging, connector titles, or errors.
- Preserve `APP_TITLE = 'ChatBBC'`, `APP_SLUG = 'chatbbc'`, package/executable `chatbbc`, app ID `com.chatbbc.app`, desktop entry `com.chatbbc.app.desktop`, and connector IDs `chatbbc-core`, `chatbbc-desktop`, `chatbbc-plugins`.
- Preserve product URLs under `TheBigBrainChad/chatbbc`. Git remote names need not match product URLs. Upstream source/provenance links correctly remain under `totec448-spec/chat-on-steroids`.
- Do not globally replace historical names: LICENSE, contributors, old changelog entries, historical protocol explanations, `CLF_`, `COS_CONTEXT`, internal keys and ports 8765–8769 remain valid.
- Current observed app version is **2.1.17**, bridge protocol **15**. Do not import upstream's 2.1.14 release/version declarations or release title. Any genuinely incompatible wire change needs one coordinated local protocol decision; MAIN-world Fiber helper version is separate from bridge protocol.
- Preserve local appearance/Omarchy work, skill pack, intentional model filtering, and the native-final React-remount fix observed at local HEAD `02277c8`. Re-read current HEAD and files at execution time.
- Shared dirty tree: inspect status and each intended file's diff before editing. Do not reset, clean, overwrite, or broadly format other work. The two rich-response plan/spec documents were already untracked before this plan.
- No automatic commits, package/install, extension reload in the user's browser, or publishing. Ask separately for deployment authority. Do not edit live state ledgers to demonstrate success.
- Linux is the acceptance platform. Preserve/adapt upstream Windows fixes where included, but do not start a new Windows/macOS development effort or claim native verification unavailable on Linux.
- Preserve original authorship and upstream PR attribution, including applicable `Co-authored-by` attribution if a later authorized commit is created. Adapt `CONTRIBUTORS.md`, not the whole upstream file.

## Scope and pinned sources

Upstream changed during planning. The earlier reviewed ten commits ended at `c5ab887`; the new tip is **`962d040b423f676317feaa8bef1308305eac97e5`**. Implement the union of the originally reviewed five groups and the newly merged #316, not whichever moving ten happen to exist when execution starts.

| PR | Implementation source | Scope |
|---|---|---|
| [297](https://github.com/totec448-spec/chat-on-steroids/pull/297) | PR patch / implementation `61ef5aa` resolved within pinned ancestry | Response identity, exact completion/order, queued editor correctness, ten-image injection, native overwrite/status behavior |
| [300](https://github.com/totec448-spec/chat-on-steroids/pull/300) | `d22ed91adbeabde840666df40701eee7531c5ea0` | Continue custody and queue/countdown presentation |
| [310](https://github.com/totec448-spec/chat-on-steroids/pull/310) | `23bd73bd6275cd3d78e164d61b7dddde95f920cc` | Browser inspection/creation, final adoption, interim order, recovery and Windows controls |
| [312](https://github.com/totec448-spec/chat-on-steroids/pull/312) | `16a79817ffd02c0c793fd0dd556602dbd4935e59` | Exact native tool-result receipts before automatic compaction |
| [313](https://github.com/totec448-spec/chat-on-steroids/pull/313) | `29fd55d5eb674377d9247c1f10b630802a822c52` | Pinned GVDB download mirror; exclude upstream release title |
| [316](https://github.com/totec448-spec/chat-on-steroids/pull/316) | `81bd56c3303c351019c69d5eeec3e89b2e3c0d91`, then `647f23ec1fc09da246c9e8953fe2a00f18e546b4` | Worker wakes, durable observation deadline, helper/continuation diagnostics, fixture teardown/schema fixes |

Latest ten at planning: `962d040`, `647f23e`, `81bd56c`, `c5ab887`, `29fd55d`, `dc624d9`, `16a7981`, `f388521`, `23bd73b`, `0a017b5`. Merge commits are not separate features. #316 already incorporates adaptations of #314, #315 and part of #284: do not apply those again.

## Task 1 — Establish the exact missing delta

**Files:** pinned upstream diffs; local counterparts; concurrent rich-response plan and specification. No production edits in this task.

- [ ] Read local status, HEAD, intended diffs and current `AGENTS.md`. Coordinate ownership of `extension/content.js`, `extension/fiber.js`, `extension/chatgpt-dom.js`, `session/store.ts`, `session/recorder.ts`, and renderer history with the rich-response implementer before editing them. Serialize overlapping edits; unrelated tasks below may proceed while those files are owned elsewhere.
- [ ] Fetch upstream objects without merging or changing the worktree, then use per-commit diffs as implementation recipes:

```sh
git status --short
git log -1 --oneline
git fetch upstream
git show --stat 81bd56c3303c351019c69d5eeec3e89b2e3c0d91
git show 16a79817ffd02c0c793fd0dd556602dbd4935e59 -- extension/content.js extension/fiber.js
```

If the upstream remote is absent, fetch from `https://github.com/totec448-spec/chat-on-steroids.git`. Stop at the pinned tip, not newer commits. Resolve PR297's abbreviated implementation object from its PR/ancestry before use.

- [ ] In the final focused worklog, inventory every changed production hunk across these six groups as **already present**, **ported/adapted**, or **excluded with reason**. This prevents the broad #297/#310 bundles being silently reduced to their headlines. Exclusions are branding/release artifacts, irrelevant historical worklogs, or behavior already provided locally—not unexamined code.
- [ ] Adapt dependency hunks inside this scope when a later fix consumes an earlier interface. Do not wholesale cherry-pick merge commits or replace local files with upstream snapshots.

**Acceptance:** all six groups have an explicit integration disposition, and shared-file ownership is settled.

## Task 2 — Response identity, final adoption and chronological presentation

**Files:** `src/main/session/{store,recorder}.ts`, `src/shared/{session,chronology}.ts`, `src/main/bridge.ts`, `extension/{content,chatgpt-dom,fiber}.js`, `src/renderer/chat.ts`, associated CSS only where upstream behavior needs it.

**Contract:** the store's exact response relation is authoritative; display-only associations never become caller or recovery authority.

- [ ] Port missing #297 response relations: join overlapping document-local turns only with the same exact native question and qualifying shared request proof. Preserve conflicting requests, separate questions, separate retries and original journal IDs/sequences.
- [ ] Keep tool-injected corrections in history but out of native-question selection. An `inputId` alone cannot distinguish injection from a native app-sent question.
- [ ] Apply exact response projection consistently in completion readers, recorder, incremental timeline, cold reads and browser activity. Use committed sequence/binding to validate async completion reads, not queue-promise identity.
- [ ] Port #310's later adoption after an initially empty/refused activity response, and final-section tracking for the generation's exact question. Compose with ChatBBC's existing remount fix. Pre-Send nodes, other questions, manual Stop and replacement generations cannot acquire this authority.
- [ ] Port the exact native response-pair lookup for unowned interim **display** ordering, including off-page canonical anchors/conflicts. Do not synthesize lifecycle turn IDs or rewrite stored history to make ordering work.
- [ ] Reconcile remaining #297/#310 native overwrite/status and recovery hunks with the rich-response implementation: retain provider prose, media and final action controls; hide only exactly covered native tool/status rows; keep one completion path and one recovery owner.

**Focused proof:** reuse upstream regressions in `test/session-response-identity.test.ts`, `test/session-completion-order.test.ts`, `test/content-script.test.ts`, `test/chronology.test.ts`, and `test/renderer-timeline.test.ts`. Select the imported cases rather than running every suite repeatedly. Required positive/negative pair: one exact final settles its proven fragments and cancels obsolete Continue; a different question/request does not. Interim messages remain between their surrounding tools after reload and incremental repaint.

## Task 3 — Queue editing, ten-image injection and Continue controls

**Files:** `src/shared/input.ts`, `src/main/session/{input,input-attachments}.ts`, `src/renderer/chat.ts`, renderer translations, and all image-limit consumers identified by #297.

**Contract:** one shared classifier describes authored delivery intent; main outbox still owns mutation/claim/receipt.

- [ ] Port the shared immediate/queued intent classification. An immediate native upload temporarily waiting after-turn displays pending delivery with Cancel, not an invalid queued-task editor.
- [ ] Preserve Remove while editing; whitespace-only Save invokes cancellation. A successful cancellation immediately retires the editor; a negative edit receipt retires/refreshes stale state; transport failure preserves the unsaved text. Selection changes synchronously retire editors, with generation checks on delayed responses.
- [ ] Adopt #297's shared `MAX_INPUT_IMAGES = 10` throughout eligibility, admission, normalization, batching and retained previews. Retain all existing per-file, decoded-pixel, normalized-image and aggregate byte bounds; ten images is not permission to exceed those bounds. Native upload limits remain separate. This concerns input attachments, not generated-image downloads or the rich-response output feature.
- [ ] Apply #300's `!row.recovery` / `!entry.recovery` guards in `reorderQueuedInputs()` and `editQueuedInput()`. Frozen Continue text/source must not become authored queue text; cancellation remains available through existing custody rules.
- [ ] Port its renderer/countdown cleanup and retire superseded reload notices for newer questions. Translate new labels into the locales present in ChatBBC; do not add another language just because upstream has it.

**Focused proof:** imported queue/editor regressions plus ten-image success, eleven-image refusal, and unchanged aggregate-byte refusal. Run `node scripts/verify-input-queue.cjs` once against the integrated renderer, not once per sub-change. Inspect its visible result. Do not assert exact English copy where the real contract is queue state or control availability.

## Task 4 — Browser tool correctness and remaining #310 changes

**Files:** `extension/browser-control{,-page}.js`, `src/main/browser-control.ts`, `src/shared/browser-control.ts`, `src/main/mcp/{tools-browser,instructions}.ts`; existing Windows computer/MCP files changed by #310.

- [ ] Create a requested tab directly at its requested URL; reject known capacity failure before creation. Keep one tab handle through readiness and attachment.
- [ ] Preserve separate creation/attachment outcomes: an attachment failure after tab creation returns the created handle, `created: true`, `attached: false` and bounded `attachmentError`; it must not invite another `new` call.
- [ ] Port bounded `browser_snapshot format: dom` details through the existing isolated reader/schema/transport. Retain screen permission, password/inline-handler omission, traversal budgets, current refs and explicit truncation. Read-only inspection does not grant protected/foreign input or transfer debugger custody.
- [ ] Port access hints and model-visible guidance distinguishing same-browser inspection from an unrelated plugin browser. Use ChatBBC naming and preserve the local skills/opening prompt contract.
- [ ] Review every remaining #310 production hunk, including Windows focus/input/accessibility fixes. Adapt self-contained existing-platform corrections without importing upstream branding or changing Linux capability publication. Retain platform tests; report Windows native behavior unverified on Linux.

**Focused proof:** imported browser creation/inspection regressions. Run `node scripts/verify-browser-control.mjs` once for real Chromium behavior; use `node scripts/verify-browser-control-entry.mjs` if the production worker import/entry contract changes. Protected input must still be denied, and failed attachment must not create a second blank tab.

## Task 5 — Native result receipts before automatic compaction

**Files:** `extension/fiber.js`, `extension/content.js`; existing `test/fiber.test.ts` and `test/content-script.test.ts`.

- [ ] Adapt #312's exact native enclosing code-mode receipt descriptors into the final shared Fiber schema from Tasks 2/rich responses. Advance the helper's version coherently; do not overwrite richer descriptors or equate helper version with bridge protocol.
- [ ] Propagate automatic/manual intent into the existing `stopAndSettle()` path as upstream does. Automatic compaction waits for both local running work to settle and the exact native result receipts.
- [ ] Retain pending request/tool-message identities across section changes. A vanished DOM row, zero running local calls, or timing alone is not an answered receipt.
- [ ] Keep the existing bounded settle deadline. Missing receipt fails visibly before Stop/summary Send: nothing was compacted. Preserve manual semantics and existing exact owner/epoch cancellation checks.

**Focused proof:** import upstream receipt cases: local call finished but native result pending => no automatic Stop; exact result answered => eligible; missing/foreign receipt => no permission. Do not manufacture receipts in mocks merely to satisfy the new guard.

## Task 6 — Worker revival, observation delivery and bounded diagnostics

**Files:** `src/main/{agents,bridge}.ts`, `extension/background.js`, `test/{bridge,extension}.test.ts`; relevant test-fixture files from #316.

- [ ] Port `liveAgentForOwnedConversation()` as a live-slot projection while retaining historical ownership APIs for recording. `queueMissingTab()` must not treat a parked prime as an occupied slot. A waking worker qualifies only with pending text for its exact run/conversation.
- [ ] Port the admitted-revival inspection in `queueWorkerRevival()`: capture command object and bridge lifecycle; after the session read recheck command presence, no elected owner, no proven delivery, same revival text/conversation, binding, recovery setting, stop and user-departure fences. Use the existing recovery election with `no-tab:wake:<commandId>`; app observation absence alone is not permission to bypass the extension's exact-tab scan or open twice.
- [ ] Set `EVENTS_REQUEST_TIMEOUT_MS = 60_000` for `/events` initial batches **and** 413 split retries. Keep `REQUEST_TIMEOUT_MS = 10_000` for ordinary reads and server limits unchanged. Preserve unacknowledged journal entries after timeout; never acknowledge before durable recording.
- [ ] Port helper-health `lastSeenAt` and 90-second reporting-gap reset. Keep diagnostics separate from recovery permission.
- [ ] Port bounded deduplicated marked-continuation outcome logging: unknown token, message conflict, retryable commit, rejected commit and committed are different outcomes. No log may claim a rebind before it commits. Retain test reset cleanup and bounded memory.
- [ ] Adapt `647f23e` only where the imported tests need it: drain recorder/durable writes before teardown and use current persisted catalog schema in large fixtures. Do not increase global test timeouts or change production behavior to satisfy teardown.

**Focused proof:** reuse #316's wake/cancellation and journal deadline cases. Required race: pause session lookup, cancel/replace the wake, resume lookup => no opening grant. An `/events` response after ten seconds but before sixty can settle; a failure retains journal custody. Prefer existing fake-clock regressions over a literal minute-long new test.

## Task 7 — Packaging-source maintenance and documentation

**Files:** `docs/licenses/native/sources.json`, `docs/licenses/native/SOURCE-BUILD.md`, `AGENTS.md`, `CHANGELOG.md`, `CONTRIBUTORS.md`, one focused worklog.

- [ ] Adapt #313's pinned GVDB archive URL to its GitHub mirror while retaining the reviewed commit, expected size and SHA. Validate with the repository's existing pinned-source check; do not hand-edit generated archives/binaries or claim byte identity without the check.
- [ ] Preserve ChatBBC's release titles and version. Do not copy upstream release notes or historical worklogs as new local accomplishments.
- [ ] Update product contracts in their existing AGENTS sections for response ownership, queue intent/ten images, compaction receipts, browser inspection and worker/journal behavior. Remove superseded local wording, not unrelated rules.
- [ ] Add a concise local changelog entry and attribution to incorporated upstream authors/PRs. Record the hunk disposition and actual checks in `docs/worklog-2026-09-19-chatbbc-upstream-reliability.md`.

## Task 8 — Focused final gate and honest handoff

Do not create a large new testing project. Reuse upstream behavior regressions; one regression set per changed boundary, one integrated run at the end. Do not run full verification after every task or delegate redundant review/test passes.

- [ ] Run targeted imported regressions once after their affected subsystem is integrated, or batch them at the end if shared edits are still in flight. Retain the meaningful negative cases named above.
- [ ] Run the queue and browser smoke scripts once as specified. For browser/provider-facing fixes, perform one short signed-in ChatGPT reproduction before/after **only if the user has authorized use/reload of that test environment**. Otherwise explicitly report source/isolated-browser validation and the missing deployed acceptance; do not silently install or send a real task.
- [ ] Run the repository's required final `npm run verify` once, then `npm run build` once. The full gate is a final integration check, not an inner loop. If unrelated concurrent work breaks it, identify the exact failure and owner; do not discard their edits or report a pass.
- [ ] Review touched identity surfaces for branding regressions. Expected active values are in Global constraints. Legitimate historical/provenance references are not failures.
- [ ] Deliver: changes per PR, exclusions/already-present code, actual command results, remaining platform/provider limitations, and any unresolved conflict. Remove only scratch files you created. No commit/install/publish without a separate request.

## Next tranche — unresolved issues, not blockers for the pinned catch-up

Do not expand the catch-up into every feature proposed during brainstorming. After Tasks 1–8, report these as the next bounded work rather than claiming they were fixed by the upstream port:

1. **Model discovery #311/#287:** explicit Refresh with only busy tabs needs a bounded authorized discovery page; passive observation must not open one. Inspect current signed-in picker/slider DOM before changing selectors. Preserve intentional ChatBBC model filters. Upstream #316 explicitly leaves #311 with another owner; check for a later approved fix before duplicating it.
2. **Core disappearing on follow-ups #279/#253:** distinguish tunnel health, native per-message connector selection and actual tool invocation. Opening prompt text is not attachment proof. No literal mention-text workaround or speculative automatic click.
3. **Residual slow recording #301:** the route-specific timeout is included above; it does not prove the underlying recording latency is optimized. Profile only if the problem remains.

New-chat model defaults, health dashboards, global concurrency limits, trusted-chat mode, additional folder semantics, embedded browser and new provider/download features remain outside this implementation. They need a separate product decision, not incidental code in an upstream merge.
