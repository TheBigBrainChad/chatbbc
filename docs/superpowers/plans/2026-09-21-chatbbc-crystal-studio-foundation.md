# ChatBBC Crystal Studio Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Crystal semantic tokens, immediate Omarchy synchronization, truthful Linux transparency, and the framework-free Adaptive Studio shell without changing product ownership.

**Architecture:** Extend the existing pure appearance owner, add one coalesced main-process Omarchy observer, derive transparent-window behavior through one platform helper, and mount the existing feature surfaces inside a new static four-zone shell. Renderer state remains a projection of validated IPC state.

**Tech Stack:** Electron 44, TypeScript 7, Node filesystem observation, vanilla DOM/CSS, Vitest/jsdom, real Electron verification.

**Spec:** `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

## Global Constraints

- Preserve current config fields and manual appearance values; following Omarchy never overwrites saved palettes.
- `src/shared/appearance.ts` remains the sole palette-to-token projection.
- One Omarchy owner reads `colors.toml`, `theme.name`, and terminal-font materialization; no renderer filesystem access.
- Never edit Hyprland or Omarchy user/system configuration.
- Linux native transparency is progressive enhancement; startup and fallback must remain readable.
- Keep context isolation, sandbox, web security, fixed preload methods, and current platform-specific window behavior.
- No framework dependency and no second renderer state ledger.
- New strings must use `t()` and all locale catalogs.

## Review Focus

1. A theme switch implemented as multiple renames/creates must publish one complete newest snapshot, not a transient null palette — Task 2.
2. A stale async theme read must not repaint over a newer generation — Task 2.
3. Hyprland absent, blur disabled, or detection timeout must produce atmospheric fallback with a readable native backing — Task 3.
4. A state push arriving while Appearance fields are dirty must repaint the shell without overwriting the dirty controls — Tasks 2 and 4.
5. Shell remount/reload must not duplicate subscriptions, lose selected session identity, or leave a click-through transparent window — Tasks 4–5.

---

### Task 1: Add Crystal semantic palette tokens

**Files:**
- Modify: `src/shared/appearance.ts`
- Modify: `src/renderer/appearance.ts`
- Modify: `src/renderer/styles/base.css`
- Test: `test/appearance.test.ts`

**Interfaces:**
- Consumes: existing `paletteTokens(background, accent, contrast, status)` and contrast helpers.
- Produces: the existing token map plus `--canvas`, `--canvas-atmosphere`, `--glass-low`, `--glass-medium`, `--glass-high`, `--glass-readable`, `--ink-muted`, `--ink-on-accent`, `--accent-readable`, `--accent-glow`, `--hairline`, `--shadow`, and `--scrim`.

- [ ] **Step 1: Add fail-first token and contrast tests**

```ts
it('derives the complete Crystal token family from one palette', () => {
  const tokens = paletteTokens('#14101d', '#c8a6ff', 60, { green: '#8ee7de', red: '#ff7898' });
  expect(tokens).toMatchObject({
    '--canvas': '#14101d',
    '--ink-on-accent': readableInk('#c8a6ff')
  });
  for (const name of ['--canvas-atmosphere', '--glass-low', '--glass-medium', '--glass-high',
    '--glass-readable', '--ink-muted', '--accent-readable', '--accent-glow', '--hairline',
    '--shadow', '--scrim']) expect(tokens[name], name).toBeTruthy();
  expect(contrastRatio(tokens['--accent-readable']!, tokens['--canvas']!)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(tokens['--ink']!, tokens['--glass-readable']!)).toBeGreaterThanOrEqual(4.5);
});
```

- [ ] **Step 2: Run the test and observe RED**

Run: `npm test -- --run test/appearance.test.ts`

Expected: FAIL because Crystal token keys are absent.

- [ ] **Step 3: Extend the pure token projection**

Add one helper for alpha-bearing surfaces and keep readable text surfaces opaque:

```ts
function alpha(hex: string, value: number): string {
  return `${hex}${Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')}`;
}

