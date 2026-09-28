import { constants, lstatSync, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { parse } from 'smol-toml';
import { luminance, mixColor, type OmarchyPalette, type OmarchyThemeState } from '../shared/appearance.js';
import { logWarn } from './logger.js';

const MAX_BYTES = 32 * 1024;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const DECODER = new TextDecoder('utf-8', { fatal: true });

function color(value: unknown): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error('Invalid Omarchy palette');
  return value.toLowerCase();
}

/** Parses only presentation colors. Other TOML fields are never executed or opened. */
export function parseOmarchyPalette(text: string): OmarchyPalette {
  try {
    const data: Record<string, unknown> = parse(text);
    const background = color(data.background);
    const foreground = color(data.foreground);
    const accent = color(data.accent);
    const mode = data.mode === undefined ? (luminance(background) >= 0.5 ? 'light' : 'dark') : data.mode;
    if (mode !== 'light' && mode !== 'dark') throw new Error('Invalid Omarchy palette');
    const sidebar = data.dark_background === undefined
      ? mixColor(background, foreground, 0.04) : color(data.dark_background);
    const palette: OmarchyPalette = { mode, background, foreground, accent, sidebar };
    for (const key of ['selection', 'red', 'green'] as const) {
      if (data[key] !== undefined) palette[key] = color(data[key]);
    }
    return palette;
  } catch {
    // smol-toml's parse error may echo untrusted source text; never expose it or a filesystem path.
    throw new Error('Invalid Omarchy palette');
  }
}

type Availability = 'unavailable' | 'invalid';
class PaletteReadError extends Error {
  constructor(readonly status: Availability) { super('Omarchy palette unavailable'); }
}

let state: OmarchyThemeState = { status: 'unavailable', generation: 0, palette: null };
let active = false;
let currentDirectory = '';
let ownerGeneration = 0;
let flight: Promise<void> | null = null;
let rerun = false;
let scheduled: NodeJS.Timeout | null = null;
interface BoundWatcher {
  directory: string;
  dev: bigint;
  ino: bigint;
  watcher: FSWatcher;
}
const watchers: BoundWatcher[] = [];
const listeners = new Set<() => void>();
let loggedInvalid = false;

export function getOmarchyTheme(): OmarchyThemeState { return state; }

export function onOmarchyThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function samePalette(a: OmarchyPalette | null, b: OmarchyPalette | null): boolean {
  return a === b || (!!a && !!b && a.mode === b.mode && a.background === b.background &&
    a.foreground === b.foreground && a.accent === b.accent && a.sidebar === b.sidebar &&
    a.selection === b.selection && a.red === b.red && a.green === b.green);
}

function publish(status: OmarchyThemeState['status'], palette: OmarchyPalette | null, generation: number): void {
  if (!active || ownerGeneration !== generation) return;
  if (state.status === status && samePalette(state.palette, palette)) return;
  if (status === 'available') loggedInvalid = false;
  if (status === 'invalid' && !loggedInvalid) {
    loggedInvalid = true;
    logWarn('Omarchy palette is invalid; keeping the last valid palette.');
  }
  state = { status, generation: state.generation + 1, palette };
  for (const listener of [...listeners]) listener();
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function readFailure(error: unknown): PaletteReadError {
  const code = (error as NodeJS.ErrnoException)?.code;
  return new PaletteReadError(code === 'ENOENT' || code === 'ENOTDIR' ? 'unavailable' : 'invalid');
}

async function directoryIdentity(directory: string): Promise<BigIntStats> {
  let stat: BigIntStats;
  try { stat = await fs.lstat(directory, { bigint: true }); }
  catch (error) { throw readFailure(error); }
  if (!stat.isDirectory()) throw new PaletteReadError('invalid');
  return stat;
}

async function fileIdentity(file: string): Promise<BigIntStats> {
  let stat: BigIntStats;
  try { stat = await fs.lstat(file, { bigint: true }); }
  catch (error) { throw readFailure(error); }
  if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) throw new PaletteReadError('invalid');
  return stat;
}

