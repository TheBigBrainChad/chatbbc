import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/main/config.js';
import { defaultConfig, getConfig, getRecordingRevision, initConfigPath, saveConfig, updateConfig } from '../src/main/config.js';
import type { RichMediaState, RichOrigin, SessionEvent } from '../src/shared/session.js';
import type { RichNode, RichResponse } from '../src/shared/rich-response.js';
import {
  beginVerifiedPageRichMediaSource, clearImageStorage, createSession, flushSessions, getSession, initSessionStore,
  getImageStorage, inspectInertRichRetrySource, readAsset, readCanonicalRichMediaRetryEligibility,
  readEvents, readPageRichPixelTarget,
  rebindSession, resetSessionStoreForTests, settleVerifiedPageRichMedia, sessionsRoot,
  upsertMessageEvent, upsertNativeImageEvent, upsertRichMedia, upsertRichMessage, writeAsset
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let A: string;
let B: string;
const MESSAGE = 'assistant:working:exchange:1789552000000';
const PROVIDER = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
const OTHER_PROVIDER = '3150f756-bf2d-45fa-ac0f-45010b2239fc';
const documentOrigin = (bindingRevision = 0, conversationId = A, documentId = 'document-a', navigationEpoch = 1): RichOrigin =>
  ({ bindingRevision, conversationId, documentId, navigationEpoch });
const image = (id = 'image-node-b', mediaId = 'card-image-b'): RichNode =>
  ({ kind: 'image', id, mediaId, alt: 'Reference', width: 800, height: 600 });
const rich = (nodes: RichNode[] = [image()], providerMessageId = PROVIDER): RichResponse => ({
  version: 1, status: 'available', reason: null, conversationId: A, messageId: MESSAGE,
  providerMessageId, revision: 0, accessibleText: 'Referenced diagram', nodes
});
const answer = (content = 'A diagram follows.', providerMessageId = PROVIDER) => ({
  kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
  messageId: MESSAGE, providerMessageId, message: { text: content, chars: content.length, truncated: false },
  turnId: 'turn-owned', state: 'final' as const, final: true, goalEligible: true
});
const pending = (): RichMediaState => ({
  mediaId: 'card-image-b', nodeId: 'image-node-b', source: { kind: 'page', nodeId: 'image-node-b' }, status: 'pending'
});
const sourceToken = (character: string, sequence: number) =>
  `src_${character.repeat(32)}_${sequence.toString(36)}`;
const sourceProof = (revision: number, expectedSlotVersion = 0, sequence = 1, character = 'a',
  origin = documentOrigin(), expectedRecordingRevision = getRecordingRevision()) => ({
  messageId: MESSAGE, providerMessageId: PROVIDER,
  mediaId: pending().mediaId, nodeId: pending().nodeId,
  richRevision: revision, origin, expectedRecordingRevision, expectedSlotVersion,
  sourceIncarnation: sourceToken(character, sequence), sourceSequence: sequence
});
const asset = (character = 'f', bytes = 123) => ({
  id: `${character.repeat(32)}.bin`, mimeType: 'image/webp', bytes
});
const row = async (id: string) => (await readEvents(id)).find(
  (event): event is Extract<SessionEvent, { kind: 'assistant_message' }> => event.kind === 'assistant_message');
const shardFile = (id: string) => path.join(sessionsRoot(), id, 'messages',
  `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`);
async function prepared(nodes: RichNode[] = [image()]): Promise<string> {
  const session = await createSession({ title: 'rich media test', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  expect(await upsertRichMessage(session.id, MESSAGE, rich(nodes), documentOrigin())).toBe('stored');
  return session.id;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-rich-media-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});
beforeEach(() => {
  resetSessionStoreForTests();
  A = randomUUID(); B = randomUUID();
});
afterEach(async () => { vi.restoreAllMocks(); await saveConfig(defaultConfig()); });
afterAll(async () => { resetSessionStoreForTests(); await removeTempDir(dir); });

it('updates metadata on one existing canonical image slot atomically without making an image event, asset or work', async () => {
  const id = await prepared();
  const before = await row(id);
  const summary = await getSession(id);
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const first = await row(id);
  expect(first).toMatchObject({ messageId: MESSAGE, richMedia: [pending()],
    origin: before?.origin, time: before?.time, message: before?.message,
    contentSeq: before?.contentSeq, finalContentSeq: before?.finalContentSeq,
    goalEligible: before?.goalEligible, turnId: before?.turnId });
  expect(first!.seq).toBeGreaterThan(before!.seq);
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('unchanged');
  expect((await row(id))!.seq).toBe(first!.seq);
  const unavailable: RichMediaState = { ...pending(), status: 'unavailable', reason: 'tainted' };
  expect(await upsertRichMedia(id, MESSAGE, unavailable, documentOrigin(), 1)).toBe('stored');
  expect((await row(id))?.richMedia).toEqual([unavailable]);
  expect((await readEvents(id)).filter(event => event.kind === 'assistant_message')).toHaveLength(1);
  expect((await readEvents(id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  expect(await getSession(id)).toMatchObject({ events: summary?.events, estimatedTokens: summary?.estimatedTokens,
    contextTokens: summary?.contextTokens, lastAssistantFinalAt: summary?.lastAssistantFinalAt,
    activeTurnId: summary?.activeTurnId, finishTurn: summary?.finishTurn, updatedAt: summary?.updatedAt });
  expect(await fs.readdir(path.join(sessionsRoot(), id, 'assets')).catch(() => [])).toEqual([]);
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(id))?.richMedia).toEqual([unavailable]);
  expect(await upsertRichMedia(id, MESSAGE, unavailable, documentOrigin(), 1)).toBe('unchanged');
});

it('rejects foreign session, absent shard, provider, conversation, document, epoch and revision', async () => {
  const id = await prepared();
  const foreign = (await createSession({ title: 'other', conversationId: B })).id;
  expect(await upsertRichMedia(foreign, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  expect(await upsertRichMedia(id, 'missing-shard', pending(), documentOrigin(), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(0, B), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(0, A, 'different-document'), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(0, A, 'document-a', 2), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(0, A, 'document-a', 0), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 0)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 2)).toBe('refused');
  const missingSession = `missing-${randomUUID()}`;
  expect(await upsertRichMedia(missingSession, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  expect(await fs.stat(path.join(sessionsRoot(), missingSession)).then(() => true, () => false)).toBe(false);
  expect(await upsertRichMedia(id, MESSAGE, { ...pending(), source: {
    kind: 'native', providerMessageId: OTHER_PROVIDER, providerAssetId: 'asset-one'
  } }, documentOrigin(), 1)).toBe('refused');
  expect((await row(id))?.richMedia).toBeUndefined();
});

it('fences queued and restarted A→B→A binding even when the conversation string matches again', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const move = rebindSession(id, A, B);
  const stale = upsertRichMedia(id, MESSAGE, { ...pending(), status: 'unavailable', reason: 'tainted' }, documentOrigin(), 1);
  expect(await Promise.all([move, stale])).toEqual([true, 'refused']);
  expect(await rebindSession(id, B, A)).toBe(true);
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  expect(await upsertRichMessage(id, MESSAGE, rich(), documentOrigin(2, A, 'document-return', 0))).toBe('stored');
  expect((await row(id))?.richMedia).toBeUndefined(); // New owner cannot inherit stale pending metadata.
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(2, A, 'document-return', 0), 1)).toBe('stored');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  await flushSessions(); resetSessionStoreForTests();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
});

it('refuses missing/duplicated image nodes, misbound sources, URL identities and untrusted status, asset and bytes', async () => {
  const id = await prepared();
  const mutations: unknown[] = [
    { ...pending(), nodeId: 'absent-image' },
    { ...pending(), mediaId: 'absent-media' },
    { ...pending(), mediaId: 'https://example.test/image?token=secret' },
    { ...pending(), source: { kind: 'page', nodeId: 'different-image' } },
    { ...pending(), source: { kind: 'native', providerMessageId: PROVIDER, providerAssetId: 'https://example.test/x' } },
    { ...pending(), status: 'available' },
    { ...pending(), asset: { id: 'pretend', mimeType: 'image/webp', bytes: 10 } },
    { ...pending(), previewDataUrl: 'data:image/webp;base64,pretend' },
    { ...pending(), previewWidth: 800, previewHeight: 600 },
    { ...pending(), reason: 'arbitrary' },
    { ...pending(), status: 'unavailable' },
    { ...pending(), status: 'pending', reason: 'removed' },
    { ...pending(), source: { kind: 'page', nodeId: 'image-node-b', url: 'https://example.test/' } },
    { ...pending(), onclick: 'run()' }
  ];
  for (const mutation of mutations) {
    expect(await upsertRichMedia(id, MESSAGE, mutation as RichMediaState, documentOrigin(), 1)).toBe('refused');
  }
  const revoked = Proxy.revocable(pending(), {});
  revoked.revoke();
  expect(await upsertRichMedia(id, MESSAGE, revoked.proxy, documentOrigin(), 1)).toBe('refused');
  const duplicate = await prepared([image(), image('image-node-c')]);
  expect(await upsertRichMedia(duplicate, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  expect((await row(id))?.richMedia).toBeUndefined();
  expect((await row(duplicate))?.richMedia).toBeUndefined();
});

it('adopts at most 64 uniquely owned slots and refuses changing the source or regressing unavailable to pending', async () => {
  const nodes = Array.from({ length: 64 }, (_, index) => image(`image-${index}`, `media-${index}`));
  const id = await prepared(nodes);
  for (let index = 0; index < 64; index++) {
    const state: RichMediaState = { mediaId: `media-${index}`, nodeId: `image-${index}`,
      source: { kind: 'page', nodeId: `image-${index}` }, status: 'pending' };
    expect(await upsertRichMedia(id, MESSAGE, state, documentOrigin(), 1)).toBe('stored');
  }
  expect((await row(id))?.richMedia).toHaveLength(64);
  expect(await upsertRichMedia(id, MESSAGE, { mediaId: 'media-0', nodeId: 'image-0',
    source: { kind: 'native', providerMessageId: PROVIDER, providerAssetId: 'provider-asset-0' }, status: 'pending'
  }, documentOrigin(), 1)).toBe('refused');
  const unavailable = { mediaId: 'media-0', nodeId: 'image-0', source: { kind: 'page' as const, nodeId: 'image-0' },
    status: 'unavailable' as const, reason: 'tainted' as const };
  expect(await upsertRichMedia(id, MESSAGE, unavailable, documentOrigin(), 1)).toBe('stored');
  expect(await upsertRichMedia(id, MESSAGE, { ...unavailable, status: 'pending', reason: 'not_loaded' }, documentOrigin(), 1)).toBe('refused');
  expect((await row(id))?.richMedia?.[0]).toEqual(unavailable);
  expect(await fs.readdir(path.join(sessionsRoot(), id, 'assets')).catch(() => [])).toEqual([]);
});

it('allows only inert native-source metadata with an exact provider ID, never an asset', async () => {
  const id = await prepared();
  const native: RichMediaState = { ...pending(), source: {
    kind: 'native', providerMessageId: PROVIDER, providerAssetId: 'generated-asset-1'
  } };
  expect(await upsertRichMedia(id, MESSAGE, native, documentOrigin(), 1)).toBe('stored');
  expect((await row(id))?.richMedia).toEqual([native]);
  expect((await readEvents(id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  expect(await upsertRichMedia(id, MESSAGE, { ...native, status: 'available' }, documentOrigin(), 1)).toBe('refused');
});

it('describes only a physically committed current PAGE slot for possible human retry, without issuing a grant', async () => {
  const id = await prepared();
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1)).toBeNull();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const before = await row(id);
  const eligible = await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1);
  expect(eligible).toEqual({ sessionId: id, conversationId: A, messageId: MESSAGE,
    providerMessageId: PROVIDER, bindingRevision: 0, documentId: 'document-a', navigationEpoch: 1,
    richRevision: 1, recordingRevision: getRecordingRevision(), cleanupEpoch: 0,
    presentationSeq: before!.seq, mediaId: pending().mediaId, nodeId: pending().nodeId,
    status: 'pending', reason: null, requiresRemovalConfirmation: false, source: 'page', eligibilityOnly: true });
  expect(Object.isFrozen(eligible)).toBe(true);
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 2)).toBeNull();
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, 'another-media', pending().nodeId, 1)).toBeNull();
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, 'another-node', 1)).toBeNull();
  const stale = await fs.readFile(shardFile(id));
  await fs.writeFile(shardFile(id), '{"broken":true}');
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1)).toBeNull();
  await fs.writeFile(shardFile(id), stale);
  const unavailable = { ...pending(), status: 'unavailable' as const, reason: 'tainted' as const };
  expect(await upsertRichMedia(id, MESSAGE, unavailable, documentOrigin(), 1)).toBe('stored');
  const updated = await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1);
  expect(updated).toMatchObject({ presentationSeq: (await row(id))!.seq,
    status: 'unavailable', reason: 'tainted', requiresRemovalConfirmation: false });
  expect(updated?.presentationSeq).toBeGreaterThan(eligible!.presentationSeq);
  expect((await row(id))?.richMedia).toEqual([unavailable]);
});

