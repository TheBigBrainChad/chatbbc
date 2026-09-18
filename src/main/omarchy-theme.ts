import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mixColor } from '../shared/appearance.js';

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
