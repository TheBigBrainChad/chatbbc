import { $, el, icon, reconcileChildren, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import { isAstraModel } from '../shared/chat-models.js';
import { injectableAttachments } from '../shared/input.js';
import type { InputImage, InputAttachment } from '../shared/input.js';
import type { InputArgs, InputEntry } from '../main/session/input.js';
import type { SessionSummary } from '../shared/session.js';

/**
 * The outbox: what the composer and the message queue draw about delivery.
 *
 * chat.ts owns which turn is controlled, which draft is open and which attachments belong to
 * it; this module owns how those facts reach the DOM, and the queue it draws them from. The
 * presentation pieces that belong to no one else — the rows entering for the first time and the
 * notices the user has dismissed — live here.
 *
 * {@link DeliveryHost} is the read-and-call surface. Every accessor returns the live value
 * rather than a copy, because these rows are redrawn while a delivery is still in flight.
 */

/** What the outbox needs from chat.ts. */
export interface DeliveryHost {
  selectedId(): string | null;
  /** Bumped whenever the composer's data owner changes; fences async reads. */
  selectionGeneration(): number;
  /** The session the last control read was made for, and the selection it was made under. */
  controlledSessionId(): string | null;
  controlledTurnId(): string | null;
  controlledSelection(): number;
  controlledQueueAtFinish(): boolean;
  controlledCanInject(): boolean;
  controlledCanSendDirectly(): boolean;
  controlledFinishWaiting(): boolean;
  controlledStopPending(): boolean;
  /** True when a finish-message draft is already open for this turn. */
  finishGoalDraftView(): boolean;
  /** The prepared plan awaiting review, if one is open. */
  preparedPlan(): { sending: boolean; stages: string[] } | null;
  /** Whether the draft stored under `key` has a plan, prepared or still being written. */
  hasPlan(key: string): boolean;
  /** The key the current composer draft is stored under. */
  draftKey(): string;
  /** Live per-draft attachments: the same map chat.ts's import path writes. */
  imageDrafts(): Map<string, Array<InputImage | InputAttachment>>;
  /** Inputs admitted locally and not yet confirmed by a queue read. */
  startingInputs(): Map<string, InputEntry>;
  /** The queue as last read, and its replacement. */
  pendingComposerInputs(): InputEntry[];
  setPendingComposerInputs(next: InputEntry[]): void;
  /** The New Chat opening that currently owns the composer, if any. */
  pendingNewInput(): { id: string; generation: number } | null;
  setPendingNewInput(next: { id: string; generation: number } | null): void;
  /** The composer's authored text, from the picker when it owns it. */
  authoredComposerText(): string;
  /** Whether the selected session has model activity after a timestamp. */
  hasLaterModelActivity(time: number): boolean;
  /** Return a failed message's payload to the composer for review. */
  restoreDraftToComposer(entry: InputEntry): void;
  /** Redraw the goal progress row the delivery controls sit above. */
  paintGoalProgress(): void;

  // ---- the queue cycle's own reads and writes ------------------------------
  /** The project a queued task's row belongs to, when it has one. */
  projectGroup(id: string | null | undefined): string | null;
  /** The project a New Chat opening would join. */
  selectedProjectId(): string | null;
  /** True while the New Chat draft, rather than a recorded session, owns the composer. */
  newChatSelected(): boolean;
  /** True when the loaded transcript already carries a committed version of this row. */
  transcriptOwns(entry: InputEntry): boolean;
  /** The durable session array. */
  sessions(): SessionSummary[];
  /** Fold a newly read summary into the session array; the caller owns the result. */
  adoptSession(summary: SessionSummary): void;
  /** Open a session in the main pane, retiring the draft that came before it. */
  selectSession(id: string): void;
  /** Repaint the transcript the outbox rows sit above. */
  paintDetail(): void;
  /** The per-draft composer text and the unsent New Chat task drafts. */
  inputDrafts(): Map<string, string>;
  newChatTasks(): Map<string, { objective: string; automation: string; loopDelivery: string }>;
  /** Bump the queue-read fence, returning the new generation. */
  retireQueueReads(): number;
  /** The current queue-read fence. */
  queueGeneration(): number;
  /** Inputs the Cancel control retired, so a late receipt is ignored. */
  cancelledStarts(): Set<string>;
  /** Re-read the model and reasoning a planned retry could not confirm. */
  refreshComposerModel(): Promise<{ model: string; reasoningEffort: string } | null>;
}

export function attachmentCard(file: InputAttachment, inComposer = false): HTMLElement {
  if (file.preview) {
    const image = document.createElement('img'); image.src = file.preview; image.alt = file.name; image.title = file.name;
    if (!inComposer) return image;
    const tile = el('div', 'composer-image'); tile.append(image); return tile;
  }
  const tile = el('div', 'attachment-card'); tile.title = file.name;
  const glyph = el('span', 'attachment-icon');
  glyph.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M7 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1 6h8M8 13h8M8 17h5');
  lines.setAttribute('fill', 'none'); lines.setAttribute('stroke', 'currentColor'); lines.setAttribute('stroke-width', '1.6'); lines.setAttribute('stroke-linecap', 'round');
  svg.append(lines); glyph.append(svg);
  const details = el('div', 'attachment-details');
  details.append(el('div', 'attachment-name', file.name), el('div', 'attachment-kind', () => file.mimeType.startsWith('image/') ? t("Image") : t("File")));
  tile.append(glyph, details); return tile;
}

export function dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement {
  const button = el('button', 'dock-action') as HTMLButtonElement;
  const description = typeof label === 'function' ? label : () => label;
  button.type = 'button'; ui(button, 'title', description); ui(button, 'aria-label', description);
  button.append(icon(symbol)); button.onclick = click; return button;
}

// Dismisses presentation only; durable cancellation and late receipts remain in the outbox.
const INPUT_NOTICE_KEY = 'dismissed-input-notices';
const dismissedInputNotices = new Set<string>((() => {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(INPUT_NOTICE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(-100) : [];
  } catch { return []; }
})());

/** The live dismissal set. chat.ts filters its timeline on the same entries. */
export function inputNotices(): Set<string> {
  return dismissedInputNotices;
}

/** Dismisses presentation only. The delivery itself is untouched. */
export function dismissInputNotice(host: DeliveryHost, id: string): void {
  dismissedInputNotices.add(id);
  try { window.localStorage.setItem(INPUT_NOTICE_KEY, JSON.stringify([...dismissedInputNotices].slice(-100))); }
  catch { /* A storage failure still allows dismissal for this window lifetime. */ }
  void refreshInputQueue(host);
}

/**
 * Draw the drafts' attachments, images and files alike.
 *
 * Removal edits the draft's own list, so the tiles are redrawn from the same map chat.ts's
 * import path writes; delivery is repainted afterwards because an attachment can change what
 * delivery is legal.
 */
export function paintComposerImages(host: DeliveryHost): void {
  const key = host.draftKey();
  const imageDrafts = host.imageDrafts();
  const images = imageDrafts.get(key) ?? [];
  const box = $('composerImages'); box.hidden = !images.length; box.replaceChildren();
  images.forEach((image, index) => {
    const tile = 'dataUrl' in image ? el('div', 'composer-image') : attachmentCard(image, true);
    if ('dataUrl' in image) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; tile.append(preview); }
    const remove = el('button', 'image-remove', '×'); remove.setAttribute('type', 'button'); ui(remove, 'aria-label', () => t("Remove {0}", [image.name]));
    remove.addEventListener('click', () => { imageDrafts.set(key, images.filter((_entry, at) => at !== index)); paintComposerImages(host); });
    tile.append(remove); box.append(tile);
  });
  paintDeliveryControls(host);
}

