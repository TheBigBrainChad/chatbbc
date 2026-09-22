# ChatBBC Crystal Studio Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every existing workspace workflow into the chat-centric Adaptive Studio shell while preserving exact session, draft, queue, project, terminal, worker, and async-selection ownership.

**Architecture:** Convert current renderer modules into explicit controllers/components backed by the Foundation presentation store. The conversation stage remains mounted; secondary destinations and the contextual workbench project existing backend facts without creating alternate ledgers.

**Tech Stack:** TypeScript, vanilla DOM/CSS, existing fixed preload IPC, CodeMirror, xterm, PDF.js, Vitest/jsdom, real Electron verification scripts.

**Spec:** `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

## Global Constraints

- Requires every Foundation task and Gate 1 review.
- Keep existing element identities until their complete owning component cutover; remove obsolete ids/classes only in the same task that migrates every caller/test.
- Conversation and composer stay mounted while the workbench opens, closes, or changes tenant.
- Session/project/browser/terminal/input ownership remains in main/shared modules.
- Preserve history pagination, immutable origins, viewport reserve, draft generations, native attachment staging, queue receipts, Goal/Loop, plans, recovery, and model selection.
- Workbench presentation may be optimistic only about opening/closing; data mutation waits for main receipts.
- Every async result rechecks component instance, selected session/project, and load generation.
- New copy goes through all locale catalogs.

## Review Focus

1. Rapid A → B → A chat selection must discard both stale A and B loads while opening the newest A at its correct viewport — Tasks 1–2.
2. A late attachment/file import must remain with the captured draft owner and never attach to a newer chat — Task 3.
3. Switching Files → Terminal → Agents must preserve unsaved editor drafts and live PTYs without retargeting them — Task 4.
4. Settings state pushes during dirty HEX/select edits must update surrounding UI without clobbering edits — Task 5.
5. Narrow-layout drawers and focus restoration must not move composer focus during ordinary live session updates — Task 6.

---

### Task 1: Turn the session list into the chat navigator and global rail

**Files:**
- Modify: `src/renderer/session-list.ts`
- Create: `src/renderer/chat-navigator.ts`
- Modify: `src/renderer/sidebar-order.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/chat.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles/shell.css`
- Test: `test/renderer-nav.test.ts`
- Test: `test/renderer-state.test.ts`
- Test: `test/renderer-chat-split.test.ts`
- Modify: `scripts/verify-sidebar-setup.cjs`

**Interfaces:**
- Consumes: `PresentationStore`, existing session/project rows, sidebar ordering, and stable `(updatedAt,id)` paging.
- Produces: `createChatNavigator(options): ChatNavigator` with `update(view)`, `focusSearch()`, `openProject(id)`, and `dispose()`.
- Produces: `NavigatorRow` discriminated as project, chat, worker, image-set, file, or empty state.

- [ ] **Step 1: Write fail-first navigator projection tests**

```ts
it('keeps chats primary and scopes worker identities to their prime family', () => {
  const rows = navigatorRows({ sessions, projects, query: '', selectedSessionId: 'prime-a' });
  expect(rows.filter(row => row.kind === 'chat').map(row => row.sessionId)).toEqual(['prime-a', 'chat-b']);
  expect(rows.filter(row => row.kind === 'worker').map(row => row.key)).toEqual(['run-a:worker-1']);
});

it('ranks authored chat previews before file and image-set matches', () => {
  const rows = navigatorRows({ ...fixture, query: 'aurora' });
  expect(rows.map(row => row.kind)).toEqual(['chat', 'file', 'image-set']);
});
```

Add A → B → A selection, partial session pages, project removal/regroup, drag clamp, and selected
off-page worker-child tests.

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- --run test/renderer-nav.test.ts test/renderer-state.test.ts test/renderer-chat-split.test.ts`

Expected: FAIL because `ChatNavigator`/ranked rows do not exist.

- [ ] **Step 3: Implement the navigator component**

