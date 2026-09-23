import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { getRecordingRevision, initConfigPath, loadConfig } from '../src/main/config.js';
import {
  appendEvent,
  clearImageStorage,
  createSession,
  flushSessions,
  getSession,
  getImageStorage,
  initSessionStore,
  MAX_GLOBAL_ASSET_BYTES,
  readAsset,
  readEvents,
  rebindSession,
  resetSessionStoreForTests,
  sessionsRoot,
  upsertMessageEvent,
  upsertNativeImageEvent,
  upsertRichMedia,
  upsertRichMessage,
  writeAsset
} from '../src/main/session/store.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-image-storage-'));
  // Asset writes are recording-gated: initialize the same persisted admission
  // generation as the app instead of implicitly relying on another test suite.
  initConfigPath(directory);
  await loadConfig();
  initSessionStore(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const REMOVAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertCleanupMarkers(row: { retiredRichMediaSlots?: Array<{ mediaId: string; nodeId: string }> },
  assetId: string): string[] {
  const markers = row.retiredRichMediaSlots as Array<{ mediaId: string; nodeId: string;
    removalIncarnation?: string; retiredAssetId?: string }> | undefined;
  expect(markers).toHaveLength(2);
  const ids = markers!.map(marker => {
    expect(marker).toEqual({ mediaId: marker.mediaId, nodeId: marker.nodeId,
      removalIncarnation: expect.stringMatching(REMOVAL_UUID), retiredAssetId: assetId });
    return marker.removalIncarnation!;
  });
  expect(new Set(ids).size).toBe(2);
  return ids;
}

/** Future available refs seeded in a real canonical shard ONLY for cleanup compatibility.
 * Production upsertRichMedia must continue refusing assets and available status. */
async function seedFutureRichOwner(sessionId: string, asset: Awaited<ReturnType<typeof writeAsset>>, suffix = 'one') {
  const session = await getSession(sessionId);
  const messageId = `rich-owner-${suffix}`;
  const providerMessageId = randomUUID();
  const origin = { conversationId: session!.conversationId!, bindingRevision: session!.bindingRevision ?? 0,
    documentId: `document-${suffix}`, navigationEpoch: 1 };
  const nodes = ['left', 'right'].map(side => ({ id: `node-${suffix}-${side}`, kind: 'image' as const,
    mediaId: `media-${suffix}-${side}`, alt: `${side} reference`, width: 5, height: 4 }));
  await upsertMessageEvent(sessionId, { time: 200, source: 'extension', kind: 'assistant_message',
    messageId, providerMessageId, message: text('Retain the authored answer.'), final: true });
  expect(await upsertRichMessage(sessionId, messageId, {
    version: 1, status: 'available', reason: null, conversationId: origin.conversationId,
    messageId, providerMessageId, revision: 0, accessibleText: 'Two reference images', nodes
  }, origin)).toBe('stored');
  await flushSessions();
  const file = path.join(sessionsRoot(), sessionId, 'messages',
    `${createHash('sha256').update(`assistant_message\u0000${messageId}`).digest('hex')}.json`);
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...original, richMedia: nodes.map(node => ({
    mediaId: node.mediaId, nodeId: node.id, source: { kind: 'page', nodeId: node.id },
    status: 'available', previewWidth: 5, previewHeight: 4, asset
  })) }), 'utf8');
  resetSessionStoreForTests(); initSessionStore(directory);
  return { file, messageId, origin };
}

