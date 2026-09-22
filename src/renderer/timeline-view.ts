import { $, clockTime, compactNumber, el, icon, reconcileChildren, run } from './dom.js';
import { t, ui } from './i18n.js';
import { chronological, positionOf } from '../shared/chronology.js';
import {
  ATTRIBUTION_LABELS,
  continuationMarkerOf,
  foldProgress,
  toolCallSummary,
  TURN_OUTCOME_LABELS
} from '../shared/session.js';
import type { SessionEvent, SessionOrigin, StoredText } from '../shared/session.js';
import { RICH_LIMITS } from '../shared/rich-response.js';
import { MAX_INPUT_IMAGES } from '../shared/input.js';
import type { InputImage } from '../shared/input.js';
import type { InputEntry } from '../main/session/input.js';
import { messageReaction, withoutMessageReaction } from '../shared/message-reaction.js';
import { userPromptText } from '../shared/user-prompt.js';
import { chatErrorPresentation, duplicateChatErrors } from './chat-error.js';
import { communicationTitle, foldAgentCommunication } from './agent-communication.js';
import { KIND_ICON } from './session-list.js';
import { imageStorageButton } from './image-storage.js';
import { localDataUrl, retireRichImageViewerWithin, retireStaleRichImageViewer } from './rich-image.js';
import { renderRichResponse } from './rich-response.js';
import { toolResultText } from './tool-result.js';
import { categoryClass, contentRowIdentity } from './transcript-categories.js';
import { frontendSegments, withSpineSegments } from './session-spine.js';
import { clearTimelineReserve, focusTimelineMessage, focusTimelineOrigin, preserveTimelineViewport } from './timeline-scroll.js';
import {
  attachmentCard, historicalAutomaticInput, inputMessageRow, inputNotices, paintPendingInputs,
  type DeliveryHost
} from './outbox-view.js';

/**
 * The transcript: its rows, and the resident window they are drawn from.
 *
 * The view owns one bounded page of one durable session — the rows, the disclosure identities
 * that survive a repaint, the projections that decide what stays resident, and the exact origin
 * every drawn row stands for. It does not own the session: which session the window belongs to,
 * and which selection generation that is, arrive from the conversation stage, so a page read for
 * an owner the stage has already left is discarded here instead of painted.
 *
 * A repaint reuses rows by identity, not by content: a row is rebuilt only when the signature it
 * was drawn from changed, and the reader's visible row anchors the reconciliation.
 */

/** Page size and bounded staging capacity. A page is not a viewport: hundreds of
 * collapsed tool records can occupy less space than one authored message. */
export const TIMELINE_PAGE_ROWS = 160;
const MAX_TIMELINE_RESIDENT_ROWS = TIMELINE_PAGE_ROWS * 2;
const MAX_TIMELINE_TEXT_CHARS = 2 * 1024 * 1024;

/** The IPC page size each navigation asks for. Deliberate older/newer reading takes half a page,
 * so the row the reader was on stays inside the window the answer replaces. */
export function timelinePageRows(mode: TimelinePageMode): number {
  return mode === 'open' || mode === 'delta' ? TIMELINE_PAGE_ROWS : TIMELINE_PAGE_ROWS / 2;
}

/**
 * How an arriving page joins the resident window.
 *
 * `open` is a selection's first page, `delta` is a live publication-cursor read, `prepend` walks
 * backwards through recorded history and `append` walks forward through a window that had already
 * been evicted. Only `open` and `delta` follow the bottom: navigation is a reading position, not
 * a jump.
 */
export type TimelinePageMode = 'open' | 'prepend' | 'append' | 'delta';

export interface TimelinePage {
  /** The session this page was read for; a page for any other owner is stale. */
  sessionId: string | null;
  events: readonly SessionEvent[];
  total: number;
  mode: TimelinePageMode;
  /** The immutable origin the request navigated from (`before` for older, `after` for newer). */
  boundary?: number;
}

/** What one paint did, for the status line that summarises it. */
export interface TimelinePaint {
  /** Keyed rows now mounted, including grouped children. */
  rows: number;
  /** Events drawn from the page budget, and the ones kept back from it. */
  shown: number;
  omitted: number;
  /** The agent filter this paint applied, when one is active. */
  filter: { label: string; matched: number } | null;
  /** Resident window size, and the session's recorded total. */
  resident: number;
  total: number;
}

/** One row's own session, when the row is not drawn by the transcript itself (the agent pane). */
export interface RowContext {
  id: string;
  /** Whether that session and generation are still the ones on screen. */
  current: () => boolean;
  /** The history the row's presentation reads. */
  history: readonly SessionEvent[];
}

export interface TimelineViewOptions {
  /** The mounted scroll pane, and the container the rows go in. */
  pane: () => HTMLElement;
  timeline: () => HTMLElement;
  /** The outbox, whose pending and retired rows the transcript projects into place. */
  outbox: DeliveryHost;
  /** The session the window belongs to, and the generation it was adopted under. */
  sessionId: () => string | null;
  generation: () => number;
  /** The session's own lineage, for the frontend spine and the worker chip; a session field,
   * never an event. */
  origin: () => SessionOrigin | null;
  /** True in developer mode: lifecycle, repair and note rows are part of the transcript then. */
  developerMode: () => boolean;
  /** One canonical assistant message, rendered by the module that owns the sanitizer pipeline. */
  renderMarkdown: (source: string, capture?: StoredText) => HTMLElement;
  renderMessage: (html: StoredText | null | undefined, fallback: string) => HTMLElement;
  /** Hand a persisted original back to its exact witness; false when it no longer applies. */
  openOriginal: (sessionId: string, messageId: string, current: () => boolean) => Promise<boolean>;
  /** Open the one worker chat this prime spawned for an agent; null when that is ambiguous. */
  workerChat: (agent: string) => (() => void) | null;
  /** The live action result for one logical message, when the action owner has one. */
  richFocusStatus?: (logicalMessageId: string) => 'pending' | 'confirmed' | 'changed' | 'unavailable' | 'unconfirmed' | null;
}

export interface TimelineView {
  /** Merge one page for the current owner and draw it; false when the page is stale. */
  update(page: TimelinePage, generation: number): boolean;
  /** Draw the resident window again; null while the current owner's page has not arrived. */
  paint(options?: { followBottom?: boolean }): TimelinePaint | null;
  /** Focus the resident row drawn from one immutable origin; false when it is not on screen. */
  focusOrigin(origin: number): boolean;
  /** Focus the gallery drawn from one exact native message; false when it is not on screen. */
  focusMessage(messageId: string): boolean;
  /** The immutable origin an older page navigates from, or null at the recorded start. */
  olderOrigin(): number | null;
  /** The immutable origin a forward page navigates from, or null at the live tail. */
  newerOrigin(): number | null;
  /** The reader is off the live tail, reading recorded history. */
  browsing(): boolean;
  /** Whether a page has arrived for the current owner. */
  loaded(): boolean;
  /** The resident window, chronological. */
  events(): readonly SessionEvent[];
  setFilter(agent: string | null): void;
  hasLaterActivity(time: number): boolean;
  /** Draw one session's bounded rows into the pane that previews it (the agent pane). */
  previewRows(source: SessionEvent[], sessionId: string, current: () => boolean, groups: Map<string, HTMLDetailsElement>): HTMLElement[];
  /** Retire the window; the drawn rows stay mounted until a page replaces them. */
  retire(): void;
  /** Drop the drawn rows too, for a deletion or a destination read that failed. */
  clearRows(): void;
  dispose(): void;
}

