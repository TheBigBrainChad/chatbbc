import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryFor, categoryClass, CONTENT_CATEGORIES } from '../src/renderer/transcript-categories.js';

const renderer = path.resolve(__dirname, '../src/renderer');
const transcript = path.join(renderer, 'styles', 'transcript.css');

/** The families whose content is multi-line and worth a card surface. */
const CARD_CATEGORIES = ['authored', 'prose', 'code', 'diff', 'image', 'error', 'handoff', 'plan'] as const;
/** The families that are one dense line each, so a separator rather than a surface. */
const ROW_CATEGORIES = ['tool', 'worker'] as const;

/** The declarations of the first rule whose selector is exactly `selector`. */
async function blockFor(selector: string): Promise<string> {
  const css = await fs.readFile(transcript, 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^{}]*)\\}`));
  expect(match, `${selector} has no rule`).not.toBeNull();
  return match![1]!;
}

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
  it('gives every category its own accent', async () => {
    const css = await fs.readFile(transcript, 'utf8');
    for (const category of CONTENT_CATEGORIES) {
      // `(?![-a-z])` so `.cat-note` cannot be satisfied by a longer neighbour's rule.
      const block = css.match(new RegExp(`\.${categoryClass(category)}(?![-a-z])[^{}]*\{([^{}]*)\}`));
      expect(block, `${categoryClass(category)} has no rule`).not.toBeNull();
      expect(block![1], `${categoryClass(category)} defines no accent`).toMatch(/--cat:\s*var\(/);
    }
  });

  /**
   * The patchwork is a shape failure, not a colour one: it comes from giving every family
   * the same multi-line card. So the shared base must declare no surface, and only the
   * multi-line families may take one. Asserted here, on the rule that would introduce the
   * fill — a check on the per-category blocks alone stays green while the base repaints
   * every row.
   */
  it('draws a card only for the multi-line families', async () => {
    const base = await blockFor('.tl-row');
    // The base is the rail and nothing else: no perimeter, no fill.
    expect(base, 'the shared base paints a fill').not.toMatch(/\bbackground\b/);
    expect(base, 'the shared base draws a box around every family').not.toMatch(/(?:^|[;\s])border:\s/);

    for (const category of CARD_CATEGORIES) {
      const block = await blockFor(`.cat-${category}`);
      expect(block, `.cat-${category} is a card but has no surface`).toMatch(/background:\s*var\(--card\)/);
    }
    for (const category of [...ROW_CATEGORIES, 'note'] as const) {
      const block = await blockFor(`.cat-${category}`);
      expect(block, `.cat-${category} is not a card but paints one`).not.toMatch(/background:\s*var\(--card\)/);
    }
    // The quietest family is not a box at all.
    expect(await blockFor('.cat-note'), 'the note family draws an edge').toMatch(/border:\s*0/);
  });

  /**
   * An edge is the family's identity, so every family has a rail; a card's rail sits on its
   * card, a row's on its separator.
   */
  it('puts every family behind its own left rail', async () => {
    const base = await blockFor('.tl-row');
    expect(base).toMatch(/border-left:\s*2px solid var\(--cat/);
    for (const category of CONTENT_CATEGORIES) {
      const block = await blockFor(`.cat-${category}`);
      // A card restates the rail beside its own perimeter; a row inherits the base's.
      if ((CARD_CATEGORIES as readonly string[]).includes(category)) {
        expect(block, `.cat-${category} lost its rail under its card`).toMatch(/border-left:\s*2px solid var\(--cat/);
      }
    }
  });

  /**
   * `.tl-head` is the shared header contract, specified by §4.7 for the family cards. No
   * builder emits one yet, so this asserts the rule as the documented contract the next
   * consumer inherits — not as a rendered element, which nothing currently produces.
   */
  it('documents the shared header geometry the family cards will use', async () => {
    const head = await blockFor('.tl-row > .tl-head');
    // Chrome type, at the one header size every family shares.
    expect(head).toMatch(/var\(--ui-font-mono\)/);
    expect(head).toMatch(/calc\(10\.5px \* var\(--text-scale/);
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