const queuedFollowup = (entry: InputEntry): boolean => !entry.opening && (entry.mode === 'finish' || (entry.mode === 'after-turn' && !!entry.sessionId && entry.purpose !== 'decision'));

/** The one composer-bound pending delivery for the current selection, if any. */
export function pendingComposerInput(host: DeliveryHost): InputEntry | undefined {
  const selectedId = host.selectedId();
  const pendingNewInput = host.pendingNewInput();
  const selectionGeneration = host.selectionGeneration();
  return [...host.startingInputs().values(), ...host.pendingComposerInputs()].find(entry => (!queuedFollowup(entry) || entry.state === 'browser') && ['queued', 'browser'].includes(entry.state) &&
    (selectedId ? (entry.sessionId ?? entry.deliveredSessionId) === selectedId :
      pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id));
}

/** Retired automatic drafts belong to their creation time, never the live composer queue. */
export function historicalAutomaticInput(entry: InputEntry): boolean {
  return !!entry.finishOwner && !entry.finishOwner.userRequested && entry.state === 'cancelled' && !!entry.error;
}

/**
 * Draw the send-and-stop surface for the current selection.
 *
 * Which turn is controlled, and under which selection that was read, are chat.ts's facts. They
 * are bound once here so the guards below read exactly as they did when the state was local.
 */
