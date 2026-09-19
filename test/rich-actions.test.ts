import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDurableStore, readDurableStrict, resetDurableForTests, writeDurableNow
} from '../src/main/durable.js';
import {
  armRichAction, beginRichAction, electRichAction, finishRichAction,
  parseRichActionSnapshot, readRichActionStatus, resetRichActionsForTests,
  restoreRichActionLedger, type RichActionRecord
} from '../src/main/rich-actions.js';

const ID = '11111111-2222-4333-8444-555555555555';
const SECOND = '22222222-3333-4444-8555-666666666666';
const SESSION = '2026-09-19-aaaaaaaa';
const CONVERSATION = '33333333-4444-4555-8666-777777777777';
const PROVIDER = '44444444-5555-4666-8777-888888888888';

function action(phase: RichActionRecord['phase'] = 'intent'): RichActionRecord {
  const elected = !['intent', 'opening_spent'].includes(phase);
  return {
    id: ID, phase, createdAt: 1789776000000, claimOwner: phase === 'intent' ? null : 'a'.repeat(64),
    sessionId: SESSION, conversationId: CONVERSATION, bindingRevision: 3,
    messageId: 'assistant:turn:1', providerMessageId: PROVIDER, revision: 2,
    nodeId: 'node-choice', groupId: 'scene-choice', kind: 'select', value: 'Forest', expectedSelected: false,
    expectedGroupSelection: 'Coast', tabId: elected ? 42 : null,
    documentId: elected ? 'doc-1' : null, navigationEpoch: elected ? 5 : null,
    openingSpent: phase === 'opening_spent', resultDetail: null
  };
}

const snapshot = (...actions: RichActionRecord[]) => ({ version: 1 as const, actions, receipts: [] });
let directory: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  resetRichActionsForTests();
  resetDurableForTests();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = null;
});

async function storage(): Promise<string> {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-rich-actions-'));
  initDurableStore(directory);
  await fs.mkdir(path.join(directory, 'state'));
  return path.join(directory, 'state', 'rich-actions.json');
}

describe('inert native-action custody parser', () => {
  it('accepts one strictly detached version-one record without retaining input object identities', () => {
    const original = snapshot(action());
    const parsed = parseRichActionSnapshot(original);
    expect(parsed).toEqual(original);
    expect(parsed).not.toBe(original);
    expect(parsed?.actions).not.toBe(original.actions);
    expect(parsed?.actions[0]).not.toBe(original.actions[0]);
    original.actions[0]!.value = 'changed after parse';
    expect(parsed?.actions[0]?.value).toBe('Forest');
  });

  it('quarantines unsupported versions, extra keys, duplicate ids/receipts and mismatched terminal receipts', () => {
    expect(parseRichActionSnapshot({ ...snapshot(), version: 2 })).toBeNull();
    expect(parseRichActionSnapshot({ ...snapshot(), bearer: 'forbidden' })).toBeNull();
    expect(parseRichActionSnapshot(snapshot(action(), { ...action(), id: ID }))).toBeNull();
    expect(parseRichActionSnapshot(snapshot({ ...action(), phase: 'may_have_dispatched' }))).toBeNull();
    expect(parseRichActionSnapshot(snapshot({ ...action(), claimOwner: 'raw-bearer' }))).toBeNull();
    expect(parseRichActionSnapshot(snapshot({ ...action(), groupId: '' }))).toBeNull();
    const missingGroup = { ...action() } as Record<string, unknown>;
    delete missingGroup.groupId;
    expect(parseRichActionSnapshot({ version: 1, actions: [missingGroup], receipts: [] })).toBeNull();
    expect(parseRichActionSnapshot(snapshot({ ...action(), documentId: 'foreign' }))).toBeNull();
    expect(parseRichActionSnapshot(snapshot(action(), {
      ...action(), id: SECOND, nodeId: 'node-other', groupId: 'scene-choice'
    }))).toBeNull(); // Second pending action cannot claim the same form/group.
    expect(parseRichActionSnapshot(snapshot(action(), {
      ...action(), id: SECOND, nodeId: 'node-other', groupId: 'other-form'
    }))).toBeTruthy();
    expect(parseRichActionSnapshot({ version: 1, actions: [action()], receipts: [
      { id: ID, state: 'observed', detail: 'selected' }
    ] })).toBeNull();
    const retired = { ...action('elected'), phase: 'retired' as const, resultDetail: 'selected' };
    const receipt = { id: ID, state: 'observed', detail: 'selected' };
    expect(parseRichActionSnapshot({ version: 1, actions: [retired], receipts: [receipt] })).toBeTruthy();
    expect(parseRichActionSnapshot({ version: 1, actions: [
      { ...action('opening_spent'), phase: 'retired', resultDetail: 'selected' }
    ], receipts: [receipt] })).toBeNull(); // No elected document could have produced an observed postcondition.
    expect(parseRichActionSnapshot({ version: 1, actions: [retired], receipts: [receipt, receipt] })).toBeNull();
    expect(parseRichActionSnapshot({ version: 1, actions: [retired], receipts: [{ ...receipt, id: SECOND }] })).toBeNull();
    expect(parseRichActionSnapshot({ version: 1, actions: [retired], receipts: [{ ...receipt, detail: 'other' }] })).toBeNull();
  });

  it('never evaluates accessors or accepts sparse, oversized or prototype-poisoned arrays', () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({ ...action() }, 'value', {
      enumerable: true, get() { getterCalls++; throw new Error('must not run'); }
    });
    expect(parseRichActionSnapshot(snapshot(hostile))).toBeNull();
    expect(getterCalls).toBe(0);
    const sparse: RichActionRecord[] = new Array(2);
    sparse[1] = action();
    expect(parseRichActionSnapshot({ version: 1, actions: sparse, receipts: [] })).toBeNull();
    expect(parseRichActionSnapshot({ version: 1, actions: new Array(129).fill(action()), receipts: [] })).toBeNull();
    expect(parseRichActionSnapshot(Object.assign(Object.create({ inherited: true }), snapshot(action())))).toBeNull();
  });
});