```ts
export interface ChatNavigator {
  update(view: ChatNavigatorView): void;
  focusSearch(): void;
  openProject(projectId: string | null): void;
  dispose(): void;
}
export function navigatorRows(view: ChatNavigatorView): NavigatorRow[];
```

Reuse `session-list.ts` row builders and `sidebar-order.ts`; do not duplicate pagination or reorder
storage. Search uses bounded loaded session preview/title data plus currently loaded project file and
image-set metadata. It never reads history or disk directly.

- [ ] **Step 4: Wire rail destinations**

Chats activates the conversation stage. Files/Agents open the matching workbench tenant while keeping
Chats selected as the active workspace. Usage and Settings activate their existing full-page panels.
Retire the current Settings-only `#tabs` semantics after migrating every caller.

- [ ] **Step 5: Verify behavior and real pointer/keyboard flow**

Run:

```bash
npm test -- --run test/renderer-nav.test.ts test/renderer-state.test.ts test/renderer-chat-split.test.ts
node scripts/verify-sidebar-setup.cjs
npm run typecheck
```

Acceptance: projects/chats/workers remain correctly grouped; navigator search is bounded; selection
identity survives live pushes; repeated activation does not reload the visible chat or steal focus.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/chat-navigator.ts src/renderer/session-list.ts src/renderer/sidebar-order.ts src/renderer/main.ts src/renderer/chat.ts src/renderer/index.html src/renderer/styles/shell.css test/renderer-nav.test.ts test/renderer-state.test.ts test/renderer-chat-split.test.ts scripts/verify-sidebar-setup.cjs
git commit -m "feat: add the Crystal chat navigator"
```

---

### Task 2: Extract the conversation stage and preserve timeline behavior

**Files:**
- Create: `src/renderer/conversation-stage.ts`
- Create: `src/renderer/timeline-view.ts`
- Modify: `src/renderer/chat.ts`
- Modify: `src/renderer/timeline-scroll.ts`
- Modify: `src/renderer/transcript-categories.ts`
- Modify: `src/renderer/session-spine.ts`
- Modify: `src/renderer/styles/transcript.css`
- Test: `test/renderer-timeline.test.ts`
- Test: `test/timeline-scroll.test.ts`
- Test: `test/renderer-chat-split.test.ts`
- Modify: `scripts/verify-history-scroll.cjs`
- Modify: `scripts/verify-chat-opening-scroll.cjs`
- Modify: `scripts/verify-chat-width.cjs`

**Interfaces:**
- Consumes: selected session/generation from the store, current session page IPC, chronology, spine, and viewport owner.
- Produces: `createConversationStage(options): ConversationStage` and `TimelineView.update(page, generation)`.
- Produces: `focusOrigin(origin)` for rich focus return; it does not load foreign history.

- [ ] **Step 1: Write fail-first stage and stale-load tests**

```ts
it('discards stale A and B pages in an A → B → A switch', async () => {
  const stage = createConversationStage(fixture);
  stage.select('A', 1); stage.select('B', 2); stage.select('A', 3);
  resolveLoad('B', pageB); resolveLoad('A:1', oldPageA); resolveLoad('A:3', newPageA);
  await settle();
  expect(stage.current()).toMatchObject({ sessionId: 'A', generation: 3 });
  expect(timelineText()).toContain('new A');
  expect(timelineText()).not.toContain('old A');
});
```

Retain tests for immutable origin paging, live revisions, dense collapsed activity, frontend spine,
off-tail browsing, and selection-generation focus return.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- --run test/renderer-timeline.test.ts test/timeline-scroll.test.ts test/renderer-chat-split.test.ts`

Expected: FAIL because stage/view interfaces are absent.

- [ ] **Step 3: Move presentation, not authority**

Move row reconciliation, paging projection, focus-by-origin, and timeline DOM ownership from `chat.ts`
into `timeline-view.ts`. Keep session loading/commands in the controller layer. Implement:

