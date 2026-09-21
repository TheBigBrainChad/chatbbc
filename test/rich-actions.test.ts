import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, getConfig, getRecordingRevision, initConfigPath, pendingRecordingOffDecision,
  recordingGenerationGrant, saveConfig, updateConfig } from '../src/main/config.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../src/main/session/blocked-chats.js';
import { createSession, initSessionStore, rebindSession, resetSessionStoreForTests,
  upsertMessageEvent, upsertRichMessage } from '../src/main/session/store.js';
import { parseRichResponse } from '../src/shared/rich-response.js';
import {
  initDurableStore, readDurableStrict, resetDurableForTests, writeDurableNow
} from '../src/main/durable.js';
import {
  armRichAction, beginRichAction, electRichAction, finishRichAction,
  parseRichActionSnapshot, readRichActionStatus, reduceInertRichActionSnapshot, resetRichActionsForTests,
  restoreRichActionLedger, reconcileInertRichAction, checkpointInertRichRetry,
  parseRichRetryLedgerSnapshot, reduceInertRichRetrySnapshot,
  type RichActionRecord, type RichRetryRecord
} from '../src/main/rich-actions.js';

const ID = '11111111-2222-4333-8444-555555555555';
const SECOND = '22222222-3333-4444-8555-666666666666';
const SESSION = '2026-09-19-aaaaaaaa';
const CONVERSATION = '33333333-4444-4555-8666-777777777777';
const PROVIDER = '44444444-5555-4666-8777-888888888888';
const OTHER_CONVERSATION = '55555555-6666-4777-8888-999999999999';

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
const OWNER = 'b'.repeat(64);
const FOREIGN = 'c'.repeat(64);
function simulated(before: unknown, transition: Parameters<typeof reduceInertRichActionSnapshot>[1]) {
  const result = reduceInertRichActionSnapshot(before, transition);
  expect(result.kind).toBe('changed');
  if (result.kind !== 'changed') throw new Error('Expected one inert simulation transition');
  expect(parseRichActionSnapshot(result.snapshot)).toEqual(result.snapshot);
  return result.snapshot;
}
let directory: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  resetBlockedChatsForTests();
  resetSessionStoreForTests();
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

