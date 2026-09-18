# ChatBBC Omarchy Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and restructure the ChatBBC renderer so it adopts the desktop's Omarchy theme and idiom — square corners, hairline structure, monospace chrome — while making two product-derived elements visible: the durable session spine and the message delivery lifecycle.

**Architecture:** Presentation only. One new main-process module reads the Omarchy theme; one new pure resolver in `shared/appearance.ts` projects a palette to CSS tokens so main and renderer share exactly one source. The renderer is split into focused modules first (stylesheet and `chat.ts`), because every later track needs to edit a different region without colliding — that split is what makes the parallel tracks safe rather than merely fast.

**Tech Stack:** Electron 44, TypeScript, electron-vite, Vitest, vanilla DOM (no framework), plain CSS with custom properties.

**Spec:** `docs/superpowers/specs/2026-09-18-chatbbc-omarchy-redesign-design.md`

## Global Constraints

- **Presentation only.** No tool, capability, IPC contract, queue rule, recovery rule, worker lifecycle or durable fact may change. A task that needs to add state or a timer is out of scope — stop and ask.
- **No renames of existing ids or class names** that scripts or modules depend on. New markup is added; existing ids stay.
- **Radii are 0.** `--r-xs` through `--r-xl` and `--pill` all become `0`. Names are kept so one geometry vocabulary survives.
- **`fontSize` default stays 14.** `--text-scale` is `fontSize / 14` and 241 rules depend on it. Density is authored in chrome rules as `calc(11px * var(--text-scale, 1))`.
- **Two type roles:** `--ui-font` (prose, unchanged setting) and `--ui-font-mono` (chrome).
- **Interface `#composerDock` keeps its id**; its five children are replaced, not renamed away, in `index.html`.
- **Every new user-visible string goes through `t()`** in `src/renderer/i18n.ts`, with keys added to `locales/es.json` and `locales/zh-CN.json`.
- **`npm run typecheck` and `npm test` must pass at the end of every task.** Run no other suite per task; the full `npm run verify` runs once at the end.
- **Commits are per task**, one commit, conventional prefix.
- **Keep the user's existing work.** Read `git status --short` before each task; never reset, checkout or reformat unrelated files.
- **Verify scripts are retargeted, never deleted.** A script failing only on a deliberate visual change is updated with a comment naming the spec section.

---

## Parallel Execution Map

Phase 0 is sequential and is the critical path — every later track needs it done.

```
Phase 0: T1 styles split → T2 tokens → T3 chat.ts split        [sequential]
                                   ↓
Phase 1: T4 theme engine ─┬─ T5 transcript ─┬─ T6 sidebar ─┬─ T7 composer ─┬─ T8 work panel   [parallel, 5 tracks]
                          └──────────────────┴─────────────┴──────────────┴────────────
Phase 2: T9 session spine ─ T10 message lifecycle              [sequential; both touch transcript modules from T5]
Phase 3: T11 pages ─ T12 icons + motion                        [parallel]
Phase 4: T13 i18n ─ T14 verification                           [sequential]
```

Each Phase 1 track owns **different files**. The split in T1/T3 is what guarantees that; do not start a track before T3 is merged.

---

## File Structure

Created:

| File | Responsibility |
|---|---|
| `src/main/omarchy-theme.ts` | Read and parse the live Omarchy theme. Returns `null` on any failure; never throws. |
| `src/renderer/styles/base.css` | Tokens (`:root`), body, scrollbars. |
| `src/renderer/styles/shell.css` | Topbar, sidebar, nav, session list, connection popover. |
| `src/renderer/styles/transcript.css` | Timeline rows, the 12 content categories, the spine. |
| `src/renderer/styles/composer.css` | Composer, status line, message lifecycle cards, queue. |
| `src/renderer/styles/panels.css` | Work panel tabs, files, sub-agents, terminal. |
| `src/renderer/styles/pages.css` | Settings destinations, plugins, usage, activity, setup. |
| `src/renderer/styles/dialogs.css` | Dialogs, popovers, toasts. |
| `src/renderer/transcript-categories.ts` | The single `kind` → category lookup and its renderers. |
| `src/renderer/message-lifecycle.ts` | `InputRow.state` → visible label/edge projection. |
| `src/renderer/session-spine.ts` | Frontend segment + handoff joint rendering from session lineage. |
| `src/renderer/session-list.ts` | Session rows, badges, paging (moved out of `chat.ts`). |
| `src/renderer/outbox-view.ts` | Pending/queued input rendering (moved out of `chat.ts`). |

Modified: `src/shared/appearance.ts`, `src/shared/types.ts`, `src/main/appearance-schema.ts`, `src/main/ipc.ts`, `src/main/window-layout.ts`, `src/renderer/appearance.ts`, `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/chat.ts`, `src/renderer/i18n.ts`, `src/renderer/locales/{es,zh-CN}.json`.

`src/renderer/styles.css` is **deleted** in T1 after its contents are distributed.

---

## Phase 0 — Foundation

### Task 1: Split `styles.css` into importable modules

**Files:**
- Create: `src/renderer/styles/{base,shell,transcript,composer,panels,pages,dialogs}.css`
- Modify: `src/renderer/styles.css` (becomes the import manifest, then deleted)
- Modify: `src/renderer/index.html:6`
- Test: `test/renderer-styles.test.ts` (create)

**Interfaces:**
- Produces: seven stylesheet paths in `src/renderer/styles/`. Later tasks assume the file names above and that `styles.css` no longer exists.

This is a **pure move**. No declaration changes. The only permitted edit is adding a header comment naming each file's responsibility.

- [ ] **Step 1: Write the failing test**

```ts
// test/renderer-styles.test.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = path.resolve(__dirname, '../src/renderer');
const sheets = ['base', 'shell', 'transcript', 'composer', 'panels', 'pages', 'dialogs'];

describe('renderer stylesheets', () => {
  it('are split into the seven responsible modules and imported by index.html', async () => {
    for (const name of sheets) {
      const text = await fs.readFile(path.join(renderer, 'styles', `${name}.css`), 'utf8');
      expect(text.length, `${name}.css is empty`).toBeGreaterThan(0);
    }
    const html = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    expect(html).not.toContain('href="./styles.css"');
    expect(html).toContain('href="./styles/base.css"');
  });

  it('keeps the whole declaration set — the split loses nothing', async () => {
    const merged = (await Promise.all(sheets.map(async name =>
      await fs.readFile(path.join(renderer, 'styles', `${name}.css`), 'utf8')))).join('\n');
    // Every custom property that existed before the split must still exist after it.
    for (const token of ['--r-xs:', '--r-sm:', '--r-md:', '--r-lg:', '--r-xl:', '--pill:',
      '--page:', '--ink:', '--card:', '--soft:', '--faint:', '--line:', '--accent:', '--lift:']) {
      expect(merged, `lost ${token}`).toContain(token);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-styles.test.ts`
Expected: FAIL with `ENOENT: no such file or directory ... styles/base.css`

- [ ] **Step 3: Move the declarations**

The existing file already carries section markers. Distribute by them; the mapping is:

| Marker in old `styles.css` | Destination |
|---|---|
| lines 1–479 (`:root`, `body`, scrollbars, topbar) | `base.css` |
| 480–603 (`header`, `panels` shell) + sidebar/nav/session blocks | `shell.css` |
| 1897–2458 (`chat`, `session list`, `timeline`) | `transcript.css` |
| 2459–2712 (`compaction + panes`) + composer blocks | `composer.css` |
| file/sub-agent/terminal blocks | `panels.css` |
| plugins, usage, activity, setup, health, folders, permissions | `pages.css` |
| dialogs, popovers, toasts (`notice`, `toast`) | `dialogs.css` |

