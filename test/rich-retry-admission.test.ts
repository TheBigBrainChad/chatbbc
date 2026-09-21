/** Cut3A: informational main/physical-ledger composition, never human consent or Retry authority. */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, getRecordingRevision, initConfigPath, recordingGenerationGrant,
  updateConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { parseRichRetryLedgerSnapshot, type RichRetryRecord } from '../src/main/rich-actions.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../src/main/session/blocked-chats.js';
import { clearImageStorage, createSession, deleteSession, findSessionByConversation, flushSessions, initSessionStore, rebindSession,
  resetSessionStoreForTests, sessionsRoot, upsertMessageEvent, upsertRichMedia,
  upsertRichMessage } from '../src/main/session/store.js';
import { registerUiSelection } from '../src/main/ui-selection.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { inspectMainRetryAdmission } from '../src/main/rich-retry-admission.js';

const MESSAGE = 'assistant:working:exchange:1789552000000';
const PROVIDER = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
const MEDIA = 'media-n-0';
const NODE = 'n-0';
let directory: string;
let mainWindow: BrowserWindow | null;
let owner: ReturnType<typeof registerUiSelection>;
let sequence: number;

const request = (id: string) => ({ sessionId: id, messageId: MESSAGE, mediaId: MEDIA,
  nodeId: NODE, richRevision: 1 });
const inspect = (event: IpcMainInvokeEvent, payload: unknown, window: BrowserWindow | null = mainWindow) =>
  inspectMainRetryAdmission(event, payload, window);

function windowFixture() {
  const frame = { url: pathToFileURL(path.join(process.cwd(), 'src/renderer/index.html')).href,
    processId: 101, routingId: 7 };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame,
    getURL: () => frame.url, isDestroyed: () => false, isLoadingMainFrame: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents,
    isDestroyed: () => false, isVisible: () => true });
  mainWindow = window as unknown as BrowserWindow;
  owner = registerUiSelection(() => mainWindow);
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const select = async (id: string | null) => {
    const selected = await owner.report(event, { sessionId: id, rendererGeneration: ++sequence });
    expect(selected.ok).toBe(true);
    return selected;
  };
  return { window, contents, frame, event, select };
}

