/** The catalog must respect the user's own choices, on top of the external discovery rules. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath } from '../src/main/skills.js';
import { buildServer } from '../src/main/mcp/tools.js';
import { listSkillLibrary, listSkillLibraryPage, skillLibraryInstructions } from '../src/main/skill-library.js';
import { emptySkillState, setSkillStateForTests } from '../src/main/skill-state.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import type { LibrarySkill } from '../src/shared/skills.js';

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

it('reports the body size as UTF-8 bytes, so Settings can show what a skill costs', async () => {
  // Multi-byte content on purpose: the em dash is three bytes and 'ü' two, so a character count
  // would report fewer bytes than the file holds and the row would understate the skill.
  await writeSkillPackage(path.join(root, 'skills', 'accented'), 'Accented — näh');
  const library = await listSkillLibrary({});
  const row = library.skills.find((skill: LibrarySkill) => skill.id === 'accented')!;
  const body = await fs.readFile(path.join(root, 'skills', 'accented', 'SKILL.md'), 'utf8');
  expect(row.bytes).toBe(Buffer.byteLength(body, 'utf8'));
  expect(row.bytes).toBeGreaterThan(body.length);
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

it('reports a disabled skill through the page the catalog omits', async () => {
  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const catalog = await listSkillLibrary({});
  const page = await listSkillLibraryPage({});
  expect(catalog.skills.map(skill => skill.id)).not.toContain('writing-plans');
  const row = page.disabled.find((skill: LibrarySkill) => skill.id === 'writing-plans');
  expect(row?.enabled).toBe(false);
  // The two halves are one split of one read, so a row cannot appear in both or in neither.
  expect(page.skills.map(skill => skill.id)).not.toContain('writing-plans');
  expect([...page.skills, ...page.disabled].map(skill => skill.id)).toContain('writing-plans');
});

it('resolves policy for an id that names an Object.prototype member', async () => {
  // `constructor` passes the id pattern and is an inherited key of both state maps.
  await writeSkillPackage(path.join(root, 'skills', 'constructor'), 'Constructor');
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).toContain('constructor');
  expect(library.skills.find(skill => skill.id === 'constructor')!.allowImplicitInvocation).toBe(true);
});

it('omits a disabled skill from the text the MCP server hands the connector', async () => {
  // The handshake, not a helper: this is the string the McpServer constructor receives at
  // `initialize`. Before this, the per-message prompt was filtered while the handshake still
  // advertised the skill the user had switched off.
  let handshake = '';
  const server = await buildServer(
    { roots: [{ name: 'workspace', path: root }], caps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false },
    'core',
    (_name, _version, instructions) => { handshake = instructions; }
  );
  await server.close();
  expect(handshake).toContain('"id":"writing-plans"');

  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const second = await buildServer(
    { roots: [{ name: 'workspace', path: root }], caps: { ...DEFAULT_CAPABILITIES, read: true }, readOnly: false, sessionTools: false, agentTools: false },
    'core',
    (_name, _version, instructions) => { handshake = instructions; }
  );
  await second.close();
  expect(handshake).not.toContain('writing-plans');
  expect(handshake).toContain('No skills are installed.');
});

it('lists no skills and promises no proactive reading when the index admits no row', async () => {
  const library = await listSkillLibrary({});
  // The four fixed lines alone fit, and the sentence is what would tip it over; every row still
  // trips the row budget, so the catalog can list nothing.
  const cramped: typeof library = { ...library, maxContextTokens: 160 };
  const text = skillLibraryInstructions(cramped);
  expect(text).not.toMatch(/read its file/i);
  expect(text).not.toContain('- {');
  expect(text).not.toContain('Additional Skills omitted');
  // A roomier budget lists the row and advertises reading it, so the fixture is not vacuous.
  const roomy = skillLibraryInstructions({ ...library, maxContextTokens: 2000 });
  expect(roomy).toMatch(/read its file/i);
  expect(roomy).toContain('"id":"writing-plans"');
});
