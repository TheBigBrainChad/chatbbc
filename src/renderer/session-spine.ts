import type { SessionEvent, SessionOrigin } from '../shared/session.js';

/** One ChatGPT frontend's run inside a durable local session. */
export interface FrontendSegment {
  /** 1-based position on the spine. */
  index: number;
  label: string;
  /** A handoff precedes this segment (this frontend was opened by a compaction). */
  startsWithHandoff: boolean;
  /** A handoff follows this segment (this frontend was compacted away). */
  endsWithHandoff: boolean;
}

/**
 * The transcript belongs to the durable local session, not to any one ChatGPT chat.
 *
 * This product separates the two: Compact & Resume moves the same local session from frontend A to
 * frontend B while the session id, project, history, queue, worker family and terminal custody all
 * stay. The spine is that separation made visible, so a compaction reads as a joint in one
 * continuous thing rather than as a new conversation that happens to follow another.
 *
 * Lineage comes from `SessionOrigin` — which is a *session* field, **not** an event — plus the
 * recorded `handoff` events that mark where one frontend gave way to the next. `resume` is
 * deliberately a `SessionOrigin` kind only; it is never a `SessionEvent`, and reading it as one
 * would hang the spine off the wrong owner and it would never render.
 *
 * Returns no segments when there is no lineage, so a session that has never been compacted and has
 * no worker origin renders exactly as it did before the spine existed.
 */
export function frontendSegments(events: readonly SessionEvent[], origin: SessionOrigin | null): FrontendSegment[] {
  const handoffs = events.reduce((count, event) => count + (event.kind === 'handoff' ? 1 : 0), 0);
  // A replaceable frontend only exists when something continued into it: a resume, or a worker
  // spawned from a prime. `helper` and `desktop` are their own roles, not continuations of a chat.
  const continued = origin !== null && (origin.kind === 'resume' || origin.kind === 'worker');
  if (!continued && handoffs === 0) return [];

  // Each handoff splits the run in two, so N handoffs across one continuation make N + 1 frontends.
  const count = (continued ? 1 : 0) + handoffs;
  const workerLabel = origin?.kind === 'worker' ? `worker ${origin.agentId ?? ''}`.trim() : null;

  return Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    // The first segment of a worker session names the worker; every later one is a resumed frontend.
    label: offset === 0 && workerLabel ? workerLabel : `frontend ${offset + 1}`,
    startsWithHandoff: offset > 0,
    endsWithHandoff: offset < count - 1
  }));
}
