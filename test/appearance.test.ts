import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { appearanceSchema } from '../src/main/appearance-schema.js';
import {
  DEFAULT_MONO_CHAIN, contrastFor, defaultAppearance, effectiveAppearance, effectiveTheme, followedTheme,
  mergeAppearance, monoChain, paletteTokens, contrastRatio, readableInk
} from '../src/shared/appearance.js';
import type { OmarchyTheme } from '../src/main/omarchy-theme.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from '../src/main/window-layout.js';

describe('custom appearance', () => {
  it('accepts arbitrary RGB colors, including identical accent and background, and bounds other preferences', () => {
    const appearance = defaultAppearance();
    appearance.dark = { background: '#51a20F', sidebar: '#fE0193', accent: '#51a20F', contrast: 0 };
    expect(appearanceSchema.parse(appearance)).toEqual(appearance);
    for (const bad of ['red', '#fff', '#12345678', 'url(https://example.com)', '#abcdef;display:none']) {
      expect(appearanceSchema.safeParse({ ...appearance, dark: { ...appearance.dark, sidebar: bad } }).success).toBe(false);
    }
    for (const fontSize of [11, 19, 14.5, Infinity]) expect(appearanceSchema.safeParse({ ...appearance, fontSize }).success).toBe(false);
    expect(appearanceSchema.safeParse({ ...appearance, font: 'remote-font' }).success).toBe(false);
  });

  it('retains readable text and buttons across light, dark and vivid custom backgrounds', () => {
    for (const background of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#fea5cf']) {
      for (const contrast of [0, 45, 100]) {
        const tokens = paletteTokens(background, background, contrast);
        expect(contrastRatio(tokens['--ink']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--soft']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--faint']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--blue']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--on-accent']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(tokens['--accent-fill']).toBe(background);
      }
    }
  });

  it('derives the complete Crystal token family from one palette', () => {
    const tokens = paletteTokens('#14101d', '#c8a6ff', 60, { green: '#8ee7de', red: '#ff7898' });
    expect(tokens).toMatchObject({
      '--canvas': '#14101d',
      '--ink-on-accent': '#000000'
    });
    for (const name of ['--canvas-atmosphere', '--glass-low', '--glass-medium', '--glass-high',
      '--glass-readable', '--ink-muted', '--accent-readable', '--accent-glow', '--hairline',
      '--shadow', '--scrim']) expect(tokens[name], name).toBeTruthy();
    expect(contrastRatio(tokens['--accent-readable']!, tokens['--canvas']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens['--ink']!, tokens['--glass-readable']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('merges stale windows per color and per theme without overwriting concurrent edits', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    live.dark.sidebar = '#ff0066'; live.light.background = '#f1f2f3'; live.font = 'serif';
    wanted.dark.accent = '#7600ff'; wanted.fontSize = 18;
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.dark).toEqual({ ...live.dark, accent: '#7600ff' });
    expect(merged.light).toEqual(live.light);
    expect(merged.font).toBe('serif'); expect(merged.fontSize).toBe(18);
    expect(mergeAppearance(live, undefined, undefined)).toBe(live);
    expect(base).toEqual(defaultAppearance());
  });

  it('uses the custom sidebar for native caption contrast and the custom page for reload backing', () => {
    const appearance = defaultAppearance();
    appearance.dark.sidebar = '#ffffff'; appearance.dark.background = '#391c56'; appearance.translucentSidebar = false;
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#ffffff') });
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#391c56');
  });

  it('keeps every radius square and publishes a mono chrome font token', async () => {
    const css = await fs.readFile(path.resolve(__dirname, '../src/renderer/styles/base.css'), 'utf8');
    const block = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
    // The desktop is decoration:rounding = 0; every radius name must resolve to 0.
    for (const name of ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--pill']) {
      expect(block, `${name} is not square`).toMatch(new RegExp(`${name}:\\s*0(px)?\\s*;`));
    }
    // Chrome reads this token, so it must exist before the renderer resolves it, and
    // it must end in a real mono: a proportional fallback breaks every aligned column.
    expect(block, 'no mono chrome token').toContain('--ui-font-mono:');
    expect(block.slice(block.indexOf('--ui-font-mono:')).split(';')[0]).toMatch(/monospace\s*$/);
    // The stylesheet ships the chain so chrome is styled before the renderer runs, and the
    // renderer overwrites it from DEFAULT_MONO_CHAIN on every paint. Two copies can drift,
    // and a drift is invisible until the first repaint on a machine with no theme, so pin them.
    const declared = block.slice(block.indexOf('--ui-font-mono:') + '--ui-font-mono:'.length).split(';')[0]!.trim();
    expect(declared, 'stylesheet chain drifted from the renderer chain').toBe(DEFAULT_MONO_CHAIN);
  });
});

/**
 * The token map this file produced before the status argument existed, captured from the
 * committed revision. Following the desktop must not perturb the default path, and the
 * only honest way to prove "byte-identical" is to compare against the real bytes.
 */
const BEFORE_STATUS: Record<'dark' | 'light', Record<string, string>> = {
  'dark': {
    '--page': '#181818', '--ink': '#ffffff', '--card': '#262626', '--sunk': '#202020', '--hover': '#2e2e2e',
    '--raise': '#2e2e2e', '--soft': '#aeaeae', '--faint': '#979797', '--line': '#3f3f3f', '--edge': '#494949',
    '--track': '#555555', '--blue': '#b0cbed', '--accent': '#b0cbed', '--accent-fill': '#b0cbed',
    '--on-accent': '#000000', '--wash': '#2a2d32', '--blue-line': '#464e58', '--accent-wash': '#2a2d32',
    '--accent-edge': '#4d5763', '--knob-off': '#ffffff', '--knob-on': '#000000', '--green': '#519d75',
    '--green-wash': '#1a251f', '--green-line': '#1c3929', '--red': '#dd6a6a', '--red-wash': '#2f1d1d',
    '--red-line': '#502626'
  },
  'light': {
    '--page': '#f4f4f5', '--ink': '#000000', '--card': '#e7e7e8', '--sunk': '#ededee', '--hover': '#dfdfe0',
    '--raise': '#dfdfe0', '--soft': '#5d5d5d', '--faint': '#636364', '--line': '#d0d0d1', '--edge': '#c6c6c7',
    '--track': '#b9b9b9', '--blue': '#486f9d', '--accent': '#486f9d', '--accent-fill': '#486f9d',
    '--on-accent': '#ffffff', '--wash': '#dfe4ea', '--blue-line': '#c0ccdb', '--accent-wash': '#dfe4ea',
    '--accent-edge': '#b8c5d6', '--knob-off': '#000000', '--knob-on': '#ffffff', '--green': '#1f7146',
    '--green-wash': '#dbe7e1', '--green-line': '#b6d3c4', '--red': '#b43b3b', '--red-wash': '#f0dfe0',
    '--red-line': '#eac0c0'
  }
};

const OSAKA: OmarchyTheme = {
  name: 'osaka-jade', mode: 'dark', background: '#111c18', accent: '#509475', sidebar: '#23372B',
  green: '#549e6a', red: '#FF5345', fontFamily: 'Iosevka Nerd Font Mono'
};

describe('following the desktop theme', () => {
  it('retains every pre-existing token while adding the complete semantic families', () => {
    const defaults = defaultAppearance();
    for (const theme of ['dark', 'light'] as const) {
      const { background, accent, contrast } = defaults[theme];
      const tokens = paletteTokens(background, accent, contrast);
      for (const [key, value] of Object.entries(BEFORE_STATUS[theme])) {
        expect(tokens[key], `${theme} ${key}`).toBe(value);
      }
      // A renamed or dropped legacy token would silently unstyle a rule that still reads it,
      // while a missing semantic role would leave a Crystal surface without a fallback.
      const added = Object.keys(tokens).filter(key => !(key in BEFORE_STATUS[theme]!)).sort();
      expect(added, `${theme} new tokens`).toEqual([
        '--accent-glow', '--accent-readable', '--canvas', '--canvas-atmosphere', '--cyan',
        '--glass-high', '--glass-low', '--glass-medium', '--glass-readable', '--hairline',
        '--ice', '--ink-muted', '--ink-on-accent', '--magenta', '--scrim', '--shadow', '--yellow'
      ]);
      expect(Object.keys(BEFORE_STATUS[theme]!).filter(key => !(key in tokens))).toEqual([]);
    }
  });

  it('lets a followed theme supply its own status colours without disturbing the rest', () => {
    const status = { green: '#00ff00', red: '#ff0000', cyan: '#00ffff', magenta: '#ff00ff', yellow: '#ffff00', ice: '#ccffff' };
    const base = paletteTokens('#181818', '#b0cbed', 60);
    const themed = paletteTokens('#181818', '#b0cbed', 60, status);
    // The neutral geometry and text ramps are the palette's, not the status colours'.
    for (const key of ['--page', '--ink', '--card', '--soft', '--faint', '--line', '--edge', '--track', '--accent']) {
      expect(themed[key], key).toBe(base[key]);
    }
    expect(themed['--green']).not.toBe(base['--green']);
    expect(themed['--red']).not.toBe(base['--red']);
    // Category identities are real tokens in both worlds, readable on the card.
    for (const key of ['--cyan', '--magenta', '--yellow', '--ice']) {
      expect(contrastRatio(themed[key]!, themed['--card']!), key).toBeGreaterThanOrEqual(4.5);
      expect(base[key], `${key} missing without a status palette`).toBeTruthy();
    }
  });

  it('leaves the saved manual palettes untouched when follow is off, missing or malformed', () => {
    const saved = defaultAppearance();
    saved.dark = { background: '#391c56', sidebar: '#ffffff', accent: '#7600ff', contrast: 12 };
    saved.light = { background: '#fffff0', sidebar: '#f1f2f3', accent: '#123456', contrast: 70 };
    const frozen = structuredClone(saved);
    const off = { ...saved, followDesktop: false };

    expect(effectiveAppearance({ theme: 'dark', appearance: saved }, null)).toBe(saved);
    expect(effectiveAppearance({ theme: 'dark', appearance: saved }, { ...OSAKA })).toBe(saved); // follow absent
    expect(effectiveAppearance({ theme: 'dark', appearance: off }, { ...OSAKA })).toBe(off);
    expect(effectiveAppearance({ theme: 'dark' }, { ...OSAKA })).toEqual(defaultAppearance());
    // Nothing above wrote to the caller's object, so turning follow off restores it exactly.
    expect(saved).toEqual(frozen);
    // A theme the reader rejected (null) is the same as no theme: the saved colours still apply.
    const followed = effectiveAppearance({ theme: 'dark', appearance: { ...saved, followDesktop: true } }, { ...OSAKA });
    expect(followed).toEqual({
      ...frozen,
      followDesktop: true,
      dark: { background: '#111c18', sidebar: '#23372B', accent: '#509475', contrast: 60 },
      status: { green: '#549e6a', red: '#FF5345' }
    });
    expect(saved).toEqual(frozen);
  });

  it('replaces only the slot the followed theme selects and reports its own mode', () => {
    const saved = defaultAppearance();
    const frozen = structuredClone(saved);
    const dark = { ...saved, followDesktop: true };
    expect(effectiveTheme({ theme: 'light', appearance: dark }, OSAKA)).toBe('dark');
    expect(effectiveTheme({ theme: 'light', appearance: dark }, null)).toBe('light');
    expect(effectiveTheme({ theme: 'light', appearance: { ...saved, followDesktop: false } }, OSAKA)).toBe('light');
    // A light desktop theme resolves to the light slot, so a custom dark palette survives.
    const light = { ...OSAKA, mode: 'light' as const, background: '#f7f7f7' };
    const resolved = effectiveAppearance({ theme: 'dark', appearance: dark }, light);
    expect(resolved.light.background).toBe('#f7f7f7');
    expect(resolved.dark).toEqual(saved.dark);
    expect(resolved.light.contrast).toBe(contrastFor('#f7f7f7'));
    expect(resolved.light.contrast).toBe(45);
    expect(effectiveAppearance({ theme: 'dark', appearance: dark }, OSAKA).dark.contrast).toBe(60);
    expect(saved).toEqual(frozen);
  });

  it('carries follow mode through a save merge and never persists derived status', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    wanted.followDesktop = true;
    live.status = { green: '#00ff00' };
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.followDesktop).toBe(true);
    expect(merged.status).toBeUndefined();
    // The saved shape is exactly the schema's, with no derived palette leaking into config.
    const saved = effectiveAppearance({ theme: 'dark', appearance: { ...base, followDesktop: true } }, OSAKA);
    const parsed = appearanceSchema.parse(saved);
    expect(parsed.followDesktop).toBe(true);
    expect('status' in parsed).toBe(false);
    expect(saved.dark.background).toBe('#111c18');
  });

  it('prefers the desktop terminal font for chrome and falls back to the built-in chain', () => {
    // A theme that names the chain's own head — this machine's Iosevka — adds nothing twice.
    expect(monoChain(OSAKA)).toBe(DEFAULT_MONO_CHAIN);
    expect(monoChain({ ...OSAKA, fontFamily: 'Fira Code' })).toBe(`"Fira Code", ${DEFAULT_MONO_CHAIN}`);
    expect(monoChain({ ...OSAKA, fontFamily: null })).toBe(DEFAULT_MONO_CHAIN);
    expect(monoChain(null)).toBe(DEFAULT_MONO_CHAIN);
    // A name with spaces must stay quoted, or it parses as several family names.
    expect(monoChain({ ...OSAKA, fontFamily: 'Fira Code' }).startsWith('"Fira Code"')).toBe(true);
  });

  it('resolves the desktop only through the one follow gate', () => {
    const on = { ...defaultAppearance(), followDesktop: true }, off = defaultAppearance();
    expect(followedTheme({ appearance: on }, OSAKA)).toBe(OSAKA);
    expect(followedTheme({ appearance: off }, OSAKA)).toBeNull();
    expect(followedTheme({ appearance: on }, null)).toBeNull();
    expect(followedTheme({}, OSAKA)).toBeNull();
    // The palette, the mode and the font all read that gate, so the toggle cannot be
    // honoured by two of them and ignored by the third.
    const themed = { ...OSAKA, mode: 'light' as const, fontFamily: 'Fira Code' };
    expect(effectiveTheme({ theme: 'dark', appearance: on }, themed)).toBe('light');
    expect(effectiveTheme({ theme: 'dark', appearance: off }, themed)).toBe('dark');
    expect(effectiveAppearance({ theme: 'dark', appearance: off }, themed)).toBe(off);
    expect(monoChain(followedTheme({ appearance: off }, themed))).toBe(DEFAULT_MONO_CHAIN);
  });

  it('keeps the built-in chain in spec §6 order', () => {
    expect(DEFAULT_MONO_CHAIN).toBe('"Iosevka Nerd Font Mono", "Iosevka NFM", "JetBrains Mono Nerd Font", '
      + '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace');
    // The last resort must be a real mono: a proportional fallback breaks every column.
    expect(DEFAULT_MONO_CHAIN.endsWith('monospace')).toBe(true);
  });

  it('signals the followed theme to the native caption and backing colours', () => {
    const appearance = effectiveAppearance({ theme: 'dark', appearance: { ...defaultAppearance(), followDesktop: true } }, OSAKA);
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#111c18');
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#23372B') });
    // Follow off is the manual answer, unchanged.
    const manual = { ...defaultAppearance(), dark: { background: '#391c56', sidebar: '#ffffff', accent: '#7600ff', contrast: 12 }, translucentSidebar: false };
    expect(windowBackgroundForTheme('dark', effectiveAppearance({ theme: 'dark', appearance: manual }, OSAKA))).toBe('#391c56');
  });
});

