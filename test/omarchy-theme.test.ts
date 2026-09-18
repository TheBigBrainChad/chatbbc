import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOmarchyTheme } from '../src/main/omarchy-theme.js';
import { mixColor } from '../src/shared/appearance.js';

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

  it('falls back per key instead of rejecting the whole theme', async () => {
    // A theme without lighter_background/accent/green/red still yields a usable palette:
    // the sidebar is derived the way the app derives tinted sidebars, and the status
    // colours stay the app's own.
    const bare = await themeDir('background = "#111c18"\nmode = "light"\n');
    const theme = readOmarchyTheme(bare)!;
    expect(theme.mode).toBe('light');
    expect(theme.accent).toBe('#111c18');
    expect(theme.sidebar).toBe('#111c18'); // mix toward itself is still itself
    expect(theme.green).toBe('#549e6a');
    expect(theme.red).toBe('#FF5345');
    expect(theme.name).toBe('osaka-jade');
    expect(theme.fontFamily).toBeNull();
  });

  it('rejects a required colour that is not #rrggbb rather than emitting it as CSS', async () => {
    // No path from a theme file to a CSS declaration: a bad ground or accent is simply
    // not a palette this app can draw, so the whole theme falls away.
    for (const bad of ['red', '#fff', '#12345678', 'url(https://example.com)', '#abcdef;display:none']) {
      expect(readOmarchyTheme(await themeDir(`background = "${bad}"\n`))).toBeNull();
      expect(readOmarchyTheme(await themeDir(`background = "#111c18"\naccent = "${bad}"\n`))).toBeNull();
    }
    // Optional colours are not fatal: a bad lighter_background/green/red falls back.
    const theme = readOmarchyTheme(await themeDir(
      'background = "#111c18"\naccent = "#509475"\nlighter_background = "nope"\ngreen = "nope"\nred = "#FF5345"\n'
    ))!;
    expect(theme.sidebar).toBe(mixColor('#111c18', '#509475', .12));
    expect(theme.green).toBe('#549e6a');
    expect(theme.red).toBe('#FF5345');
  });
});
