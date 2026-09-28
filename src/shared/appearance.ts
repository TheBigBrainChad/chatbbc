/** Saved appearance is presentation only. Live Omarchy colors are projected, never persisted. */
export const APPEARANCE_FONTS = ['system', 'sans', 'serif', 'mono'] as const;
export type AppearanceTheme = 'light' | 'dark';
export interface AppearancePalette {
  background: string;
  sidebar: string;
  accent: string;
  contrast: number;
}
export interface OmarchyPalette {
  mode: AppearanceTheme;
  background: string;
  foreground: string;
  accent: string;
  sidebar: string;
  selection?: string;
  red?: string;
  green?: string;
}
export interface OmarchyThemeState {
  status: 'available' | 'unavailable' | 'invalid';
  generation: number;
  palette: OmarchyPalette | null;
}
export interface AppearanceSettings {
  light: AppearancePalette;
  dark: AppearancePalette;
  font: typeof APPEARANCE_FONTS[number];
  fontSize: number;
  translucentSidebar: boolean;
  followOmarchy: boolean;
}
export function defaultAppearance(): AppearanceSettings {
  return {
    light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
    dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
    font: 'system', fontSize: 14, translucentSidebar: true, followOmarchy: true
  };
}

export interface ResolvedAppearance {
  theme: AppearanceTheme;
  settings: AppearanceSettings;
  foreground?: string;
  selection?: string;
  red?: string;
  green?: string;
}

/** Project live colors only onto the active mode; saved manual settings remain untouched. */
export function resolveAppearance(theme: AppearanceTheme, settings: AppearanceSettings | undefined,
  omarchy?: OmarchyThemeState | null): ResolvedAppearance {
  const manual = settings ?? defaultAppearance();
  const palette = manual.followOmarchy && omarchy ? omarchy.palette : null;
  if (!palette) return { theme, settings: manual };
  const mode = palette.mode;
  return {
    theme: mode,
    settings: { ...manual, [mode]: { ...manual[mode], background: palette.background, sidebar: palette.sidebar,
      accent: palette.accent } },
    foreground: palette.foreground, selection: palette.selection, red: palette.red, green: palette.green
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
    followOmarchy: pick(current.followOmarchy, before.followOmarchy, wanted.followOmarchy) };
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

export interface PaletteTokenOptions {
  foreground?: string;
  selection?: string;
  red?: string;
  green?: string;
}

function validColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#[\da-fA-F]{6}$/.test(value);
}

/** Keep derived surfaces as close to their tint as body-text contrast permits. */
function readableSurface(background: string, tint: string, amount: number, ink: string): string {
  const candidate = mixColor(background, tint, amount);
  if (contrastRatio(candidate, ink) >= 4.5) return candidate;
  for (let step = 19; step >= 0; step--) {
    const reduced = mixColor(background, tint, amount * step / 20);
    if (contrastRatio(reduced, ink) >= 4.5) return reduced;
  }
  return background;
}

function readableOnSurfaces(color: string, ink: string, surfaces: string[]): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, ink, step / 20);
    if (surfaces.every(surface => contrastRatio(candidate, surface) >= 4.5)) return candidate;
  }
  return ink;
}

/** One palette feeds existing semantic CSS tokens, including independently colored sidebars. */
export function paletteTokens(background: string, accent: string, contrast: number,
  options?: PaletteTokenOptions): Record<string, string> {
  const c = contrast / 100;
  const ink = validColor(options?.foreground) ? readableTint(options.foreground, background, 4.5) : readableInk(background);
  const surface = (tint: string, amount: number): string => options
    ? readableSurface(background, tint, amount, ink) : mixColor(background, tint, amount);
  const card = surface(ink, .025 + .06 * c);
  const sunk = surface(ink, .018 + .025 * c);
  const hover = surface(ink, .055 + .07 * c);
  const popover = surface(ink, .06 + .06 * c);
  const wash = surface(accent, .12);
  const green = validColor(options?.green) ? options.green : '#258552';
  const red = validColor(options?.red) ? options.red : '#d44545';
  const greenWash = surface(green, .12), redWash = surface(red, .12);
  const tint = (color: string, surfaces: string[]): string => options
    ? readableOnSurfaces(color, ink, surfaces) : readableTint(color, surfaces[0]!, 4.5);
  const textSurfaces = options ? [background, card, sunk, hover, popover, wash, greenWash, redWash] : [card];
  const tokens: Record<string, string> = {
    '--page': background, '--ink': ink, '--card': card, '--sunk': sunk,
    '--hover': hover, '--raise': hover, '--popover': popover,
    '--soft': tint(mixColor(background, ink, .53 + .2 * c), textSurfaces),
    '--faint': tint(mixColor(background, ink, .43 + .2 * c), textSurfaces),
    '--line': mixColor(background, ink, .09 + .13 * c), '--edge': mixColor(background, ink, .12 + .15 * c),
    '--track': mixColor(background, ink, .18 + .14 * c),
    '--blue': tint(accent, options ? textSurfaces : [background]),
    '--accent': tint(accent, options ? textSurfaces : [background]),
    '--accent-fill': accent, '--on-accent': readableInk(accent),
    '--wash': wash, '--blue-line': mixColor(background, accent, .3),
    '--accent-wash': wash, '--accent-edge': mixColor(background, accent, .35),
    '--knob-off': ink, '--knob-on': readableInk(accent),
    '--green': tint(green, options ? [card, greenWash] : [card]), '--green-wash': greenWash,
    '--green-line': mixColor(background, green, .3),
    '--red': tint(red, options ? [card, redWash] : [card]), '--red-wash': redWash,
    '--red-line': mixColor(background, red, .3)
  };
  if (validColor(options?.selection)) {
    tokens['--selection'] = options.selection;
    tokens['--selection-ink'] = readableInk(options.selection);
  }
  return tokens;
}