export function paintDeliveryControls(host: DeliveryHost): void {
  host.paintGoalProgress();
  const selectedId = host.selectedId();
  const selectionGeneration = host.selectionGeneration();
  const controlledSessionId = host.controlledSessionId();
  const controlledTurnId = host.controlledTurnId();
  const controlledSelection = host.controlledSelection();
  const controlledQueueAtFinish = host.controlledQueueAtFinish();
  const controlledCanInject = host.controlledCanInject();
  const controlledCanSendDirectly = host.controlledCanSendDirectly();
  const controlledFinishWaiting = host.controlledFinishWaiting();
  const controlledStopPending = host.controlledStopPending();
  const finishGoalDraftView = host.finishGoalDraftView();
  const imageDrafts = host.imageDrafts();
  const draftKey = () => host.draftKey();
  const authoredComposerText = () => host.authoredComposerText();
  const startingInputs = host.startingInputs();
  const pendingComposerInputs = host.pendingComposerInputs();
  const currentPreparedPlan = () => host.preparedPlan();
  const taskPlans = { has: (key: string) => host.hasPlan(key) };
  const working = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledTurnId !== null;
  const queueAtFinish = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish;
  const canInject = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledCanInject;
  const canSendDirectly = selectedId !== null && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledCanSendDirectly;
  const files = imageDrafts.get(draftKey()) ?? [];
  const nativeFiles = files.some(file => 'id' in file) && !(canInject && injectableAttachments(files));
  $('queueAtFinish').hidden = !queueAtFinish || nativeFiles;
  ui($('afterTurnLabel'), 'textContent', () => queueAtFinish && !nativeFiles ? t("Queue at Session finish") : t("After this turn"));
  const generate = $<HTMLButtonElement>('generateFinishGoal');
  const queued = [...startingInputs.values(), ...pendingComposerInputs].some(entry =>
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && ['queued', 'browser', 'tool'].includes(entry.state));
  generate.hidden = !working || !controlledFinishWaiting || queued || controlledStopPending || !!finishGoalDraftView;
  generate.disabled = generate.dataset.busy === `${selectedId}:${controlledTurnId}`;
  const sendOption = $<HTMLSelectElement>('sendMode').querySelector('option[value="auto"]');
  const immediateLabel = () => nativeFiles && working ? t("After this turn") : canSendDirectly ? t("Send directly") : canInject ? t("Inject now") : t("Send");
  if (sendOption) ui(sendOption, 'textContent', immediateLabel);
  ui($('immediateDeliveryLabel'), 'textContent', immediateLabel);
  const immediateAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="auto"]');
  if (immediateAction) immediateAction.hidden = (nativeFiles && working) || canInject;
  const injectionAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="tool"]');
  const explicitInjection = (canInject || canSendDirectly) && (!files.length || injectableAttachments(files));
  if (injectionAction) injectionAction.hidden = !explicitInjection;
  if ($<HTMLSelectElement>('sendMode').value === 'tool' && !explicitInjection) $<HTMLSelectElement>('sendMode').value = 'auto';
  if (canInject && explicitInjection && $<HTMLSelectElement>('sendMode').value === 'auto') $<HTMLSelectElement>('sendMode').value = 'tool';
  if (!canInject && !canSendDirectly && !queueAtFinish) $<HTMLSelectElement>('sendMode').value = 'auto';
  const pending = pendingComposerInput(host);
  const stop = (working || !!pending) && !currentPreparedPlan() && !authoredComposerText().trim() && !(imageDrafts.get(draftKey())?.length);
  // Hover selects delivery for the next message. Clicking the empty-composer
  // Stop still acts immediately; there is no second Stop action in the menu.
  $('sendOptions').hidden = !canInject && !canSendDirectly && !queueAtFinish;
  const send = $<HTMLButtonElement>('chatSend');
  const planMode = taskPlans.has(draftKey()), preparedPlan = currentPreparedPlan();
  send.disabled = !!preparedPlan && (preparedPlan.sending || preparedPlan.stages.some(stage => !stage.trim()));
  send.dataset.action = stop ? 'stop' : 'send';
  ui(send, 'aria-label', () => stop ? (controlledStopPending ? t("Stop requested") : t("Stop turn")) : t("Send message"));
  if (stop && !working && pending) ui(send, 'aria-label', () => t("Cancel delivery"));
  const planAction = selectedId ? t("Queue plan at Session finish") : t("Start full plan");
  if (preparedPlan && !stop) send.setAttribute('aria-label', planAction);
  else if (planMode && !stop) ui(send, 'aria-label', () => t("Generate plan"));
  send.classList.toggle('is-plan-ready', !!preparedPlan && !stop);
  ui(send, 'title', () => stop && !working && pending ? t("Cancel delivery") : preparedPlan && !stop ? planAction : planMode && !stop ? t("Click to generate plan") : '');
  send.classList.toggle('is-stop', stop);
  for (const button of $('sendOptions').querySelectorAll<HTMLElement>('[data-delivery]')) {
    button.setAttribute('aria-checked', String(button.dataset.delivery === (nativeFiles && working && $<HTMLSelectElement>('sendMode').value !== 'tool' ? 'after-turn' : $<HTMLSelectElement>('sendMode').value)));
  }
}

