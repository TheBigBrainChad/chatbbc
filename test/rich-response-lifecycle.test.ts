import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { defaultConfig, getConfig, getRecordingRevision, initConfigPath, recordingWriteAllowed, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow } from '../src/main/durable.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { configureInputDelivery, listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { recordChatObservations, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import { appendEvent, clearImageStorage, createSession, getImageStorage, initSessionStore, readAsset,
  readEvents, readRecordedSessionImage, resetSessionStoreForTests, sessionsRoot, upsertMessageEvent,
  upsertNativeImageEvent, writeAsset } from '../src/main/session/store.js';

let directory: string;
const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const message = (id: string) => ({ kind: 'user_message' as const, source: 'app' as const,
  messageId: id, time: 100, message: text(id) });
const off = async () => {
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  expect(getConfig().sessions.record).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(false);
};
const on = async () => saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: true } });
/** Off must close admission before a previously started physical writer is released. */
function beginOffBehindWriter(): { saved: Promise<void>; closing: Promise<void> } {
  const saved = off();
  const closing = vi.waitFor(() => expect(recordingWriteAllowed(getRecordingRevision())).toBe(false));
  return { saved, closing };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbbc-recording-off-'));
  initConfigPath(directory);
  await saveConfig(defaultConfig());
  initSessionStore(directory);
  initDurableStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  await flushDurable();
  resetRecorderForTests();
  resetSessionStoreForTests();
  await saveConfig(defaultConfig());
  await fs.rm(directory, { recursive: true, force: true });
});

/** Pause exactly one owner write while leaving the independent config writer able to commit. */
function gateRename(target: string) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!held && String(to) === target) { held = true; entered(); await gate; }
    return rename(from, to);
  }) as typeof fs.rename);
  return { reached, release, restore: () => spy.mockRestore() };
}

it('refuses a second canonical user and assistant queued before the persisted Off transition', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const queuedUser = upsertMessageEvent(session.id, message('after-off'));
    const queuedAssistant = upsertMessageEvent(session.id, {
      kind: 'assistant_message', source: 'extension', messageId: 'assistant-after-off', time: 102,
      message: text('private assistant prose'), final: true
    });
    void queuedUser.catch(() => undefined);
    void queuedAssistant.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    expect(getConfig().sessions.record).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    gate.release();
    await disabling.saved;
    await baseline;
    expect((await fs.stat(shard)).isFile()).toBe(true);
    await expect(queuedUser).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    await expect(queuedAssistant).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind.endsWith('_message'))).toMatchObject([
      { kind: 'user_message', messageId: 'baseline' }
    ]);
  } finally { gate.release(); gate.restore(); }
});

it('refuses queued native image metadata after Off without creating its canonical shard', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const pending = upsertNativeImageEvent(session.id, { kind: 'native_image', source: 'extension', time: 101,
      messageId: 'native-after-off', providerAssetId: 'file_native_after_off', providerRole: 'tool',
      providerStatus: 'finished_successfully', previewStatus: 'pending' });
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  } finally { gate.release(); gate.restore(); }
});

it('does not revive an old queued transcript write when Recording is switched Off then On before its queue runs', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const pending = upsertMessageEvent(session.id, message('old-epoch'));
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await on();
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
    await upsertMessageEvent(session.id, message('new-epoch'));
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(2);
  } finally { gate.release(); gate.restore(); }
});

it('refuses a journal transcript row queued before Off while preserving the preceding committed row', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const journal = path.join(sessionsRoot(), session.id, 'events.jsonl');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = fs.appendFile.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'appendFile').mockImplementation((async (name, ...args) => {
    if (!held && String(name) === journal) { held = true; entered(); await gate; }
    return (append as (...args: unknown[]) => Promise<void>)(name, ...args);
  }) as typeof fs.appendFile);
  try {
    const baseline = appendEvent(session.id, { source: 'extension', kind: 'turn_start', time: 100, turnId: 'prior' });
    await reached;
    const pending = appendEvent(session.id, { source: 'extension', kind: 'turn_start', time: 101, turnId: 'after-off' });
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'turn_start').map(event => event.turnId)).toEqual(['prior']);
  } finally { release(); spy.mockRestore(); }
});

