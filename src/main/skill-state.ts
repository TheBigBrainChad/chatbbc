/**
 * The app's own record of the bundled Skill pack and the user's choices about it.
 *
 * Two things must not diverge, so they share one serialized owner: provenance (which files
 * this app wrote, so an upgrade can refresh them without destroying a user's edit) and
 * tombstones (which skills the user deleted, so a seed never resurrects them).
 *
 * Enablement deliberately does not live in `config.json`. The renderer's settings save is a
 * field-wise `{base, patch}` merge, which is correct for scalar fields and wrong for a map:
 * toggling one skill would rewrite the whole map from a stale base and clobber a concurrent
 * toggle of another skill.
 */

import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { logWarn } from './logger.js';
import type { SkillState } from '../shared/skills.js';

export type { SkillState } from '../shared/skills.js';

export interface SkillPolicy {
  enabled: boolean;
  implicit: boolean;
}

export const SKILL_STATE = 'skills';
const MAX_IDS = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function emptySkillState(): SkillState {
  return { version: 1, seeded: {}, enabled: {}, implicit: {}, removed: [] };
}

function booleanMap(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (ID.test(key) && typeof entry === 'boolean' && Object.keys(result).length < MAX_IDS) result[key] = entry;
  }
  return result;
}

/**
 * Malformed input is discarded field by field. A bad file must not widen authority.
 *
 * A version this build does not know is discarded like any other bad field rather than
 * voiding the file: the version describes the writer, and every field below is validated on
 * its own evidence. The result is always version 1.
 */
export function sanitizeSkillState(raw: unknown): SkillState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptySkillState();
  const source = raw as Record<string, unknown>;
  const state = emptySkillState();
  if (source.seeded !== null && typeof source.seeded === 'object' && !Array.isArray(source.seeded)) {
    for (const [key, entry] of Object.entries(source.seeded as Record<string, unknown>)) {
      if (ID.test(key) && typeof entry === 'string' && DIGEST.test(entry) && Object.keys(state.seeded).length < MAX_IDS) {
        state.seeded[key] = entry;
      }
    }
  }
  state.enabled = booleanMap(source.enabled);
  state.implicit = booleanMap(source.implicit);
  if (Array.isArray(source.removed)) {
    for (const entry of source.removed) {
      if (typeof entry === 'string' && ID.test(entry) && !state.removed.includes(entry) && state.removed.length < MAX_IDS) {
        state.removed.push(entry);
      }
    }
  }
  return state;
}

/** The complete key set `emptySkillState` produces. Anything else is not this app's own shape. */
const STATE_KEYS = ['version', 'seeded', 'enabled', 'implicit', 'removed'];

function looksLikeIdRecord(value: unknown, entryIsValid: (entry: unknown) => boolean): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  // The bound is enforced here too, or a state the app would truncate on its next read
  // could still be cached and published as valid.
  if (entries.length > MAX_IDS) return false;
  return entries.every(([key, entry]) => ID.test(key) && entryIsValid(entry));
}

/**
 * Whether a changed state is one this app could have written itself.
 *
 * `sanitizeSkillState` is a repair: it keeps whatever it can trust. This is the stricter
 * question a mutation must answer before anything is stored. It accepts exactly the states
 * the repair leaves unchanged — the same version, the same five keys, the same field shapes,
 * within the same bounds — so a change that returns something the app never produces fails
 * loudly instead of being silently truncated into a valid state and written as if it were
 * intended. Unknown keys are rejected for that reason: sanitize would strip them, so accepting
 * them here would let the cache hold a state its own next read could not reproduce.
 */
function isOwnSkillState(value: unknown): value is SkillState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).length !== STATE_KEYS.length) return false;
  if (!STATE_KEYS.every(key => Object.hasOwn(state, key))) return false;
  if (!Array.isArray(state.removed) || state.removed.length > MAX_IDS) return false;
  const removed = new Set(state.removed);
  return (
    state.version === 1 &&
    looksLikeIdRecord(state.seeded, entry => typeof entry === 'string' && DIGEST.test(entry)) &&
    looksLikeIdRecord(state.enabled, entry => typeof entry === 'boolean') &&
    looksLikeIdRecord(state.implicit, entry => typeof entry === 'boolean') &&
    removed.size === state.removed.length &&
    state.removed.every(entry => typeof entry === 'string' && ID.test(entry))
  );
}

let cache: SkillState = emptySkillState();
let operations: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = operations.then(work, work);
  operations = run.then(() => undefined, () => undefined);
  return run;
}

export function currentSkillState(): SkillState {
  return cache;
}

export function setSkillStateForTests(state: SkillState): void {
  cache = state;
}

export async function restoreSkillState(): Promise<void> {
  const stored = await readDurable<unknown>(SKILL_STATE);
  cache = sanitizeSkillState(stored);
}

/**
 * Applies one change and returns the published state. Serialized, so two toggles cannot
 * interleave a read and a write. The durable write happens before the cache advances, so a
 * caller that sees the new state knows it survived a crash.
 *
 * A failed write is refused *and* superseded. durable.ts deliberately keeps a failed generation
 * pending and retries it, which is right when the value is still wanted, but here the caller is
 * being told the change was not stored — so that generation has to be replaced by the state that
 * is still authoritative before it is allowed to land later. Otherwise the refused value would be
 * written moments after the refusal and resurrected by the next `restoreSkillState`, leaving disk
 * ahead of the cache: the exact divergence this module exists to prevent.
 */
export function mutateSkillState(change: (state: SkillState) => SkillState): Promise<SkillState> {
  return serial(async () => {
    const next = change(cache);
    if (!isOwnSkillState(next)) throw new Error('Refusing to store an invalid Skill state');
    try {
      await writeDurableNow(SKILL_STATE, next);
    } catch (error) {
      writeDurableSoon(SKILL_STATE, cache);
      throw error;
    }
    cache = next;
    return next;
  });
}

/**
 * One decision point for whether a skill is used and whether the model may select it itself.
 *
 * Enablement: app choice, then an external discovery rule, then on. A skill's own metadata has
 * no enablement concept, so it contributes no layer here.
 * Implicit: app choice, then the skill's own `allow_implicit_invocation` declaration.
 *
 * Both maps are plain objects, so a bare `map[id]` would find `Object.prototype` members for ids
 * like `constructor` — a valid skill id that is also an inherited key. That would read an
 * inherited function as a stored choice, skip the rule and the default, and return a non-boolean
 * the IPC layer cannot structured-clone. `Object.hasOwn` asks the only question that matters
 * here: did the app store a choice for this id?
 */
export function resolveSkillPolicy(
  id: string,
  declaration: boolean,
  external: boolean | undefined,
  state: SkillState
): SkillPolicy {
  const enabled = Object.hasOwn(state.enabled, id) ? state.enabled[id]! : (external ?? true);
  const implicit = Object.hasOwn(state.implicit, id) ? state.implicit[id]! : declaration;
  return { enabled, implicit };
}

export function logSkillStateProblem(message: string): void {
  logWarn(`Skill pack: ${message}`);
}