it('matches only the exact nonremoved physical PAGE retry source without conferring authority or writing', async () => {
  const inspect = inspectInertRichRetrySource;
  const id = await prepared([image('n-0', 'media-n-0')]);
  const page: RichMediaState = { mediaId: 'media-n-0', nodeId: 'n-0',
    source: { kind: 'page', nodeId: 'n-0' }, status: 'pending' };
  expect(await upsertRichMedia(id, MESSAGE, page, documentOrigin(), 1)).toBe('stored');
  const eligibility = await readCanonicalRichMediaRetryEligibility(id, MESSAGE, page.mediaId, page.nodeId, 1);
  expect(eligibility).not.toBeNull();
  const exact = {
    sessionId: id, conversationId: A, bindingRevision: 0, messageId: MESSAGE,
    providerMessageId: PROVIDER, richRevision: 1, presentationSeq: (await row(id))!.seq,
    mediaId: page.mediaId, nodeId: page.nodeId, originDocumentId: 'document-a',
    originNavigationEpoch: 1, recordingRevision: getRecordingRevision(),
    recordingGeneration: config.recordingGenerationGrant()!, cleanupEpoch: eligibility!.cleanupEpoch
  };
  const physical = await fs.readFile(shardFile(id));
  const match = Object.freeze({ kind: 'source_matches', authority: 'none' });
  expect(await inspect(exact)).toEqual(match);
  expect(Object.isFrozen(await inspect(exact))).toBe(true);
  expect(await fs.readFile(shardFile(id))).toEqual(physical);
  expect(await fs.readdir(path.join(sessionsRoot(), id, 'assets')).catch(() => [])).toEqual([]);
  for (const drift of [
    { sessionId: `missing-${randomUUID()}` }, { conversationId: B }, { bindingRevision: 2 },
    { messageId: 'different-message' }, { providerMessageId: OTHER_PROVIDER },
    { richRevision: 2 }, { presentationSeq: exact.presentationSeq - 1 },
    { mediaId: 'media-n-1' }, { nodeId: 'n-1' }, { originDocumentId: 'new-document' },
    { originNavigationEpoch: 2 }, { recordingRevision: exact.recordingRevision + 1 },
    { recordingGeneration: 'x'.repeat(43) }, { cleanupEpoch: exact.cleanupEpoch + 1 }
  ]) expect(await inspect({ ...exact, ...drift })).toBeNull();
  const unexpectedField = { ...exact, confirmRemoved: true };
  expect(await inspect(unexpectedField)).toBeNull();
  expect(await inspect({ ...exact, get source() { throw new Error('unexpected getter'); } })).toBeNull();

  const unavailable: RichMediaState = { ...page, status: 'unavailable', reason: 'tainted' };
  expect(await upsertRichMedia(id, MESSAGE, unavailable, documentOrigin(), 1)).toBe('stored');
  const fresh = { ...exact, presentationSeq: (await row(id))!.seq };
  expect(await inspect(exact)).toBeNull();
  expect(await inspect(fresh)).toEqual(match);
  expect(await fs.readFile(shardFile(id), 'utf8')).toContain('"tainted"');

  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  expect(await inspect(fresh)).toBeNull();
  await updateConfig(current => ({ ...current, sessions: { ...current.sessions, record: true } }));
  expect(await inspect(fresh)).toBeNull(); // Off→On cannot reuse the original persisted G.
});

