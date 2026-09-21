# ChatBBC Crystal Studio Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the superseded renderer paths, prove accessibility/performance/packaging/live behavior, align product contracts, and leave one maintainable Crystal Studio implementation.

**Architecture:** Treat Foundation, Workspace, and Rich Outputs as complete vertical slices. This plan deletes replaced presentation code only after symbol-aware reference checks, runs real Electron and packaged-runtime acceptance, updates authoritative contracts, and records exact evidence levels without changing release version or publishing.

**Tech Stack:** TypeScript/Electron, LSP references, Vitest, production verification scripts, electron-vite, electron-builder Linux packages, signed-in Chromium companion.

**Spec:** `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

## Global Constraints

- Requires Gates 1–3 and completed task commits from every prior plan.
- Delete superseded code and preferences; do not retain a classic shell, hidden fallback renderer, alias export, duplicate CSS owner, or migration branch after its one-time state migration.
- Preserve unrelated dirty work and all legacy platform-specific source/tests.
- Use LSP references before removing/renaming exported symbols and LSP rename for cross-file symbol/file renames.
- Do not weaken tests to match the redesign; remove only tests that assert obsolete implementation details and replace them with observable-contract checks.
- Do not bump versions, tag, publish, install, or create a release.
- Separate source, tests, build, package, installed payload, and signed-in behavior in the worklog.
- Run full validation only after focused smoke tests pass.

## Review Focus

1. No old shell, duplicated state cache, stale CSS owner, hidden preference, or dead IPC surface remains — Task 1.
2. Transparent and atmospheric modes have identical interaction geometry, readable first paint, and bounded idle work — Task 2.
3. Every new string, tool, permission, durable owner, lifecycle, and security boundary appears in authoritative contracts/docs — Task 3.
4. Packaged extension manifest and renderer assets match source; development build success alone is insufficient — Task 4.
5. Signed-in acceptance distinguishes confirmed choice/download/save behavior from unavailable or unconfirmed outcomes — Task 4.

---

### Task 1: Remove superseded renderer paths and temporary migration state

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/chat.ts`
- Modify: `src/renderer/session-list.ts`
- Modify: `src/renderer/styles/base.css`
- Modify: `src/renderer/styles/shell.css`
- Modify: `src/renderer/styles/transcript.css`
- Modify: `src/renderer/styles/composer.css`
- Modify: `src/renderer/styles/panels.css`
- Modify: `src/renderer/styles/pages.css`
- Modify: `src/renderer/styles/dialogs.css`
- Modify: `src/renderer/sidebar-resize.ts`
- Modify: `src/renderer/work-panel-resize.ts`
- Modify: affected `test/renderer-*.test.ts`
- Modify: affected `scripts/verify-*.cjs`

**Interfaces:**
- Consumes completed replacement components.
- Produces one renderer bootstrap, one presentation store, one shell, one conversation stage, and one workbench.

- [ ] **Step 1: Establish the deletion inventory with symbol-aware references**

For every candidate export/file/class/id, run LSP references first. Classify each as replaced,
still-owned, or compatibility data migration. Inspect the diff of each candidate by passing its exact
path to `git diff --`. Record the exact one-time localStorage migration keys; no runtime branch may remain after migration.

- [ ] **Step 2: Add/strengthen observable fail-first cutover tests**

```ts
it('mounts exactly one shell, timeline, composer, navigator, and workbench', () => {
  for (const selector of ['#appShell', '#timeline', '#composer', '#chatNavigator', '#contextWorkbench'])
    expect(document.querySelectorAll(selector), selector).toHaveLength(1);
});

it('does not remount the conversation stage while routing secondary destinations', () => {
  const stage = document.querySelector('#conversationStage');
  router.show('settings'); router.show('usage'); router.show('chats');
  expect(document.querySelector('#conversationStage')).toBe(stage);
});
```

Delete source-text/snapshot tests that only pin old classes or labels; do not repin them to new markup.

- [ ] **Step 3: Run focused tests before deletion**

Run: `npm test -- --run test/renderer-layout.test.ts test/renderer-state.test.ts test/renderer-nav.test.ts test/renderer-timeline.test.ts test/renderer-composer.test.ts test/renderer-work-panel.test.ts`

Expected: new behavior tests PASS while reference inventory still reports obsolete paths.

- [ ] **Step 4: Delete replaced paths and migrate preferences once**