it('refuses a direct image asset queued before Off without modifying quota or creating pixels', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const firstBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#113355' } }).png().toBuffer();
  const nextBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#994433' } }).png().toBuffer();
  const firstId = `${createHash('sha256').update(firstBytes).digest('hex').slice(0, 32)}.png`;
  const nextId = `${createHash('sha256').update(nextBytes).digest('hex').slice(0, 32)}.png`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = fs.writeFile.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (name, ...args) => {
    if (!held && String(name).endsWith(path.join('assets', firstId))) { held = true; entered(); await gate; }
    return (write as (...args: unknown[]) => Promise<void>)(name, ...args);
  }) as typeof fs.writeFile);
  try {
    const first = writeAsset(session.id, firstBytes, 'image/png');
    await reached;
    const pending = writeAsset(session.id, nextBytes, 'image/png');
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    await first;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    await expect(fs.stat(path.join(sessionsRoot(), session.id, 'assets', nextId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await getImageStorage()).usedBytes).toBe(firstBytes.length);
  } finally { release(); spy.mockRestore(); }
});

it('acknowledges an input receipt without a fabricated anchor if its first row waits beyond Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const anchors: number[] = [];
    const pending = recordDeliveredInput({ id: 'receipt-after-off', sessionId: session.id, state: 'sent',
      messageId: 'input:receipt-after-off', deliveredAt: 200, text: 'private receipt' } as InputEntry,
    seq => anchors.push(seq));
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    expect(await pending).toBe(true);
    expect(anchors).toEqual([]);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { gate.release(); gate.restore(); }
});

it('durably settles a sent outbox receipt suppressed at Off without an anchor or later On backfill', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const row: InputEntry = {
    id: randomUUID(), sessionId: session.id, text: 'sent before disabled recording',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: 100, createdAt: 100,
    state: 'sent', owner: null, conversationId: session.conversationId,
    messageId: 'input:privacy-receipt', deliveredAt: 200, historyRecorded: false
  };
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    await writeDurableNow('session-input', [row]);
    let entered!: () => void;
    const invoked = new Promise<void>(resolve => { entered = resolve; });
    configureInputDelivery({
      recordDelivered: (entry, anchor) => { entered(); return recordDeliveredInput(entry, anchor); },
      changed: () => {}, applyAutomation: async () => {}
    });
    const reconciling = listInputs();
    await invoked;
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    expect(await reconciling).toMatchObject([{ historyRecorded: true }]);
    expect((await readDurable<InputEntry[]>('session-input'))).toMatchObject([{ historyRecorded: true }]);
    expect((await readDurable<InputEntry[]>('session-input'))![0]?.historyAnchored).not.toBe(true);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
    await on();
    expect(await listInputs()).toMatchObject([{ historyRecorded: true }]);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { gate.release(); gate.restore(); }
});

