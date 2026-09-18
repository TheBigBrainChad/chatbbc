import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import * as config from '../src/main/config.js';
import { recordRichObservation, resetRecorderForTests } from '../src/main/session/recorder.js';
import {
  createSession, flushSessions, getSession, initSessionStore, readEvents, rebindSession,
  resetSessionStoreForTests, sessionsRoot, upsertMessageEvent, upsertRichMessage
} from '../src/main/session/store.js';
import { parseRichResponse } from '../src/shared/rich-response.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const PROVIDER = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
const OTHER = '3150f756-bf2d-45fa-ac0f-45010b2239fc';
const MESSAGE = 'assistant:working:exchange:1789552000000';
const origin = (bindingRevision = 0, conversationId = A, documentId = 'document-a', navigationEpoch = 1) =>
  ({ conversationId, bindingRevision, documentId, navigationEpoch });
const rich = (text = 'Choose', providerMessageId: string | null = PROVIDER) => {
  const parsed = parseRichResponse({
    version: 1, status: 'available', reason: null, conversationId: A, messageId: MESSAGE,
    providerMessageId, revision: 999, accessibleText: text,
    nodes: [{ id: 'n1', kind: 'text', style: 'body', text }]
  });
  if (!parsed) throw new Error('Invalid synthetic rich fixture');
  return parsed;
};
const answer = (text = 'Choose', providerMessageId = PROVIDER) => ({
  kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
  messageId: MESSAGE, message: { text, chars: text.length, truncated: false },
  providerMessageId, turnId: 'turn-owned', state: 'final' as const, final: true,
  goalEligible: true
});

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('clf-rich-store-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterAll(async () => {
  resetRecorderForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});
beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
  A = randomUUID();
  B = randomUUID();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await saveConfig(defaultConfig());
});