it('refuses a matching PAGE expectation for removed, available, native or corrupt physical sources', async () => {
  const inspect = inspectInertRichRetrySource;
  const page: RichMediaState = { mediaId: 'media-n-0', nodeId: 'n-0',
    source: { kind: 'page', nodeId: 'n-0' }, status: 'pending' };
  const id = await prepared([image('n-0', 'media-n-0')]);
  expect(await upsertRichMedia(id, MESSAGE, page, documentOrigin(), 1)).toBe('stored');
  const eligibility = await readCanonicalRichMediaRetryEligibility(id, MESSAGE, page.mediaId, page.nodeId, 1);
  const expected = { sessionId: id, conversationId: A, bindingRevision: 0,
    messageId: MESSAGE, providerMessageId: PROVIDER, richRevision: 1,
    presentationSeq: (await row(id))!.seq, mediaId: page.mediaId, nodeId: page.nodeId,
    originDocumentId: 'document-a', originNavigationEpoch: 1,
    recordingRevision: getRecordingRevision(), recordingGeneration: config.recordingGenerationGrant()!,
    cleanupEpoch: eligibility!.cleanupEpoch };
  const original = await fs.readFile(shardFile(id));
  await fs.writeFile(shardFile(id), '{"corrupt":"no physical owner"}');
  expect(await inspect(expected)).toBeNull();
  expect(await fs.readFile(shardFile(id), 'utf8')).toBe('{"corrupt":"no physical owner"}');
  await fs.writeFile(shardFile(id), original);
  const removed: RichMediaState = { ...page, status: 'unavailable', reason: 'removed' };
  expect(await upsertRichMedia(id, MESSAGE, removed, documentOrigin(), 1)).toBe('stored');
  expect(await inspect({ ...expected, presentationSeq: (await row(id))!.seq })).toBeNull();
  const saved = JSON.parse(await fs.readFile(shardFile(id), 'utf8'));
  const retiredAssetId = `${'e'.repeat(32)}.bin`;
  await fs.writeFile(shardFile(id), JSON.stringify({ ...saved,
    retiredRichImageAssetIds: [retiredAssetId],
    retiredRichMediaSlots: [{ mediaId: page.mediaId, nodeId: page.nodeId,
      removalIncarnation: randomUUID(), retiredAssetId }]
  }));
  resetSessionStoreForTests();
  expect(await inspect({ ...expected, presentationSeq: saved.seq })).toBeNull();

  const availableId = await prepared([image('n-0', 'media-n-0')]);
  expect(await upsertRichMedia(availableId, MESSAGE, page, documentOrigin(), 1)).toBe('stored');
  const available = (await row(availableId))!;
  await fs.writeFile(shardFile(availableId), JSON.stringify({ ...available,
    richMedia: [{ ...page, status: 'available', previewWidth: 5, previewHeight: 4,
      asset: { id: `${'a'.repeat(32)}.bin`, mimeType: 'image/webp', bytes: 100 } }]
  }));
  resetSessionStoreForTests();
  expect(await inspect({ ...expected, sessionId: availableId,
    presentationSeq: available.seq })).toBeNull();

  const nativeId = await prepared([image('n-0', 'media-n-0')]);
  expect(await upsertRichMedia(nativeId, MESSAGE, { ...page,
    source: { kind: 'native', providerMessageId: PROVIDER, providerAssetId: 'native-asset' }
  }, documentOrigin(), 1)).toBe('stored');
  expect(await inspect({ ...expected, sessionId: nativeId,
    presentationSeq: (await row(nativeId))!.seq })).toBeNull();
});

it('refuses retry eligibility if the exact physical assistant is replaced while unique-owner lookup awaits', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const file = shardFile(id);
  const original = await fs.readFile(file);
  const actualReadDir = fs.readdir.bind(fs);
  let replaced = false;
  const spy = vi.spyOn(fs, 'readdir').mockImplementation((async (...args) => {
    if (!replaced && String(args[0]) === sessionsRoot()) {
      replaced = true;
      // The first physical shard inspection has finished; catalog acquisition is
      // the next independent await. This is an external replacement, not a store upsert.
      await fs.writeFile(file, '{"corrupt":"second-source-read-required"}');
    }
    return Reflect.apply(actualReadDir, fs, args);
  }) as typeof fs.readdir);
  try {
    expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId,
      pending().nodeId, 1)).toBeNull();
    expect(replaced).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('second-source-read-required');
  } finally {
    spy.mockRestore();
    await fs.writeFile(file, original);
  }
  // A fresh exact source read must still work after restoring the genuine shard.
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId,
    pending().nodeId, 1)).toMatchObject({ eligibilityOnly: true, source: 'page' });
});

it('does not invent a native tuple-to-rich-node association even when the native preview is available', async () => {
  const id = await prepared();
  const bytes = await sharp({ create: { width: 5, height: 4, channels: 3,
    background: '#123456' } }).webp().toBuffer();
  const imageAsset = await writeAsset(id, bytes, 'image/webp');
  const providerAssetId = 'file_observedNativeAssetA';
  await upsertNativeImageEvent(id, { kind: 'native_image', source: 'extension', time: 101,
    messageId: PROVIDER, providerAssetId, providerRole: 'tool', previewStatus: 'available',
    previewWidth: 5, previewHeight: 4, asset: imageAsset });
  const syntheticNative = { ...pending(), source: {
    kind: 'native' as const, providerMessageId: PROVIDER, providerAssetId } };
  expect(await upsertRichMedia(id, MESSAGE, syntheticNative, documentOrigin(), 1)).toBe('stored');
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1)).toBeNull();
  expect(await upsertRichMedia(id, MESSAGE, { ...syntheticNative, status: 'available',
    previewWidth: 5, previewHeight: 4, asset: imageAsset }, documentOrigin(), 1)).toBe('refused');
  for (const source of [
    { kind: 'native' as const, providerMessageId: OTHER_PROVIDER, providerAssetId },
    { kind: 'native' as const, providerMessageId: PROVIDER, providerAssetId: 'file_wrongAssetId' }
  ]) {
    expect(await upsertRichMedia(id, MESSAGE, { ...syntheticNative, source }, documentOrigin(), 1)).toBe('refused');
  }
  expect((await row(id))?.richMedia).toEqual([syntheticNative]);
});

it('describes a removed PAGE slot only with explicit confirmation and never removes its durable fence', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const removed = { ...pending(), status: 'unavailable' as const, reason: 'removed' as const };
  expect(await upsertRichMedia(id, MESSAGE, removed, documentOrigin(), 1)).toBe('stored');
  await expect(readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1))
    .resolves.toMatchObject({ status: 'unavailable', reason: 'removed', requiresRemovalConfirmation: true });
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(id))?.retiredRichMediaSlots).toEqual([
    { mediaId: removed.mediaId, nodeId: removed.nodeId }
  ]); // Metadata removal is legacy; no cleanup-only UUID is minted on restart.
  await expect(readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1))
    .resolves.toMatchObject({ requiresRemovalConfirmation: true });
  const committed = JSON.parse(await fs.readFile(shardFile(id), 'utf8'));
  await fs.writeFile(shardFile(id), JSON.stringify({ ...committed, retiredRichMediaSlots: [] }));
  resetSessionStoreForTests();
  expect(await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1)).toBeNull();
});

it('revokes a read-only retry snapshot across Recording Off→On, rebind and physical provider alias', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const match = () => readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1);
  const original = await match();
  expect(original).not.toBeNull();
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  expect(await match()).toBeNull();
  await updateConfig(current => ({ ...current, sessions: { ...current.sessions, record: true } }));
  const reopened = await match();
  expect(reopened?.recordingRevision).toBeGreaterThan(original!.recordingRevision);
  expect(await rebindSession(id, A, B)).toBe(true);
  expect(await match()).toBeNull();
  expect(await rebindSession(id, B, A)).toBe(true);
  expect(await match()).toBeNull();
  const newOrigin = documentOrigin(2, A, 'rebound-document', 0);
  expect(await upsertRichMessage(id, MESSAGE, rich(), newOrigin)).toBe('stored');
  const latestRevision = (await row(id))!.rich!.revision;
  expect(await upsertRichMedia(id, MESSAGE, pending(), newOrigin, latestRevision)).toBe('stored');
  expect((await match())?.bindingRevision).toBe(2);
  const alias = { ...(await row(id)), messageId: 'another-assistant-message',
    rich: undefined, richOrigin: undefined, richMedia: undefined };
  const aliasFile = path.join(sessionsRoot(), id, 'messages',
    `${createHash('sha256').update('assistant_message\u0000another-assistant-message').digest('hex')}.json`);
  await fs.writeFile(aliasFile, JSON.stringify(alias));
  resetSessionStoreForTests();
  expect(await match()).toBeNull(); // One provider UUID cannot own two canonical assistants.
});

it('invalidates a queued retry-eligibility read immediately when image cleanup is requested', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  // An unrelated asset makes cleanup enter the same real session retirement path.
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: '#123456' } }).webp().toBuffer();
  await writeAsset(id, bytes, 'image/webp');
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realLstat = fs.lstat.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'lstat').mockImplementation((async (...args) => {
    if (!held && String(args[0]) === shardFile(id)) {
      held = true;
      entered();
      await gate;
    }
    return realLstat(...args);
  }) as typeof fs.lstat);
  const stale = readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1);
  await reached;
  const cleanup = clearImageStorage('all'); // Synchronously increments the cleanup request epoch.
  release();
  expect(await stale).toBeNull();
  spy.mockRestore();
  expect((await cleanup).removedFiles).toBeGreaterThanOrEqual(1);
  const fresh = await readCanonicalRichMediaRetryEligibility(id, MESSAGE, pending().mediaId, pending().nodeId, 1);
  expect(fresh).toMatchObject({ cleanupEpoch: 1, eligibilityOnly: true, status: 'pending' });
});