it('keeps previously committed input text but suppresses its preview after Off during Sharp', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#227755' } }).webp().toBuffer();
  const assetId = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.bin`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stats = sharp.prototype.stats;
  let held = false;
  const spy = vi.spyOn(sharp.prototype, 'stats').mockImplementation(async function (this: ReturnType<typeof sharp>, ...args: Parameters<typeof stats>) {
    if (!held) { held = true; entered(); await gate; }
    return stats.apply(this, args);
  });
  try {
    const anchors: number[] = [];
    const receipt: InputEntry = { id: 'receipt-text-only', sessionId: session.id, state: 'sent',
      messageId: 'input:receipt-text-only', deliveredAt: 200, text: 'keep committed text',
      images: [{ name: 'privacy.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] } as InputEntry;
    const pending = recordDeliveredInput(receipt, seq => anchors.push(seq));
    await reached;
    await off();
    release();
    expect(await pending).toBe(true);
    expect(anchors).toHaveLength(1);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toMatchObject([
      { messageId: 'input:receipt-text-only', assets: undefined }
    ]);
    await expect(fs.stat(path.join(sessionsRoot(), session.id, 'assets', assetId))).rejects.toMatchObject({ code: 'ENOENT' });
    await on();
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { release(); spy.mockRestore(); }
});

it('does not enrich an existing native image after Off during Sharp decode', async () => {
  const conversationId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const data = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123987' } }).webp().toBuffer();
  const assetId = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.bin`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stats = sharp.prototype.stats;
  let held = false;
  const spy = vi.spyOn(sharp.prototype, 'stats').mockImplementation(async function (this: ReturnType<typeof sharp>, ...args: Parameters<typeof stats>) {
    if (!held) { held = true; entered(); await gate; }
    return stats.apply(this, args);
  });
  try {
    const pending = recordChatObservations(conversationId, [{ kind: 'native_image', time: 200,
      messageId: randomUUID(), providerAssetId: 'file_privacy_image', providerRole: 'tool',
      providerStatus: 'finished_successfully', previewStatus: 'available', previewWidth: 4, previewHeight: 3,
      previewDataUrl: `data:image/webp;base64,${data.toString('base64')}` }]);
    await reached;
    expect((await readEvents(sessionId!, { kinds: ['native_image'] })).at(0)).toMatchObject({ previewStatus: 'pending' });
    await off();
    release();
    expect((await pending).stored).toBe(1);
    expect((await readEvents(sessionId!, { kinds: ['native_image'] })).at(0)).toMatchObject({ previewStatus: 'pending', asset: undefined });
    await expect(fs.stat(path.join(sessionsRoot(), sessionId!, 'assets', assetId))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); spy.mockRestore(); }
});

it('keeps pre-Off image history readable and permits explicit owner retirement and cleanup while Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#335599' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  await upsertMessageEvent(session.id, { ...message('historical-image'), assets: [asset] });
  await off();
  expect(await readRecordedSessionImage(session.id, asset.id)).toBe(`data:image/png;base64,${pixels.toString('base64')}`);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect(await readAsset(session.id, asset.id)).toBeNull();
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message')).toMatchObject({
    retiredImageAssetIds: [asset.id], assets: undefined
  });
});

it('retains durable handoff control markers while transcript recording is Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  await off();
  await appendEvent(session.id, {
    source: 'app', kind: 'handoff', time: 200, handoffId: 'handoff-privacy', chars: 24, reason: 'compaction'
  });
  expect((await readEvents(session.id)).filter(event => event.kind === 'handoff')).toMatchObject([
    { handoffId: 'handoff-privacy' }
  ]);
});

it('does not acknowledge Recording Off while an already-started asset write can still create pixels', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#aa3355' } }).png().toBuffer();
  const assetId = `${createHash('sha256').update(pixels).digest('hex').slice(0, 32)}.png`;
  const target = path.join(sessionsRoot(), session.id, 'assets', assetId);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, ...args) => {
    if (String(file) === target) { entered(); await gate; }
    return (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
  }) as typeof fs.writeFile);
  let assetWrite: Promise<unknown> | null = null;
  let offSave: Promise<unknown> | null = null;
  try {
    assetWrite = writeAsset(session.id, pixels, 'image/png');
    await reached;
    offSave = off();
    // An independent config rename used to resolve while this physical write was held.
    // The Off acknowledgement must now wait for the original owner to leave that write.
    const acknowledgedBeforeRelease = await Promise.race([
      offSave.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 150))
    ]);
    release();
    await assetWrite;
    await offSave;
    expect(acknowledgedBeforeRelease).toBe(false);
    expect((await fs.stat(target)).size).toBe(pixels.length);
  } finally {
    release();
    await Promise.allSettled([assetWrite, offSave].filter((promise): promise is Promise<unknown> => promise !== null));
    spy.mockRestore();
  }
});

