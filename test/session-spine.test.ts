import { describe, expect, it } from 'vitest';
import { frontendSegments } from '../src/renderer/session-spine.js';
import type { SessionEvent, SessionOrigin } from '../src/shared/session.js';

/**
 * The spine is the visible separation between the durable local session and the replaceable
 * ChatGPT frontend it currently runs in. Lineage comes from `SessionOrigin` — a SESSION field,
 * not an event — plus the recorded `handoff` events that mark where one frontend gave way.
 *
 * `resume` is deliberately a `SessionOrigin` kind only. Reading it as a `SessionEvent` would hang
 * the spine off the wrong owner and it would never render, so the first case below is the guard
 * against that: an event list carrying a handoff but NO origin still has no lineage to draw.
 */

const handoff = (seq: number): SessionEvent =>
  ({ kind: 'handoff', seq, time: seq, handoffId: `h${seq}`, chars: 4100, reason: 'manual' }) as SessionEvent;

describe('session spine', () => {
  it('draws nothing for a session with no continuation and no handoff', () => {
    expect(frontendSegments([], null)).toEqual([]);
    // A handoff with no continuation origin still splits the run in two: the handoff event is
    // recorded evidence that a frontend ended, so a segment exists either side of it.
    expect(frontendSegments([handoff(1)], null)).toHaveLength(2);
    expect(frontendSegments([handoff(1)], null)[0]!.label).toMatch(/frontend 1/);
  });

  it('counts frontends from the whole session, so scrolling cannot change the spine', () => {
    // chat.ts passes the session's full loaded history rather than the windowed page: the number
    // of frontends is a fact about the session. This pins the count against the event list shape
    // that a page would shrink.
    const origin: SessionOrigin = { kind: 'resume', fromSessionId: 'A', agentId: null, task: '' };
    const all = [handoff(1), handoff(2)];
    expect(frontendSegments(all, origin)).toHaveLength(3);
    // A single handoff still yields exactly two segments — one joint, two runs.
    expect(frontendSegments(all.slice(0, 1), origin)).toHaveLength(2);
  });

  it('numbers one segment per frontend and puts the handoff between them', () => {
    const origin: SessionOrigin = { kind: 'resume', fromSessionId: 'A', agentId: null, task: '' };
    const segments = frontendSegments([handoff(1)], origin);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.index).toBe(1);
    expect(segments[1]!.index).toBe(2);
    expect(segments[0]!.endsWithHandoff).toBe(true);
    expect(segments[1]!.startsWithHandoff).toBe(true);
    // Only the joint's two sides are marked; a one-handoff session has no second joint.
    expect(segments[0]!.startsWithHandoff).toBe(false);
    expect(segments[1]!.endsWithHandoff).toBe(false);
  });

  it('treats a worker origin as a worker segment, not a resumed frontend', () => {
    const origin: SessionOrigin = { kind: 'worker', fromSessionId: 'A', agentId: 'worker-2', task: 'audit' };
    const segments = frontendSegments([], origin);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.label).toMatch(/worker/i);
    expect(segments[0]!.label).toContain('worker-2');
  });
});
