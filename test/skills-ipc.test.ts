/**
 * The Skills page's write surface, from the state file down to the IPC channel.
 *
 * The state transitions are exercised directly, and the two handlers once through the
 * channel, because that is the only place the strict payload schema and the id re-check
 * on a renderer payload can be observed.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSkillsPath, skillsDirectory } from '../src/main/skills.js';
import { emptySkillState, currentSkillState, restoreSkillState, setSkillStateForTests } from '../src/main/skill-state.js';
import { bundledSkillPackRoot, directoryDigest, syncSkillPack } from '../src/main/skill-pack.js';
import { setSkillEnabled, setSkillImplicit, resetPackedSkill } from '../src/main/skill-management.js';
import { registerIpc } from '../src/main/ipc.js';

type Reply = { ok: boolean; data?: unknown; error?: string };
type Handler = (event: unknown, payload: unknown) => Promise<Reply>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  // The pack and the app root are the same checkout in a test run, which is how
  // `bundledSkillPackRoot` finds `skill-pack/` exactly as it does in development.
  app: {
    on: vi.fn(),
    getPath: () => '',
    getVersion: () => '0.0.0',
    getAppPath: () => fileURLToPath(new URL('..', import.meta.url)),
    isPackaged: false
  }
}));

let root: string;
const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillipc-');
  initConfigPath(root); initDurableStore(root);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: root }] });
  await initSkillsPath(root);
  await fs.mkdir(path.join(root, 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: Alpha\ndescription: Alpha skill.\n---\nBody.', 'utf8');
  resetDurableForTests(); initDurableStore(root); setSkillStateForTests(emptySkillState());
});
afterEach(async () => { resetDurableForTests(); await removeTempDir(root); });

it('records an explicit choice and survives a restart', async () => {
  await setSkillEnabled('alpha', false);
  expect(currentSkillState().enabled.alpha).toBe(false);
  await restoreSkillState();
  expect(currentSkillState().enabled.alpha).toBe(false);
});

it('clears a choice back to inherit when passed undefined', async () => {
  await setSkillEnabled('alpha', false);
  await setSkillEnabled('alpha', undefined);
  expect(currentSkillState().enabled.alpha).toBeUndefined();
});

it('refuses an id that is not a valid skill id', async () => {
  await expect(setSkillEnabled('../escape', false)).rejects.toThrow(/skill/i);
});

it('clears a tombstone so a removed bundled skill comes back', async () => {
  setSkillStateForTests({ ...emptySkillState(), removed: ['alpha'] });
  await setSkillImplicit('alpha', true);
  expect(currentSkillState().removed).toContain('alpha');
});

/** Removes the managed copy the way the user's own removal does, tombstone and all. */
async function tombstone(id: string): Promise<{ packRoot: string; managedRoot: string }> {
  const packRoot = bundledSkillPackRoot();
  const managedRoot = skillsDirectory();
  if (!packRoot || !managedRoot) throw new Error('The bundled skill pack must be present for this suite');
  await fs.rm(path.join(managedRoot, id), { recursive: true, force: true });
  setSkillStateForTests({ ...emptySkillState(), removed: [id] });
  return { packRoot, managedRoot };
}

it('restores a removed bundled skill and records the provenance a later launch needs', async () => {
  const id = 'brainstorming';
  const { packRoot, managedRoot } = await tombstone(id);

  const state = await resetPackedSkill(id);

  expect(state.removed).not.toContain(id);
  expect(await exists(path.join(managedRoot, id, 'SKILL.md'))).toBe(true);
  // Provenance is the digest of what was just written, so the copy is this app's own work.
  expect(state.seeded[id]).toBe(await directoryDigest(path.join(packRoot, id)));
  // The tombstone was cleared before the sync, or the entry would have been skipped; the
  // digest was recorded after it, or the next launch would read the copy as a user edit and
  // preserve it forever. A second sync is exactly that next launch.
  const next = await syncSkillPack({ managedRoot, packRoot, state: currentSkillState() });
  expect(next.result.refreshed).toContain(id);
  expect(next.result.preserved).not.toContain(id);
});

it('leaves the restored choice on disk, so a restart keeps the skill', async () => {
  const id = 'brainstorming';
  await tombstone(id);
  await resetPackedSkill(id);
  await restoreSkillState();
  expect(currentSkillState().removed).not.toContain(id);
});

it('applies a choice from the renderer channel and refuses payloads outside the schema', async () => {
  registerIpc(() => null, () => undefined);
  const set = handlers.get('skills:set');
  expect(set).toBeTypeOf('function');

  expect(await set!(null, { id: 'alpha', enabled: false })).toMatchObject({ ok: true });
  expect(currentSkillState().enabled.alpha).toBe(false);
  // An extra key and a traversing id are refused, not ignored: the renderer is a boundary.
  expect(await set!(null, { id: 'alpha', enabled: false, rogue: true })).toMatchObject({ ok: false });
  expect(await set!(null, { id: '../escape' })).toMatchObject({ ok: false });

  const reset = handlers.get('skills:reset');
  expect(reset).toBeTypeOf('function');
  await tombstone('brainstorming');
  const restored = await reset!(null, { id: 'brainstorming' });
  expect(restored.ok, restored.error).toBe(true);
  expect(currentSkillState().removed).not.toContain('brainstorming');
  expect(await reset!(null, { id: '../escape' })).toMatchObject({ ok: false });
});