```ts
export interface ConversationStage {
  select(sessionId: string | null, generation: number): void;
  update(page: SessionDetail, generation: number): void;
  focusOrigin(origin: number): boolean;
  dispose(): void;
}
```

Use immutable origins for location and revision sequence only for updates. Preserve all existing
viewport reserve and bounded resident-page logic.

- [ ] **Step 4: Apply Crystal transcript language**

Assistant prose is borderless/readable, user messages are compact accent glass, and tool activity
retains the chronological activity rail. Keep semantic categories, exact outcomes, plan, queue,
recovery, and continuation cards. Theme changes update tokens only; they do not replace rows.

- [ ] **Step 5: Verify DOM and real Electron history behavior**

Run:

```bash
npm test -- --run test/renderer-timeline.test.ts test/timeline-scroll.test.ts test/renderer-chat-split.test.ts
node scripts/verify-history-scroll.cjs
node scripts/verify-chat-opening-scroll.cjs
node scripts/verify-chat-width.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/conversation-stage.ts src/renderer/timeline-view.ts src/renderer/chat.ts src/renderer/timeline-scroll.ts src/renderer/transcript-categories.ts src/renderer/session-spine.ts src/renderer/styles/transcript.css test/renderer-timeline.test.ts test/timeline-scroll.test.ts test/renderer-chat-split.test.ts scripts/verify-history-scroll.cjs scripts/verify-chat-opening-scroll.cjs scripts/verify-chat-width.cjs
git commit -m "refactor: extract the conversation stage"
```

---

### Task 3: Move composer, outbox, plans, and recovery into the stage

**Files:**
- Create: `src/renderer/composer-controller.ts`
- Modify: `src/renderer/chat.ts`
- Modify: `src/renderer/outbox-view.ts`
- Modify: `src/renderer/composer-status-line.ts`
- Modify: `src/renderer/message-lifecycle.ts`
- Modify: `src/renderer/agent-plan.ts`
- Modify: `src/renderer/recovery.ts`
- Modify: `src/renderer/chat-models.ts`
- Modify: `src/renderer/skills.ts`
- Modify: `src/renderer/styles/composer.css`
- Test: `test/renderer-composer.test.ts`
- Test: `test/renderer-agent-plan.test.ts`
- Test: `test/renderer-recovery.test.ts`
- Test: `test/session-input-images.test.ts`
- Modify: `scripts/verify-composer-layout.cjs`
- Modify: `scripts/verify-input-queue.cjs`
- Modify: `scripts/verify-goal-status-layout.cjs`

**Interfaces:**
- Consumes: existing draft owner/generation, input/outbox APIs, model/Goal/Loop selection, attachments, skills, plans, and recovery projections.
- Produces: `ComposerController.update(owner, state)`, `focus()`, `replaceDraft()`, and `dispose()`.

- [ ] **Step 1: Add fail-first owner and late-result tests**

```ts
it('rejects a late attachment import after draft owner replacement', async () => {
  const composer = createComposerController(fixture);
  composer.update(owner('A', 1), stateA);
  const importA = composer.importFiles(files);
  composer.update(owner('B', 2), stateB);
  resolveImport(importA, attachmentsA);
  await settle();
  expect(composer.currentDraft().attachments).toEqual([]);
});
```

