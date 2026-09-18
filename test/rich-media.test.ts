import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/main/config.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import type { RichMediaState, RichOrigin, SessionEvent } from '../src/shared/session.js';
import type { RichNode, RichResponse } from '../src/shared/rich-response.js';
import {
  createSession, flushSessions, getSession, initSessionStore, readEvents, rebindSession,
  resetSessionStoreForTests, sessionsRoot, upsertMessageEvent, upsertRichMedia, upsertRichMessage
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
