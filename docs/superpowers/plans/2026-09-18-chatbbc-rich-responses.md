# ChatBBC Rich Responses, Native Interactions and Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Resume the existing plan workspace and ledger; do not recreate completed work. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated images and rich ChatGPT answers durable and usable in ChatBBC, including exactly-once user-authorized interaction with supported controls in the original ChatGPT conversation.

**Architecture:** Keep canonical messages, media, browser identity and delivery authority with their existing owners. Capture a bounded semantic projection of an exactly identified native answer, store it on the existing canonical assistant shard, reuse the existing image asset store, and route explicit user actions through one durable main-process transaction and the paired companion. This rewrite is continuation-aware: it replaces the original 16-task orchestration, not the approved design or evidence already recorded.

**Tech Stack:** Electron 44, TypeScript, Chromium MV3 companion JavaScript, Node HTTP bridge and durable JSON, Sharp, Zod, Vitest/jsdom, vanilla renderer DOM/CSS.

**Spec:** `docs/superpowers/specs/2026-09-18-chatbbc-rich-responses-design.md`

## Global Constraints

- The spec is authoritative. This plan is its execution argument; resolve conflicts in favor of the spec and record the ruling in the SDD ledger.
- Linux is the implementation and live-validation target. Preserve legacy Windows/macOS source and tests.
- Preserve ChatBBC identity, current release declarations, Omarchy compatibility, CSP, context isolation and sandboxing. Re-read current version/protocol declarations; do not restore numbers recorded by an older report.
- One fact has one owner: canonical text/chronology in the session store, rich projection on the same assistant shard, bytes/quota/tombstones in the existing asset owner, live control identity in the current extension document, irreversible action custody in the main process.
- Never evaluate model-authored JavaScript, JSX/DIL, event handlers or arbitrary CSS. Never persist signed URLs, cookies, credentials or raw provider payloads.
- Rich-message bounds remain 128 KiB serialized, 1,024 nodes, depth 24, 128 controls, 64 media references and 8 KiB per text node, plus existing bridge/image/renderer limits.
- Exact ownership requires local session, originating conversation, binding epoch, canonical message identity, current provider/DOM relation, document id and navigation epoch as applicable. Text, position, URL, active tab or A → B → A equality is insufficient.
- Recording Off must publish no new transcript, rich projection, media asset or action state after its durable barrier. Existing readable history and unrelated outbox/control state remain intact.
- A user action persists `may-have-dispatched` before browser input. Crash, timeout, missing ACK or restart can never make that action replayable.
- Browser opening/input is allowed only by an explicit human interaction against an eligible exact frontend. History loading, startup, hydration and timers grant no authority.
- Do not add a webview, second image cache, generic IPC executor, parallel recovery owner, new browser permission or synthetic success path.
- Source tests, build, package, installed bytes and live provider behavior are separate evidence levels. Report only the level actually exercised.
- Preserve unrelated dirty work. Never reset, clean, overwrite or broadly reformat the shared tree.

## Review Focus

Each item is pinned to the task that owns it:

1. **A → B → A stale ownership:** old rich capture, media completion or action receipt must not attach to the later A epoch — Tasks 2–6.
2. **Lost action acknowledgement:** restart after durable `may-have-dispatched` must yield observed/unknown, never a second click — Tasks 3–4.
3. **Recording Off race:** queued session, metadata, asset and journal writes must drain or be rejected before Off acknowledges — Task 6.
4. **Shared asset retirement:** deleting or cleaning one rich/native reference must not remove bytes still referenced elsewhere or resurrect a tombstoned asset — Tasks 2 and 6.
5. **Hostile/oversized rich input:** getters, proxies, malformed nesting, excessive UTF-8 and executable fields must fail closed while canonical text remains readable — Task 2.

---

## Superpowers Execution Contract