Move each block verbatim, in the original order within its destination, so cascade order between files is preserved by the import order below.

Delete `src/renderer/styles.css`.

- [ ] **Step 4: Point the manifest at the modules**

Replace `index.html:6` with, in this exact order (cascade order matters):

```html
    <link rel="stylesheet" href="./styles/base.css" />
    <link rel="stylesheet" href="./styles/shell.css" />
    <link rel="stylesheet" href="./styles/transcript.css" />
    <link rel="stylesheet" href="./styles/composer.css" />
    <link rel="stylesheet" href="./styles/panels.css" />
    <link rel="stylesheet" href="./styles/pages.css" />
    <link rel="stylesheet" href="./styles/dialogs.css" />
```

- [ ] **Step 5: Run the test and prove the app is visually unchanged**

Run: `npm test -- --run test/renderer-styles.test.ts` → PASS

Then capture before/after screenshots and confirm they are identical:

```sh
node_modules/.bin/electron scripts/verify-appearance.cjs
# compare against the committed baseline
```

Expected: `verify-appearance.cjs` passes with no assertion changes. A visual change here means the split lost or reordered a block — fix the split, do not adjust the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/styles src/renderer/index.html test/renderer-styles.test.ts
git rm --cached src/renderer/styles.css 2>/dev/null || true
git commit -m "refactor(renderer): split styles.css into responsible modules"
```

---

### Task 2: Rewrite the design tokens — square, dense, two type roles

**Files:**
- Modify: `src/renderer/styles/base.css` (the `:root` block)
- Modify: `src/renderer/appearance.ts:20-30`
- Test: `test/appearance.test.ts` (modify)

**Interfaces:**
- Consumes: `styles/base.css` from T1.
- Produces: the token names every later task uses — `--ui-font-mono` (mono chrome) alongside the existing `--ui-font` (prose), and `--r-*` all at `0`.

- [ ] **Step 1: Write the failing test**

Add to `test/appearance.test.ts`:

```ts
it('keeps every radius square and publishes a mono chrome font token', async () => {
  const css = await fs.readFile(path.resolve(__dirname, '../src/renderer/styles/base.css'), 'utf8');
  const block = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  // The desktop is decoration:rounding = 0; every radius name must resolve to 0.
  for (const name of ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--pill']) {
    expect(block, `${name} is not square`).toMatch(new RegExp(`${name}:\\s*0(px)?\\s*;`));
  }
});
```

Add `import { promises as fs } from 'node:fs'; import path from 'node:path';` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/appearance.test.ts`
Expected: FAIL — `--r-xs is not square` (it is `6px`).

- [ ] **Step 3: Change the geometry tokens**

In `styles/base.css`'s `:root`, replace the five radii and the pill:

```css
  /* Square, because the desktop is: Hyprland decoration:rounding = 0.
     The names stay so there is one geometry vocabulary and a theme could raise them. */
  --r-xs: 0;
  --r-sm: 0;
  --r-md: 0;
  --r-lg: 0;
  --r-xl: 0;
  --pill: 0;
```

Set `--lift: none;` in the light `:root` too (dark already has `--lift: none`), so no theme keeps a card shadow.

- [ ] **Step 4: Add the mono chrome token and resolve it in the renderer**

In `styles/base.css`'s `:root` add:

```css
  /* Chrome type. Text and labels are monospace — the desktop's own idiom —
     while authored and assistant prose keep --ui-font. */
  --ui-font-mono: "Iosevka Nerd Font Mono", "Iosevka NFM", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace;
```

In `src/renderer/appearance.ts`, inside `applyAppearance`, after the `--ui-font` lines, add:

```ts
  // Chrome is always the resolved mono chain; only prose follows the picker.
  root.style.setProperty('--ui-font-mono', value.monoFont ?? DEFAULT_MONO_CHAIN);
```

and above the function:

```ts
/** Resolution order for chrome type: desktop terminal font, then a real mono, then the last resort. */
export const DEFAULT_MONO_CHAIN =
  '"Iosevka Nerd Font Mono", "Iosevka NFM", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
```

- [ ] **Step 5: Apply mono to chrome**

In `shell.css`, `transcript.css`, `composer.css`, `panels.css`, `pages.css`, `dialogs.css`, replace `font-family`/`font:` declarations in **chrome** rules with `var(--ui-font-mono)`, and set chrome sizes to `calc(11px * var(--text-scale, 1))`.

Do **not** touch the transcript prose rules — those are T5's job and must keep `--ui-font`.

- [ ] **Step 6: Run tests and the appearance fixture**

Run: `npm test -- --run test/appearance.test.ts test/renderer-styles.test.ts`
Then: `node_modules/.bin/electron scripts/verify-appearance.cjs`

Expected: tests PASS. The fixture may need `fontSize` assertions reviewed — they assert 14, which is unchanged, so it must pass untouched.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/styles src/renderer/appearance.ts test/appearance.test.ts
git commit -m "feat(renderer): square geometry and monospace chrome tokens"
```

---

### Task 3: Split `chat.ts` into focused modules

**Files:**
- Create: `src/renderer/session-list.ts`, `src/renderer/outbox-view.ts`
- Modify: `src/renderer/chat.ts`
- Test: `test/renderer-chat-split.test.ts` (create)

**Interfaces:**
- Consumes: nothing from T2 beyond the code compiling.
- Produces: `session-list.ts` exporting `paintSessions`, `sessionRow`, `mergeSessionRows`; `outbox-view.ts` exporting `inputMessageRow`, `pendingComposerInput`, `paintDeliveryControls`. T5 and T7 edit these instead of `chat.ts`, which is what prevents them colliding.

This is a **pure move**. No behaviour change. `chat.ts` imports them; nothing else changes.

- [ ] **Step 1: Write the failing test**

```ts
// test/renderer-chat-split.test.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = path.resolve(__dirname, '../src/renderer');