let visibleInputIds = new Set<string>();

/**
 * One pending or retired delivery, with the actions its state allows.
 *
 * `notice` marks a row that failed or was cancelled while it belonged to the selection; those
 * carry the dismiss and retry controls, which is why the same row reads differently in the
 * timeline and in the outbox.
 */
export function inputMessageRow(host: DeliveryHost, entry: InputEntry, notice: boolean): HTMLElement {
  const row = el('div', 'pending-message');
  row.classList.toggle('is-delivered', !entry.error && ['sent', 'tool'].includes(entry.state));
  row.classList.toggle('is-delivery-error', !!entry.error || entry.state === 'failed');
  row.dataset.inputId = entry.id;
  if (!visibleInputIds.has(entry.id)) row.classList.add('is-entering');
  visibleInputIds.add(entry.id);
  if (visibleInputIds.size > 100) visibleInputIds.delete(visibleInputIds.values().next().value!);
  const status = () => entry.error || (entry.state === 'failed' ? t("Delivery not confirmed") : entry.state === 'decision' ? t("Preparing follow-up") : entry.state === 'browser' ? t("Delivery confirmation pending") : entry.state === 'tool' ? t("Sent to the active turn · awaiting receipt") : entry.dueAt > Date.now() ? t("Scheduled {0}", [new Date(entry.dueAt).toLocaleString()]) : entry.delivery === 'tool' ? t("Waiting for the next tool call") : t("Queued"));
  const files = el('div', 'message-attachments');
  if (entry.attachments?.length) files.append(...entry.attachments.map(file => attachmentCard(file)));
  for (const image of entry.images ?? []) { const preview = document.createElement('img'); preview.src = image.dataUrl; preview.alt = image.name; files.append(preview); }
  if (files.childElementCount) row.append(files);
  if (entry.text) {
    const text = el('div', 'pending-message-text', entry.text);
    text.setAttribute('dir', 'auto');
    row.append(text);
  }
  const receipt = el('span', 'pending-message-status');
  ui(receipt, 'title', status); ui(receipt, 'aria-label', status);
  if (entry.error || entry.state === 'failed') {
    ui(receipt, 'textContent', status);
  }
  else receipt.append(icon(['sent', 'tool'].includes(entry.state) ? 'i-check' : 'i-clock'));
  receipt.hidden = !entry.error && ['sent', 'tool'].includes(entry.state) && host.hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt);
  row.append(receipt);
  if (notice) {
    const dismiss = dockAction(() => t("Dismiss delivery notice"), 'i-x', () => {});
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      const result = await run(window.api.cancelInput(entry.id));
      if (result) dismissInputNotice(host, entry.id);
      else dismiss.disabled = false;
      void refreshInputQueue(host);
    };
    row.append(dismiss);
    const retry = dockAction(() => t("Retry delivery"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    const unqueuedPlan = entry.stages !== undefined && !entry.stagesApplied;
    ui(retry, 'title', () => unqueuedPlan ? t("Retry stage one with the complete plan and queued checkpoints") : t("Restore this message to the composer for review and sending"));
    retry.onclick = () => {
      if (unqueuedPlan) { void retryPlannedInput(host, entry); return; }
      if (host.authoredComposerText().trim() || host.imageDrafts().get(host.draftKey())?.length) { toast(t("Send or clear your current draft before retrying this message.")); return; }
      host.restoreDraftToComposer(entry);
      dismissInputNotice(host, entry.id);
    };
    row.append(retry);
  }
  if (['queued', 'browser'].includes(entry.state)) {
    const cancel = dockAction(() => t("Cancel delivery"), 'i-x', () => {});
    cancel.onclick = async () => {
      cancel.disabled = true;
      const result = await run(window.api.cancelInput(entry.id));
      if (result) dismissInputNotice(host, entry.id);
      void refreshInputQueue(host);
    };
    row.append(cancel);
  }
  if (entry.state === 'queued' && (entry.error?.startsWith('Message queued. Browser startup failed:') || entry.error?.startsWith('Local chat setup failed:'))) {
    const retry = dockAction(() => t("Retry browser"), 'i-retry', () => {});
    retry.classList.add('delivery-retry');
    retry.onclick = async () => { retry.setAttribute('disabled', ''); await run(window.api.retryInputBrowser(entry.id)); void refreshInputQueue(host); };
    row.append(retry);
  }
  return row;
}