it('retains valid metadata across ordinary same-prose updates but invalidates changed prose, provider and rich owner', async () => {
  const id = await prepared();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const repeat = await upsertMessageEvent(id, { ...answer(), renderedHtml: {
    text: '<p>A diagram follows.</p>', chars: 25, truncated: false
  }, richMedia: [{ ...pending(), status: 'available' }],
  retiredRichImageAssetIds: ['forged'] } as Parameters<typeof upsertMessageEvent>[1]);
  expect(repeat.event.kind === 'assistant_message' && repeat.event.richMedia).toEqual([pending()]);
  expect(repeat.event.kind === 'assistant_message' && repeat.event.retiredRichImageAssetIds).toBeUndefined();
  const newRich = rich([{ kind: 'group', id: 'card', layout: 'card', children: [image()] }]);
  expect(await upsertRichMessage(id, MESSAGE, newRich, documentOrigin())).toBe('stored');
  expect((await row(id))?.richMedia).toBeUndefined();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 2)).toBe('stored');
  const changed = await upsertMessageEvent(id, answer('Different prose'));
  expect(changed.event.kind === 'assistant_message' && changed.event.richMedia).toBeUndefined();
  expect(changed.event.kind === 'assistant_message' && changed.event.rich).toBeUndefined();
  expect(await upsertRichMessage(id, MESSAGE, rich(), documentOrigin())).toBe('stored');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  const providerDrift = await upsertMessageEvent(id, answer('Different prose', OTHER_PROVIDER));
  expect(providerDrift.event.kind === 'assistant_message' && providerDrift.event.richMedia).toBeUndefined();
});

it('preserves existing removal tombstones and refuses metadata when Recording is Off', async () => {
  const id = await prepared();
  const stored = await row(id);
  await flushSessions(); resetSessionStoreForTests();
  await fs.writeFile(shardFile(id), JSON.stringify({ ...stored, retiredRichImageAssetIds: ['deleted-asset'] }), 'utf8');
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
  expect((await row(id))?.retiredRichImageAssetIds).toEqual(['deleted-asset']);
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(id))?.retiredRichImageAssetIds).toEqual(['deleted-asset']);
  expect(await upsertRichMedia(id, MESSAGE, { ...pending(), status: 'available',
    asset: { id: 'deleted-asset', mimeType: 'image/webp', bytes: 10 } }, documentOrigin(), 1)).toBe('refused');
  const enabled = config.getConfig();
  const off = vi.spyOn(config, 'getConfig').mockReturnValue({ ...enabled, sessions: { ...enabled.sessions, record: false } });
  try {
    expect(await upsertRichMedia(id, MESSAGE, { ...pending(), status: 'unavailable', reason: 'unsupported' }, documentOrigin(), 1)).toBe('refused');
  } finally { off.mockRestore(); }
  expect((await row(id))?.richMedia).toEqual([pending()]);
});

it('does not retain unvalidated persisted media or execute proxy getters from untrusted fields', async () => {
  const id = await prepared();
  let gets = 0;
  const spoof = new Proxy(pending(), { get(target, key, receiver) {
    gets++;
    return key === 'mediaId' ? 'https://evil.test/image' : Reflect.get(target, key, receiver);
  } });
  expect(await upsertRichMedia(id, MESSAGE, spoof, documentOrigin(), 1)).toBe('stored');
  expect(gets).toBe(0);
  await flushSessions(); resetSessionStoreForTests();
  const original = await row(id);
  await fs.writeFile(shardFile(id), JSON.stringify({ ...original,
    richMedia: [{ ...pending(), status: 'available', asset: { id: 'unowned', mimeType: 'image/webp', bytes: 12 } }]
  }), 'utf8');
  resetSessionStoreForTests();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('refused');
  const clean = await upsertMessageEvent(id, { ...answer(), renderedHtml: {
    text: '<p>A diagram follows.</p>', chars: 25, truncated: false
  } });
  expect(clean.event.kind === 'assistant_message' && clean.event.richMedia).toBeUndefined();
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(id))?.richMedia).toBeUndefined();
});

it('does not publish a failed atomic shard write and recovers the original after restart', async () => {
  const id = await prepared();
  const prior = await row(id);
  const realRename = fs.rename.bind(fs);
  const fault = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to).includes(path.join(id, 'messages'))) throw new Error('simulated disk failure');
    return realRename(from, to);
  }) as typeof fs.rename);
  await expect(upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).rejects.toThrow('simulated disk failure');
  expect(await row(id)).toEqual(prior);
  fault.mockRestore();
  await flushSessions(); resetSessionStoreForTests();
  expect(await row(id)).toEqual(prior);
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1)).toBe('stored');
});

it('seeds exact page image slots in the verified rich shard write and retains the authored prefix after restart', async () => {
  const session = await createSession({ title: 'atomic rich media', conversationId: A });
  const first = await upsertMessageEvent(session.id, answer());
  const summary = await getSession(session.id);
  const nested = rich([{ kind: 'group', id: 'cards', layout: 'grid', children: [
    image('image-one', 'media-one'),
    { kind: 'group', id: 'nested', layout: 'card', children: [image('image-two', 'media-two')] }
  ] }]);
  const revision = getRecordingRevision();
  expect(await upsertRichMessage(session.id, MESSAGE, nested, documentOrigin(), revision, true)).toBe('stored');
  const expectedMedia: RichMediaState[] = [
    { mediaId: 'media-one', nodeId: 'image-one', source: { kind: 'page', nodeId: 'image-one' },
      status: 'pending', reason: 'not_loaded' },
    { mediaId: 'media-two', nodeId: 'image-two', source: { kind: 'page', nodeId: 'image-two' },
      status: 'pending', reason: 'not_loaded' }
  ];
  const onDisk = JSON.parse(await fs.readFile(shardFile(session.id), 'utf8')) as SessionEvent;
  expect(onDisk).toMatchObject({ kind: 'assistant_message', rich: { revision: 1 }, richMedia: expectedMedia,
    message: first.event.message, contentSeq: first.event.contentSeq });
  const stored = await row(session.id);
  expect(stored).toMatchObject({ richMedia: expectedMedia, rich: { revision: 1 },
    message: first.event.message, contentSeq: first.event.contentSeq });
  expect(stored?.kind === 'assistant_message' && stored.finalContentSeq).toBe(
    first.event.kind === 'assistant_message' ? first.event.finalContentSeq : undefined);
  expect(stored?.kind === 'assistant_message' && stored.goalEligible).toBe(
    first.event.kind === 'assistant_message' ? first.event.goalEligible : undefined);
  expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  expect(await fs.readdir(path.join(sessionsRoot(), session.id, 'assets')).catch(() => [])).toEqual([]);
  expect(await getSession(session.id)).toMatchObject({ events: summary?.events,
    estimatedTokens: summary?.estimatedTokens, contextTokens: summary?.contextTokens,
    lastAssistantFinalAt: summary?.lastAssistantFinalAt, finishTurn: summary?.finishTurn });
  await flushSessions(); resetSessionStoreForTests();
  expect(await row(session.id)).toEqual(stored);
  expect(await fs.readFile(shardFile(session.id), 'utf8')).toBe(JSON.stringify(onDisk));
});

it('requires an original recording revision and opt-in; rejects duplicate image identities before touching the shard', async () => {
  const session = await createSession({ title: 'bounded rich slots', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const original = await fs.readFile(shardFile(session.id));
  const initial = await row(session.id);
  const duplicated = rich([image('image-first', 'same-media'), image('image-second', 'same-media')]);
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), undefined, true)).toBe('refused');
  expect(await upsertRichMessage(session.id, MESSAGE, duplicated, documentOrigin(),
    getRecordingRevision(), true)).toBe('refused');
  expect(await fs.readFile(shardFile(session.id))).toEqual(original);
  expect(await row(session.id)).toEqual(initial);
  // Existing generic caller behavior is unchanged: it stores rich presentation without seeding.
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin())).toBe('stored');
  expect((await row(session.id))?.richMedia).toBeUndefined();
  const richRevision = (await row(session.id))?.rich?.revision;
  // The same verified structure can subsequently seed its missing slot without minting new rich content.
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(),
    getRecordingRevision(), true)).toBe('stored');
  expect((await row(session.id))?.rich).toMatchObject({ revision: richRevision });
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded' }]);
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(),
    getRecordingRevision(), true)).toBe('unchanged');
});

