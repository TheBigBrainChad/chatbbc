/**
 * The Skills settings section: one row per skill, with an on/off switch, an implicit switch,
 * and the body's size.
 *
 * The three are separate on purpose. Enablement decides whether a skill exists for the model at
 * all. Implicit invocation decides whether the model may open it without being asked; some
 * skills are useful only when named, and conflating the two would remove that choice. Size is
 * neither: it is the cost of the body, shown so a fifteen-kilobyte skill is never named blind.
 *
 * A skill the user switched off leaves the model-facing catalog, so the page cannot read its
 * rows from that list alone — turning one off would be a one-way door. The reply carries the
 * omitted rows as `disabled`, projected from the same read, and they are rendered in a second
 * group with the switch already in its "on" position so they can be brought back.
 */

import type { LibrarySkill, SkillLibraryPage, SkillState } from '../shared/skills.js';
import { applySettingsFilter, el, humanBytes } from './dom.js';
import { t } from './i18n.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SkillsLibraryOptions {
  host: HTMLElement;
  list: () => Promise<Reply<SkillLibraryPage>>;
  set: (payload: { id: string; enabled?: boolean; implicit?: boolean }) => Promise<Reply<SkillState>>;
  notify: (message: string) => void;
}

/** What the section hands back to its owner: a way to re-read the library on demand. */
export interface SkillsLibraryView {
  refresh: () => Promise<void>;
}

const scopeLabel = (skill: LibrarySkill): string => skill.scope === 'repo' ? t('Project')
  : skill.scope === 'system' ? t('System') : skill.scope === 'admin' ? t('Admin') : t('Personal');

const titleOf = (skill: LibrarySkill): string => skill.displayName || skill.name;

/** One row's name, scope, description and size. Nothing here changes state. */
function rowHead(skill: LibrarySkill): HTMLElement {
  const head = el('div', 'skill-library-head');
  head.append(el('strong', '', titleOf(skill)), el('span', 'skill-library-scope', scopeLabel(skill)));
  // An absent size renders nothing rather than "0 B": a row without one is a row whose body was
  // never read, and a made-up zero would read as an empty skill.
  if (typeof skill.bytes === 'number') head.append(el('span', 'skill-library-size', humanBytes(skill.bytes)));
  return head;
}

/**
 * One write, from the press to the repaint.
 *
 * Both controls are the same transaction: send the change, report a refusal, then re-read so the
 * row is redrawn from what the main process actually kept. `undo` is the part that is not shared
 * — a checkbox has already flipped in the DOM and has to be put back, while a button never moved.
 *
 * Nothing may escape: the handler fires this without awaiting it, so a failed transport call
 * would otherwise surface as an unhandled rejection instead of the message the user needs.
 */
function commit(options: SkillsLibraryOptions, refresh: () => Promise<void>, payload: { id: string; enabled?: boolean; implicit?: boolean }, undo?: () => void): void {
  const report = (message: string): void => { undo?.(); options.notify(message); };
  void (async () => {
    try {
      const reply = await options.set(payload);
      if (!reply.ok) { report(reply.error); return; }
      await refresh();
    } catch (failure) {
      report(failure instanceof Error ? failure.message : t('Skills could not be loaded.'));
    }
  })();
}

/**
 * The on/off control, in both of its readings.
 *
 * `enabled` is the state the row is offering to leave, so the label describes the move: a
 * present skill is turned off, an omitted one is turned on. It is deliberately not labelled
 * "Remove" or "Reset": switching a skill off only takes it out of the catalog, and the file
 * stays on disk — promising more than that would misdescribe what the button does.
 */
function switchControl(skill: LibrarySkill, enabled: boolean, options: SkillsLibraryOptions, refresh: () => Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn', () => t(enabled ? 'Turn off' : 'Turn on')) as HTMLButtonElement;
  button.type = 'button';
  button.dataset.skillId = skill.id;
  button.dataset.action = enabled ? 'disable' : 'enable';
  button.addEventListener('click', () => commit(options, refresh, { id: skill.id, enabled: !enabled }));
  return button;
}