async function page(status: 'pending' | 'unavailable' = 'pending') {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'inert retry admission', conversationId });
  const origin = { conversationId, bindingRevision: 0, documentId: 'document-a', navigationEpoch: 1 };
  const text = 'An image follows.';
  await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: 100,
    messageId: MESSAGE, providerMessageId: PROVIDER,
    message: { text, chars: text.length, truncated: false }, final: true });
  expect(await upsertRichMessage(session.id, MESSAGE, { version: 1, status: 'available',
    reason: null, conversationId, messageId: MESSAGE, providerMessageId: PROVIDER,
    revision: 0, accessibleText: text,
    nodes: [{ kind: 'image', id: NODE, mediaId: MEDIA, alt: 'Picture', width: 100, height: 100 }]
  }, origin)).toBe('stored');
  const media = { mediaId: MEDIA, nodeId: NODE, source: { kind: 'page' as const, nodeId: NODE },
    status, ...(status === 'unavailable' ? { reason: 'tainted' as const } : {}) };
  expect(await upsertRichMedia(session.id, MESSAGE, media, origin, 1)).toBe('stored');
  // Ordinary sidebar/attachment discovery warms the authoritative catalog;
  // Cut3A itself must never create one or perform cold metadata repair.
  expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id)
    .toBe(session.id);
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`);
  const ledger = path.join(directory, 'state', 'rich-actions.json');
  return { session, origin, media, shard, ledger };
}

function retryRow(id: string, conversationId: string, phase: RichRetryRecord['phase']): RichRetryRecord {
  const elected = phase === 'elected' || phase === 'dispatch_spent' || phase === 'retired';
  const openingSpent = phase === 'opening_spent';
  const dispatched = phase === 'dispatch_spent' || phase === 'retired';
  return { kind: 'retry_capture', id: randomUUID(), phase, createdAt: Date.now(),
    claimOwner: phase === 'intent' ? null : 'b'.repeat(64),
    sessionId: id, conversationId, bindingRevision: 0, messageId: MESSAGE,
    providerMessageId: PROVIDER, richRevision: 1, presentationSeq: 3,
    mediaId: MEDIA, nodeId: NODE, source: 'page', originDocumentId: 'document-a',
    originNavigationEpoch: 1, selectionGeneration: 1,
    recordingRevision: getRecordingRevision(), recordingGeneration: recordingGenerationGrant()!,
    cleanupEpoch: 0, removalIncarnation: null, confirmRemoved: false,
    tabId: elected ? 42 : null, documentId: elected ? 'elected-doc' : null,
    documentGeneration: elected ? 1 : null, navigationEpoch: elected ? 2 : null,
    openingSpent, dispatchSpent: dispatched, resultDetail: phase === 'retired' ? 'unconfirmed' : null };
}

beforeEach(async () => {
  directory = await makeTempDir('clf-retry-admission-');
  initConfigPath(directory);
  initSessionStore(directory);
  initDurableStore(directory);
  await fs.mkdir(path.join(directory, 'state'));
  await updateConfig(() => defaultConfig());
  mainWindow = null;
  sequence = 0;
  owner = registerUiSelection(() => mainWindow);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetBlockedChatsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('reports only a frozen nonauthorizing match for exact selected PAGE pending and unavailable; writes nothing', async () => {
  for (const status of ['pending', 'unavailable'] as const) {
    const { session, shard, ledger } = await page(status);
    const { event, select } = windowFixture();
    await select(session.id);
    // A warm, fully indexed session is distinct from a cold disk recovery path.
    expect((await findSessionByConversation(session.conversationId!, { requireUnique: true }))?.id)
      .toBe(session.id);
    const shardBefore = await fs.readFile(shard);
    const ledgerBefore = await fs.readFile(ledger).catch(() => null);
    const expected = Object.freeze({ kind: 'admission_matches', authority: 'none' });
    const result = await inspect(event, request(session.id));
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(await fs.readFile(shard)).toEqual(shardBefore);
    expect(await fs.readFile(ledger).catch(() => null)).toEqual(ledgerBefore);
    expect(await fs.readdir(path.join(sessionsRoot(), session.id, 'assets')).catch(() => [])).toEqual([]);
  }
});

it('does not repair a cold journal, metadata or session lifetime merely to inspect retry', async () => {
  const { session, ledger, shard } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  await flushSessions();
  resetSessionStoreForTests(); // Physical assistant remains; target and catalog are now cold.
  const dir = path.join(sessionsRoot(), session.id);
  const journal = path.join(dir, 'events.jsonl');
  const meta = path.join(dir, 'meta.json');
  await fs.appendFile(journal, '{"kind":'); // The normal ensureOpen repair would append a newline.
  const [journalBefore, metaBefore, shardBefore] = await Promise.all([
    fs.readFile(journal), fs.readFile(meta), fs.readFile(shard)
  ]);
  const ledgerBefore = await fs.readFile(ledger).catch(() => null);
  const result = await inspect(event, request(session.id));
  expect(await fs.readFile(journal)).toEqual(journalBefore);
  expect(await fs.readFile(meta)).toEqual(metaBefore);
  expect(await fs.readFile(shard)).toEqual(shardBefore);
  expect(await fs.readFile(ledger).catch(() => null)).toEqual(ledgerBefore);
  expect(result).toBeNull();
});

it('rejects malformed requests, spoofed consent, foreign/subframe sender, hidden window and wrong selection', async () => {
  const { session } = await page();
  const { event, window, frame, contents, select } = windowFixture();
  expect(await inspect(event, request(session.id))).toBeNull();
  await select(session.id);
  for (const input of [null, {}, { ...request(session.id), url: 'https://example.test/x' },
    { ...request(session.id), isTrusted: true }, { ...request(session.id), confirmed: true },
    { ...request(session.id), richRevision: 0 }, { ...request(session.id), nodeId: 'other' },
    { ...request(session.id), mediaId: 'media-other' },
    { ...request(session.id), messageId: 'bad\u0000id' },
    Object.defineProperty({ ...request(session.id) }, 'mediaId', { enumerable: true, get() { throw new Error('not data'); } })
  ]) expect(await inspect(event, input)).toBeNull();
  expect(await inspect({ sender: {}, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    request(session.id))).toBeNull();
  expect(await inspect({ sender: contents, senderFrame: {} } as unknown as IpcMainInvokeEvent,
    request(session.id))).toBeNull();
  expect(await inspect(event, request(session.id), null)).toBeNull();
  Object.defineProperty(window, 'isVisible', { value: () => false });
  expect(await inspect(event, request(session.id))).toBeNull();
});

it('refuses a durable A→B→A rebind even when the final conversation string matches', async () => {
  const { session } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  const original = session.conversationId!;
  const replacement = randomUUID();
  expect(await rebindSession(session.id, original, replacement)).toBe(true);
  expect(await rebindSession(session.id, replacement, original)).toBe(true);
  expect(await inspect(event, request(session.id))).toBeNull();
});

it('rejects every physical same-slot retry phase, including cold-restored unknown, and malformed ledger', async () => {
  const { session, ledger } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  const conversation = session.conversationId!;
  for (const phase of ['intent', 'opening_spent', 'elected', 'dispatch_spent', 'retired'] as const) {
    const row = retryRow(session.id, conversation, phase);
    const input = { version: 2 as const, actions: [row], receipts: phase === 'retired'
      ? [{ id: row.id, state: 'unknown', detail: 'unconfirmed' }] : [] };
    expect(parseRichRetryLedgerSnapshot(input)).not.toBeNull();
    await writeDurableNow('rich-actions', input);
    const before = await fs.readFile(ledger);
    expect(await inspect(event, request(session.id))).toBeNull();
    expect(await fs.readFile(ledger)).toEqual(before);
  }
  await fs.writeFile(ledger, '{"invalid":');
  expect(await inspect(event, request(session.id))).toBeNull();
  expect(await fs.readFile(ledger, 'utf8')).toBe('{"invalid":');
});

it('accepts a structurally valid legacy control-only ledger but refuses v2 corruption', async () => {
  const { session, ledger } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  await writeDurableNow('rich-actions', { version: 1, actions: [], receipts: [] });
  const before = await fs.readFile(ledger);
  expect(await inspect(event, request(session.id))).toEqual({
    kind: 'admission_matches', authority: 'none'
  });
  expect(await fs.readFile(ledger)).toEqual(before);
  await fs.writeFile(ledger, JSON.stringify({ version: 3, actions: [], receipts: [] }));
  expect(await inspect(event, request(session.id))).toBeNull();
});

it('rejects replaced, removed, blocked and stale Recording lifecycle without creating a retry', async () => {
  const { session, origin, media, shard } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  expect(await inspect(event, { ...request(session.id), richRevision: 2 })).toBeNull();
  setChatBlocked(session.conversationId!, true);
  expect(await inspect(event, request(session.id))).toBeNull();
  setChatBlocked(session.conversationId!, false);
  await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: false } }));
  expect(await inspect(event, request(session.id))).toBeNull();
  await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: true } }));
  expect(await inspect(event, request(session.id))).toEqual({ kind: 'admission_matches', authority: 'none' });
  expect(await upsertRichMedia(session.id, MESSAGE, { ...media, status: 'unavailable', reason: 'removed' },
    origin, 1)).toBe('stored');
  expect(await inspect(event, request(session.id))).toBeNull();
  const text = await fs.readFile(shard, 'utf8');
  await fs.writeFile(shard, '{broken physical source');
  expect(await inspect(event, request(session.id))).toBeNull();
  expect(await fs.readFile(shard, 'utf8')).toBe('{broken physical source');
  await fs.writeFile(shard, text);
  await flushSessions();
});

it('rejects A→B→A selection while physical ledger read is in flight', async () => {
  const { session } = await page();
  const second = await createSession({ title: 'another selected chat', conversationId: randomUUID() });
  const { event, select } = windowFixture();
  await select(session.id);
  const durable = await import('../src/main/durable.js');
  const realRead = durable.readDurableStrict;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let once = true;
  vi.spyOn(durable, 'readDurableStrict').mockImplementation(async (...args) => {
    const result = await realRead(...args);
    if (once && args[0] === 'rich-actions') { once = false; entered(); await held; }
    return result;
  });
  try {
    const old = inspect(event, request(session.id));
    await reached;
    await select(second.id);
    await select(session.id);
    release();
    expect(await old).toBeNull();
  } finally { release?.(); }
  expect(await inspect(event, request(session.id))).toEqual({ kind: 'admission_matches', authority: 'none' });
});

it('refuses physical shard replacement while the first strict ledger read awaits; never repairs it', async () => {
  const { session, shard } = await page();
  const { event, select } = windowFixture();
  await select(session.id);
  const durable = await import('../src/main/durable.js');
  const realRead = durable.readDurableStrict;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let once = true;
  vi.spyOn(durable, 'readDurableStrict').mockImplementation(async (...args) => {
    const result = await realRead(...args);
    if (once && args[0] === 'rich-actions') { once = false; entered(); await held; }
    return result;
  });
  try {
    const inFlight = inspect(event, request(session.id));
    await reached;
    await fs.writeFile(shard, '{"replaced":"outside-store"}');
    release();
    expect(await inFlight).toBeNull();
    expect(await fs.readFile(shard, 'utf8')).toBe('{"replaced":"outside-store"}');
  } finally { release?.(); }
});

it('rejects cleanup and deletion requests while ledger I/O waits instead of returning a stale match', async () => {
  for (const mutate of ['cleanup', 'delete'] as const) {
    const { session } = await page();
    const { event, select } = windowFixture();
    await select(session.id);
    const durable = await import('../src/main/durable.js');
    const realRead = durable.readDurableStrict;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let once = true;
    const spy = vi.spyOn(durable, 'readDurableStrict').mockImplementation(async (...args) => {
      const result = await realRead(...args);
      if (once && args[0] === 'rich-actions') { once = false; entered(); await held; }
      return result;
    });
    try {
      const inFlight = inspect(event, request(session.id));
      await reached;
      if (mutate === 'cleanup') await clearImageStorage('all');
      else await deleteSession(session.id);
      release();
      expect(await inFlight).toBeNull();
    } finally { release?.(); spy.mockRestore(); }
  }
});

it('rejects Recording Off→On rotation or newly occupied custody while ledger I/O awaits', async () => {
  for (const mutate of ['recording', 'ledger'] as const) {
    const { session, ledger } = await page();
    const { event, select } = windowFixture();
    await select(session.id);
    const durable = await import('../src/main/durable.js');
    const realRead = durable.readDurableStrict;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let once = true;
    const spy = vi.spyOn(durable, 'readDurableStrict').mockImplementation(async (...args) => {
      const result = await realRead(...args);
      if (once && args[0] === 'rich-actions') { once = false; entered(); await held; }
      return result;
    });
    try {
      const inFlight = inspect(event, request(session.id));
      await reached;
      if (mutate === 'recording') {
        await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: false } }));
        await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: true } }));
      } else {
        const row = retryRow(session.id, session.conversationId!, 'intent');
        await writeDurableNow('rich-actions', { version: 2, actions: [row], receipts: [] });
      }
      release();
      expect(await inFlight).toBeNull();
      if (mutate === 'ledger') {
        const disk = JSON.parse(await fs.readFile(ledger, 'utf8'));
        expect(disk.actions).toHaveLength(1);
      }
    } finally { release?.(); spy.mockRestore(); }
  }
});