1. Invoke `superpowers:using-git-worktrees`. If `.worktrees/rich-responses/` is the registered existing workspace, resume it; never create a nested or replacement worktree.
2. Invoke `superpowers:subagent-driven-development` with this plan. Resolve the workspace using its `sdd-workspace` helper.
3. The existing ledger at `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/progress.md` is durable evidence. Its historical `Task1`–`Task16` labels refer to the retired plan layout. Preserve them verbatim and append:

   ```text
   Plan rewrite adopted: 2026-09-21
   Legacy task numbering retired; Workflow Tasks 1–7 below are authoritative.
   ```

4. Before dispatch, create the complete shared-file/interface matrix required by the SDD skill. Never run concurrent implementers; these cuts overlap in bridge, recorder, store, extension and renderer ownership.
5. For each task, the controller generates a task brief, records BASE, dispatches one implementer, receives a committed change and report, packages `BASE..HEAD`, and dispatches an independent task reviewer. Critical/Important findings use the SDD fix loop and scoped re-review.
6. Use TDD for every behavioral repair: reproduce a real failure or write the nearest behavior-level failing regression, observe RED for the intended reason, implement the smallest owner-level fix, then observe GREEN. A test that never failed is not regression evidence.
7. The continuation preflight may mark a task complete without reimplementation only when current source, immutable commits/reports and applicable verification establish every acceptance item. Record the exact evidence and `Task N: complete (...)` in the ledger. Otherwise dispatch only the remaining delta.
8. If signed-in provider evidence is temporarily unavailable, finish independent source-safe work, retain unavailable/inert behavior at the live boundary and ledger the missing evidence. Never infer selectors, media families, accepted input or installed behavior from fixtures.
9. After Task 7, invoke `superpowers:verification-before-completion`, request one whole-branch review on the most capable available reviewer, then invoke `superpowers:finishing-a-development-branch`. Push, merge, install, publish and release remain separately authorized side effects.

---

## Mandatory Continuation Preflight

The SDD controller performs this during setup; it is not an implementation task and produces no source commit.

- [ ] Verify the registered worktree, branch, HEAD, dirty-path ownership and plan workspace. Run:

  ```bash
  git status --short
  git log -1 --oneline
  ```

- [ ] Read the existing ledger newest-first and verify claimed commits/reports against current source. Historical reports prove only their recorded tree.
- [ ] Append one status table for Workflow Tasks 1–7 with: current behavior, accepted evidence, missing acceptance, owned files and next delta.
- [ ] Record current package/app/extension versions, both bridge-protocol declarations and separate source-test/build/package/installed/provider evidence.
- [ ] Append `Task N: complete (...)` only when every acceptance item for that task is proven on the current tree. Otherwise retain `partial`, `blocked` or `not started` and dispatch only its remaining delta.
- [ ] Complete the SDD shared-file/interface matrix. Acceptance: no completed behavior is reimplemented, no self-report is mistaken for independent approval, and no source result is represented as installed/provider proof.

---

### Task 1: Close Generated-Image Discovery and Capture Reliability

**Files:**
- Modify only at the proven first wrong boundary: `extension/fiber.js`, `extension/chatgpt-dom.js`, `extension/content.js`, `src/main/bridge.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/renderer/chat.ts`
- Test: `test/fiber.test.ts`, `test/chatgpt-dom-input.test.ts`, `test/content-script.test.ts`, `test/bridge.test.ts`, `test/image-storage.test.ts`, `test/renderer-timeline.test.ts`
- Evidence: `docs/superpowers/evidence/2026-09-18-rich-responses-live.md`

**Interfaces:**
- Consumes: current typed provider evidence, exact message/document ownership, existing `native_image` event and existing bounded asset pipeline.
- Produces: reliable pending → available/unavailable native-image rows for observed public single, gallery and image-only outputs, preserving provider order and exact tuple identity.

- [ ] **Step 1: Diagnose the actual stage before changing production**

  On an owned signed-in fixture, trace: provider typed output → exact message/DOM tuple → loaded pixels → bridge admission → decoded asset write → `sessions:image` → renderer paint. Record only redacted identities and stage outcomes. If live access is unavailable, add only source-safe negatives and leave unproved families unsupported.

