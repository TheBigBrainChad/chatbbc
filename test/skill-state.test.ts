import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
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
afterEach(async () => { resetDurableForTests(); await removeTempDir(root); });

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