it('retains prior pending/unavailable slots and removal tombstones across same-owner rich hydration', async () => {
  const session = await createSession({ title: 'hydrated media', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const firstTree = rich([image('image-one', 'media-one'), image('image-two', 'media-two')]);
  const revision = getRecordingRevision();
  expect(await upsertRichMessage(session.id, MESSAGE, firstTree, documentOrigin(), revision, true)).toBe('stored');
  const unavailable: RichMediaState = { mediaId: 'media-one', nodeId: 'image-one',
    source: { kind: 'page', nodeId: 'image-one' }, status: 'unavailable', reason: 'unsupported' };
  expect(await upsertRichMedia(session.id, MESSAGE, unavailable, documentOrigin(), 1, revision)).toBe('stored');
  await flushSessions(); resetSessionStoreForTests();
  const prior = await row(session.id);
  await fs.writeFile(shardFile(session.id), JSON.stringify({ ...prior,
    retiredRichImageAssetIds: ['removed-asset-id'] }), 'utf8');
  resetSessionStoreForTests();
  const changed = rich([{ kind: 'group', id: 'updated', layout: 'card', children: [
    image('image-one', 'media-one'), image('image-two', 'media-two'), image('image-three', 'media-three')
  ] }]);
  expect(await upsertRichMessage(session.id, MESSAGE, changed, documentOrigin(), revision, true)).toBe('stored');
  expect((await row(session.id))?.richMedia).toEqual([
    unavailable,
    { mediaId: 'media-two', nodeId: 'image-two', source: { kind: 'page', nodeId: 'image-two' },
      status: 'pending', reason: 'not_loaded' },
    { mediaId: 'media-three', nodeId: 'image-three', source: { kind: 'page', nodeId: 'image-three' },
      status: 'pending', reason: 'not_loaded' }
  ]);
  expect((await row(session.id))?.retiredRichImageAssetIds).toEqual(['removed-asset-id']);
  const accepted = await fs.readFile(shardFile(session.id));
  // A reused media identity cannot silently move an unavailable slot onto a different node.
  expect(await upsertRichMessage(session.id, MESSAGE,
    rich([image('impostor', 'media-one')]), documentOrigin(), revision, true)).toBe('refused');
  expect(await fs.readFile(shardFile(session.id))).toEqual(accepted);
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(session.id))?.richMedia?.[0]).toEqual(unavailable);
  expect((await row(session.id))?.retiredRichImageAssetIds).toEqual(['removed-asset-id']);
});

it('commits rich and pending slots in one physical rename before a successful Recording Off', async () => {
  const session = await createSession({ title: 'rich Off physical prefix', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const target = shardFile(session.id);
  const rename = fs.rename.bind(fs);
  let reached!: () => void;
  let release!: () => void;
  const physical = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let renames = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    await rename(from, to);
    if (String(to) === target) { renames++; reached(); await gate; }
  }) as typeof fs.rename);
  try {
    const accepted = upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(),
      getRecordingRevision(), true);
    await physical;
    const physicalShard = JSON.parse(await fs.readFile(target, 'utf8')) as SessionEvent;
    expect(physicalShard).toMatchObject({ rich: { revision: 1 },
      richMedia: [{ ...pending(), reason: 'not_loaded' }] });
    const off = saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
    release();
    expect(await accepted).toBe('stored');
    await off;
    expect(renames).toBe(1);
    expect(await fs.readFile(target, 'utf8')).toBe(JSON.stringify(physicalShard));
    await flushSessions(); resetSessionStoreForTests();
    expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded' }]);
  } finally {
    release();
    spy.mockRestore();
    await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
  }
});

it('fences a trusted metadata update by its original Recording revision after Off→On', async () => {
  const id = await prepared();
  const oldRevision = getRecordingRevision();
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
  const newRevision = getRecordingRevision();
  expect(newRevision).toBe(oldRevision + 2);
  const original = await fs.readFile(shardFile(id));
  resetSessionStoreForTests();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1, oldRevision)).toBe('refused');
  expect(await fs.readFile(shardFile(id))).toEqual(original);
  expect((await row(id))?.richMedia).toBeUndefined();
  expect(await upsertRichMedia(id, MESSAGE, pending(), documentOrigin(), 1, newRevision)).toBe('stored');
  expect((await row(id))?.richMedia).toEqual([pending()]);
  expect(await upsertRichMedia(id, MESSAGE, { ...pending(), status: 'unavailable', reason: 'tainted' },
    documentOrigin(), 1)).toBe('stored'); // Legacy omitted revision remains compatible.
});

it('refuses malformed durable rich predecessors without rewriting their shards or seeding media', async () => {
  const session = await createSession({ title: 'malformed prior rich', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin())).toBe('stored');
  await flushSessions(); resetSessionStoreForTests();
  const target = shardFile(session.id);
  const valid = JSON.parse(await fs.readFile(target, 'utf8')) as Extract<SessionEvent, { kind: 'assistant_message' }>;
  expect(valid.rich).toMatchObject({ revision: 1 });
  expect(valid.richMedia).toBeUndefined();
  const next = rich([{ kind: 'group', id: 'later-card', layout: 'card', children: [image()] }]);
  for (const invalid of [
    { ...valid.rich, revision: '3' },
    { ...valid.rich, conversationId: B },
    { ...valid.rich, messageId: 'different-logical-message' },
    { ...valid.rich, providerMessageId: OTHER_PROVIDER }
  ]) {
    const corrupted = JSON.stringify({ ...valid, rich: invalid });
    await fs.writeFile(target, corrupted, 'utf8');
    resetSessionStoreForTests();
    expect(await upsertRichMessage(session.id, MESSAGE, next, documentOrigin(),
      getRecordingRevision(), true)).toBe('refused');
    expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
  }
  await fs.writeFile(target, JSON.stringify(valid), 'utf8');
  resetSessionStoreForTests();
  expect(await upsertRichMessage(session.id, MESSAGE, next, documentOrigin(),
    getRecordingRevision(), true)).toBe('stored');
  expect((await row(session.id))?.rich).toMatchObject({ revision: 2 });
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded' }]);
});