describe('renderer applies the resolved appearance', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** The renderer module is DOM-bound, so the document must exist before it is imported. */
  async function paint(followDesktop: boolean, omarchy: OmarchyTheme | null) {
    const dom = new JSDOM('<html><body><div class="sidebar"></div></body></html>');
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    const { applyAppearance } = await import('../src/renderer/appearance.js');
    const saved = { ...defaultAppearance(), followDesktop };
    applyAppearance('dark', saved, omarchy);
    const root = dom.window.document.documentElement, read = (name: string) => root.style.getPropertyValue(name);
    return { root, read, saved };
  }

  it('draws the followed palette, mode and terminal font', async () => {
    const { root, read } = await paint(true, OSAKA);
    expect(read('--page')).toBe('#111c18');
    expect(read('--accent-fill')).toBe('#509475');
    expect(read('--sidebar-color')).toBe('#23372B');
    // The theme names the chain's own head here, so the chain is unchanged and not doubled.
    expect(read('--ui-font-mono')).toBe(DEFAULT_MONO_CHAIN);
    // The desktop's own green/red reach the status tokens, not the app's built-in pair.
    expect(read('--green')).toBe(paletteTokens('#111c18', '#509475', 60, { green: '#549e6a', red: '#FF5345' })['--green']);
    expect(read('--green-wash')).toBe(paletteTokens('#111c18', '#509475', 60, { green: '#549e6a' })['--green-wash']);
    expect(root.dataset.theme).toBe('dark');
    // A followed theme's status colours are additive: the category tokens exist.
    for (const name of ['--cyan', '--magenta', '--yellow', '--ice']) expect(read(name), name).not.toBe('');
  });

  it('draws the saved manual palette and the built-in chain when follow is off', async () => {
    // The theme deliberately ships a font that is NOT the chain's head: with follow off the
    // desktop must not restyle chrome at all, so the chain has to be the built-in one. A
    // fixture whose font was already the head would pass either way and prove nothing.
    const { read, saved } = await paint(false, { ...OSAKA, fontFamily: 'Fira Code' });
    expect(read('--page')).toBe(saved.dark.background);
    expect(read('--accent-fill')).toBe(saved.dark.accent);
    expect(read('--ui-font-mono')).toBe(DEFAULT_MONO_CHAIN);
    expect(read('--ui-font-mono')).not.toContain('Fira Code');
    // Nor do its status colours reach the tokens.
    expect(read('--green')).toBe(paletteTokens(saved.dark.background, saved.dark.accent, saved.dark.contrast)['--green']);
    expect(read('--green-wash')).toBe(paletteTokens(saved.dark.background, saved.dark.accent, saved.dark.contrast)['--green-wash']);
  });

  it('puts a followed theme’s own terminal font at the head of the chrome chain', async () => {
    const { read } = await paint(true, { ...OSAKA, fontFamily: 'Fira Code' });
    expect(read('--ui-font-mono')).toBe(`"Fira Code", ${DEFAULT_MONO_CHAIN}`);
  });

  it('draws the saved palette when following is on but this machine has no theme', async () => {
    const { read, saved } = await paint(true, null);
    expect(read('--page')).toBe(saved.dark.background);
    expect(read('--ui-font-mono')).toBe(DEFAULT_MONO_CHAIN);
  });

  it('adopts a light desktop theme without changing the saved palettes', async () => {
    const { read, saved } = await paint(true, { ...OSAKA, mode: 'light', background: '#f7f7f7', sidebar: '#efefef', accent: '#046a45' });
    expect(read('--page')).toBe('#f7f7f7');
    expect(saved.light.background).toBe(defaultAppearance().light.background);
    expect(saved.dark.background).toBe(defaultAppearance().dark.background);
  });
});
