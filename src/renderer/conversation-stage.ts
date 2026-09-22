import type { SessionEvent, SessionOrigin, StoredText } from '../shared/session.js';
import type { DeliveryHost } from './outbox-view.js';
import {
  createTimelineView,
  type TimelinePage,
  type TimelinePaint,
  type TimelineView
} from './timeline-view.js';

/**
 * The conversation stage: which session the transcript belongs to, and the mounted region all of
 * it draws into.
 *
 * The stage is the transcript's owner identity. A selection adopts an owner and its generation
 * before any read starts, and every arriving page must name exactly that owner and generation, so
 * A → B → A retires B's page and A's earlier one without any of them reaching the rows. It does
 * not load or command sessions: the controller asks the stage for the origin a page should be
 * read from, calls the session IPC, and hands the answer back.
 *
 * The composer stays outside the stage; the transcript region stays mounted while it lives.
 */

/** Which session the transcript belongs to, and which selection generation that was. */
export interface ConversationStageOwner {
  sessionId: string | null;
  generation: number;
}

export interface ConversationStageOptions {
  /** The scroll pane the transcript reads its geometry from, and the container rows go in. */
  pane: () => HTMLElement;
  timeline: () => HTMLElement;
  /** The outbox, whose pending and retired rows the transcript projects into place. */
  outbox: DeliveryHost;
  /** The selected session's own lineage; a session field, never an event. */
  origin: () => SessionOrigin | null;
  /** True in developer mode: lifecycle, repair and note rows are part of the transcript then. */
  developerMode: () => boolean;
  /** One canonical assistant message, by the module that owns the sanitizer pipeline. */
  renderMarkdown: (source: string, capture?: StoredText) => HTMLElement;
  renderMessage: (html: StoredText | null | undefined, fallback: string) => HTMLElement;
  /** Hand a persisted original back to its exact witness; false when it no longer applies. */
  openOriginal: (sessionId: string, messageId: string, current: () => boolean) => Promise<boolean>;
  /** Open the one worker chat this prime spawned for an agent; null when that is ambiguous. */
  workerChat: (agent: string) => (() => void) | null;
}

export interface ConversationStage {
  /** Adopt an owner before its page arrives; a page for any other owner is discarded. */
  select(sessionId: string | null, generation: number): void;
  /** Merge and draw the exact page for the current owner; false when the page is stale. */
  update(page: TimelinePage, generation: number): boolean;
  /** Draw the resident window again; null while the owner's page has not arrived yet. */
  paint(options?: { followBottom?: boolean }): TimelinePaint | null;
  /** The owner's page has not arrived: the previous transcript stays mounted and inert. */
  awaiting(): boolean;
  /** The reader is off the live tail, reading recorded history. */
  browsing(): boolean;
  /** The immutable origins the controller pages from; null when there is nothing to request. */
  olderOrigin(): number | null;
  newerOrigin(): number | null;
  /** Focus the resident row drawn from one immutable origin; false when it is not on screen. */
  focusOrigin(origin: number): boolean;
  /** Focus the gallery drawn from one exact native message; false when it is not on screen. */
  focusMessage(messageId: string): boolean;
  /** Whether the resident window carries model activity after a timestamp. */
  hasLaterActivity(time: number): boolean;
  /** The resident window, chronological. */
  events(): readonly SessionEvent[];
  setFilter(agent: string | null): void;
  /** Draw one session's bounded rows into the pane that previews it (the agent pane). */
  previewRows(source: SessionEvent[], sessionId: string, current: () => boolean, groups: Map<string, HTMLDetailsElement>): HTMLElement[];
  /** Retire the window and the rows drawn from it (a deletion, or a read that failed). */
  clear(): void;
  dispose(): void;
  current(): ConversationStageOwner;
}

export function createConversationStage(options: ConversationStageOptions): ConversationStage {
  let owner: ConversationStageOwner = { sessionId: null, generation: 0 };
  const view: TimelineView = createTimelineView({
    ...options,
    sessionId: () => owner.sessionId,
    generation: () => owner.generation
  });

  return {
    select(sessionId, generation) {
      // The drawn rows stay mounted until the destination arrives, so the previous chat is not
      // replaced by the New Chat welcome during the read. The window behind them is retired here,
      // which is what makes a page for the previous owner stale.
      if (sessionId !== owner.sessionId) view.retire();
      owner = { sessionId, generation };
    },
    update: (page, generation) => view.update(page, generation),
    paint: options_ => view.paint(options_),
    awaiting: () => owner.sessionId !== null && !view.loaded(),
    browsing: () => view.browsing(),
    olderOrigin: () => view.olderOrigin(),
    newerOrigin: () => view.newerOrigin(),
    focusOrigin: origin => view.focusOrigin(origin),
    focusMessage: messageId => view.focusMessage(messageId),
    hasLaterActivity: time => view.hasLaterActivity(time),
    events: () => view.events(),
    setFilter: agent => view.setFilter(agent),
    previewRows: (source, sessionId, current, groups) => view.previewRows(source, sessionId, current, groups),
    clear() {
      view.retire();
      view.clearRows();
    },
    dispose() {
      view.dispose();
      owner = { sessionId: null, generation: 0 };
    },
    current: () => ({ ...owner })
  };
}
