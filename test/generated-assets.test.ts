import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, updateConfig } from '../src/main/config.js';
import {
  listGeneratedAssets,
  resetGeneratedAssetsForTests,
  saveGeneratedAsset
} from '../src/main/generated-assets.js';
import {
  createSession,
  initSessionStore,
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
  return { session, other, roots, png };
}

const saveBase = {
  readOnly: false,
  canCreate: true,
  canEdit: true,
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
});
