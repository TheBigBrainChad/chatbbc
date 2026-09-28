import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir, faultGate } from './helpers.js';
import {
  getOmarchyTheme, onOmarchyThemeChange, parseOmarchyPalette,
  refreshOmarchyTheme, startOmarchyTheme, stopOmarchyTheme
} from '../src/main/omarchy-theme.js';

const dark = 'background = "#282828"\nforeground = "#d4be98"\naccent = "#7daea3"\ndark_background = "#1e1e1e"\n';
const light = 'background = "#fafafa"\nforeground = "#202020"\naccent = "#2456a6"\nmode = "light"\n';
let root: string | undefined;

async function fixture(content?: string): Promise<{ current: string; theme: string; colors: string }> {
  root = await makeTempDir('chatbbc-omarchy-');
  const current = path.join(root, 'omarchy', 'current');
  const theme = path.join(current, 'theme');
  const colors = path.join(theme, 'colors.toml');
  if (content !== undefined) {
    await fs.mkdir(theme, { recursive: true });
    await fs.writeFile(colors, content);
  }
  return { current, theme, colors };
}

async function replacePalette(colors: string, content: string): Promise<void> {
  const temporary = `${colors}.next`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, colors);
}

afterEach(async () => {
  stopOmarchyTheme();
  vi.restoreAllMocks();
  if (root) await removeTempDir(root);
  root = undefined;
});

