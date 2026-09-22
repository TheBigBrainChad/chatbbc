import { randomBytes, randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { getSession, sessionImageSets } from './session/store.js';
import {
  MAX_GENERATED_ASSET_DOWNLOADS,
  type GeneratedAssetDownloadBatch,
  type GeneratedAssetDownloadClaim,
  type GeneratedAssetDownloadDocument,
  type GeneratedAssetDownloadOffer,
  type GeneratedAssetDownloadRequest,
  type GeneratedAssetDownloadResult,
  type GeneratedAssetDownloadSource,
  type GeneratedAssetDownloadState
} from '../shared/generated-assets.js';

const MAX_BATCHES = 64;
const MAX_LIVE_DOCUMENTS = 64;
const MAX_DETAIL = 240;
const SESSION_ID = /^[a-z0-9_-]{1,128}$/i;
const COMMAND_ID = /^[a-f0-9-]{36}$/i;
const PROVIDER_ASSET_ID = /^file_[A-Za-z0-9_-]{8,100}$/;
const DOCUMENT_ID = /^[a-z0-9_-]{1,128}$/i;

type InternalItem = GeneratedAssetDownloadBatch['items'][number] & {
  batchId: string;
  sessionId: string;
  conversationId: string;
  bindingRevision: number;
  logicalMessageId: string;
  claimToken: string | null;
  document: GeneratedAssetDownloadDocument | null;
};

type InternalBatch = Omit<GeneratedAssetDownloadBatch, 'items'> & {
  fingerprint: string;
  items: InternalItem[];
};

const batches = new Map<string, InternalBatch>();
const items = new Map<string, InternalItem>();
const subscribers = new Set<(batch: GeneratedAssetDownloadBatch) => void>();
let requestQueue = Promise.resolve();

function publicBatch(batch: InternalBatch): GeneratedAssetDownloadBatch {
  return {
    id: batch.id,
    sessionId: batch.sessionId,
    logicalMessageId: batch.logicalMessageId,
    createdAt: batch.createdAt,
    items: batch.items.map(({ id, assetId, filename, state, detail }) => ({ id, assetId, filename, state, detail }))
  };
}

function publish(batch: InternalBatch): void {
  const view = publicBatch(batch);
  for (const subscriber of subscribers) subscriber(view);
}

function validMessageId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateRequest(input: GeneratedAssetDownloadRequest): string[] {
  if (!input || typeof input !== 'object' || !SESSION_ID.test(input.sessionId) ||
      typeof input.logicalMessageId !== 'string' || !validMessageId(input.logicalMessageId) ||
      !Array.isArray(input.assetIds) || input.assetIds.length < 1 ||
      input.assetIds.length > MAX_GENERATED_ASSET_DOWNLOADS) throw new Error('download_batch_invalid');
  const assetIds = [...input.assetIds];
  if (new Set(assetIds).size !== assetIds.length || !assetIds.every(id => typeof id === 'string' && PROVIDER_ASSET_ID.test(id))) {
    throw new Error('download_batch_invalid');
  }
  return assetIds;
}

function filename(assetId: string, index: number): string {
  const suffix = assetId.slice(5).replace(/[^A-Za-z0-9_-]/g, '').slice(-32) || 'original';
  return `ChatBBC image ${String(index + 1).padStart(2, '0')} - ${suffix}.png`;
}

function terminal(state: GeneratedAssetDownloadState): boolean {
  return state === 'complete' || state === 'failed' || state === 'unconfirmed';
}

function nonterminalBatches(): number {
  let count = 0;
  for (const batch of batches.values()) {
    if (batch.items.some(item => !terminal(item.state))) count++;
  }
  return count;
}

function trimBatches(): void {
  if (batches.size <= MAX_BATCHES) return;
  for (const [id, batch] of batches) {
    if (!batch.items.every(item => terminal(item.state))) continue;
    batches.delete(id);
    for (const item of batch.items) items.delete(item.id);
    if (batches.size <= MAX_BATCHES) return;
  }
}

async function canonicalTarget(input: GeneratedAssetDownloadRequest, assetIds: string[]) {
  const session = await getSession(input.sessionId);
  if (!session?.conversationId || !Number.isSafeInteger(session.bindingRevision ?? 0) ||
      (session.bindingRevision ?? 0) < 0) throw new Error('download_session_unavailable');
  const result = await sessionImageSets(input.sessionId, [input.logicalMessageId]);
  const set = result.sets.find(row => row.responseId === input.logicalMessageId);
  const owned = new Set(set?.images.map(image => image.providerAssetId) ?? []);
  if (!set || assetIds.some(assetId => !owned.has(assetId))) throw new Error('download_asset_unavailable');
  const current = await getSession(input.sessionId);
  if (!current || current.conversationId !== session.conversationId ||
      current.bindingRevision !== session.bindingRevision) throw new Error('download_session_changed');
  return { conversationId: session.conversationId, bindingRevision: session.bindingRevision ?? 0 };
}

export async function requestGeneratedAssetDownloads(
  input: GeneratedAssetDownloadRequest,
  stillCurrent?: () => boolean
): Promise<GeneratedAssetDownloadBatch> {
  const run = requestQueue.then(async () => {
    const assetIds = validateRequest(input);
    const target = await canonicalTarget(input, assetIds);
    const fingerprint = JSON.stringify([input.sessionId, target.conversationId, target.bindingRevision,
      input.logicalMessageId, assetIds]);
    for (const batch of batches.values()) {
      if (batch.fingerprint === fingerprint && batch.items.some(item => !terminal(item.state))) return publicBatch(batch);
    }
    if (nonterminalBatches() >= MAX_BATCHES) throw new Error('download_capacity');
    if (stillCurrent && !stillCurrent()) throw new Error('download_selection_changed');
    const batchId = randomUUID();
    const batch: InternalBatch = {
      id: batchId,
      sessionId: input.sessionId,
      logicalMessageId: input.logicalMessageId,
      createdAt: Date.now(),
      fingerprint,
      items: assetIds.map((assetId, index) => ({
        id: randomUUID(),
        batchId,
        sessionId: input.sessionId,
        conversationId: target.conversationId,
        bindingRevision: target.bindingRevision,
        logicalMessageId: input.logicalMessageId,
        assetId,
        filename: filename(assetId, index),
        state: 'requested' as const,
        detail: null,
        claimToken: null,
        document: liveDocuments.get(target.conversationId) ?? null
      }))
    };
    batches.set(batch.id, batch);
    for (const item of batch.items) items.set(item.id, item);
    trimBatches();
    publish(batch);
    wakeBrowserWork();
    return publicBatch(batch);
  });
  requestQueue = run.then(() => undefined, () => undefined);
  return run;
}

function documentKey(document: GeneratedAssetDownloadDocument): string {
  return `${document.tab}\u0000${document.documentId}\u0000${document.documentGeneration}\u0000${document.spaEpoch}`;
}

function sameDocument(left: GeneratedAssetDownloadDocument, right: GeneratedAssetDownloadDocument): boolean {
  return documentKey(left) === documentKey(right);
}
const liveDocuments = new Map<string, GeneratedAssetDownloadDocument | null>();
let documentsComplete = false;

export function observeGeneratedAssetDocuments(
  rows: readonly (GeneratedAssetDownloadDocument & { conversationId: string })[],
  complete = true
): void {
  liveDocuments.clear();
  documentsComplete = complete === true && Array.isArray(rows) && rows.length <= MAX_LIVE_DOCUMENTS;
  if (!documentsComplete) return;
  const grouped = new Map<string, Map<string, GeneratedAssetDownloadDocument>>();
  for (const row of rows) {
    if (!row || typeof row.conversationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.conversationId) ||
        !validSource({ ...row })) continue;
    const document = Object.freeze({
      tab: row.tab,
      documentId: row.documentId,
      documentGeneration: row.documentGeneration,
      spaEpoch: row.spaEpoch
    });
    const documents = grouped.get(row.conversationId) ?? new Map<string, GeneratedAssetDownloadDocument>();
    documents.set(documentKey(document), document);
    grouped.set(row.conversationId, documents);
  }
  for (const [conversationId, documents] of grouped) {
    liveDocuments.set(conversationId, documents.size === 1 ? [...documents.values()][0]! : null);
  }
  for (const item of items.values()) {
    if (item.state !== 'requested' || item.claimToken !== null || item.document) continue;
    const live = liveDocuments.get(item.conversationId);
    if (live) item.document = live;
  }
}