it('never recreates a removed page slot after a new document, temporary omission, restart or replay', async () => {
  const session = await createSession({ title: 'durable slot removal', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const original = rich([image(), image('sibling-node', 'sibling-media')]);
  const revision = getRecordingRevision();
  expect(await upsertRichMessage(session.id, MESSAGE, original, documentOrigin(), revision, true)).toBe('stored');
  const removed: RichMediaState = { ...pending(), status: 'unavailable', reason: 'removed' };
  expect(await upsertRichMedia(session.id, MESSAGE, removed, documentOrigin(), 1, revision)).toBe('stored');
  const summary = await getSession(session.id);
  await flushSessions(); resetSessionStoreForTests();

  // A different physical document without a new durable binding is deliberately
  // refused by the existing ownership guard. Use a real A→B→A handover to prove
  // the new-document path under an independently committed revision.
  expect(await rebindSession(session.id, A, B)).toBe(true);
  expect(await rebindSession(session.id, B, A)).toBe(true);
  const reopened = documentOrigin(2, A, 'document-reopened', 0);
  expect(await upsertRichMessage(session.id, MESSAGE, original, reopened, revision, true)).toBe('stored');
  expect((await row(session.id))?.richMedia?.find(media => media.mediaId === removed.mediaId)).toEqual(removed);
  expect((await row(session.id))?.retiredRichMediaSlots).toEqual([
    { mediaId: removed.mediaId, nodeId: removed.nodeId }
  ]);
  // Hydration can temporarily omit an image. The slot's removal belongs to the
  // canonical assistant, not merely to the current image-bearing revision.
  expect(await upsertRichMessage(session.id, MESSAGE,
    rich([image('sibling-node', 'sibling-media')]), reopened, revision, true)).toBe('stored');
  expect((await row(session.id))?.richMedia).toHaveLength(1);
  await flushSessions(); resetSessionStoreForTests();
  expect((await row(session.id))?.retiredRichMediaSlots).toEqual([
    { mediaId: removed.mediaId, nodeId: removed.nodeId }
  ]);
  expect(await rebindSession(session.id, A, B)).toBe(true);
  expect(await rebindSession(session.id, B, A)).toBe(true);
  const latest = documentOrigin(4, A, 'document-latest', 0);
  expect(await upsertRichMessage(session.id, MESSAGE, original, latest, revision, true)).toBe('stored');
  expect((await row(session.id))?.richMedia?.find(media => media.mediaId === removed.mediaId)).toEqual(removed);
  expect(await upsertRichMedia(session.id, MESSAGE, pending(), latest,
    (await row(session.id))!.rich!.revision, revision)).toBe('refused');
  expect(await upsertRichMessage(session.id, MESSAGE,
    rich([image('impostor-node', removed.mediaId)]), latest, revision, true)).toBe('refused');
  expect(await getSession(session.id)).toMatchObject({ events: summary?.events,
    lastAssistantFinalAt: summary?.lastAssistantFinalAt, estimatedTokens: summary?.estimatedTokens });
  expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
});

it('treats persisted slot-tombstone corruption as a refusal and never admits page-supplied removal fences', async () => {
  const session = await createSession({ title: 'slot integrity', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true)).toBe('stored');
  const removed: RichMediaState = { ...pending(), status: 'unavailable', reason: 'removed' };
  expect(await upsertRichMedia(session.id, MESSAGE, removed, documentOrigin(), 1, revision)).toBe('stored');
  const expected = [{ mediaId: removed.mediaId, nodeId: removed.nodeId }];
  expect((await row(session.id))?.retiredRichMediaSlots).toEqual(expected);
  expect(await upsertRichMedia(session.id, MESSAGE, removed, documentOrigin(), 1, revision)).toBe('unchanged');
  expect((await row(session.id))?.retiredRichMediaSlots).toEqual(expected);

  // A raw observation can change prose, never rewrite a store-owned deletion decision.
  const replay = await upsertMessageEvent(session.id, {
    ...answer('Different prose'), retiredRichMediaSlots: [{ mediaId: 'forged-media', nodeId: 'forged-node' }]
  } as Parameters<typeof upsertMessageEvent>[1]);
  expect(replay.event.kind === 'assistant_message' && replay.event.retiredRichMediaSlots).toEqual(expected);
  expect(replay.event.kind === 'assistant_message' && replay.event.richMedia).toBeUndefined();
  // Restore the valid authored message/rich subtree, then test actual on-disk tamper.
  await upsertMessageEvent(session.id, answer('Different prose'));
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true)).toBe('stored');
  await flushSessions(); resetSessionStoreForTests();
  const target = shardFile(session.id);
  const valid = JSON.parse(await fs.readFile(target, 'utf8'));
  for (const bad of [
    [{ mediaId: removed.mediaId, nodeId: 'impostor-node' }],
    [{ mediaId: removed.mediaId, nodeId: removed.nodeId },
      { mediaId: removed.mediaId, nodeId: removed.nodeId }],
    [{ mediaId: 'https://example.test/?token=private', nodeId: removed.nodeId }],
    [{ ...expected[0], removalIncarnation: randomUUID() }],
    [{ ...expected[0], retiredAssetId: 'a'.repeat(32) + '.bin' }],
    [{ ...expected[0], removalIncarnation: randomUUID(), retiredAssetId: 'bad-file' }],
    [{ ...expected[0], removalIncarnation: 'not-a-uuid', retiredAssetId: 'a'.repeat(32) + '.bin' }],
    [{ ...expected[0], removalIncarnation: randomUUID(), retiredAssetId: 'a'.repeat(32) + '.txt' }],
    [{ ...expected[0], removalIncarnation: randomUUID(), retiredAssetId: 'a'.repeat(32) + '.bin',
      url: 'https://example.test/private' }],
    'malformed-list'
  ]) {
    const corrupted = JSON.stringify({ ...valid, retiredRichMediaSlots: bad });
    await fs.writeFile(target, corrupted, 'utf8');
    resetSessionStoreForTests();
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true)).toBe('refused');
    expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
  }
  await fs.writeFile(target, JSON.stringify(valid), 'utf8');
  resetSessionStoreForTests();
  expect((await row(session.id))?.retiredRichMediaSlots).toEqual(expected);
});

it('begins only on an existing canonical PAGE slot and persists its store-owned source version without changing work', async () => {
  const session = await createSession({ title: 'page source custody', conversationId: A });
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId)).toBeNull();
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true)).toBe('stored');
  const before = await row(session.id);
  const summary = await getSession(session.id);
  const empty = await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId);
  expect(empty).toMatchObject({ richRevision: 1, slotVersion: 0, sourceIncarnation: null,
    sourceSequence: null, status: 'pending', removed: false, richOrigin: documentOrigin() });
  const admitted = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  expect(admitted.status).toBe('stored');
  expect(admitted.slotVersion).toBeGreaterThan(0);
  const expected = { slotVersion: admitted.slotVersion!, sourceIncarnation: sourceToken('a', 1), sourceSequence: 1 };
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toMatchObject(expected);
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded', pageSource: {
    slotVersion: admitted.slotVersion, incarnation: sourceToken('a', 1), sequence: 1,
    recordingRevision: revision
  } }]);
  expect((await row(session.id))?.message).toEqual(before?.message);
  expect((await getSession(session.id))).toMatchObject({ events: summary?.events,
    estimatedTokens: summary?.estimatedTokens, contextTokens: summary?.contextTokens,
    lastAssistantFinalAt: summary?.lastAssistantFinalAt, finishTurn: summary?.finishTurn });
  expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  expect(await fs.readdir(path.join(sessionsRoot(), session.id, 'assets')).catch(() => [])).toEqual([]);
  await flushSessions(); resetSessionStoreForTests();
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toMatchObject(expected);
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1)))
    .toEqual({ status: 'unchanged', slotVersion: admitted.slotVersion });
});

it('increases the source barrier for A→B→A and rejects stale, nonmonotonic and wrong-slot source witnesses', async () => {
  const session = await createSession({ title: 'source CAS', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const second = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, first.slotVersion!, 2, 'b'));
  const third = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, second.slotVersion!, 3, 'c'));
  expect([first.status, second.status, third.status]).toEqual(['stored', 'stored', 'stored']);
  expect(first.slotVersion!).toBeLessThan(second.slotVersion!);
  expect(second.slotVersion!).toBeLessThan(third.slotVersion!);
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, first.slotVersion!, 1, 'a')))
    .toEqual({ status: 'refused' });
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, third.slotVersion!, 2, 'b')))
    .toEqual({ status: 'refused' });
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, third.slotVersion!, 3, 'd')))
    .toEqual({ status: 'refused' });
  expect(await beginVerifiedPageRichMediaSource(session.id, { ...sourceProof(1, third.slotVersion!, 4, 'c'),
    sourceIncarnation: sourceToken('c', 3) }))
    .toEqual({ status: 'refused' }); // One old incarnation cannot claim a newer sequence.
  expect(await beginVerifiedPageRichMediaSource(session.id, { ...sourceProof(1, third.slotVersion!, 4, 'd'),
    nodeId: 'impostor' })).toEqual({ status: 'refused' });
  expect(await beginVerifiedPageRichMediaSource(session.id, { ...sourceProof(1, third.slotVersion!, 4, 'd'),
    providerMessageId: OTHER_PROVIDER })).toEqual({ status: 'refused' });
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toMatchObject({ sourceIncarnation: sourceToken('c', 3), sourceSequence: 3, slotVersion: third.slotVersion });
});

it('serializes a newer source before an older delayed begin and refuses the stale version after the physical rename', async () => {
  const session = await createSession({ title: 'pixel source race', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const target = shardFile(session.id);
  const rename = fs.rename.bind(fs);
  let reached!: () => void;
  let release!: () => void;
  const physical = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    await rename(from, to);
    if (String(to) === target) { reached(); await gate; }
  }) as typeof fs.rename);
  try {
    const newer = beginVerifiedPageRichMediaSource(session.id, sourceProof(1, 0, 2, 'b'));
    await physical;
    const physicallySaved = JSON.parse(await fs.readFile(target, 'utf8')) as Extract<SessionEvent, { kind: 'assistant_message' }>;
    expect(physicallySaved.richMedia?.[0]?.pageSource?.incarnation).toBe(sourceToken('b', 2));
    const stale = beginVerifiedPageRichMediaSource(session.id, sourceProof(1, 0, 1, 'a'));
    release();
    const accepted = await newer;
    expect(accepted.status).toBe('stored');
    expect(await stale).toEqual({ status: 'refused' });
    expect((await row(session.id))?.richMedia?.[0]?.pageSource?.slotVersion).toBe(accepted.slotVersion);
  } finally {
    release();
    spy.mockRestore();
  }
});

it('requires the original recording revision and never lets raw metadata mint or replace a source witness', async () => {
  const session = await createSession({ title: 'raw source refusal', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true);
  const raw: RichMediaState = { ...pending(), pageSource: { incarnation: sourceToken('a', 1), sequence: 1,
    slotVersion: 999 } };
  expect(await upsertRichMedia(session.id, MESSAGE, raw, documentOrigin(), 1, revision)).toBe('refused');
  expect(await beginVerifiedPageRichMediaSource(session.id, { ...sourceProof(1),
    sourceIncarnation: 'https://example.test/image?token=secret' })).toEqual({ status: 'refused' });
  expect(await beginVerifiedPageRichMediaSource(session.id, { ...sourceProof(1),
    sourceSequence: 2 })).toEqual({ status: 'refused' });
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, 0, 1, 'a',
    documentOrigin(), revision))).toEqual({ status: 'refused' });
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded' }]);
});