/**
 * Move an accepted New Chat opening's draft and selection onto the session it became.
 *
 * Local admission moves the draft; a native receipt alone may mark it sent. The exact opening is
 * re-checked after the await, so a slower read cannot adopt one that has already been superseded.
 */
export async function adoptAcceptedOpening(host: DeliveryHost, entry: InputEntry): Promise<boolean> {
  const pending = host.pendingNewInput();
  const id = entry.opening ? entry.sessionId : entry.state === 'sent' ? entry.deliveredSessionId : null;
  if (!id || !pending || pending.id !== entry.id || pending.generation !== host.selectionGeneration() || !host.newChatSelected() || host.selectedId() !== null) return false;
  let summary = host.sessions().find(row => row.id === id);
  if (!summary) summary = (await run(window.api.getSession(id, { limit: 1 })))?.summary ?? undefined;
  if (!summary || host.pendingNewInput() !== pending || pending.generation !== host.selectionGeneration() || host.selectedId() !== null) return false;
  host.setPendingNewInput(null);
  host.adoptSession(summary);
  const from = host.draftKey();
  host.inputDrafts().set(summary.id, host.authoredComposerText());
  const images = host.imageDrafts().get(from);
  if (images) host.imageDrafts().set(summary.id, images);
  host.selectSession(summary.id);
  host.inputDrafts().delete(from); host.imageDrafts().delete(from); host.newChatTasks().delete(from);
  return true;
}

/**
 * Draw the outbox rows for the current selection, reusing rows whose own facts have not moved.
 *
 * A row is rebuilt only when its signature changes, so a queue read that found nothing new leaves
 * the DOM — and any text selection inside it — exactly as it was.
 */
