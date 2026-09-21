import { readFileSync, statSync, watch as watchFs, type FSWatcher } from 'node:fs';
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

export interface OmarchyThemeState {
  generation: number;
  theme: OmarchyTheme | null;
  diagnostic: string | null;
}

type WatchFactory = (directory: string, listener: () => void) => FSWatcher;

export interface OmarchyThemeObservationOptions {
  home?: string;
  debounceMs?: number;
  onChange?: (state: OmarchyThemeState) => void;
  /** Dependency seam for deterministic watcher tests; the app always uses node:fs. */
  watchFactory?: WatchFactory;
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
 * `omarchy-theme-set` writes these materialized paths itself, so this is the documented
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

const THEME_DIAGNOSTIC =
  'ChatBBC could not read the latest Omarchy theme. The last valid theme or built-in palette remains active.';
const DEFAULT_DEBOUNCE_MS = 75;
const themeListeners = new Set<(state: OmarchyThemeState) => void>();
let themeState: OmarchyThemeState = { generation: 0, theme: null, diagnostic: null };
let activeObservation: OmarchyThemeObservation | null = null;
let stopActiveObservation: (() => void) | null = null;

function sameTheme(left: OmarchyTheme | null, right: OmarchyTheme | null): boolean {
  return left === right || Boolean(left && right
    && left.name === right.name
    && left.mode === right.mode
    && left.background === right.background
    && left.accent === right.accent
    && left.sidebar === right.sidebar
    && left.green === right.green
    && left.red === right.red
    && left.fontFamily === right.fontFamily);
}

function publishThemeState(next: OmarchyThemeState): void {
  themeState = next;
  for (const listener of themeListeners) listener(next);
}

function existingDirectory(candidate: string, floor: string): string | null {
  let current = candidate;
  for (;;) {
    try {
      if (statSync(current, { throwIfNoEntry: false })?.isDirectory()) return current;
    } catch {
      // Keep walking toward the supplied home. A single unreadable path must not stop startup.
    }
    if (current === floor) return null;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${floor}${path.sep}`)) return null;
    current = parent;
  }
}

class OmarchyThemeObservation {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly home: string,
    private readonly debounceMs: number,
    private readonly watchFactory: WatchFactory
  ) {}

  start(): void {
    this.read(false);
    this.arm();
  }

  retry(): void {
    if (!this.stopped) this.read(true);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private schedule = (): void => {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.read(true);
    }, this.debounceMs);
  };

  private read(notify: boolean): void {
    if (this.stopped) return;
    const candidate = readOmarchyTheme(this.home);
    if (candidate === null) {
      if (themeState.diagnostic !== THEME_DIAGNOSTIC) {
        const next = { ...themeState, diagnostic: THEME_DIAGNOSTIC };
        if (notify) publishThemeState(next);
        else themeState = next;
      }
      this.arm();
      return;
    }

    const changed = !sameTheme(themeState.theme, candidate);
    if (changed || themeState.diagnostic !== null) {
      const next = {
        generation: themeState.generation + (changed ? 1 : 0),
        theme: changed ? candidate : themeState.theme,
        diagnostic: null
      };
      if (notify) publishThemeState(next);
      else themeState = next;
    }
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    const current = path.join(this.home, '.local/state/omarchy/current');
    const theme = path.join(current, 'theme');
    const parent = existingDirectory(current, this.home);
    const themeDirectory = existingDirectory(theme, current);
    const desired = new Set([parent, themeDirectory].filter((entry): entry is string => entry !== null));

    for (const [directory, watcher] of this.watchers) {
      if (desired.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of desired) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = this.watchFactory(directory, this.schedule);
        watcher.on?.('error', this.schedule);
        this.watchers.set(directory, watcher);
      } catch {
        // A rename can remove a directory between stat and watch. Its stable parent remains armed.
      }
    }
  }
}

export function currentOmarchyThemeState(): OmarchyThemeState {
  return themeState;
}

export function onOmarchyThemeChange(listener: (state: OmarchyThemeState) => void): () => void {
  themeListeners.add(listener);
  return () => { themeListeners.delete(listener); };
}

export function retryOmarchyThemeObservation(): OmarchyThemeState {
  activeObservation?.retry();
  return themeState;
}

export function startOmarchyThemeObservation(options: OmarchyThemeObservationOptions = {}): () => void {
  stopActiveObservation?.();
  const home = options.home ?? os.homedir();
  themeState = { generation: 0, theme: null, diagnostic: null };
  const observation = new OmarchyThemeObservation(
    home,
    options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    options.watchFactory ?? ((directory, listener) => watchFs(directory, { persistent: false }, listener))
  );
  activeObservation = observation;
  if (options.onChange) themeListeners.add(options.onChange);
  observation.start();

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (options.onChange) themeListeners.delete(options.onChange);
    observation.stop();
    if (activeObservation === observation) activeObservation = null;
    if (stopActiveObservation === stop) stopActiveObservation = null;
  };
  stopActiveObservation = stop;
  return stop;
}
