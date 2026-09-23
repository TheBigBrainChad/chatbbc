import { TIMELINE_PAGE_ROWS } from './timeline-view.js';
import type { RichFocusStatus } from './rich-focus-stage.js';

/**
 * The transcript's copy of a rich-action result for the session on screen.
 * `sessions:richActionStatus` remains the ledger read. This map only projects that
 * result onto the loaded rows; it is not a second ledger. Task 2 owns the writer.
 */
const bySession = new Map<string, Map<string, RichFocusStatus>>();

/** One resident transcript window (the open page plus the eviction buffer behind it). */
export const RICH_FOCUS_STATUS_LIMIT = TIMELINE_PAGE_ROWS * 2;

/** Store ids are 8–64 of this shape; tests also use a short alphabetic id. */
const SESSION_KEY = /^[0-9a-z-]{1,64}$/i;

/** Rich logical message ids are any string up to 256 characters, without control characters. */
function messageKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function richFocusStatus(sessionId: string, logicalMessageId: string): RichFocusStatus | null {
  if (!SESSION_KEY.test(sessionId) || !messageKey(logicalMessageId)) return null;
  return bySession.get(sessionId)?.get(logicalMessageId) ?? null;
}

/** Project one `RichActionResult.state` onto one session's loaded row. Unknown states clear it. */
export function projectRichActionResult(
  sessionId: string,
  logicalMessageId: string,
  state: 'pending' | 'observed' | 'unknown' | 'changed' | 'unavailable'
): void {
  if (!SESSION_KEY.test(sessionId) || !messageKey(logicalMessageId)) return;
  const status = state === 'pending' ? 'pending'
    : state === 'observed' ? 'confirmed'
      : state === 'unknown' ? 'unconfirmed'
        : state === 'changed' ? 'changed'
          : state === 'unavailable' ? 'unavailable' : null;
  const rows = bySession.get(sessionId) ?? new Map<string, RichFocusStatus>();
  if (!status) {
    rows.delete(logicalMessageId);
    if (rows.size === 0) bySession.delete(sessionId);
    return;
  }
  if (!bySession.has(sessionId)) bySession.set(sessionId, rows);
  if (rows.has(logicalMessageId)) rows.delete(logicalMessageId);
  rows.set(logicalMessageId, status);
  while (rows.size > RICH_FOCUS_STATUS_LIMIT) {
    const oldest = rows.keys().next().value;
    if (oldest === undefined) break;
    rows.delete(oldest);
  }
}

/** Keep only the assistant messages still loaded for this session. */
export function retainRichFocusStatus(sessionId: string, messageIds: readonly string[]): void {
  if (!SESSION_KEY.test(sessionId)) return;
  const rows = bySession.get(sessionId);
  if (!rows) return;
  const keep = new Set(messageIds.filter(id => messageKey(id)));
  for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
  if (rows.size === 0) bySession.delete(sessionId);
}

/** Drop one session's display copy when that owner leaves, is cleared, or is disposed. */
export function retireRichFocusStatus(sessionId: string): void {
  if (!SESSION_KEY.test(sessionId)) return;
  bySession.delete(sessionId);
}

export function clearRichFocusStatus(): void {
  bySession.clear();
}
