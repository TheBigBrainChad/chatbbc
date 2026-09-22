/** The custom property an underfilled tail reservation carries, read by the transcript's padding. */
export const TIMELINE_RESERVE_PROPERTY = '--timeline-scroll-reserve';

/** The attribute a drawn row carries for the immutable canonical origin it stands for. */
export const TIMELINE_ORIGIN_ATTRIBUTE = 'data-timeline-origin';

/** Drop a stale tail reserve. A new selection, or a page that filled the tail, owns its own space. */
export function clearTimelineReserve(timeline: HTMLElement): void {
  timeline.style.removeProperty(TIMELINE_RESERVE_PROPERTY);
}

/** Focus an already-drawn row without moving the reader's surrounding scroll. */
function focusRow(target: HTMLElement): boolean {
  if (!target.isConnected) return false;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest' });
  return true;
}

/**
 * Focus the resident row drawn from one immutable canonical origin.
 *
 * A focus request is never a reason to read history: an origin that is not on screen returns
 * false and the caller keeps its own selection, so a stale ask cannot retarget another session's
 * transcript or pull a page the reader did not navigate to.
 */
export function focusTimelineOrigin(timeline: HTMLElement, origin: number): boolean {
  const row = timeline.querySelector<HTMLElement>(`[${TIMELINE_ORIGIN_ATTRIBUTE}="${origin}"]`);
  return row ? focusRow(row) : false;
}

/** Focus the gallery drawn from one exact native message id — a generated-image set.
 * When that gallery is off the page, focus the resident message row instead. */
export function focusTimelineMessage(timeline: HTMLElement, messageId: string): boolean {
  if (typeof messageId !== 'string' || messageId.length === 0) return false;
  const row = [...timeline.querySelectorAll<HTMLElement>('[data-image-message]')]
    .find(candidate => candidate.dataset.imageMessage === messageId);
  if (row) return focusRow(row.closest<HTMLElement>('.generated-image-gallery') ?? row);
  const assistant = `assistant_message\u0000${messageId}`;
  const user = `user_message\u0000${messageId}`;
  const message = [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .find(candidate => candidate.dataset.timelineKey === assistant || candidate.dataset.timelineKey === user);
  return message ? focusRow(message) : false;
}

/** Capture the visible logical row for one synchronous reconciliation. No retained
 * state: selection changes and user scrolling naturally get a fresh anchor. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const previous = pane.scrollTop;
  const following = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 40;
  const previousReserve = Number.parseFloat(timeline.style.getPropertyValue(TIMELINE_RESERVE_PROPERTY)) || 0;
  const previousContentHeight = timeline.getBoundingClientRect().height - previousReserve;
  const edge = pane.getBoundingClientRect().top;
  const rows = () => [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')]
    .filter(row => !row.matches('.tool-group[open]'));
  const anchors: Array<{ key: string | undefined; offset: number }> = [];
  if (!following) for (const row of rows()) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.top >= edge + pane.clientHeight) break;
    if (rect.bottom > edge) anchors.push({ key: row.dataset.timelineKey, offset: rect.top - edge });
  }
  return () => {
    clearTimelineReserve(timeline);
    if (following) {
      const growth = Math.max(0, timeline.getBoundingClientRect().height - previousContentHeight);
      const reserve = Math.max(0, previousReserve - growth);
      if (reserve > 0) timeline.style.setProperty(TIMELINE_RESERVE_PROPERTY, `${reserve}px`);
      pane.scrollTop = pane.scrollHeight;
      return;
    }
    const currentRows = new Map(rows().map(row => [row.dataset.timelineKey, row]));
    for (const anchor of anchors) {
      const rect = currentRows.get(anchor.key)?.getBoundingClientRect();
      if (!rect || rect.height <= 0) continue;
      const top = pane.scrollTop + rect.top - pane.getBoundingClientRect().top - anchor.offset;
      // An underfilled tail has real blank space below its last row. Prepending
      // must preserve that space too, otherwise Chromium clamps the restored
      // anchor to the new bottom and moves every visible message. Recompute the
      // reserve on each paint so later content naturally consumes it.
      let reserve = Math.ceil(top - Math.max(0, pane.scrollHeight - pane.clientHeight));
      if (reserve > 0) {
        // scrollHeight is floored at clientHeight. When eviction leaves less than
        // one viewport of content, it hides the additional blank-space deficit.
        // Measure with one viewport of temporary padding, then remove the excess;
        // both writes happen before paint and leave only the required reserve.
        reserve += pane.clientHeight;
        timeline.style.setProperty(TIMELINE_RESERVE_PROPERTY, `${reserve}px`);
        reserve = Math.max(0, reserve - (pane.scrollHeight - pane.clientHeight - top));
        timeline.style.setProperty(TIMELINE_RESERVE_PROPERTY, `${Math.ceil(reserve)}px`);
      }
      pane.scrollTop = top;
      return;
    }
    pane.scrollTop = previous;
  };
}
