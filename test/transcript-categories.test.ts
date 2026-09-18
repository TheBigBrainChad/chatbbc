import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryFor, categoryClass, CONTENT_CATEGORIES } from '../src/renderer/transcript-categories.js';

const renderer = path.resolve(__dirname, '../src/renderer');

describe('transcript categories', () => {
  it('maps every recorded SessionEvent kind to exactly one category', () => {
    const kinds = ['session_start', 'user_message', 'assistant_message', 'tool_call', 'page_tool',
      'native_image', 'agent_message', 'progress', 'chat_error', 'note', 'handoff',
      'turn_start', 'turn_end'] as const;
    for (const kind of kinds) {
      const category = categoryFor(kind);
      expect(CONTENT_CATEGORIES, `${kind} has no category`).toContain(category);
    }
    expect(kinds).toHaveLength(13);
  });

  it('gives authored, generated and system their own identities', () => {
    expect(categoryFor('user_message')).toBe('authored');
    expect(categoryFor('agent_message')).toBe('worker');
    expect(categoryFor('chat_error')).toBe('error');
    // generated work and authored work must not share a class
    expect(categoryClass('authored')).not.toBe(categoryClass('worker'));
  });

  /**
   * The class a row carries is only half the identity: the other half is the stylesheet rule
   * it resolves to. A category added without one would render as exactly the same row as
   * every other family, which is the failure this lookup exists to prevent.
   */
  it('gives every category a rule in the transcript stylesheet', async () => {
    const css = await fs.readFile(path.join(renderer, 'styles', 'transcript.css'), 'utf8');
    for (const category of CONTENT_CATEGORIES) {
      // `(?![-a-z])` so `.cat-note` cannot be satisfied by a longer neighbour's rule.
      const block = css.match(new RegExp(`\.${categoryClass(category)}(?![-a-z])[^{}]*\{([^{}]*)\}`));
      expect(block, `${categoryClass(category)} has no rule`).not.toBeNull();
      // Accent on the rail, glyph and label only. A fill here is what makes a dense
      // transcript read as a patchwork, so no category may paint one.
      expect(block![1], `${categoryClass(category)} paints a fill`).not.toMatch(/\bbackground\b/);
    }
  });

  /** One geometry for every family; the accent is the only thing that varies. */
  it('shares one row geometry across every family', async () => {
    const css = await fs.readFile(path.join(renderer, 'styles', 'transcript.css'), 'utf8');
    const row = css.match(/\.tl-row\s*\{([^{}]*)\}/);
    expect(row, '.tl-row has no rule').not.toBeNull();
    // The shared card: one hairline outer edge and the 2px left rail the accent colours.
    expect(row![1]).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(row![1]).toMatch(/border-left-width:\s*2px/);
    const head = css.match(/\.tl-row\s*>\s*\.tl-head\s*\{([^{}]*)\}/);
    expect(head, '.tl-head has no rule').not.toBeNull();
    // Chrome type, at the one header size every family shares.
    expect(head![1]).toMatch(/var\(--ui-font-mono\)/);
    expect(head![1]).toMatch(/calc\(10\.5px \* var\(--text-scale/);
    // The rail is where each family spends its accent, so every family sets one.
    for (const category of CONTENT_CATEGORIES) {
      const block = css.match(new RegExp(`\.${categoryClass(category)}(?![-a-z])[^{}]*\{([^{}]*)\}`));
      expect(block![1], `${categoryClass(category)} has no left rail`).toMatch(/border-left-color:\s*var\(/);
    }
  });

  /**
   * The followed desktop theme supplies these four through `paletteTokens`. A machine with
   * no Omarchy theme never calls it, and an unresolved `var()` in a border colour makes the
   * whole declaration invalid — the rail would vanish rather than fall back.
   */
  it('defines the category palette for a machine with no desktop theme', async () => {
    const css = await fs.readFile(path.join(renderer, 'styles', 'base.css'), 'utf8');
    const light = css.match(/:root\s*\{([^}]*)\}/);
    const dark = css.match(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
    expect(light, 'base.css has no :root block').not.toBeNull();
    expect(dark, 'base.css has no dark theme block').not.toBeNull();
    for (const token of ['--cyan', '--magenta', '--yellow', '--ice']) {
      expect(light![1], `${token} is missing from the light defaults`).toContain(`${token}:`);
      expect(dark![1], `${token} is missing from the dark theme`).toContain(`${token}:`);
    }
  });
});