describe('rich revisions of an existing canonical assistant shard', () => {
  it('enriches one exact logical message durably without changing content, turn or Goal facts', async () => {
    const session = await createSession({ title: 'rich canonical', conversationId: A });
    const first = await upsertMessageEvent(session.id, answer());
    const before = await getSession(session.id);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const rows = await readEvents(session.id);
    expect(rows.filter(row => row.kind === 'assistant_message')).toHaveLength(1);
    const stored = rows.find(row => row.kind === 'assistant_message');
    expect(first.event.kind).toBe('assistant_message');
    if (first.event.kind !== 'assistant_message') throw new Error('expected assistant');
    expect(stored).toMatchObject({
      messageId: MESSAGE, origin: first.event.origin, contentSeq: first.event.contentSeq,
      finalContentSeq: first.event.finalContentSeq, turnId: first.event.turnId,
      goalEligible: first.event.goalEligible, message: first.event.message,
      rich: { revision: 1, accessibleText: 'Choose' }, richOrigin: origin()
    });
    expect(stored!.seq).toBeGreaterThan(first.event.seq); // delivery cursor, not work sequence
    const after = await getSession(session.id);
    expect(after).toMatchObject({ events: before?.events, estimatedTokens: before?.estimatedTokens,
      contextTokens: before?.contextTokens, lastAssistantFinalAt: before?.lastAssistantFinalAt,
      activeTurnId: before?.activeTurnId, finishTurn: before?.finishTurn, updatedAt: before?.updatedAt });
    await flushSessions();
    resetSessionStoreForTests();
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toEqual(stored);
    expect((await getSession(session.id))?.bindingRevision).toBe(0);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('unchanged');
  });

  it('keeps same-provider rich through ordinary same-text upserts, but invalidates changed text or provider', async () => {
    const session = await createSession({ title: 'rich preservation', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const repeat = await upsertMessageEvent(session.id, { ...answer(), renderedHtml: { text: '<p>Choose</p>', chars: 13, truncated: false } });
    expect(repeat.event.kind === 'assistant_message' && repeat.event.rich?.revision).toBe(1);
    const replaced = await upsertMessageEvent(session.id, answer('Choose again'));
    expect(replaced.event.kind === 'assistant_message' && replaced.event.rich).toBeUndefined();
    expect(replaced.event.kind === 'assistant_message' && replaced.event.richOrigin).toBeUndefined();
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose again'), origin())).toBe('stored');
    const drift = await upsertMessageEvent(session.id, answer('Choose again', OTHER));
    expect(drift.event.kind === 'assistant_message' && drift.event.rich).toBeUndefined();
  });

  it('rejects missing or foreign logical/provider identity rather than creating a transcript row', async () => {
    const session = await createSession({ title: 'rich identity', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, 'unknown-row', rich(), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose', OTHER), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose', null), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin(0, B))).toBe('refused');
    expect((await readEvents(session.id)).filter(row => row.kind === 'assistant_message')).toHaveLength(1);
  });

  it('persists every successful A→B→A revision and refuses stale snapshots inside the store queue', async () => {
    const session = await createSession({ title: 'rich binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect(await rebindSession(session.id, B, A)).toBe(true);
    expect(await rebindSession(session.id, B, A)).toBe(false);
    expect((await getSession(session.id))?.bindingRevision).toBe(2);
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Stale'), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Fresh'), origin(2, A, 'document-return', 0))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Old'), origin())).toBe('refused');
    await flushSessions();
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.bindingRevision).toBe(2);
    const row = (await readEvents(session.id)).find(event => event.kind === 'assistant_message');
    expect(row).toMatchObject({ rich: { accessibleText: 'Fresh', revision: 2 }, richOrigin: origin(2, A, 'document-return', 0) });
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Again stale'), origin())).toBe('refused');
  });

  it('rejects stale or conflicting document/epoch and assigns monotonically newer rich revisions', async () => {
    const session = await createSession({ title: 'rich epochs', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin(0, A, 'doc', 3))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('old'), origin(0, A, 'doc', 2))).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('foreign'), origin(0, A, 'different-doc', 4))).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('updated'), origin(0, A, 'doc', 4))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('updated'), origin(0, A, 'doc', 4))).toBe('unchanged');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ rich: { revision: 2 } });
  });

  it('does not publish a failed atomic shard write and succeeds on safe retry', async () => {
    const session = await createSession({ title: 'rich failure', conversationId: A });
    const first = await upsertMessageEvent(session.id, answer());
    const realRename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, 'rename').mockImplementation((async (oldPath, newPath) => {
      if (String(newPath).includes(path.join(session.id, 'messages'))) throw new Error('simulated disk fault');
      return realRename(oldPath, newPath);
    }) as typeof fs.rename);
    await expect(upsertRichMessage(session.id, MESSAGE, rich(), origin())).rejects.toThrow('simulated disk fault');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toEqual(first.event);
    fault.mockRestore();
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ rich: { revision: 1 } });
    expect(sessionsRoot()).toBeTruthy();
  });

  it('refuses uncorroborated recorder observations and recording-Off even with a claimed document', async () => {
    const session = await createSession({ title: 'rich ingestion refused', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const item = { kind: 'assistant_message' as const, time: 100, messageId: MESSAGE,
      providerMessageId: PROVIDER, rich: rich(), documentId: 'fabricated', navigationEpoch: 1 };
    expect(await recordRichObservation(A, item)).toBe('refused');
    // Current config normalizes record:true as a product invariant; simulate a future
    // recording-disabled runtime at the consumer boundary without widening this task.
    const enabled = config.getConfig();
    const off = vi.spyOn(config, 'getConfig').mockReturnValue({ ...enabled, sessions: { ...enabled.sessions, record: false } });
    try {
      expect(await recordRichObservation(A, item)).toBe('refused');
      expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('refused');
    } finally {
      off.mockRestore();
    }
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).not.toHaveProperty('rich');
  });

  it('treats a pre-feature metadata checkpoint as binding revision zero', async () => {
    const session = await createSession({ title: 'legacy binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await flushSessions();
    const file = path.join(sessionsRoot(), session.id, 'meta.json');
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    delete persisted.bindingRevision;
    await fs.writeFile(file, JSON.stringify(persisted), 'utf8');
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.bindingRevision).toBe(0);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('never increments or publishes a failed rebind metadata checkpoint', async () => {
    const session = await createSession({ title: 'failed binding', conversationId: A });
    const realRename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === path.join(sessionsRoot(), session.id, 'meta.json')) throw new Error('meta fault');
      return realRename(from, to);
    }) as typeof fs.rename);
    expect(await rebindSession(session.id, A, B)).toBe(false);
    expect(await getSession(session.id)).toMatchObject({ conversationId: A, bindingRevision: 0 });
    fault.mockRestore();
    resetSessionStoreForTests();
    expect(await getSession(session.id)).toMatchObject({ conversationId: A, bindingRevision: 0 });
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('never lets an ordinary upsert inject rich fields or replace the store-owned revision', async () => {
    const session = await createSession({ title: 'no rich smuggling', conversationId: A });
    const injected = { ...answer(), rich: rich(), richOrigin: origin(),
      richMediaUnavailable: 'unsupported' as const, retiredRichImageAssetIds: ['file_injected'] };
    const first = await upsertMessageEvent(session.id, injected);
    expect(first.event).not.toHaveProperty('rich');
    expect(first.event).not.toHaveProperty('richOrigin');
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const repeat = await upsertMessageEvent(session.id, { ...injected, rich: rich('malicious overwrite') });
    expect(repeat.event).toMatchObject({ rich: { accessibleText: 'Choose', revision: 1 } });
  });

  it('serializes a stale async rich request behind the exact rebind without reattaching A', async () => {
    const session = await createSession({ title: 'serialized binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const first = upsertRichMessage(session.id, MESSAGE, rich(), origin());
    const moved = rebindSession(session.id, A, B);
    const stale = upsertRichMessage(session.id, MESSAGE, rich('stale'), origin());
    expect(await Promise.all([first, moved, stale])).toEqual(['stored', true, 'refused']);
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({
      rich: { accessibleText: 'Choose', revision: 1 }
    });
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('snapshots origin descriptors without invoking untrusted Proxy property getters', async () => {
    const session = await createSession({ title: 'origin snapshots', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    let gets = 0;
    const spoof = new Proxy(origin(), { get(target, key, receiver) {
      gets++;
      return key === 'conversationId' ? B : Reflect.get(target, key, receiver);
    } });
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), spoof)).toBe('stored');
    expect(gets).toBe(0);
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ richOrigin: origin() });
  });
});
