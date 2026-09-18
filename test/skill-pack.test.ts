import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { emptySkillState } from '../src/main/skill-state.js';
import { skillCatalogInstructions, initSkillsPath, listSkills, skillsDirectory } from '../src/main/skills.js';
import { directoryDigest, mergeSeedDelta, readPackEntries, syncSkillPack } from '../src/main/skill-pack.js';

let root: string, pack: string, managed: string;
const skill = (name: string, body = 'Body.') => `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n${body}`;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
const exists = async (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillpack-');
  pack = path.join(root, 'pack'); managed = path.join(root, 'managed');
  await write(path.join(pack, 'alpha', 'SKILL.md'), skill('Alpha'));
  await write(path.join(pack, 'beta', 'SKILL.md'), skill('Beta'));
  await write(path.join(pack, 'beta', 'reference.md'), 'Supporting bytes.');
  await fs.mkdir(managed, { recursive: true });
});
afterEach(async () => { await removeTempDir(root); });

it('seeds every packed skill into an empty library', async () => {
  const { result, delta } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  expect(result.added.sort()).toEqual(['alpha', 'beta']);
  expect(result.errors).toEqual([]);
  expect(await fs.readFile(path.join(managed, 'alpha', 'SKILL.md'), 'utf8')).toBe(skill('Alpha'));
  expect(await fs.readFile(path.join(managed, 'beta', 'reference.md'), 'utf8')).toBe('Supporting bytes.');
  // The delta names exactly what the pass wrote — everything, for a library that had nothing.
  expect(Object.keys(delta).sort()).toEqual(['alpha', 'beta']);
});

it('is a no-op when the managed copy still matches what we wrote', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  const state = mergeSeedDelta(emptySkillState(), first.delta);
  const second = await syncSkillPack({ managedRoot: managed, packRoot: pack, state });
  expect(second.result.added).toEqual([]);
  expect(second.result.preserved).toEqual([]);
  expect(second.result.refreshed.sort()).toEqual(['alpha', 'beta']);
});

it('preserves a skill the user edited instead of overwriting it', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  const state = mergeSeedDelta(emptySkillState(), first.delta);
  await write(path.join(managed, 'alpha', 'SKILL.md'), skill('Alpha', 'My own edit.'));
  const edited = await directoryDigest(path.join(managed, 'alpha'));
  const second = await syncSkillPack({ managedRoot: managed, packRoot: pack, state });
  expect(second.result.preserved).toContain('alpha');
  expect(await fs.readFile(path.join(managed, 'alpha', 'SKILL.md'), 'utf8')).toBe(skill('Alpha', 'My own edit.'));
  // A preserved entry is untouched, so it is absent from the delta and keeps the stale hash
  // the state already holds — which is what makes the edit keep being preserved next launch.
  expect(second.delta.alpha).toBeUndefined();
  expect(mergeSeedDelta(state, second.delta).seeded.alpha).toBe(state.seeded.alpha);
  expect(edited).not.toBe(state.seeded.alpha);
});

it('never resurrects a skill the user removed', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  const state = mergeSeedDelta(emptySkillState(), first.delta);
  await fs.rm(path.join(managed, 'alpha'), { recursive: true });
  const second = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: { ...state, removed: ['alpha'] } });
  expect(second.result.skipped).toContain('alpha');
  expect(await exists(path.join(managed, 'alpha'))).toBe(false);
  // A tombstoned entry's record is dropped by the delta, so the next read cannot resurrect it.
  expect(second.delta.alpha).toBeNull();
  expect(mergeSeedDelta(state, second.delta).seeded.alpha).toBeUndefined();
  expect(second.result.refreshed).toContain('beta');
});

it('re-seeds a removed-then-reinstalled skill only once its tombstone is cleared', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  const state = mergeSeedDelta(emptySkillState(), first.delta);
  await fs.rm(path.join(managed, 'alpha'), { recursive: true });
  await syncSkillPack({ managedRoot: managed, packRoot: pack, state: { ...state, removed: ['alpha'] } });
  const cleared = await syncSkillPack({ managedRoot: managed, packRoot: pack, state });
  expect(cleared.result.added).toContain('alpha');
  expect(await exists(path.join(managed, 'alpha', 'SKILL.md'))).toBe(true);
});

it('refuses a packed skill whose file is invalid and keeps the library intact', async () => {
  await fs.writeFile(path.join(pack, 'broken', 'SKILL.md').replace('/broken/', '/broken/'), '', 'utf8').catch(() => undefined);
  await write(path.join(pack, 'broken', 'SKILL.md'), '');
  const { result } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  expect(result.errors.join(' ')).toMatch(/broken/);
  expect(result.added.sort()).toEqual(['alpha', 'beta']);
  expect(await exists(path.join(managed, 'broken'))).toBe(false);
});

it('ignores pack entries whose names are not valid skill ids', async () => {
  await write(path.join(pack, 'Not An Id', 'SKILL.md'), skill('Bad'));
  const { entries } = await readPackEntries(pack);
  expect(entries.map(entry => entry.id).sort()).toEqual(['alpha', 'beta']);
});

it('shows the seeded skills in the published catalog instead of an empty library', async () => {
  await initSkillsPath(root);
  // The scan initSkillsPath published ran before anything was mirrored, so this is exactly what
  // a connector asking for instructions on first launch used to be handed.
  expect(skillCatalogInstructions()).toContain('No skills are installed.');
  const { result } = await syncSkillPack({ managedRoot: skillsDirectory()!, packRoot: pack, state: emptySkillState() });
  expect(result.added.sort()).toEqual(['alpha', 'beta']);
  // The sync writes directories itself and never goes through skills.ts's owner, so it has to
  // republish that cache on the way out or this keeps claiming there are no skills.
  expect(skillCatalogInstructions()).not.toContain('No skills are installed.');
  expect(skillCatalogInstructions()).toContain('"id":"alpha"');
  await listSkills();
  expect(skillCatalogInstructions()).toContain('"id":"beta"');
});

it('isolates a failed copy so later skills still seed and provenance still lands', async () => {
  const realCopy = fs.cp.bind(fs);
  const copier = vi.spyOn(fs, 'cp').mockImplementation(async (from, to, options) => {
    if (path.basename(String(from)) === 'alpha') throw new Error('EACCES: permission denied');
    return realCopy(from, to, options);
  });
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() })
    .finally(() => copier.mockRestore());
  // The failure is reported, not thrown, and it does not stop the entries after it.
  expect(first.result.errors.join(' ')).toMatch(/alpha/);
  expect(first.result.errors.join(' ')).toMatch(/EACCES/);
  expect(first.result.added).toEqual(['beta']);
  // The failed entry contributes nothing to the delta; only the copy that landed is recorded.
  expect(first.delta.alpha).toBeUndefined();
  expect(first.delta.beta).toBeDefined();
  expect(await exists(path.join(managed, 'beta', 'SKILL.md'))).toBe(true);
  // The digest for the skill that did copy has to survive the failure. Without it the next
  // launch reads the directory as provenance-unknown, preserves it, and the pack can never
  // refresh that skill again.
  const next = await syncSkillPack({
    managedRoot: managed, packRoot: pack,
    state: mergeSeedDelta(emptySkillState(), first.delta)
  });
  expect(next.result.refreshed).toContain('beta');
  expect(next.result.added).toContain('alpha');
});
