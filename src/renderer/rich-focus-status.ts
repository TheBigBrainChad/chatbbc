import type { RichFocusStatus } from './rich-focus-stage.js';

/**
 * The transcript's copy of a rich-action result.
 * `sessions:richActionStatus` remains the ledger read. This map only projects that
 * result onto the focused row; it is not a second ledger.
 */
const byMessage = new Map<string, RichFocusStatus>();

const MESSAGE_ID = /^[a-z0-9:_-]{1,190}$/i;

export function richFocusStatus(logicalMessageId: string): RichFocusStatus | null {
  return byMessage.get(logicalMessageId) ?? null;
}

/** Project one `RichActionResult.state` onto the focused row. Unknown states clear it. */
export function projectRichActionResult(
  logicalMessageId: string,
  state: 'pending' | 'observed' | 'unknown' | 'changed' | 'unavailable'
): void {
  if (!MESSAGE_ID.test(logicalMessageId)) return;
  const status = state === 'pending' ? 'pending'
    : state === 'observed' ? 'confirmed'
      : state === 'unknown' ? 'unconfirmed'
        : state === 'changed' ? 'changed'
          : state === 'unavailable' ? 'unavailable' : null;
  if (!status) byMessage.delete(logicalMessageId);
  else byMessage.set(logicalMessageId, status);
}

export function clearRichFocusStatus(): void {
  byMessage.clear();
}