export function createTimelineView(options: TimelineViewOptions): TimelineView {
  /**
   * Which agent's events the transcript is showing.
   *
   * `null` is everything. `UNATTRIBUTED` is its own bucket rather than being folded into "all",
   * because a call this app could not tie to any agent is a real category — with ChatGPT's
   * stateless connector it is the *default* category — and hiding it inside the total would let
   * a filtered view look complete when it is not.
   */
  const UNATTRIBUTED = '\u0000unattributed';
  let agentFilter: string | null = null;
  /** The session the current filter was chosen in; adopting a different one resets it. */
  let filterFor: string | null = null;

  /** The resident page: the recorded events this reader can reach without a new read. */
  let residentEvents: SessionEvent[] = [];
  let totalEvents = 0;
  /** Set once the current owner's first page has arrived. */
  let loaded = false;
  /** The immutable origin the reader walked back to; null while they are at the live tail. */
  let browsingFrom: number | null = null;

  /**
   * Tool calls the user has opened, by their durable call id.
   *
   * The timeline is redrawn whenever anything is recorded, and a fresh `<details>` is closed. So
   * opening a call to read its arguments and then having ChatGPT make one more MCP call — the
   * normal case — silently collapsed what you were reading, several times a minute. Remembering
   * the open set outside the DOM is what makes a redraw invisible; the ids are the recorder's
   * own, so they survive the rebuild. The agent pane draws the same calls, so it shares this set.
   *
   * Cleared when a different session is adopted, not on every repaint: the whole point is that a
   * repaint must not be able to change what is open.
   */
  const openTools = new Set<string>();

  /**
   * The transcript's rows currently on screen, by timeline key, with the signature they were
   * drawn from. A repaint rebuilds only the rows whose signature changed and reuses every other
   * element as it is: that keeps the scroll position honest, because a row the user opened keeps
   * its height and its place while ChatGPT records one more call.
   */
  const rowCache = new Map<string, { sig: string; row: HTMLElement }>();
  /** One activity disclosure between authored messages; communication keeps its own identity. */
  const toolGroups = new Map<string, HTMLDetailsElement>();

  function forgetRows(): void {
    openTools.clear();
    rowCache.clear();
    toolGroups.clear();
  }

  /**
   * The agent chips above the timeline: one identity per attribution in this resident window.
   *
   * Drawn only when the session actually has more than one attribution, so a single-agent
   * session — which is every session unless multi-agent mode is running — keeps exactly the view
   * it had before.
   */
  function paintAgentFilter(): void {
    const box = $('chatAgentFilter');
    if (!options.developerMode()) { box.hidden = true; agentFilter = null; return; }
    const named = [...new Set(residentEvents.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
    const anyUnattributed = residentEvents.some((event) => !event.agent);
    // A filter belongs to the session it was chosen in. Carrying it across an adopted session
    // showed the next session's timeline as empty with no chip lit to explain why — and agent
    // ids repeat between runs, so it could also silently hide half of one.
    if (filterFor !== options.sessionId()) {
      agentFilter = null;
      filterFor = options.sessionId();
    } else if (agentFilter !== null && agentFilter !== UNATTRIBUTED && !named.includes(agentFilter)) {
      agentFilter = null;
    }
    if (named.length === 0 || (named.length === 1 && !anyUnattributed)) {
      box.hidden = true;
      box.replaceChildren();
      agentFilter = null;
      return;
    }
    const buttons: HTMLElement[] = [];
    const chip = (value: string | null, label: string): HTMLElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.agent = value ?? '';
      if (agentFilter === value) button.classList.add('is-sel');
      return button;
    };
    buttons.push(chip(null, t("All")));
    for (const agent of named) buttons.push(chip(agent, agent));
    if (anyUnattributed) buttons.push(chip(UNATTRIBUTED, t("Unattributed")));
    box.replaceChildren(...buttons);
    box.hidden = false;
  }

  function visibleEvents(): SessionEvent[] {
    if (agentFilter === null) return residentEvents;
    if (agentFilter === UNATTRIBUTED) return residentEvents.filter((event) => !event.agent);
    return residentEvents.filter((event) => event.agent === agentFilter);
  }

  function hasLaterModelActivity(time: number): boolean {
    return residentEvents.some(event => event.time > time &&
      ['assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
  }

  function paintInputReceipt(row: HTMLElement, item: TimelineItem): void {
    if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
    const receipt = row.querySelector<HTMLElement>('.input-receipt');
    if (!receipt) return;
    receipt.hidden = hasLaterModelActivity(item.event.time);
    receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
  }

  /** Merge one live delta without letting canonical message revisions duplicate rows. */
  function mergeDelta(delta: readonly SessionEvent[]): void {
    const merged = [...residentEvents];
    const floor = residentEvents.length ? Math.min(...residentEvents.map(positionOf)) : 0;
    const messageRows = new Map<string, number>();
    for (let index = 0; index < merged.length; index++) {
      const key = canonicalMessageKey(merged[index]!);
      if (key) messageRows.set(key, index);
    }
    for (const event of delta) {
      const key = canonicalMessageKey(event);
      const index = key ? messageRows.get(key) : undefined;
      if (index !== undefined) merged[index] = event;
      else {
        // An old canonical revision is not newly authored history. Its original page still owns
        // it; admitting it here would evict an unrelated live row.
        if (positionOf(event) < floor) continue;
        if (key) messageRows.set(key, merged.length);
        merged.push(event);
      }
    }
    residentEvents = retainTimelinePage(chronological(foldProgress(merged)), 'newer', options.pane(), options.timeline());
  }

  // ------------------------------------------------------------------- rows

  function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: RowContext): HTMLElement {
    const { call } = event;
    const summary = toolCallSummary(call);
    const box = document.createElement('details');
    box.className = `tool tone-${call.summary.tone}`;
    box.open = openTools.has(call.callId);
    box.addEventListener('toggle', () => {
      if (box.open) openTools.add(call.callId);
      else openTools.delete(call.callId);
    });

    const head = document.createElement('summary');
    head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
    head.append(el('b', '', call.summary.title));
    if (call.summary.detail) head.append(el('em', '', call.summary.detail));
    if (summary.metric) head.append(el('span', 'metric', summary.metric));
    box.append(head);

    const raw = el('div', 'raw');
    const facts = el('p', 'raw-facts');
    ui(facts, 'textContent', () => `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
      t("placed by {0}", [ATTRIBUTION_LABELS[call.attribution] ?? call.attribution]));
    raw.append(facts);

    if (call.changes && call.changes.length > 0) {
      const changes = el('ul', 'changes');
      for (const change of call.changes) {
        const li = el('li');
        li.append(el('code', '', change.path));
        const counts = `+${change.added} −${change.removed}${change.approximate ? t(" (approx.)") : ''}`;
        li.append(el('span', 'metric', counts));
        changes.append(li);
      }
      raw.append(changes);
    }

    raw.append(el('h4', '', () => t("Arguments")));
    raw.append(textBlock('pre', call.args.text, call.args.truncated, call.args.chars));
    raw.append(el('h4', '', () => t("Result")));
    const images = call.assets?.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) ?? [];
    const readable = toolResultText(call.result.text, call.result.truncated, images.length > 0);
    if (readable) raw.append(textBlock('pre', readable, call.result.truncated && images.length === 0, call.result.chars));
    // Older recordings did not retain the reason an image asset was omitted. Explain the missing
    // local preview without inferring a historical provider receipt.
    if (call.tool === 'view_image' && call.outcome === 'ok' && images.length === 0) {
      raw.append(el('p', 'meta', () => t("No image preview was retained in this recording.")));
    }
    if (images.length && (context?.id || options.sessionId())) {
      const id = context?.id ?? options.sessionId()!, generation = options.generation();
      const attachments = el('div', 'tool-images');
      let loadedImages = false;
      const load = async () => {
        if (!box.open || loadedImages) return;
        loadedImages = true;
        for (const asset of images) {
          const data = await run(window.api.getSessionImage(id, asset.id));
          if (context ? !context.current() : id !== options.sessionId() || generation !== options.generation()) return;
          if (!data) { attachments.append(el('p', 'meta', () => t("Image unavailable"))); continue; }
          const image = document.createElement('img');
          image.src = data; image.alt = t("{0} result", [call.tool]); image.loading = 'lazy';
          image.style.cssText = 'display:block;max-width:100%;max-height:600px;object-fit:contain;margin:8px 0';
          attachments.append(image);
        }
      };
      box.addEventListener('toggle', () => void load());
      raw.append(attachments);
      void load();
    }
    if (call.result.assetId) raw.append(el('p', 'raw-facts', () => t("Full recorded response: {0}", [call.result.assetId])));

    for (const asset of call.assets ?? []) {
      raw.append(el('p', 'raw-facts', () => t("asset {0} · {1} · {2} bytes", [asset.id, asset.mimeType, compactNumber(asset.bytes)])));
    }

    box.append(raw);
    return box;
  }

  function paintMessageReaction(box: HTMLElement, value: unknown): void {
    const reaction = messageReaction(value);
    const existing = box.querySelector<HTMLElement>('.message-reaction');
    if (!reaction) { existing?.remove(); return; }
    if (existing?.textContent === reaction) return;
    const badge = existing ?? el('span', 'message-reaction');
    badge.textContent = reaction;
    badge.setAttribute('role', 'img');
    ui(badge, 'aria-label', () => t("ChatGPT reacted with {0}", [reaction]));
    if (!existing) box.append(badge);
  }

  function eventBody(event: SessionEvent, context?: RowContext): HTMLElement {
    switch (event.kind) {
      case 'session_start':
        return el('p', 'meta', () => t("Session started — {0}", [event.title]));
      case 'user_message': {
        const box = el('div', 'said is-user');
        box.classList.add('has-reaction-slot');
        box.append(el('b', '', () => t("You")));
        const attachments = el('div', 'message-attachments');
        if (event.attachments?.length) attachments.append(...event.attachments.map(file => attachmentCard(file)));
        const assets = event.assets?.filter(asset => asset.mimeType === 'image/webp').slice(0, MAX_INPUT_IMAGES) ?? [];
        const retained = retainedInputImages(event, context?.id ?? options.sessionId(), options.outbox.pendingComposerInputs());
        const preview = (data: string, retainedOnly = false, slot?: HTMLElement) => {
          const image = document.createElement('img');
          image.src = data; image.alt = t("User attachment"); image.loading = 'lazy';
          const frame = slot ?? el('div', 'user-image-slot');
          frame.replaceChildren(image);
          if (!slot) attachments.append(frame);
          if (retainedOnly) {
            const notice = el('span', 'retained-image-notice', () => t("Not saved to history"));
            ui(notice, 'title', () => t("Image preview retained with this delivery; not yet saved to history."));
            frame.append(notice);
          }
        };
        // History selection measures the viewport before IPC completes. Reserve each saved
        // image's final footprint now; loading, pixels and failure all occupy the same slot.
        const slots = assets.map(() => {
          const slot = el('div', 'user-image-slot');
          slot.append(el('span', 'meta', () => t("Image preview is loading")));
          attachments.append(slot);
          return slot;
        });
        if (event.attachments?.length || assets.length || retained.length) box.append(attachments);
        if (!assets.length) for (const image of retained) preview(image.dataUrl, true);
        // Native ChatGPT can prepend a blank paragraph. Ignore it only when a complete
        // instruction frame validates; keep the authored suffix exact.
        const userText = event.authoredText ?? userPromptText(event.message.text.trimStart()) ?? event.message.text;
        if (userText) box.append(textBlock('msg user-message-text', userText, event.authoredText === undefined && event.message.truncated, event.authoredText?.length ?? event.message.chars));
        paintMessageReaction(box, event.reaction);
        if (event.inputDelivery) {
          box.classList.add('has-input-receipt');
          const receipt = el('span', 'input-receipt');
          const label = event.inputDelivery === 'offered' ? t("Sent to the active turn · awaiting receipt") : t("Delivery confirmed");
          receipt.title = label; receipt.setAttribute('aria-label', label);
          receipt.append(icon(event.inputDelivery === 'offered' ? 'i-clock' : 'i-check'));
          box.append(receipt);
        }
        if (assets.length && (context?.id || options.sessionId())) {
          const id = context?.id ?? options.sessionId()!, generation = options.generation();
          void (async () => {
            for (const [index, asset] of assets.entries()) {
              const data = await run(window.api.getSessionImage(id, asset.id));
              if (context ? !context.current() : id !== options.sessionId() || generation !== options.generation()) return;
              const slot = slots[index]!;
              if (data) preview(data, false, slot);
              else if (retained[index]) preview(retained[index]!.dataUrl, true, slot);
              else slot.replaceChildren(el('span', 'meta', () => t("Image unavailable")));
            }
          })();
        }
        return box;
      }
      case 'assistant_message': {
        const box = el('div', 'said');
        box.append(el('b', '', () => event.final ? 'ChatGPT' : t("ChatGPT (partial)")));
        const id = context?.id ?? options.sessionId();
        const generation = options.generation();
        const currentRichRow = () => context
          ? context.current()
          : id !== null && options.sessionId() === id && options.generation() === generation;
        const focusStatus = !context && event.messageId ? options.richFocusStatus?.(event.messageId) ?? undefined : undefined;
        box.append(event.rich ? renderRichResponse(event.rich, event.message.text, id ? {
          sessionId: id,
          media: event.richMedia ?? [],
          current: currentRichRow,
          ...(focusStatus ? { focusStatus } : {}),
          // Displaying persisted richOrigin is not a URL grant. The explicit button performs no
          // action or browser input: main rereads the exact canonical historical assistant under
          // the current window/selection witness.
          ...(event.richOrigin && event.messageId ? { openOriginal: () => options.openOriginal(id, event.messageId!, currentRichRow) } : {})
        } : undefined)
          : options.renderMarkdown(event.message.text, event.renderedHtml));
        if (event.richMediaUnavailable) {
          box.append(el('p', 'meta rich-media-unavailable', () => t("Image preview unavailable — open original in ChatGPT")));
        }
        return box;
      }
      case 'native_image': {
        const box = el('div', 'said native-image');
        box.append(el('b', '', () => t("ChatGPT generated image")));
        const frame = el('div', 'generated-image-frame');
        const width = event.width ?? event.previewWidth ?? 1;
        const height = event.height ?? event.previewHeight ?? 1;
        frame.style.aspectRatio = `${Math.max(1, width)} / ${Math.max(1, height)}`;
        const unavailable = () => {
          frame.classList.toggle('is-unavailable', event.previewStatus !== 'pending');
          frame.replaceChildren(el('p', 'meta', () => {
          if (event.previewStatus === 'pending') return t("Image preview is loading");
          if (event.previewError === 'removed') return t("Image removed from local storage");
          if (event.previewError === 'quota') return t("Image preview unavailable — recording storage is full");
          if (event.previewError === 'oversized') return t("Image preview unavailable — image exceeds the recording limit");
          return t("Image preview unavailable");
          }));
          if (event.previewStatus !== 'pending') frame.append(imageStorageButton());
        };
        if (event.asset) frame.append(el('p', 'meta', () => t("Image preview is loading")));
        else unavailable();
        box.append(frame);
        const id = context?.id ?? options.sessionId();
        if (event.asset && id) {
          const generation = options.generation();
          void (async () => {
            const data = await run(window.api.getSessionImage(id, event.asset!.id));
            if (context ? !context.current() : id !== options.sessionId() || generation !== options.generation()) return;
            // Only the fixed local image reader's bounded bytes may become an IMG source. A
            // malformed IPC reply must never trigger a remote image request or paint a different
            // MIME under this exact canonical generated-image asset.
            if (!localDataUrl(data, event.asset!.mimeType)) {
              const pane = context ? box.closest<HTMLElement>('.agent-panel-body') : options.pane();
              const timeline = context ? pane : options.timeline();
              const restore = pane && timeline && box.isConnected ? preserveTimelineViewport(pane, timeline) : () => {};
              unavailable(); restore();
              return;
            }
            const image = document.createElement('img');
            image.src = data;
            image.alt = t("ChatGPT generated image");
            frame.replaceChildren(image);
          })();
        }
        return box;
      }
      case 'progress':
        return el('p', 'meta is-progress', event.message.text);
      case 'page_tool': {
        const line = el('p', 'meta is-progress thinking-line');
        line.append(icon('i-globe', 'ico thinking-ico'), el('span', '', event.label));
        return line;
      }
      case 'turn_start':
        return el('p', 'meta', () => event.detail ? t("Turn reopened — {0}", [event.detail]) : t("Turn started"));
      case 'turn_end': {
        const line = el(
          'p',
          event.outcome === 'completed' ? 'meta' : 'meta is-warn',
          () => t("Turn {0}{1}", [t(TURN_OUTCOME_LABELS[event.outcome]), event.detail ? ` — ${event.detail}` : ''])
        );
        return line;
      }
      case 'chat_error': {
        const notice = el('div', 'chat-error-notice');
        notice.setAttribute('role', 'status');
        const presentation = () => chatErrorPresentation(event, context?.history ?? residentEvents);
        // The timeline signature includes this projection, so later completion/work repaints it.
        notice.classList.toggle('is-resolved', presentation().resolved);
        const title = el('strong', '', () => presentation().title);
        notice.append(title, textBlock('msg', presentation().message, event.message.truncated, event.message.chars),
          el('p', 'chat-error-next', () => presentation().next));
        return notice;
      }
      case 'tool_call':
        return toolBody(event, context);
      case 'note':
        return el('p', 'meta', event.message.text);
      /**
       * Rendered rather than left to fall through to "Unknown event".
       *
       * The timeline is how the user checks what the agents actually said to each other, and a
       * run of grey "Unknown event" rows in the middle of a multi-agent session reads as a broken
       * log — the one impression a session recorder cannot afford to give.
       */
      case 'agent_message': {
        const box = document.createElement('details');
        box.className = 'agent-communication';
        // Which end of the message this record is. The same message is written once here and once
        // in the other agent's session, so without this a pair reads as two messages.
        ui(box, 'title', () => event.delivery === 'sent'
            ? t("Sent by {0}; recorded when the app accepted it", [event.from])
            : t("Received by {0}; recorded when it acknowledged delivery", [event.to]));
        const summary = el('summary');
        const worker = event.from === 'prime' ? event.to : event.from;
        const avatar = el('span', 'agent-avatar', worker.replace(/^worker-/, ''));
        avatar.dataset.color = String([...worker].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
        avatar.setAttribute('aria-hidden', 'true');
        summary.append(avatar, el('span', '', () => communicationTitle(event)));
        const communicationKey = `agent:${context?.id ?? options.sessionId()}:${event.seq}`;
        box.open = openTools.has(communicationKey);
        box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
        box.append(summary);
        box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
        if (!context) {
          const openWorkerChat = options.workerChat(worker);
          if (openWorkerChat) {
            const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
            ui(open, 'aria-label', () => t("Open {0} chat", [worker]));
            const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
            open.append(el('span', '', () => t("Open worker chat")), arrow);
            open.onclick = () => openWorkerChat(); box.append(open);
          }
        }
        return box;
      }
      case 'handoff':
        return el(
          'p',
          'meta is-good',
          () => t("Handoff saved — {0} characters ({1})", [compactNumber(event.chars), event.reason])
        );
      default:
        return el('p', 'meta', () => t("Unknown event"));
    }
  }

  function eventRow(event: SessionEvent): HTMLElement {
    // One class per content family, so the stylesheet owns what a family looks like and this
    // builder only says which family a row belongs to. `ev-<kind>` stays: it is the hook the
    // reconciliation, grouping and fixtures already select on.
    const row = el('div', contentRowIdentity(event.kind));
    if (event.kind === 'assistant_message' && !event.rich && !event.richMediaUnavailable &&
        !withoutMessageReaction(event.message.text).trim()) row.hidden = true;
    tagImageRow(row, event);
    const time = document.createElement('time');
    time.textContent = clockTime(event.time);
    time.title = new Date(event.time).toLocaleString();
    const body = el('div', 'ev-body');
    const currentWorker = options.origin();
    if (event.agent && event.agent !== 'prime' && !(currentWorker?.kind === 'worker' && currentWorker.agentId === event.agent)) {
      body.append(el('span', 'chip', event.agent));
    }
    body.append(eventBody(event));
    // A refused call from a chat Compact & Resume already replaced is not a placement failure:
    // its request id proved exactly which chat it came from, and that chat's stopped turn simply
    // kept calling from OpenAI's side. Say so beside the row, or a full Unattributed bucket of
    // these reads as the attribution chain having broken.
    if (event.kind === 'tool_call' && event.call.attributionMethod === 'superseded') {
      body.append(
        el(
          'p',
          'meta',
          () => t("From a chat that Compact & Resume had already replaced — ChatGPT kept running its stopped turn there. Refused by design; nothing to repair.")
        )
      );
    }
    row.append(time, body);
    return row;
  }

  function compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
    const key = `compaction:${block.token}`;
    const state = compactionState(block);

    // A Compact & Resume card is where the `handoff` family's rows went: the fold replaces the
    // brief/request/end/handoff events with one card, so it carries that family's identity rather
    // than inventing a kind of its own.
    const row = previous ?? el('div', `ev ev-compaction tl-row ${categoryClass('handoff')}`);
    const box = previous?.querySelector<HTMLDetailsElement>('details.compaction') ?? document.createElement('details');
    box.className = `tool compaction tone-${state.tone}`;
    if (!previous) {
      box.open = openTools.has(key);
      box.addEventListener('toggle', () => {
        if (box.open) openTools.add(key);
        else openTools.delete(key);
      });
    }

    if (!previous) {
      const head = document.createElement('summary');
      head.append(icon('i-steps', 'ico tool-ico'));
      head.append(el('b', '', () => t("Compact & Resume:")));
      head.append(el('span', 'state'));
      box.append(head);
    }
    ui(box.querySelector<HTMLElement>('summary .state')!, 'textContent', () => compactionState(block).text);

    const raw = el('div', 'raw');
    if (block.prompt) {
      raw.append(el('h4', '', () => t("Brief request")));
      // The routing marker is the app's, not the user's; the card already says what this is.
      const prompt = userPromptText(block.prompt.message.text) ?? block.prompt.message.text;
      // The marker is stripped in whichever form the page recorded it; `marker` is the exact text
      // that matched, so an escaped one is removed as completely as a clean one.
      const request = prompt.replace(continuationMarkerOf(prompt)?.marker ?? '', '');
      raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
    }
    if (block.brief) {
      const brief = block.brief;
      raw.append(el('h4', '', () => brief.final ? t("Summary") : t("Summary (still writing)")));
      raw.append(options.renderMarkdown(block.brief.message.text));
    }
    if (block.handoff) {
      const saved = block.handoff;
      raw.append(
        el('p', 'raw-facts', () => t("Handoff saved — {0} characters ({1})", [compactNumber(saved.chars), saved.reason]))
      );
    }
    if (block.resume) {
      const resumed = block.resume;
      raw.append(
        el(
          'p',
          'raw-facts',
          () => t("Bootstrap sent into the new chat — {0} characters at {1}", [compactNumber(resumed.message.chars), clockTime(resumed.time)])
        )
      );
    }
    for (const note of block.notes) raw.append(el('p', 'raw-facts', `${clockTime(note.time)} — ${note.message.text}`));
    const oldRaw = box.querySelector<HTMLElement>('.raw');
    if (oldRaw) {
      // Streaming changes only the affected section. Keep the disclosure, focus and unchanged
      // request mounted instead of replacing the whole reading surface.
      const oldParts = [...oldRaw.children];
      reconcileChildren(oldRaw, [...raw.children].map((part, index) =>
        (oldParts[index]?.isEqualNode(part) ? oldParts[index] : part) as HTMLElement));
    } else box.append(raw);

    if (previous) return row;
    const time = document.createElement('time');
    time.textContent = clockTime(block.time);
    time.title = new Date(block.time).toLocaleString();
    const body = el('div', 'ev-body');
    body.append(box);
    row.append(time, body);
    return row;
  }

  // ------------------------------------------------------------------ painting

  function paint({ followBottom = true }: { followBottom?: boolean } = {}): TimelinePaint | null {
    const sessionId = options.sessionId();
    // The destination's page has not arrived: the previous owner's rows stay mounted and inert.
    if (sessionId !== null && !loaded) return null;
    const pane = options.pane();
    const timeline = options.timeline();
    // Drawing the adopted owner's rows is what releases the destination gate the controller
    // armed when it changed selection.
    timeline.removeAttribute('inert');
    timeline.removeAttribute('aria-busy');
    paintAgentFilter();
    const filtered = visibleEvents();
    const windowed = boundedTimeline(filtered);
    const shown = windowed.shown;

    // Preserve the visible logical row when late transcript revisions change the height above it;
    // retaining absolute scrollTop would move the reader's content.
    const restoreViewport = preserveTimelineViewport(pane, timeline, followBottom);
    let restoreRichFocus: (() => void) | null = null;
    const timelineRows: HTMLElement[] = [];
    const keep = new Set<string>();
    let activityBoundary = '';
    const oldest = shown.length ? Math.min(...shown.map(event => event.time)) : 0;
    const newest = shown.length ? Math.max(...shown.map(event => event.time)) : 0;
    const retiredInputs = options.outbox.pendingComposerInputs().filter(entry => historicalAutomaticInput(entry) &&
      (entry.sessionId ?? entry.deliveredSessionId) === sessionId && !inputNotices().has(entry.id) &&
      agentFilter === null && entry.createdAt >= oldest && (browsingFrom === null || entry.createdAt <= newest))
      .sort((a, b) => a.createdAt - b.createdAt);
    const appendRetiredInputs = (until: number) => {
      while (retiredInputs.length && retiredInputs[0]!.createdAt <= until) {
        const entry = retiredInputs.shift()!;
        const key = `retired-input:${entry.id}`;
        const sig = JSON.stringify([entry.text, entry.error, entry.createdAt]);
        keep.add(key);
        const cached = rowCache.get(key);
        const row = cached?.sig === sig ? cached.row : inputMessageRow(options.outbox, entry, true);
        if (row !== cached?.row) {
          const time = document.createElement('time');
          time.textContent = new Date(entry.createdAt).toLocaleString();
          row.prepend(time);
        }
        row.dataset.timelineKey = key;
        rowCache.set(key, { sig, row });
        timelineRows.push(row);
        activityBoundary = key;
      }
    };
    const duplicateErrors = duplicateChatErrors(residentEvents);
    for (const item of timelineItems(shown)) {
      if (item.kind === 'event' && duplicateErrors.has(item.event.seq)) continue;
      appendRetiredInputs(item.kind === 'event' ? item.event.time : item.block.time);
      if (item.kind === 'compaction' || !['tool_call', 'page_tool', 'agent_message'].includes(item.event.kind)) activityBoundary = itemKey(item);
      if (!options.developerMode() && item.kind === 'event' && item.event.source === 'app' && item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
      if (!options.developerMode() && item.kind === 'event' && ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind)) continue;
      const key = itemKey(item);
      const focusStatus = item.kind === 'event' && item.event.kind === 'assistant_message' && item.event.messageId
        ? options.richFocusStatus?.(item.event.messageId) ?? '' : '';
      const sig = itemSignature(item, sessionId, options.outbox.pendingComposerInputs(), focusStatus) + (item.kind === 'event' && item.event.kind === 'chat_error'
        ? JSON.stringify(chatErrorPresentation(item.event, residentEvents)) : '');
      keep.add(key);
      const cached = rowCache.get(key);
      if (cached && cached.sig === sig) {
        cached.row.dataset.activityBoundary = activityBoundary;
        if (item.kind === 'event' && item.event.kind === 'user_message') {
          paintMessageReaction(cached.row.querySelector<HTMLElement>('.said.is-user')!, item.event.reaction);
        }
        paintInputReceipt(cached.row, item);
        timelineRows.push(cached.row);
        continue;
      }
      let row = item.kind === 'compaction' ? compactionRow(item.block, cached?.row) : eventRow(item.event);
      if (cached && item.kind === 'event' && item.event.kind === 'assistant_message') {
        // A revision cursor changes a bubble's contents, not its immutable viewport identity.
        // Keep the outer row mounted and recover keyboard focus by validated semantic node id.
        const active = document.activeElement as HTMLElement | null;
        const focused = active && cached.row.contains(active) ? active.closest<HTMLElement>('[data-rich-node-id]') : null;
        const focusId = focused?.dataset.richNodeId;
        const focusTag = active?.tagName;
        const oldDisclosure = cached.row.querySelector<HTMLDetailsElement>('details.rich-source');
        const newDisclosure = row.querySelector<HTMLDetailsElement>('details.rich-source');
        if (oldDisclosure?.open && newDisclosure) newDisclosure.open = true;
        retireRichImageViewerWithin(cached.row);
        cached.row.replaceChildren(...row.childNodes);
        cached.row.hidden = row.hidden;
        cached.row.className = row.className;
        row = cached.row;
        if (focusId && focusTag) restoreRichFocus = () => {
          const owner = [...row.querySelectorAll<HTMLElement>('[data-rich-node-id]')]
            .find(node => node.dataset.richNodeId === focusId);
          const target = owner?.tagName === focusTag ? owner
            : [...(owner?.querySelectorAll<HTMLElement>('*') ?? [])].find(node => node.tagName === focusTag);
          target?.focus({ preventScroll: true });
        };
      }
      row.dataset.timelineKey = key;
      row.dataset.timelineOrigin = String(itemOrigin(item));
      row.dataset.activityBoundary = activityBoundary;
      paintInputReceipt(row, item);
      rowCache.set(key, { sig, row });
      timelineRows.push(row);
    }
    appendRetiredInputs(Infinity);
    for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);

    // The spine is a projection of recorded lineage: no handoff and no continuation origin means
    // no spine, and the transcript renders exactly as it did before this existed. A session that
    // has been compacted reads as one continuous column with a labelled frontend per run.
    //
    // It reads the session's full resident history, not the windowed page or the filtered view:
    // the number of frontends a session has run in is a fact about the session, so it must not
    // change as the reader scrolls, and an agent filter must not erase a segment's joint.
    const spine = frontendSegments(residentEvents, options.origin());
    timeline.classList.toggle('spine', spine.length > 0);
    reconcileChildren(timeline, spine.length === 0
      ? groupImageRows(groupToolRows(timelineRows, sessionId, toolGroups, openTools))
      : withSpineSegments(groupImageRows(groupToolRows(timelineRows, sessionId, toolGroups, openTools)), spine));
    retireStaleRichImageViewer();
    paintPendingInputs(options.outbox);
    $('timelineEmpty').hidden = sessionId !== null || timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
    restoreViewport();
    restoreRichFocus?.();

    return {
      rows: timeline.querySelectorAll('[data-timeline-key]').length,
      shown: shown.length,
      omitted: windowed.omitted,
      filter: agentFilter === null ? null : {
        label: agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter,
        matched: filtered.length
      },
      resident: residentEvents.length,
      total: totalEvents
    };
  }

  /** Retire the window this view holds; the drawn rows stay mounted until a page replaces them. */
  function retire(): void {
    residentEvents = [];
    totalEvents = 0;
    loaded = false;
    browsingFrom = null;
    agentFilter = null;
    filterFor = null;
    forgetRows();
    const box = $('chatAgentFilter');
    box.hidden = true;
    box.replaceChildren();
  }

  /** Drop the drawn rows too, for a deletion or a destination read that failed. */
  function clearRows(): void {
    forgetRows();
    options.timeline().replaceChildren();
  }

  /** Release the window and its rows; the page is going away. */
  function dispose(): void {
    clearRows();
    residentEvents = [];
    totalEvents = 0;
    loaded = false;
    browsingFrom = null;
    agentFilter = null;
    filterFor = null;
  }

  return {
    update(page, generation) {
      // Exact owner and generation: A → B → A retires both B's page and A's earlier one here.
      if (generation !== options.generation() || page.sessionId !== options.sessionId()) return false;
      if (page.mode === 'delta') mergeDelta(page.events);
      else {
        // User/assistant prose is canonical in messages.json, while structured page activity
        // stays append-only by design: ChatGPT can grow one commentary caption or rewrite one
        // activity label several times. `foldProgress` turns those snapshots back into the one
        // logical row their stable progressId/messageId names, then chronology places that row at
        // its first appearance. This helper existed already but was never wired into the desktop
        // reader, which is why "Inspecting…" and "Inspected…" still appeared as siblings.
        const folded = chronological(foldProgress([...page.events]));
        if (page.mode === 'prepend') {
          const boundary = page.boundary!;
          browsingFrom = boundary;
          const retained = residentEvents.filter(event => positionOf(event) >= boundary);
          residentEvents = retainTimelinePage(chronological(foldProgress([...folded, ...retained])), 'older', options.pane(), options.timeline());
        } else if (page.mode === 'append') {
          residentEvents = retainTimelinePage(chronological(foldProgress([...residentEvents, ...folded])), 'newer', options.pane(), options.timeline());
          // Reaching the live tail restores ordinary delta reads. Paging itself preserves the
          // reader's row even when they were at the bottom of the previous window.
          if (page.events.length < TIMELINE_PAGE_ROWS / 2) browsingFrom = null;
        } else residentEvents = chronological([...folded].sort((a, b) => positionOf(a) - positionOf(b)).slice(-TIMELINE_PAGE_ROWS));
      }
      totalEvents = page.total;
      loaded = true;
      // A selection opens at the latest message with no tail space left over from the chat before
      // it; navigation keeps both, because the reader is looking at recorded history.
      if (page.mode === 'open') clearTimelineReserve(options.timeline());
      paint({ followBottom: page.mode === 'open' || page.mode === 'delta' });
      // Apply only after the current load has rendered: the previous chat's viewport is not a
      // reading position in this one.
      if (page.mode === 'open') options.pane().scrollTop = options.pane().scrollHeight;
      return true;
    },
    paint,
    focusOrigin: origin => focusTimelineOrigin(options.timeline(), origin),
    focusMessage: messageId => focusTimelineMessage(options.timeline(), messageId),
    olderOrigin() {
      // A boundary is where the drawn window starts, not where the resident one does: ordered
      // requests walk the reader's page, not the eviction buffer behind it.
      const windowed = boundedTimeline(visibleEvents());
      const boundaryRows = windowed.omitted > 0 && windowed.shown.length ? windowed.shown : residentEvents;
      return boundaryRows.length ? Math.min(...boundaryRows.map(positionOf)) : null;
    },
    newerOrigin: () => (browsingFrom === null || residentEvents.length === 0
      ? null
      : residentEvents.reduce((cursor, event) => Math.max(cursor, positionOf(event)), 0)),
    browsing: () => browsingFrom !== null,
    loaded: () => loaded,
    events: () => residentEvents,
    setFilter: (agent: string | null) => { agentFilter = agent; },
    hasLaterActivity: hasLaterModelActivity,
    previewRows(source, sessionId, current, groups) {
      let boundary = '';
      const rows = boundedTimeline(source).shown.flatMap(event => {
        if (!['tool_call', 'page_tool', 'agent_message'].includes(event.kind)) boundary = `event:${event.seq}`;
        if (!['user_message', 'assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', contentRowIdentity(event.kind));
        const body = el('div', 'ev-body');
        tagImageRow(row, event);
        row.dataset.timelineKey = `event:${event.seq}`;
        row.dataset.activityBoundary = boundary;
        body.append(eventBody(event, { id: sessionId, current, history: source }));
        row.append(body);
        return [row];
      });
      return groupImageRows(groupToolRows(rows, `pane:${sessionId}`, groups, openTools));
    },
    retire,
    clearRows,
    dispose
  };
}

// ------------------------------------------------------------ shared projections

/** A canonical message or call identity, so a revision patches its row instead of adding one. */
function canonicalMessageKey(event: SessionEvent): string | null {
  if (event.kind === 'tool_call') return `tool_call\u0000${event.call.callId}`;
  if (event.kind === 'native_image') return `native_image\u0000${event.messageId}\u0000${event.providerAssetId}`;
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  node.setAttribute('dir', 'auto');
  if (truncated) {
    node.append(el('span', 'cut', () => t(" … cut, {0} characters in the original", [compactNumber(chars)])));
  }
  return node;
}

/** The exact outbox input retains preview bytes until optional history storage succeeds. */
function retainedInputImages(
  event: Extract<SessionEvent, { kind: 'user_message' }>,
  sessionId: string | null,
  pending: readonly InputEntry[]
): InputImage[] {
  if (!sessionId || !event.inputId) return [];
  const root = pending.find(entry => entry.id === event.inputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId &&
    (entry.messageId ? entry.messageId === event.messageId : event.messageId === `input:${entry.id}`));
  if (!root) return [];
  const companion = root.companionInputId ? pending.find(entry => entry.id === root.companionInputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId && entry.messageId === root.messageId) : undefined;
  // Match combinedInput's canonical image order for asset-index fallback.
  return [...root.images ?? [], ...companion?.images ?? [], ...root.toolImages ?? []].slice(0, MAX_INPUT_IMAGES);
}

function eventTextCost(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
      return event.message.text.length;
    case 'assistant_message':
      // Charge the schema's maximum rather than traversing an untrusted tree for each page.
      // Text/HTML plus rich must share the existing 2 MiB resident paint budget.
      return event.message.text.length + (event.renderedHtml?.text.length ?? 0) +
        (event.rich ? RICH_LIMITS.bytes : 0) + (event.richMediaUnavailable ? 128 : 0);
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      return event.message.text.length;
    case 'tool_call':
      return (
        event.call.args.text.length +
        event.call.result.text.length +
        event.call.summary.title.length +
        (event.call.summary.detail?.length ?? 0)
      );
    case 'page_tool':
      return event.label.length;
    case 'turn_end':
      return event.detail?.length ?? 0;
    default:
      return 128;
  }
}

/** Eviction follows the measured reader viewport, not an arbitrary half-page. Keep the current
 * visible rows plus the incoming stage; ordinary tall histories still settle at 160 records.
 * Dense collapsed activity has bounded extra room. */
function retainTimelinePage(
  source: SessionEvent[],
  direction: 'older' | 'newer',
  pane: HTMLElement,
  timeline: HTMLElement
): SessionEvent[] {
  // Residency and navigation share the immutable origin domain. Display order can move a final
  // across its turn's tools, but must not cut a hole in a page.
  source = [...source].sort((a, b) => positionOf(a) - positionOf(b));
  const edge = pane.getBoundingClientRect().top;
  const protectedKeys = new Set<string>();
  for (const row of timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= edge - pane.clientHeight) continue;
    if (rect.top >= edge + 2 * pane.clientHeight) break;
    protectedKeys.add(row.dataset.timelineKey!);
    if (row.matches('.tool-group:not([open])')) {
      for (const child of row.querySelectorAll<HTMLElement>('[data-timeline-key]')) protectedKeys.add(child.dataset.timelineKey!);
    }
  }
  const protectedSeqs = new Set<number>();
  for (const item of timelineItems(source)) {
    if (item.kind !== 'compaction' || !protectedKeys.has(itemKey(item))) continue;
    const block = item.block;
    protectedSeqs.add(block.seq);
    for (const event of [block.prompt, block.brief, block.end, block.handoff, block.resume, ...block.notes]) {
      if (event) protectedSeqs.add(event.seq);
    }
  }
  const protectedIndexes = source.flatMap((event, index) => protectedSeqs.has(event.seq) || protectedKeys.has(itemKey({ kind: 'event', event })) ? [index] : []);
  const first = protectedIndexes[0] ?? source.length;
  const last = protectedIndexes.at(-1) ?? -1;
  if (direction === 'older') {
    const end = Math.min(source.length, Math.max(TIMELINE_PAGE_ROWS, last + 1));
    return chronological(source.slice(0, Math.min(end, MAX_TIMELINE_RESIDENT_ROWS)));
  }
  const start = Math.max(0, Math.min(source.length - TIMELINE_PAGE_ROWS, first));
  return chronological(source.slice(Math.max(start, source.length - MAX_TIMELINE_RESIDENT_ROWS)));
}

/** Newest-first selection, returned chronologically, under resident and text/HTML budgets. */
export function boundedTimeline(source: readonly SessionEvent[]): { shown: SessionEvent[]; omitted: number } {
  let chars = 0;
  let start = source.length;
  while (start > 0 && source.length - start < MAX_TIMELINE_RESIDENT_ROWS) {
    const next = source[start - 1]!;
    const cost = Math.min(eventTextCost(next), MAX_TIMELINE_TEXT_CHARS);
    if (start < source.length && chars + cost > MAX_TIMELINE_TEXT_CHARS) break;
    chars += cost;
    start -= 1;
  }
  return { shown: foldAgentCommunication(source.slice(start)), omitted: start };
}

// ------------------------------------------------------------ compaction rows

/**
 * One Compact & Resume, folded out of the rows the recorder wrote for it.
 *
 * The recorder stores a compaction as it happened: the brief request typed into chat A, the brief
 * ChatGPT answered with, the app's own "handoff saved" line, and the bootstrap typed into chat B
 * — four rows, three of them long, in an order that reflects when each was observed rather than
 * what they were. Read as a timeline they look like three separate things going on; they are one
 * thing with three steps, and this is that thing.
 */
interface CompactionBlock {
  token: string;
  /** The row this card takes the place of. */
  seq: number;
  time: number;
  prompt: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /**
   * The turn ChatGPT answered the brief request in. The request is typed by the app, so its row
   * carries no local turn id of its own; the turn is the one that opens right after it.
   */
  turnId: string | null;
  brief: Extract<SessionEvent, { kind: 'assistant_message' }> | null;
  end: Extract<SessionEvent, { kind: 'turn_end' }> | null;
  handoff: Extract<SessionEvent, { kind: 'handoff' }> | null;
  resume: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /** What the app said about this compaction, newest last — an abandonment and why. */
  notes: Array<Extract<SessionEvent, { kind: 'note' }>>;
}

type TimelineItem = { kind: 'event'; event: SessionEvent } | { kind: 'compaction'; block: CompactionBlock };

function continuationMarker(event: SessionEvent): { kind: 'HANDOFF' | 'RESUME'; token: string } | null {
  if (event.kind !== 'user_message') return null;
  const match = continuationMarkerOf(event.message.text);
  return match ? { kind: match.kind, token: match.token } : null;
}

/**
 * The timeline with each compaction folded into one item.
 *
 * A card opens at the marked brief request and absorbs what belongs to it: the turn that answers
 * it, the answer (the brief), the app's handoff line. The marked bootstrap in the replacement chat
 * closes the same card by token, wherever it lands, and so does an app note naming the token. A
 * bootstrap whose request has scrolled out of the window still gets a card, with the steps it
 * implies already done.
 *
 * Which turn answers the request is read from the log, not from the request row. The request is
 * typed by the app into the chat, so the extension records it with no local turn id (or, on a
 * reload, with the previous turn's); the generation ChatGPT opens for it is the first `turn_start`
 * after it. Keying on the request's own `turnId` left that start, the brief, the end and the
 * handoff as four loose rows under an empty card — the live shape.
 */
function timelineItems(source: readonly SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const blocks = new Map<string, CompactionBlock>();
  let open: CompactionBlock | null = null;
  const blockFor = (token: string, event: SessionEvent): CompactionBlock => {
    let block = blocks.get(token);
    if (!block) {
      block = {
        token,
        seq: event.seq,
        time: event.time,
        prompt: null,
        turnId: null,
        brief: null,
        end: null,
        handoff: null,
        resume: null,
        notes: []
      };
      blocks.set(token, block);
      items.push({ kind: 'compaction', block });
    }
    return block;
  };
  for (const event of source) {
    const marker = continuationMarker(event);
    if (marker && event.kind === 'user_message') {
      const block = blockFor(marker.token, event);
      if (marker.kind === 'HANDOFF') {
        block.prompt = event;
        block.turnId = event.turnId ?? null;
        open = block;
        // Chronology puts a turn's start before the message that opened it, so the request turn's
        // own start row is already on the list; it belongs to the card like the rest.
        const previous = items[items.length - 2];
        if (
          previous?.kind === 'event' &&
          previous.event.kind === 'turn_start' &&
          event.turnId !== undefined &&
          previous.event.turnId === event.turnId
        ) {
          items.splice(items.length - 2, 1);
        }
      } else {
        block.resume = event;
        if (open === block) open = null;
      }
      continue;
    }
    if (event.kind === 'note' && event.continuation) {
      const block = blockFor(event.continuation, event);
      block.notes.push(event);
      if (open === block) open = null;
      continue;
    }
    if (open) {
      if (event.kind === 'handoff') {
        open.handoff = event;
        continue;
      }
      if (event.kind === 'assistant_message') {
        if (open.turnId && event.turnId && event.turnId !== open.turnId) {
          items.push({ kind: 'event', event });
          continue;
        }
        open.brief = event;
        if (event.turnId !== undefined) open.turnId = event.turnId;
        continue;
      }
      if (event.kind === 'turn_start' && !open.brief && !open.handoff && !open.end) {
        open.turnId = event.turnId ?? null;
        continue;
      }
      const sameTurn = open.turnId !== null && event.turnId === open.turnId;
      if (sameTurn && (event.kind === 'turn_end' || event.kind === 'progress' || event.kind === 'page_tool')) {
        if (event.kind === 'turn_end') open.end = event;
        continue;
      }
      // Local calls can finish or be refused after the source request. They remain ordinary
      // visible rows and cannot close the summary's grouping or decide its fate. Only another
      // authored user message starts an unrelated conversation step.
      if (event.kind === 'user_message') open = null;
    }
    items.push({ kind: 'event', event });
  }
  return items;
}

type CompactionTone = 'good' | 'wait' | 'bad';

const ABANDONED_NOTE = /^Compact & Resume abandoned\s*[\u2014-]\s*/i;

/**
 * One sentence for where the compaction is, or where it died.
 *
 * Success and failure come from the recorded continuation, never from later activity in this
 * timeline. Refused source calls are compatible with a still-running handoff.
 */
function compactionState(block: CompactionBlock): { text: string; tone: CompactionTone } {
  const chars = block.handoff ? t(" ({0} characters)", [compactNumber(block.handoff.chars)]) : '';
  if (block.resume) return { text: t("New chat opened at {0}{1}", [clockTime(block.resume.time), chars]), tone: 'good' };
  const abandoned = [...block.notes].reverse().find((note) => ABANDONED_NOTE.test(note.message.text));
  if (abandoned) return { text: t("Failed — {0}", [abandoned.message.text.replace(ABANDONED_NOTE, '')]), tone: 'bad' };
  if (block.handoff) {
    return { text: t("Summary saved{0} — opening the new chat…", [chars]), tone: 'wait' };
  }
  if (block.end && block.end.outcome !== 'completed') {
    const status = block.end.outcome === 'stopped' ? t("Summary generation stopped")
      : block.end.outcome === 'failed' ? t("Summary generation failed")
      : t("Summary generation ended without a completed handoff");
    return { text: block.end.detail ? t("{0} — {1}", [status, block.end.detail]) : status, tone: 'bad' };
  }
  if (block.brief?.final) {
    return { text: t("Summary written — saving the handoff…"), tone: 'wait' };
  }
  if (block.brief) return { text: t("ChatGPT is writing the summary…"), tone: 'wait' };
  return { text: t("Summary requested — waiting for ChatGPT…"), tone: 'wait' };
}

/** What a row was drawn from; a different signature is a different row. */
function itemSignature(item: TimelineItem, sessionId: string | null, pending: readonly InputEntry[], focusStatus = ''): string {
  if (item.kind === 'compaction') {
    const { block } = item;
    return [
      block.token,
      block.prompt?.seq ?? '',
      block.brief ? `${block.brief.seq}:${block.brief.message.chars}:${block.brief.renderedHtml?.chars ?? 0}:${block.brief.state}` : '',
      block.end ? `${block.end.seq}:${block.end.outcome}:${block.end.detail ?? ''}` : '',
      block.handoff?.seq ?? '',
      block.resume?.seq ?? '',
      block.notes.map((note) => note.seq).join(',')
    ].join('|');
  }
  const { event } = item;
  const parts: Array<string | number> = [event.kind === 'user_message' ? '' : event.seq, event.time, event.kind, event.agent ?? ''];
  switch (event.kind) {
    case 'user_message': {
      // A badge-only revision patches the existing bubble, preserving loaded images and
      // selection. Every other recorded field still invalidates its body.
      const { seq: _seq, reaction: _reaction, ...body } = event;
      parts.push(JSON.stringify(body));
      // Bytes are immutable for an accepted input. Queue arrival must repaint a canonical row
      // even if its recorded revision did not change.
      parts.push(...retainedInputImages(event, sessionId, pending).map(image => `${image.name}:${image.dataUrl.length}`));
      break;
    }
    case 'progress':
    case 'chat_error':
    case 'note':
    case 'agent_message':
      parts.push(event.message.chars);
      break;
    case 'assistant_message':
      parts.push(event.message.chars, event.renderedHtml?.chars ?? 0, event.state ?? '', event.final ? 'final' : '',
        event.rich?.revision ?? '', event.rich?.status ?? '', event.rich?.reason ?? '',
        event.richMediaUnavailable ?? '', JSON.stringify(event.richMedia ?? []),
        JSON.stringify(event.retiredRichImageAssetIds ?? []), focusStatus);
      break;
    case 'native_image':
      parts.push(event.messageId, event.providerAssetId, event.providerStatus ?? '', event.previewStatus, event.asset?.id ?? '',
        event.previewWidth ?? '', event.previewHeight ?? '', event.previewError ?? '');
      break;
    case 'tool_call':
      parts.push(
        event.call.outcome,
        event.call.attribution,
        event.call.durationMs,
        event.call.args.chars,
        event.call.result.chars,
        event.call.summary.title,
        event.call.summary.detail ?? ''
      );
      break;
    case 'page_tool':
      parts.push(event.label);
      break;
    case 'turn_end':
      parts.push(event.outcome, event.detail ?? '');
      break;
    case 'handoff':
      parts.push(event.chars);
      break;
    default:
      break;
  }
  return parts.join('|');
}

function itemKey(item: TimelineItem): string {
  if (item.kind === 'compaction') return `compaction:${item.block.token}`;
  // A canonical revision advances the update cursor, not the identity of the row anchoring the
  // viewport and the following activity disclosure.
  const message = canonicalMessageKey(item.event);
  return message ? `message:${message}` : `event:${item.event.seq}`;
}

/** The immutable origin a drawn row stands for: the row's own, or the first event a compaction
 * card folded away. */
function itemOrigin(item: TimelineItem): number {
  if (item.kind === 'event') return positionOf(item.event);
  const { block } = item;
  const folded = [block.prompt, block.brief, block.end, block.handoff, block.resume, ...block.notes];
  return folded.reduce((oldest: number | null, event) =>
    event && (oldest === null || positionOf(event) < oldest) ? positionOf(event) : oldest, null) ?? block.seq;
}

/** Keep retained scroll containers mounted: rebuilding a feed must not restart disclosure
 * animations or detach a result while the user is scrolling it. Paging can extend or trim the
 * beginning of an activity group, so its first member is not a new disclosure identity. The open
 * set is the caller's, because the transcript and the pane that previews it share one identity
 * per call: an opened disclosure stays open wherever the same row is drawn. */
export function groupToolRows(
  rows: HTMLElement[],
  scope: string | null,
  groups: Map<string, HTMLDetailsElement>,
  openTools: Set<string>
): HTMLElement[] {
  const grouped: HTMLElement[] = [], retained = new Set<string>();
  for (let i = 0; i < rows.length;) {
    if (!rows[i]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message')) { grouped.push(rows[i++]!); continue; }
    let end = i + 1;
    while (end < rows.length && rows[end]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message') && rows[end]!.dataset.activityBoundary === rows[i]!.dataset.activityBoundary) end++;
    if (end - i === 1) { grouped.push(rows[i++]!); continue; }
    const previous = rows.slice(i, end).map(row => row.closest<HTMLElement>('.tool-group'))
      .find(group => group?.dataset.timelineKey && groups.get(group.dataset.timelineKey) === group && !retained.has(group.dataset.timelineKey));
    const key = previous?.dataset.timelineKey ?? `group:${scope}:${rows[i]!.dataset.timelineKey}`;
    retained.add(key);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'tool-group';
      group.dataset.timelineKey = key;
      const summary = document.createElement('summary');
      summary.append(el('span', 'activity-symbol'), el('span', 'activity-title'), icon('i-chev', 'ico activity-chevron'));
      group.append(summary, el('div', 'tool-group-body'));
      group.addEventListener('toggle', () => { if (group!.open) openTools.add(key); else openTools.delete(key); });
      group.open = openTools.has(key) || rows.slice(i, end).some((row) => row.querySelector('details[open]')); groups.set(key, group);
    }
    const latest = rows[end - 1]!;
    const latestHead = latest.querySelector('.tool > summary, .agent-communication > summary, .thinking-line');
    const label = latestHead?.querySelector('b, span:not(.agent-avatar)')?.textContent || t("Activity");
    group.querySelector('.activity-title')!.textContent = label;
    ui(group.querySelector('summary')!, 'title', () => t("{0} actions · {1}", [end - i, label]));
    const symbol = latestHead?.querySelector('svg, .agent-avatar');
    group.querySelector('.activity-symbol')!.replaceChildren(...(symbol ? [symbol.cloneNode(true)] : []));
    reconcileChildren(group.lastElementChild!, rows.slice(i, end));
    grouped.push(group); i = end;
  }
  for (const key of groups.keys()) if (!retained.has(key)) groups.delete(key);
  return grouped;
}

/** Adjacent images from one response share a compact gallery, retaining canonical rows. */
export function tagImageRow(row: HTMLElement, event: SessionEvent): void {
  if (event.kind !== 'native_image') return;
  row.dataset.imageAgent = event.agent ?? '';
  row.dataset.imageMessage = event.messageId;
  row.dataset.imageTurn = event.turnId ?? '';
}

export function groupImageRows(rows: HTMLElement[]): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (let i = 0; i < rows.length;) {
    const first = rows[i]!;
    if (!first.dataset.imageMessage) { result.push(first); i++; continue; }
    const messages = new Set([first.dataset.imageMessage]);
    const turns = new Set(first.dataset.imageTurn ? [first.dataset.imageTurn] : []);
    let end = i + 1;
    while (end < rows.length) {
      const next = rows[end]!.dataset;
      if (!next.imageMessage || next.imageAgent !== first.dataset.imageAgent) break;
      if (!messages.has(next.imageMessage) && !(next.imageTurn && turns.has(next.imageTurn))) break;
      messages.add(next.imageMessage);
      if (next.imageTurn) turns.add(next.imageTurn);
      end++;
    }
    const gallery = rows.slice(i, end).map(row => row.closest<HTMLElement>('.generated-image-gallery'))
      .find((node): node is HTMLElement => !!node) ?? el('div', 'generated-image-gallery');
    reconcileChildren(gallery, rows.slice(i, end));
    result.push(gallery); i = end;
  }
  return result;
}
