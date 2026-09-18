import {
  DEFAULT_MONO_CHAIN, defaultAppearance, effectiveAppearance, effectiveTheme, followedTheme, mixColor,
  monoChain, paletteTokens, type AppearanceSettings, type AppearanceTheme
} from '../shared/appearance.js';
import type { OmarchyTheme } from '../main/omarchy-theme.js';
import type { UiPrefs } from '../shared/types.js';
import { $ } from './dom.js';
import { ui, t } from './i18n.js';

const FONT_FAMILIES = {
  system: '', sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif', mono: DEFAULT_MONO_CHAIN
};

const appearanceListeners = new Set<() => void>();
/** Canvas/terminal renderers must refresh after the CSS palette has been applied. */
export function onAppearanceChanged(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => { appearanceListeners.delete(listener); };
}
function tokens(element: HTMLElement, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
}

/**
 * Paint one appearance. `omarchy` is the live desktop theme, and when the saved settings
 * follow it the palette, the light/dark answer and the chrome font all come from there
 * instead — resolved through the same pure helpers main uses, so the two cannot disagree.
 * With follow off or no theme this is exactly the manual palette it always was.
 */
export function applyAppearance(theme: AppearanceTheme, settings?: AppearanceSettings,
  omarchy?: OmarchyTheme | null): void {
  const ui = { theme, appearance: settings ?? defaultAppearance() };
  const followed = followedTheme(ui, omarchy ?? null);
  const value = effectiveAppearance(ui, omarchy ?? null), resolved = effectiveTheme(ui, omarchy ?? null);
  const palette = value[resolved], root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.translucentSidebar = String(value.translucentSidebar);
  tokens(root, paletteTokens(palette.background, palette.accent, palette.contrast, value.status));
  root.style.setProperty('--text-scale', String(value.fontSize / 14));
  if (value.font === 'system') root.style.removeProperty('--ui-font');
  else root.style.setProperty('--ui-font', FONT_FAMILIES[value.font]);
  // Chrome is always the mono chain; only prose follows the picker. The desktop's own
  // terminal font leads it **only while the desktop is followed** — with the toggle off, a
  // machine whose theme ships a font must still get the built-in chain, exactly as the
  // palette is untouched.
  root.style.setProperty('--ui-font-mono', monoChain(followed));
  root.style.setProperty('--sidebar-color', palette.sidebar);
  // Glass is composed inside the window: a colored backdrop and translucent layer.
  // No native transparent window, desktop capture, or platform permission is needed.
  const sidebarBackground = value.translucentSidebar ? mixColor(palette.sidebar, palette.background, .13) : palette.sidebar;
  for (const element of document.querySelectorAll<HTMLElement>('.sidebar, .app-topbar, .appearance-preview-sidebar, .connection-popover')) {
    // Same status palette as the page, or the sidebar's green/red would disagree with the
    // conversation's beside it.
    tokens(element, paletteTokens(sidebarBackground, palette.accent, palette.contrast, value.status));
  }
  for (const listener of appearanceListeners) listener();
}

/**
 * Only the in-progress form edit is local; the existing Settings queue owns persistence.
 *
 * The controls always edit the *saved* palettes, even while a followed desktop theme is
 * what is drawn — so following and unfollowing never destroys a manual colour, and the
 * panel keeps showing what turning follow off will restore.
 *
 * `refreshDesktop` re-reads the desktop theme on demand. There is no watcher: following a desktop
 * is a choice, and a silent repaint mid-session is worse than one the reader asks for.
 */
