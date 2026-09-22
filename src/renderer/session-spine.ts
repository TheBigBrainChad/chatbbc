import { el } from './dom.js';
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

  // A handoff is a boundary: it ended one frontend and opened the next, so N handoffs across one
  // session make N + 1 runs — the commonest case being a fresh session that compacted once, whose
  // origin is null because nothing continued into it and whose transcript still spans two chats.
  const count = handoffs > 0 ? handoffs + 1 : 1;
  const workerLabel = origin?.kind === 'worker' ? `worker ${origin.agentId ?? ''}`.trim() : null;

  return Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    // The first segment of a worker session names the worker; every later one is a resumed frontend.
    label: offset === 0 && workerLabel ? workerLabel : `frontend ${offset + 1}`,
    startsWithHandoff: offset > 0,
    endsWithHandoff: offset < count - 1
  }));
}

/**
 * The header that opens one ChatGPT frontend's run inside this durable local session.
 *
 * The spine itself is drawn by the `.spine` container; these headers are the labelled divisions
 * on it. They read only what the segment list already says — nothing here decides lineage.
 */
export function spineSegmentRow(segment: FrontendSegment): HTMLElement {
  const row = el('div', 'spine-seg');
  row.dataset.spineSegment = String(segment.index);
  const label = el('span', 'spine-seg-label', segment.label);
  row.append(label);
  if (segment.startsWithHandoff) row.classList.add('is-after-handoff');
  return row;
}

/**
 * Insert a frontend segment header ahead of each segment's first row.
 *
 * Compaction rows are the joints on the spine: a segment after the first begins immediately after
 * one. The existing row pipeline is untouched — a header is spliced between rows rather than
 * tagging every row. When a segment contributes no rows of its own (a compaction recorded before
 * any answer) its header is still emitted at the boundary, so the reader sees that it existed.
 */
export function withSpineSegments(rows: HTMLElement[], spine: readonly FrontendSegment[]): HTMLElement[] {
  const out: HTMLElement[] = [spineSegmentRow(spine[0]!)];
  let next = 1;
  for (const row of rows) {
    out.push(row);
    // A joint closes the segment above it and opens the one below.
    if (next < spine.length && row.classList.contains('ev-compaction')) {
      out.push(spineSegmentRow(spine[next]!));
      next++;
    }
  }
  return out;
}
