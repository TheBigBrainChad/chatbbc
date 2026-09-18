/**
 * The Skills settings section.
 *
 * The page exists so a user can see what is installed, switch a skill off, see what a body
 * costs, and — the part that is easy to get wrong — bring back something they turned off. A
 * page that can turn things off but not back on is a trap, so the disabled group is asserted
 * here rather than assumed.
 *
 * The document is built before the module is imported, mirroring `renderer-skills.test.ts`:
 * `vitest.config.ts` supplies a node environment, and `vi.resetModules()` gives each test the
 * module fresh against its own `window`/`document`.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { LibrarySkill, SkillLibraryPage, SkillState } from '../src/shared/skills.js';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM('<div id="skillsLibraryList" role="list"></div><p id="skillsLibraryEmpty" hidden></p><button id="skillsRefresh" type="button">Refresh</button>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event, Node: dom.window.Node });
});
afterEach(() => dom.window.close());

const skill = (id: string, name: string, implicit = true, bytes?: number): LibrarySkill => ({
  id, name, displayName: name, description: `${name} description`, shortDescription: '',
  path: `/skills/${id}/SKILL.md`, scope: 'managed', source: 'managed', managed: true,
  allowImplicitInvocation: implicit, ...(bytes === undefined ? {} : { bytes })
});

const page = (skills: LibrarySkill[], disabled: LibrarySkill[] = []): SkillLibraryPage =>
  ({ skills, disabled, errors: [], roots: [], includeInstructions: true });

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (error: string) => ({ ok: false as const, error });
const state = () => ok({} as SkillState);
/** One macrotask turn, which is what the module's `.then()` chains need to settle. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

/** The setter as the module sees it, widened to both reply arms so a test can drive a refusal. */
type Setter = (payload: { id: string; enabled?: boolean; implicit?: boolean }) => Promise<{ ok: true; data: SkillState } | { ok: false; error: string }>;

async function fixture(options: { data?: SkillLibraryPage; set?: Setter } = {}) {
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const host = document.getElementById('skillsLibraryList')!;
  const notify = vi.fn();
  const list = vi.fn(async () => ok(options.data ?? page([skill('a', 'Alpha')])));
  const set = vi.fn(options.set ?? (async () => state()));
  return { view: initSkillsLibrary({ host, list, set, notify }), list, set, notify, host };
}

const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.skill-library-row')];
const names = (host: HTMLElement): (string | null)[] => rows(host).map(row => row.querySelector('strong')!.textContent);
const action = (host: HTMLElement, kind: 'disable' | 'enable'): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`[data-action="${kind}"]`)!;

it('renders one row per skill and toggles implicit invocation', async () => {
  const { view, set, host } = await fixture({ data: page([skill('a', 'Alpha'), skill('b', 'Beta', false)]) });
  await view.refresh();
  expect(rows(host)).toHaveLength(2);
  const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes[0]!.checked).toBe(true);
  expect(boxes[1]!.checked).toBe(false);
  boxes[1]!.checked = true;
  boxes[1]!.dispatchEvent(new Event('change'));
  await settle();
  expect(set).toHaveBeenCalledWith({ id: 'b', implicit: true });
});

it('reports a failed toggle instead of silently ignoring it', async () => {
  const { view, notify, host } = await fixture({ set: async () => fail('nope') });
  await view.refresh();
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  await settle();
  expect(notify).toHaveBeenCalledWith('nope');
  // The box has already flipped in the DOM; leaving it flipped would show a choice the app refused.
  expect(box.checked).toBe(true);
});

it('turns an enabled skill off and re-reads so the row moves groups', async () => {
  const { view, set, host, list } = await fixture();
  await view.refresh();
  const off = action(host, 'disable');
  expect(off.textContent).toBe('Turn off');
  off.click();
  await settle();
  expect(set).toHaveBeenCalledWith({ id: 'a', enabled: false });
  expect(list).toHaveBeenCalledTimes(2);
});

/** A refused write must not repaint: the page still shows the state the main process kept. */
it('reports a refused on/off write without re-reading', async () => {
  const { view, notify, host, list } = await fixture({ set: async () => fail('busy') });
  await view.refresh();
  action(host, 'disable').click();
  await settle();
  expect(notify).toHaveBeenCalledWith('busy');
  expect(list).toHaveBeenCalledTimes(1);
});

/**
 * The one-way-door test. A skill the user switched off is gone from the catalog, so if the
 * page rendered only `skills` there would be no way back to it.
 */
