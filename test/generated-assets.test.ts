import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, updateConfig } from '../src/main/config.js';
import {
  appendOriginalChunk,
  beginOriginalTransfer,
  finishOriginalTransfer,
  listGeneratedAssets,
  prepareGeneratedAssetPreviewSave,
  saveGeneratedAssetPreviews,
  resetGeneratedAssetsForTests,
  saveGeneratedAsset,
  waitOriginalTransfer
} from '../src/main/generated-assets.js';
import {
  createSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  upsertNativeImageEvent,
  writeAsset
} from '../src/main/session/store.js';
import type { Root } from '../src/shared/types.js';

let directory = '';
let rootPath = '';
const responseId = 'assistant:image-set:aurora';
const assetId = 'file_AuroraOriginal0001';

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbbc-generated-assets-'));
  rootPath = path.join(directory, 'approved');
  await fs.mkdir(rootPath);
  initConfigPath(directory);
  await updateConfig(() => defaultConfig());
  initSessionStore(directory);
  resetGeneratedAssetsForTests();
});

afterEach(async () => {
  resetGeneratedAssetsForTests();
  resetSessionStoreForTests();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const session = await createSession({ title: 'Aurora', conversationId: randomUUID() });
  const other = await createSession({ title: 'Other', conversationId: randomUUID() });
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const asset = await writeAsset(session.id, png, 'image/png');
  await upsertNativeImageEvent(session.id, {
    time: 1,
    source: 'extension',
    kind: 'native_image',
    messageId: responseId,
    providerAssetId: assetId,
    providerRole: 'tool',
    previewStatus: 'available',
    previewWidth: 8,
    previewHeight: 6,
    width: 8,
    height: 6,
    asset
  });
  const roots: Root[] = [{ name: 'approved', path: rootPath }];
  await updateConfig(config => ({ ...config, roots }));
  return { session, other, roots, png };
}

const saveBase = {
  readOnly: false,
  canCreate: true,
  source: 'preview' as const
};

describe('generated asset retrieval', () => {
  it('refuses a handle issued to another session', async () => {
    const { session, other, roots } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    await expect(saveGeneratedAsset({
      ...saveBase,
      sessionId: other.id,
      handle: row!.handle,
      path: '/approved/out.png',
      roots
    })).rejects.toMatchObject({ code: 'asset_handle_refused' });
    expect(JSON.stringify(row)).not.toMatch(/file_|https?:/);
  });
  it('does not replace a destination changed after preflight', async () => {
    const { session, roots, png } = await fixture();
    const destination = path.join(rootPath, 'out.png');
    const newer = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
    await fs.writeFile(destination, newer);
    const [row] = await listGeneratedAssets(session.id);
    let entered!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = saveGeneratedAsset({
      ...saveBase,
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/out.png',
      roots,
      afterPreflight: async () => { entered(); await gate; }
    });
    await enteredGate;
    const changed = Buffer.concat([newer, Buffer.from('changed')]);
    await fs.writeFile(destination, changed);
    release();
    await expect(save).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
    expect(await fs.readFile(destination)).toEqual(changed);
    expect(changed.equals(png)).toBe(false);
  });

  it('refuses to replace an existing file even when it is unchanged', async () => {
    const { session, roots } = await fixture();
    const destination = path.join(rootPath, 'out.png');
    const existing = Buffer.from('user-owned file');
    await fs.writeFile(destination, existing);
    const [row] = await listGeneratedAssets(session.id);
    await expect(saveGeneratedAsset({
      ...saveBase,
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/out.png',
      roots
    })).rejects.toMatchObject({ code: 'destination_exists' });
    expect(await fs.readFile(destination)).toEqual(existing);
  });

  it('does not overwrite a file created at the publication boundary', async () => {
    const { session, roots } = await fixture();
    const destination = path.join(rootPath, 'out.png');
    const external = Buffer.from('external writer');
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await fs.writeFile(target, external);
      return link(source, target);
    });
    const [row] = await listGeneratedAssets(session.id);
    await expect(saveGeneratedAsset({
      ...saveBase,
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/out.png',
      roots
    })).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
    expect(await fs.readFile(destination)).toEqual(external);
  });

  it('refuses unsupported no-replace filesystems without publishing partial bytes', async () => {
    const { session, roots } = await fixture();
    const destination = path.join(rootPath, 'unsupported.png');
    vi.spyOn(fs, 'link').mockRejectedValueOnce(Object.assign(new Error('Hard links unavailable'), {
      code: 'EOPNOTSUPP'
    }));
    const [row] = await listGeneratedAssets(session.id);
    await expect(saveGeneratedAsset({
      ...saveBase, sessionId: session.id, handle: row!.handle,
      path: '/approved/unsupported.png', roots
    })).rejects.toMatchObject({ code: 'destination_unsupported' });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a save when its approved root is revoked during preparation', async () => {
    const { session, roots } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    const destination = path.join(rootPath, 'revoked.png');
    await expect(saveGeneratedAsset({
      ...saveBase,
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/revoked.png',
      roots,
      afterPreflight: async () => {
        await updateConfig(config => ({ ...config, roots: [] }));
      }
    })).rejects.toMatchObject({ code: 'path_refused' });
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an original save after its session rebinds during transfer', async () => {
    const { session, roots, png } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    let entered!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = saveGeneratedAsset({
      ...saveBase,
      source: 'original',
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/rebound.png',
      roots,
      readOriginal: async () => { entered(); await gate; return png; }
    });
    await enteredGate;
    expect(await rebindSession(session.id, session.conversationId, randomUUID())).toBe(true);
    release();
    await expect(save).rejects.toMatchObject({ code: 'asset_handle_expired' });
    await expect(fs.stat(path.join(rootPath, 'rebound.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lists one opaque handle for every asset in one response', async () => {
    const { session } = await fixture();
    const second = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#00aa44' } }).png().toBuffer();
    const asset = await writeAsset(session.id, second, 'image/png');
    await upsertNativeImageEvent(session.id, {
      time: 2, source: 'extension', kind: 'native_image', messageId: responseId,
      providerAssetId: 'file_AuroraOriginal0002', providerRole: 'tool', previewStatus: 'available',
      previewWidth: 5, previewHeight: 5, width: 5, height: 5, asset
    });
    const rows = await listGeneratedAssets(session.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.handle)).size).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/file_|https?:/);
  });

  it('suggests a WebP preview name without mislabeling the original', async () => {
    const { session } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    expect(row).toMatchObject({
      filename: 'ChatBBC image 01.png',
      previewFilename: 'ChatBBC image 01.webp',
      mime: 'image/png',
      previewAvailable: true
    });
  });

  it('saves selected canonical previews as WebP without requiring an approved root', async () => {
    const { session } = await fixture();
    const chosen = path.join(directory, 'chosen.webp');
    const selection = await prepareGeneratedAssetPreviewSave(session.id, responseId, [assetId]);
    const result = await saveGeneratedAssetPreviews(selection, { kind: 'file', path: chosen });
    expect(result).toEqual({ saved: 1, failed: 0, cancelled: false });
    expect((await sharp(await fs.readFile(chosen)).metadata()).format).toBe('webp');
  });

  it('never replaces an existing destination, including one created during publication', async () => {
    const { session } = await fixture();
    const chosen = path.join(directory, 'chosen.webp');
    const selection = await prepareGeneratedAssetPreviewSave(session.id, responseId, [assetId]);
    await fs.writeFile(chosen, 'user bytes');
    expect(await saveGeneratedAssetPreviews(selection, { kind: 'file', path: chosen }))
      .toMatchObject({ saved: 0, failed: 1, cancelled: false });
    expect(await fs.readFile(chosen, 'utf8')).toBe('user bytes');
    await fs.rm(chosen);
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementationOnce(async (from, to) => {
      await fs.writeFile(to, 'concurrent bytes');
      return link(from, to);
    });
    expect(await saveGeneratedAssetPreviews(selection, { kind: 'file', path: chosen }))
      .toMatchObject({ saved: 0, failed: 1, cancelled: false });
    expect(await fs.readFile(chosen, 'utf8')).toBe('concurrent bytes');
  });

  it('preserves successful siblings when a later selected preview is unavailable', async () => {
    const { session } = await fixture();
    const missing = 'file_AuroraOriginal0002';
    await upsertNativeImageEvent(session.id, {
      time: 2, source: 'extension', kind: 'native_image', messageId: responseId,
      providerAssetId: missing, providerRole: 'tool', previewStatus: 'pending'
    });
    const selection = await prepareGeneratedAssetPreviewSave(session.id, responseId, [assetId, missing]);
    const result = await saveGeneratedAssetPreviews(selection, { kind: 'directory', path: directory });
    expect(result).toMatchObject({ saved: 1, failed: 1, cancelled: false });
    expect((await sharp(await fs.readFile(path.join(directory, 'ChatBBC image 01.webp'))).metadata()).format).toBe('webp');
    await expect(fs.stat(path.join(directory, 'ChatBBC image 02.webp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses stale session binding after selecting a destination', async () => {
    const { session } = await fixture();
    const selection = await prepareGeneratedAssetPreviewSave(session.id, responseId, [assetId]);
    expect(await rebindSession(session.id, session.conversationId, randomUUID())).toBe(true);
    const chosen = path.join(directory, 'stale.webp');
    expect(await saveGeneratedAssetPreviews(selection, { kind: 'file', path: chosen }))
      .toMatchObject({ saved: 0, failed: 1, cancelled: false });
    await expect(fs.stat(chosen)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not substitute a preview when the original reader is absent', async () => {
    const { session, roots } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    await expect(saveGeneratedAsset({
      ...saveBase,
      source: 'original',
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/original.png',
      roots
    })).rejects.toMatchObject({ code: 'original_unavailable' });
    await expect(fs.stat(path.join(rootPath, 'original.png'))).rejects.toThrow();
  });

  it('saves original bytes only after the chunk digest matches', async () => {
    const { session, roots, png } = await fixture();
    const [row] = await listGeneratedAssets(session.id);
    const id = beginOriginalTransfer({
      sessionId: session.id,
      conversationId: '11111111-2222-4333-8444-555555555555',
      assetId: 'file_AuroraOriginal0001',
      logicalMessageId: responseId,
      document: { tab: 42, documentId: 'doc-aurora', documentGeneration: 3, spaEpoch: 7 }
    });
    const pending = waitOriginalTransfer(id);
    appendOriginalChunk(id, 0, png.subarray(0, 40));
    // An identical replay of an acknowledged offset must be accepted without duplicating bytes.
    appendOriginalChunk(id, 0, png.subarray(0, 40));
    appendOriginalChunk(id, 40, png.subarray(40));
    finishOriginalTransfer(id, createHash('sha256').update(png).digest('hex'));
    const bytes = await pending;
    const saved = await saveGeneratedAsset({
      ...saveBase,
      source: 'original',
      sessionId: session.id,
      handle: row!.handle,
      path: '/approved/original.png',
      roots,
      readOriginal: async () => bytes
    });
    expect(saved.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(await fs.readFile(path.join(rootPath, 'original.png'))).toEqual(png);
  });
});
