import { nativeTheme, type BrowserWindow } from 'electron';
import { resolveAppearance, type ResolvedAppearance } from '../shared/appearance.js';
import { getConfig } from './config.js';
import { getOmarchyTheme } from './omarchy-theme.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from './window-layout.js';

/** Project the process-owned palette onto the saved manual settings without persisting it. */
export function resolvedAppearance(): ResolvedAppearance {
  const { theme, appearance } = getConfig().ui;
  return resolveAppearance(theme, appearance, getOmarchyTheme());
}

/** Keep native chrome and the reload backing in step with the same renderer projection. */
export function applyNativeAppearance(window: BrowserWindow | null): void {
  const resolved = resolvedAppearance();
  nativeTheme.themeSource = resolved.theme;
  if (!window || window.isDestroyed()) return;
  if (process.platform === 'win32') {
    window.setTitleBarOverlay(titleBarOverlayForTheme(resolved.theme, resolved.settings));
  }
  window.setBackgroundColor(windowBackgroundForTheme(resolved.theme, resolved.settings));
}
