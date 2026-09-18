import type { OmarchyTheme } from '../main/omarchy-theme.js';

/** Saved appearance is presentation only. Theme remains the existing ui.theme choice. */
export const APPEARANCE_FONTS = ['system', 'sans', 'serif', 'mono'] as const;
export type AppearanceTheme = 'light' | 'dark';
export interface AppearancePalette {
  background: string;
  sidebar: string;
  accent: string;
  contrast: number;
}
export interface AppearanceSettings {
  light: AppearancePalette;
  dark: AppearancePalette;
  font: typeof APPEARANCE_FONTS[number];
  fontSize: number;
  translucentSidebar: boolean;
  /** Follow the live desktop theme instead of these palettes. Absent reads as off. */
  followDesktop?: boolean;
  /** Derived from a followed theme, never saved: the schema has no such field. */
  status?: StatusPalette;
}
export function defaultAppearance(): AppearanceSettings {
  return {
    light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
    dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
    font: 'system', fontSize: 14, translucentSidebar: true
  };
}

/** Field-wise three-way merge, so an unrelated save cannot undo another window's colors. */
export function mergeAppearance(live: AppearanceSettings | undefined, base: AppearanceSettings | undefined,
  wanted: AppearanceSettings | undefined): AppearanceSettings | undefined {
  if (!wanted) return live;
  const current = live ?? defaultAppearance(), before = base ?? defaultAppearance();
  const pick = <T>(a: T, b: T, c: T): T => Object.is(b, c) ? a : c;
  const palette = (theme: AppearanceTheme): AppearancePalette => ({
    background: pick(current[theme].background, before[theme].background, wanted[theme].background),
    sidebar: pick(current[theme].sidebar, before[theme].sidebar, wanted[theme].sidebar),
    accent: pick(current[theme].accent, before[theme].accent, wanted[theme].accent),
    contrast: pick(current[theme].contrast, before[theme].contrast, wanted[theme].contrast)
  });
  return { light: palette('light'), dark: palette('dark'), font: pick(current.font, before.font, wanted.font),
    fontSize: pick(current.fontSize, before.fontSize, wanted.fontSize),
    translucentSidebar: pick(current.translucentSidebar, before.translucentSidebar, wanted.translucentSidebar),
    // Follow mode is a real preference and merges like one. `status` is derived from the live
    // theme on every read, so merging it would only let a stale window persist a theme it
    // was not looking at.
    followDesktop: pick(current.followDesktop, before.followDesktop, wanted.followDesktop) };
}