- [ ] **Step 2: Add fail-first positive and neighboring negative regressions**

  Cover tool-final and assistant-final public images using valid matching tuples; reject user uploads, private/analysis images, wrong recipients, duplicate/ambiguous owners, unstamped same-asset clones, stale documents and A → B → A completions. Include single, gallery and image-only ordering.

- [ ] **Step 3: Fix the first wrong owner only**

  Reuse the existing native-image event, capture and store. Do not introduce another event family or URL-based identity. Recheck exact source ownership after each asynchronous pixel/decode/write operation.

- [ ] **Step 4: Verify the behavior**

  Run:

  ```bash
  npm test -- --run test/fiber.test.ts test/chatgpt-dom-input.test.ts test/content-script.test.ts test/bridge.test.ts test/image-storage.test.ts test/renderer-timeline.test.ts
  npm run typecheck
  ```

  Acceptance: exact public images appear once and in order; pending/unsupported/quota states remain truthful; stale or foreign images never attach; no signed URL or duplicate base64 is persisted.

- [ ] **Step 5: Commit, report and pass task review**

  Commit only the proven delta. The reviewer must distinguish fixture coverage from installed/provider proof.

---

### Task 2: Publish Verified Rich Trees and Embedded Media

**Files:**
- Modify: `src/shared/rich-response.ts`, `src/shared/session.ts`, `extension/fiber.js`, `extension/chatgpt-dom.js`, `extension/content.js`, `src/main/bridge.ts`, `src/main/session/rich-response.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/main/session/input-history.ts`, `src/renderer/rich-response.ts`, `src/renderer/styles/transcript.css`
- Test: `test/rich-response-schema.test.ts`, `test/rich-response-store.test.ts`, `test/rich-response-renderer.test.ts`, `test/rich-media.test.ts`, `test/content-script.test.ts`, `test/bridge.test.ts`, `test/image-storage.test.ts`

**Interfaces:**
- Consumes: exact current message/root proof from the extension, bounded `RichResponse` parsing, canonical assistant shards and existing asset admission/cleanup.
- Produces: progressively revised safe rich presentation on the same canonical assistant message, with embedded media that references existing validated assets and never changes turn/final/work semantics.

- [ ] **Step 1: Prove capture-time provenance**

  Add fail-first tests showing the original Chrome sender/document/navigation epoch and current binding survive MAIN → content → background journal → bridge → recorder. Include same-document SPA A → B → A, late journal replay, wrong route and replaced provider-message negatives.

- [ ] **Step 2: Prove hostile and oversized input fails closed**

  Test arrays/objects with getters, proxies and custom iterators; malformed/deep/excessive nodes; oversized UTF-8; executable fields; duplicate node/media ids; invalid geometry. Preserve canonical text and publish one explicit unavailable rich state instead of a partial tree.

- [ ] **Step 3: Admit rich revisions on the canonical shard**

  Require exact session/conversation/binding/message/provider/document proof. Preserve message origin, chronology, `contentSeq`, `finalContentSeq`, Goal state and canonical text. Repeated identical revisions are unchanged; late captures and physical shard replacement are refused.

- [ ] **Step 4: Admit embedded media transactionally**

  Persist pending/unavailable identity first; publish `available` only after decoded bytes, exact message revision and asset reference commit. Reuse an existing native-image asset for an identical proven tuple. Extend inventory/retirement before any new reference can become live.

- [ ] **Step 5: Verify storage and presentation**

  Run:

  ```bash
  npm test -- --run test/rich-response-schema.test.ts test/rich-response-store.test.ts test/rich-response-renderer.test.ts test/rich-media.test.ts test/content-script.test.ts test/bridge.test.ts test/image-storage.test.ts
  npm run typecheck
  ```

  Acceptance: rich choice/diagram structures render safely without raw component leakage or chat-wide overflow; controls remain inert; embedded assets stay in reading order; canonical fallback survives unavailable/oversized input; A → B → A cannot retarget a revision.

- [ ] **Step 6: Commit, report and pass task review**

  Review must cover both the data contract and the browser-to-store provenance chain.