/**
 * The implicit-invocation switch.
 *
 * A failed write restores the box: the checkbox has already flipped in the DOM, and leaving it
 * flipped would show a choice the app did not accept.
 */
function implicitControl(skill: LibrarySkill, options: SkillsLibraryOptions, refresh: () => Promise<void>): HTMLElement {
  const box = el('input', '') as HTMLInputElement;
  box.type = 'checkbox';
  box.checked = skill.allowImplicitInvocation;
  box.dataset.skillId = skill.id;
  box.addEventListener('change', () => {
    commit(options, refresh, { id: skill.id, implicit: box.checked }, () => { box.checked = !box.checked; });
  });
  const label = el('label', 'skill-library-switch');
  label.append(box, el('span', '', () => t('Let ChatGPT use this on its own')));
  return label;
}

/** One skill: what it is, how big it is, and the two choices about it. */
function row(skill: LibrarySkill, enabled: boolean, options: SkillsLibraryOptions, refresh: () => Promise<void>): HTMLElement {
  const node = el('div', 'skill-library-row');
  node.setAttribute('role', 'listitem');
  if (!enabled) node.classList.add('is-disabled');
  node.append(rowHead(skill), el('p', 'skill-library-description', skill.shortDescription || skill.description));
  const actions = el('div', 'skill-library-actions');
  actions.append(switchControl(skill, enabled, options, refresh));
  // Implicit invocation is a choice about a skill the model can already see, so it is offered
  // only while the skill is on. A disabled skill shows one control, and that control is the way
  // back, rather than a second switch whose setting cannot take effect yet.
  if (enabled) actions.append(implicitControl(skill, options, refresh));
  node.append(actions);
  return node;
}

/** A subheading inside the list, so a group of rows reads as a group. */
function groupHeading(label: string, count: number): HTMLElement {
  const node = el('p', 'skill-library-group', () => `${label} · ${count}`);
  node.setAttribute('role', 'presentation');
  return node;
}

const byName = (left: LibrarySkill, right: LibrarySkill): number =>
  titleOf(left).localeCompare(titleOf(right));

export function initSkillsLibrary(options: SkillsLibraryOptions): SkillsLibraryView {
  const { host } = options;
  // Only the newest request may paint. A slow first reply must not overwrite a toggle's own
  // refresh, or the page would show the state from before the switch was pressed.
  let epoch = 0;
  // The reply is untrusted transport, and every caller fires this without awaiting it from an
  // event handler, so nothing may escape: a rejected promise here would surface as an unhandled
  // rejection rather than as the message the user needs. A malformed reply is reported like a
  // refused one — silently rendering an empty library would look like "nothing is installed".
  const report = (failure: unknown): void =>
    options.notify(failure instanceof Error ? failure.message : t('Skills could not be loaded.'));

  const refresh = async (): Promise<void> => {
    const request = ++epoch;
    let reply: Reply<SkillLibraryPage>;
    try { reply = await options.list(); }
    catch (failure) { report(failure); return; }
    if (request !== epoch) return;
    if (!reply.ok) { options.notify(reply.error); return; }
    const page = reply.data as SkillLibraryPage | null | undefined;
    if (!page || !Array.isArray(page.skills)) { report(new Error(t('Skills could not be loaded.'))); return; }
    const enabled = [...page.skills].sort(byName);
    const disabled = [...(page.disabled ?? [])].sort(byName);
    host.replaceChildren();
    const empty = document.getElementById('skillsLibraryEmpty');
    if (empty) empty.hidden = enabled.length + disabled.length > 0;
    for (const skill of enabled) host.append(row(skill, true, options, refresh));
    if (disabled.length) host.append(groupHeading(t('Turned off'), disabled.length));
    for (const skill of disabled) host.append(row(skill, false, options, refresh));
    // The rows arrived after the search box may have been typed into. `filterSettingsSections`
    // runs only from that input handler, so a query entered while this read was in flight was
    // matched against an empty pane; without re-applying it here the section stays hidden and
    // reports "No settings match your search" while matching skills are on screen.
    applySettingsFilter();
  };

  document.getElementById('skillsRefresh')?.addEventListener('click', () => void refresh());
  return { refresh };
}
