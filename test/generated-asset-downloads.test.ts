import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, updateConfig } from '../src/main/config.js';
import {
  claimGeneratedAssetDownload,
  pendingGeneratedAssetDownloadOffers,
  recordGeneratedAssetDownloadResult,
  observeGeneratedAssetDocuments,
  reconcileGeneratedAssetDownloadCustody,
  requestGeneratedAssetDownloads,
  resetGeneratedAssetDownloadsForTests,
  stopGeneratedAssetDownloads,
  subscribeGeneratedAssetDownloads
} from '../src/main/generated-asset-downloads.js';
import {
  createSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  upsertNativeImageEvent
} from '../src/main/session/store.js';

let directory = '';
const responseId = 'assistant:image-set:aurora';
const firstAsset = 'file_AuroraOriginal0001';
const secondAsset = 'file_AuroraOriginal0002';

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbbc-generated-downloads-'));
  initConfigPath(directory);
  await updateConfig(() => defaultConfig());
  initSessionStore(directory);
  resetGeneratedAssetDownloadsForTests();
});

afterEach(async () => {
  resetGeneratedAssetDownloadsForTests();
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Aurora', conversationId });
  for (const [index, providerAssetId] of [firstAsset, secondAsset].entries()) {
    await upsertNativeImageEvent(session.id, {
      time: index + 1,
      source: 'extension',
      kind: 'native_image',
      messageId: responseId,
      providerAssetId,
      providerRole: 'tool',
      previewStatus: 'pending'
    });
  }
  return { session, conversationId };
}

const source = (conversationId: string, documentId = 'doc-aurora') => ({
  conversationId,
  tab: 42,
  documentId,
  documentGeneration: 3,
  spaEpoch: 7
});

function showDocument(conversationId: string, documentId = 'doc-aurora'): void {
  observeGeneratedAssetDocuments([source(conversationId, documentId)]);
}

describe('generated original download custody', () => {
  it('rereads one canonical response, bounds batches, deduplicates active requests, and never returns a URL', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset, secondAsset]
    });
    expect(batch.items.map(item => item.state)).toEqual(['requested', 'requested']);
    expect(batch.items.map(item => item.assetId)).toEqual([firstAsset, secondAsset]);
    expect(JSON.stringify(batch)).not.toMatch(/https?:|url|bearer|token/i);
    const duplicate = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset, secondAsset]
    });
    expect(duplicate.id).toBe(batch.id);
    showDocument(conversationId);
    expect(pendingGeneratedAssetDownloadOffers()).toHaveLength(2);

    await expect(requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: Array.from({ length: 21 }, (_, index) => `file_${String(index).padStart(8, '0')}`)
    })).rejects.toThrow('download_batch_invalid');
    await expect(requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: ['file_NotOwned000000']
    })).rejects.toThrow('download_asset_unavailable');
  });

  it('claims one exact current document and refuses replay, rebind, foreign session, and changed assets', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset]
    });
    showDocument(conversationId);
    const offer = pendingGeneratedAssetDownloadOffers()[0]!;
    expect(offer).toMatchObject({ id: batch.items[0]!.id, conversationId, logicalMessageId: responseId, assetId: firstAsset,
      document: { tab: 42, documentId: 'doc-aurora', documentGeneration: 3, spaEpoch: 7 } });

    const claimed = await claimGeneratedAssetDownload({ id: offer.id, ...source(conversationId) });
    expect(claimed).toMatchObject({ id: offer.id, conversationId, logicalMessageId: responseId, assetId: firstAsset });
    expect(claimed?.claimToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await claimGeneratedAssetDownload({ id: offer.id, ...source(conversationId) })).toBeNull();
    expect(pendingGeneratedAssetDownloadOffers()).toEqual([]);

    const second = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [secondAsset]
    });
    showDocument(conversationId);
    await rebindSession(session.id, conversationId, randomUUID());
    expect(await claimGeneratedAssetDownload({ id: second.items[0]!.id, ...source(conversationId) })).toBeNull();
  });

  it('withholds every offer when the live document report is truncated', async () => {
    const { session, conversationId } = await fixture();
    await requestGeneratedAssetDownloads({
      sessionId: session.id, logicalMessageId: responseId, assetIds: [firstAsset]
    });
    showDocument(conversationId);
    expect(pendingGeneratedAssetDownloadOffers()).toHaveLength(1);
    observeGeneratedAssetDocuments([], false);
    expect(pendingGeneratedAssetDownloadOffers()).toEqual([]);
  });

  it('publishes truthful per-item states and accepts only the matching claimed receipt', async () => {
    const { session, conversationId } = await fixture();
    const seen: string[] = [];
    const unsubscribe = subscribeGeneratedAssetDownloads(batch => {
      seen.push(batch.items.map(item => item.state).join(','));
    });
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset, secondAsset]
    });
    showDocument(conversationId);
    expect(batch.items).toHaveLength(2);
    const [first, second] = pendingGeneratedAssetDownloadOffers();
    const firstClaim = await claimGeneratedAssetDownload({ id: first!.id, ...source(conversationId) });
    const secondClaim = await claimGeneratedAssetDownload({ id: second!.id, ...source(conversationId) });
    expect(firstClaim && secondClaim).toBeTruthy();

    expect(await recordGeneratedAssetDownloadResult({
      id: first!.id,
      claimToken: 'x'.repeat(32),
      state: 'started'
    })).toBe(false);
    expect(await recordGeneratedAssetDownloadResult({
      id: first!.id,
      claimToken: firstClaim!.claimToken,
      state: 'started'
    })).toBe(true);
    expect(await recordGeneratedAssetDownloadResult({
      id: first!.id,
      claimToken: firstClaim!.claimToken,
      state: 'complete'
    })).toBe(true);
    expect(await recordGeneratedAssetDownloadResult({
      id: second!.id,
      claimToken: secondClaim!.claimToken,
      state: 'unconfirmed',
      detail: 'Browser restarted before the receipt was observed.'
    })).toBe(true);
    expect(await recordGeneratedAssetDownloadResult({
      id: second!.id,
      claimToken: secondClaim!.claimToken,
      state: 'complete'
    })).toBe(false);
    expect(seen.at(-1)).toBe('complete,unconfirmed');
    expect(JSON.stringify(seen)).not.toMatch(/https?:/);
    unsubscribe();
  });

  it('marks a claimed download unconfirmed when the next browser incarnation has no receipt custody', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset]
    });
    showDocument(conversationId);
    const claim = await claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId) });
    expect(claim).toBeTruthy();
    let latest = '';
    const unsubscribe = subscribeGeneratedAssetDownloads(value => {
      latest = value.items[0]?.state ?? '';
    });
    expect(reconcileGeneratedAssetDownloadCustody([])).toBe(1);
    unsubscribe();
    expect(latest).toBe('unconfirmed');
    expect(pendingGeneratedAssetDownloadOffers()).toEqual([]);
    expect(await recordGeneratedAssetDownloadResult({
      id: batch.items[0]!.id,
      claimToken: claim!.claimToken,
      state: 'complete'
    })).toBe(false);
  });

  it('offers only one exact live document and lets only one concurrent claim win', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id,
      logicalMessageId: responseId,
      assetIds: [firstAsset]
    });
    observeGeneratedAssetDocuments([
      source(conversationId, 'doc-a'),
      { ...source(conversationId, 'doc-b'), tab: 43 }
    ]);
    expect(pendingGeneratedAssetDownloadOffers()).toEqual([]);
    expect(await claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId, 'doc-a') })).toBeNull();
    showDocument(conversationId, 'doc-a');
    const [first, second] = await Promise.all([
      claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId, 'doc-a') }),
      claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId, 'doc-a') })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('accepts an exact terminal receipt again after its acknowledgement was lost', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id, logicalMessageId: responseId, assetIds: [firstAsset]
    });
    showDocument(conversationId);
    const claim = await claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId) });
    const receipt = { id: batch.items[0]!.id, claimToken: claim!.claimToken, state: 'complete' as const };
    expect(await recordGeneratedAssetDownloadResult({ ...receipt, state: 'started' })).toBe(true);
    expect(await recordGeneratedAssetDownloadResult(receipt)).toBe(true);
    expect(await recordGeneratedAssetDownloadResult(receipt)).toBe(true);
    expect(await recordGeneratedAssetDownloadResult({ ...receipt, state: 'failed' })).toBe(false);
  });

  it('refuses another batch when 64 downloads are still unresolved', async () => {
    const { session } = await fixture();
    for (let index = 0; index < 64; index += 1) {
      const messageId = `assistant:image-set:${index}`;
      await upsertNativeImageEvent(session.id, {
        time: index + 10, source: 'extension', kind: 'native_image', messageId,
        providerAssetId: firstAsset, providerRole: 'tool', previewStatus: 'pending'
      });
      await requestGeneratedAssetDownloads({ sessionId: session.id, logicalMessageId: messageId, assetIds: [firstAsset] });
    }
    await expect(requestGeneratedAssetDownloads({
      sessionId: session.id, logicalMessageId: responseId, assetIds: [secondAsset]
    })).rejects.toThrow('download_capacity');
  });

  it('marks an unresolved download unconfirmed and refuses new admission after shutdown', async () => {
    const { session, conversationId } = await fixture();
    const batch = await requestGeneratedAssetDownloads({
      sessionId: session.id, logicalMessageId: responseId, assetIds: [firstAsset]
    });
    showDocument(conversationId);
    expect(await claimGeneratedAssetDownload({ id: batch.items[0]!.id, ...source(conversationId) })).toBeTruthy();
    let latest = '';
    const unsubscribe = subscribeGeneratedAssetDownloads(value => {
      latest = value.items[0]?.state ?? '';
    });
    expect(stopGeneratedAssetDownloads()).toBe(1);
    unsubscribe();
    expect(latest).toBe('unconfirmed');
    await expect(requestGeneratedAssetDownloads({
      sessionId: session.id, logicalMessageId: responseId, assetIds: [secondAsset]
    })).rejects.toThrow('download_shutdown');
  });
});