Cover New Chat per-project drafts, plan result after navigation, queue/history reconciliation, direct
correction delivery modes, image injection, model picker, Goal/Loop, IME, and dirty text during state
pushes.

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- --run test/renderer-composer.test.ts test/renderer-agent-plan.test.ts test/renderer-recovery.test.ts test/session-input-images.test.ts`

Expected: FAIL because the controller interface is absent.

- [ ] **Step 3: Implement the composer controller**

```ts
export interface ComposerController {
  update(owner: ComposerDraftOwner, view: ComposerView): void;
  focus(): void;
  replaceDraft(next: DraftSnapshot): void;
  dispose(): void;
}
```

Move event ownership from `chat.ts`; retain existing `outbox-view`, status-line, plan, recovery,
model, skills, and attachment owners. Do not create a second draft object or queue cache.

- [ ] **Step 4: Restyle without changing delivery semantics**

Place queue/plan/recovery cards chronologically and keep one anchored floating Crystal composer.
Expose delivery, model, Goal/Loop, attachments, skills, and context without hiding truthful states.
CSS field sizing remains the composer height owner.

- [ ] **Step 5: Verify focused and real layout behavior**

Run:

```bash
npm test -- --run test/renderer-composer.test.ts test/renderer-agent-plan.test.ts test/renderer-recovery.test.ts test/session-input-images.test.ts
node scripts/verify-composer-layout.cjs
node scripts/verify-input-queue.cjs
node scripts/verify-goal-status-layout.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/composer-controller.ts src/renderer/chat.ts src/renderer/outbox-view.ts src/renderer/composer-status-line.ts src/renderer/message-lifecycle.ts src/renderer/agent-plan.ts src/renderer/recovery.ts src/renderer/chat-models.ts src/renderer/skills.ts src/renderer/styles/composer.css test/renderer-composer.test.ts test/renderer-agent-plan.test.ts test/renderer-recovery.test.ts test/session-input-images.test.ts scripts/verify-composer-layout.cjs scripts/verify-input-queue.cjs scripts/verify-goal-status-layout.cjs
git commit -m "refactor: move composer into the conversation stage"
```

---

### Task 4: Expand the contextual workbench without recreating tenants

**Files:**
- Modify: `src/renderer/work-panel.ts`
- Modify: `src/renderer/work-panel-resize.ts`
- Modify: `src/renderer/file-panel.ts`
- Modify: `src/renderer/file-code-editor.ts`
- Modify: `src/renderer/agent-panel.ts`
- Modify: `src/renderer/workspace-terminal.ts`
- Create: `src/renderer/output-inspector.ts`
- Modify: `src/renderer/styles/panels.css`
- Test: `test/renderer-work-panel.test.ts`
- Test: `test/renderer-file-panel.test.ts`
- Test: `test/renderer-agent-panel.test.ts`
- Test: `test/workspace-terminal.test.ts`
- Modify: `scripts/verify-work-panel-terminal.cjs`
- Modify: `scripts/verify-workspace-terminal.cjs`

**Interfaces:**
- Extends `WorkTab` to `'files' | 'agents' | 'terminal' | 'inspector' | 'plan' | 'session'`.
- Produces: `WorkbenchSelection { tab; ownerKey; origin?: number; payloadId?: string }`.
- Consumes existing tenant `show/hide/available` interfaces; tenant state remains in each feature.

- [ ] **Step 1: Write fail-first preservation and exact-owner tests**

```ts
it('preserves editor draft and PTY while switching tenants', () => {
  panel.show('files'); typeUnsaved('changed');
  panel.show('terminal'); terminal.write('echo alive');
  panel.show('agents'); panel.show('files');
  expect(editor.value()).toBe('changed');
  panel.show('terminal'); expect(terminal.output()).toContain('alive');
});