it('retires a native and two future rich owners of one asset once, keeping metadata and restart tombstones', async () => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'shared owner', conversationId });
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#224466' } }).png().toBuffer();
  const shared = await writeAsset(session.id, png, 'image/png');
  const unrelated = await writeAsset(session.id, Buffer.from('not an image'), 'text/plain');
  const native = await upsertNativeImageEvent(session.id, { time: 100, source: 'extension', kind: 'native_image',
    messageId: 'provider-native', providerAssetId: 'provider-image', providerRole: 'tool',
    providerStatus: 'finished_successfully', previewStatus: 'available', asset: shared });
  const { messageId, origin } = await seedFutureRichOwner(session.id, shared);
  const before = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
  expect(before?.kind === 'assistant_message' && before.richMedia?.length).toBe(2);
  const cleared = await clearImageStorage('all');
  expect(cleared).toMatchObject({ removedFiles: 1, freedBytes: png.length });
  expect(await readAsset(session.id, shared.id)).toBeNull();
  expect(await readAsset(session.id, unrelated.id)).toEqual(Buffer.from('not an image'));
  const rows = await readEvents(session.id);
  const assistant = rows.find(row => row.kind === 'assistant_message');
  expect(assistant).toMatchObject({ messageId, retiredRichImageAssetIds: [shared.id] });
  if (assistant?.kind !== 'assistant_message') throw new Error('assistant missing');
  expect(assistant.richMedia).toHaveLength(2);
  expect(assistant.retiredRichMediaSlots).toMatchObject([
    { mediaId: 'media-one-left', nodeId: 'node-one-left' },
    { mediaId: 'media-one-right', nodeId: 'node-one-right' }
  ]);
  const incarnations = assertCleanupMarkers(assistant, shared.id);
  expect(assistant.richMedia?.every(media => media.status === 'unavailable' && media.reason === 'removed' && !media.asset)).toBe(true);
  expect(assistant.rich?.nodes).toEqual(before?.kind === 'assistant_message' ? before.rich?.nodes : undefined);
  expect(assistant.message).toEqual(before?.kind === 'assistant_message' ? before.message : undefined);
  expect(assistant.contentSeq).toBe(before?.kind === 'assistant_message' ? before.contentSeq : undefined);
  expect(rows.find(row => row.kind === 'native_image')).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
  expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({
    retiredRichImageAssetIds: [shared.id], richMedia: [
      { status: 'unavailable', reason: 'removed' }, { status: 'unavailable', reason: 'removed' }
    ] });
  const restored = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
  if (restored?.kind !== 'assistant_message') throw new Error('missing restored assistant');
  expect(assertCleanupMarkers(restored, shared.id)).toEqual(incarnations);
  expect(await upsertRichMedia(session.id, messageId, {
    mediaId: 'media-one-left', nodeId: 'node-one-left', source: { kind: 'page', nodeId: 'node-one-left' },
    status: 'available', asset: shared
  }, origin, 1)).toBe('refused');
  expect(await upsertRichMedia(session.id, messageId, {
    mediaId: 'media-one-left', nodeId: 'node-one-left', source: { kind: 'page', nodeId: 'node-one-left' },
    status: 'unavailable', reason: 'tainted'
  }, origin, 1)).toBe('refused');
  const { seq: _seq, origin: _origin, ...replay } = native.event;
  expect((await upsertNativeImageEvent(session.id, { ...replay, previewStatus: 'available', asset: shared })).accepted).toBe(false);
  // A user-cleared reference must never return as an auto-captured pending slot
  // when an old answer reappears after an actual physical A→B→A handover.
  const nextConversation = randomUUID();
  expect(await rebindSession(session.id, conversationId, nextConversation)).toBe(true);
  expect(await rebindSession(session.id, nextConversation, conversationId)).toBe(true);
  if (!assistant.rich) throw new Error('rich predecessor missing');
  expect(await upsertRichMessage(session.id, messageId, assistant.rich,
    { ...origin, bindingRevision: 2, documentId: 'reopened-after-clear', navigationEpoch: 0 },
    getRecordingRevision(), true)).toBe('stored');
  const returned = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
  if (returned?.kind !== 'assistant_message') throw new Error('missing replayed assistant');
  expect(assertCleanupMarkers(returned, shared.id)).toEqual(incarnations);
  expect(returned?.kind === 'assistant_message' && returned.richMedia).toEqual([
    { mediaId: 'media-one-left', nodeId: 'node-one-left', source: { kind: 'page', nodeId: 'node-one-left' },
      status: 'unavailable', reason: 'removed' },
    { mediaId: 'media-one-right', nodeId: 'node-one-right', source: { kind: 'page', nodeId: 'node-one-right' },
      status: 'unavailable', reason: 'removed' }
  ]);
  expect(await readAsset(session.id, shared.id)).toBeNull();
});