describe('inert durable status, recovery and denial', () => {
  it('refuses to treat an uninitialized or missing state directory as a fresh ledger', async () => {
    expect(await restoreRichActionLedger()).toBe('unavailable');
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-rich-actions-'));
    initDurableStore(directory);
    expect(await restoreRichActionLedger()).toBe('quarantined');
    await fs.mkdir(path.join(directory, 'state'));
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'unavailable' });
    resetRichActionsForTests(); // A new process may observe the now-healthy empty root.
    expect(await restoreRichActionLedger()).toBe('absent');
  });

  it('never admits or writes an intent, election, arm or result from production entrypoints', async () => {
    const file = await storage();
    expect(await restoreRichActionLedger()).toBe('absent');
    const before = await fs.readdir(path.dirname(file));
    expect((await beginRichAction(action())).state).toBe('unavailable');
    expect(await electRichAction(ID, 42, 'doc-1', 5)).toBe(false);
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
    expect((await finishRichAction(ID, 'observed', 'claimed selection')).state).toBe('unavailable');
    expect(await fs.readdir(path.dirname(file))).toEqual(before);
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'unavailable' });
  });

  it('reports only the exact stored session/action; restored dispatched state is unknown, never rearmed', async () => {
    await storage();
    await writeDurableNow('rich-actions', snapshot(action()));
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('valid');
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ id: ID, state: 'pending' });
    expect(await readRichActionStatus('2026-09-19-bbbbbbbb', ID)).toMatchObject({ state: 'unavailable' });
    expect(await readRichActionStatus(SESSION, SECOND)).toMatchObject({ state: 'unavailable' });
    await writeDurableNow('rich-actions', snapshot(action('may_have_dispatched')));
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ id: ID, state: 'unknown' });
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
  });

  it('reads a valid retired receipt without fabricating success, and never reports foreign ownership', async () => {
    await storage();
    const retired = { ...action('elected'), phase: 'retired' as const, resultDetail: 'native selection observed' };
    await writeDurableNow('rich-actions', { version: 1, actions: [retired], receipts: [
      { id: ID, state: 'observed', detail: 'native selection observed' }
    ] });
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, ID)).toEqual({ id: ID, state: 'observed', detail: 'native selection observed' });
    expect(await readRichActionStatus('2026-09-19-bbbbbbbb', ID)).toMatchObject({ state: 'unavailable' });
  });

  it('quarantines corrupt/unreadable/unsupported durable data monotonically without overwriting its bytes', async () => {
    const file = await storage();
    await fs.writeFile(file, '{corrupt');
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'unavailable' });
    expect(await fs.readFile(file, 'utf8')).toBe('{corrupt');
    await writeDurableNow('rich-actions', snapshot(action()));
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'unavailable' });
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    await fs.writeFile(file, JSON.stringify({ ...snapshot(action()), version: 2 }));
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await fs.readFile(file, 'utf8')).toContain('"version":2');
  });

  it('does not publish a failed synthetic disk checkpoint or return arm authority after recovery', async () => {
    await storage();
    await writeDurableNow('rich-actions', snapshot(action()));
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk refused checkpoint'));
    await expect(writeDurableNow('rich-actions', snapshot(action('may_have_dispatched'))))
      .rejects.toThrow('disk refused checkpoint');
    rename.mockRestore();
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    resetDurableForTests();
    resetRichActionsForTests();
    initDurableStore(directory!);
    expect(await readDurableStrict('rich-actions')).toMatchObject({ kind: 'valid' });
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
  });
});