/** Real canonical assistant shard and actual v1 disk row; never a production user-click admission. */
async function canonicalClaim(phase: 'intent' | 'opening_spent' | 'elected' | 'may_have_dispatched' = 'intent',
  claimed = true): Promise<{ file: string; row: RichActionRecord; changeRich: () => Promise<void> }> {
  const file = await storage();
  initConfigPath(directory!);
  initSessionStore(directory!);
  await updateConfig(() => defaultConfig()); // An explicit On transition, even after another test's Off.
  const session = await createSession({ reservedId: SESSION, title: 'test-only saved control', conversationId: CONVERSATION });
  const answer = {
    kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
    messageId: 'assistant:turn:1', message: { text: 'Choose', chars: 6, truncated: false },
    providerMessageId: PROVIDER, turnId: 'turn-1', state: 'final' as const, final: true, goalEligible: true
  };
  await upsertMessageEvent(session.id, answer);
  const putRich = async (accessibleText: string): Promise<void> => {
    const rich = parseRichResponse({
      version: 1, status: 'available', reason: null, conversationId: CONVERSATION,
      messageId: answer.messageId, providerMessageId: PROVIDER, revision: 99,
      accessibleText, nodes: [{ id: 'form', kind: 'group', layout: 'card', children: [
        { id: 'node-choice', kind: 'control', control: 'choice', label: 'Forest', groupId: 'scene-choice',
          value: 'Forest', selected: false, disabled: false, children: [] },
        { id: 'coast', kind: 'control', control: 'choice', label: 'Coast', groupId: 'scene-choice',
          value: 'Coast', selected: true, disabled: false, children: [] },
        { id: 'continue', kind: 'control', control: 'continue', label: 'Continue', groupId: 'scene-choice',
          value: null, selected: false, disabled: false, children: [] }
      ] }]
    });
    if (!rich) throw new Error('Invalid synthetic canonical rich fixture');
    expect(await upsertRichMessage(session.id, answer.messageId, rich, {
      conversationId: CONVERSATION, bindingRevision: 0, documentId: 'source-doc', navigationEpoch: 1
    })).toBe('stored');
  };
  await putRich('Choose');
  const row: RichActionRecord = {
    ...action(phase), sessionId: session.id, bindingRevision: 0, revision: 1,
    claimOwner: claimed ? OWNER : null,
    ...(phase === 'intent' ? { openingSpent: false } : {})
  };
  await writeDurableNow('rich-actions', snapshot(row));
  resetRichActionsForTests();
  expect(await restoreRichActionLedger()).toBe('valid');
  return { file, row, changeRich: async () => putRich('Revised options') };
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
    expect(parseRichActionSnapshot({ ...snapshot(), version: 3 })).toBeNull();
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

describe('synthetic v1 pure transitions only (NOT accepted clicks or native authority)', () => {
  it('copies every pre-dispatch phase through one irreversible cut without mutating the input', () => {
    const original = snapshot(action());
    const claimed = simulated(original, { kind: 'claim', expected: action(), owner: OWNER });
    expect(original.actions[0]?.claimOwner).toBeNull();
    expect(claimed.actions[0]).toMatchObject({ phase: 'intent', claimOwner: OWNER, openingSpent: false });
    const opened = simulated(claimed, { kind: 'opening_spent', expected: claimed.actions[0]!, owner: OWNER });
    expect(opened.actions[0]).toMatchObject({ phase: 'opening_spent', openingSpent: true, tabId: null });
    const elected = simulated(opened, { kind: 'elect', expected: opened.actions[0]!, owner: OWNER,
      tabId: 42, documentId: 'doc-1', navigationEpoch: 5 });
    expect(elected.actions[0]).toMatchObject({ phase: 'elected', openingSpent: true,
      tabId: 42, documentId: 'doc-1', navigationEpoch: 5 });
    const cut = simulated(elected, { kind: 'may_have_dispatched', expected: elected.actions[0]!, owner: OWNER });
    expect(cut.actions[0]?.phase).toBe('may_have_dispatched');
    expect(cut.receipts).toEqual([]);
    expect(elected.actions[0]?.phase).toBe('elected');
    for (const transition of [
      { kind: 'may_have_dispatched', expected: cut.actions[0]!, owner: OWNER },
      { kind: 'opening_spent', expected: cut.actions[0]!, owner: OWNER },
      { kind: 'retire', expected: cut.actions[0]!, owner: OWNER, outcome: 'changed', detail: 'stale' }
    ] as const) expect(reduceInertRichActionSnapshot(cut, transition)).toEqual({ kind: 'refused' });
  });

  it('can elect an already existing exact tab without spending opening authority', () => {
    const claimed = simulated(snapshot(action()), { kind: 'claim', expected: action(), owner: OWNER });
    const elected = simulated(claimed, { kind: 'elect', expected: claimed.actions[0]!, owner: OWNER,
      tabId: 99, documentId: 'known-doc', navigationEpoch: 8 });
    expect(elected.actions[0]).toMatchObject({ phase: 'elected', openingSpent: false, tabId: 99 });
    expect(reduceInertRichActionSnapshot(elected, { kind: 'elect', expected: elected.actions[0]!,
      owner: OWNER, tabId: 100, documentId: 'other-doc', navigationEpoch: 9 })).toEqual({ kind: 'refused' });
  });

  it('retires only an already claimed pre-dispatch record and atomically includes its matching receipt', () => {
    const initial = snapshot(action());
    expect(reduceInertRichActionSnapshot(initial, { kind: 'retire', expected: action(),
      owner: OWNER, outcome: 'unavailable', detail: 'Unclaimed' })).toEqual({ kind: 'refused' });
    const claimed = simulated(initial, { kind: 'claim', expected: action(), owner: OWNER });
    const command = { kind: 'retire' as const, expected: claimed.actions[0]!, owner: OWNER,
      outcome: 'changed' as const, detail: 'Exact source changed' };
    const retired = simulated(claimed, command);
    expect(retired.actions[0]).toMatchObject({ phase: 'retired', claimOwner: OWNER,
      resultDetail: 'Exact source changed', tabId: null });
    expect(retired.receipts).toEqual([{ id: ID, state: 'changed', detail: 'Exact source changed' }]);
    const identical = reduceInertRichActionSnapshot(retired, command);
    expect(identical).toEqual({ kind: 'unchanged', snapshot: retired });
    expect(reduceInertRichActionSnapshot(retired, { ...command, detail: 'Conflicting result' }))
      .toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(retired, { ...command, owner: FOREIGN }))
      .toEqual({ kind: 'refused' });
    expect(claimed.receipts).toEqual([]);
  });

  it('rejects foreign claimants, stale expected epochs/identities, malformed transitions and invented receipts', () => {
    const initial = snapshot(action());
    expect(reduceInertRichActionSnapshot(initial, { kind: 'claim', expected: action(), owner: 'raw-secret' }))
      .toEqual({ kind: 'refused' });
    const claimed = simulated(initial, { kind: 'claim', expected: action(), owner: OWNER });
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'claim', expected: action(), owner: FOREIGN }))
      .toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'opening_spent', expected: claimed.actions[0]!, owner: FOREIGN }))
      .toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'opening_spent',
      expected: { ...claimed.actions[0]!, bindingRevision: 4 }, owner: OWNER })).toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'elect', expected: claimed.actions[0]!,
      owner: OWNER, tabId: -1, documentId: 'doc-1', navigationEpoch: 5 })).toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'retire', expected: claimed.actions[0]!,
      owner: OWNER, outcome: 'observed' as 'changed', detail: 'Invented postcondition' })).toEqual({ kind: 'refused' });
    let getterCalls = 0;
    const hostile = Object.defineProperty({ kind: 'opening_spent', expected: claimed.actions[0]!, owner: OWNER },
      'owner', { enumerable: true, get() { getterCalls++; throw new Error('do not execute'); } });
    expect(reduceInertRichActionSnapshot(claimed, hostile)).toEqual({ kind: 'refused' });
    expect(getterCalls).toBe(0);
    expect(reduceInertRichActionSnapshot(claimed, { kind: 'opening_spent', expected: claimed.actions[0]!,
      owner: OWNER, browserUrl: 'https://hostile.example' } as Parameters<typeof reduceInertRichActionSnapshot>[1]))
      .toEqual({ kind: 'refused' });
  });

  it('rejects malformed, duplicate, full and foreign snapshots instead of allocating or evicting records', () => {
    const initial = snapshot(action());
    const command = { kind: 'claim' as const, expected: action(), owner: OWNER };
    expect(reduceInertRichActionSnapshot(snapshot(action(), action()), command)).toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot({ ...initial, version: 3 }, command)).toEqual({ kind: 'refused' });
    const full = snapshot(...Array.from({ length: 128 }, (_, index) => ({
      ...action(), id: `${String(index).padStart(8, '0')}-2222-4333-8444-555555555555`,
      groupId: `group-${index}`
    })));
    expect(parseRichActionSnapshot(full)?.actions).toHaveLength(128);
    expect(simulated(full, { kind: 'claim', expected: full.actions[0]!, owner: OWNER }).actions).toHaveLength(128);
    expect(reduceInertRichActionSnapshot(full, { kind: 'claim',
      expected: { ...action(), id: SECOND }, owner: OWNER })).toEqual({ kind: 'refused' });
    expect(reduceInertRichActionSnapshot(initial, { kind: 'claim',
      expected: { ...action(), id: SECOND }, owner: OWNER })).toEqual({ kind: 'refused' });
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
    await fs.writeFile(file, JSON.stringify({ ...snapshot(action()), version: 3 }));
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await fs.readFile(file, 'utf8')).toContain('"version":3');
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

  it('cold-restores each synthetic checkpoint without granting native input or fabricating a receipt', async () => {
    const file = await storage();
    const states: Array<{ ledger: ReturnType<typeof snapshot>; status: RichActionRecord['phase'] }> = [
      { ledger: snapshot(action()), status: 'intent' },
      { ledger: snapshot({ ...action(), claimOwner: OWNER }), status: 'intent' },
      { ledger: snapshot({ ...action('opening_spent'), claimOwner: OWNER }), status: 'opening_spent' },
      { ledger: snapshot({ ...action('elected'), claimOwner: OWNER }), status: 'elected' },
      { ledger: snapshot({ ...action('may_have_dispatched'), claimOwner: OWNER }), status: 'may_have_dispatched' }
    ];
    for (const state of states) {
      await writeDurableNow('rich-actions', state.ledger);
      resetDurableForTests(); // Deliberately simulate only a settled-disk new process.
      resetRichActionsForTests();
      initDurableStore(directory!);
      expect(await readDurableStrict('rich-actions')).toMatchObject({ kind: 'valid' });
      expect(await restoreRichActionLedger()).toBe('valid');
      const result = await readRichActionStatus(SESSION, ID);
      expect(result).toMatchObject({ id: ID,
        state: state.status === 'may_have_dispatched' ? 'unknown' : 'pending' });
      expect(await beginRichAction(action())).toMatchObject({ state: 'unavailable' });
      expect(await electRichAction(ID, 42, 'doc-1', 5)).toBe(false);
      expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
      expect(await finishRichAction(ID, 'observed', 'invented')).toMatchObject({ state: 'unavailable' });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(state.ledger);
    }
  });

  it('treats a rename-then-error cut as an ambiguous disk result and never retries a native click', async () => {
    const file = await storage();
    const before = snapshot({ ...action('elected'), claimOwner: OWNER });
    const irreversible = snapshot({ ...action('may_have_dispatched'), claimOwner: OWNER });
    await writeDurableNow('rich-actions', before);
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    const rename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to); // The physical commit succeeds; only its ACK is lost.
      throw new Error('lost checkpoint acknowledgment');
    });
    await expect(writeDurableNow('rich-actions', irreversible)).rejects.toThrow('lost checkpoint acknowledgment');
    fault.mockRestore();
    // An ambiguous commit must not be presented optimistically by the old reader.
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'pending' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(irreversible);
    resetDurableForTests(); // Only now is the process's scheduled retry discarded.
    resetRichActionsForTests();
    initDurableStore(directory!);
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'unknown', id: ID });
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
    expect(await beginRichAction(action())).toMatchObject({ state: 'unavailable' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(irreversible);
  });
});