it('lists a turned-off skill in its own group with a way back on', async () => {
  const { view, set, host } = await fixture({
    data: page([skill('a', 'Alpha')], [skill('z', 'Zeta', true, 2048)])
  });
  await view.refresh();
  expect(rows(host)).toHaveLength(2);
  expect(names(host)).toEqual(['Alpha', 'Zeta']);
  expect(host.querySelector('.skill-library-group')!.textContent).toBe('Turned off · 1');
  const back = action(host, 'enable');
  expect(back.closest('.skill-library-row')).toBe(rows(host)[1]);
  expect(back.textContent).toBe('Turn on');
  back.click();
  await settle();
  expect(set).toHaveBeenCalledWith({ id: 'z', enabled: true });
});

it('shows what a body costs, and nothing at all when the size is unknown', async () => {
  const { view, host } = await fixture({ data: page([skill('a', 'Alpha', true, 15_360), skill('b', 'Beta')]) });
  await view.refresh();
  const sizes = [...host.querySelectorAll('.skill-library-size')].map(node => node.textContent);
  expect(sizes).toEqual(['15 KB']);
  expect(host.textContent).not.toContain('NaN');
});

/** Implicit invocation is a choice about a skill the model can see, so a hidden one offers only the way back. */
it('offsets a disabled skill one control instead of a switch that cannot take effect', async () => {
  const { view, host } = await fixture({ data: page([], [skill('z', 'Zeta')]) });
  await view.refresh();
  const row = rows(host)[0]!;
  expect(row.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(row.querySelectorAll('button')).toHaveLength(1);
});

it('says so when nothing is installed, and hides that notice once something is', async () => {
  const empty = document.getElementById('skillsLibraryEmpty')!;
  const none = await fixture({ data: page([]) });
  await none.view.refresh();
  expect(empty.hidden).toBe(false);
  expect(none.host.children).toHaveLength(0);

  const one = await fixture({ data: page([], [skill('z', 'Zeta')]) });
  await one.view.refresh();
  // A turned-off skill is an installed skill; the empty notice must not sit above its row.
  expect(empty.hidden).toBe(true);
});

it('reports a failed library read and leaves the last good rows alone', async () => {
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const host = document.getElementById('skillsLibraryList')!;
  const notify = vi.fn();
  const replies = [ok(page([skill('a', 'Alpha')])), fail('library unavailable')];
  const view = initSkillsLibrary({ host, list: async () => replies.shift()!, set: vi.fn() as never, notify });
  await view.refresh();
  await view.refresh();
  expect(notify).toHaveBeenCalledWith('library unavailable');
  expect(names(host)).toEqual(['Alpha']);
});

/**
 * Every caller fires `refresh` from an event handler without awaiting it, so a rejected or
 * malformed transport reply has to be reported here. Left unhandled it surfaced as an unhandled
 * rejection in the suite rather than as a message, and an unreadable page looked like an empty one.
 */
it('survives a reply that is missing its payload instead of throwing', async () => {
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const host = document.getElementById('skillsLibraryList')!;
  const notify = vi.fn();
  const view = initSkillsLibrary({ host, list: async () => ({ ok: true, data: null }) as never, set: vi.fn() as never, notify });
  await expect(view.refresh()).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledWith('Skills could not be loaded.');
  expect(rows(host)).toHaveLength(0);
});

it('reports a transport rejection rather than letting it escape', async () => {
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const host = document.getElementById('skillsLibraryList')!;
  const notify = vi.fn();
  const view = initSkillsLibrary({ host, list: async () => { throw new Error('channel closed'); }, set: vi.fn() as never, notify });
  await expect(view.refresh()).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledWith('channel closed');
});

it('reports a rejected write rather than letting it escape', async () => {
  const { view, notify, host } = await fixture({ set: async () => { throw new Error('channel closed'); } });
  await view.refresh();
  action(host, 'disable').click();
  await settle();
  expect(notify).toHaveBeenCalledWith('channel closed');
});

/**
 * Two reads overlap whenever a toggle's own refresh races the initial load. Only the newest may
 * paint, or the page would show the state from before the switch was pressed.
 */
it('ignores a reply for a superseded read', async () => {
  const { initSkillsLibrary } = await import('../src/renderer/skills-library.js');
  const host = document.getElementById('skillsLibraryList')!;
  let release: (() => void) | undefined;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const view = initSkillsLibrary({
    host,
    list: async () => {
      calls += 1;
      const superseded = calls === 1;
      if (superseded) await stalled;
      return ok(page([superseded ? skill('a', 'Alpha') : skill('b', 'Beta')]));
    },
    set: vi.fn() as never,
    notify: vi.fn()
  });
  const first = view.refresh();
  await view.refresh();
  release!();
  await first;
  expect(names(host)).toEqual(['Beta']);
});

it('re-reads from the Refresh button', async () => {
  const { view, list } = await fixture();
  await view.refresh();
  document.getElementById('skillsRefresh')!.click();
  await settle();
  expect(list).toHaveBeenCalledTimes(2);
});