it('retains a monotonic slot version across a new document and A→B→A binding while rejecting old custody', async () => {
  const session = await createSession({ title: 'document source fence', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  expect(await rebindSession(session.id, A, B)).toBe(true);
  expect(await rebindSession(session.id, B, A)).toBe(true);
  const reopened = documentOrigin(2, A, 'document-next', 0);
  expect(await upsertRichMessage(session.id, MESSAGE, rich(), reopened, recording, true)).toBe('stored');
  const current = await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId);
  expect(current).toMatchObject({ richRevision: 1, slotVersion: first.slotVersion,
    sourceIncarnation: null, sourceSequence: null, richOrigin: reopened, status: 'pending' });
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, first.slotVersion!, 2, 'b')))
    .toEqual({ status: 'refused' });
  const resumed = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(1, first.slotVersion!, 1, 'd', reopened));
  expect(resumed.status).toBe('stored');
  expect(resumed.slotVersion!).toBeGreaterThan(first.slotVersion!);
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, first.slotVersion!, 1, 'a', reopened)))
    .toEqual({ status: 'refused' });
  await flushSessions(); resetSessionStoreForTests();
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toMatchObject({ slotVersion: resumed.slotVersion, sourceIncarnation: sourceToken('d', 1) });
});

it('retires an older available preview when the exact witnessed source changes and never mints an asset', async () => {
  const session = await createSession({ title: 'source replaces preview', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const before = await row(session.id);
  const asset = { id: `${'f'.repeat(32)}.bin`, mimeType: 'image/webp', bytes: 123 };
  await flushSessions(); resetSessionStoreForTests();
  await fs.writeFile(shardFile(session.id), JSON.stringify({ ...before, richMedia: [{
    ...before!.richMedia![0], status: 'available', reason: undefined,
    previewWidth: 160, previewHeight: 120, asset
  }] }), 'utf8');
  resetSessionStoreForTests();
  const changed = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(1, first.slotVersion!, 2, 'b'));
  expect(changed.status).toBe('stored');
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), reason: 'not_loaded', pageSource: {
    incarnation: sourceToken('b', 2), sequence: 2, slotVersion: changed.slotVersion,
    recordingRevision: revision
  } }]);
  expect((await row(session.id))?.richMedia?.[0]?.asset).toBeUndefined();
});

it('never starts a removed source, including after omission, restart and corrupt persisted witness', async () => {
  const session = await createSession({ title: 'source and removal', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const revision = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), revision, true);
  const versioned = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const removed: RichMediaState = { ...pending(), status: 'unavailable', reason: 'removed' };
  expect(await upsertRichMedia(session.id, MESSAGE, removed, documentOrigin(), 1, revision)).toBe('stored');
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toBeNull();
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, versioned.slotVersion!, 2, 'b')))
    .toEqual({ status: 'refused' });
  await flushSessions(); resetSessionStoreForTests();
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, versioned.slotVersion!, 2, 'b')))
    .toEqual({ status: 'refused' });
  const target = shardFile(session.id);
  const valid = JSON.parse(await fs.readFile(target, 'utf8'));
  for (const broken of [
    { slotVersion: 0, incarnation: sourceToken('a', 1), sequence: 1 },
    { slotVersion: versioned.slotVersion, incarnation: sourceToken('a', 1), sequence: -1 },
    { slotVersion: versioned.slotVersion, incarnation: 'https://example.test/private', sequence: 1 },
    { slotVersion: versioned.slotVersion, incarnation: sourceToken('a', 1), sequence: 2 },
    { slotVersion: versioned.slotVersion, incarnation: sourceToken('a', 1), sequence: 1, url: 'secret' }
  ]) {
    const corrupted = JSON.stringify({ ...valid, richMedia: [{ ...valid.richMedia[0], pageSource: broken }] });
    await fs.writeFile(target, corrupted, 'utf8');
    resetSessionStoreForTests();
    expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
      .toBeNull();
    expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, versioned.slotVersion!, 2, 'b')))
      .toEqual({ status: 'refused' });
    expect(await fs.readFile(target, 'utf8')).toBe(corrupted);
  }
});

it('never reuses a source version when a rich tree omits and restores the same image', async () => {
  const session = await createSession({ title: 'omitted source', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich([image(), image('neighbor', 'neighbor-media')]),
    documentOrigin(), recording, true);
  const old = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  expect(old.status).toBe('stored');
  await upsertRichMessage(session.id, MESSAGE, rich([image('neighbor', 'neighbor-media')]),
    documentOrigin(), recording, true);
  await flushSessions(); resetSessionStoreForTests();
  expect(await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId))
    .toBeNull();
  await upsertRichMessage(session.id, MESSAGE, rich([image(), image('neighbor', 'neighbor-media')]),
    documentOrigin(), recording, true);
  const current = await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId);
  expect(current?.slotVersion).toBeGreaterThan(old.slotVersion!);
  expect(current?.sourceIncarnation).toBeNull();
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(3, 0, 1, 'a')))
    .toEqual({ status: 'refused' });
  const newSource = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(3, current!.slotVersion, 2, 'b'));
  expect(newSource.status).toBe('stored');
  expect(newSource.slotVersion).toBeGreaterThan(current!.slotVersion);
});

it('keeps a source version fence when a new prose revision removes rich and its revision restarts', async () => {
  const session = await createSession({ title: 'authored source reset', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const old = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  expect(old.status).toBe('stored');
  await upsertMessageEvent(session.id, answer('Replacement authored response'));
  expect((await row(session.id))?.rich).toBeUndefined();
  await flushSessions(); resetSessionStoreForTests();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const current = await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId);
  expect(current?.richRevision).toBe(1);
  expect(current?.slotVersion).toBeGreaterThan(old.slotVersion!);
  expect(await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, 0, 1, 'a')))
    .toEqual({ status: 'refused' });
});