Remove old topbar/sidebar/tab/classic-chat DOM, duplicated state variables/subscriptions, obsolete CSS,
manual Omarchy-refresh happy path, adjacency image grouping, and replaced component event listeners.
Migrate old sidebar/work-panel widths into the new keys on first read, then delete old keys immediately.
Remove aliases and compatibility exports after all callers compile.

- [ ] **Step 5: Verify one path remains**

Run:

```bash
npm test -- --run test/renderer-layout.test.ts test/renderer-state.test.ts test/renderer-nav.test.ts test/renderer-timeline.test.ts test/renderer-composer.test.ts test/renderer-work-panel.test.ts
npm run typecheck
npm run build
```

Expected: PASS; no duplicate listener, stale import, duplicate id, or old shell path.

- [ ] **Step 6: Commit**

```bash
git add src/renderer test scripts
git commit -m "refactor: remove the superseded renderer"
```

---

### Task 2: Prove accessibility, responsive layout, and bounded rendering cost

**Files:**
- Modify: `src/renderer/styles/base.css`
- Modify: `src/renderer/styles/shell.css`
- Modify: `src/renderer/styles/transcript.css`
- Modify: `src/renderer/styles/composer.css`
- Modify: `src/renderer/styles/panels.css`
- Modify: `test/renderer-layout.test.ts`
- Modify: `test/renderer-timeline.test.ts`
- Modify: `test/renderer-i18n.test.ts`
- Create: `scripts/verify-crystal-accessibility.cjs`
- Create: `scripts/verify-crystal-performance.cjs`
- Modify: `scripts/verify-crystal-shell.cjs`
- Modify: `scripts/verify-crystal-workspace.cjs`
- Modify: `scripts/verify-crystal-rich-outputs.cjs`

**Interfaces:**
- Consumes one cut-over renderer.
- Produces evidence for keyboard, focus, contrast, reduced motion, resize, zoom, virtualization, and idle behavior.

- [ ] **Step 1: Add fail-first boundary checks**

Add tests for 360 px narrow width, large zoom, high/low contrast Omarchy palettes, transparent/fallback
geometry equality, no horizontal transcript overflow, one vertical chat scroll owner, drawer focus
return, live region restraint, semantic names, reduced motion, and stage preservation.

- [ ] **Step 2: Run focused tests and observe failures**

Run: `npm test -- --run test/renderer-layout.test.ts test/renderer-timeline.test.ts test/renderer-i18n.test.ts`

- [ ] **Step 3: Fix source boundaries, not screenshots**

Repair tokens, layout ownership, containment, logical edges, focus ordering, and component lifecycle.
No magic per-string widths, fixed-height transcript cards, duplicate breakpoint state machine, polling,
or animation timer is allowed.

- [ ] **Step 4: Implement real Electron verification**

`verify-crystal-accessibility.cjs` drives keyboard-only navigation, focus return, form labels, drawer
traps, zoom, reduced motion, and semantic state text.

`verify-crystal-performance.cjs` uses production modules and Chromium performance metrics to prove:
settled hidden/static components schedule no recurring animation work; language/theme changes do not
retain detached rows; timeline resident/staging bounds hold; opening workbench does not remount the
transcript; native image hydration keeps reserved geometry.

- [ ] **Step 5: Run the visual/runtime acceptance set**

```bash
node scripts/verify-crystal-glass.cjs
node scripts/verify-crystal-shell.cjs
node scripts/verify-crystal-workspace.cjs
node scripts/verify-crystal-rich-outputs.cjs
node scripts/verify-crystal-accessibility.cjs
node scripts/verify-crystal-performance.cjs
node scripts/verify-chat-width.cjs
node scripts/verify-history-scroll.cjs
node scripts/verify-composer-layout.cjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/styles test/renderer-layout.test.ts test/renderer-timeline.test.ts test/renderer-i18n.test.ts scripts/verify-crystal-accessibility.cjs scripts/verify-crystal-performance.cjs scripts/verify-crystal-shell.cjs scripts/verify-crystal-workspace.cjs scripts/verify-crystal-rich-outputs.cjs
git commit -m "test: verify Crystal Studio accessibility and performance"
```

---

### Task 3: Align authoritative contracts, setup guidance, and worklog

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `docs/tool-surface.md`
- Modify: `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`
- Create: `docs/worklog-2026-09-21-crystal-studio.md`
- Modify: `test/mcp-tool-declarations.test.ts`
- Modify: `test/third-party-notices.test.ts` only if dependency evidence changed

