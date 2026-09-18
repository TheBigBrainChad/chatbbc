import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = () => fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

describe('settings navigation', () => {
  it('offers exactly five destinations', async () => {
    const text = await html();
    const tabs = [...text.matchAll(/data-tab="([a-z-]+)"/g)].map(m => m[1]);
    expect(tabs.sort()).toEqual(['activity', 'appearance', 'automation', 'usage', 'workspace']);
  });

  it('keeps Setup reachable without being a nav peer', async () => {
    const text = await html();
    expect(text).not.toContain('data-tab="setup"');
    expect(text).toContain('data-panel="setup"'); // the wizard page still exists
  });
});