it('settles only a source-current pending PAGE slot, preserving its version and authored chronology', async () => {
  const session = await createSession({ title: 'verified page preview', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const began = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const original = await row(session.id);
  const summary = await getSession(session.id);
  const proof = { ...sourceProof(1), expectedSlotVersion: began.slotVersion!,
    status: 'available' as const, asset: asset(), previewWidth: 160, previewHeight: 120 };
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('stored');
  expect((await row(session.id))?.richMedia).toEqual([{ ...pending(), status: 'available',
    pageSource: { slotVersion: began.slotVersion, incarnation: sourceToken('a', 1), sequence: 1,
      recordingRevision: recording },
    previewWidth: 160, previewHeight: 120, asset: asset() }]);
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('unchanged');
  expect(await settleVerifiedPageRichMedia(session.id, { ...proof, asset: asset('e') })).toBe('refused');
  expect((await row(session.id))?.contentSeq).toBe(original?.contentSeq);
  expect((await row(session.id))?.finalContentSeq).toBe(original?.finalContentSeq);
  expect(await getSession(session.id)).toMatchObject({ events: summary?.events,
    estimatedTokens: summary?.estimatedTokens, contextTokens: summary?.contextTokens,
    lastAssistantFinalAt: summary?.lastAssistantFinalAt, finishTurn: summary?.finishTurn });
  expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  await flushSessions(); resetSessionStoreForTests();
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('unchanged');
});

it('refuses stale A pixels after B and after A→B→A, including a byte-identical source reincarnation', async () => {
  const session = await createSession({ title: 'late page preview', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const old = { ...sourceProof(1), expectedSlotVersion: first.slotVersion!, status: 'available' as const,
    asset: asset(), previewWidth: 160, previewHeight: 120 };
  const second = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(1, first.slotVersion!, 2, 'b'));
  expect(await settleVerifiedPageRichMedia(session.id, old)).toBe('refused');
  const current = { ...sourceProof(1, second.slotVersion!, 2, 'b'),
    status: 'available' as const, asset: asset('e'), previewWidth: 100, previewHeight: 100 };
  expect(await settleVerifiedPageRichMedia(session.id, current)).toBe('stored');
  const third = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(1, second.slotVersion!, 3, 'a'));
  expect(await settleVerifiedPageRichMedia(session.id, old)).toBe('refused');
  expect(await settleVerifiedPageRichMedia(session.id, current)).toBe('refused');
  expect(await settleVerifiedPageRichMedia(session.id, { ...sourceProof(1, third.slotVersion!, 3, 'a'),
    status: 'available', asset: asset(), previewWidth: 160, previewHeight: 120 })).toBe('stored');
  expect((await row(session.id))?.richMedia?.[0]?.pageSource?.slotVersion).toBe(third.slotVersion);
});

it('settles unavailable by exact source CAS and refuses a late status or mismatched replay', async () => {
  const session = await createSession({ title: 'tainted page image', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const stale = { ...sourceProof(1, first.slotVersion!), status: 'unavailable' as const,
    reason: 'tainted' as const };
  const second = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1, first.slotVersion!, 2, 'b'));
  expect(await settleVerifiedPageRichMedia(session.id, stale)).toBe('refused');
  const exact = { ...sourceProof(1, second.slotVersion!, 2, 'b'), status: 'unavailable' as const,
    reason: 'tainted' as const };
  expect(await settleVerifiedPageRichMedia(session.id, exact)).toBe('stored');
  expect(await settleVerifiedPageRichMedia(session.id, exact)).toBe('unchanged');
  expect(await settleVerifiedPageRichMedia(session.id, { ...exact, reason: 'invalid' })).toBe('refused');
  expect(await settleVerifiedPageRichMedia(session.id, { ...exact, status: 'available',
    asset: asset(), previewWidth: 100, previewHeight: 100 })).toBe('refused');
  expect((await row(session.id))?.richMedia?.[0]).toMatchObject({ status: 'unavailable', reason: 'tainted',
    pageSource: { slotVersion: second.slotVersion, sequence: 2 } });
});

it('refuses malformed assets, retired slots, stale Off generations and rebinds at private settlement', async () => {
  const session = await createSession({ title: 'settlement fences', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  const recording = getRecordingRevision();
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), recording, true);
  const first = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const proof = { ...sourceProof(1, first.slotVersion!), status: 'available' as const,
    asset: asset(), previewWidth: 160, previewHeight: 120 };
  const oldShard = await fs.readFile(shardFile(session.id));
  for (const forged of [
    { ...proof, asset: { ...asset(), bytes: 384_001 } },
    { ...proof, asset: { ...asset(), id: 'https://example.test/private' } },
    { ...proof, asset: { ...asset(), mimeType: 'image/png' } },
    { ...proof, previewWidth: 1601 },
    { ...proof, previewWidth: 1600, previewHeight: 1601 },
    { ...proof, sourceIncarnation: sourceToken('b', 1) },
    { ...proof, sourceSequence: 2 },
    { ...proof, providerMessageId: OTHER_PROVIDER },
    { ...proof, expectedSlotVersion: 0 }
  ]) expect(await settleVerifiedPageRichMedia(session.id, forged)).toBe('refused');
  expect(await fs.readFile(shardFile(session.id))).toEqual(oldShard);
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('refused');
  const fresh = { ...proof, expectedRecordingRevision: getRecordingRevision() };
  expect(await settleVerifiedPageRichMedia(session.id, fresh)).toBe('refused');
  const refreshed = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(1, first.slotVersion!, 2, 'b', documentOrigin(), getRecordingRevision()));
  expect(refreshed.status).toBe('stored');
  const currentProof = { ...sourceProof(1, refreshed.slotVersion!, 2, 'b', documentOrigin(),
    getRecordingRevision()), status: 'available' as const, asset: asset(),
    previewWidth: 160, previewHeight: 120 };
  expect(await settleVerifiedPageRichMedia(session.id, currentProof)).toBe('stored');
  expect(await rebindSession(session.id, A, B)).toBe(true);
  expect(await rebindSession(session.id, B, A)).toBe(true);
  expect(await settleVerifiedPageRichMedia(session.id, currentProof)).toBe('refused');
  const reopened = documentOrigin(2, A, 'document-after-rebind', 0);
  await upsertRichMessage(session.id, MESSAGE, rich(), reopened, getRecordingRevision(), true);
  const current = await readPageRichPixelTarget(session.id, MESSAGE, PROVIDER, pending().mediaId, pending().nodeId);
  const next = await beginVerifiedPageRichMediaSource(session.id,
    sourceProof(current!.richRevision, current!.slotVersion, 1, 'b', reopened));
  expect(await upsertRichMedia(session.id, MESSAGE,
    { ...pending(), status: 'unavailable', reason: 'removed' }, reopened,
    current!.richRevision, getRecordingRevision())).toBe('stored');
  expect(await settleVerifiedPageRichMedia(session.id, { ...sourceProof(current!.richRevision,
    next.slotVersion!, 1, 'b', reopened), expectedRecordingRevision: getRecordingRevision(),
    status: 'available', asset: asset(), previewWidth: 160, previewHeight: 120 })).toBe('refused');
});

it('leaves pending unchanged if the physical settlement rename fails, then admits one retry', async () => {
  const session = await createSession({ title: 'settlement disk failure', conversationId: A });
  await upsertMessageEvent(session.id, answer());
  await upsertRichMessage(session.id, MESSAGE, rich(), documentOrigin(), getRecordingRevision(), true);
  const begin = await beginVerifiedPageRichMediaSource(session.id, sourceProof(1));
  const proof = { ...sourceProof(1, begin.slotVersion!), status: 'unavailable' as const,
    reason: 'tainted' as const };
  const original = await fs.readFile(shardFile(session.id));
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to) === shardFile(session.id)) throw new Error('simulated pixel settlement failure');
    return rename(from, to);
  }) as typeof fs.rename);
  await expect(settleVerifiedPageRichMedia(session.id, proof)).rejects.toThrow('simulated pixel settlement failure');
  expect(await fs.readFile(shardFile(session.id))).toEqual(original);
  spy.mockRestore();
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('stored');
  expect(await settleVerifiedPageRichMedia(session.id, proof)).toBe('unchanged');
});

it('keeps a partial EIO write outside the hash name and admits a complete retry', async () => {
  const session = await createSession({ title: 'asset EIO', conversationId: A });
  const data = Buffer.from('complete-binary-asset-'.repeat(32));
  const id = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.bin`;
  const assets = path.join(sessionsRoot(), session.id, 'assets');
  const originalWrite = fs.writeFile.bind(fs);
  const before = (await getImageStorage()).usedBytes;
  let injected = false;
  const fault = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, contents, options) => {
    if (!injected && String(file).startsWith(`${assets}${path.sep}`) &&
        typeof options === 'object' && options?.flag === 'wx') {
      injected = true;
      await originalWrite(file, (contents as Buffer).subarray(0, 13), options);
      throw Object.assign(new Error('simulated partial EIO'), { code: 'EIO' });
    }
    return originalWrite(file, contents, options);
  }) as typeof fs.writeFile);
  try {
    await expect(writeAsset(session.id, data, 'image/webp')).rejects.toThrow('simulated partial EIO');
  } finally { fault.mockRestore(); }
  expect(injected).toBe(true);
  await expect(fs.lstat(path.join(assets, id))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(assets)).toEqual([]);
  expect((await getImageStorage()).usedBytes).toBe(before);

  expect(await writeAsset(session.id, data, 'image/webp')).toEqual({ id, mimeType: 'image/webp', bytes: data.length });
  expect(await readAsset(session.id, id)).toEqual(data);
  expect(await fs.readdir(assets)).toEqual([id]);
  expect((await getImageStorage()).usedBytes).toBe(before + data.length);
});

it('deduplicates an intact existing hash asset without replacing its inode or charging quota twice', async () => {
  const session = await createSession({ title: 'asset dedupe', conversationId: A });
  const data = Buffer.from('same image bytes for both owners');
  const before = (await getImageStorage()).usedBytes;
  const first = await writeAsset(session.id, data, 'image/webp');
  const target = path.join(sessionsRoot(), session.id, 'assets', first.id);
  const original = await fs.stat(target);
  expect(await writeAsset(session.id, Buffer.from(data), 'image/webp')).toEqual(first);
  const repeated = await fs.stat(target);
  expect(repeated.ino).toBe(original.ino);
  expect(repeated.mtimeMs).toBe(original.mtimeMs);
  expect(await fs.readdir(path.dirname(target))).toEqual([first.id]);
  expect((await getImageStorage()).usedBytes).toBe(before + data.length);
});

it('refuses truncated, same-length corrupt and non-regular hash targets without changing existing bytes', async () => {
  const data = Buffer.from('hash-name-does-not-prove-file-integrity');
  const id = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.bin`;
  for (const corruption of ['truncated', 'same-length', 'directory', 'symlink'] as const) {
    const session = await createSession({ title: `asset ${corruption}`, conversationId: A });
    const dir = path.join(sessionsRoot(), session.id, 'assets');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    const actual = corruption === 'truncated' ? data.subarray(0, 8) : Buffer.alloc(data.length, 0x41);
    if (corruption === 'directory') await fs.mkdir(target);
    else if (corruption === 'symlink') {
      await fs.writeFile(path.join(dir, 'other.bin'), actual);
      await fs.symlink('other.bin', target);
    } else await fs.writeFile(target, actual);
    await expect(writeAsset(session.id, data, 'image/webp')).rejects.toThrow();
    if (corruption === 'directory') expect((await fs.lstat(target)).isDirectory()).toBe(true);
    else if (corruption === 'symlink') {
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(dir, 'other.bin'))).toEqual(actual);
    } else expect(await fs.readFile(target)).toEqual(actual);
    expect((await fs.readdir(dir)).every(name => !name.endsWith('.tmp'))).toBe(true);
  }
});