export function pendingGeneratedAssetDownloadOffers(): GeneratedAssetDownloadOffer[] {
  const offers: GeneratedAssetDownloadOffer[] = [];
  if (!documentsComplete) return offers;
  for (const item of items.values()) {
    if (item.state !== 'requested' || item.claimToken !== null || !item.document) continue;
    const live = liveDocuments.get(item.conversationId);
    if (!live || !sameDocument(live, item.document)) continue;
    offers.push({
      id: item.id,
      conversationId: item.conversationId,
      logicalMessageId: item.logicalMessageId,
      assetId: item.assetId,
      filename: item.filename,
      document: item.document
    });
  }
  return offers;
}

export function generatedAssetDownloadsForSession(sessionId: string): GeneratedAssetDownloadBatch[] {
  if (!SESSION_ID.test(sessionId)) return [];
  return [...batches.values()].filter(batch => batch.sessionId === sessionId).map(publicBatch);
}

export function reconcileGeneratedAssetDownloadCustody(liveIds: readonly string[]): number {
  if (!Array.isArray(liveIds) || liveIds.length > 100 ||
      liveIds.some(id => typeof id !== 'string' || !COMMAND_ID.test(id))) return 0;
  const live = new Set(liveIds);
  const changed = new Set<InternalBatch>();
  let count = 0;
  for (const item of items.values()) {
    if (item.claimToken === null || terminal(item.state) || live.has(item.id)) continue;
    item.state = 'unconfirmed';
    item.detail = 'Browser receipt custody was lost before completion could be confirmed.';
    const batch = batches.get(item.batchId);
    if (batch) changed.add(batch);
    count++;
  }
  for (const batch of changed) publish(batch);
  return count;
}

