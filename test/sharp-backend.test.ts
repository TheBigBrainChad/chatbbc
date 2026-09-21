import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('isolates the Linux x64 Electron-only Sharp fork from host Node and Vitest', async () => {
  const source = readFileSync(path.join(root, 'src/main/sharp.ts'), 'utf8');
  expect(source).toContain('process.versions.electron');
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.electron) return;
  const { default: sharp } = await import('../src/main/sharp.js');
  const png = await sharp({ create: {
    width: 2, height: 2, channels: 4,
    background: { r: 1, g: 2, b: 3, alpha: 1 }
  } }).png().toBuffer();
  expect((await sharp(png).metadata()).format).toBe('png');
});
