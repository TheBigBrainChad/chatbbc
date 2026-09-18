/**
 * Mirrors the bundled Skill pack into the managed library Chrome-free, on disk.
 *
 * The pack ships as a packaged resource, but the library must live at a stable path: on an
 * AppImage `process.resourcesPath` is a temporary mount that disappears when the app exits,
 * so `/skills/<id>/SKILL.md` could not be read on the next launch. Copying once at startup
 * gives discovery, `/` completion and `read` one ordinary directory to work with.
 *
 * Refresh is provenance-driven rather than unconditional. A skill the user has edited is
 * theirs; overwriting it on every launch would silently destroy work. The recorded digest
 * says what this app last wrote, so an unchanged file can be refreshed and a changed one
 * cannot.
 *
 * A crash mid-refresh is self-healing: the next launch sees the directory present but not
 * matching provenance, which is indistinguishable from a user edit, so the content is
 * preserved rather than half-replaced. Copying is therefore a plain write, not a transaction.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { app } from 'electron';
import { SKILL_ID_PATTERN } from '../shared/skills.js';
import { readSkillTextSnapshot, listSkills, skillsDirectory } from './skills.js';
import type { SkillState } from './skill-state.js';

export const SKILL_PACK_DIR = 'skill-pack';
const SKILL_FILENAME = 'SKILL.md';
const MAX_PACK_ENTRIES = 256;

export interface PackEntry {
  id: string;
  source: string;
  digest: string;
}

export interface PackSyncResult {
  added: string[];
  refreshed: string[];
  preserved: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Where the pack ships, or null when it is not present in this build.
 *
 * Each candidate is checked for existence rather than assumed: a dev run may have the pack in
 * the checkout but not beside Electron's own resources, and a packaged run has the opposite.
 * Returning an unverified path would make the first candidate silently win and the pack look
 * empty instead of absent.
 */
export function bundledSkillPackRoot(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, SKILL_PACK_DIR)]
    : [path.join(app.getAppPath(), SKILL_PACK_DIR), path.join(process.cwd(), SKILL_PACK_DIR)];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * One digest over the whole skill directory. Hashing every file, not just SKILL.md, means an
 * edit to a companion file is preserved too — the user's intent is "I changed this skill".
 */
export async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (dir: string, relativeDir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported skill entry: ${relative}`);
      }
    }
  };
  await visit(directory, '');
  return hash.digest('hex');
}

/** Validates each candidate before it can become part of the library. */
export async function readPackEntries(packRoot: string): Promise<{ entries: PackEntry[]; errors: string[] }> {
  const entries: PackEntry[] = [];
  const errors: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(packRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    return { entries, errors: [`pack unreadable: ${(error as Error).message}`] };
  }
  for (const id of names) {
    if (!SKILL_ID_PATTERN.test(id)) continue;
    if (entries.length >= MAX_PACK_ENTRIES) { errors.push('pack exceeds its entry limit'); break; }
    const source = path.join(packRoot, id);
    try {
      const file = path.join(source, SKILL_FILENAME);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md must be a regular file');
      await readSkillTextSnapshot(file);
      entries.push({ id, source, digest: await directoryDigest(source) });
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}

async function copySkill(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

/**
 * Brings the managed library in line with the shipped pack. Returns the provenance map the
 * caller persists; this function never writes state itself, so a test can drive it directly.
 * It does republish `skills.ts`'s catalog, but only when the destination really is that library.
 *
 * Each entry is isolated. A failure on one — a transient EACCES, a full disk — must not strand
 * the rest: the loop continues, so the entries after it still seed on this launch. It also must
 * not throw, because the caller persists the returned map only when this resolves; losing that
 * would be the expensive half. A skill copied but not recorded looks provenance-unknown on the
 * next launch, is preserved from then on, and can never be refreshed by a pack update again.
 */
export async function syncSkillPack(options: {
  managedRoot: string;
  packRoot: string;
  state: SkillState;
}): Promise<{ result: PackSyncResult; seeded: Record<string, string> }> {
  const { managedRoot, packRoot, state } = options;
  const result: PackSyncResult = { added: [], refreshed: [], preserved: [], skipped: [], errors: [] };
  const seeded: Record<string, string> = { ...state.seeded };
  const { entries, errors } = await readPackEntries(packRoot);
  result.errors.push(...errors);
  for (const entry of entries) {
    const destination = path.join(managedRoot, entry.id);
    if (state.removed.includes(entry.id)) { result.skipped.push(entry.id); delete seeded[entry.id]; continue; }
    const recorded = state.seeded[entry.id];
    let present = false;
    try { present = (await fs.lstat(destination)).isDirectory(); } catch { present = false; }
    try {
      if (!present) {
        await copySkill(entry.source, destination);
        seeded[entry.id] = entry.digest;
        result.added.push(entry.id);
        continue;
      }
      const current = await directoryDigest(destination).catch(() => null);
      if (current !== null && recorded !== undefined && current === recorded) {
        await copySkill(entry.source, destination);
        seeded[entry.id] = entry.digest;
        result.refreshed.push(entry.id);
        continue;
      }
      // Either the user edited it, or provenance is unknown. Both mean "do not touch".
      result.preserved.push(entry.id);
      if (recorded !== undefined) seeded[entry.id] = recorded;
    } catch (error) {
      // Only the two copy branches reach here, and both destinations are this app's own work —
      // never the user's content — so a half-written copy is discarded rather than left behind,
      // where it would read as a user edit and be preserved forever.
      await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
      result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Copying writes directories directly, so `skills.ts`'s cache still describes the scan
  // `initSkillsPath` took before any of this existed — which is why a connector asking for
  // instructions on a fresh install was handed "No skills are installed." while all fourteen
  // sat on disk. `listSkills` is that cache's owner (scan, then publish) and is the only thing
  // allowed to refresh it; doing it here, rather than at the call site, means no caller can
  // forget. A preserved entry changes nothing the catalog did not already describe.
  //
  // Guarded, because the catalog describes exactly one directory. Syncing any other root — a
  // test's, another profile's — must not publish that root's contents as the app's library.
  //
  // Its failure is reported, never thrown: this runs after the copies, and a throw here would
  // discard the whole provenance map — the same degradation the loop's isolation exists to
  // prevent.
  if ((result.added.length || result.refreshed.length) && skillsDirectory() === managedRoot) {
    try { await listSkills(); }
    catch (error) { result.errors.push(`catalog: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { result, seeded };
}