it('a failure on the SECOND owner shard vetoes every physical deletion and a later retry converges', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#556677' } }).png().toBuffer();
  const shared = await writeAsset(session.id, pixels, 'image/png');
  const first = await seedFutureRichOwner(session.id, shared, 'first');
  const second = await seedFutureRichOwner(session.id, shared, 'second');
  const rename = fs.rename.bind(fs);
  let shardWrites = 0;
  const failure = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to).includes(`${path.sep}messages${path.sep}`) && ++shardWrites === 2) throw new Error('second shard failed');
    return rename(from, to);
  }) as typeof fs.rename);
  await expect(clearImageStorage('all')).rejects.toThrow('second shard failed');
  expect(shardWrites).toBe(2);
  expect(await readAsset(session.id, shared.id)).toEqual(pixels);
  const firstCommitted = JSON.parse(await fs.readFile(first.file, 'utf8'));
  const firstIncarnations = assertCleanupMarkers(firstCommitted, shared.id);
  expect(JSON.parse(await fs.readFile(second.file, 'utf8')).retiredRichMediaSlots).toBeUndefined();
  failure.mockRestore();
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
  const assistants = (await readEvents(session.id)).filter(row => row.kind === 'assistant_message');
  expect(assistants).toHaveLength(2);
  for (const row of assistants) {
    expect(row).toMatchObject({ retiredRichImageAssetIds: [shared.id],
      richMedia: [{ reason: 'removed' }, { reason: 'removed' }] });
    if (row.kind !== 'assistant_message') throw new Error('missing assistant');
    assertCleanupMarkers(row, shared.id);
  }
  const finalFirst = JSON.parse(await fs.readFile(first.file, 'utf8'));
  expect(assertCleanupMarkers(finalFirst, shared.id)).toEqual(firstIncarnations);
});

it('reconciles a physically committed first cleanup rename whose acknowledgment was lost before metadata or another cleanup', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#446699' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const { file, messageId, origin } = await seedFutureRichOwner(session.id, asset);
  const rename = fs.rename.bind(fs);
  let injected = false;
  const lostAck = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!injected && String(to) === file) {
      await rename(from, to);
      injected = true;
      throw new Error('cleanup rename committed but acknowledgment lost');
    }
    return rename(from, to);
  }) as typeof fs.rename);
  await expect(clearImageStorage('all')).rejects.toThrow('acknowledgment lost');
  lostAck.mockRestore();
  expect(injected).toBe(true);
  expect(await readAsset(session.id, asset.id)).toEqual(pixels); // Uncertain cleanup never unlinks.
  const committed = JSON.parse(await fs.readFile(file, 'utf8'));
  const incarnations = assertCleanupMarkers(committed, asset.id);

  // Same process and same cached session: stale available media must not erase a
  // physically committed removal through ordinary metadata or a second cleanup.
  await upsertMessageEvent(session.id, { time: 201, source: 'extension', kind: 'assistant_message',
    messageId, providerMessageId: committed.providerMessageId,
    message: text('Retain the authored answer.'), final: true,
    renderedHtml: text('<p>Different presentation metadata</p>') });
  const afterMetadata = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(assertCleanupMarkers(afterMetadata, asset.id)).toEqual(incarnations);
  expect(afterMetadata.richMedia.every((media: { status: string; reason: string; asset?: unknown }) =>
    media.status === 'unavailable' && media.reason === 'removed' && !media.asset)).toBe(true);
  expect(await upsertRichMedia(session.id, messageId, {
    mediaId: 'media-one-left', nodeId: 'node-one-left', source: { kind: 'page', nodeId: 'node-one-left' },
    status: 'pending'
  }, origin, 1)).toBe('refused');
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect(assertCleanupMarkers(JSON.parse(await fs.readFile(file, 'utf8')), asset.id)).toEqual(incarnations);
});

it('preserves both physical owner tombstones when the second rename commits but its acknowledgment is lost', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#5577aa' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const first = await seedFutureRichOwner(session.id, asset, 'first');
  const second = await seedFutureRichOwner(session.id, asset, 'second');
  const rename = fs.rename.bind(fs);
  let injected = false;
  const lostAck = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!injected && String(to) === second.file) {
      await rename(from, to);
      injected = true;
      throw new Error('second cleanup ACK lost');
    }
    return rename(from, to);
  }) as typeof fs.rename);
  await expect(clearImageStorage('all')).rejects.toThrow('second cleanup ACK lost');
  lostAck.mockRestore();
  expect(injected).toBe(true);
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
  const originalFirst = assertCleanupMarkers(JSON.parse(await fs.readFile(first.file, 'utf8')), asset.id);
  const originalSecond = assertCleanupMarkers(JSON.parse(await fs.readFile(second.file, 'utf8')), asset.id);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect(assertCleanupMarkers(JSON.parse(await fs.readFile(first.file, 'utf8')), asset.id)).toEqual(originalFirst);
  expect(assertCleanupMarkers(JSON.parse(await fs.readFile(second.file, 'utf8')), asset.id)).toEqual(originalSecond);
});

