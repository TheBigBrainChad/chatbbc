import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSession, readAsset, sessionImageSets } from './session/store.js';
import { SandboxError, resolvePath } from './sandbox.js';
import sharp from './sharp.js';
import { wakeBrowserWork } from './browser-wake.js';
import { GENERATED_ASSET_LIMITS, type GeneratedAssetDownloadDocument } from '../shared/generated-assets.js';
import { liveDocumentFor } from './generated-asset-downloads.js';
import type { Root } from '../shared/types.js';
import { getConfig } from './config.js';

const HANDLE = /^[A-Za-z0-9_-]{32}$/;
const HANDLE_TTL_MS = 15 * 60_000;
const MAX_HANDLES = 256;

export class GeneratedAssetError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'GeneratedAssetError';
  }
}

export interface GeneratedAssetListing {
  handle: string;
  /** Original provenance/default only. A local preview uses previewFilename. */
  filename: string;
  previewFilename?: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | null;
  width: number | null;
  height: number | null;
  previewAvailable: boolean;
  originalAvailable: false;
}

interface HandleRecord {
  sessionId: string;
  logicalMessageId: string;
  assetId: string;
  bindingRevision: number;
  previewAssetId: string | null;
  mime: GeneratedAssetListing['mime'];
  width: number | null;
  height: number | null;
  filename: string;
  createdAt: number;
}

const handles = new Map<string, HandleRecord>();
let transfers = 0;

export interface SaveGeneratedAssetRequest {
  sessionId: string;
  handle: string;
  path: string;
  source: 'original' | 'preview';
  roots: readonly Root[];
  readOnly: boolean;
  canCreate: boolean;
  stillCurrent?: () => boolean;
  afterPreflight?: () => Promise<void>;
  readOriginal?: (record: HandleRecord) => Promise<Buffer>;
}

export interface SaveGeneratedAssetResult {
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  source: 'original' | 'preview';
}

function filename(index: number, extension: 'png' | 'webp' = 'png'): string {
  return `ChatBBC image ${String(index + 1).padStart(2, '0')}.${extension}`;
}

function expireHandles(now = Date.now()): void {
  for (const [handle, record] of handles) {
    if (now - record.createdAt > HANDLE_TTL_MS) handles.delete(handle);
  }
  while (handles.size > MAX_HANDLES) {
    const oldest = handles.keys().next().value;
    if (!oldest) break;
    handles.delete(oldest);
  }
}

export async function listGeneratedAssets(sessionId: string): Promise<GeneratedAssetListing[]> {
  expireHandles();
  const session = await getSession(sessionId);
  if (!session) throw new GeneratedAssetError('download_session_unavailable');
  const listed = await sessionImageSets(sessionId);
  const current = await getSession(sessionId);
  if (!current || current.conversationId !== session.conversationId ||
      current.bindingRevision !== session.bindingRevision) {
    throw new GeneratedAssetError('download_session_changed');
  }
  const rows: GeneratedAssetListing[] = [];
  let index = 0;
  for (const set of listed.sets) {
    for (const image of set.images) {
      if (rows.length >= GENERATED_ASSET_LIMITS.maxList) return rows;
      const record: HandleRecord = {
        sessionId,
        logicalMessageId: set.responseId,
        assetId: image.providerAssetId,
        bindingRevision: current.bindingRevision ?? 0,
        previewAssetId: image.previewAssetId ?? null,
        mime: image.previewMime ?? null,
        width: image.width ?? image.previewWidth ?? null,
        height: image.height ?? image.previewHeight ?? null,
        filename: filename(index),
        createdAt: Date.now()
      };
      index += 1;
      const handle = randomBytes(24).toString('base64url');
      handles.set(handle, record);
      rows.push({
        handle,
        filename: record.filename,
        ...(image.hasPreview ? { previewFilename: filename(index - 1, 'webp') } : {}),
        mime: record.mime,
        width: record.width,
        height: record.height,
        previewAvailable: image.hasPreview,
        originalAvailable: false
      });
    }
  }
  return rows;
}

export interface GeneratedAssetPreviewSelection {
  sessionId: string;
  logicalMessageId: string;
  conversationId: string | null;
  bindingRevision: number;
  images: Array<{ assetId: string; previewAssetId: string | null; previewMime: string | null; filename: string }>;
}