---

### Task 3: Complete Durable Native-Action Custody

**Files:**
- Modify: `src/main/rich-actions.ts`, `src/main/ui-selection.ts`, `src/main/bridge.ts`, `src/main/durable.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/chat.ts`
- Test: `test/rich-actions.test.ts`, `test/bridge.test.ts`, `test/ipc.test.ts`, `test/preload.test.ts`, `test/renderer-timeline.test.ts`

**Interfaces:**
- Consumes: exact stored rich control descriptor, current renderer selection witness, current session/binding policy and durable writer.
- Produces: one serialized action transaction with phases `intent accepted → opening spent → elected → may-have-dispatched → observed|unknown|changed|unavailable → retired` and a read-only exact-owner status API.

- [ ] **Step 1: Establish the renderer selection witness**

  Add fail-first selection/null/destruction/reload/A → B → A tests for a private main-process owner tied to the current BrowserWindow/webContents and selected local session. Never treat `sessions:list.activeId` as UI selection authority.

- [ ] **Step 2: Implement and test durable transitions**

  Test valid transitions and refuse skipped, duplicate, foreign-owner, stale-revision, blocked, superseded and compacting paths. Persist every authority-bearing transition before publication.

- [ ] **Step 3: Prove the irreversible cut**

  Crash-inject before and after `may-have-dispatched`, during result publication and before receipt retirement. Restart after the cut must produce unknown/observed custody without another dispatch; a pre-cut proven failure may be retired without claiming input occurred.

- [ ] **Step 4: Expose read-only status only**

  Add fixed validated IPC/preload status access for exact session/action membership. Do not expose begin/elect/arm/finish or arbitrary browser data to the renderer in this task.

- [ ] **Step 5: Verify**

  Run:

  ```bash
  npm test -- --run test/rich-actions.test.ts test/bridge.test.ts test/ipc.test.ts test/preload.test.ts test/renderer-timeline.test.ts
  npm run typecheck
  ```

  Acceptance: action custody survives restart; one action id cannot cross sessions/documents/revisions; lost ACK cannot authorize replay; renderer selection changes invalidate pending authority.

- [ ] **Step 6: Commit, report and pass concurrency-focused review**

---

### Task 4: Execute One Verified Native Control Through the Companion

**Files:**
- Modify: `extension/background.js`, `extension/content.js`, `extension/chatgpt-dom.js`, `src/main/bridge.ts`, `src/main/rich-actions.ts`
- Test: `test/rich-action-extension.test.ts`, `test/extension.test.ts`, `test/content-script.test.ts`, `test/chatgpt-dom-input.test.ts`, `test/bridge.test.ts`, `test/rich-actions.test.ts`

**Interfaces:**
- Consumes: Task 3 durable grant, exact current rich control observation and authenticated extension sender/document registration.
- Produces: one elected tab/document operation for supported choice selection and Continue, with a native observed postcondition and durable result/ACK custody.

- [ ] **Step 1: Add negative protocol fixtures first**

  Refuse missing/foreign/stale/duplicate/protected grants, untrusted senders, tab-query failure, wrong conversation/message/control, changed options, disabled controls, reset native selection, SPA A → B → A and restart uncertainty. Assert no click and no replacement tab.

- [ ] **Step 2: Add one-shot bridge/extension custody**

  Opening authority is spent before tab creation. Elect one exact registered document, persist the main irreversible cut, claim once in the extension, recheck route/message/control/current state immediately before input, and retain the result until the main process durably acknowledges it.

- [ ] **Step 3: Implement supported native semantics**

  Support the observed card/radio-like selection and Continue operation only. Use real page input semantics owned by `chatgpt-dom.js`; never evaluate model callbacks or translate Continue into a text prompt. Continue requires the exact currently observed selection/form value.

- [ ] **Step 4: Require observed postconditions**

  Selection success requires native selected/value change. Continue success requires the provider's resulting native transition/new turn evidence. Dispatch acknowledgement alone yields unknown, not success.

