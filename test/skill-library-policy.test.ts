/** The catalog must respect the user's own choices, on top of the external discovery rules. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath } from '../src/main/skills.js';
import { listSkillInventory, listSkillLibrary, skillLibraryInstructions } from '../src/main/skill-library.js';
import { emptySkillState, setSkillStateForTests } from '../src/main/skill-state.js';

let root: string, home: string;
const contents = (name: string) => `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\nBody for ${name}.`;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, 'utf8');
}
const writeSkillPackage = (directory: string, name: string): Promise<void> => write(path.join(directory, 'SKILL.md'), contents(name));

beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillpolicy-');
  home = path.join(root, 'home');
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
  initConfigPath(root);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: root }] });
  await initSkillsPath(root);
  await writeSkillPackage(path.join(root, 'skills', 'writing-plans'), 'Writing Plans');
  setSkillStateForTests(emptySkillState());
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTempDir(root); });

it('lists a managed skill by default', async () => {
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).toContain('writing-plans');
});

it('omits a skill the user switched off', async () => {
  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).not.toContain('writing-plans');
  expect(skillLibraryInstructions(library)).not.toContain('writing-plans');
});

it('suppresses a discovered skill that shadows a bundled one', async () => {
  // The discovered copy has the same name and would otherwise appear as its hashed variant.
  await writeSkillPackage(path.join(root, 'skills', 'brainstorming'), 'Brainstorming');
  await writeSkillPackage(path.join(home, '.agents', 'skills', 'brainstorming'), 'Brainstorming');
  const library = await listSkillLibrary({});
  const named = library.skills.filter(skill => (skill.displayName ?? skill.name) === 'Brainstorming');
  expect(named).toHaveLength(1);
  expect(named[0]!.managed).toBe(true);
});

it('does not surface the unadapted twin when the curated skill is switched off', async () => {
  await writeSkillPackage(path.join(root, 'skills', 'brainstorming'), 'Brainstorming');
  await writeSkillPackage(path.join(home, '.agents', 'skills', 'brainstorming'), 'Brainstorming');
  setSkillStateForTests({ ...emptySkillState(), enabled: { brainstorming: false } });
  const library = await listSkillLibrary({});
  // The curated one is off, and its unadapted twin must not step into the vacated slot.
  expect(library.skills.filter(skill => (skill.displayName ?? skill.name) === 'Brainstorming')).toEqual([]);
});

it('advertises proactive reading only while a listed skill allows it', async () => {
  expect(skillLibraryInstructions(await listSkillLibrary({}))).toMatch(/read its file/i);
  setSkillStateForTests({ ...emptySkillState(), implicit: { 'writing-plans': false } });
  const library = await listSkillLibrary({});
  // The skill is still enabled; only its consent to be opened unprompted is withdrawn.
  expect(library.skills.map(skill => skill.id)).toContain('writing-plans');
  expect(library.skills[0]!.allowImplicitInvocation).toBe(false);
  expect(skillLibraryInstructions(library)).not.toMatch(/read its file/i);
});

it('reports a disabled skill through the inventory the catalog omits', async () => {
  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const catalog = await listSkillLibrary({});
  const inventory = await listSkillInventory({});
  expect(catalog.skills.map(skill => skill.id)).not.toContain('writing-plans');
  const row = inventory.skills.find(skill => skill.id === 'writing-plans');
  expect(row?.enabled).toBe(false);
});

it('resolves policy for an id that names an Object.prototype member', async () => {
  // `constructor` passes the id pattern and is an inherited key of both state maps.
  await writeSkillPackage(path.join(root, 'skills', 'constructor'), 'Constructor');
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).toContain('constructor');
  expect(library.skills.find(skill => skill.id === 'constructor')!.allowImplicitInvocation).toBe(true);
});