export function paintPendingInputs(host: DeliveryHost): void {
  const all = host.pendingComposerInputs();
  const selectedId = host.selectedId();
  const selectionGeneration = host.selectionGeneration();
  const pendingNewInput = host.pendingNewInput();
  const selectedProjectId = host.selectedProjectId();
  const belongsToSelection = (entry: InputEntry): boolean => selectedId === null
    ? pendingNewInput?.generation === selectionGeneration && entry.id === pendingNewInput.id
    : (entry.sessionId ?? entry.deliveredSessionId) === selectedId;
  // A pre-acceptance or failed-materialization row belongs only to its exact draft.
  // A fresh New Chat never inherits another opening.
  const unbound = (entry: InputEntry) => selectedId === null && pendingNewInput?.id === entry.id && pendingNewInput.generation === selectionGeneration && !entry.deliveredSessionId && entry.purpose !== 'decision' && ['queued', 'browser'].includes(entry.state);
  const notice = (entry: InputEntry) => belongsToSelection(entry) && entry.purpose !== 'decision' &&
    ['failed', 'cancelled'].includes(entry.state) && !!entry.error && !dismissedInputNotices.has(entry.id);
  const anchored = (entry: InputEntry) => host.transcriptOwns(entry);
  const rows = all.filter((entry) => !dismissedInputNotices.has(entry.id) && !(!notice(entry) && anchored(entry)) && !(queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state)) && (belongsToSelection(entry) || unbound(entry) || notice(entry)) &&
    (notice(entry) || unbound(entry) || selectedId !== null || host.projectGroup(entry.projectId) === selectedProjectId) &&
    (notice(entry) || !['sent', 'cancelled'].includes(entry.state) || (entry.state === 'sent' && entry.messageId && !anchored(entry))));
  for (const entry of host.startingInputs().values()) if (belongsToSelection(entry) && !all.some(row => row.id === entry.id)) rows.push(entry);
  const box = $('inputQueue');
  const previous = new Map([...box.querySelectorAll<HTMLElement>(':scope > .pending-message')].map(row => [row.dataset.inputId, row]));
  const next = rows.filter(entry => !historicalAutomaticInput(entry)).map(entry => {
    const sig = JSON.stringify([entry.text, entry.state, entry.error, entry.dueAt, notice(entry), entry.stagesApplied,
      entry.stages, entry.attachments?.map(file => file.id), entry.images?.map(image => [image.name, image.dataUrl.length]),
      host.hasLaterModelActivity(entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt)]);
    const old = previous.get(entry.id);
    if (old?.dataset.inputSignature === sig) return old;
    const row = inputMessageRow(host, entry, notice(entry)); row.dataset.inputSignature = sig; return row;
  });
  // Helper controls have their own owner and are refreshed by the queue read below.
  reconcileChildren(box, [...next, ...box.querySelectorAll<HTMLElement>(':scope > .queued-input')]);
}

/**
 * Read the durable outbox and redraw every queue surface from it.
 *
 * The read is fenced by the selection and by a request counter, so a listing started before an
 * input was accepted can never overwrite the newer row that acceptance already put on screen.
 */