// Inside paletteTokens:
const glassReadable = mixColor(background, ink, .07 + .09 * c);
return {
  ...existing,
  '--canvas': background,
  '--canvas-atmosphere': mixColor(background, accent, .08),
  '--glass-low': alpha(mixColor(background, accent, .04), .54),
  '--glass-medium': alpha(mixColor(background, accent, .07), .68),
  '--glass-high': alpha(mixColor(background, accent, .10), .82),
  '--glass-readable': glassReadable,
  '--ink-muted': readableTint(mixColor(background, ink, .58), glassReadable, 4.5),
  '--ink-on-accent': readableInk(accent),
  '--accent-readable': readableTint(accent, background, 4.5),
  '--accent-glow': alpha(accent, .34),
  '--hairline': alpha(ink, .14),
  '--shadow': alpha('#000000', readableInk(background) === '#ffffff' ? .42 : .18),
  '--scrim': alpha('#000000', .55)
};
```

Update base fallbacks to the built-in Crystal dark/light values while retaining every old token until final cutover.

- [ ] **Step 4: Verify token and renderer appearance behavior**

Run: `npm test -- --run test/appearance.test.ts test/renderer-styles.test.ts`

Expected: PASS; manual palettes and followed palettes produce complete readable token maps.

- [ ] **Step 5: Commit**

```bash
git add src/shared/appearance.ts src/renderer/appearance.ts src/renderer/styles/base.css test/appearance.test.ts
git commit -m "feat: add Crystal appearance tokens"
```

---

### Task 2: Make Omarchy theme observation immediate and generation-safe

**Files:**
- Modify: `src/main/omarchy-theme.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/appearance.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/locales/es.json`
- Modify: `src/renderer/locales/zh-CN.json`
- Modify: `src/renderer/locales/zh-TW.json`
- Test: `test/omarchy-theme.test.ts`
- Test: `test/appearance.test.ts`
- Test: `test/renderer-state.test.ts`

**Interfaces:**
- Produces: `OmarchyThemeState { generation: number; theme: OmarchyTheme | null; diagnostic: string | null }`.
- Produces: `startOmarchyThemeObservation(options): () => void`, `currentOmarchyThemeState()`, and `onOmarchyThemeChange(listener): () => void`.
- Consumes: existing `state:changed` publication and renderer dirty-field protection.

- [ ] **Step 1: Write fail-first watcher tests with rename bursts**

```ts
it('coalesces a theme replacement and publishes only the complete newest snapshot', async () => {
  const changes: OmarchyThemeState[] = [];
  const stop = startOmarchyThemeObservation({ home, debounceMs: 40, onChange: state => changes.push(state) });
  await replaceThemeFiles(home, { name: 'Crystal Test', background: '#101218', accent: '#b99aff' });
  await vi.advanceTimersByTimeAsync(80);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ generation: 2, theme: { name: 'Crystal Test', background: '#101218' }, diagnostic: null });
  stop();
});

