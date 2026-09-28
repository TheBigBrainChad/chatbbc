import { defaultAppearance, mixColor, paletteTokens, resolveAppearance, type AppearanceSettings, type AppearanceTheme, type OmarchyThemeState, type ResolvedAppearance } from '../shared/appearance.js';
import type { UiPrefs } from '../shared/types.js';
import { t, ui } from './i18n.js';
import { $ } from './dom.js';

const FONT_FAMILIES = {
  system: '', sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif', mono: '"Cascadia Mono", Consolas, monospace'
};
const appearanceListeners = new Set<() => void>();
/** Canvas/terminal renderers must refresh after the CSS palette has been applied. */
export function onAppearanceChanged(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => { appearanceListeners.delete(listener); };
}
function tokens(element: HTMLElement, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
  for (const key of ['--selection', '--selection-ink']) {
    if (!(key in values)) element.style.removeProperty(key);
  }
}

export function applyAppearance(theme: AppearanceTheme, settings?: AppearanceSettings,
  options?: Pick<ResolvedAppearance, 'foreground' | 'selection' | 'red' | 'green'>): void {
  const value = settings ?? defaultAppearance(), palette = value[theme], root = document.documentElement;
  const colors = options && (options.foreground || options.selection || options.red || options.green) ? options : undefined;
  root.dataset.theme = theme;
  root.dataset.translucentSidebar = String(value.translucentSidebar);
  tokens(root, paletteTokens(palette.background, palette.accent, palette.contrast, colors));
  root.style.setProperty('--text-scale', String(value.fontSize / 14));
  if (value.font === 'system') root.style.removeProperty('--ui-font');
  else root.style.setProperty('--ui-font', FONT_FAMILIES[value.font]);
  root.style.setProperty('--sidebar-color', palette.sidebar);
  // Glass is composed inside the window: a colored backdrop and translucent layer.
  // No native transparent window, desktop capture, or platform permission is needed.
  const sidebarBackground = value.translucentSidebar ? mixColor(palette.sidebar, palette.background, .13) : palette.sidebar;
  for (const element of document.querySelectorAll<HTMLElement>('.sidebar, .app-topbar, .appearance-preview-sidebar, .connection-popover')) {
    tokens(element, paletteTokens(sidebarBackground, palette.accent, palette.contrast, colors));
  }
  for (const listener of appearanceListeners) listener();
}

/** Only the in-progress form edit is local; the existing Settings queue owns persistence. */
export function initAppearance(save: (patch: { theme?: AppearanceTheme; appearance?: AppearanceSettings }) => void): { apply(ui: UiPrefs, omarchy: OmarchyThemeState): void } {
  const panel = $('appearancePanel');
  let theme: AppearanceTheme = 'dark';
  let current = defaultAppearance();
  let omarchy: OmarchyThemeState = { status: 'unavailable', generation: 0, palette: null };
  let editing = false;
  const colorKeys = ['accent', 'background', 'sidebar'] as const;
  const manualControls = panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    '#appearanceTheme, [data-color], [data-hex], #appearanceContrast');
  const status = $('appearanceOmarchyStatus');
  const statusText = (): string => {
    if (!current.followOmarchy) return t('Manual colors selected.');
    if (omarchy.palette) {
      if (omarchy.status === 'invalid') return t('Latest Omarchy colors are invalid; using the last valid palette.');
      if (omarchy.status === 'unavailable') return t('Omarchy theme unavailable; using the last valid palette.');
      return t('Omarchy colors are active.');
    }
    return t(omarchy.status === 'invalid'
      ? 'Omarchy colors are invalid; using saved colors.'
      : 'Omarchy theme unavailable; using saved colors.');
  };
  function paint(updateControls = true): void {
    const resolved = resolveAppearance(theme, current, omarchy);
    applyAppearance(resolved.theme, resolved.settings, resolved);
    const following = current.followOmarchy && omarchy.palette !== null;
    for (const control of manualControls) control.disabled = following;
    ui(status, 'textContent', statusText);
    if (!updateControls) return;
    $<HTMLInputElement>('appearanceFollowOmarchy').checked = current.followOmarchy;
    $<HTMLSelectElement>('appearanceTheme').value = following ? resolved.theme : theme;
    $<HTMLSelectElement>('appearanceFont').value = current.font;
    $<HTMLInputElement>('appearanceSize').value = String(current.fontSize);
    $('appearanceSizeValue').textContent = `${current.fontSize} px`;
    $<HTMLInputElement>('appearanceContrast').value = String(resolved.settings[resolved.theme].contrast);
    $('appearanceContrastValue').textContent = String(resolved.settings[resolved.theme].contrast);
    $<HTMLInputElement>('appearanceTranslucent').checked = current.translucentSidebar;
    for (const key of colorKeys) {
      const color = resolved.settings[resolved.theme][key];
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
    else if (control.id === 'appearanceFollowOmarchy') current = { ...current, followOmarchy: (control as HTMLInputElement).checked };
    paint();
    return true;
  }
  panel.addEventListener('input', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || !control.id.startsWith('appearance') || control.disabled) return;
    editing = true;
    update(control);
  });
  panel.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id.startsWith('appearance') || control.disabled) return;
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
    editing = false; current = { ...defaultAppearance(), followOmarchy: current.followOmarchy }; paint(); save({ appearance: current });
  });
  return { apply(preferences, snapshot) {
    omarchy = snapshot ?? { status: 'unavailable', generation: 0, palette: null };
    if (!editing) {
      theme = preferences.theme;
      current = preferences.appearance ?? defaultAppearance();
    }
    paint(!editing);
  } };
}
