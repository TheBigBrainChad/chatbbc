/**
 * The three actions the Skills page can take, as one validated entry point.
 *
 * They live apart from the IPC handlers so the validation and the state transition can be
 * tested without an Electron channel, and so no renderer payload can reach `skill-state.ts`
 * unvalidated. An id is always re-checked here: the renderer is a boundary, not a caller.
 *
 * All three are `async` because their first act is to reject a bad payload. A synchronous
 * throw from a function whose return type is `Promise` is not the same thing as a rejected
 * promise — `handle` in `ipc.ts` absorbs either, but a caller awaiting the returned value
 * would see the throw escape before it ever held a promise.
 */

import { SKILL_ID_PATTERN } from '../shared/skills.js';
import { currentSkillState, mutateSkillState, type SkillState } from './skill-state.js';
import { bundledSkillPackRoot, mergeSeedDelta, syncSkillPack } from './skill-pack.js';
import { skillsDirectory } from './skills.js';

/**
 * The one id check on this path. `skills.ts` has a private copy for the ids it reads off
 * disk; this is the copy that stands between a renderer payload and a state file, so it is
 * exported and used by every action below rather than trusted to each caller.
 */
export function assertSkillId(id: string): void {
  if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) throw new Error('Choose a valid skill');
}

/** An absent entry means inherit, so `undefined` deletes the choice rather than storing one. */
export async function setSkillEnabled(id: string, enabled: boolean | undefined): Promise<SkillState> {
  assertSkillId(id);
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('A skill switch is on or off');
  return mutateSkillState(state => {
    const next = { ...state.enabled };
    if (enabled === undefined) delete next[id];
    else next[id] = enabled;
    return { ...state, enabled: next };
  });
}

export async function setSkillImplicit(id: string, implicit: boolean | undefined): Promise<SkillState> {
  assertSkillId(id);
  if (implicit !== undefined && typeof implicit !== 'boolean') throw new Error('A skill switch is on or off');
  return mutateSkillState(state => {
    const next = { ...state.implicit };
    if (implicit === undefined) delete next[id];
    else next[id] = implicit;
    return { ...state, implicit: next };
  });
}

/**
 * Restores one bundled skill from the pack after the user removed it.
 *
 * The order is the operation, not an implementation detail. A sync run while the tombstone is
 * still set skips that id — that is exactly what a tombstone is for — so the clear has to be
 * durable and published first or nothing is restored. The digest the sync reports has to be
 * stored afterwards, or the next launch would find a copy it cannot recognize as its own work
 * and preserve it forever from then on, freezing the skill at whatever the pack held today.
 *
 * One sync, not two: the copy and the digest come from the same pass over the pack.
 *
 * The state is re-read after each await rather than carried across it. The sync is not inside
 * `mutateSkillState`'s serialization — it is a filesystem pass — so a toggle from another
 * window can land while it runs, and the sync must run against what is true now, with the
 * persisted provenance merged into the state that exists when it finishes.
 *
 * This restores a skill that is missing; it deliberately does not overwrite one the user
 * edited, because to `syncSkillPack` an edit and a foreign file look the same, and the rule
 * that protects the first is what protects the second.
 */
export async function resetPackedSkill(id: string): Promise<SkillState> {
  assertSkillId(id);
  const packRoot = bundledSkillPackRoot();
  const managedRoot = skillsDirectory();
  if (!packRoot || !managedRoot) throw new Error('The bundled skill pack is unavailable');
  await mutateSkillState(state => ({ ...state, removed: state.removed.filter(entry => entry !== id) }));
  const { delta } = await syncSkillPack({ managedRoot, packRoot, state: currentSkillState() });
  // The delta is merged inside the mutation, against the state as it is at commit time. Folding
  // it into a snapshot read before the sync would re-install that snapshot and discard any
  // provenance another caller recorded while the filesystem pass was running — a copy whose
  // record is lost can never be refreshed again. `mergeSeedDelta` only touches the ids this
  // pass actually wrote, so it cannot erase them.
  return mutateSkillState(current => mergeSeedDelta(current, delta));
}
