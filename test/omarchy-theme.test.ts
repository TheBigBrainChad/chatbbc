import { promises as fs } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentOmarchyThemeState,
  onOmarchyThemeChange,
  readOmarchyTheme,
  retryOmarchyThemeObservation,
  startOmarchyThemeObservation,
  type OmarchyThemeState
} from '../src/main/omarchy-theme.js';
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

    const huge = await themeDir('accent = "#509475"\n' + 'x'.repeat(80_000));
    expect(readOmarchyTheme(huge)).toBeNull();
  });

  // Windows maps chmod onto the read-only attribute alone, so a file with no permissions is
  // still readable there and the theme parses. POSIX is where "unreadable" is a real state.
  it.runIf(process.platform !== 'win32')('returns null for a theme file it cannot read', async () => {
    const unreadable = await themeDir(OSAKA);
    await fs.chmod(path.join(unreadable, '.local/state/omarchy/current/theme/colors.toml'), 0o000);
    expect(readOmarchyTheme(unreadable)).toBeNull();
    // The same absence when the directory itself cannot be traversed, which is how a
    // permissions problem usually presents in a real home directory.
    await fs.chmod(path.join(unreadable, '.local/state/omarchy/current/theme'), 0o000);
    expect(readOmarchyTheme(unreadable)).toBeNull();
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

type WatchFactory = (directory: string, listener: () => void) => FSWatcher;

function controlledWatch(): { factory: WatchFactory; emit(directory: string): void } {
  const active = new Map<string, Set<() => void>>();
  return {
    factory(directory, listener) {
      let listeners = active.get(directory);
      if (!listeners) active.set(directory, listeners = new Set());
      listeners.add(listener);
      return {
        close: () => {
          listeners!.delete(listener);
          if (listeners!.size === 0) active.delete(directory);
        }
      } as FSWatcher;
    },
    emit(directory) {
      for (const listener of [...active.get(directory) ?? []]) listener();
    }
  };
}

async function replaceThemeFiles(
  home: string,
  next: { name: string; background: string; accent: string; font?: string }
): Promise<void> {
  const current = path.join(home, '.local/state/omarchy/current');
  const theme = path.join(current, 'theme');
  const colors = `mode = "dark"\nbackground = "${next.background}"\naccent = "${next.accent}"\n`;
  await Promise.all([
    fs.writeFile(path.join(theme, 'colors.toml.next'), colors),
    fs.writeFile(path.join(theme, 'alacritty.toml.next'),
      `[font]\nnormal = { family = "${next.font ?? 'Iosevka Nerd Font Mono'}" }\n`),
    fs.writeFile(path.join(current, 'theme.name.next'), next.name)
  ]);
  await Promise.all([
    fs.rename(path.join(theme, 'colors.toml.next'), path.join(theme, 'colors.toml')),
    fs.rename(path.join(theme, 'alacritty.toml.next'), path.join(theme, 'alacritty.toml')),
    fs.rename(path.join(current, 'theme.name.next'), path.join(current, 'theme.name'))
  ]);
}

const observationStops: Array<() => void> = [];
afterEach(() => {
  for (const stop of observationStops.splice(0)) stop();
  vi.useRealTimers();
});

describe('live Omarchy theme observation', () => {
  it('coalesces a theme replacement and publishes only the complete newest snapshot', async () => {
    vi.useFakeTimers();
    const home = await themeDir(OSAKA);
    const watched = controlledWatch();
    const changes: OmarchyThemeState[] = [];
    const stop = startOmarchyThemeObservation({
      home,
      debounceMs: 40,
      onChange: state => changes.push(state),
      watchFactory: watched.factory
    });
    observationStops.push(stop);

    expect(currentOmarchyThemeState()).toMatchObject({
      generation: 1,
      theme: { name: 'osaka-jade' },
      diagnostic: null
    });
    await replaceThemeFiles(home, {
      name: 'Crystal Test',
      background: '#101218',
      accent: '#b99aff'
    });
    const current = path.join(home, '.local/state/omarchy/current');
    watched.emit(current);
    watched.emit(path.join(current, 'theme'));
    await vi.advanceTimersByTimeAsync(80);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      generation: 2,
      theme: { name: 'Crystal Test', background: '#101218', accent: '#b99aff' },
      diagnostic: null
    });
  });

  it('retains the last valid theme through a transient missing file', async () => {
    vi.useFakeTimers();
    const home = await themeDir(OSAKA);
    const watched = controlledWatch();
    const changes: OmarchyThemeState[] = [];
    observationStops.push(startOmarchyThemeObservation({
      home,
      debounceMs: 40,
      onChange: state => changes.push(state),
      watchFactory: watched.factory
    }));
    const current = path.join(home, '.local/state/omarchy/current');
    const colors = path.join(current, 'theme/colors.toml');
    await fs.rename(colors, `${colors}.next`);
    watched.emit(path.join(current, 'theme'));
    await fs.writeFile(path.join(current, 'theme.name'), 'Restored');
    await fs.rename(`${colors}.next`, colors);
    watched.emit(path.join(current, 'theme'));
    await vi.advanceTimersByTimeAsync(80);

    expect(currentOmarchyThemeState()).toMatchObject({
      generation: 2,
      theme: { name: 'Restored' },
      diagnostic: null
    });
    expect(changes).toHaveLength(1);
  });

  it('keeps the last complete generation and reports bounded corrupt or oversized input', async () => {
    vi.useFakeTimers();
    const home = await themeDir(OSAKA);
    const watched = controlledWatch();
    const changes: OmarchyThemeState[] = [];
    observationStops.push(startOmarchyThemeObservation({
      home,
      debounceMs: 40,
      onChange: state => changes.push(state),
      watchFactory: watched.factory
    }));
    const current = path.join(home, '.local/state/omarchy/current');
    await fs.writeFile(path.join(current, 'theme/colors.toml'), 'not a theme');
    watched.emit(path.join(current, 'theme'));
    await vi.advanceTimersByTimeAsync(80);
    expect(currentOmarchyThemeState()).toMatchObject({
      generation: 1,
      theme: { name: 'osaka-jade', background: '#111c18' }
    });
    expect(currentOmarchyThemeState().diagnostic).toMatch(/read.*theme/i);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.diagnostic!.length).toBeLessThan(160);

    await fs.writeFile(path.join(current, 'theme/colors.toml'), `background = "#101218"\n${'x'.repeat(70_000)}`);
    watched.emit(path.join(current, 'theme'));
    await vi.advanceTimersByTimeAsync(80);
    expect(currentOmarchyThemeState().generation).toBe(1);
    expect(currentOmarchyThemeState().theme?.background).toBe('#111c18');
    expect(changes).toHaveLength(1);
    await fs.writeFile(path.join(current, 'theme/colors.toml'), OSAKA);
    const recovered = retryOmarchyThemeObservation();
    expect(recovered).toMatchObject({ generation: 1, diagnostic: null, theme: { background: '#111c18' } });
    expect(changes).toHaveLength(2);
  });

  it('publishes two valid generations in order and never lets an older debounce win', async () => {
    vi.useFakeTimers();
    const home = await themeDir(OSAKA);
    const watched = controlledWatch();
    const changes: OmarchyThemeState[] = [];
    observationStops.push(startOmarchyThemeObservation({
      home,
      debounceMs: 40,
      onChange: state => changes.push(state),
      watchFactory: watched.factory
    }));
    const current = path.join(home, '.local/state/omarchy/current');
    await replaceThemeFiles(home, { name: 'First', background: '#202128', accent: '#8e79d6' });
    watched.emit(current);
    await vi.advanceTimersByTimeAsync(40);
    await replaceThemeFiles(home, { name: 'Second', background: '#303138', accent: '#a98df4' });
    watched.emit(current);
    await vi.advanceTimersByTimeAsync(40);

    expect(changes.map(change => [change.generation, change.theme?.name])).toEqual([
      [2, 'First'],
      [3, 'Second']
    ]);
    expect(currentOmarchyThemeState().theme?.name).toBe('Second');
  });

  it('reports a missing Omarchy directory and disposes listeners, watchers and pending timers', async () => {
    vi.useFakeTimers();
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'omarchy-none-'));
    const watched = controlledWatch();
    const direct: OmarchyThemeState[] = [];
    const global: OmarchyThemeState[] = [];
    const unsubscribe = onOmarchyThemeChange(state => global.push(state));
    const stop = startOmarchyThemeObservation({
      home,
      debounceMs: 40,
      onChange: state => direct.push(state),
      watchFactory: watched.factory
    });
    observationStops.push(stop);

    expect(currentOmarchyThemeState()).toMatchObject({ generation: 0, theme: null });
    expect(currentOmarchyThemeState().diagnostic).toMatch(/read.*theme/i);
    watched.emit(home);
    unsubscribe();
    stop();
    await vi.advanceTimersByTimeAsync(80);
    watched.emit(home);
    await vi.advanceTimersByTimeAsync(80);
    expect(direct).toEqual([]);
    expect(global).toEqual([]);
  });
});