describe('main-private claimed pre-dispatch reconciliation (no action authority)', () => {
  it('durably retires a claimed action when the exact physical rich revision changes', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toEqual({
      id: ID, state: 'changed', detail: 'Canonical rich control changed'
    });
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(persisted.actions[0]).toMatchObject({ phase: 'retired', claimOwner: OWNER,
      resultDetail: 'Canonical rich control changed' });
    expect(persisted.receipts).toEqual([{ id: ID, state: 'changed', detail: 'Canonical rich control changed' }]);
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toEqual({
      id: ID, state: 'changed', detail: 'Canonical rich control changed'
    });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(persisted);
    expect(await beginRichAction(row)).toMatchObject({ state: 'unavailable' });
    expect(await armRichAction(row.id, 'doc-1', 5)).toBe(false);
  });

  it('retires an existing claim on Recording Off without treating a later On as fresh authority', async () => {
    const { file, row } = await canonicalClaim();
    const config = getConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({
      id: ID, state: 'unavailable'
    });
    const physicallyRetired = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(physicallyRetired.actions[0]?.phase).toBe('retired');
    await updateConfig(() => defaultConfig());
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toEqual(physicallyRetired.receipts[0]);
  });

  it('does not retire for a provisional Recording Off whose config rename fails', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    const originalLedger = await fs.readFile(file, 'utf8');
    const actualRename = fs.rename.bind(fs);
    let enterRename!: () => void;
    let failRename!: () => void;
    const entered = new Promise<void>(resolve => { enterRename = resolve; });
    const held = new Promise<void>(resolve => { failRename = resolve; });
    const configFile = path.join(directory!, 'config.json');
    const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === configFile) {
        enterRename();
        await held;
        throw new Error('config Off rename failed');
      }
      return actualRename(from, to);
    }) as typeof fs.rename);
    const off = updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: false } }));
    try {
      await entered;
      expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
      expect(await fs.readFile(file, 'utf8')).toBe(originalLedger);
      expect(await readRichActionStatus(row.sessionId, row.id)).toMatchObject({ state: 'pending' });
      expect(await armRichAction(row.id, 'doc-1', 5)).toBe(false);
    } finally {
      failRename();
      await expect(off).rejects.toThrow('config Off rename failed');
      spy.mockRestore();
    }
    expect(getConfig().sessions.record).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(originalLedger);
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ id: ID, state: 'changed' });
  });

  it('defers provisional Off arriving inside the second physical source verification', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    const originalLedger = await fs.readFile(file, 'utf8');
    let enterSecond!: () => void;
    let releaseSecond!: () => void;
    const secondReached = new Promise<void>(resolve => { enterSecond = resolve; });
    const heldSecond = new Promise<void>(resolve => { releaseSecond = resolve; });
    const actualOpendir = fs.opendir.bind(fs);
    let sourceReads = 0;
    const sourceSpy = vi.spyOn(fs, 'opendir').mockImplementation((async (target, options) => {
      if (String(target).endsWith(path.join(row.sessionId, 'messages')) && ++sourceReads === 2) {
        enterSecond();
        await heldSecond;
      }
      return actualOpendir(target, options);
    }) as typeof fs.opendir);
    let enterRename!: () => void;
    let failRename!: () => void;
    const renameReached = new Promise<void>(resolve => { enterRename = resolve; });
    const heldRename = new Promise<void>(resolve => { failRename = resolve; });
    const actualRename = fs.rename.bind(fs);
    const configSpy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === path.join(directory!, 'config.json')) {
        enterRename();
        await heldRename;
        throw new Error('late config Off failed');
      }
      return actualRename(from, to);
    }) as typeof fs.rename);
    const reconcile = reconcileInertRichAction(row.sessionId, row.id);
    let off: Promise<unknown> | null = null;
    try {
      await secondReached;
      off = updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: false } }));
      // Off's session-drain waits for this queued shard reader: it cannot reach
      // config rename until we release it. Its provisional gate is already live.
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingRecordingOffDecision()).not.toBeNull();
      releaseSecond();
      await renameReached;
      expect(await reconcile).toMatchObject({ state: 'unavailable' });
      expect(await fs.readFile(file, 'utf8')).toBe(originalLedger);
    } finally {
      releaseSecond();
      failRename();
      if (off) await expect(off).rejects.toThrow('late config Off failed');
      configSpy.mockRestore();
      sourceSpy.mockRestore();
    }
    expect(getConfig().sessions.record).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe(originalLedger);
  });

  it('refuses to overwrite a physical ledger replaced during the second awaited canonical shard read', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    const replacement = '{"version":2,"owner":"independent newer physical ledger"}';
    const originalOpendir = fs.opendir.bind(fs);
    let sourceReads = 0;
    const spy = vi.spyOn(fs, 'opendir').mockImplementation((async (target, options) => {
      if (String(target).endsWith(path.join(row.sessionId, 'messages')) && ++sourceReads === 2) {
        await fs.writeFile(file, replacement);
      }
      return originalOpendir(target, options);
    }) as typeof fs.opendir);
    try {
      expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
      expect(sourceReads).toBe(2);
      expect(await fs.readFile(file, 'utf8')).toBe(replacement);
      expect(await restoreRichActionLedger()).toBe('quarantined');
      expect(await armRichAction(row.id, 'doc-1', 5)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('retires a blocked source while preserving its original claimed owner and refusing browser dispatch', async () => {
    const { file, row } = await canonicalClaim('opening_spent');
    setChatBlocked(CONVERSATION, true);
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ id: ID, state: 'unavailable' });
    const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(persisted.actions[0]).toMatchObject({ phase: 'retired', claimOwner: OWNER, openingSpent: true });
    expect(persisted.receipts).toHaveLength(1);
    expect(await electRichAction(ID, 42, 'doc-1', 5)).toBe(false);
  });

  it('retires the original binding across A→B→A instead of trusting the matching conversation id', async () => {
    const { file, row } = await canonicalClaim();
    expect(await rebindSession(row.sessionId, CONVERSATION, OTHER_CONVERSATION)).toBe(true);
    expect(await rebindSession(row.sessionId, OTHER_CONVERSATION, CONVERSATION)).toBe(true);
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ id: ID, state: 'unavailable' });
    const retired = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(retired.actions[0]).toMatchObject({ phase: 'retired', bindingRevision: 0 });
    expect(retired.receipts).toHaveLength(1);
  });

  it('preserves unclaimed and dispatched records without forging a claim or a postcondition', async () => {
    const unclaimed = await canonicalClaim('intent', false);
    await unclaimed.changeRich();
    expect(await reconcileInertRichAction(unclaimed.row.sessionId, unclaimed.row.id)).toMatchObject({
      state: 'unavailable'
    });
    expect(JSON.parse(await fs.readFile(unclaimed.file, 'utf8'))).toEqual(snapshot(unclaimed.row));
    // A completed write is required before resetting the simulated disk owner.
    await writeDurableNow('rich-actions', snapshot({ ...action('may_have_dispatched'),
      sessionId: unclaimed.row.sessionId, bindingRevision: 0, revision: 1, claimOwner: OWNER }));
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('valid');
    expect(await reconcileInertRichAction(unclaimed.row.sessionId, ID)).toMatchObject({
      id: ID, state: 'unknown'
    });
    expect(JSON.parse(await fs.readFile(unclaimed.file, 'utf8')).receipts).toEqual([]);
  });

  it('quarantines a failed pre-rename checkpoint without optimistic receipt or a later grant', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('reconciliation write refused'));
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
    rename.mockRestore();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(snapshot(row));
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
  });

  it('does not publish a failed retirement later through the durable writer retry timer', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    vi.useFakeTimers();
    try {
      const rejected = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failed terminal checkpoint'));
      expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
      rejected.mockRestore();
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(snapshot(row));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(snapshot(row));
      expect(await restoreRichActionLedger()).toBe('quarantined');
      expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never replays an ambiguous rename after an unrelated newer physical state appears', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    vi.useFakeTimers();
    try {
      const physicalRename = fs.rename.bind(fs);
      const lostAck = vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
        await physicalRename(source, target);
        throw new Error('ambiguous committed retirement');
      });
      expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
      lostAck.mockRestore();
      expect(await restoreRichActionLedger()).toBe('quarantined');
      const laterState = '{"version":2,"later":"independent state"}';
      await fs.writeFile(file, laterState);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await fs.readFile(file, 'utf8')).toBe(laterState);
      expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quarantines an ambiguous rename-then-error, even if a full terminal snapshot physically landed', async () => {
    const { file, row, changeRich } = await canonicalClaim();
    await changeRich();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
      await originalRename(source, target);
      throw new Error('lost retirement acknowledgment');
    });
    expect(await reconcileInertRichAction(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
    rename.mockRestore();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(row.sessionId, row.id)).toMatchObject({ state: 'unavailable' });
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.actions[0]).toMatchObject({ phase: 'retired', claimOwner: OWNER });
    expect(disk.receipts).toHaveLength(1);
    expect(await armRichAction(ID, 'doc-1', 5)).toBe(false);
    // A real fresh process can read the physical terminal record, never retry the action.
    resetDurableForTests();
    resetRichActionsForTests();
    initDurableStore(directory!);
    expect(await readRichActionStatus(row.sessionId, row.id)).toEqual(disk.receipts[0]);
  });
});

