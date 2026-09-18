import { describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * One icon set and two motion durations.
 *
 * The icon weight is a shared decision, not a per-glyph one: when a couple of inline SVGs carried
 * 1.7 and 1.8 while the stylesheet said 1.6 the set read as mismatched weights side by side. Motion
 * is the same kind of decision — a handful of near-identical durations is not a system, and the
 * reduced-motion guard only helps if every duration actually flows through a token it can zero.
 */

const readHtml = fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

describe('icon set', () => {
  it('draws every glyph at one stroke weight', async () => {
    const html = await readHtml;
    // Language-flag artwork is a fill/flag asset with its own geometry, not a UI glyph.
    const sprite = html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</svg>', html.indexOf('<svg class="sprite"')));
    const widths = [...sprite.matchAll(/stroke-width="([\d.]+)"/g)].map(match => match[1]);
    expect(widths.every(width => width === '1.5'), `sprite widths: ${widths.join(', ')}`).toBe(true);
    const styles = await readRendererStyles();
    expect(styles).toMatch(/\.ico\s*\{[^}]*stroke-width:\s*1\.5/);
  });
});

describe('motion tokens', () => {
  it('routes every transition through a token the reduced-motion guard can zero', async () => {
    const styles = await readRendererStyles();
    expect(styles).toMatch(/--motion-state:\s*140ms/);
    expect(styles).toMatch(/--motion-fade:\s*120ms/);
    // A literal duration in a transition would survive the guard, so there must be none.
    const literal = [...styles.matchAll(/transition:[^;}]*?\b\d+(?:\.\d+)?m?s\b/g)]
      .map(match => match[0]).filter(declaration => !declaration.includes('var(--motion'));
    expect(literal, `transitions bypassing the tokens: ${literal.join(' | ')}`).toEqual([]);
  });
});
