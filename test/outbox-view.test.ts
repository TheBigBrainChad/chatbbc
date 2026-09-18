import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lifecycleOf } from '../src/renderer/message-lifecycle.js';
import { inputMessageRow } from '../src/renderer/outbox-view.js';

/**
 * A pending row states where its message has got to. The outbox records seven distinct states
 * (`queued | browser | tool | sent | cancelled | failed | decision`), and the product treats four
 * of them as different facts with different consequences: a message sitting in the outbox, one
 * inserted into the ChatGPT composer, one ChatGPT has accepted, and one an active turn is holding
 * are NOT the same thing. AGENTS.md forbids claiming a send from an insertion, so the row has to
 * say which one it is rather than show one ambiguous clock.
 */

let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); dom = undefined; vi.unstubAllGlobals(); });

describe('message lifecycle', () => {
  it('gives each delivery stage its own label and tone', () => {
    const stages = ['queued', 'browser', 'tool', 'sent'].map(state => lifecycleOf({ state } as never));
    expect(new Set(stages.map(stage => stage.label)).size).toBe(4);
    expect(new Set(stages.map(stage => stage.tone)).size).toBe(4);
    for (const stage of stages) expect(stage.detail).toBeTruthy();
  });

  it('treats failure and cancellation as terminal, not as waiting', () => {
    expect(lifecycleOf({ state: 'failed' } as never).tone).toBe('failed');
    expect(lifecycleOf({ state: 'cancelled' } as never).tone).toBe('failed');
    expect(lifecycleOf({ state: 'queued' } as never).tone).toBe('queued');
  });

  it('labels a future due time as scheduled rather than plainly queued', () => {
    const scheduled = lifecycleOf({ state: 'queued', dueAt: Date.now() + 60_000 } as never);
    const plain = lifecycleOf({ state: 'queued' } as never);
    expect(scheduled.label).not.toBe(plain.label);
    expect(scheduled.tone).toBe('scheduled');
  });
});

describe('pending rows', () => {
  /**
   * The row builder reads only the delivery fields off its host for a plain entry, and builds with
   * the shared `el` helper, so the globals those touch are what this needs.
   */
  function mount(): void {
    dom = new JSDOM('<body></body>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  }
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'input-1', state: 'queued', text: 'run the suite', createdAt: Date.now(), attachments: [], ...over
  }) as never;

  it('carries its stage as a tone and states it as visible text', () => {
    mount();
    const stage = lifecycleOf({ state: 'browser' } as never);
    const row = inputMessageRow({ state: () => null } as never, entry({ state: 'browser' }), false);
    // The tone is what the stylesheet keys on, so a re-flattened row would lose its identity.
    expect(row.dataset.tone).toBe('composer');
    expect(row.className).toContain('tone-composer');
    // The claim must be readable without hovering: the old row hid it in a `title`.
    expect(row.textContent).toContain(stage.label);
    expect(row.textContent).toContain(stage.detail);
  });

  it('does not render two different stages identically', () => {
    mount();
    const states = ['queued', 'browser', 'tool', 'sent'];
    const tones = states.map(state => inputMessageRow({ state: () => null } as never, entry({ state }), false).dataset.tone);
    expect(new Set(tones).size).toBe(states.length);
  });
});

