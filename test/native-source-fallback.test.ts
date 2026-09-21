import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('ships the exact pinned GVDB source bytes for a fresh checkout without relying on an HTTP 406 endpoint', () => {
  const inventory = JSON.parse(readFileSync(path.join(root, 'docs/licenses/native/sources.json'), 'utf8'));
  const gvdb = inventory.sources.find((source: { id: string }) => source.id === 'gvdb');
  expect(gvdb).toMatchObject({
    version: '2b42fc75f09dbe1cd1057580b5782b08f2dcb400',
    sha256: '069a00aa1fc893f18423602f4e095583be5a220429f6e8a58d70511490b4b019',
    bytes: 24716,
    bundledFile: 'pinned/gvdb-53daeeb4.tar.gz'
  });
  const archive = readFileSync(path.join(root, 'docs/licenses/native', gvdb.bundledFile));
  expect(archive.byteLength).toBe(gvdb.bytes);
  expect(createHash('sha256').update(archive).digest('hex')).toBe(gvdb.sha256);
  const packaging = readFileSync(path.join(root, 'scripts/package-native-sources.mjs'), 'utf8');
  expect(packaging).toContain('source.bundledFile');
  expect(packaging).toContain('path.join(noticeDirectory, source.bundledFile)');
});