// These fixtures exercise storage transitions, NOT an authenticated user gesture,
// browser permission, page pixel receipt or successful capture. No execution route exists.
function retry(phase: RichRetryRecord['phase'] = 'intent'): RichRetryRecord {
  const elected = ['elected', 'dispatch_spent'].includes(phase);
  return {
    kind: 'retry_capture', id: SECOND, phase, createdAt: 1789776000000,
    claimOwner: phase === 'intent' ? null : OWNER,
    sessionId: SESSION, conversationId: CONVERSATION, bindingRevision: 3,
    messageId: 'assistant:turn:1', providerMessageId: PROVIDER,
    richRevision: 2, presentationSeq: 17, mediaId: 'media-n-1', nodeId: 'n-1', source: 'page',
    originDocumentId: 'original-doc', originNavigationEpoch: 4, selectionGeneration: 9,
    recordingRevision: 3, recordingGeneration: 'a'.repeat(43), cleanupEpoch: 5,
    removalIncarnation: null, confirmRemoved: false,
    tabId: elected ? 42 : null, documentId: elected ? 'current-doc' : null,
    documentGeneration: elected ? 2 : null, navigationEpoch: elected ? 8 : null,
    openingSpent: phase === 'opening_spent', dispatchSpent: phase === 'dispatch_spent',
    resultDetail: null
  };
}

