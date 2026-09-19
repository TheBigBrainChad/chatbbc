import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { createSession, deleteSession, flushSessions, initSessionStore, readAsset, resetSessionStoreForTests,
  sessionsRoot, upsertMessageEvent, upsertNativeImageEvent, upsertRichMessage, writeAsset } from '../src/main/session/store.js';

it('has no startup age-retention owner or recurring prune timer', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  expect(source).not.toContain('startSessionRetentionMaintenance');
  expect(source).not.toContain('pruneSessions');
  await expect(stat(path.join(process.cwd(), 'src/main/session/retention.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('explicit session deletion removes its own shared image assets without deleting another session content-hash twin', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chatbbc-retention-'));
  try {
    initSessionStore(dir);
    const first = await createSession({ conversationId: randomUUID() });
    const second = await createSession({ conversationId: randomUUID() });
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#339966' } }).png().toBuffer();
    const owned = await writeAsset(first.id, bytes, 'image/png');
    const other = await writeAsset(second.id, bytes, 'image/png');
    expect(owned.id).toBe(other.id);
    await upsertMessageEvent(first.id, { time: 1, source: 'app', kind: 'user_message',
      messageId: 'old-authored', message: { text: 'Keep original source.', chars: 21, truncated: false }, assets: [owned] });
    await upsertNativeImageEvent(first.id, { time: 2, source: 'extension', kind: 'native_image',
      messageId: 'native-owner', providerAssetId: 'generated-owner', providerRole: 'tool',
      providerStatus: 'finished_successfully', previewStatus: 'available', asset: owned });
    // Test-only future rich asset: deletion must remove its session directory, while the
    // production rich-media publisher continues to refuse available asset references.
    const messageId = 'rich-deleted';
    const providerMessageId = randomUUID();
    await upsertMessageEvent(first.id, { time: 3, source: 'extension', kind: 'assistant_message',
      messageId, providerMessageId, final: true,
      message: { text: 'A reference image', chars: 17, truncated: false } });
    await upsertRichMessage(first.id, messageId, {
      version: 1, status: 'available', reason: null, conversationId: first.conversationId!,
      messageId, providerMessageId, revision: 0, accessibleText: 'Reference image',
      nodes: [{ kind: 'image', id: 'rich-slot', mediaId: 'rich-media', alt: 'Reference', width: 4, height: 4 }]
    }, { conversationId: first.conversationId!, bindingRevision: 0, documentId: 'native-document', navigationEpoch: 1 });
    await flushSessions();
    const shard = path.join(sessionsRoot(), first.id, 'messages',
      `${createHash('sha256').update(`assistant_message\u0000${messageId}`).digest('hex')}.json`);
    const original = JSON.parse(await readFile(shard, 'utf8'));
    await writeFile(shard, JSON.stringify({ ...original, richMedia: [{
      mediaId: 'rich-media', nodeId: 'rich-slot', source: { kind: 'page', nodeId: 'rich-slot' },
      status: 'available', previewWidth: 4, previewHeight: 4, asset: owned
    }] }));
    resetSessionStoreForTests(); initSessionStore(dir);
    await deleteSession(first.id);
    await expect(stat(path.join(sessionsRoot(), first.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readAsset(second.id, other.id)).toEqual(bytes);
  } finally {
    resetSessionStoreForTests();
    await rm(dir, { recursive: true, force: true });
  }
});