function channels(hex: string): number[] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}
export function mixColor(a: string, b: string, amount: number): string {
  const right = channels(b);
  return '#' + channels(a).map((value, i) => Math.round(value + (right[i]! - value) * amount)
    .toString(16).padStart(2, '0')).join('');
}
export function luminance(color: string): number {
  const linear = channels(color).map(value => {
    const n = value / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function readableInk(background: string): string {
  return contrastRatio(background, '#ffffff') > contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}
function readableTint(color: string, background: string, ratio: number): string {
  const ink = readableInk(background);
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, ink, step / 20);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return ink;
}

/**
 * A followed desktop theme's own status roles. Absent roles keep the app's own colours,
 * so a theme that names only some of them still produces a complete, readable palette.
 */
export interface StatusPalette {
  green?: string; red?: string; cyan?: string; magenta?: string; yellow?: string; ice?: string;
}

/** One palette feeds existing semantic CSS tokens, including independently colored sidebars. */
export function paletteTokens(background: string, accent: string, contrast: number,
  status?: StatusPalette): Record<string, string> {
  const ink = readableInk(background), c = contrast / 100;
  const card = mixColor(background, ink, .025 + .06 * c);
  const hover = mixColor(background, ink, .055 + .07 * c);
  const green = status?.green ?? '#258552', red = status?.red ?? '#d44545';
  return {
    '--page': background, '--ink': ink, '--card': card, '--sunk': mixColor(background, ink, .018 + .025 * c),
    '--hover': hover, '--raise': hover,
    '--soft': readableTint(mixColor(background, ink, .53 + .2 * c), card, 4.5),
    '--faint': readableTint(mixColor(background, ink, .43 + .2 * c), card, 4.5),
    '--line': mixColor(background, ink, .09 + .13 * c), '--edge': mixColor(background, ink, .12 + .15 * c),
    '--track': mixColor(background, ink, .18 + .14 * c),
    '--blue': readableTint(accent, background, 4.5), '--accent': readableTint(accent, background, 4.5),
    '--accent-fill': accent, '--on-accent': readableInk(accent),
    '--wash': mixColor(background, accent, .12), '--blue-line': mixColor(background, accent, .3),
    '--accent-wash': mixColor(background, accent, .12), '--accent-edge': mixColor(background, accent, .35),
    '--knob-off': ink, '--knob-on': readableInk(accent),
    '--green': readableTint(green, card, 4.5), '--green-wash': mixColor(background, green, .12),
    '--green-line': mixColor(background, green, .3),
    '--red': readableTint(red, card, 4.5), '--red-wash': mixColor(background, red, .12),
    '--red-line': mixColor(background, red, .3),
    '--cyan': readableTint(status?.cyan ?? '#2DD5B7', card, 4.5),
    '--magenta': readableTint(status?.magenta ?? '#D2689C', card, 4.5),
    '--yellow': readableTint(status?.yellow ?? '#E5C736', card, 4.5),
    '--ice': readableTint(status?.ice ?? '#ACD4CF', card, 4.5)
  };
}

/**
 * The desktop terminal font, then the app's own mono chain. One owner for both callers.
 * Order is spec §6: Iosevka NF Mono, Iosevka NFM, JetBrains Mono NF, JetBrains Mono,
 * Cascadia Mono, ui-monospace, monospace.
 */
export const DEFAULT_MONO_CHAIN =
  '"Iosevka Nerd Font Mono", "Iosevka NFM", "JetBrains Mono Nerd Font", "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace';

/**
 * Chrome type prefers the desktop's own terminal font, quoted, over the built-in chain.
 * A theme whose terminal font is already the chain's first candidate — this machine's
 * Iosevka, or its own family — contributes nothing rather than being emitted twice.
 */
export function monoChain(omarchy: OmarchyTheme | null): string {
  const family = omarchy?.fontFamily?.trim();
  if (!family) return DEFAULT_MONO_CHAIN;
  return DEFAULT_MONO_CHAIN.startsWith(`"${family}",`) ? DEFAULT_MONO_CHAIN : `"${family}", ${DEFAULT_MONO_CHAIN}`;
}

/**
 * The legibility floor a ground calls for. A dark ground keeps the 60 the built-in dark
 * palette uses and a light one the 45, so a followed theme is exactly as readable as a
 * hand-picked one, and the contrast control keeps its existing meaning.
 */
export function contrastFor(background: string): number {
  return readableInk(background) === '#000000' ? 45 : 60;
}

/**
 * The theme actually being followed, or null when the saved settings do not follow one.
 * The one gate: palette, mode and chrome font all resolve through it, so none of the three
 * can drift into following the desktop while the toggle says otherwise.
 */
export function followedTheme(
  ui: { appearance?: AppearanceSettings },
  omarchy: OmarchyTheme | null
): OmarchyTheme | null {
  return ui.appearance?.followDesktop && omarchy ? omarchy : null;
}

/** The desktop's own light/dark answer wins in follow mode; otherwise the user's explicit choice. */
export function effectiveTheme(
  ui: { theme: AppearanceTheme; appearance?: AppearanceSettings },
  omarchy: OmarchyTheme | null
): AppearanceTheme {
  return followedTheme(ui, omarchy)?.mode ?? ui.theme;
}

/**
 * The one place a followed desktop theme becomes an appearance. Pure, so main and renderer
 * cannot disagree, and the saved manual palettes are never touched: only the slot the
 * followed theme's own `mode` selects is replaced, and turning follow off restores the
 * saved colours because they were never written.
 *
 * `status` is derived here and stripped by the schema on save, so a followed theme's
 * status colours can never become durable config.
 */
export function effectiveAppearance(
  ui: { theme: AppearanceTheme; appearance?: AppearanceSettings },
  omarchy: OmarchyTheme | null
): AppearanceSettings {
  const saved = ui.appearance ?? defaultAppearance(), followed = followedTheme(ui, omarchy);
  if (!followed) return saved;
  const mode = followed.mode;
  return {
    ...saved,
    [mode]: {
      background: followed.background,
      sidebar: followed.sidebar,
      accent: followed.accent,
      contrast: contrastFor(followed.background)
    },
    status: { green: followed.green, red: followed.red }
  };
}
