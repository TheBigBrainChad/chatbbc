import { describe, expect, it } from 'vitest';
import { lifecycleOf } from '../src/renderer/message-lifecycle.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'i1', state: 'queued', text: 'x', createdAt: 0, ...over
}) as never;

describe('message lifecycle', () => {
  it('never renders two different facts the same way', () => {
    // These four are the facts the product insists are distinct.
    const queued = lifecycleOf(entry({ state: 'queued' }));
    const composer = lifecycleOf(entry({ state: 'browser' }));
    const turn = lifecycleOf(entry({ state: 'tool' }));
    const sent = lifecycleOf(entry({ state: 'sent' }));
    const labels = [queued, composer, turn, sent].map(l => l.label);
    expect(new Set(labels).size, 'two delivery stages share a label').toBe(4);
    expect(new Set([queued, composer, turn, sent].map(l => l.tone)).size).toBe(4);
  });

  it('labels a scheduled message by its due time, not as plain queued', () => {
    expect(lifecycleOf(entry({ dueAt: Date.now() + 60_000 })).label).toMatch(/after turn|scheduled/i);
  });

  it('marks failure and cancellation as terminal and retryable-looking', () => {
    expect(lifecycleOf(entry({ state: 'failed' })).tone).toBe('failed');
    expect(lifecycleOf(entry({ state: 'cancelled' })).tone).toBe('failed');
  });
});