function validSource(source: GeneratedAssetDownloadSource): boolean {
  return Boolean(source && typeof source === 'object' &&
    typeof source.conversationId === 'string' && /^[a-f0-9-]{36}$/i.test(source.conversationId) &&
    Number.isSafeInteger(source.tab) && source.tab >= 0 &&
    typeof source.documentId === 'string' && DOCUMENT_ID.test(source.documentId) &&
    Number.isSafeInteger(source.documentGeneration) && source.documentGeneration >= 1 &&
    Number.isSafeInteger(source.spaEpoch) && source.spaEpoch >= 0);
}

export async function claimGeneratedAssetDownload(
  input: { id: string } & GeneratedAssetDownloadSource
): Promise<GeneratedAssetDownloadClaim | null> {
  const run = requestQueue.then(async () => {
    if (!COMMAND_ID.test(input?.id ?? '') || !validSource(input)) return null;
    const item = items.get(input.id);
    const presented = {
      tab: input.tab,
      documentId: input.documentId,
      documentGeneration: input.documentGeneration,
      spaEpoch: input.spaEpoch
    };
    if (!item || item.state !== 'requested' || item.claimToken !== null || !item.document ||
        item.conversationId !== input.conversationId || !sameDocument(item.document, presented)) return null;
    try {
      await canonicalTarget({ sessionId: item.sessionId, logicalMessageId: item.logicalMessageId,
        assetIds: [item.assetId] }, [item.assetId]);
    } catch { return null; }
    const session = await getSession(item.sessionId);
    if (items.get(input.id) !== item || item.state !== 'requested' || item.claimToken !== null ||
        !item.document || !sameDocument(item.document, presented) ||
        !session || session.conversationId !== item.conversationId ||
        session.bindingRevision !== item.bindingRevision) return null;
    item.claimToken = randomBytes(24).toString('base64url');
    const document = item.document;
    const batch = batches.get(item.batchId);
    if (batch) publish(batch);
    return {
      id: item.id,
      conversationId: item.conversationId,
      logicalMessageId: item.logicalMessageId,
      assetId: item.assetId,
      filename: item.filename,
      document,
      claimToken: item.claimToken
    };
  });
  requestQueue = run.then(() => undefined, () => undefined);
  return run;
}

const transitions: Record<GeneratedAssetDownloadState, ReadonlySet<GeneratedAssetDownloadState>> = {
  requested: new Set(['started', 'failed', 'unconfirmed']),
  started: new Set(['complete', 'failed', 'unconfirmed']),
  complete: new Set(),
  failed: new Set(),
  unconfirmed: new Set()
};

export async function recordGeneratedAssetDownloadResult(input: GeneratedAssetDownloadResult): Promise<boolean> {
  if (!input || typeof input !== 'object' || !COMMAND_ID.test(input.id) ||
      typeof input.claimToken !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.claimToken) ||
      !['started', 'complete', 'failed', 'unconfirmed'].includes(input.state)) return false;
  const item = items.get(input.id);
  if (!item || item.claimToken !== input.claimToken || !item.document) return false;
  if (item.state === input.state) return true;
  if (!transitions[item.state].has(input.state)) return false;
  item.state = input.state;
  item.detail = typeof input.detail === 'string' && input.detail.trim()
    ? input.detail.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_DETAIL)
    : null;
  const batch = batches.get(item.batchId);
  if (batch) publish(batch);
  return true;
}

export function subscribeGeneratedAssetDownloads(
  subscriber: (batch: GeneratedAssetDownloadBatch) => void
): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function resetGeneratedAssetDownloadsForTests(): void {
  batches.clear();
  items.clear();
  subscribers.clear();
  liveDocuments.clear();
  documentsComplete = false;
  requestQueue = Promise.resolve();
}
