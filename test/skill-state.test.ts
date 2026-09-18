import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { makeTempDir, removeTempDir } from './helpers.js';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  currentSkillState, emptySkillState, mutateSkillState, resolveSkillPolicy,
  restoreSkillState, sanitizeSkillState, setSkillStateForTests
} from '../src/main/skill-state.js';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillstate-');
  initDurableStore(root);
  setSkillStateForTests(emptySkillState());
});
afterEach(async () => { vi.restoreAllMocks(); resetDurableForTests(); await removeTempDir(root); });

it('treats a missing state file as inherit-everything', async () => {
  await restoreSkillState();
  expect(currentSkillState()).toEqual(emptySkillState());
  expect(resolveSkillPolicy('brainstorming', true, undefined, currentSkillState()))
    .toEqual({ enabled: true, implicit: true });
});

it('refuses a malformed state file instead of trusting it', () => {
  const state = sanitizeSkillState({
    version: 99,
    seeded: { good: 'a'.repeat(64), bad: 5 },
    enabled: { good: 'yes', other: false },
    implicit: { other: true },
    removed: ['gone', 7, 'gone']
  });
  expect(state.seeded).toEqual({ good: 'a'.repeat(64) });
  expect(state.enabled).toEqual({ other: false });
  expect(state.implicit).toEqual({ other: true });
  expect(state.removed).toEqual(['gone']);
});

it('lets an explicit app choice beat an external rule, which beats the default', () => {
  const state = { ...emptySkillState(), enabled: { a: true, b: false } };
  // Explicit app on, even though an external rule and declaration say off.
  expect(resolveSkillPolicy('a', false, false, state).enabled).toBe(true);
  // Explicit app off, even though an external rule says on.
  expect(resolveSkillPolicy('b', true, true, state).enabled).toBe(false);
  // No app choice: the external rule decides.
  expect(resolveSkillPolicy('c', true, false, state).enabled).toBe(false);
  expect(resolveSkillPolicy('c', true, true, state).enabled).toBe(true);
  // No app choice and no rule: default on.
  expect(resolveSkillPolicy('d', true, undefined, state).enabled).toBe(true);
});

it('resolves implicit invocation from the app choice, then the skill declaration', () => {
  const state = { ...emptySkillState(), implicit: { a: false, b: true } };
  expect(resolveSkillPolicy('a', true, undefined, state).implicit).toBe(false);
  expect(resolveSkillPolicy('b', false, undefined, state).implicit).toBe(true);
  expect(resolveSkillPolicy('c', false, undefined, state).implicit).toBe(false);
  expect(resolveSkillPolicy('c', true, undefined, state).implicit).toBe(true);
});

it('defaults implicit invocation off for packed skills that declare nothing', () => {
  // The caller passes the declaration; a pack skill with no agents/openai.yaml passes false.
  expect(resolveSkillPolicy('x', false, undefined, emptySkillState()).implicit).toBe(false);
});

it('serializes mutations and publishes only after the durable write', async () => {
  await mutateSkillState(state => ({ ...state, enabled: { ...state.enabled, a: false } }));
  await mutateSkillState(state => ({ ...state, implicit: { ...state.implicit, a: true } }));
  const stored = await readDurable<{ enabled: Record<string, boolean>; implicit: Record<string, boolean> }>('skills');
  expect(stored?.enabled).toEqual({ a: false });
  expect(stored?.implicit).toEqual({ a: true });
  expect(currentSkillState().enabled).toEqual({ a: false });
});

it('drops a mutation that returns an invalid state rather than writing it', async () => {
  await expect(mutateSkillState(() => ({ version: 3 } as never))).rejects.toThrow(/state/i);
  expect(await readDurable('skills')).toBeNull();
});

it('reads inherited object keys as absent choices, not as stored ones', () => {
  // `constructor` satisfies SKILL_ID_PATTERN, and a bare map lookup would find the inherited
  // Object constructor — bypassing both the external rule and the default, and returning a
  // function where SkillPolicy declares a boolean.
  const state = emptySkillState();
  expect(resolveSkillPolicy('constructor', false, false, state)).toEqual({ enabled: false, implicit: false });
  expect(resolveSkillPolicy('constructor', true, undefined, state)).toEqual({ enabled: true, implicit: true });
  const chosen = { ...emptySkillState(), enabled: { constructor: true }, implicit: { toString: false } };
  expect(resolveSkillPolicy('constructor', true, false, chosen).enabled).toBe(true);
  expect(resolveSkillPolicy('toString', true, undefined, chosen).implicit).toBe(false);
  // An inherited key that no list stores still resolves to booleans.
  for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const policy = resolveSkillPolicy(id, true, undefined, state);
    expect(typeof policy.enabled).toBe('boolean');
    expect(typeof policy.implicit).toBe('boolean');
  }
});

it('rejects a mutation carrying keys the state file never holds', async () => {
  await expect(mutateSkillState(() => ({ ...emptySkillState(), note: 'x' } as never)))
    .rejects.toThrow(/state/i);
  expect(await readDurable('skills')).toBeNull();
});

it('supersedes a failed write so the refused state cannot land later', async () => {
  await mutateSkillState(state => ({ ...state, enabled: { a: false } }));
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(mutateSkillState(state => ({ ...state, enabled: { ...state.enabled, b: true } })))
    .rejects.toThrow('disk unavailable');
  rename.mockRestore();
  // durable.ts retains the failed generation and retries it. The refusal must replace it with
  // the state that is still authoritative, or `b: true` would be written after being refused.
  await flushDurable();
  expect(await readDurable('skills')).toEqual({ version: 1, seeded: {}, enabled: { a: false }, implicit: {}, removed: [] });
  expect(currentSkillState().enabled).toEqual({ a: false });
});