it('retains the last valid theme through a transient missing file', async () => {
  // remove colors.toml, emit watcher event, restore it inside the debounce window
  expect(currentOmarchyThemeState().theme?.name).toBe('Restored');
});
```

Also test listener disposal, oversized/corrupt input, two rapid generations, and no Omarchy directory.

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `npm test -- --run test/omarchy-theme.test.ts test/appearance.test.ts test/renderer-state.test.ts`

Expected: FAIL because observation/state generation APIs do not exist.

- [ ] **Step 3: Implement one coalesced owner**

Keep bounded parsing in `readOmarchyTheme()`. Add a singleton owner around an injectable factory:

```ts
export interface OmarchyThemeState {
  generation: number;
  theme: OmarchyTheme | null;
  diagnostic: string | null;
}
export function startOmarchyThemeObservation(options?: {
  home?: string; debounceMs?: number; onChange?: (state: OmarchyThemeState) => void;
}): () => void;
export function currentOmarchyThemeState(): OmarchyThemeState;
export function onOmarchyThemeChange(listener: (state: OmarchyThemeState) => void): () => void;
```

Watch the stable parent directories rather than an individual replaceable inode. Debounce 75 ms,
read all files into one candidate, increment generation only for a changed complete snapshot, retain
the previous theme on malformed/transient input, and close watchers/timers during shutdown.

- [ ] **Step 4: Publish through the existing state flow**

Change `AppState.omarchy` to `OmarchyThemeState`; use `state.theme` in existing appearance helpers.
Subscribe `pushState` and native chrome refresh to `onOmarchyThemeChange`. Replace manual-refresh copy
with live-sync copy; keep the button as an explicit retry only when a diagnostic is present.

- [ ] **Step 5: Verify tests and a throwaway live file switch**

Run:

```bash
npm test -- --run test/omarchy-theme.test.ts test/appearance.test.ts test/renderer-state.test.ts
npm run typecheck
```

Then run the app with an isolated HOME fixture, replace the three materialized files, and observe one
new state generation without losing a focused dirty HEX field.

- [ ] **Step 6: Commit**

```bash
git add src/main/omarchy-theme.ts src/main/ipc.ts src/main/index.ts src/shared/types.ts src/preload/index.ts src/renderer/main.ts src/renderer/appearance.ts src/renderer/index.html src/renderer/locales test/omarchy-theme.test.ts test/appearance.test.ts test/renderer-state.test.ts
git commit -m "feat: follow Omarchy theme changes live"
```

---

### Task 3: Add truthful transparent-window and fallback ownership

**Files:**
- Create: `src/main/window-glass.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/window-layout.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/appearance.ts`
- Modify: `src/renderer/styles/base.css`
- Modify: `src/renderer/styles/shell.css`
- Test: `test/window-glass.test.ts`
- Test: `test/window-layout.test.ts`
- Create: `scripts/verify-crystal-glass.cjs`

**Interfaces:**
- Produces: `GlassSupport { mode: 'hyprland-blur' | 'transparent' | 'atmospheric'; transparent: boolean; diagnostic: string | null }`.
- Produces: `windowGlassOptions(platform, env, support)` and `detectGlassSupport(options)`.
- Consumes: Crystal tokens and the stable `com.chatbbc.app` desktop/window identity.

- [ ] **Step 1: Write fail-first platform/failure tests**

```ts
it('uses transparent Linux options only for a positive supported environment', () => {
  expect(windowGlassOptions('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'owned' }, { mode: 'hyprland-blur', transparent: true, diagnostic: null }))
    .toMatchObject({ transparent: true, backgroundColor: '#00000000' });
});

it.each(['win32', 'darwin'] as const)('keeps legacy %s window behavior', platform => {
  expect(windowGlassOptions(platform, {}, { mode: 'atmospheric', transparent: false, diagnostic: null }).transparent).toBeUndefined();
});

it('falls back when hyprctl times out or reports blur disabled', async () => {
  expect((await detectGlassSupport({ platform: 'linux', env: {}, run: rejectingRunner })).mode).toBe('atmospheric');
});
```

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test -- --run test/window-glass.test.ts test/window-layout.test.ts`

Expected: FAIL because `window-glass.ts` does not exist.

- [ ] **Step 3: Implement bounded detection and constructor options**

Use an injected `execFile` wrapper to query `hyprctl getoption decoration:blur:enabled -j` with a
one-second timeout and bounded stdout. Never issue a Hyprland mutation. Treat absence, malformed JSON,
disabled blur, timeout, and non-Linux as atmospheric fallback. A positive Hyprland environment with
blur disabled may use transparent mode only if the worst-case backing remains readable.

Apply `transparent: true` and `backgroundColor: '#00000000'` only from `windowGlassOptions`; otherwise
retain `windowBackgroundForTheme`. Keep a renderer boot backing until `did-finish-load` and the first
complete appearance paint acknowledge readiness.

- [ ] **Step 4: Publish truthful mode and style the fallback**

Add `glass: GlassSupport` to `AppState`. Set `data-glass-mode` on `<html>`. Native modes use transparent
Crystal layers; atmospheric mode paints `--canvas-atmosphere`. Do not use `pointer-events: none` on the
window root.

- [ ] **Step 5: Verify tests and real Electron surface**

Run:

```bash
npm test -- --run test/window-glass.test.ts test/window-layout.test.ts test/renderer-layout.test.ts
node scripts/verify-crystal-glass.cjs
npm run typecheck
```

The script launches isolated Electron twice: atmospheric fallback and a fixture-positive transparent
mode. It asserts readable first paint, window hit testing, reload backing, and no layout delta.

- [ ] **Step 6: Commit**

```bash
git add src/main/window-glass.ts src/main/index.ts src/main/ipc.ts src/main/window-layout.ts src/shared/types.ts src/renderer/appearance.ts src/renderer/styles/base.css src/renderer/styles/shell.css test/window-glass.test.ts test/window-layout.test.ts scripts/verify-crystal-glass.cjs
git commit -m "feat: add progressive Crystal window glass"
```

---

### Task 4: Introduce the immutable renderer presentation store

**Files:**
- Create: `src/renderer/presentation-store.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/chat.ts`
- Test: `test/renderer-presentation-store.test.ts`
- Test: `test/renderer-state.test.ts`

**Interfaces:**
- Produces: `createPresentationStore(initial): PresentationStore` with `getState`, `dispatch`, and `subscribe`.
- Produces actions: `appStateReceived`, `sessionSelected`, `draftOwnerChanged`, `workbenchChanged`, and `selectionGenerationAdvanced`.
- Consumes: validated `AppState`, existing selected local session, draft key/generation, and work-panel presentation state.

- [ ] **Step 1: Write reducer and subscription tests**

```ts
it('rejects an older app-state and selection generation', () => {
  const store = createPresentationStore(seed);
  store.dispatch({ type: 'appStateReceived', generation: 4, state: state4 });
  store.dispatch({ type: 'appStateReceived', generation: 3, state: state3 });
  store.dispatch({ type: 'sessionSelected', sessionId: 'b', generation: 8 });
  store.dispatch({ type: 'sessionSelected', sessionId: 'a', generation: 7 });
  expect(store.getState()).toMatchObject({ appGeneration: 4, selectedSessionId: 'b', selectionGeneration: 8 });
});

it('notifies only selectors whose value changed', () => {
  const listener = vi.fn();
  store.subscribe(state => state.shell.workbench, listener);
  store.dispatch({ type: 'appStateReceived', generation: 2, state: changedStatusOnly });
  expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/renderer-presentation-store.test.ts test/renderer-state.test.ts`

Expected: FAIL because the store module is absent.

- [ ] **Step 3: Implement the minimal immutable store**

```ts
export interface PresentationStore {
  getState(): Readonly<PresentationState>;
  dispatch(action: PresentationAction): void;
  subscribe<T>(select: (state: PresentationState) => T,
    listener: (value: T, state: PresentationState) => void): () => void;
}
```

Use explicit discriminated actions and `Object.is` selector comparison. The store contains projections
and presentation preferences only; it has no persistence method and no generic event names.

- [ ] **Step 4: Adapt current state/selection entry points**

Dispatch from `api.onStateChanged`, existing session selection, draft replacement, and work-panel
changes. Preserve current public module functions while they migrate; they read a selector rather
than copying state into another global.

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm test -- --run test/renderer-presentation-store.test.ts test/renderer-state.test.ts test/renderer-chat-split.test.ts
npm run typecheck
```

Expected: PASS with one app-state generation and one selection generation owner.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/presentation-store.ts src/renderer/main.ts src/renderer/chat.ts test/renderer-presentation-store.test.ts test/renderer-state.test.ts
git commit -m "refactor: add renderer presentation store"
```

---

### Task 5: Mount the Adaptive Studio shell around current features

**Files:**
- Create: `src/renderer/app-shell.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles/shell.css`
- Modify: `src/renderer/styles/base.css`
- Modify: `src/renderer/sidebar-resize.ts`
- Modify: `src/renderer/work-panel-resize.ts`
- Test: `test/renderer-layout.test.ts`
- Test: `test/renderer-nav.test.ts`
- Test: `test/renderer-work-panel.test.ts`
- Modify: `scripts/verify-chat-width.cjs`
- Create: `scripts/verify-crystal-shell.cjs`

**Interfaces:**
- Produces: `AppShell { rail; navigator; stage; workbench; setDestination(); setWorkbenchOpen(); dispose() }`.
- Consumes: Task 4 presentation store and existing feature roots/ids.
- Produces stable region ids: `globalRail`, `chatNavigator`, `conversationStage`, `contextWorkbench`.

- [ ] **Step 1: Add fail-first shell identity and responsive tests**

```ts
it('mounts one chat-centric four-zone shell without duplicating feature roots', () => {
  const shell = createAppShell({ document, store });
  expect(document.querySelectorAll('#globalRail, #chatNavigator, #conversationStage, #contextWorkbench')).toHaveLength(4);
  for (const id of ['sessionList', 'timeline', 'composer', 'workPanel'])
    expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
  expect(shell.stage.contains(document.querySelector('#timeline'))).toBe(true);
});
```

Add width tests asserting collapse priority: workbench overlay, navigator drawer, compact rail; the
conversation stage remains mounted and composer width remains stable.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- --run test/renderer-layout.test.ts test/renderer-nav.test.ts test/renderer-work-panel.test.ts`

Expected: FAIL because the new regions and shell controller are absent.

- [ ] **Step 3: Replace the outer static layout**

Create the four semantic regions in `index.html`. Move existing session/navigation nodes into
`chatNavigator`, chat panel into `conversationStage`, and existing `workPanel` into
`contextWorkbench`. Preserve existing feature element ids until their owning Workspace tasks replace
them. Add rail buttons for Chats, Files, Agents, Usage, and Settings with roving keyboard focus.

Implement:

```ts
export function createAppShell(options: {
  store: PresentationStore; roots: AppShellRoots;
}): AppShell;
```

The shell changes visibility/projection only. It never calls session/project mutation APIs.

- [ ] **Step 4: Implement responsive presentation ownership**

Use CSS container/media queries and shell attributes. Keep one presentation preference for navigator
width and one for workbench width; migrate existing sidebar/work-panel values once and remove the old
keys in Cutover. Escape closes only the topmost drawer/overlay and returns focus to its trigger.

- [ ] **Step 5: Verify DOM and real Electron layout**

Run:

```bash
npm test -- --run test/renderer-layout.test.ts test/renderer-nav.test.ts test/renderer-work-panel.test.ts
node scripts/verify-crystal-shell.cjs
node scripts/verify-chat-width.cjs
npm run typecheck
```

Verify wide/medium/narrow widths, zoom, keyboard rail navigation, drawer focus return, transparent
and atmospheric modes, and unchanged transcript prose width during workbench toggles.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app-shell.ts src/renderer/index.html src/renderer/main.ts src/renderer/styles src/renderer/sidebar-resize.ts src/renderer/work-panel-resize.ts test/renderer-layout.test.ts test/renderer-nav.test.ts test/renderer-work-panel.test.ts scripts/verify-chat-width.cjs scripts/verify-crystal-shell.cjs
git commit -m "feat: mount the Adaptive Studio shell"
```