describe('renderer chat split', () => {
  it('moves session list and outbox rendering into their own modules', async () => {
    const list = await fs.readFile(path.join(renderer, 'session-list.ts'), 'utf8');
    const outbox = await fs.readFile(path.join(renderer, 'outbox-view.ts'), 'utf8');
    expect(list).toContain('export function paintSessions');
    expect(list).toContain('export function sessionRow');
    expect(outbox).toContain('export function inputMessageRow');
    expect(outbox).toContain('export function pendingComposerInput');
  });

  it('no longer defines them in chat.ts', async () => {
    const chat = await fs.readFile(path.join(renderer, 'chat.ts'), 'utf8');
    expect(chat).not.toContain('function paintSessions(');
    expect(chat).not.toContain('function inputMessageRow(');
    // and is smaller for it
    expect(chat.split('\n').length).toBeLessThan(3600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-chat-split.test.ts`
Expected: FAIL with `ENOENT ... session-list.ts`

- [ ] **Step 3: Move the code**

Move, verbatim, from `chat.ts` into `session-list.ts`:
`KIND_ICON`, `AGENT_BADGE`, `sessionBadges`, `sessionRow`, `sortSessionRows`, `mergeSessionRows`, `maybePageSessions`, `paintSessions`, `projectGroup`, `selectedLocalProject`, `PROJECT_TASK_PAGE_SIZE`, `PROJECT_TASK_PAGE_INCREMENT`, `pressureOf`, `sessionWorking`, `unattributedBlocked`.

Move, verbatim, into `outbox-view.ts`:
`inputMessageRow`, `historicalAutomaticInput`, `pendingComposerInput`, `paintDeliveryControls`, `dockAction`, `queuedFollowup`, `attachmentCard`, `paintComposerImages`, `INPUT_NOTICE_KEY`, `dismissInputNotice`.

Each module imports what it needs from `./dom.js`, `./i18n.js`, `../shared/*`, and takes the few `chat.ts` locals it used as explicit parameters. Where a moved function read a module-level mutable in `chat.ts`, pass it in and pass a setter back — do not duplicate the state.

- [ ] **Step 4: Re-export nothing**

`chat.ts` must import and call these; it must not `export *` them. Nothing outside `chat.ts` used them as `chat.ts` exports (`main.ts` imports only `chatApply`, `chatSettingsPatch`, `chatVisible`, `initChat`, `openChatView`).

- [ ] **Step 5: Run the full renderer suite**

Run: `npm run typecheck && npm test -- --run test/renderer-chat-split.test.ts test/renderer-timeline.test.ts test/renderer-state.test.ts test/renderer-agent-plan.test.ts`

Expected: PASS. Any behavioural difference is a move error — fix the move.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/session-list.ts src/renderer/outbox-view.ts src/renderer/chat.ts test/renderer-chat-split.test.ts
git commit -m "refactor(renderer): split session list and outbox out of chat.ts"
```

---

## Phase 1 — Parallel Tracks

> Start these only after T3 is committed. Each track owns different files.

### Task 4: Omarchy theme engine (track: theme)

**Files:**
- Create: `src/main/omarchy-theme.ts`
- Modify: `src/shared/appearance.ts`, `src/shared/types.ts`, `src/main/appearance-schema.ts`, `src/main/ipc.ts`, `src/main/window-layout.ts`, `src/renderer/appearance.ts`
- Test: `test/omarchy-theme.test.ts` (create), `test/appearance.test.ts` (modify)

**Interfaces:**
- Produces:
  - `readOmarchyTheme(home?: string): OmarchyTheme | null`
  - `interface OmarchyTheme { name: string; mode: 'light' | 'dark'; background: string; accent: string; sidebar: string; green: string; red: string; fontFamily: string | null }`
  - `effectiveAppearance(ui: UiPrefs, theme: OmarchyTheme | null): AppearanceSettings`
  - `AppState.omarchy: OmarchyTheme | null`
- Consumes: `paletteTokens`, `mixColor`, `readableInk` from `shared/appearance.ts` (existing).

- [ ] **Step 1: Write the failing test**

```ts
// test/omarchy-theme.test.ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOmarchyTheme } from '../src/main/omarchy-theme.js';

async function themeDir(colors: string, name = 'osaka-jade', alacritty?: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'omarchy-'));
  const dir = path.join(home, '.local/state/omarchy/current/theme');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'colors.toml'), colors);
  await fs.writeFile(path.join(home, '.local/state/omarchy/current/theme.name'), name);
  if (alacritty) await fs.writeFile(path.join(dir, 'alacritty.toml'), alacritty);
  return home;
}

const OSAKA = `mode = "dark"
accent = "#509475"
background = "#111c18"
lighter_background = "#23372B"
foreground = "#C1C497"
green = "#549e6a"
red = "#FF5345"
`;

describe('readOmarchyTheme', () => {
  it('reads the live theme Omarchy actually writes', async () => {
    const home = await themeDir(OSAKA);
    const theme = readOmarchyTheme(home);
    expect(theme).not.toBeNull();
    expect(theme!.name).toBe('osaka-jade');
    expect(theme!.mode).toBe('dark');
    expect(theme!.accent).toBe('#509475');
    expect(theme!.background).toBe('#111c18');
    expect(theme!.sidebar).toBe('#23372B');
    expect(theme!.green).toBe('#549e6a');
    expect(theme!.red).toBe('#FF5345');
  });

  it('reads the terminal font when the theme ships one', async () => {
    const home = await themeDir(OSAKA, 'osaka-jade',
      '[font]\nnormal = { family = "Iosevka Nerd Font Mono" }\nsize = 8\n');
    expect(readOmarchyTheme(home)!.fontFamily).toBe('Iosevka Nerd Font Mono');
  });

  it('returns null — never throws — for every way the theme can be absent or wrong', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'omarchy-none-'));
    expect(readOmarchyTheme(empty)).toBeNull();

    expect(readOmarchyTheme(await themeDir('not toml at all'))).toBeNull();
    expect(readOmarchyTheme(await themeDir('accent = "red"\n'))).toBeNull();
    expect(readOmarchyTheme(await themeDir('accent = "#509475"\n'))).toBeNull(); // no background

    const unreadable = await themeDir(OSAKA);
    await fs.chmod(path.join(unreadable, '.local/state/omarchy/current/theme/colors.toml'), 0o000);
    expect(readOmarchyTheme(unreadable)).toBeNull();

    const huge = await themeDir('accent = "#509475"\n' + 'x'.repeat(80_000));
    expect(readOmarchyTheme(huge)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/omarchy-theme.test.ts`
Expected: FAIL — cannot resolve `../src/main/omarchy-theme.js`

- [ ] **Step 3: Implement the reader**

```ts
// src/main/omarchy-theme.ts
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mixColor, readableInk } from '../shared/appearance.js';

export interface OmarchyTheme {
  name: string;
  mode: 'light' | 'dark';
  background: string;
  accent: string;
  sidebar: string;
  green: string;
  red: string;
  fontFamily: string | null;
}

/** Bounded: a theme file is a few hundred bytes; anything larger is not one. */
const MAX_BYTES = 64 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Synchronous bounded read; null when absent, too large or unreadable. */
function readBounded(file: string, max = MAX_BYTES): string | null {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > max) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function field(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text);
  return match ? match[1]! : null;
}

/**
 * Read the theme Omarchy materialises for the running desktop.
 *
 * `omarchy-theme-set` writes these two paths itself, so this is the documented
 * hand-off point rather than a guess at the user's config layout. Returns null
 * for every failure — no Omarchy, missing file, unreadable, oversized, unparseable
 * or a value that is not an #rrggbb colour. The caller falls back; nothing here
 * may take the app down over a theme file.
 */
export function readOmarchyTheme(home: string = os.homedir()): OmarchyTheme | null {
  try {
    const dir = path.join(home, '.local/state/omarchy/current/theme');
    const colors = readBounded(path.join(dir, 'colors.toml'));
    if (colors === null) return null;

    const background = field(colors, 'background');
    if (!background || !HEX.test(background)) return null;

    const accent = field(colors, 'accent') ?? background;
    if (!HEX.test(accent)) return null;

    const lighter = field(colors, 'lighter_background');
    const sidebar = lighter && HEX.test(lighter) ? lighter : mixColor(background, accent, .12);

    const green = field(colors, 'green'), red = field(colors, 'red');
    const mode = field(colors, 'mode') === 'light' ? 'light' : 'dark';
    const name = readBounded(path.join(home, '.local/state/omarchy/current/theme.name'), 4 * 1024)?.trim();

    const alacritty = readBounded(path.join(dir, 'alacritty.toml'));
    const family = alacritty ? /family\s*=\s*"([^"]+)"/.exec(alacritty)?.[1] ?? null : null;

    return {
      name: name && name.length > 0 ? name : 'omarchy',
      mode, background, accent, sidebar,
      green: green && HEX.test(green) ? green : '#549e6a',
      red: red && HEX.test(red) ? red : '#FF5345',
      fontFamily: family
    };
  } catch {
    return null;
  }
}

/** A followed theme reuses the app's existing legibility floor for its ground. */
export function contrastFor(background: string): number {
  return readableInk(background) === '#000000' ? 45 : 60;
}
```

- [ ] **Step 4: Add the pure resolver and the config field**

In `src/shared/appearance.ts`:

```ts
/** Follow the desktop explicitly; off means the saved manual palettes are used verbatim. */
export interface FollowDesktop { enabled: boolean; theme: OmarchyTheme | null }

/**
 * The one place a followed desktop theme becomes an appearance. Pure, so main and
 * renderer cannot disagree, and so the saved manual palettes are never mutated:
 * turning follow off restores them exactly because they were never overwritten.
 */
export function effectiveAppearance(ui: { theme: AppearanceTheme; appearance?: AppearanceSettings;
  followDesktop?: boolean }, omarchy: OmarchyTheme | null): AppearanceSettings {
  const saved = ui.appearance ?? defaultAppearance();
  if (!ui.followDesktop || !omarchy) return saved;
  const mode = omarchy.mode;
  const contrast = contrastFor(omarchy.background);
  return {
    ...saved,
    [mode]: { background: omarchy.background, sidebar: omarchy.sidebar, accent: omarchy.accent, contrast },
    ...(omarchy.fontFamily ? {} : {})
  };
}

/** Chrome type prefers the desktop's own terminal font. */
export function monoChain(omarchy: OmarchyTheme | null): string {
  const base = '"Iosevka Nerd Font Mono", "Iosevka NFM", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';
  return omarchy?.fontFamily ? `"${omarchy.fontFamily}", ${base}` : base;
}
```

Import `OmarchyTheme` as `import type { OmarchyTheme } from '../main/omarchy-theme.js';` — the type is shared, the reader stays in main.

In `src/main/appearance-schema.ts`, add to `appearanceSchema`:

```ts
  followDesktop: z.boolean().optional()
```

Extend `paletteTokens()` in `src/shared/appearance.ts` with an optional status palette, so a followed
theme's own cyan/magenta/yellow/ice reach the category identities in T5. With no argument the output
must stay byte-identical to today:

```ts
export interface StatusPalette { green?: string; red?: string; cyan?: string; magenta?: string; yellow?: string; ice?: string }

export function paletteTokens(background: string, accent: string, contrast: number,
  status?: StatusPalette): Record<string, string> {
  // ...existing body unchanged, then:
  const green = status?.green ?? '#258552', red = status?.red ?? '#d44545';
  return {
    // ...existing tokens unchanged (using the two locals above for --green*/--red*), plus:
    '--cyan': readableTint(status?.cyan ?? '#2DD5B7', card, 4.5),
    '--magenta': readableTint(status?.magenta ?? '#D2689C', card, 4.5),
    '--yellow': readableTint(status?.yellow ?? '#E5C736', card, 4.5),
    '--ice': readableTint(status?.ice ?? '#ACD4CF', card, 4.5)
  };
}
```

Then in `src/main/omarchy-theme.ts` add the mapping used by callers:

```ts
/** A followed theme's own status colours, so category identities stay meaningful under it. */
export function omarchyStatus(theme: OmarchyTheme | null): StatusPalette | undefined {
  if (!theme) return undefined;
  return { green: theme.green, red: theme.red };
}
```

and have `applyAppearance` in `src/renderer/appearance.ts` pass it:

```ts
tokens(root, paletteTokens(palette.background, palette.accent, palette.contrast, value.status));
```

with `status?: StatusPalette` carried on `AppearanceSettings` (optional, so saved configs and the
schema stay valid without it).

- [ ] **Step 5: Publish `omarchy` in `AppState` and use the resolver in main**

In `src/shared/types.ts`, add to `AppState`:

```ts
  /** The live Omarchy theme, or null when this machine has none. Presentation only. */
  omarchy?: import('../main/omarchy-theme.js').OmarchyTheme | null;
```

In `src/main/ipc.ts`, in the `state:get` handler, add `omarchy: readOmarchyTheme()`. In the save path where `titleBarOverlayForTheme` and `windowBackgroundForTheme` are called (around `ipc.ts:463` and `:468`), pass the resolved appearance:

```ts
const resolved = effectiveAppearance(next.ui, readOmarchyTheme());
```

and use `resolved` in both calls. Apply the same in `src/main/index.ts:116` and `:119`.

- [ ] **Step 6: Run tests**

Run: `npm run typecheck && npm test -- --run test/omarchy-theme.test.ts test/appearance.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/omarchy-theme.ts src/shared/appearance.ts src/shared/types.ts src/main/appearance-schema.ts src/main/ipc.ts src/main/window-layout.ts src/main/index.ts test/omarchy-theme.test.ts test/appearance.test.ts
git commit -m "feat(theme): follow the live Omarchy theme"
```

---

### Task 5: Transcript content categories (track: transcript)

**Files:**
- Create: `src/renderer/transcript-categories.ts`
- Modify: `src/renderer/styles/transcript.css`, `src/renderer/chat.ts`
- Test: `test/transcript-categories.test.ts` (create)

**Interfaces:**
- Produces: `categoryFor(kind: SessionEventKind): ContentCategory` and `categoryClass(category): string`, used by T9 and T10.
- Consumes: nothing from other tracks.

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript-categories.test.ts
import { describe, expect, it } from 'vitest';
import { categoryFor, categoryClass, CONTENT_CATEGORIES } from '../src/renderer/transcript-categories.js';

describe('transcript categories', () => {
  it('maps every recorded SessionEvent kind to exactly one category', () => {
    const kinds = ['session_start', 'user_message', 'assistant_message', 'tool_call', 'page_tool',
      'native_image', 'agent_message', 'progress', 'chat_error', 'note', 'handoff',
      'turn_start', 'turn_end'] as const;
    for (const kind of kinds) {
      const category = categoryFor(kind);
      expect(CONTENT_CATEGORIES, `${kind} has no category`).toContain(category);
    }
    expect(kinds).toHaveLength(13);
  });

  it('gives authored, generated and system their own identities', () => {
    expect(categoryFor('user_message')).toBe('authored');
    expect(categoryFor('agent_message')).toBe('worker');
    expect(categoryFor('chat_error')).toBe('error');
    // generated work and authored work must not share a class
    expect(categoryClass('authored')).not.toBe(categoryClass('worker'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/transcript-categories.test.ts`
Expected: FAIL — cannot resolve `transcript-categories.js`

- [ ] **Step 3: Implement the single lookup**

```ts
// src/renderer/transcript-categories.ts
import type { SessionEventKind } from '../shared/session.js';

/** One identity per content family. Geometry is shared; accent, glyph and edge are not. */
export const CONTENT_CATEGORIES = [
  'authored', 'prose', 'code', 'diff', 'image', 'tool', 'error',
  'recovery', 'worker', 'handoff', 'plan', 'note'
] as const;
export type ContentCategory = typeof CONTENT_CATEGORIES[number];

const BY_KIND: Record<SessionEventKind, ContentCategory> = {
  user_message: 'authored',
  assistant_message: 'prose',
  tool_call: 'tool',
  page_tool: 'tool',
  native_image: 'image',
  agent_message: 'worker',
  progress: 'recovery',
  chat_error: 'error',
  note: 'note',
  handoff: 'handoff',
  session_start: 'note',
  turn_start: 'note',
  turn_end: 'note'
};

export function categoryFor(kind: SessionEventKind): ContentCategory {
  return BY_KIND[kind] ?? 'note';
}

/** The class a row carries. One class per category, so CSS owns the identity. */
export function categoryClass(category: ContentCategory): string {
  return `cat-${category}`;
}
```

- [ ] **Step 4: Give each category its identity in CSS**

In `styles/transcript.css`, add one block per category following the prototype in
`outputs/redesign-baseline/prototypes/categories.html`. The shared contract first:

```css
/* Every category shares this geometry; only the accent, glyph and edge differ. */
.tl-row { border: 1px solid var(--line); background: var(--card); border-left-width: 2px; }
.tl-row > .tl-head { display: flex; align-items: center; gap: 10px; padding: 6px 11px;
  border-bottom: 1px solid var(--line); font: calc(10.5px * var(--text-scale, 1)) var(--ui-font-mono); }

/* Accent on the rail, glyph, label and metadata only — never a large fill,
   so a busy transcript does not read as a patchwork. */
.cat-authored { border-left-color: var(--accent); }
.cat-code     { border-left-color: var(--cyan); }
.cat-diff     { border-left-color: var(--soft); }
.cat-image    { border-left-color: var(--line); }
.cat-tool     { border-left-color: var(--line); }
.cat-error    { border-left-color: var(--red); }
.cat-recovery { border-left-color: var(--yellow); }
.cat-worker   { border-left-color: var(--magenta); }
.cat-handoff  { border-left-color: var(--ice); }
.cat-plan     { border-left-color: var(--accent); }
.cat-note     { border-left-color: var(--line); }
```

Add `--cyan`, `--magenta`, `--yellow`, `--ice` to `styles/base.css` `:root`, mirrored into the dark
theme. Their values come from `paletteTokens()`, which T4 already extended with the full status
palette — this task adds only the CSS defaults for a machine with no Omarchy theme, and must **not**
edit `shared/appearance.ts`.

- [ ] **Step 5: Use it in the timeline renderer**

In `chat.ts`, wherever a timeline row is built, add the category class instead of the current ad-hoc per-kind class:

```ts
import { categoryFor, categoryClass } from './transcript-categories.js';
// ...
row.classList.add('tl-row', categoryClass(categoryFor(event.kind)));
```

- [ ] **Step 6: Run tests**

Run: `npm run typecheck && npm test -- --run test/transcript-categories.test.ts test/renderer-timeline.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/transcript-categories.ts src/renderer/styles src/renderer/chat.ts test/transcript-categories.test.ts
git commit -m "feat(transcript): give every content family its own identity"
```

---

### Task 6: Sidebar and settings navigation (track: shell)

**Files:**
- Modify: `src/renderer/index.html:79-260`, `src/renderer/main.ts`, `src/renderer/styles/shell.css`
- Test: `test/renderer-nav.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tracks.
- Produces: five destination names and their `data-tab` values, which T11 renders pages for.

- [ ] **Step 1: Write the failing test**

```ts
// test/renderer-nav.test.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = () => fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

describe('settings navigation', () => {
  it('offers exactly five destinations', async () => {
    const text = await html();
    const tabs = [...text.matchAll(/data-tab="([a-z-]+)"/g)].map(m => m[1]);
    expect(tabs.sort()).toEqual(['activity', 'appearance', 'automation', 'usage', 'workspace']);
  });

  it('keeps Setup reachable without being a nav peer', async () => {
    const text = await html();
    expect(text).not.toContain('data-tab="setup"');
    expect(text).toContain('data-panel="setup"'); // the wizard page still exists
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-nav.test.ts`
Expected: FAIL — tabs are `home, usage, setup, settings, appearance, activity`.

- [ ] **Step 3: Rebuild the sidebar markup**

In `index.html`, replace the `#tabs` nav and sidebar body so the structure is: brand + product mark, five destination buttons, hairline, session list (`#sessionList` unchanged), hairline, one dense footer row containing `#sidebarConnection` and `#workspaceSettings`.

`New chat` (`#newChat`) and `#sidebarPlugins` move into the session-list header row. Keep every existing id: `#sidebar`, `#sidebarResize`, `#backToChat`, `#newChat`, `#sidebarPlugins`, `#sessionList`, `#projectsSection`, `#chatsSection`, `#workspaceSettings`, `#sidebarConnection`, `#connectionPopover`.

Map the old tabs onto the new five: `home`→`workspace`, `settings`→`automation`, keep `appearance`, `usage`, `activity`; remove the `setup` nav button but keep `data-panel="setup"` and `#setupBadge` (move the badge onto the Workspace button).

- [ ] **Step 4: Make Settings reuse the sidebar slot**

In `main.ts`, when a destination is selected, the sidebar shows the settings nav in place of `#sessionList`; `#backToChat` becomes the way out. Implement by toggling a class on `.sidebar` (`is-settings`) rather than adding a second nav; the body still swaps panels via the existing `data-panel` mechanism.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/renderer-nav.test.ts test/renderer-layout.test.ts`
Then: `node_modules/.bin/electron scripts/verify-sidebar-setup.cjs` and `scripts/verify-sidebar-setup.cjs` must still pass (collapse state, project groups, five visible rows).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/main.ts src/renderer/styles/shell.css test/renderer-nav.test.ts
git commit -m "feat(shell): five settings destinations in a single sidebar slot"
```

---

### Task 7: Composer, status line and message lifecycle (track: composer)

**Files:**
- Create: `src/renderer/message-lifecycle.ts`
- Modify: `src/renderer/index.html:952-1030`, `src/renderer/outbox-view.ts`, `src/renderer/styles/composer.css`
- Test: `test/message-lifecycle.test.ts` (create)

**Interfaces:**
- Produces: `lifecycleOf(entry: InputEntry): { label: string; tone: string }` — consumed by T10.
- Consumes: `outbox-view.ts` from T3.

- [ ] **Step 1: Write the failing test**

```ts
// test/message-lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { lifecycleOf } from '../src/renderer/message-lifecycle.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'i1', state: 'queued', text: 'x', createdAt: 0, ...over
}) as never;

describe('message lifecycle', () => {
  it('never renders two different facts the same way', () => {
    // These four are the facts the product insists are distinct.
    const queued = lifecycleOf(entry({ state: 'queued' }));
    const composer = lifecycleOf(entry({ state: 'browser' }));
    const turn = lifecycleOf(entry({ state: 'tool' }));
    const sent = lifecycleOf(entry({ state: 'sent' }));
    const labels = [queued, composer, turn, sent].map(l => l.label);
    expect(new Set(labels).size, 'two delivery stages share a label').toBe(4);
    expect(new Set([queued, composer, turn, sent].map(l => l.tone)).size).toBe(4);
  });

  it('labels a scheduled message by its due time, not as plain queued', () => {
    expect(lifecycleOf(entry({ dueAt: Date.now() + 60_000 })).label).toMatch(/after turn|scheduled/i);
  });

  it('marks failure and cancellation as terminal and retryable-looking', () => {
    expect(lifecycleOf(entry({ state: 'failed' })).tone).toBe('failed');
    expect(lifecycleOf(entry({ state: 'cancelled' })).tone).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/message-lifecycle.test.ts`
Expected: FAIL — cannot resolve `message-lifecycle.js`

- [ ] **Step 3: Implement the projection**

```ts
// src/renderer/message-lifecycle.ts
import { t } from './i18n.js';

/** The visible claim a message makes about where it has got to. */
export interface MessageStage { label: string; tone: 'queued' | 'scheduled' | 'composer' | 'turn' | 'sent' | 'failed'; detail: string }

/**
 * Project the outbox row onto what the user is told.
 *
 * `InputRow.state` is `queued | browser | tool | sent | cancelled | failed | decision`.
 * These are different facts and must not be merged: a message in the outbox, a message
 * inserted into the ChatGPT composer, one ChatGPT has accepted, and one an active turn
 * is holding are four different states with four different consequences for the user.
 */
export function lifecycleOf(entry: {
  state?: string; error?: string; dueAt?: number; delivery?: string;
  deliveredAt?: number; offeredAt?: number;
}): MessageStage {
  const { state } = entry;
  if (state === 'failed') return { label: t("NOT SENT"), detail: entry.error ?? t("Delivery was not confirmed"), tone: 'failed' };
  if (state === 'cancelled') return { label: t("WITHDRAWN"), detail: entry.error ?? t("No longer queued"), tone: 'failed' };
  if (state === 'sent') return { label: t("SENT"), detail: t("ChatGPT accepted it"), tone: 'sent' };
  if (state === 'tool') return { label: t("SENT TO TURN"), detail: t("Awaiting receipt from the active turn"), tone: 'turn' };
  if (state === 'browser') return { label: t("IN COMPOSER"), detail: t("In the ChatGPT composer · not sent"), tone: 'composer' };
  if (state === 'decision') return { label: t("PREPARING FOLLOW-UP"), detail: t("Producing the next instruction"), tone: 'queued' };
  if (entry.dueAt !== undefined && entry.dueAt > Date.now()) {
    return { label: t("SCHEDULED — after turn ends"), detail: t("Waiting for a verified completion"), tone: 'scheduled' };
  }
  if (entry.delivery === 'tool') return { label: t("WAITING FOR A TOOL CALL"), detail: t("Delivered with the next tool result"), tone: 'queued' };
  return { label: t("QUEUED"), detail: t("In the outbox · not yet in ChatGPT"), tone: 'queued' };
}
```

- [ ] **Step 4: Add the CSS identity per tone**

In `styles/composer.css`:

```css
.msg { border: 1px solid var(--line); background: var(--card); border-left-width: 2px; }
.msg > .msg-head { display: flex; align-items: center; gap: 9px; padding: 5px 10px;
  border-bottom: 1px solid var(--line); font: calc(10.5px * var(--text-scale, 1)) var(--ui-font-mono); }
.msg.tone-queued    { border-left-color: var(--faint); }
.msg.tone-scheduled { border-left-color: var(--yellow); }
.msg.tone-composer  { border-left-color: var(--cyan); }
.msg.tone-turn      { border-left-color: var(--ice); }
.msg.tone-sent      { border-left-color: var(--green); }
.msg.tone-failed    { border-left-color: var(--red); }
```

- [ ] **Step 5: Replace the dock and label the toolbar**

In `index.html`, inside `#composerDock` keep the five child ids (`#agentPlan`, `#recoveryStatus`, `#taskPlanPreview`, `#finishQueue`, `#activeGoalRow`) but render them **inside one collapsible status line** — a `#composerStatusLine` element that shows the live segments and expands to reveal those existing children. Do not delete the children; they keep their existing paint functions in `chat.ts`.

In the composer toolbar, surface the mode control (`#composerSettings` radio group) as a visible `Ordinary / Goal / Loop` control, give `#attachmentMenu` the visible label `Attach`, and turn `#contextMeter` into a labelled `context <n>` segment.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test -- --run test/message-lifecycle.test.ts test/renderer-composer.test.ts`
Then: `node_modules/.bin/electron scripts/verify-composer-layout.cjs` and `scripts/verify-composer-context.cjs` must pass.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/message-lifecycle.ts src/renderer/index.html src/renderer/outbox-view.ts src/renderer/styles/composer.css test/message-lifecycle.test.ts
git commit -m "feat(composer): one status line and a truthful message lifecycle"
```

---

### Task 8: Work panel tabs — Files, Sub-agents, Terminal (track: panel)

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/file-panel.ts`, `src/renderer/agent-panel.ts`, `src/renderer/workspace-terminal.ts`, `src/renderer/work-panel-resize.ts`, `src/renderer/styles/panels.css`
- Test: `test/renderer-work-panel.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tracks.
- Produces: one panel host with three tenants; the terminal gains a "widen when selected" behaviour.

- [ ] **Step 1: Write the failing test**

```ts
// test/renderer-work-panel.test.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFile(path.resolve(__dirname, '../src/renderer', f), 'utf8');

describe('work panel', () => {
  it('has one tab strip hosting three tenants', async () => {
    const html = await read('index.html');
    const tabs = [...html.matchAll(/data-work-tab="([a-z-]+)"/g)].map(m => m[1]);
    expect(tabs).toEqual(['files', 'agents', 'terminal']);
  });

  it('keeps each tenant owner intact', async () => {
    expect(await read('file-panel.ts')).toContain('attachWorkPanelResize');
    expect(await read('workspace-terminal.ts')).toContain('FitAddon');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-work-panel.test.ts`
Expected: FAIL — no `data-work-tab` in the markup.

- [ ] **Step 3: Add the tab strip and host**

In `index.html`, add one `#workPanel` host containing a tab strip (`data-work-tab="files|agents|terminal"`) and three panes. Move the terminal's bottom-drawer markup into the third pane; keep `#workspaceTerminal` and every existing terminal id.

- [ ] **Step 4: Widen for the terminal**

In `work-panel-resize.ts`, when the `terminal` tab is selected, set the panel to its existing maximum (host width minus 360px). Restore the user's previous width when leaving the tab. Do not add a second resize owner — reuse the existing one.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/renderer-work-panel.test.ts test/renderer-file-panel.test.ts`
Then: `node_modules/.bin/electron scripts/verify-workspace-terminal.cjs` must pass unchanged (real PTY input, cwd, hide/reopen, tabs, Ctrl+C, exit codes, resize, close).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/file-panel.ts src/renderer/agent-panel.ts src/renderer/workspace-terminal.ts src/renderer/work-panel-resize.ts src/renderer/styles/panels.css test/renderer-work-panel.test.ts
git commit -m "feat(panel): one tabbed work panel for files, sub-agents and terminal"
```

---

## Phase 2 — Identity Elements

### Task 9: The session spine

**Files:**
- Create: `src/renderer/session-spine.ts`
- Modify: `src/renderer/chat.ts`, `src/renderer/styles/transcript.css`
- Test: `test/session-spine.test.ts` (create)

**Interfaces:**
- Consumes: `categoryClass` from T5; the timeline container from T5.
- Produces: `frontendSegments(events, origin): FrontendSegment[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/session-spine.test.ts
import { describe, expect, it } from 'vitest';
import { frontendSegments } from '../src/renderer/session-spine.js';

const handoff = (seq: number) => ({ kind: 'handoff', seq, handoffId: 'h1', chars: 4100, reason: 'manual' }) as never;

describe('session spine', () => {
  it('draws no spine when the session has no lineage', () => {
    expect(frontendSegments([], null)).toEqual([]);
  });

  it('numbers one segment per frontend and puts the handoff between them', () => {
    const segments = frontendSegments([handoff(1)], { kind: 'resume', fromSessionId: 'A' } as never);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.index).toBe(1);
    expect(segments[1]!.index).toBe(2);
    expect(segments[0]!.endsWithHandoff).toBe(true);
    expect(segments[1]!.startsWithHandoff).toBe(true);
  });

  it('treats a worker origin as a worker segment, not a resumed frontend', () => {
    const segments = frontendSegments([], { kind: 'worker', fromSessionId: 'A', agentId: 'worker-2' } as never);
    expect(segments[0]!.label).toMatch(/worker/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/session-spine.test.ts`
Expected: FAIL — cannot resolve `session-spine.js`

- [ ] **Step 3: Implement**

```ts
// src/renderer/session-spine.ts
import type { SessionEvent, SessionOrigin } from '../shared/session.js';

export interface FrontendSegment {
  index: number;
  label: string;
  startsWithHandoff: boolean;
  endsWithHandoff: boolean;
}

/**
 * The transcript belongs to the durable local session, not to any one ChatGPT chat.
 *
 * Lineage comes from `SessionOrigin` — which is a *session* field, not an event — plus
 * the recorded `handoff` events that mark where one frontend gave way to the next.
 * `resume` is deliberately a SessionOrigin kind only; it is never a SessionEvent, and
 * reading it as one would hang the spine off the wrong owner and never render.
 */
export function frontendSegments(events: readonly SessionEvent[], origin: SessionOrigin | null): FrontendSegment[] {
  const handoffs = events.filter(e => e.kind === 'handoff').length;
  const continuations = origin && (origin.kind === 'resume' || origin.kind === 'worker') ? 1 : 0;
  const count = handoffs + continuations;
  if (count === 0) return [];
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    label: origin?.kind === 'worker' && i === 0 ? `worker ${origin.agentId ?? ''}`.trim() : `frontend ${i + 1}`,
    startsWithHandoff: i > 0,
    endsWithHandoff: i < count - 1
  }));
}
```

- [ ] **Step 4: Render it**

In `chat.ts`, wrap the timeline in a `.spine` container when `frontendSegments(...)` is non-empty, emit a `.spine-seg` header per segment, and render the handoff joint on the `handoff` rows. Draw the spine from the same event stream the timeline already has; no new IPC and no new state.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/session-spine.test.ts test/renderer-timeline.test.ts`
Then: `node_modules/.bin/electron scripts/verify-history-scroll.cjs` and `scripts/verify-chat-width.cjs`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/session-spine.ts src/renderer/chat.ts src/renderer/styles/transcript.css test/session-spine.test.ts
git commit -m "feat(transcript): show the durable session spine and its frontends"
```

---

### Task 10: Message lifecycle cards in the timeline

**Files:**
- Modify: `src/renderer/outbox-view.ts`, `src/renderer/chat.ts`, `src/renderer/styles/composer.css`
- Test: `test/outbox-view.test.ts` (create)

**Interfaces:**
- Consumes: `lifecycleOf` from T7, `categoryFor` from T5.
- Produces: pending rows that carry `data-tone`, which T14 asserts on.

- [ ] **Step 1: Write the failing test**

```ts
// test/outbox-view.test.ts
import { describe, expect, it } from 'vitest';
import { lifecycleOf } from '../src/renderer/message-lifecycle.js';

describe('pending rows carry the lifecycle tone', () => {
  it('exposes a distinct tone per stage for the renderer to style', () => {
    const tones = ['queued', 'browser', 'tool', 'sent', 'failed', 'cancelled'].map(state =>
      lifecycleOf({ state } as never).tone);
    expect(new Set(tones).size).toBeGreaterThanOrEqual(4);
    expect(tones).not.toContain(undefined as never);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/outbox-view.test.ts`
Expected: FAIL until `message-lifecycle.ts` is imported by the row builder; confirm it passes once wired, then proceed.

- [ ] **Step 3: Wire the row**

In `outbox-view.ts::inputMessageRow`, replace the `i-check`/`i-clock` icon swap with the lifecycle projection:

```ts
const stage = lifecycleOf(entry);
row.dataset.tone = stage.tone;
row.classList.add('msg', `tone-${stage.tone}`);
head.append(el('span', 'msg-glyph', stage.tone === 'sent' ? '●' : stage.tone === 'failed' ? '!' : '◦'));
head.append(el('span', 'msg-label', stage.label));
head.append(el('span', 'msg-detail', stage.detail));
```

The label is **text, always visible** — the old `title`-only wording is removed, and `receipt.hidden` no longer hides a delivered row's meaning.

- [ ] **Step 4: Keep delivery controls working**

`#finishQueue` and the retry/withdraw/edit actions keep their existing handlers and ids. Only the presentation changes.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/outbox-view.test.ts test/message-lifecycle.test.ts test/session-input.test.ts`
Then: `node_modules/.bin/electron scripts/verify-composer-context.cjs`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/outbox-view.ts src/renderer/chat.ts src/renderer/styles/composer.css test/outbox-view.test.ts
git commit -m "feat(composer): show every delivery stage as its own visible state"
```

---

## Phase 3 — Pages, Icons and Motion

### Task 11: Settings destination pages

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/main.ts`, `src/renderer/styles/pages.css`
- Test: `test/renderer-nav.test.ts` (extend)

**Interfaces:**
- Consumes: the five destinations from T6.
- Produces: `Workspace / Automation / Appearance / Usage / Activity` panels with their existing controls intact.

- [ ] **Step 1: Write the failing test**

```ts
it('renders five destination panels with their existing controls', async () => {
  const text = await html();
  for (const panel of ['workspace', 'automation', 'appearance', 'usage', 'activity']) {
    expect(text, `${panel} panel missing`).toContain(`data-panel="${panel}"`);
  }
  // controls that must survive the regroup
  for (const id of ['appearancePanel', 'chatModelsSection', 'goalEnabled', 'multiAgentEnabled']) {
    expect(text, `lost #${id}`).toContain(`id="${id}"`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-nav.test.ts`
Expected: FAIL — `automation panel missing`

- [ ] **Step 3: Regroup the panels**

Move existing sections into the five panels without changing any control id. `Setup` (`data-panel="setup"`) is reached from a card inside Workspace and keeps `#setupBadge`.

- [ ] **Step 4: Apply the dense row idiom**

In `styles/pages.css`, give every settings row the shared shape: flat surface, hairline separator (`> * + *`), control in a reserved right column (`minmax(10rem, auto)`), so controls do not jitter row to row. Pages stay neutral — no page accent; cards carry their category colour.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/renderer-nav.test.ts test/appearance.test.ts`
Then: `node_modules/.bin/electron scripts/verify-appearance.cjs`, `scripts/verify-settings-focus.cjs`, `scripts/verify-dropdown-layout.cjs`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/main.ts src/renderer/styles/pages.css test/renderer-nav.test.ts
git commit -m "feat(settings): five destinations with the dense row idiom"
```

---

### Task 12: Icon set and motion tokens

**Files:**
- Modify: `src/renderer/index.html:13-75` (the sprite), `src/renderer/styles/base.css`
- Test: `test/renderer-icons.test.ts` (create)

**Interfaces:**
- Produces: the same icon ids at a uniform 1.5px stroke. No consumer changes.

- [ ] **Step 1: Write the failing test**

```ts
// test/renderer-icons.test.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('icon sprite', () => {
  it('keeps every id and uses one stroke width', async () => {
    const html = await fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
    const sprite = html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</svg>'));
    const ids = [...sprite.matchAll(/<g id="(i-[a-z]+)"/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(25);
    const widths = new Set([...sprite.matchAll(/stroke-width="([\d.]+)"/g)].map(m => m[1]));
    expect([...widths]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/renderer-icons.test.ts`
Expected: FAIL — the sprite currently carries inline `stroke-width` values.

- [ ] **Step 3: Unify the sprite**

Redraw every glyph as a 1.5px stroke on the existing 24 grid with `fill="none"` and `stroke="currentColor"`, and move the stroke width to one CSS rule in `styles/base.css`:

```css
.ico, .sprite g { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
```

Keep every `id` exactly as it is.

- [ ] **Step 4: Add the motion tokens**

```css
:root { --motion-fade: 120ms; --motion-state: 140ms; }
@media (prefers-reduced-motion: reduce) { :root { --motion-fade: 0ms; --motion-state: 0ms; } }
```

Use `--motion-fade` for appended transcript rows and `--motion-state` for hover/active fills. Remove any decorative animation not already covered by the reduced-motion guard.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test -- --run test/renderer-icons.test.ts`
Then: `node_modules/.bin/electron scripts/verify-pet-electron.cjs` (reduced-motion behaviour must be unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/styles/base.css test/renderer-icons.test.ts
git commit -m "feat(ui): one uniform icon set and functional-only motion"
```

---

## Phase 4 — Localisation and Verification

### Task 13: Localise the new copy

**Files:**
- Modify: `src/renderer/locales/es.json`, `src/renderer/locales/zh-CN.json`
- Test: `test/renderer-i18n.test.ts` (extend)

**Interfaces:**
- Consumes: every new string added by T6, T7, T9, T10, T11.

- [ ] **Step 1: Collect the new strings**

```sh
grep -rhoE 't\("([^"]+)"' src/renderer/*.ts | sed 's/t("//' | sort -u
```

- [ ] **Step 2: Write the failing test**

```ts
it('translates every delivery stage label', async () => {
  const es = JSON.parse(await fs.readFile(path.resolve(__dirname, '../src/renderer/locales/es.json'), 'utf8'));
  for (const label of ['QUEUED', 'SENT', 'NOT SENT', 'IN COMPOSER', 'SENT TO TURN', 'WITHDRAWN']) {
    expect(es[label], `untranslated: ${label}`).toBeTruthy();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --run test/renderer-i18n.test.ts`
Expected: FAIL — `untranslated: QUEUED`

- [ ] **Step 4: Add the entries**

Add every new key to `es.json` and `zh-CN.json` with real translations. Keep proper nouns (`ChatBBC`, `ChatGPT`, model names) untranslated.

- [ ] **Step 5: Verify**

Run: `npm test -- --run test/renderer-i18n.test.ts test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts`
Then: `node_modules/.bin/electron scripts/verify-renderer-label-memory.cjs`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/locales test/renderer-i18n.test.ts
git commit -m "i18n: translate the redesign's new copy"
```

---

### Task 14: Full verification

**Files:**
- Create: `docs/superpowers/verification/2026-09-18-omarchy-redesign.md`
- Modify: any verify script that asserts a deliberately changed fact (with a comment naming the spec section)

- [ ] **Step 1: Run the whole suite**

```sh
npm run typecheck && npm run verify
```

Expected: PASS. Record the exact file/test counts in the verification doc.

- [ ] **Step 2: Run every affected visual fixture**

```sh
for s in appearance chat-width composer-layout composer-context dropdown-layout settings-focus \
         sidebar-setup connection-compact connection-layer history-scroll chat-opening-scroll \
         chat-switch setup-guide disconnect-ui goal-status-layout plan-collapse pr-workspace \
         workspace-terminal pet-electron renderer-label-memory; do
  node_modules/.bin/electron "scripts/verify-$s.cjs" || echo "FAILED: $s"
done
```

Expected: all pass. For any failure caused **only** by a deliberate change in this spec, update the assertion with a comment naming the spec section, and say so in the verification doc. Never delete a check.

- [ ] **Step 3: Capture acceptance screenshots from the real build**

```sh
node_modules/.bin/electron . --remote-debugging-port=9222 --user-data-dir=/tmp/chatbbc-shots
```

Capture, at 1600×900 and at a narrow width: each of the five destinations, the transcript with a session spine and a frontend boundary visible, and at least one mid-flight message (queued or in-composer). Save under `outputs/redesign-baseline/final/`.

- [ ] **Step 4: Verify against the desktop**

Confirm by eye that the app's ground, accent and corner radius match the live theme:

```sh
cat ~/.local/state/omarchy/current/theme/colors.toml
hyprctl getoption decoration:rounding
```

The page background must equal the theme's `background`, the accent the theme's `accent` (or `blue`), and every corner must be square.

- [ ] **Step 5: Write the verification doc**

Record: the exact commands run, their real output, the screenshots' paths, what was **not** verified (no `npm run dist`, no installed payload, no live ChatGPT behaviour) and every assertion that was retargeted with its reason.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/verification/2026-09-18-omarchy-redesign.md
git commit -m "docs: record the redesign's verification"
```

---

## Self-Review

**Spec coverage.** §2 decisions: 1→T5/T10, 2→T7, 3→T6, 4→T6/T11, 5→T4, 5b→T4, 6→T12, 7→T8, 8→T5, 9→T11. §2.1 identity → T9, T10, T5, T7. §3.1 geometry → T2. §3.2 structure → T5, T11. §3.3 typography → T2. §3.4 palette → T4, T5. §4.1 spine → T9. §4.2 lifecycle → T7, T10. §4.3 sidebar → T6. §4.4 settings → T11. §4.5 motion/icons → T12. §4.6 work panel → T8. §4.7 categories → T5. §4.8 pages → T11. §5 theme → T4. §6 fonts → T2, T4. §7 unchanged → Global Constraints. §8 verification → T14, plus per-task checks. §9 risks → T14 step 4, and the retarget rule in Global Constraints.

**No placeholders.** Every step carries the real code, command or mapping it needs. The two pure-move tasks (T1, T3) specify what moves where by name rather than by "refactor this".

**Type consistency.** `OmarchyTheme` (T4) is used by `effectiveAppearance` and `monoChain` (T4) and by `AppState` (T4). `ContentCategory`/`categoryClass` (T5) are consumed by T9 and T10. `MessageStage`/`lifecycleOf` (T7) are consumed by T10 and asserted in T7's own test. `FrontendSegment` (T9) is self-contained. `InputEntry` is the existing type from `shared/input.js`; `SessionEventKind` and `SessionOrigin` are the existing types from `shared/session.js` — 13 event kinds, 4 origin kinds, and `resume` is **only** an origin kind (verified against `session.ts:460`).

**Parallel safety.** Phase 1's five tracks touch disjoint files: T4 (`main/omarchy-theme.ts`, `main/ipc.ts`, `main/index.ts`, `main/window-layout.ts`, `main/appearance-schema.ts`, `shared/appearance.ts`, `shared/types.ts`), T5 (`transcript-categories.ts`, `transcript.css`, `chat.ts` timeline region), T6 (`index.html` nav region, `main.ts`, `shell.css`), T7 (`message-lifecycle.ts`, `index.html` composer region, `outbox-view.ts`, `composer.css`), T8 (`file-panel.ts`, `agent-panel.ts`, `workspace-terminal.ts`, `work-panel-resize.ts`, `panels.css`).

Three shared-file rules make this safe:

1. **`shared/appearance.ts` belongs to T4 alone.** T5 consumes `paletteTokens`' status argument and must not edit that file — this is why the status extension lives in T4.
2. **`index.html` is shared by T6 and T7** as non-overlapping hunks (nav region vs composer region). **T7 waits for T6 to commit** before editing `index.html`; otherwise T7 starts after T6's commit.
3. **`chat.ts` is shared by T5 and T9**, but T9 is Phase 2 and starts only after T5 is committed.

Full conflict matrix: T4 touches nothing another Phase 1 track touches. T5, T6, T7, T8 are pairwise disjoint except `index.html`, serialized by rule 2.