it('does not acknowledge Recording Off while first-sight recording creates a session outside writer queues', async () => {
  const conversationId = randomUUID();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = fs.writeFile.bind(fs);
  let blocked = false;
  let firstSightWriteSettled = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, ...args) => {
    if (!blocked && String(file).endsWith(path.join('messages.json'))) {
      blocked = true;
      entered();
      await gate;
      const result = await (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
      firstSightWriteSettled = true;
      return result;
    }
    return (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
  }) as typeof fs.writeFile);
  let creating: Promise<string | null> | null = null;
  let saving: Promise<void> | null = null;
  try {
    creating = sessionForConversation(conversationId);
    void creating.catch(() => undefined);
    await reached;
    saving = off();
    await vi.waitFor(() => expect(recordingWriteAllowed(getRecordingRevision())).toBe(false));
    const acknowledgedBeforeRelease = await Promise.race([
      saving.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 150))
    ]);
    expect(acknowledgedBeforeRelease).toBe(false);
    await expect(sessionForConversation(randomUUID())).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    release();
    await saving;
    expect(firstSightWriteSettled).toBe(true);
    await expect(creating).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    const sessions = await fs.readdir(sessionsRoot());
    expect(sessions).toHaveLength(1);
    // Session creation began while On; its later session_start must not append after Off.
    expect(await fs.readFile(path.join(sessionsRoot(), sessions[0]!, 'events.jsonl'), 'utf8')).toBe('');
    expect(await readEvents(sessions[0]!)).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([creating, saving].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('flushes a pre-Off dirty session summary before acknowledging Off and leaves no delayed metadata writer', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const meta = path.join(sessionsRoot(), session.id, 'meta.json');
  const originalRename = fs.rename.bind(fs);
  let acknowledged = false;
  let lateMetaWrites = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (acknowledged && String(to) === meta) lateMetaWrites++;
    return originalRename(from, to);
  }) as typeof fs.rename);
  try {
    await appendEvent(session.id, { kind: 'turn_start', source: 'extension', time: 100, turnId: 'pre-off' });
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(0);
    await off();
    acknowledged = true;
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1650));
    expect(lateMetaWrites).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('keeps observations retryable when a pending Recording Off fails to save', async () => {
  const conversationId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const originalRename = fs.rename.bind(fs);
  const target = path.join(directory, 'config.json');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to) === target) {
      entered();
      await gate;
      throw Object.assign(new Error('Config rename failed'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fs.rename);
  const observation = { kind: 'user_message' as const, time: 200, messageId: randomUUID(), text: 'must survive failed Off' };
  let saving: Promise<void> | null = null;
  let recording: ReturnType<typeof recordChatObservations> | null = null;
  try {
    saving = off();
    void saving.catch(() => undefined);
    await reached;
    expect(getConfig().sessions.record).toBe(true);
    expect(recordingWriteAllowed(getRecordingRevision())).toBe(false);
    recording = recordChatObservations(conversationId, [observation]);
    await expect(recording).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    release();
    await expect(saving).rejects.toThrow('Config rename failed');
    expect(getConfig().sessions.record).toBe(true);
    expect((await recordChatObservations(conversationId, [observation])).stored).toBeGreaterThan(0);
    expect((await readEvents(sessionId!)).filter(event => event.kind === 'user_message')).toMatchObject([
      { messageId: observation.messageId, message: text(observation.text) }
    ]);
  } finally {
    release();
    await Promise.allSettled([recording, saving].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('retains the committed On setting and reopens recording admission when the Off config rename fails', async () => {
  const originalRename = fs.rename.bind(fs);
  const priorRevision = getRecordingRevision();
  let refused = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!refused && String(to) === path.join(directory, 'config.json')) {
      refused = true;
      throw Object.assign(new Error('Config rename failed'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fs.rename);
  try {
    await expect(off()).rejects.toThrow('Config rename failed');
    expect(getConfig().sessions.record).toBe(true);
    expect(getRecordingRevision()).toBe(priorRevision);
    expect(recordingWriteAllowed(priorRevision)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    const session = await createSession({ conversationId: randomUUID() });
    await upsertMessageEvent(session.id, message('recording-still-on'));
    expect((await readEvents(session.id)).some(event => event.kind === 'user_message' &&
      event.messageId === 'recording-still-on')).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