/** Freeze canonical membership before opening a human-owned destination picker. */
export async function prepareGeneratedAssetPreviewSave(
  sessionId: string, logicalMessageId: string, assetIds: readonly string[],
  stillCurrent?: () => boolean
): Promise<GeneratedAssetPreviewSelection> {
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 20 ||
      new Set(assetIds).size !== assetIds.length ||
      assetIds.some(id => !/^file_[A-Za-z0-9_-]{8,100}$/.test(id))) {
    throw new GeneratedAssetError('download_batch_invalid');
  }
  if (stillCurrent && !stillCurrent()) throw new GeneratedAssetError('download_selection_changed');
  const session = await getSession(sessionId);
  if (!session) throw new GeneratedAssetError('download_session_unavailable');
  const listed = await sessionImageSets(sessionId, [logicalMessageId]);
  const set = listed.sets.find(row => row.responseId === logicalMessageId);
  if (!set || assetIds.some(id => !set.images.some(image => image.providerAssetId === id))) {
    throw new GeneratedAssetError('download_asset_unavailable');
  }
  const again = await getSession(sessionId);
  if (!again || again.conversationId !== session.conversationId ||
      again.bindingRevision !== session.bindingRevision ||
      (stillCurrent && !stillCurrent())) throw new GeneratedAssetError('download_selection_changed');
  return {
    sessionId, logicalMessageId, conversationId: session.conversationId,
    bindingRevision: session.bindingRevision ?? 0,
    images: assetIds.map(assetId => {
      const index = set.images.findIndex(image => image.providerAssetId === assetId);
      const image = set.images[index]!;
      return {
        assetId, previewAssetId: image.previewAssetId ?? null,
        previewMime: image.previewMime ?? null,
        filename: filename(index, 'webp')
      };
    })
  };
}

export interface GeneratedAssetPreviewSaveResult {
  saved: number;
  failed: number;
  cancelled: boolean;
  firstError?: string;
}

/**
 * Human-chosen filesystem destination; intentionally separate from the agent's approved
 * roots and opaque-handle save path. No caller-supplied provider URL can reach this path.
 */
