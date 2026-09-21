import { execFile } from 'node:child_process';
import type { BrowserWindowConstructorOptions } from 'electron';
import type { GlassSupport } from '../shared/types.js';
export type { GlassSupport } from '../shared/types.js';

export interface GlassCommandOptions {
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export const DEFAULT_GLASS_SUPPORT: GlassSupport = Object.freeze({
  mode: 'atmospheric',
  transparent: false,
  diagnostic: null
});

export type GlassCommandRunner = (
  file: string,
  args: readonly string[],
  options: GlassCommandOptions
) => Promise<string>;

export interface DetectGlassSupportOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: GlassCommandRunner;
}

const GLASS_QUERY_TIMEOUT_MS = 1_000;
const GLASS_QUERY_MAX_BYTES = 16 * 1_024;
const TRANSPARENT_BACKGROUND = '#00000000';

const atmospheric = (diagnostic: string | null): GlassSupport =>
  diagnostic === null ? DEFAULT_GLASS_SUPPORT : {
    mode: 'atmospheric',
    transparent: false,
    diagnostic
  };

const runGlassCommand: GlassCommandRunner = (file, args, options) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(file, [...args], {
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: options.env,
    windowsHide: true
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
  return promise;
};

/**
 * Observe compositor support without changing compositor or user configuration. Native glass is
 * enabled only after the active Hyprland instance explicitly reports that blur is on; every
 * absent, unsupported or unreadable result stays on the in-window atmospheric surface.
 */
export async function detectGlassSupport(options: DetectGlassSupportOptions = {}): Promise<GlassSupport> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'linux') return atmospheric(null);
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) return atmospheric(null);

  let stdout: string;
  try {
    stdout = await (options.run ?? runGlassCommand)(
      'hyprctl',
      ['getoption', 'decoration:blur:enabled', '-j'],
      { timeout: GLASS_QUERY_TIMEOUT_MS, maxBuffer: GLASS_QUERY_MAX_BYTES, env }
    );
  } catch {
    return atmospheric('ChatBBC could not confirm Hyprland blur; atmospheric glass remains active.');
  }

  if (Buffer.byteLength(stdout, 'utf8') > GLASS_QUERY_MAX_BYTES) {
    return atmospheric('Hyprland returned too much blur status data; atmospheric glass remains active.');
  }

  let result: unknown;
  try { result = JSON.parse(stdout); }
  catch { return atmospheric('Hyprland returned malformed blur status; atmospheric glass remains active.'); }

  if (!result || typeof result !== 'object') {
    return atmospheric('Hyprland returned malformed blur status; atmospheric glass remains active.');
  }
  const enabled = 'bool' in result && typeof result.bool === 'boolean'
    ? result.bool
    : 'int' in result && typeof result.int === 'number' ? result.int === 1 : null;
  if (enabled === null) {
    return atmospheric('Hyprland returned malformed blur status; atmospheric glass remains active.');
  }
  if (!enabled) return atmospheric('Hyprland blur is disabled; atmospheric glass remains active.');
  return { mode: 'hyprland-blur', transparent: true, diagnostic: null };
}

/** Project support into constructor-only Electron options. All other platforms retain their old options. */
export function windowGlassOptions(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  support: GlassSupport
): Pick<BrowserWindowConstructorOptions, 'transparent' | 'backgroundColor'> | Record<string, never> {
  if (platform !== 'linux' || !env.HYPRLAND_INSTANCE_SIGNATURE || !support.transparent || support.mode === 'atmospheric') return {};
  return { transparent: true, backgroundColor: TRANSPARENT_BACKGROUND };
}

interface GlassBackingTarget {
  setBackgroundColor(color: string): void;
}

export interface GlassBackingHandshake {
  /** A navigation/reload started; restore a readable backing until this document paints. */
  loading(background?: string): void;
  /** Electron finished loading the current document. */
  didFinishLoad(): void;
  /** The renderer applied its complete appearance and glass-mode projection. */
  appearancePainted(): void;
  /** Keep a not-yet-released backing synchronized with a live theme change. */
  updateBackground(background: string): void;
}

/**
 * A transparent-capable BrowserWindow must not expose an empty transparent document. The native
 * backing clears only when Electron load completion and renderer appearance completion refer to
 * the same navigation. Reload immediately restores the latest readable palette color.
 */
export function createGlassBackingHandshake(
  target: GlassBackingTarget,
  support: GlassSupport,
  initialBackground: string
): GlassBackingHandshake {
  let background = initialBackground;
  let loaded = false;
  let painted = false;
  let released = false;

  const apply = (): void => {
    if (!support.transparent) return;
    if (loaded && painted) {
      if (!released) target.setBackgroundColor(TRANSPARENT_BACKGROUND);
      released = true;
      return;
    }
    if (released) target.setBackgroundColor(background);
    released = false;
  };

  target.setBackgroundColor(background);
  return {
    loading(nextBackground) {
      if (nextBackground) background = nextBackground;
      loaded = false;
      painted = false;
      target.setBackgroundColor(background);
      released = false;
    },
    didFinishLoad() { loaded = true; apply(); },
    appearancePainted() { painted = true; apply(); },
    updateBackground(nextBackground) {
      background = nextBackground;
      if (!released) target.setBackgroundColor(background);
    }
  };
}