it('preserves an indeterminate cleanup shard through restart without blocking valid or new message keys', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#447799' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const { file, messageId, origin } = await seedFutureRichOwner(session.id, asset);
  const healthy = await seedFutureRichOwner(session.id, asset, 'healthy');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const providerMessageId: string = original.providerMessageId;
  const rename = fs.rename.bind(fs);
  let injected = false;
  const damaged = '{"corrupt":"no provable committed canonical owner"}';
  const lostAck = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!injected && String(to) === file) {
      await rename(from, to);
      await fs.writeFile(file, damaged, 'utf8');
      injected = true;
      throw new Error('cleanup physical owner indeterminate');
    }
    return rename(from, to);
  }) as typeof fs.rename);
  await expect(clearImageStorage('all')).rejects.toThrow('indeterminate');
  lostAck.mockRestore();
  expect(injected).toBe(true);
  const metadata = upsertMessageEvent(session.id, { time: 201, source: 'extension', kind: 'assistant_message',
    messageId, providerMessageId,
    message: text('Retain the authored answer.'), final: true,
    renderedHtml: text('<p>Must not replace an unprovable physical owner</p>') });
  await expect(metadata).rejects.toThrow('Canonical cleanup ownership is uncertain');
  await expect(upsertRichMessage(session.id, messageId, {
    ...original.rich, accessibleText: 'Changed rich content cannot bypass cleanup quarantine'
  }, origin, getRecordingRevision(), true)).rejects.toThrow('Canonical cleanup ownership is uncertain');
  await expect(clearImageStorage('all')).rejects.toThrow('Canonical cleanup ownership is uncertain');
  expect(await fs.readFile(file, 'utf8')).toBe(damaged);
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);

  // The process quarantine is deliberately cleared by real initialization. A
  // permissive history read skips the damaged SHA shard; it must not make that
  // same physical path available for ordinary re-observation after restart.
  resetSessionStoreForTests(); initSessionStore(directory);
  await expect(upsertMessageEvent(session.id, {
    time: 202, source: 'extension', kind: 'assistant_message', messageId, providerMessageId,
    message: text('Retain the authored answer.'), final: true,
    renderedHtml: text('<p>Restart cannot overwrite an unprovable owner</p>')
  })).rejects.toThrow('Canonical message predecessor is uncertain');
  expect(await upsertRichMessage(session.id, messageId, original.rich, origin,
    getRecordingRevision(), true)).toBe('refused');
  expect(await fs.readFile(file, 'utf8')).toBe(damaged);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0, freedBytes: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);

  // A corrupt owner must not turn into a session-wide write ban after restart:
  // the untouched valid shard can advance and a truly absent key can be created.
  const healthyBefore = JSON.parse(await fs.readFile(healthy.file, 'utf8'));
  expect((await upsertMessageEvent(session.id, {
    time: 203, source: 'extension', kind: 'assistant_message', messageId: healthy.messageId,
    providerMessageId: healthyBefore.providerMessageId,
    message: text('Retain the authored answer.'), final: true,
    renderedHtml: text('<p>Valid predecessor revision</p>')
  })).changed).toBe(true);
  expect(JSON.parse(await fs.readFile(healthy.file, 'utf8')).renderedHtml).toEqual(text('<p>Valid predecessor revision</p>'));
  const freshId = 'new-after-corrupt-owner';
  expect((await upsertMessageEvent(session.id, {
    time: 204, source: 'extension', kind: 'user_message', messageId: freshId,
    message: text('New legitimate message')
  })).changed).toBe(true);
  const freshFile = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update(`user_message\u0000${freshId}`).digest('hex')}.json`);
  expect(JSON.parse(await fs.readFile(freshFile, 'utf8')).messageId).toBe(freshId);
  expect(await fs.readFile(file, 'utf8')).toBe(damaged);
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('rejects forged four-field cleanup provenance without rewriting the owner or restoring removed pixels', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#445588' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const { file, messageId, origin } = await seedFutureRichOwner(session.id, asset);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  const valid = JSON.parse(await fs.readFile(file, 'utf8'));
  const original = valid.retiredRichMediaSlots as Array<{
    mediaId: string; nodeId: string; removalIncarnation: string; retiredAssetId: string
  }>;
  expect(assertCleanupMarkers(valid, asset.id)).toHaveLength(2);
  const altered = [
    [{ ...original[0], removalIncarnation: undefined }, original[1]],
    [{ ...original[0], retiredAssetId: undefined }, original[1]],
    [{ ...original[0], removalIncarnation: original[1]!.removalIncarnation }, original[1]],
    [{ ...original[0], removalIncarnation: original[1]!.removalIncarnation.toUpperCase() }, original[1]],
    [{ ...original[0], removalIncarnation: randomUUID() + '-extra' }, original[1]],
    [{ ...original[0], retiredAssetId: 'f'.repeat(32) + '.bin' }, original[1]],
    [{ ...original[0], url: 'https://example.test/unsafe' }, original[1]]
  ];
  for (const markers of altered) {
    const invalid = JSON.stringify({ ...valid, retiredRichMediaSlots: markers });
    await fs.writeFile(file, invalid, 'utf8');
    resetSessionStoreForTests(); initSessionStore(directory);
    expect(await upsertRichMessage(session.id, messageId, valid.rich, origin,
      getRecordingRevision(), true)).toBe('refused');
    expect(await fs.readFile(file, 'utf8')).toBe(invalid);
    expect(await readAsset(session.id, asset.id)).toBeNull();
  }
  const withoutRetiredList = JSON.stringify({ ...valid, retiredRichImageAssetIds: undefined });
  await fs.writeFile(file, withoutRetiredList, 'utf8');
  resetSessionStoreForTests(); initSessionStore(directory);
  expect(await upsertRichMessage(session.id, messageId, valid.rich, origin,
    getRecordingRevision(), true)).toBe('refused');
  expect(await fs.readFile(file, 'utf8')).toBe(withoutRetiredList);
  await fs.writeFile(file, JSON.stringify(valid), 'utf8');
  resetSessionStoreForTests(); initSessionStore(directory);
  const recovered = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
  if (recovered?.kind !== 'assistant_message') throw new Error('missing recovered assistant');
  expect(assertCleanupMarkers(recovered, asset.id)).toEqual(original.map(marker => marker.removalIncarnation));
});

it('vetoes deletion if a future canonical owner shard or the legacy owner map is unreadable', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#778899' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const { file } = await seedFutureRichOwner(session.id, asset);
  await fs.writeFile(file, '{corrupt-json', 'utf8');
  resetSessionStoreForTests(); initSessionStore(directory);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
  await fs.writeFile(file, ' '.repeat(1024 * 1024 + 1));
  resetSessionStoreForTests(); initSessionStore(directory);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
  await fs.rm(file);
  await fs.writeFile(path.join(sessionsRoot(), session.id, 'messages.json'), '{broken');
  resetSessionStoreForTests(); initSessionStore(directory);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('keeps image bytes when a canonical-only rich owner directory disappears before restart', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#334477' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  await seedFutureRichOwner(session.id, asset);
  await fs.rm(path.join(sessionsRoot(), session.id, 'messages'), { recursive: true });
  resetSessionStoreForTests(); initSessionStore(directory);

  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0, freedBytes: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('keeps image bytes when the missing journal might contain another durable owner', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#775544' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  await appendEvent(session.id, { time: 100, source: 'app', kind: 'user_message',
    messageId: 'journal-only-owner', message: text('Retain journal image'), assets: [asset] });
  await flushSessions();
  await fs.rm(path.join(sessionsRoot(), session.id, 'events.jsonl'));
  resetSessionStoreForTests(); initSessionStore(directory);

  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0, freedBytes: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('keeps image bytes when the legacy owner map disappears before restart', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#774455' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const legacyOwner = { seq: 1, time: 100, source: 'app', kind: 'user_message',
    messageId: 'legacy-only-owner', message: text('Retain legacy image'), assets: [asset] };
  await fs.writeFile(path.join(sessionsRoot(), session.id, 'messages.json'), JSON.stringify({
    'user_message\u0000legacy-only-owner': legacyOwner
  }));
  resetSessionStoreForTests(); initSessionStore(directory);
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message')).toMatchObject({ assets: [asset] });
  await fs.rm(path.join(sessionsRoot(), session.id, 'messages.json'));
  resetSessionStoreForTests(); initSessionStore(directory);

  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0, freedBytes: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('cleans image bytes from a fresh session with no authored messages', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#445577' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');

  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect(await readAsset(session.id, asset.id)).toBeNull();
});

it('vetoes deletion when the journal exceeds the bounded owner inventory scan', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#667744' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  await fs.truncate(path.join(sessionsRoot(), session.id, 'events.jsonl'), 64 * 1024 * 1024 + 1);
  resetSessionStoreForTests(); initSessionStore(directory);

  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0, freedBytes: 0 });
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('vetoes unreadable shard I/O rather than trusting an already-loaded in-memory owner map', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#448866' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  const { file } = await seedFutureRichOwner(session.id, asset);
  expect((await readEvents(session.id)).find(event => event.kind === 'assistant_message')).toBeDefined();
  const realRead = fs.readFile.bind(fs);
  const failure = vi.spyOn(fs, 'readFile').mockImplementation(((name, ...args) =>
    String(name) === file ? Promise.reject(Object.assign(new Error('owner unreadable'), { code: 'EACCES' })) :
      (realRead as (...args: unknown[]) => Promise<unknown>)(name, ...args)) as typeof fs.readFile);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 0 });
  failure.mockRestore();
  expect(await readAsset(session.id, asset.id)).toEqual(pixels);
});

it('does not confuse identical content-addressed image IDs across different sessions', async () => {
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#aa7744' } }).png().toBuffer();
  const first = await createSession({ conversationId: randomUUID() });
  const second = await createSession({ conversationId: randomUUID() });
  const left = await writeAsset(first.id, pixels, 'image/png');
  const right = await writeAsset(second.id, pixels, 'image/png');
  expect(left.id).toBe(right.id);
  await seedFutureRichOwner(first.id, left, 'left');
  await seedFutureRichOwner(second.id, right, 'right');
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 2, freedBytes: pixels.length * 2 });
  for (const id of [first.id, second.id]) {
    expect(await readAsset(id, left.id)).toBeNull();
    expect((await readEvents(id)).find(row => row.kind === 'assistant_message')).toMatchObject({
      retiredRichImageAssetIds: [left.id] });
  }
});

it('serializes newly queued owner publication before deletion inventory instead of using a stale prequeue snapshot', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#5599aa' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  let entered!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const atWrite = new Promise<void>(resolve => { entered = resolve; });
  const realRename = fs.rename.bind(fs);
  const hold = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to).includes(`${path.sep}messages${path.sep}`)) {
      entered();
      await blocked;
    }
    return realRename(from, to);
  }) as typeof fs.rename);
  const owner = upsertMessageEvent(session.id, {
    time: 300, source: 'app', kind: 'user_message', messageId: 'new-before-cleanup',
    message: text('A new owner was queued first'), assets: [asset]
  });
  await atWrite;
  const cleanup = clearImageStorage('all');
  release();
  await owner;
  const result = await cleanup;
  hold.mockRestore();
  expect(result).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect((await readEvents(session.id)).find(row => row.kind === 'user_message')).toMatchObject({
    assets: undefined, retiredImageAssetIds: [asset.id] });
  expect(await readAsset(session.id, asset.id)).toBeNull();
});

it('reads cold usage without opening asset contents and reuses the maintained quota after writes', async () => {
  const session = await createSession({ title: 'Usage accounting' });
  const bytes = Buffer.from('stored asset');
  await writeAsset(session.id, bytes, 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);
  const openFile = vi.spyOn(fs, 'open');
  expect(await getImageStorage()).toEqual({ usedBytes: bytes.length, limitBytes: MAX_GLOBAL_ASSET_BYTES });
  expect(openFile).not.toHaveBeenCalled();
  const scan = vi.spyOn(fs, 'opendir');
  expect((await getImageStorage()).usedBytes).toBe(bytes.length);
  expect(scan).not.toHaveBeenCalled();
  await writeAsset(session.id, Buffer.from('another asset'), 'text/plain');
  expect((await getImageStorage()).usedBytes).toBe(bytes.length + Buffer.byteLength('another asset'));
  expect(scan).not.toHaveBeenCalled();
});

it('clears only persisted images after retiring every durable reference and never reacquires an exact removed native image', async () => {
  const session = await createSession({ conversationId: 'image-storage', title: 'Image storage' });
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#113355' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 6, height: 3, channels: 3, background: '#775533' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 7, height: 2, channels: 3, background: '#337755' } }).webp().toBuffer();
  const [userImage, toolImage, nativeImage] = await Promise.all([
    writeAsset(session.id, png, 'image/png'),
    writeAsset(session.id, jpeg, 'image/jpeg'),
    writeAsset(session.id, webp, 'image/webp')
  ]);
  const overflow = await writeAsset(session.id, Buffer.from('preserve exact text'), 'text/plain');
  const binary = await writeAsset(session.id, Buffer.from([1, 2, 3, 4, 5]), 'application/octet-stream');

  await upsertMessageEvent(session.id, {
    time: 100, source: 'app', kind: 'user_message', messageId: 'input:image-storage',
    message: text('Keep the transcript'), assets: [userImage]
  });
  await appendEvent(session.id, {
    time: 110, source: 'mcp', kind: 'tool_call', call: {
      callId: 'image-tool-call', tool: 'view_image', requestId: 'image-storage-request',
      conversationId: 'image-storage', attribution: 'request_id', attributionMethod: 'request_id',
      args: text('{}'), result: { ...text(''), assetId: overflow.id }, outcome: 'ok', durationMs: 1,
      summary: { kind: 'read', title: 'Viewed image', tone: 'neutral' }, assets: [toolImage]
    }
  });
  const native = await upsertNativeImageEvent(session.id, {
    time: 120, source: 'extension', kind: 'native_image', messageId: 'native-image-message',
    providerAssetId: 'file_00000000000000000000000000000001', providerRole: 'tool',
    providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254,
    previewWidth: 7, previewHeight: 2, previewStatus: 'available', asset: nativeImage
  });

  const before = await getImageStorage();
  expect(before).toEqual({
    usedBytes: png.length + jpeg.length + webp.length + Buffer.byteLength('preserve exact text') + 5,
    limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  const cleared = await clearImageStorage('all');
  expect(cleared).toEqual({
    freedBytes: png.length + jpeg.length + webp.length,
    removedFiles: 3,
    usedBytes: Buffer.byteLength('preserve exact text') + 5,
    limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  expect(await readAsset(session.id, overflow.id)).toEqual(Buffer.from('preserve exact text'));
  expect(await readAsset(session.id, binary.id)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  expect(await readAsset(session.id, userImage.id)).toBeNull();

  const rows = await readEvents(session.id);
  const user = rows.find((event) => event.kind === 'user_message');
  const tool = rows.find((event) => event.kind === 'tool_call');
  const generated = rows.find((event) => event.kind === 'native_image');
  expect(user).toMatchObject({ assets: undefined, retiredImageAssetIds: [userImage.id] });
  expect(tool?.kind === 'tool_call' ? tool.call : null).toMatchObject({
    assets: undefined, retiredImageAssetIds: [toolImage.id], result: { assetId: overflow.id }
  });
  expect(generated).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  expect(generated?.kind === 'native_image' ? generated.asset : null).toBeUndefined();
  const { sessionImageSets } = await import('../src/main/session/store.js');
  const tombstone = await sessionImageSets(session.id, ['native-image-message']);
  expect(tombstone.sets[0]).toMatchObject({ completeness: 'unavailable', images: [{ hasPreview: false, previewError: 'removed' }] });
  expect(JSON.stringify(tombstone)).not.toMatch(/base64|https?:|data:/);

  const { seq: _seq, origin: _origin, ...nativeReplay } = native.event;
  const replay = await upsertNativeImageEvent(session.id, {
    ...nativeReplay, asset: nativeImage, previewStatus: 'available', previewError: undefined
  });
  expect(replay).toMatchObject({ changed: false, accepted: false });
  await upsertMessageEvent(session.id, {
    time: 130, source: 'app', kind: 'user_message', messageId: 'input:image-storage',
    message: text('Keep the transcript'), assets: [userImage]
  });
  expect((await readEvents(session.id)).find((event) => event.kind === 'user_message')).toMatchObject({
    assets: undefined, retiredImageAssetIds: [userImage.id]
  });

  resetSessionStoreForTests();
  initSessionStore(directory);
  const restored = (await readEvents(session.id)).find((event) => event.kind === 'native_image');
  expect(restored).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  expect(restored?.kind === 'native_image' ? restored.asset : null).toBeUndefined();
});

it('preserves a local quota failure across weaker page observations until a preview is actually stored', async () => {
  const session = await createSession({ conversationId: 'quota-precedence', title: 'Quota precedence' });
  const identity = {
    time: 200, source: 'extension' as const, kind: 'native_image' as const,
    messageId: 'quota-image-message', providerAssetId: 'file_00000000000000000000000000000002',
    providerRole: 'tool' as const, providerStatus: 'finished_successfully' as const
  };
  await upsertNativeImageEvent(session.id, {
    ...identity, previewStatus: 'unavailable', previewError: 'quota'
  });
  const replay = await upsertNativeImageEvent(session.id, {
    ...identity, time: 201, previewStatus: 'unavailable', previewError: 'not_loaded'
  });
  expect(replay.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'quota' });

  const pixels = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#224466' } }).webp().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/webp');
  const available = await upsertNativeImageEvent(session.id, {
    ...identity, time: 202, previewStatus: 'available', previewWidth: 3, previewHeight: 2, asset
  });
  expect(available.event).toMatchObject({ previewStatus: 'available', asset });
  expect(available.event.previewError).toBeUndefined();
});

it('fences a pre-cleanup asset reference even when its canonical publication lands after cleanup', async () => {
  const session = await createSession({ conversationId: 'cleanup-race', title: 'Cleanup race' });
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#662244' } }).png().toBuffer();
  const write = writeAsset(session.id, pixels, 'image/png');
  const cleanup = clearImageStorage('all');
  const asset = await write;
  const result = await cleanup;
  expect(result).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });

  await upsertMessageEvent(session.id, {
    time: 300, source: 'app', kind: 'user_message', messageId: 'input:late-image-reference',
    message: text('Late publication'), assets: [asset]
  });
  const row = (await readEvents(session.id)).find((event) => event.kind === 'user_message');
  expect(row).toMatchObject({ assets: undefined, retiredImageAssetIds: [asset.id] });
  expect(await readAsset(session.id, asset.id)).toBeNull();
});

it('does not traverse or delete an assets directory symlink', async () => {
  const session = await createSession({ conversationId: 'linked-assets', title: 'Linked assets' });
  const outside = path.join(directory, 'outside-images');
  await fs.mkdir(outside);
  const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#335577' } }).png().toBuffer();
  const outsideFile = path.join(outside, '0123456789abcdef0123456789abcdef.png');
  await fs.writeFile(outsideFile, pixels);
  await fs.symlink(outside, path.join(directory, 'sessions', session.id, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');

  expect(await getImageStorage()).toEqual({ usedBytes: 0, limitBytes: MAX_GLOBAL_ASSET_BYTES });
  expect(await clearImageStorage('all')).toEqual({
    freedBytes: 0, removedFiles: 0, usedBytes: 0, limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  expect(await fs.readFile(outsideFile)).toEqual(pixels);
});

it('returns one session\'s response-owned image metadata without preview bytes', async () => {
  const { sessionImageSets } = await import('../src/main/session/store.js');
  const first = await createSession({ title: 'A', conversationId: randomUUID() });
  const second = await createSession({ title: 'B', conversationId: randomUUID() });
  await upsertNativeImageEvent(first.id, { time: 1, source: 'extension', kind: 'native_image',
    messageId: 'response-a', providerAssetId: 'asset-a', providerRole: 'tool', previewStatus: 'pending' });
  await upsertNativeImageEvent(first.id, { time: 2, source: 'extension', kind: 'native_image',
    messageId: 'response-a', providerAssetId: 'asset-b', providerRole: 'tool',
    previewStatus: 'unavailable', previewError: 'quota' });
  await upsertNativeImageEvent(second.id, { time: 3, source: 'extension', kind: 'native_image',
    messageId: 'response-b', providerAssetId: 'asset-a', providerRole: 'tool', previewStatus: 'pending' });
  const owned = await sessionImageSets(first.id);
  expect(owned.truncated).toBe(false);
  expect(owned.sets.map(set => set.responseId)).toEqual(['response-a']);
  expect(owned.sets[0]!.images.map(image => image.providerAssetId)).toEqual(['asset-a', 'asset-b']);
  expect(owned.sets[0]!.completeness).toBe('partial');
  expect(JSON.stringify(owned)).not.toMatch(/base64|https?:|data:/);
  expect((await sessionImageSets(second.id)).sets.map(set => set.responseId)).toEqual(['response-b']);
  expect(await sessionImageSets(first.id)).toEqual(owned);
  const scoped = await sessionImageSets(first.id, ['response-a']);
  expect(scoped.sets.map(set => set.responseId)).toEqual(['response-a']);
  expect((await sessionImageSets(second.id, ['response-b'])).sets.map(set => set.responseId)).toEqual(['response-b']);
  expect(await sessionImageSets(first.id, ['response-a'])).toEqual(scoped);
});

it('marks image-set metadata truncated when one response exceeds the metadata cap', async () => {
  const { sessionImageSets } = await import('../src/main/session/store.js');
  const { IMAGE_SET_METADATA_LIMIT } = await import('../src/shared/chronology.js');
  const session = await createSession({ title: 'Cap', conversationId: randomUUID() });
  for (let index = 0; index < IMAGE_SET_METADATA_LIMIT + 1; index++) {
    await upsertNativeImageEvent(session.id, {
      time: index + 1, source: 'extension', kind: 'native_image', messageId: 'response-a',
      providerAssetId: `asset-${index}`, providerRole: 'tool', previewStatus: 'pending'
    });
  }
  const owned = await sessionImageSets(session.id);
  expect(owned.truncated).toBe(true);
  expect(owned.sets).toHaveLength(1);
  expect(owned.sets[0]!.images).toHaveLength(IMAGE_SET_METADATA_LIMIT);
  expect(JSON.stringify(owned)).not.toMatch(/base64|https?:|data:/);
});
