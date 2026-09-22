import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSession, readAsset, sessionImageSets } from './session/store.js';
import { SandboxError, resolvePath } from './sandbox.js';
import sharp from './sharp.js';
import { GENERATED_ASSET_LIMITS } from '../shared/generated-assets.js';
import type { Root } from '../shared/types.js';

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
  filename: string;
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
  canEdit: boolean;
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

function filename(index: number): string {
  return `ChatBBC image ${String(index + 1).padStart(2, '0')}.png`;
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

async function publishBytes(real: string, bytes: Buffer, before: string): Promise<void> {
  const temporary = path.join(path.dirname(real), `.chatbbc-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (await destinationRevision(real) !== before) throw new GeneratedAssetError('DESTINATION_CHANGED');
    await fs.rename(temporary, real);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function decodeImage(bytes: Buffer): Promise<{ width: number; height: number }> {
  if (bytes.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) throw new GeneratedAssetError('asset_oversize');
  const image = sharp(bytes, { limitInputPixels: GENERATED_ASSET_LIMITS.maxDecodedPixels, animated: false });
  const info = await image.metadata();
  if (!info.width || !info.height || info.width * info.height > GENERATED_ASSET_LIMITS.maxDecodedPixels) {
    throw new GeneratedAssetError('asset_oversize');
  }
  await image.stats();
  return { width: info.width, height: info.height };
}

export async function saveGeneratedAsset(input: SaveGeneratedAssetRequest): Promise<SaveGeneratedAssetResult> {
  expireHandles();
  if (input.readOnly || (input.source === 'preview' && !input.canCreate && !input.canEdit)) {
    throw new GeneratedAssetError('write_disabled');
  }
  const record = handles.get(input.handle);
  if (!record || !HANDLE.test(input.handle) || record.sessionId !== input.sessionId) {
    throw new GeneratedAssetError('asset_handle_refused');
  }
  const session = await getSession(input.sessionId);
  if (!session || session.bindingRevision !== record.bindingRevision) throw new GeneratedAssetError('asset_handle_expired');
  if (input.stillCurrent && !input.stillCurrent()) throw new GeneratedAssetError('download_selection_changed');
  let resolved;
  try {
    resolved = await resolvePath(input.roots, input.path, { allowMissing: true });
  } catch (error) {
    if (error instanceof SandboxError) throw new GeneratedAssetError('path_refused', error.message);
    throw error;
  }
  const before = await destinationRevision(resolved.real);
  if (before === 'missing' && !input.canCreate) throw new GeneratedAssetError('write_disabled');
  if (before !== 'missing' && !input.canEdit) throw new GeneratedAssetError('write_disabled');
  if (input.afterPreflight) await input.afterPreflight();
  if (input.stillCurrent && !input.stillCurrent()) throw new GeneratedAssetError('download_selection_changed');
  const again = await getSession(input.sessionId);
  if (!again || again.bindingRevision !== record.bindingRevision || again.conversationId !== session.conversationId) {
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
  const currentPath = await resolvePath(input.roots, input.path, { allowMissing: true });
  if (currentPath.real !== resolved.real) throw new GeneratedAssetError('path_refused');
  await publishBytes(currentPath.real, bytes, before);
  return {
    path: currentPath.virtual,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: decoded.width,
    height: decoded.height,
    source: input.source
  };
}

interface OriginalTransfer {
  id: string;
  sessionId: string;
  conversationId: string;
  assetId: string;
  logicalMessageId: string;
  chunks: Buffer[];
  bytes: number;
  done: ((bytes: Buffer) => void) | null;
  fail: ((error: Error) => void) | null;
}

const originalTransfers = new Map<string, OriginalTransfer>();

export function beginOriginalTransfer(record: { sessionId: string; conversationId: string; assetId: string; logicalMessageId: string }): string {
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
    chunks: [],
    bytes: 0,
    done: null,
    fail: null
  });
  return id;
}

export function pendingOriginalTransfers(): Array<{ id: string; conversationId: string; logicalMessageId: string; assetId: string }> {
  return [...originalTransfers.values()].map(transfer => ({
    id: transfer.id,
    conversationId: transfer.conversationId,
    logicalMessageId: transfer.logicalMessageId,
    assetId: transfer.assetId
  }));
}

export function appendOriginalChunk(id: string, chunk: Buffer): void {
  const transfer = originalTransfers.get(id);
  if (!transfer || chunk.length < 1 || chunk.length > GENERATED_ASSET_LIMITS.maxChunkBytes) {
    throw new GeneratedAssetError('asset_chunk_refused');
  }
  if (transfer.bytes + chunk.length > GENERATED_ASSET_LIMITS.maxCompressedBytes) {
    transfer.fail?.(new GeneratedAssetError('asset_oversize'));
    originalTransfers.delete(id);
    throw new GeneratedAssetError('asset_oversize');
  }
  transfer.chunks.push(Buffer.from(chunk));
  transfer.bytes += chunk.length;
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

export function resetGeneratedAssetsForTests(): void {
  handles.clear();
  transfers = 0;
  originalTransfers.clear();
}