export async function saveGeneratedAssetPreviews(
  selection: GeneratedAssetPreviewSelection,
  destination: { kind: 'file' | 'directory'; path: string },
  stillCurrent?: () => boolean
): Promise<GeneratedAssetPreviewSaveResult> {
  const result: GeneratedAssetPreviewSaveResult = { saved: 0, failed: 0, cancelled: false };
  const fail = (error: unknown): void => {
    result.failed++;
    result.firstError ??= error instanceof Error ? error.message : 'Could not save preview';
  };
  if ((selection.images.length === 1) !== (destination.kind === 'file')) {
    throw new GeneratedAssetError('download_batch_invalid');
  }
  let directory: string;
  try {
    if (destination.kind === 'file' && path.extname(destination.path).toLowerCase() !== '.webp') {
      throw new GeneratedAssetError('destination_extension', 'Choose a .webp destination.');
    }
    directory = await fs.realpath(destination.kind === 'file' ? path.dirname(destination.path) : destination.path);
    if (!(await fs.stat(directory)).isDirectory()) throw new GeneratedAssetError('destination_invalid');
  } catch (error) {
    result.failed = selection.images.length;
    result.firstError = error instanceof Error ? error.message : 'Invalid destination';
    return result;
  }
  for (const [index, image] of selection.images.entries()) {
    try {
      const session = await getSession(selection.sessionId);
      if (!session || session.conversationId !== selection.conversationId ||
          (session.bindingRevision ?? 0) !== selection.bindingRevision ||
          (stillCurrent && !stillCurrent())) throw new GeneratedAssetError('download_selection_changed');
      const current = await sessionImageSets(selection.sessionId, [selection.logicalMessageId]);
      const member = current.sets.find(set => set.responseId === selection.logicalMessageId)?.images
        .find(row => row.providerAssetId === image.assetId);
      if (!member || !image.previewAssetId || member.previewAssetId !== image.previewAssetId ||
          member.previewMime !== image.previewMime) throw new GeneratedAssetError('preview_unavailable');
      const bytes = await readAsset(selection.sessionId, image.previewAssetId, GENERATED_ASSET_LIMITS.maxCompressedBytes);
      if (!bytes) throw new GeneratedAssetError('preview_unavailable');
      const decoded = await decodeImage(bytes);
      if (`image/${decoded.format}` !== image.previewMime) throw new GeneratedAssetError('preview_invalid');
      const webp = await sharp(bytes, { limitInputPixels: GENERATED_ASSET_LIMITS.maxDecodedPixels, animated: false })
        .webp().toBuffer();
      if (webp.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) throw new GeneratedAssetError('asset_oversize');
      const target = path.join(directory, destination.kind === 'file' ? path.basename(destination.path) : image.filename);
      const temporary = path.join(directory, `.chatbbc-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(webp);
          await file.sync();
        } finally {
          await file.close();
        }
        const latest = await getSession(selection.sessionId);
        if (!latest || latest.conversationId !== selection.conversationId ||
            (latest.bindingRevision ?? 0) !== selection.bindingRevision ||
            (stillCurrent && !stillCurrent())) throw new GeneratedAssetError('download_selection_changed');
        const latestSet = await sessionImageSets(selection.sessionId, [selection.logicalMessageId]);
        if (latestSet.sets.find(set => set.responseId === selection.logicalMessageId)?.images
          .find(row => row.providerAssetId === image.assetId)?.previewAssetId !== image.previewAssetId ||
            (stillCurrent && !stillCurrent())) throw new GeneratedAssetError('preview_unavailable');
        try {
          await fs.link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new GeneratedAssetError('destination_exists', 'A destination already exists; previews never replace files.');
          }
          if (['EOPNOTSUPP', 'ENOTSUP', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new GeneratedAssetError('destination_unsupported',
              'This destination does not support atomic no-replace saves (hard links).');
          }
          throw error;
        }
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      result.saved++;
    } catch (error) {
      fail(error);
      if (error instanceof GeneratedAssetError && error.code === 'download_selection_changed') {
        result.failed += selection.images.length - index - 1;
        break;
      }
    }
  }
  return result;
}

async function destinationRevision(real: string): Promise<string> {
  try {
    const stat = await fs.lstat(real);
    if (stat.isSymbolicLink()) throw new GeneratedAssetError('destination_link');
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function publishBytes(
  real: string, bytes: Buffer, root: Root, record: HandleRecord,
  conversationId: string | null, stillCurrent?: () => boolean
): Promise<void> {
  const temporary = path.join(path.dirname(real), `.chatbbc-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Linking the staged inode is the atomic, no-replace publication boundary. A second
    // writer creating the destination after our path checks wins; rename would erase it.
    const session = await getSession(record.sessionId);
    if (!session || session.bindingRevision !== record.bindingRevision ||
        session.conversationId !== conversationId || (stillCurrent && !stillCurrent())) {
      throw new GeneratedAssetError('asset_handle_expired');
    }
    try {
      const live = getConfig();
      if (live.readOnly || !live.capabilities.create) throw new GeneratedAssetError('write_disabled');
      if (!live.roots.some(approved => approved.name === root.name && approved.path === root.path)) {
        throw new GeneratedAssetError('path_refused');
      }
      await fs.link(temporary, real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new GeneratedAssetError('DESTINATION_CHANGED');
      }
      if (['EOPNOTSUPP', 'ENOTSUP', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new GeneratedAssetError('destination_unsupported',
          'Cannot guarantee atomic no-replace publication at this destination; choose a writable filesystem with hard-link support.');
      }
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function decodeImage(bytes: Buffer): Promise<{ width: number; height: number; format: string | undefined }> {
  if (bytes.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) throw new GeneratedAssetError('asset_oversize');
  const image = sharp(bytes, { limitInputPixels: GENERATED_ASSET_LIMITS.maxDecodedPixels, animated: false });
  const info = await image.metadata();
  if (!info.width || !info.height || info.width * info.height > GENERATED_ASSET_LIMITS.maxDecodedPixels) {
    throw new GeneratedAssetError('asset_oversize');
  }
  await image.stats();
  return { width: info.width, height: info.height, format: info.format };
}

export async function saveGeneratedAsset(input: SaveGeneratedAssetRequest): Promise<SaveGeneratedAssetResult> {
  expireHandles();
  if (input.readOnly || !input.canCreate) throw new GeneratedAssetError('write_disabled');
  const record = handles.get(input.handle);
  if (!record || !HANDLE.test(input.handle) || record.sessionId !== input.sessionId) {
    throw new GeneratedAssetError('asset_handle_refused');
  }
  const session = await getSession(input.sessionId);
  if (!session || session.bindingRevision !== record.bindingRevision) throw new GeneratedAssetError('asset_handle_expired');
  const conversationId = session.conversationId;
  if (input.stillCurrent && !input.stillCurrent()) throw new GeneratedAssetError('download_selection_changed');
  let resolved;
  try {
    resolved = await resolvePath(input.roots, input.path, { allowMissing: true });
  } catch (error) {
    if (error instanceof SandboxError) throw new GeneratedAssetError('path_refused', error.message);
    throw error;
  }
  const before = await destinationRevision(resolved.real);
  if (input.afterPreflight) await input.afterPreflight();
  if (before !== 'missing') {
    if (await destinationRevision(resolved.real) !== before) throw new GeneratedAssetError('DESTINATION_CHANGED');
    throw new GeneratedAssetError('destination_exists', 'Choose a new destination; generated asset saves never replace a file.');
  }
  if (input.stillCurrent && !input.stillCurrent()) throw new GeneratedAssetError('download_selection_changed');
  const again = await getSession(input.sessionId);
  if (!again || again.bindingRevision !== record.bindingRevision || again.conversationId !== conversationId) {
    throw new GeneratedAssetError('asset_handle_expired');
  }
  let bytes: Buffer;
  if (input.source === 'preview') {
    if (!record.previewAssetId) throw new GeneratedAssetError('preview_unavailable');
    const preview = await readAsset(input.sessionId, record.previewAssetId);
    if (!preview) throw new GeneratedAssetError('preview_unavailable');
    bytes = preview;
  } else {
    if (!input.readOriginal) throw new GeneratedAssetError('original_unavailable');
    if (transfers >= GENERATED_ASSET_LIMITS.maxConcurrentTransfers) throw new GeneratedAssetError('transfer_capacity');
    transfers += 1;
    try {
      bytes = await input.readOriginal(record);
    } finally {
      transfers -= 1;
    }
    if (!bytes || bytes.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) throw new GeneratedAssetError('asset_oversize');
  }
  const decoded = await decodeImage(bytes);
  let currentPath;
  try {
    currentPath = await resolvePath(getConfig().roots, input.path, { allowMissing: true });
  } catch (error) {
    if (error instanceof SandboxError) throw new GeneratedAssetError('path_refused', error.message);
    throw error;
  }
  if (currentPath.real !== resolved.real) throw new GeneratedAssetError('path_refused');
  await publishBytes(currentPath.real, bytes, currentPath.root, record, conversationId, input.stillCurrent);
  return {
    path: currentPath.virtual,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: decoded.width,
    height: decoded.height,
    source: input.source
  };
}

interface OriginalTransferDocument {
  tab: number;
  documentId: string;
  documentGeneration: number;
  spaEpoch: number;
}

interface OriginalTransfer {
  id: string;
  sessionId: string;
  conversationId: string;
  assetId: string;
  logicalMessageId: string;
  document: OriginalTransferDocument;
  offset: number;
  chunks: Buffer[];
  bytes: number;
  done: ((bytes: Buffer) => void) | null;
  fail: ((error: Error) => void) | null;
}

const originalTransfers = new Map<string, OriginalTransfer>();
let originalAdmissionClosed = false;

export function beginOriginalTransfer(record: {
  sessionId: string;
  conversationId: string;
  assetId: string;
  logicalMessageId: string;
  document: OriginalTransferDocument;
}): string {
  if (originalAdmissionClosed) throw new GeneratedAssetError('transfer_shutdown');
  if (originalTransfers.size >= GENERATED_ASSET_LIMITS.maxConcurrentTransfers) {
    throw new GeneratedAssetError('transfer_capacity');
  }
  const id = randomUUID();
  originalTransfers.set(id, {
    id,
    sessionId: record.sessionId,
    conversationId: record.conversationId,
    assetId: record.assetId,
    logicalMessageId: record.logicalMessageId,
    document: Object.freeze({ ...record.document }),
    offset: 0,
    chunks: [],
    bytes: 0,
    done: null,
    fail: null
  });
  return id;
}

/** True when the frozen document is still the one live document main proves for the conversation. */
function sameLiveDocument(conversationId: string, document: GeneratedAssetDownloadDocument): boolean {
  const live = liveDocumentFor(conversationId);
  return Boolean(live) && live!.tab === document.tab && live!.documentId === document.documentId &&
    live!.documentGeneration === document.documentGeneration && live!.spaEpoch === document.spaEpoch;
}

export async function readOriginalForHandle(sessionId: string, handle: string): Promise<Buffer> {
  const record = handles.get(handle);
  if (!record || record.sessionId !== sessionId) throw new GeneratedAssetError('asset_handle_refused');
  const session = await getSession(sessionId);
  if (!session?.conversationId) throw new GeneratedAssetError('download_session_unavailable');
  if (session.bindingRevision !== record.bindingRevision) throw new GeneratedAssetError('asset_handle_expired');
  // Shutdown may have begun while this read was awaiting. Recheck before admitting, so an
  // already-admitted save cannot escape the ordered teardown.
  if (originalAdmissionClosed) throw new GeneratedAssetError('transfer_shutdown');
  // The document is frozen here, from main's own proven-unique observation. The companion must
  // present this exact document before any byte is accepted, so a retry cannot retarget.
  const document = liveDocumentFor(session.conversationId);
  if (!document) throw new GeneratedAssetError('original_unavailable');
  // Recheck the document is still the live one and shutdown has not begun, with no await between
  // this point and publication.
  if (originalAdmissionClosed || !sameLiveDocument(session.conversationId, document)) {
    throw new GeneratedAssetError('transfer_shutdown');
  }
  const id = beginOriginalTransfer({
    sessionId,
    conversationId: session.conversationId,
    assetId: record.assetId,
    logicalMessageId: record.logicalMessageId,
    document: {
      tab: document.tab,
      documentId: document.documentId,
      documentGeneration: document.documentGeneration,
      spaEpoch: document.spaEpoch
    }
  });
  wakeBrowserWork();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Buffer>((_resolve, reject) => {
    timer = setTimeout(() => {
      originalTransfers.delete(id);
      reject(new GeneratedAssetError('original_unavailable'));
    }, GENERATED_ASSET_LIMITS.transferMs);
  });
  try {
    return await Promise.race([waitOriginalTransfer(id), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The frozen document of one live original transfer, or null when it is gone. */
export function originalTransferDocument(id: string): OriginalTransferDocument | null {
  return originalTransfers.get(id)?.document ?? null;
}

export function pendingOriginalTransfers(): Array<{
  id: string;
  conversationId: string;
  logicalMessageId: string;
  assetId: string;
  offset: number;
  document: OriginalTransferDocument;
}> {
  return [...originalTransfers.values()].map(transfer => ({
    id: transfer.id,
    conversationId: transfer.conversationId,
    logicalMessageId: transfer.logicalMessageId,
    assetId: transfer.assetId,
    offset: transfer.offset,
    document: transfer.document
  }));
}

/** Append one chunk only at its exact next offset; a repeated offset must carry identical bytes. */
export function appendOriginalChunk(id: string, offset: number, chunk: Buffer): void {
  const transfer = originalTransfers.get(id);
  if (!transfer || !Number.isSafeInteger(offset) || offset < 0 ||
      chunk.length < 1 || chunk.length > GENERATED_ASSET_LIMITS.maxChunkBytes) {
    throw new GeneratedAssetError('asset_chunk_refused');
  }
  if (offset < transfer.offset) {
    const start = offset;
    const prior = Buffer.concat(transfer.chunks).subarray(start, start + chunk.length);
    if (prior.length !== chunk.length || !prior.equals(chunk)) {
      throw new GeneratedAssetError('asset_chunk_conflict');
    }
    return;
  }
  if (offset !== transfer.offset) throw new GeneratedAssetError('asset_chunk_offset');
  if (transfer.bytes + chunk.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) {
    transfer.fail?.(new GeneratedAssetError('asset_oversize'));
    originalTransfers.delete(id);
    throw new GeneratedAssetError('asset_oversize');
  }
  transfer.chunks.push(Buffer.from(chunk));
  transfer.bytes += chunk.length;
  transfer.offset += chunk.length;
}

export function waitOriginalTransfer(id: string): Promise<Buffer> {
  const transfer = originalTransfers.get(id);
  if (!transfer) return Promise.reject(new GeneratedAssetError('asset_transfer_missing'));
  return new Promise((resolve, reject) => {
    transfer.done = resolve;
    transfer.fail = reject;
  });
}
export function finishOriginalTransfer(id: string, sha256: string): void {
  const transfer = originalTransfers.get(id);
  if (!transfer) throw new GeneratedAssetError('asset_transfer_missing');
  const bytes = Buffer.concat(transfer.chunks);
  const actual = createHash('sha256').update(bytes).digest('hex');
  originalTransfers.delete(id);
  if (actual !== sha256) {
    transfer.fail?.(new GeneratedAssetError('asset_digest_mismatch'));
    throw new GeneratedAssetError('asset_digest_mismatch');
  }
  transfer.done?.(bytes);
}

/** Fail every in-flight original waiter and drop its bytes, then close admission. */
export function stopOriginalTransfers(): number {
  originalAdmissionClosed = true;
  const count = originalTransfers.size;
  for (const transfer of originalTransfers.values()) {
    transfer.fail?.(new GeneratedAssetError('transfer_shutdown'));
  }
  originalTransfers.clear();
  return count;
}

export function resetGeneratedAssetsForTests(): void {
  handles.clear();
  transfers = 0;
  originalTransfers.clear();
  originalAdmissionClosed = false;
}