export async function refreshInputQueue(host: DeliveryHost): Promise<void> {
  const selection = host.selectionGeneration();
  const request = host.retireQueueReads();
  const [all, pausedHelpers] = await Promise.all([run(window.api.listInputs()), run(window.api.listPausedHelpers())]);
  if (!all || selection !== host.selectionGeneration() || request !== host.queueGeneration()) return;
  host.setPendingComposerInputs(all);
  for (const id of dismissedInputNotices) if (!all.some(entry => entry.id === id)) dismissedInputNotices.delete(id);
  paintDeliveryControls(host);
  const opening = host.pendingNewInput();
  const accepted = opening && all.find(entry => entry.id === opening.id);
  if (accepted && await adoptAcceptedOpening(host, accepted)) return;
  const belongsToSelection = (entry: { id: string; sessionId: string | null; deliveredSessionId?: string | null }): boolean => host.selectedId() === null
    ? host.pendingNewInput()?.generation === host.selectionGeneration() && entry.id === host.pendingNewInput()!.id
    : (entry.sessionId ?? entry.deliveredSessionId) === host.selectedId();
  const queuedTasks = all.filter(entry => belongsToSelection(entry) && queuedFollowup(entry) && ['queued', 'tool', 'browser'].includes(entry.state));
  // The first input already durably owns every later stage. Show that authority
  // until its native receipt materializes the actual queue, without a blank gap.
  const staged = [...all, ...[...host.startingInputs().values()].filter(entry => !all.some(row => row.id === entry.id))]
    .filter(entry => belongsToSelection(entry) && !entry.stagesApplied && ['queued', 'browser', 'tool'].includes(entry.state));
  const projectedIds = new Set<string>();
  for (const entry of staged) for (const [index, text] of (entry.stages ?? []).entries()) {
    const id = `${entry.id}:stage:${index}`; projectedIds.add(id);
    queuedTasks.push({ ...entry, id, text, mode: 'finish', state: 'browser', stages: undefined });
  }
  const queueSession = host.selectedId();
  const reorder = async (from: string, to: string, after: boolean) => {
    if (!queueSession || host.selectedId() !== queueSession) return;
    const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
    if (from === to || !ids.includes(from) || !ids.includes(to)) return;
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to) + Number(after), 0, from);
    const saved = await run(window.api.reorderQueuedInputs(queueSession, ids));
    if (saved === false) toast(t("The queue changed during the move. Try again."));
    void refreshInputQueue(host);
  };
  const taskList = $('finishQueue'); taskList.hidden = queuedTasks.length === 0;
  const oldCards = new Map([...taskList.children].map(node => [(node as HTMLElement).dataset.inputId, node as HTMLElement]));
  const dragging = !!taskList.querySelector('.is-dragging');
  reconcileChildren(taskList, queuedTasks.map(entry => {
    const existing = oldCards.get(entry.id);
    if (dragging && existing) return existing;
    if (entry.state === 'queued' && existing?.classList.contains('is-editing')) return existing;
    const card = el('div', 'queued-input'); card.dataset.inputId = entry.id;
    if (projectedIds.has(entry.id)) ui(card, 'aria-label', () => t("Plan stage · waiting for the first message to be sent"));
    const label = el('span', 'queue-label', entry.text); ui(label, 'title', () => `${entry.state === 'queued' ? (entry.mode === 'after-turn' ? t("After the next completed answer") : t("At Session finish or after a completed answer")) : t("Awaiting receipt")} · ${entry.text}`);
    label.dir = 'auto';
    card.append(icon('i-clock'), label);
    if (entry.state === 'queued') {
      const queueSessionSummary = host.sessions().find(row => row.id === host.selectedId());
      const modelSelection = queueSessionSummary?.selectedModel;
      if (entry.mode === 'finish' && modelSelection?.conversationId === queueSessionSummary?.conversationId && isAstraModel(modelSelection?.model, modelSelection?.reasoningEffort)) {
        const delivery = el('button', 'btn queue-delivery', () => entry.afterTurn === true ? t("Also after turn") : t("Finish only")) as HTMLButtonElement;
        delivery.type = 'button';
        ui(delivery, 'aria-label', () => t("Also send this task as a new message after Astra finishes its turn"));
        delivery.setAttribute('aria-pressed', String(entry.afterTurn === true));
        ui(delivery, 'title', () => entry.afterTurn === true ? t("At Session Finish, or as a new message after verified turn completion") : t("Only inside the Session Finish tool result; never start a new turn"));
        delivery.onclick = async () => {
          delivery.disabled = true;
          await run(window.api.editQueuedInput(entry.id, entry.text, entry.afterTurn !== true));
          void refreshInputQueue(host);
        };
        card.append(delivery);
      }
      label.draggable = true;
      label.tabIndex = 0;
      ui(label, 'title', () => t("Drag to reorder. Alt + Up/Down also moves this task."));
      label.ondragstart = event => {
        card.classList.add('is-dragging');
        event.dataTransfer?.setData('application/x-cos-queued-input', `${queueSession}:${entry.id}`);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      };
      label.ondragend = () => { card.classList.remove('is-dragging'); void refreshInputQueue(host); };
      card.ondragover = event => {
        if (event.dataTransfer?.types.includes('application/x-cos-queued-input')) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        }
      };
      card.ondrop = event => {
        const value = event.dataTransfer?.getData('application/x-cos-queued-input') ?? '';
        if (!queueSession || !value.startsWith(`${queueSession}:`)) return;
        event.preventDefault();
        void reorder(value.slice(queueSession.length + 1), entry.id, event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
      };
      label.onkeydown = event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const ids = queuedTasks.filter(row => row.state === 'queued').map(row => row.id);
        const next = ids[ids.indexOf(entry.id) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) void reorder(entry.id, next, event.key === 'ArrowDown');
      };
      const edit = dockAction(() => t("Edit queued task"), 'i-pencil', () => {});
      edit.onclick = () => {
        const field = document.createElement('textarea'); field.dir = 'auto'; field.value = entry.text; ui(field, 'aria-label', () => t("Queued task"));
        const contents = [...card.childNodes];
        const save = el('button', 'btn', () => t("Save")) as HTMLButtonElement; save.type = 'button';
        save.onclick = async () => {
          if (save.disabled) return;
          const value = field.value;
          save.disabled = true; ui(save, 'textContent', () => t("Saving…")); field.readOnly = true;
          try {
            const saved = await run(window.api.editQueuedInput(entry.id, value));
            if (!card.isConnected || selection !== host.selectionGeneration()) return;
            if (saved) {
              // The durable edit receipt ends editing, regardless of focus or a slower
              // queue refresh. Refreshes preserve drafts; they do not own Save completion.
              entry.text = value.trim(); label.textContent = entry.text;
              card.classList.remove('is-editing'); card.replaceChildren(...contents);
              void refreshInputQueue(host);
            } else if (saved === false) toast(t("This task is no longer queued and could not be edited."));
          } catch (error) { toast(error instanceof Error ? error.message : t("Could not save this task.")); }
          finally { save.disabled = false; ui(save, 'textContent', () => t("Save")); field.readOnly = false; }
        };
        card.classList.add('is-editing'); card.replaceChildren(field, save); field.focus();
      };
      const cancel = dockAction(() => t("Remove queued task"), 'i-trash', () => {}); cancel.onclick = async () => { await run(window.api.cancelInput(entry.id)); void refreshInputQueue(host); };
      card.append(edit, cancel);
    }
    return card;
  }));
  host.paintDetail();
  for (const node of $('inputQueue').querySelectorAll(':scope > .queued-input')) node.remove();
  for (const helper of pausedHelpers ?? []) {
    if (helper.sourceSessionId !== host.selectedId()) continue;
    const row = el('div', 'queued-input');
    row.append(el('span', '', () => t("Helper delivery was not confirmed. Its old chat may still be running.")));
    const retry = el('button', 'btn', () => t("Start a new helper"));
    retry.setAttribute('type', 'button');
    retry.onclick = async () => {
      retry.setAttribute('disabled', '');
      const accepted = await run(window.api.retryHelper(helper.id, helper.sourceSessionId));
      if (accepted) toast(t("New helper authorized for this chat"));
      else toast(t("This helper has changed. Refreshing its status."));
      void refreshInputQueue(host);
    };
    row.append(retry);
    $('inputQueue').append(row);
  }
}