- [ ] **Step 5: Verify source behavior**

  Run:

  ```bash
  npm test -- --run test/rich-action-extension.test.ts test/extension.test.ts test/content-script.test.ts test/chatgpt-dom-input.test.ts test/bridge.test.ts test/rich-actions.test.ts
  npm run typecheck
  ```

  Then exercise one owned signed-in safe fixture. If real accepted input cannot be observed, leave production actions unavailable and report the exact missing evidence; do not ship fixture-only enablement.

- [ ] **Step 6: Commit, report and pass task review**

  Reviewer focus: exactly-once input, opener custody, no replay after lost ACK, no protected/executor-tab interference.

---

### Task 5: Wire Fixed IPC, Accessible Controls, Viewer and Retry

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/rich-actions.ts`, `src/main/session/store.ts`, `src/renderer/rich-response.ts`, `src/renderer/rich-image.ts`, `src/renderer/chat.ts`, `src/renderer/styles/transcript.css`, `src/renderer/i18n.ts`, `src/renderer/locales/es.json`, `src/renderer/locales/zh-CN.json`
- Test: `test/rich-action-ipc.test.ts`, `test/preload.test.ts`, `test/rich-response-renderer.test.ts`, `test/rich-image.test.ts`, `test/renderer-timeline.test.ts`

**Interfaces:**
- Consumes: reviewed Task 3/4 action APIs, canonical rich/media membership and retained preview bytes.
- Produces: fixed preload methods for explicit user action/status/manual open/exact retry and accessible renderer projection with truthful pending/observed/unknown/changed/unavailable states.

- [ ] **Step 1: Add fixed validated IPC/preload contracts**

  Renderer inputs name only current session, canonical message/revision/node or stored asset/action ids. Main derives browser target, operation and URL. Reject foreign membership, stale selection generation, superseded frontend and programmatic/non-user invocation.

- [ ] **Step 2: Enable controls only through explicit trusted interaction**

  Preserve stable DOM, keyboard semantics, focus, reduced motion, zoom and responsive layout. Never optimistically persist selection or Continue success. Unknown controls and ineligible historical frontends provide inert/manual-open presentation.

- [ ] **Step 3: Complete the local saved-preview viewer**

  Use retained bounded bytes through existing `sessions:image`; label them saved/downscaled previews, preserve focus containment and return, cancel stale loads, and never imply original-resolution custody.

- [ ] **Step 4: Add exact-image Retry capture**

  Retry re-observes one exact existing image and may consume one explicit user-authorized original-chat opening. It never regenerates, refetches a signed URL, overrides a tombstone or repeats after ambiguous dispatch.

- [ ] **Step 5: Verify**

  Run:

  ```bash
  npm test -- --run test/rich-action-ipc.test.ts test/preload.test.ts test/rich-response-renderer.test.ts test/rich-image.test.ts test/renderer-timeline.test.ts
  npm run typecheck
  ```

  Acceptance: fixed APIs expose no generic browser executor; controls are keyboard/focus accessible; stale UI cannot act; viewer/retry preserve exact ownership and truthful image provenance.

- [ ] **Step 6: Commit, report and pass task review**

---

### Task 6: Harden Recording Off, History, Cleanup and Crash Recovery

**Files:**
- Modify only where failing tests identify the wrong owner: `src/main/config.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/main/session/input-history.ts`, `src/main/rich-actions.ts`, `src/main/bridge.ts`, `extension/background.js`, `src/renderer/chat.ts`, `src/renderer/rich-response.ts`
- Test: `test/rich-response-lifecycle.test.ts`, `test/session-retention.test.ts`, `test/image-storage.test.ts`, `test/image-storage-ui.test.ts`, `test/rich-media.test.ts`, `test/rich-actions.test.ts`, `test/continuation.test.ts`, `test/renderer-timeline.test.ts`

**Interfaces:**
- Consumes: complete rich/media/action paths from Tasks 1–5 and current config/durable/session transactions.
- Produces: one enforced Off barrier, complete asset reference retirement, restart-safe history/action recovery and compaction-safe historical provenance.

- [ ] **Step 1: Prove Recording Off as a physical write barrier**

  Pause each accepted write before publication, commit Off, resume it, and assert no new session directory, message shard, metadata, journal, media asset or action record appears after acknowledgement. Include first-sight session creation, delayed metadata flush, queued asset write and failed Off persistence. Existing history stays readable.

- [ ] **Step 2: Prove cleanup and tombstones across every owner**

  Test native image, rich media, user/tool assets and shared references. All selected shards retire references before physical deletion; missing/corrupt inventories veto deletion; concurrent stale capture cannot resurrect removed bytes; quota remains exact.

- [ ] **Step 3: Prove history and compaction invariants**

  Restart and page rich revisions without moving chronology or widening the viewport. Compact A → B without rewriting A's rich provenance or granting B/A-later action authority. Image-only finals, Goal/Loop and `contentSeq`/`finalContentSeq` remain governed by existing canonical owners.

- [ ] **Step 4: Prove crash/receipt intersections**

  Crash around action intent/election/cut/result/retirement and media pending/write/reference publication. Recovery must converge to exact observed/unknown/unavailable state without duplicate input, orphan assets or fabricated success.

- [ ] **Step 5: Verify**

  Run:

  ```bash
  npm test -- --run test/rich-response-lifecycle.test.ts test/session-retention.test.ts test/image-storage.test.ts test/image-storage-ui.test.ts test/rich-media.test.ts test/rich-actions.test.ts test/continuation.test.ts test/renderer-timeline.test.ts
  npm run typecheck
  ```

  Acceptance: Off blocks new persisted feature bytes; cleanup is all-owner and tombstone-safe; restart/compaction preserve identity; action/media crash points never replay or retarget.

- [ ] **Step 6: Commit, report and pass race-focused review**

---

### Task 7: Integrated Linux, Package and Live Acceptance

**Files:**
- Modify: `AGENTS.md` only where final behavior changes its authoritative contracts
- Modify: `docs/superpowers/evidence/2026-09-18-rich-responses-live.md`
- Modify release declarations only with explicit release-preparation authorization
- Test: all focused suites named above plus project verification/build/package/runtime commands

**Interfaces:**
- Consumes: reviewed Tasks 1–6 and the complete spec.
- Produces: final evidence matrix, authoritative product-contract update, whole-branch review package and a branch ready for the user's integration decision.

- [x] **Step 1: Run the final source gate once on a stable tree**

  2026-09-21: `npm run verify` EXIT0 — 226 main files passed / 13 skipped, 5,680 tests passed / 136 skipped; shutdown 6/6; privacy/notices/typecheck/Electron passed. `npm run build` EXIT0.

  Run:

  ```bash
  npm run verify
  npm run build
  ```

  Read complete output and record exact pass/fail counts and exit codes. A rerun after failure is additional evidence; preserve the original failure and diagnosis.

- [x] **Step 2: Verify the assembled Linux artifact when authorized**

  2026-09-21: `env -u APPIMAGE npm run dist:linux:x64` EXIT0; packaged runtime smoke EXIT0 (Electron 44.3.0, Sharp 0.35.4/libvips 8.18.6 PNG/decode/WebP, PTY, tree-sitter). SHA-256 AppImage `1407a4584f043b2f7aed828c1f42d998a94584ecbcb2323941c332766d66b4dd`; DEB `2be9f447879bd343b9157e2b80716f0e84fb3e7ca5a0112ed2214df13c08c83f`. Disposable Ubuntu 24.04 DEB GUI recorded `app started` / `renderer state ready` / `window loaded`.

  Build the authorized Linux target, verify package/app/extension versions, both protocol declarations, packaged extension bytes and native dependencies, then run the packaged runtime smoke. A successful source build is not package evidence.

- [ ] **Step 3: Exercise the installed app and matching companion when authorized**

  BLOCKED 2026-09-21: browser relay could not acquire a signed-in `chatgpt.com` tab; Orca `computer list-apps` returned an empty inventory. Disposable DEB GUI startup is not companion pairing, native choice/Continue, generated-image pixels or raster/accessibility.

  Verify hashes before replacing any test installation. Confirm the actual app/extension handshake, then exercise: rich choice cards; wide diagram/table; single, gallery and image-only generation; pending/available/unavailable images; local viewer; exact one-time selection and Continue; closed-tab explicit reopen; restart; A → B → A; quota/cleanup/tombstones; Recording Off; keyboard/focus/reduced-motion; Light/Dark/Omarchy narrow/zoom layout. Record redacted outcomes only.

- [ ] **Step 4: Check the completion criteria line by line**

  NOT MET 2026-09-21: source/package/install-startup pass; both supplied rich examples, durable live generated-image previews, and one supported native action/postcondition remain unverified. Unproved families stay explicitly unsupported.

  The feature is complete only when both supplied rich examples are usable, current generated-image cases have durable previews, restart/navigation preserve history, and one supported user action produces one correctly owned observed or truthful unknown/unavailable outcome. Unproved provider families remain explicitly unsupported, not silently accepted.

- [x] **Step 5: Update authoritative documentation**

  2026-09-21: `AGENTS.md` owners/ledger/§21 limits updated; package/install and live-block evidence appended.

  Integrate final owners, bounds, lifecycle, evidence level and any remaining supported limitations into the relevant `AGENTS.md` sections. Append actual live/package evidence to the evidence document; remove obsolete implementation-gap claims rather than adding contradictory notes.

- [ ] **Step 6: Request final whole-branch review**

  2026-09-21: independent reviewer launched against the reachable tree. Live cells remain blocked; do not treat missing native action as a source defect to invent.

  Use the SDD review-package helper from merge base to HEAD. Give the most capable reviewer the spec, plan, ledger rulings/deferred findings, implementation reports and package/live evidence. One fix wave and one scoped re-review maximum, as required by the SDD skill.

- [ ] **Step 7: Verify before completion and finish the branch**

  2026-09-21: verification-before-completion ran on the reachable gates (verify/build/package/smoke/DEB GUI). Finishing menu presented; no merge/push without an explicit user choice. Live acceptance is not claimed complete.

  Invoke `superpowers:verification-before-completion` and rerun the command that proves every completion claim on the final reviewed tree. Then invoke `superpowers:finishing-a-development-branch`; present merge, PR or keep-as-is options. Never push, merge, publish or delete the worktree without the user's corresponding choice.

---

## Dependency Gates

```text
Continuation preflight
  ├─ Task 1 generated-image reliability
  └─ Task 2 rich capture/publication
       ├─ Task 3 durable action custody
       │    └─ Task 4 companion one-shot input
       │         └─ Task 5 IPC/UI/viewer/retry
       └──────────────────────────────┘
                    ↓
          Task 6 lifecycle hardening
                    ↓
          Task 7 integrated acceptance
```

- Task 1 may finish independently of rich interaction.
- Task 2 requires capture-time identity proof before live rich/media publication.
- Task 4 requires both reviewed durable custody and real safe native-input feasibility. Without either, controls remain inert.
- Task 5 may land read-only viewer/status behavior before action enablement, but executable controls require reviewed Task 4.
- Task 6 runs after every production path exists so its race/crash tests cover the complete transaction.
- Task 7 is the only completion gate. Earlier source success is not installed or provider acceptance.

## Specification Coverage

| Design requirement | Workflow task |
| --- | --- |
| Real failure diagnosis and ordinary generated images | 1, 7 |
| Exact rich capture, bounded schema and safe renderer | 2, 7 |
| Embedded media, shared assets, quota and tombstones | 2, 6, 7 |
| Durable action phases and no replay | 3, 4, 6 |
| Fixed IPC, accessible controls and truthful status | 5 |
| Local viewer, manual original and exact retry | 5, 6 |
| Recording Off, history, compaction and restart | 6 |
| Linux/Omarchy/package/installed/live acceptance | 7 |