**Interfaces:**
- Documents: renderer ownership, Omarchy watcher/window glass, rich action/download/asset ledgers, Core `generated_assets`, limits, cleanup, failure states, and evidence.

- [ ] **Step 1: Inventory contract changes against current source**

Trace the final symbols and tests for each new fact. Confirm owner/storage/lifetime/publication for:
Omarchy generation, glass mode, presentation store, destination/workbench projection, rich action,
static artifact, image set, human download, transfer claim, and generated asset handle.

- [ ] **Step 2: Update the product map in place**

Edit existing AGENTS sections rather than appending disconnected notes. Remove resolved gap language for
rich native actions only for families live-proved in this branch. Keep unsupported families explicit.
Add Core tool exposure/permission rules and generated-asset bounds to §6/§10/§12/§13/§18 as applicable.
Update the ownership table and current source alignment.

- [ ] **Step 3: Update user/developer documentation**

README describes the new shell without claiming universal compositor blur. Setup explains Omarchy live
follow and fallback. Tool surface documents exact `generated_assets` schemas, permission, original vs
preview, and failure outcomes. Do not add public screenshots containing private/account data.

- [ ] **Step 4: Write the focused worklog**

Record changed owners, exact tests/commands/output, source vs Electron vs package vs signed-in evidence,
known unsupported provider control families, and any unperformed installed-app validation. Mark design
spec status Implemented only after Task 4 succeeds; otherwise In implementation.

- [ ] **Step 5: Verify documentation contracts**

```bash
npm test -- --run test/mcp-tool-declarations.test.ts test/third-party-notices.test.ts
npm run verify:privacy
npm run verify:notices
```

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md docs/setup.md docs/tool-surface.md docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md docs/worklog-2026-09-21-crystal-studio.md test/mcp-tool-declarations.test.ts test/third-party-notices.test.ts
git commit -m "docs: document Crystal Studio ownership and evidence"
```

---

### Task 4: Run full review, build, package, and signed-in acceptance

**Files:**
- Modify: only files required by failures found in this task
- Modify: `docs/worklog-2026-09-21-crystal-studio.md`
- Modify: `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

**Interfaces:**
- Consumes the complete branch.
- Produces final evidence and a reviewed implementation; no release, install, tag, or publish.

- [ ] **Step 1: Request whole-branch code review before final claims**

Use `superpowers:requesting-code-review`. Review the full diff against the spec and all five program
review-focus races. Fix every Critical/Important finding at its owning boundary and rerun that finding's
nearest reproduction before continuing.

- [ ] **Step 2: Run complete source validation**

```bash
npm run typecheck
npm test -- --run
npm run verify:privacy
npm run verify:notices
npm run verify
npm run build
```

Expected: every command exits 0. Record command, exit, and relevant summary in the worklog.

- [ ] **Step 3: Build and smoke Linux packages**

Because BrowserWindow transparency, renderer resources, and extension manifest/permissions differ by
packaging layer, run:

```bash
npm run dist
```

Inspect the assembled x64/arm64 resources for the changed renderer, extension manifest, and packaged
native runtime through the repository's existing smoke scripts. Do not install or publish.

- [ ] **Step 4: Run final Omarchy/Hyprland acceptance**

In the development app, switch between at least two real Omarchy themes and light/dark modes; verify
immediate generation-safe repaint, window blur where compositor support exists, readable atmospheric
fallback, no geometry/focus loss, and correct Settings status. Record actual compositor evidence.

- [ ] **Step 5: Run final signed-in provider acceptance**

Reload the changed extension and exercise:
- supported rich choice with observed exact postcondition;
- changed/stale choice refusal;
- semantic and static artifact display;
- image-only and multi-image response grouping;
- one original download, one download-all, one cancelled/unknown download;
- `generated_assets list`, original save, preview save, root revocation, and destination race;
- browser navigation/closure around each mutation.

Unsupported provider structures remain inert and are named in the worklog. Do not claim installed-app
or account-family coverage not actually exercised.

- [ ] **Step 6: Mark documents complete and run completion verification**

Update the worklog with final output and the design spec status to Implemented/Verified at the exact
achieved evidence level. Use `superpowers:verification-before-completion`; rerun any command it requires.

- [ ] **Step 7: Commit final evidence/fixes**

```bash
git add docs/worklog-2026-09-21-crystal-studio.md docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md
git commit -m "test: complete Crystal Studio acceptance"
```