it('rejects an inspector payload from a replaced transcript origin', async () => {
  // select A/origin 8, switch to B, resolve A detail
  expect(inspector.isEmpty()).toBe(true);
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- --run test/renderer-work-panel.test.ts test/renderer-file-panel.test.ts test/renderer-agent-panel.test.ts test/workspace-terminal.test.ts`

Expected: FAIL for new tenants/selection identity.

- [ ] **Step 3: Extend the one existing panel owner**

Keep `createWorkPanel()` as the one visibility owner. Add `select(selection)` and `close()`; reuse the
same File, Agent, and Terminal elements. `output-inspector.ts` renders metadata/actions for the exact
selected message/image/artifact without loading another session.

- [ ] **Step 4: Apply split/overlay behavior**

Wide mode uses the resizable workbench; medium/narrow uses the shell overlay. Preserve pane DOM,
watchers, editor drafts, and PTYs when hidden. Escape closes workbench and returns focus to the exact
trigger. Project/session changes invoke tenant-owned guards before replacement.

- [ ] **Step 5: Verify tenants and real Electron behavior**

Run:

```bash
npm test -- --run test/renderer-work-panel.test.ts test/renderer-file-panel.test.ts test/renderer-agent-panel.test.ts test/workspace-terminal.test.ts
node scripts/verify-work-panel-terminal.cjs
node scripts/verify-workspace-terminal.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/work-panel.ts src/renderer/work-panel-resize.ts src/renderer/file-panel.ts src/renderer/file-code-editor.ts src/renderer/agent-panel.ts src/renderer/workspace-terminal.ts src/renderer/output-inspector.ts src/renderer/styles/panels.css test/renderer-work-panel.test.ts test/renderer-file-panel.test.ts test/renderer-agent-panel.test.ts test/workspace-terminal.test.ts scripts/verify-work-panel-terminal.cjs scripts/verify-workspace-terminal.cjs
git commit -m "feat: expand the contextual workbench"
```

---

### Task 5: Migrate Settings, Setup, Plugins, Usage, dialogs, and notifications

**Files:**
- Create: `src/renderer/destination-router.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/plugins.ts`
- Modify: `src/renderer/usage.ts`
- Modify: `src/renderer/setup-guide.ts`
- Modify: `src/renderer/appearance.ts`
- Modify: `src/renderer/connection-popover.ts`
- Modify: `src/renderer/plugin-refresh-reminder.ts`
- Modify: `src/renderer/tool-approval.ts`
- Modify: `src/renderer/styles/pages.css`
- Modify: `src/renderer/styles/dialogs.css`
- Test: `test/renderer-nav.test.ts`
- Test: `test/renderer-usage.test.ts`
- Test: `test/renderer-state.test.ts`
- Modify: `scripts/verify-appearance.cjs`
- Modify: `scripts/verify-setup-guide.cjs`
- Modify: `scripts/verify-settings-focus.cjs`
- Modify: `scripts/verify-dropdown-layout.cjs`

**Interfaces:**
- Produces: `Destination = 'chats' | 'files' | 'agents' | 'usage' | 'settings'`.
- Produces: `createDestinationRouter({ shell, store }): DestinationRouter`.
- Consumes existing feature modules and current Settings three-way merge.

- [ ] **Step 1: Add fail-first destination/focus tests**

```ts
it('returns to the same chat without reloading it after Settings', () => {
  router.show('chats'); const timeline = document.querySelector('#timeline');
  router.show('settings'); router.show('chats');
  expect(document.querySelector('#timeline')).toBe(timeline);
});

it('does not overwrite a dirty appearance field on a state push', () => {
  focusAndType('#appearance-accent-hex', '#123456');
  pushState(newerUnrelatedConfig);
  expect(value('#appearance-accent-hex')).toBe('#123456');
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- --run test/renderer-nav.test.ts test/renderer-usage.test.ts test/renderer-state.test.ts`

Expected: FAIL because the destination router is absent.

- [ ] **Step 3: Implement one router and reuse feature modules**

The router changes stage presentation and rail selection only. Usage lazy loading, plugin manager,
Setup disclosure state, Appearance merge, connection popover, and notices keep their existing owners.
Settings sections become workbench-friendly Crystal cards without changing IPC contracts.

- [ ] **Step 4: Migrate dialogs and top-layer surfaces**

Use Crystal high-glass surfaces with readable opaque fallback. Preserve native customizable select,
focus trap/return, trusted clicks, dirty fields, and stacking rules. No dialog may be clipped by the
transparent window shell.

- [ ] **Step 5: Verify feature surfaces in real Electron**

Run:

```bash
npm test -- --run test/renderer-nav.test.ts test/renderer-usage.test.ts test/renderer-state.test.ts
node scripts/verify-appearance.cjs
node scripts/verify-setup-guide.cjs
node scripts/verify-settings-focus.cjs
node scripts/verify-dropdown-layout.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/destination-router.ts src/renderer/main.ts src/renderer/index.html src/renderer/plugins.ts src/renderer/usage.ts src/renderer/setup-guide.ts src/renderer/appearance.ts src/renderer/connection-popover.ts src/renderer/plugin-refresh-reminder.ts src/renderer/tool-approval.ts src/renderer/styles/pages.css src/renderer/styles/dialogs.css test/renderer-nav.test.ts test/renderer-usage.test.ts test/renderer-state.test.ts scripts/verify-appearance.cjs scripts/verify-setup-guide.cjs scripts/verify-settings-focus.cjs scripts/verify-dropdown-layout.cjs
git commit -m "feat: migrate secondary surfaces to Crystal Studio"
```

---

### Task 6: Complete workspace accessibility, localization, and ordinary-flow proof

**Files:**
- Modify: `src/renderer/i18n.ts`
- Modify: `src/renderer/locales/es.json`
- Modify: `src/renderer/locales/zh-CN.json`
- Modify: `src/renderer/locales/zh-TW.json`
- Verify: `src/renderer/styles/base.css` (reduced motion already removes animation, transition, and smooth scrolling; do not rewrite that rule)
- Modify: `src/renderer/styles/shell.css`
- Modify: `src/renderer/styles/transcript.css`
- Modify: `src/renderer/styles/composer.css`
- Modify: `src/renderer/styles/panels.css`
- Test: `test/renderer-i18n.test.ts`
- Test: `test/renderer-i18n-es.test.ts`
- Test: `test/renderer-i18n-tw.test.ts`
- Test: `test/renderer-layout.test.ts`
- Modify: `scripts/verify-renderer-label-memory.cjs`
- Create: `scripts/verify-crystal-workspace.cjs`

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: a complete ordinary workspace flow inside one shell, ready for rich-output component replacement.

- [ ] **Step 1: Add fail-first keyboard/locale/reduced-motion checks**

Test rail and drawer keyboard traversal, focus return, enlarged zoom, RTL authored prose, LTR shell,
new string coverage in every locale, detached label collection, and reduced-motion removal of
nonessential animations.

```ts
expect(missingLocaleKeys('es')).toEqual([]);
expect(missingLocaleKeys('zh-CN')).toEqual([]);
expect(missingLocaleKeys('zh-TW')).toEqual([]);
expect(document.activeElement).toBe(openWorkbenchButton);
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- --run test/renderer-i18n.test.ts test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts test/renderer-layout.test.ts`

- [ ] **Step 3: Complete accessibility and localization fixes**

Add missing `t()` bindings/translations, roving tabindex, focus return, logical edges, visible
non-color focus, aria-live restraint, and reduced-motion rules. Verify the existing base.css
reduced-motion rule; do not rewrite it when those three declarations are already present. Do not translate authored/provider
content or retain detached nodes outside the existing WeakMap.

- [ ] **Step 4: Exercise the complete ordinary flow**

`scripts/verify-crystal-workspace.cjs` must launch production renderer modules and use real Chromium
input to: open project chat, send/edit a draft, open queue/plan, page history, switch A → B → A, open
Files, preserve an editor draft, use Terminal, inspect Agents, visit Settings/Usage, switch locale,
and return to the same transcript/scroll/focus.

- [ ] **Step 5: Run the Workspace acceptance set**

```bash
npm test -- --run test/renderer-i18n.test.ts test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts test/renderer-layout.test.ts
node scripts/verify-renderer-label-memory.cjs
node scripts/verify-crystal-workspace.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/i18n.ts src/renderer/locales src/renderer/styles test/renderer-i18n.test.ts test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts test/renderer-layout.test.ts scripts/verify-renderer-label-memory.cjs scripts/verify-crystal-workspace.cjs
git commit -m "feat: complete the Crystal workspace flow"
```