/**
 * Re-send a failed or cancelled automatic plan that never left the outbox.
 *
 * The outbox retains the authored workflow after a failure, so the retry carries that payload
 * rather than its stage-one display text, and it never revives the old browser claim or receipt.
 */
export async function retryPlannedInput(host: DeliveryHost, entry: InputEntry): Promise<void> {
  if (dismissedInputNotices.has(entry.id) || entry.stagesApplied || !['failed', 'cancelled'].includes(entry.state)) return;
  // The outbox retains the authored workflow after failure. Retry that payload, not
  // its stage-one display text, and never revive the old browser claim/receipt.
  const { sessionId, projectId, text, objective, stages, images, attachments, attachmentDelivery, automation, loopAfterTurn, model, reasoningEffort, afterTurn } = entry;
  const args: InputArgs = { id: crypto.randomUUID(), sessionId, projectId, text, objective, stages, images, attachments, attachmentDelivery,
    automation, loopAfterTurn, model, reasoningEffort, afterTurn, mode: entry.requestedMode ?? entry.mode, dueAt: Date.now() };
  const generation = host.selectionGeneration();
  // Hide during the attempt, but persist dismissal only after its replacement is durable.
  dismissedInputNotices.add(entry.id); void refreshInputQueue(host);
  let accepted = false;
  try {
    if (entry.error === 'Requested model or reasoning could not be confirmed') {
      const selection = await host.refreshComposerModel();
      if (generation !== host.selectionGeneration() || host.cancelledStarts().has(args.id)) return;
      if (!selection) { toast(t("Model refresh could not confirm your selection. Choose an available model, then retry the plan.")); return; }
      Object.assign(args, selection);
    }
    host.startingInputs().set(args.id, { ...args, state: 'queued', owner: null, createdAt: args.dueAt, conversationId: null });
    if (sessionId === null) host.setPendingNewInput({ id: args.id, generation });
    paintDeliveryControls(host); void refreshInputQueue(host);
    const result = await run(window.api.sendInput(args));
    if (host.cancelledStarts().has(args.id)) return;
    if (!result) return;
    accepted = true;
    host.retireQueueReads();
    host.setPendingComposerInputs([...host.pendingComposerInputs().filter(row => row.id !== result.id), result]);
    await adoptAcceptedOpening(host, result);
  } finally {
    if (accepted) dismissInputNotice(host, entry.id);
    if (!accepted && !host.cancelledStarts().has(args.id)) dismissedInputNotices.delete(entry.id);
    if (!accepted && host.pendingNewInput()?.id === args.id) host.setPendingNewInput(null);
    host.cancelledStarts().delete(args.id); host.startingInputs().delete(args.id);
    paintDeliveryControls(host); void refreshInputQueue(host);
  }
}