async function acquire(): Promise<OmarchyPalette> {
  const theme = path.join(currentDirectory, 'theme');
  const file = path.join(theme, 'colors.toml');
  const currentBefore = await directoryIdentity(currentDirectory);
  const themeBefore = await directoryIdentity(theme);
  const pathBefore = await fileIdentity(file);
  let handle: FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw readFailure(error); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES) || !sameIdentity(pathBefore, before)) {
      throw new PaletteReadError('invalid');
    }
    // One extra byte detects growth beyond the cap; no path-following or unbounded readFile().
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (part.bytesRead === 0) break;
      bytes += part.bytesRead;
    }
    if (bytes > MAX_BYTES) throw new PaletteReadError('invalid');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(currentBefore, await directoryIdentity(currentDirectory)) ||
      !sameIdentity(themeBefore, await directoryIdentity(theme)) ||
      !sameIdentity(after, await fileIdentity(file))) throw new PaletteReadError('invalid');
    return parseOmarchyPalette(DECODER.decode(buffer.subarray(0, bytes)));
  } catch (error) {
    if (error instanceof PaletteReadError) throw error;
    throw new PaletteReadError('invalid');
  } finally {
    await handle.close();
  }
}

function directoryStat(directory: string): BigIntStats | null {
  try {
    const stat = lstatSync(directory, { bigint: true });
    return stat.isDirectory() ? stat : null;
  } catch { return null; }
}

function bindWatchers(): void {
  if (!active) return;
  const theme = path.join(currentDirectory, 'theme');
  const directories: Array<{ directory: string; stat: BigIntStats }> = [];
  const currentStat = directoryStat(currentDirectory);
  if (currentStat) {
    directories.push({ directory: currentDirectory, stat: currentStat });
    const themeStat = directoryStat(theme);
    if (themeStat) directories.push({ directory: theme, stat: themeStat });
  } else {
    // On a first run, bind upwards until the first surviving Omarchy-state ancestor.
    // The fixture seam's containing directory serves as its root; production stops at HOME.
    const floor = path.resolve(currentDirectory === path.join(os.homedir(), '.local/state/omarchy/current')
      ? os.homedir() : path.dirname(path.dirname(currentDirectory)));
    let candidate = currentDirectory;
    let stat = directoryStat(candidate);
    while (candidate.startsWith(floor + path.sep) && !stat) {
      candidate = path.dirname(candidate);
      stat = directoryStat(candidate);
    }
    if (stat) directories.push({ directory: candidate, stat });
  }
  for (const bound of watchers.splice(0)) {
    if (directories.some(({ directory, stat }) =>
      directory === bound.directory && stat.dev === bound.dev && stat.ino === bound.ino)) {
      watchers.push(bound);
    } else bound.watcher.close();
  }
  for (const { directory, stat } of directories) {
    if (watchers.some(bound => bound.directory === directory)) continue;
    try { watchers.push({ directory, dev: stat.dev, ino: stat.ino, watcher: watch(directory, invalidateAndSchedule) }); }
    catch { /* An inaccessible directory is reported by acquire(); focus/explicit refresh can retry. */ }
  }
}

function invalidateAndSchedule(): void {
  if (!active) return;
  ownerGeneration++;
  if (flight) rerun = true;
  bindWatchers();
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    void refreshOmarchyTheme();
  }, 50);
}

async function refreshOnce(generation: number): Promise<void> {
  bindWatchers();
  try {
    const palette = await acquire();
    publish('available', palette, generation);
  } catch (error) {
    const status = error instanceof PaletteReadError ? error.status : 'invalid';
    publish(status, state.palette, generation);
  } finally {
    if (active) bindWatchers();
  }
}

/** Serialized refresh; a burst of invalidations can request at most one rerun. */
export function refreshOmarchyTheme(): Promise<void> {
  if (!active) return Promise.resolve();
  const generation = ++ownerGeneration;
  if (flight) {
    rerun = true;
    return flight;
  }
  flight = (async () => {
    let next = generation;
    do {
      rerun = false;
      await refreshOnce(next);
      next = ownerGeneration;
    } while (active && rerun);
  })().finally(() => { flight = null; });
  return flight;
}

export async function startOmarchyTheme(options: { currentDirectory?: string } = {}): Promise<void> {
  if (active) {
    if (flight) await flight;
    return;
  }
  currentDirectory = options.currentDirectory ?? path.join(os.homedir(), '.local/state/omarchy/current');
  active = true;
  bindWatchers();
  await refreshOmarchyTheme();
}

export function stopOmarchyTheme(): void {
  active = false;
  ownerGeneration++;
  rerun = false;
  if (scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  for (const bound of watchers.splice(0)) bound.watcher.close();
  loggedInvalid = false;
  listeners.clear();
  state = { status: 'unavailable', generation: state.generation, palette: null };
}
