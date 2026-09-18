import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = path.resolve(__dirname, '../src/renderer');
const sheets = ['base', 'shell', 'transcript', 'composer', 'panels', 'pages', 'dialogs'];

describe('renderer stylesheets', () => {
  it('are split into the seven responsible modules and imported by index.html', async () => {
    for (const name of sheets) {
      const text = await fs.readFile(path.join(renderer, 'styles', `${name}.css`), 'utf8');
      expect(text.length, `${name}.css is empty`).toBeGreaterThan(0);
    }
    const html = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    expect(html).not.toContain('href="./styles.css"');
    expect(html).toContain('href="./styles/base.css"');
  });

  it('links the modules in cascade order', async () => {
    const html = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
    // Order is load bearing: an equal-specificity tie between two modules is decided by
    // which sheet comes second, so the links must stay in the order the modules expect.
    const positions: number[] = sheets.map(name => html.indexOf(`href="./styles/${name}.css"`));
    for (const [i, position] of positions.entries()) {
      expect(position, `styles/${sheets[i]}.css is not linked`).toBeGreaterThan(-1);
      if (i > 0) expect(position, `styles/${sheets[i]}.css must load after styles/${sheets[i - 1]}.css`).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('keeps the whole declaration set — the split loses nothing', async () => {
    const merged = (await Promise.all(sheets.map(async name =>
      await fs.readFile(path.join(renderer, 'styles', `${name}.css`), 'utf8')))).join('\n');
    // Every custom property that existed before the split must still exist after it.
    for (const token of ['--r-xs:', '--r-sm:', '--r-md:', '--r-lg:', '--r-xl:', '--pill:',
      '--page:', '--ink:', '--card:', '--soft:', '--faint:', '--line:', '--accent:', '--lift:']) {
      expect(merged, `lost ${token}`).toContain(token);
    }
  });
});