export function initAppearance(
  save: (patch: { theme?: AppearanceTheme; appearance?: AppearanceSettings }) => void,
  refreshDesktop?: () => void
): { apply(ui: UiPrefs, omarchy?: OmarchyTheme | null): void } {
  const panel = $('appearancePanel');
  let theme: AppearanceTheme = 'dark';
  let current = defaultAppearance();
  let live: OmarchyTheme | null = null;
  let editing = false;
  const colorKeys = ['accent', 'background', 'sidebar'] as const;
  function paint(): void {
    applyAppearance(theme, current, live);
    $<HTMLSelectElement>('appearanceTheme').value = theme;
    $<HTMLSelectElement>('appearanceFont').value = current.font;
    $<HTMLInputElement>('appearanceSize').value = String(current.fontSize);
    $('appearanceSizeValue').textContent = `${current.fontSize} px`;
    $<HTMLInputElement>('appearanceContrast').value = String(current[theme].contrast);
    $('appearanceContrastValue').textContent = String(current[theme].contrast);
    $<HTMLInputElement>('appearanceTranslucent').checked = current.translucentSidebar;
    // The toggle shows what will happen on save; the name is what was actually detected, so a
    // machine with no Omarchy theme says so instead of implying one is being followed.
    $<HTMLInputElement>('appearanceFollowDesktop').checked = current.followDesktop === true;
    const detected = live?.name ?? '';
    ui($('appearanceDesktopName'), 'textContent', () => detected || t('none'));
    $('appearanceRefreshRow').hidden = live === null;
    // A followed desktop theme draws its own colors, so the pickers below describe the palettes
    // that return when follow is turned off. They stay editable, which is what makes that honest.
    panel.classList.toggle('is-following-desktop', followedTheme({ appearance: current }, live) !== null);
    for (const key of colorKeys) {
      const color = current[theme][key];
      panel.querySelector<HTMLInputElement>(`[data-color="${key}"]`)!.value = color;
      const hex = panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!;
      if (document.activeElement !== hex) hex.value = color.toUpperCase();
    }
  }
  function update(control: HTMLInputElement | HTMLSelectElement): boolean {
    if (control.dataset.color || control.dataset.hex) {
      const key = (control.dataset.color ?? control.dataset.hex) as typeof colorKeys[number];
      const value = control.value.trim();
      if (!/^#[\da-fA-F]{6}$/.test(value)) {
        control.setAttribute('aria-invalid', 'true');
        return false;
      }
      control.removeAttribute('aria-invalid');
      current = { ...current, [theme]: { ...current[theme], [key]: value.toLowerCase() } };
      // Keep the hex text in sync with native picker gestures too.
      if (control.dataset.color) panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!.value = value.toUpperCase();
    } else if (control.id === 'appearanceSize') current = { ...current, fontSize: Number(control.value) };
    else if (control.id === 'appearanceContrast') current = { ...current, [theme]: { ...current[theme], contrast: Number(control.value) } };
    else if (control.id === 'appearanceFont') current = { ...current, font: control.value as AppearanceSettings['font'] };
    else if (control.id === 'appearanceTranslucent') current = { ...current, translucentSidebar: (control as HTMLInputElement).checked };
    else if (control.id === 'appearanceFollowDesktop') current = { ...current, followDesktop: (control as HTMLInputElement).checked };
    else return false;
    paint();
    return true;
  }
  panel.addEventListener('input', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || !control.id.startsWith('appearance')) return;
    editing = true;
    update(control);
  });
  panel.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id.startsWith('appearance')) return;
    editing = false;
    if (control.id === 'appearanceTheme') {
      theme = control.value as AppearanceTheme;
      paint(); save({ theme });
    } else if (update(control)) save({ appearance: current });
    else {
      // Incomplete hex input never becomes CSS or durable config. Restore the last valid value.
      control.removeAttribute('aria-invalid');
      if (control.dataset.hex) control.value = current[theme][control.dataset.hex as typeof colorKeys[number]].toUpperCase();
    }
  });
  $('appearanceReset').addEventListener('click', () => {
    editing = false; current = defaultAppearance(); paint(); save({ appearance: current });
  });
  // The desktop theme is read at startup and on save, never by a watcher. This asks the main
  // process for a fresh snapshot, so a theme the user changed a moment ago becomes visible without
  // restarting — and it is a deliberate action rather than a silent repaint.
  $('appearanceRefreshDesktop').addEventListener('click', () => refreshDesktop?.());
  return { apply(ui, omarchy) {
    live = omarchy ?? null;
    if (editing) return;
    theme = ui.theme; current = ui.appearance ?? defaultAppearance(); paint();
  } };
}