const v2 = (...actions: Array<RichActionRecord | RichRetryRecord>) =>
  ({ version: 2 as const, actions, receipts: [] });

function retryStep(before: unknown, transition: unknown) {
  const result = reduceInertRichRetrySnapshot(before, transition);
  expect(result.kind).toBe('changed');
  if (result.kind !== 'changed') throw new Error('Expected a state-only retry transition');
  expect(parseRichRetryLedgerSnapshot(result.snapshot)).toEqual(result.snapshot);
  return result.snapshot;
}

async function retryRoot(): Promise<string> {
  const file = await storage();
  initConfigPath(directory!);
  await updateConfig(() => defaultConfig());
  return file;
}

function freshRetry(): RichRetryRecord {
  const generation = recordingGenerationGrant();
  if (!generation) throw new Error('Test setup did not establish a Recording On generation');
  return { ...retry(), recordingRevision: getRecordingRevision(), recordingGeneration: generation };
}

describe('Task14 Cut1: strictly inert PAGE retry v2 schema', () => {
  it('never treats a spent opening or dispatch as a proven negative or releases its exact slot', () => {
    const spentRows: RichRetryRecord[] = [
      retry('opening_spent'),
      { ...retry('elected'), openingSpent: true },
      retry('dispatch_spent'),
      { ...retry('dispatch_spent'), openingSpent: true }
    ];
    for (const spent of spentRows) {
      for (const outcome of ['changed', 'unavailable'] as const) {
        const negative = { ...spent, phase: 'retired' as const, resultDetail: 'No proven negative' };
        expect(parseRichRetryLedgerSnapshot({ version: 2, actions: [negative], receipts: [
          { id: SECOND, state: outcome, detail: 'No proven negative' }
        ] })).toBeNull();
        expect(reduceInertRichRetrySnapshot(v2(spent), {
          kind: 'retire', expected: spent, owner: OWNER, outcome, detail: 'No proven negative'
        })).toEqual({ kind: 'refused' });
      }
      const unknown = retryStep(v2(spent), {
        kind: 'retire', expected: spent, owner: OWNER, outcome: 'unknown', detail: 'Unconfirmed'
      });
      expect(reduceInertRichRetrySnapshot(unknown, { kind: 'create', record: {
        ...retry(), id: '66666666-2222-4333-8444-555555555555'
      } })).toEqual({ kind: 'refused' });
    }
    const unspent = { ...retry(), claimOwner: OWNER };
    for (const outcome of ['changed', 'unavailable'] as const) {
      expect(retryStep(v2(unspent), { kind: 'retire', expected: unspent,
        owner: OWNER, outcome, detail: 'Pre-opening failure' }).receipts[0]?.state).toBe(outcome);
    }
  });

  it('quarantines a forged v2 retry observed receipt on cold restore but preserves legacy control observed', async () => {
    const file = await storage();
    const spent = retry('dispatch_spent');
    const fake = { version: 2, actions: [{ ...spent, phase: 'retired', resultDetail: 'Pixels claimed' }],
      receipts: [{ id: SECOND, state: 'observed', detail: 'Pixels claimed' }] };
    expect(parseRichRetryLedgerSnapshot(fake)).toBeNull();
    await writeDurableNow('rich-actions', fake);
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await readRichActionStatus(SESSION, SECOND)).toMatchObject({ state: 'unavailable' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(fake);
    const control = { ...action('elected'), phase: 'retired' as const, resultDetail: 'Old control observed' };
    await writeDurableNow('rich-actions', { version: 2, actions: [control], receipts: [
      { id: ID, state: 'observed', detail: 'Old control observed' }
    ] });
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('valid');
    expect(await readRichActionStatus(SESSION, ID)).toMatchObject({ state: 'observed' });
  });

  it('preserves exact valid v1 controls and receipts in a v2 union, without migrating a read', async () => {
    const file = await storage();
    const retired = { ...action('elected'), phase: 'retired' as const, resultDetail: 'old verified receipt' };
    const old = { version: 1, actions: [retired, { ...action('may_have_dispatched'), id: '77777777-2222-4333-8444-555555555555', groupId: 'other' }],
      receipts: [{ id: ID, state: 'observed', detail: 'old verified receipt' }] };
    await writeDurableNow('rich-actions', old);
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('valid');
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(old));
    expect(await readRichActionStatus(SESSION, old.actions[1]!.id)).toMatchObject({ state: 'unknown' });
    const migrated = retryStep(old, { kind: 'create', record: retry() });
    expect(migrated).toMatchObject({ version: 2, actions: [retired, old.actions[1], retry()], receipts: old.receipts });
    expect(parseRichRetryLedgerSnapshot(migrated)).toEqual(migrated);
    expect(parseRichActionSnapshot(migrated)).toBeNull();
    expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(old));
  });

  it('rejects ambiguous PAGE owners, duplicate exact slots and malformed or mixed v2 rows without invoking getters', () => {
    const first = retry();
    expect(parseRichRetryLedgerSnapshot(v2(first))).toEqual(v2(first));
    expect(parseRichRetryLedgerSnapshot(v2(first, { ...first, id: '66666666-2222-4333-8444-555555555555' }))).toBeNull();
    expect(parseRichRetryLedgerSnapshot(v2(first, { ...first, id: ID, mediaId: 'media-n-2', nodeId: 'n-2' }))).toBeTruthy();
    for (const bad of [
      { ...first, source: 'native' }, { ...first, value: 'Generate' },
      { ...first, mediaId: 'another' }, { ...first, confirmRemoved: true },
      { ...first, removalIncarnation: ID }, { ...first, recordingGeneration: 'short' },
      { ...first, phase: 'dispatch_spent', dispatchSpent: true },
      { ...first, openingSpent: true }, { ...first, nodeId: 'n-2' },
      { ...first, originDocumentId: '' }, { ...first, selectionGeneration: -1 }
    ]) expect(parseRichRetryLedgerSnapshot(v2(bad as RichRetryRecord))).toBeNull();
    let getters = 0;
    const hostile = Object.defineProperty({ ...first }, 'mediaId', { enumerable: true,
      get() { getters++; throw Error('must not evaluate'); } });
    expect(parseRichRetryLedgerSnapshot(v2(hostile))).toBeNull();
    expect(getters).toBe(0);
    expect(parseRichRetryLedgerSnapshot({ ...v2(first), version: 3 })).toBeNull();
    expect(parseRichRetryLedgerSnapshot({ ...v2(first), receipts: [{ id: first.id, state: 'observed', detail: 'fiction' }] })).toBeNull();
    expect(parseRichRetryLedgerSnapshot({ version: 2, actions: [{ ...first, claimOwner: OWNER,
      phase: 'retired', resultDetail: 'Unjustified unknown' }], receipts: [
      { id: first.id, state: 'unknown', detail: 'Unjustified unknown' }
    ] })).toBeNull();
    expect(parseRichRetryLedgerSnapshot(v2(...Array.from({ length: 129 }, (_, n) =>
      ({ ...first, id: `${n.toString().padStart(8, '0')}-2222-4333-8444-555555555555`,
        mediaId: `media-n-${n}`, nodeId: `n-${n}` }))))).toBeNull();
  });

  it('models claim, once-only opening, exact election and irreversible dispatch; never models native click', () => {
    const first = retry();
    const begun = retryStep(v2(), { kind: 'create', record: first });
    const claimed = retryStep(begun, { kind: 'claim', expected: first, owner: OWNER });
    const c = claimed.actions[0]!;
    expect(reduceInertRichRetrySnapshot(claimed, { kind: 'claim', expected: c, owner: FOREIGN })).toEqual({ kind: 'refused' });
    const opened = retryStep(claimed, { kind: 'opening_spent', expected: c, owner: OWNER });
    expect(reduceInertRichRetrySnapshot(opened, { kind: 'opening_spent', expected: opened.actions[0], owner: OWNER }))
      .toEqual({ kind: 'refused' });
    const elected = retryStep(opened, { kind: 'elect', expected: opened.actions[0], owner: OWNER,
      tabId: 42, documentId: 'current-doc', documentGeneration: 2, navigationEpoch: 8 });
    const spent = retryStep(elected, { kind: 'dispatch_spent', expected: elected.actions[0], owner: OWNER });
    expect(spent.actions[0]).toMatchObject({ phase: 'dispatch_spent', openingSpent: true, dispatchSpent: true });
    for (const cmd of [
      { kind: 'dispatch_spent', expected: spent.actions[0], owner: OWNER },
      { kind: 'elect', expected: spent.actions[0], owner: OWNER, tabId: 43,
        documentId: 'another', documentGeneration: 3, navigationEpoch: 9 },
      { kind: 'retire', expected: spent.actions[0], owner: OWNER, outcome: 'observed', detail: 'canvas ACK' }
    ]) expect(reduceInertRichRetrySnapshot(spent, cmd)).toEqual({ kind: 'refused' });
    const unknown = retryStep(spent, { kind: 'retire', expected: spent.actions[0], owner: OWNER,
      outcome: 'unknown', detail: 'No proven asset commit' });
    expect(unknown.receipts).toEqual([{ id: SECOND, state: 'unknown', detail: 'No proven asset commit' }]);
    expect(reduceInertRichRetrySnapshot(unknown, { kind: 'retire', expected: spent.actions[0], owner: OWNER,
      outcome: 'unknown', detail: 'No proven asset commit' }).kind).toBe('unchanged');
    expect(reduceInertRichRetrySnapshot(unknown, { kind: 'retire', expected: spent.actions[0], owner: OWNER,
      outcome: 'observed', detail: 'Fake success' })).toEqual({ kind: 'refused' });
  });

  it('readback checkpoints each phase without offering capture or changing v1 control behavior', async () => {
    const file = await retryRoot();
    const first = freshRetry();
    let before: RichRetryRecord = first;
    const steps = [
      { kind: 'create', record: first },
      { kind: 'claim', expected: before, owner: OWNER }
    ];
    expect((await checkpointInertRichRetry(steps[0], () => true)).kind).toBe('changed');
    let disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk).toEqual(v2(first));
    expect((await checkpointInertRichRetry(steps[1], () => true)).kind).toBe('changed');
    before = { ...first, claimOwner: OWNER };
    for (const step of [
      { kind: 'opening_spent', expected: before, owner: OWNER },
      { kind: 'elect', expected: { ...before, phase: 'opening_spent', openingSpent: true }, owner: OWNER,
        tabId: 42, documentId: 'current-doc', documentGeneration: 2, navigationEpoch: 8 },
      { kind: 'dispatch_spent', expected: { ...before, phase: 'elected', openingSpent: true,
        tabId: 42, documentId: 'current-doc', documentGeneration: 2, navigationEpoch: 8 }, owner: OWNER }
    ]) expect((await checkpointInertRichRetry(step, () => true)).kind).toBe('changed');
    disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.actions[0]).toMatchObject({ phase: 'dispatch_spent', dispatchSpent: true });
    resetRichActionsForTests();
    expect(await restoreRichActionLedger()).toBe('valid');
    expect(await readRichActionStatus(SESSION, SECOND)).toMatchObject({ state: 'unknown' });
    expect((await checkpointInertRichRetry({ kind: 'dispatch_spent', expected: disk.actions[0], owner: OWNER },
      () => true)).kind).toBe('refused');
    expect((await beginRichAction(action())).state).toBe('unavailable');
    expect(await armRichAction(ID, 'current-doc', 8)).toBe(false);
    expect((await checkpointInertRichRetry({ kind: 'retire', expected: disk.actions[0], owner: OWNER,
      outcome: 'unknown', detail: 'Unconfirmed recapture' }, () => true)).kind).toBe('changed');
    disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.actions[0].phase).toBe('retired');
    expect(disk.receipts).toEqual([{ id: SECOND, state: 'unknown', detail: 'Unconfirmed recapture' }]);
  });

  it('quarantines rejected and ambiguous checkpoint writes with no delayed retry or second dispatch', async () => {
    const file = await retryRoot();
    const first = freshRetry();
    expect((await checkpointInertRichRetry({ kind: 'create', record: first }, () => true)).kind).toBe('changed');
    const before = await fs.readFile(file, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Error('disk checkpoint refused'));
    expect((await checkpointInertRichRetry({ kind: 'claim', expected: first, owner: OWNER }, () => true)).kind)
      .toBe('refused');
    rename.mockRestore();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect((await checkpointInertRichRetry({ kind: 'claim', expected: first, owner: OWNER }, () => true)).kind)
      .toBe('refused');

    resetDurableForTests(); resetRichActionsForTests(); initDurableStore(directory!);
    const actualRename = fs.rename.bind(fs);
    const ambiguous = vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => {
      await actualRename(a, b); throw Error('lost checkpoint ACK');
    });
    // A restored pre-dispatch claim is intentionally unavailable; exercise the
    // rename-then-error cut with an independent NEW slot instead.
    const second = { ...first, id: '66666666-2222-4333-8444-555555555555',
      mediaId: 'media-n-2', nodeId: 'n-2' };
    expect((await checkpointInertRichRetry({ kind: 'create', record: second }, () => true)).kind)
      .toBe('refused');
    ambiguous.mockRestore();
    expect(await restoreRichActionLedger()).toBe('quarantined');
    const committed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(committed.actions[1]).toMatchObject({ id: second.id, phase: 'intent' });
    expect((await checkpointInertRichRetry({ kind: 'claim', expected: second, owner: OWNER },
      () => true)).kind).toBe('refused');
  });

  it('serializes duplicate exact-slot intents while retaining independent PAGE slots and legacy receipts', async () => {
    const file = await retryRoot();
    const old = { version: 1, actions: [{ ...action('elected'), phase: 'retired', resultDetail: 'old' }],
      receipts: [{ id: ID, state: 'observed', detail: 'old' }] };
    await writeDurableNow('rich-actions', old);
    resetRichActionsForTests();
    const first = freshRetry();
    const duplicate = { ...first, id: '66666666-2222-4333-8444-555555555555' };
    const simultaneous = await Promise.all([
      checkpointInertRichRetry({ kind: 'create', record: first }, () => true),
      checkpointInertRichRetry({ kind: 'create', record: duplicate }, () => true)
    ]);
    expect(simultaneous.map(item => item.kind)).toEqual(['changed', 'refused']);
    const second = { ...first, id: '88888888-2222-4333-8444-555555555555',
      mediaId: 'media-n-2', nodeId: 'n-2' };
    expect((await checkpointInertRichRetry({ kind: 'create', record: second }, () => true)).kind).toBe('changed');
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(disk.version).toBe(2);
    expect(disk.actions).toEqual([...old.actions, first, second]);
    expect(disk.receipts).toEqual(old.receipts);
    expect((await beginRichAction(action())).state).toBe('unavailable');
  });

  it('does not revive restored pre-dispatch rows or an old Recording generation after Off→On', async () => {
    const file = await retryRoot();
    const first = freshRetry();
    expect((await checkpointInertRichRetry({ kind: 'create', record: first }, () => true)).kind).toBe('changed');
    resetRichActionsForTests();
    expect(await readRichActionStatus(SESSION, SECOND)).toMatchObject({ state: 'unavailable' });
    expect((await checkpointInertRichRetry({ kind: 'claim', expected: first, owner: OWNER }, () => true)).kind)
      .toBe('refused');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(v2(first));
    await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: false } }));
    await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: true } }));
    expect((await checkpointInertRichRetry({ kind: 'create', record: {
      ...first, id: '99999999-2222-4333-8444-555555555555',
      mediaId: 'media-n-2', nodeId: 'n-2' } }, () => true)).kind).toBe('refused');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(v2(first));
  });

  it('requires unavailable removed recovery until a store-owned durable incarnation exists', async () => {
    const file = await retryRoot();
    const first = freshRetry();
    expect(parseRichRetryLedgerSnapshot(v2({ ...first, confirmRemoved: true, removalIncarnation: ID }))).toBeTruthy();
    expect((await checkpointInertRichRetry({ kind: 'create', record: {
      ...first, confirmRemoved: true, removalIncarnation: ID } }, () => true)).kind).toBe('refused');
    expect(await fs.readFile(file, 'utf8').catch(() => null)).toBeNull();
  });

  it('quarantines an independently replaced physical predecessor and never rewrites its bytes', async () => {
    const file = await retryRoot();
    const first = freshRetry();
    expect((await checkpointInertRichRetry({ kind: 'create', record: first }, () => true)).kind).toBe('changed');
    const replacement = '{"version":3,"separate":"owner"}';
    await fs.writeFile(file, replacement);
    expect((await checkpointInertRichRetry({ kind: 'claim', expected: first, owner: OWNER }, () => true)).kind)
      .toBe('refused');
    expect(await restoreRichActionLedger()).toBe('quarantined');
    expect(await fs.readFile(file, 'utf8')).toBe(replacement);
  });
});