describe('Omarchy palette parsing', () => {
  it('normalizes supported keys, ignores unknown theme fields and derives mode from luminance', () => {
    expect(parseOmarchyPalette(`${dark}selection = "#504945"\nred = "#EA6962"\ngreen = "#A9B665"\nwallpaper = "/not/an/input"`)).toEqual({
      mode: 'dark', background: '#282828', foreground: '#d4be98', accent: '#7daea3',
      sidebar: '#1e1e1e', selection: '#504945', red: '#ea6962', green: '#a9b665'
    });
    expect(parseOmarchyPalette(light).mode).toBe('light');
    expect(parseOmarchyPalette('background = "#ffffff"\nforeground = "#000000"\naccent = "#010203"').sidebar).toBe('#f5f5f5');
    expect(parseOmarchyPalette('background = "#777777"\nforeground = "#ffffff"\naccent = "#010203"').mode).toBe('dark');
  });

  it('rejects bad mode, malformed TOML and every invalid supported color without leaking input paths', () => {
    for (const bad of [
      `${dark}mode = "auto"`, `${dark}mode = 1`, `${dark}selection = "#123"`,
      `${dark}red = 123`, `${dark}green = "#12345678"`, `${dark}dark_background = false`,
      dark.replace('#282828', 'var(--page)'), dark.replace('#d4be98', '#fff'),
      dark.replace('#7daea3', '#xyzxyz'), 'background = "#000000"\nbroken = [',
      'background = "#000000"\nforeground = "#ffffff"'
    ]) {
      expect(() => parseOmarchyPalette(bad)).toThrow();
    }
    let failure: unknown;
    try { parseOmarchyPalette('background = "/home/private/colors.toml"'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('/home/private');
  });
});

describe('Omarchy theme owner', () => {
  it('reads real colors and only publishes changed palettes or availability', async () => {
    const { current, colors } = await fixture(dark);
    let notifications = 0;
    onOmarchyThemeChange(() => { notifications++; });
    await startOmarchyTheme({ currentDirectory: current });
    expect(getOmarchyTheme()).toMatchObject({ status: 'available', palette: {
      mode: 'dark', background: '#282828', foreground: '#d4be98', sidebar: '#1e1e1e'
    } });
    const first = getOmarchyTheme().generation;
    await refreshOmarchyTheme();
    expect(getOmarchyTheme().generation).toBe(first);
    await replacePalette(colors, light);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'available', palette: {
      mode: 'light', background: '#fafafa', accent: '#2456a6'
    } });
    expect(getOmarchyTheme().generation).toBeGreaterThan(first);
    expect(notifications).toBeGreaterThanOrEqual(2);
  });

  it('treats a malformed first-run palette as invalid without inventing a saved palette', async () => {
    const { current } = await fixture('background = "#xyz"');
    await startOmarchyTheme({ currentDirectory: current });
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: null });
  });

  it('follows missing ancestors and a replaced theme directory without a restart', async () => {
    const { current, theme } = await fixture();
    await startOmarchyTheme({ currentDirectory: current });
    expect(getOmarchyTheme().status).toBe('unavailable');
    await fs.mkdir(theme, { recursive: true });
    await fs.writeFile(path.join(theme, 'colors.toml'), dark);
    await vi.waitFor(() => expect(getOmarchyTheme().palette?.background).toBe('#282828'), { timeout: 3000 });
    const next = path.join(current, 'new-theme');
    await fs.mkdir(next);
    await fs.writeFile(path.join(next, 'colors.toml'), light);
    await fs.rename(theme, path.join(current, 'old-theme'));
    await fs.rename(next, theme);
    await vi.waitFor(() => expect(getOmarchyTheme().palette?.background).toBe('#fafafa'), { timeout: 3000 });
  });

  it('distinguishes first-run missing files from invalid input, retaining last-good during damage and replacement', async () => {
    const { current, colors, theme } = await fixture();
    await startOmarchyTheme({ currentDirectory: current });
    expect(getOmarchyTheme()).toMatchObject({ status: 'unavailable', palette: null });
    await fs.mkdir(theme, { recursive: true });
    await fs.writeFile(colors, dark);
    await refreshOmarchyTheme();
    const good = getOmarchyTheme().palette;
    await replacePalette(colors, `${dark}mode = "automatic"`);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: good });
    const invalidGeneration = getOmarchyTheme().generation;
    await refreshOmarchyTheme();
    expect(getOmarchyTheme().generation).toBe(invalidGeneration);
    await fs.rm(theme, { recursive: true });
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'unavailable', palette: good });
    await fs.mkdir(theme);
    await fs.writeFile(colors, light);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'available', palette: { background: '#fafafa' } });
  });

  it('rejects oversized, invalid UTF-8, symlink and FIFO inputs without opening a blocking stream', async () => {
    const { current, colors } = await fixture(dark);
    await startOmarchyTheme({ currentDirectory: current });
    const good = getOmarchyTheme().palette;
    await replacePalette(colors, dark.padEnd(32 * 1024, ' '));
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'available', palette: good });
    await replacePalette(colors, ' '.repeat(32 * 1024 + 1));
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: good });
    await fs.writeFile(colors, Buffer.from([0xff, 0xfe, 0x80]));
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: good });
    await fs.rm(colors);
    await fs.symlink('/etc/passwd', colors);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: good });
    await fs.rm(colors);
    expect(spawnSync('mkfifo', [colors]).status).toBe(0);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme()).toMatchObject({ status: 'invalid', palette: good });
  });

  it('invalidates a paused old-file read and publishes only the replacement', async () => {
    const { current, colors } = await fixture(dark);
    const published: Array<{ status: string; background: string | undefined }> = [];
    onOmarchyThemeChange(() => published.push({
      status: getOmarchyTheme().status, background: getOmarchyTheme().palette?.background
    }));
    const gate = faultGate();
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      await gate.hold();
      return handle;
    });
    const starting = startOmarchyTheme({ currentDirectory: current });
    await gate.entered;
    await replacePalette(colors, light);
    const following = refreshOmarchyTheme();
    gate.release();
    await Promise.all([starting, following]);
    expect(published).toEqual([{ status: 'available', background: '#fafafa' }]);
    expect(getOmarchyTheme()).toMatchObject({ status: 'available', palette: { background: '#fafafa' } });
  });

  it('stops and clears subscriptions even while a read is paused', async () => {
    const { current } = await fixture(dark);
    const gate = faultGate();
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      await gate.hold();
      return handle;
    });
    let notifications = 0;
    onOmarchyThemeChange(() => { notifications++; });
    const starting = startOmarchyTheme({ currentDirectory: current });
    await gate.entered;
    stopOmarchyTheme();
    gate.release();
    await starting;
    expect(getOmarchyTheme()).toMatchObject({ status: 'unavailable', palette: null });
    expect(notifications).toBe(0);
    await refreshOmarchyTheme();
    expect(getOmarchyTheme().status).toBe('unavailable');
  });
});
