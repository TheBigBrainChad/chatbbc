import { describe, it, expect } from 'vitest';
import { appearanceSchema } from '../src/main/appearance-schema.js';
import { defaultAppearance, mergeAppearance, paletteTokens, contrastRatio, readableInk, resolveAppearance } from '../src/shared/appearance.js';
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

  it('preserves preexisting manual palettes while fresh installs follow live Omarchy', () => {
    const fresh = defaultAppearance();
    expect(fresh.followOmarchy).toBe(true);
    const old = appearanceSchema.parse({ ...fresh, followOmarchy: undefined });
    expect(old.followOmarchy).toBe(false);
    const manual = { ...fresh, followOmarchy: false };
    const live = { status: 'available' as const, generation: 1, palette: {
      mode: 'dark' as const, background: '#282828', foreground: '#d4be98',
      accent: '#7daea3', sidebar: '#1e1e1e'
    } };
    expect(resolveAppearance('light', manual, live).settings.light).toEqual(manual.light);
    const projected = resolveAppearance('light', fresh, live);
    expect(projected.theme).toBe('dark');
    expect(projected.settings.dark).toMatchObject({ background: '#282828', sidebar: '#1e1e1e', accent: '#7daea3' });
    expect(fresh.dark.background).not.toBe('#282828');
    expect(paletteTokens('#282828', '#7daea3', 60, { foreground: '#d4be98' })['--ink']).toBe('#d4be98');
  });

  it('projects only the active palette and retains manual colors through unavailable snapshots', () => {
    const saved = defaultAppearance();
    saved.light.background = '#abcdef';
    saved.dark.accent = '#334455';
    const omarchy = { status: 'available' as const, generation: 2, palette: {
      mode: 'light' as const, background: '#fafafa', foreground: '#202020',
      accent: '#2456a6', sidebar: '#eeeeee', selection: '#c2ddf9',
      red: '#aa2244', green: '#227744'
    } };
    const projected = resolveAppearance('dark', saved, omarchy);
    expect(projected.theme).toBe('light');
    expect(projected.settings.light).toEqual({ ...saved.light, background: '#fafafa', sidebar: '#eeeeee', accent: '#2456a6' });
    expect(projected.settings.dark).toEqual(saved.dark);
    expect(projected).toMatchObject({ foreground: '#202020', selection: '#c2ddf9', red: '#aa2244', green: '#227744' });
    expect(saved.light.background).toBe('#abcdef');
    expect(saved.followOmarchy).toBe(true);
    const missing = resolveAppearance('dark', saved, { status: 'unavailable', generation: 3, palette: null });
    expect(missing.theme).toBe('dark');
    expect(missing.settings.dark).toEqual(saved.dark);
    expect(missing.foreground).toBeUndefined();
    const manual = resolveAppearance('dark', { ...saved, followOmarchy: false }, omarchy);
    expect(manual.theme).toBe('dark');
    expect(manual.settings.light).toEqual(saved.light);
    expect(manual.selection).toBeUndefined();
  });

  it('keeps Omarchy text and semantic colors readable on both page and sidebar surfaces', () => {
    for (const background of ['#282828', '#fafafa', '#777777']) {
      const foreground = background === '#282828' ? '#d4be98' : background === '#fafafa' ? '#202020' : '#010101';
      const tokens = paletteTokens(background, '#7daea3', 100, {
        foreground, selection: '#aabbcc', red: '#cc2266', green: '#44cc88'
      });
      expect(tokens['--page']).toBe(background);
      expect(tokens['--accent-fill']).toBe('#7daea3');
      expect(tokens['--selection']).toBe('#aabbcc');
      expect(tokens['--ink']).toBe(foreground);
      expect(contrastRatio(tokens['--selection-ink']!, tokens['--selection']!)).toBeGreaterThanOrEqual(4.5);
      for (const surface of ['--page', '--card', '--sunk', '--hover', '--raise', '--popover', '--wash', '--accent-wash',
        '--green-wash', '--red-wash']) {
        expect(contrastRatio(tokens['--ink']!, tokens[surface]!)).toBeGreaterThanOrEqual(4.5);
      }
      for (const tint of ['--soft', '--faint', '--accent', '--blue', '--red', '--green']) {
        expect(contrastRatio(tokens[tint]!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(tokens['--green']!, tokens['--green-wash']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['--red']!, tokens['--red-wash']!)).toBeGreaterThanOrEqual(4.5);
    }
    expect(paletteTokens('#282828', '#7daea3', 60, { foreground: '#d4be98' })['--ink']).toBe('#d4be98');
    const adjusted = paletteTokens('#ffffff', '#123456', 45, { foreground: '#fefefe' });
    expect(contrastRatio(adjusted['--ink']!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    const sidebar = paletteTokens('#eeeeee', '#2456a6', 60, { foreground: '#202020' });
    expect(sidebar['--page']).toBe('#eeeeee');
    expect(contrastRatio(sidebar['--ink']!, sidebar['--popover']!)).toBeGreaterThanOrEqual(4.5);
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

  it('merges stale windows per color and per theme without overwriting concurrent edits', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    live.dark.sidebar = '#ff0066'; live.light.background = '#f1f2f3'; live.font = 'serif';
    live.followOmarchy = false;
    wanted.dark.accent = '#7600ff'; wanted.fontSize = 18;
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.dark).toEqual({ ...live.dark, accent: '#7600ff' });
    expect(merged.light).toEqual(live.light);
    expect(merged.font).toBe('serif'); expect(merged.fontSize).toBe(18);
    expect(merged.followOmarchy).toBe(false);
    expect(mergeAppearance(live, base, { ...wanted, followOmarchy: false })!.followOmarchy).toBe(false);
    expect(mergeAppearance(base, base, { ...wanted, followOmarchy: false })!.followOmarchy).toBe(false);
    expect(mergeAppearance(live, undefined, undefined)).toBe(live);
    expect(base).toEqual(defaultAppearance());
  });

  it('uses the custom sidebar for native caption contrast and the custom page for reload backing', () => {
    const appearance = defaultAppearance();
    appearance.dark.sidebar = '#ffffff'; appearance.dark.background = '#391c56'; appearance.translucentSidebar = false;
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#ffffff') });
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#391c56');
  });
});
