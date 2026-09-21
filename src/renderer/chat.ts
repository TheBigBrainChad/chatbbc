import { createWorkspaceTerminal } from './workspace-terminal.js';
import { ui, t } from './i18n.js';
import { initComposerStatusLine, paintComposerStatusLine } from './composer-status-line.js';
import { initSkills } from './skills.js';
import { initSkillsLibrary, type SkillsLibraryView } from './skills-library.js';
import { imageStorageButton } from './image-storage.js';
import { applyChatModels, applyComposerSessionModel, initChatModels, confirmedComposerModel, ensureComposerModel } from './chat-models.js';
import { marked, Marked } from 'marked';
import { safeExternalLink } from '../shared/external-link.js';
import { createAgentPanel } from './agent-panel.js';
import { createFilePanel } from './file-panel.js';
import { createWorkPanel } from './work-panel.js';
import { renderAgentPlan } from './agent-plan.js';
import { userPromptText } from '../shared/user-prompt.js';
import { messageReaction, withoutMessageReaction } from '../shared/message-reaction.js';
import { goalErrorMessage } from '../shared/goal-errors.js';
import type { GoalModel } from '../shared/goal-reasoning.js';
import { renderGoalReasoning } from './goal-reasoning.js';
import { renderRichResponse } from './rich-response.js';
import { localDataUrl, retireRichImageViewer, retireRichImageViewerWithin, retireStaleRichImageViewer } from './rich-image.js';
import { RICH_LIMITS } from '../shared/rich-response.js';
import { preserveTimelineViewport } from './timeline-scroll.js';
import { createSidebarOrder } from './sidebar-order.js';
import { toolResultText } from './tool-result.js';
import { chatErrorPresentation, duplicateChatErrors } from './chat-error.js';
import { categoryFor, categoryClass } from './transcript-categories.js';
import { frontendSegments, type FrontendSegment } from './session-spine.js';
import { renderRecoveryCountdowns } from './recovery.js';
import type { RecoveryCountdown } from '../shared/recovery.js';
import { communicationTitle, foldAgentCommunication } from './agent-communication.js';
import { initContextMeter, paintContextMeter } from './context-meter.js';
import { isProModel } from '../shared/chat-models.js';
import type { InputImage, InputAttachment, InputAutomation } from '../shared/input.js';
import { injectableAttachments, MAX_INPUT_IMAGES } from '../shared/input.js';
import type { InputEntry } from '../main/session/input.js';
import type { LocalProject } from '../shared/projects.js';
import type { TaskProgress } from '../shared/task-progress.js';
/**
 * Desktop chat workspace: recorded prose/tool truth, exact-session controls and a composer.
 * The extension remains the ChatGPT transport; main owns permissions, delivery, Goal and
 * compaction. The renderer crosses only the fixed preload API and scopes async views to
 * the selected session generation. Token and cost values remain explicitly estimates.
 */

import type {
  AgentState,
  Handoff,
  SessionEvent,
  SessionSummary,
  StoredText,
  SwarmState,
  TokenPressure
} from '../shared/session.js';
import {
  ATTRIBUTION_LABELS,
  CHAT_ACTIVE_MS,
  continuationMarkerOf,
  TURN_OUTCOME_LABELS,
  foldProgress,
  toolCallSummary
} from '../shared/session.js';
import { chronological, positionOf } from '../shared/chronology.js';
import { recentChatActivity } from '../shared/session-activity.js';
import {
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
  MAX_GOAL_SYSTEM_PROMPT_CHARS
} from '../shared/goal.js';
import { browserExtensionRequired, type AppState, type Config } from '../shared/types.js';
import { $, ago, applySettingsFilter, clockTime, compactNumber, el, icon, reconcileChildren, run, toast } from './dom.js';
import {
  KIND_ICON, mergeSessionRows, maybePageSessions, paintSessions, pressureOf, projectGroup,
  repaintBadges, selectedLocalProject, sessionWorking, unattributedBlocked,
  type SessionListHost, type SessionRowActions
} from './session-list.js';
import {
  adoptAcceptedOpening, attachmentCard, dismissInputNotice, dockAction, historicalAutomaticInput,
  inputMessageRow, inputNotices, paintComposerImages, paintDeliveryControls, paintPendingInputs,
  pendingComposerInput, refreshInputQueue,
  type DeliveryHost
} from './outbox-view.js';

const api = window.api;


/**
 * How close to the end of the model list counts as asking for the next page, in pixels.
 * A little over one row, so the fetch starts while there is still something to read.
 */
const GOAL_SCROLL_MARGIN = 72;
/** Page size and bounded staging capacity. A page is not a viewport: hundreds of
 * collapsed tool records can occupy less space than one authored message. */
const MAX_TIMELINE_ROWS = 160;
const MAX_TIMELINE_RESIDENT_ROWS = MAX_TIMELINE_ROWS * 2;
const MAX_TIMELINE_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_HTML_CHARS = 256 * 1024;
const SESSION_PAGE_SIZE = 60;

/**
 * Which agent's events the timeline is showing.
 *
 * `null` is everything. `UNATTRIBUTED` is its own bucket rather than being folded into
 * "all", because a call this app could not tie to any agent is a real category — with
 * ChatGPT's stateless connector it is the *default* category — and hiding it inside the
 * total would let a filtered view look complete when it is not.
 */
const UNATTRIBUTED = '\u0000unattributed';
let agentFilter: string | null = null;
/** The session the current filter was chosen in; selecting a different one resets it. */
let filterFor: string | null = null;

interface Deps {
  /** The renderer's single save path — reads every control, including ours. */
  save: () => Promise<void>;
  state: () => AppState | null;
}

let deps: Deps;
let visible = false;

let sessions: SessionSummary[] = [];
let pressure = new Map<string, TokenPressure>();
let sessionTotal = 0;
let sessionPageCursor: { updatedAt: number; id: string } | null = null;
let sessionPageLoading = false;
/** True after the user has explicitly paged beyond the newest page. */
let loadedOlderSessions = false;
let activeId: string | null = null;
let selectedId: string | null = null;
let newChatSelected = true;
let selectedProjectId: string | null = null;
let projects: LocalProject[] = [];
/** Window-local disclosure intent. Project groups start closed until the user or selection opens one. */
const expandedProjects = new Set<string>();
const projectVisibleCounts = new Map<string, number>();
let workspaceTerminal: ReturnType<typeof createWorkspaceTerminal> | null = null;

let sidebarOrder: ReturnType<typeof createSidebarOrder> | undefined;
function draftKey(): string { return selectedId ?? (selectedProjectId ? `project:${selectedProjectId}` : 'new'); }
let selectionGeneration = 0;
let selectionReportSequence = 0;
let reportedSessionId: string | null = null;
let acknowledgedUiSelection: { sessionId: string | null; rendererGeneration: number; generation: number } | null = null;
let currentChatView = 'timeline';

/** Presentation only. Main validates the sender, current window and session before witnessing. */
function reportVisibleSelection(force = false): void {
  const sessionId = visible && currentChatView === 'timeline' && !document.hidden ? selectedId : null;
  if (!force && sessionId === reportedSessionId && acknowledgedUiSelection?.sessionId === sessionId) return;
  reportedSessionId = sessionId;
  acknowledgedUiSelection = null;
  const rendererGeneration = ++selectionReportSequence;
  void api.reportUiSelection({ sessionId, rendererGeneration }).then(result => {
    // A→B→A and same-id reselections retire all older acknowledgments, including failures.
    if (rendererGeneration !== selectionReportSequence || sessionId !== reportedSessionId ||
        !result.ok || result.data.sessionId !== sessionId) return;
    acknowledgedUiSelection = { sessionId, rendererGeneration, generation: result.data.generation };
  }).catch(() => { /* A failed witness stays unavailable; ordinary chat remains usable. */ });
}
// Async file import belongs to one visible composer draft, not just to a session key.
// Replacing that draft retires in-flight imports even when navigation returns to the
// same key or a send failure later restores the submitted text.
let composerDraftGeneration = 0;
type ComposerDraftOwner = { key: string; generation: number };
function composerDraftOwner(): ComposerDraftOwner { return { key: draftKey(), generation: composerDraftGeneration }; }
function ownsComposerDraft(owner: ComposerDraftOwner): boolean {
  return owner.key === draftKey() && owner.generation === composerDraftGeneration;
}
function replaceComposerDraft(): void { composerDraftGeneration++; skillPicker?.close(); }
let pendingNewInput: { id: string; generation: number } | null = null;
let agentPanel: ReturnType<typeof createAgentPanel> | null = null;
let filePanel: ReturnType<typeof createFilePanel> | null = null;
let workPanel: ReturnType<typeof createWorkPanel> | null = null;
const expandedWorkers = new Set<string>();
const inputDrafts = new Map<string, string>();
const newChatTasks = new Map<string, { objective: string; automation: string; loopDelivery: string }>();
const imageDrafts = new Map<string, Array<InputImage | InputAttachment>>();
const startingInputs = new Map<string, InputEntry>();
// Window-local presentation only: a new incident or changed status is visible again.
const dismissedRecoveryNotices = new Map<string, string>();
function authoredComposerText(): string { return skillPicker?.authoredText() ?? $<HTMLTextAreaElement>('chatInput').value; }
function rememberDraft(): void {
  inputDrafts.set(draftKey(), authoredComposerText());
  if (selectedId === null) newChatTasks.set(draftKey(), {
    objective: $<HTMLTextAreaElement>('sessionObjective').value,
    automation: $<HTMLSelectElement>('chatAutomation').value,
    loopDelivery: $<HTMLSelectElement>('loopDelivery').value
  });
}
let skillPicker: ReturnType<typeof initSkills> | undefined;
let skillsLibrary: SkillsLibraryView | undefined;
/** The project/session scope the Skills page last read, so a scope change can be told from a repaint. */
let skillsLibraryScopeKey: string | undefined;
/** Whether the page has ever read the library; until it has, nothing needs re-reading. */
let skillsLibraryLoaded = false;
function restoreDraft(): void {
  skillPicker?.close();
  cancelGoalRequest();
  $('activeGoalRow').hidden = true; $('recoveryStatus').hidden = true;
  $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(draftKey()) ?? '';
  skillPicker?.restore();
  const task = selectedId === null ? newChatTasks.get(draftKey()) : undefined;
  const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = task?.automation ?? 'off'; delete automation.dataset.edited;
  $<HTMLSelectElement>('loopDelivery').value = task?.loopDelivery ?? 'finish';
  $<HTMLTextAreaElement>('sessionObjective').value = task?.objective ?? '';
  delete $('sessionObjective').dataset.edited; delete $('sessionObjective').dataset.sessionId; delete $('sessionObjective').dataset.saved;
  paintTaskPlan(); paintComposerImages(deliveryHost);
}

let events: SessionEvent[] = [];
let totalEvents = 0;
/** The session whose `events`/cursor pair belongs together. */
let detailFor: string | null = null;
let detailCursor: number | null = null;
let historyBefore: number | null = null;
let historyLoading = false;
/** The last swarm the app reported, so the header can summarise it without the log. */
let swarm: SwarmState | null = null;
/**
 * ChatGPT conversations the user has blocked from using local tools.
 *
 * Live policy the main process owns, keyed by conversation rather than by session, and pushed
 * with every session list. The renderer only ever mirrors it — pressing the button asks the
 * main process and repaints from the answer it gets back.
 */
let blockedChats = new Set<string>();

/** Handoff currently shown, and the id it was loaded for. */
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

let listTimer: number | undefined;
let listRefreshDirty = false;
let toolActivityTimer: number | undefined;
let sessionsLoadGeneration = 0;
let detailLoadGeneration = 0;
let handoffLoadGeneration = 0;

/**
 * Blocks or releases the Unattributed stream by moving the one switch that governs it.
 *
 * The settings sheet's checkbox is the stored state, and the renderer's save path reads every
 * control from the DOM — so this presses that checkbox rather than inventing a second way to
 * write the same setting. One switch, two places to reach it.
 */
async function toggleUnattributedBlock(blocked: boolean): Promise<void> {
  $<HTMLInputElement>('allowUnattributedCalls').checked = !blocked;
  await deps.save();
  paintSessions(sessionHost);
}

async function toggleSessionBlock(id: string, blocked: boolean): Promise<void> {
  const next = await run(api.setSessionBlocked(id, blocked));
  if (next === null) return;
  blockedChats = new Set(next);
  paintSessions(sessionHost);
}

/** One selection retirement path for deletion and independently confirmed disappearance. */
function clearSelectedSession(): void {
  retireRichImageViewer();
  rememberDraft();
  selectionGeneration++;
  replaceComposerDraft();
  selectedId = null;
  newChatSelected = true;
  pendingNewInput = null;
  events = [];
  totalEvents = 0;
  detailFor = null;
  detailCursor = null;
  historyBefore = null;
  handoff = null;
  handoffFor = null;
  detailLoadGeneration++;
  handoffLoadGeneration++;
  // Deletion and confirmed absence arrive outside selectSession/selectNewChat. Retire the old
  // recorded controls and their cached rows on this same stack, before reporting null or
  // awaiting another list/detail read that could fail or stall indefinitely.
  $('timeline').setAttribute('inert', '');
  $('inputQueue').setAttribute('inert', '');
  $('timeline').replaceChildren();
  $('inputQueue').replaceChildren();
  forgetTimelineRows();
  restoreDraft();
  void refreshSessionControls();
  paintSessions(sessionHost);
  paintDetail(false);
  paintHandoff();
  reportVisibleSelection(true);
}

async function deleteSession(id: string): Promise<void> {
  const done = await run(api.deleteSession(id));
  if (done === null) { if (selectedId === id) reportVisibleSelection(true); return; }
  sessions = sessions.filter((entry) => entry.id !== id);
  pressure.delete(id);
  sessionTotal = Math.max(0, sessionTotal - 1);
  if (selectedId === id) {
    clearSelectedSession();
  }
  toast(t("Session deleted"));
  await loadSessions();
}



async function loadSessions(): Promise<void> {
  const generation = ++sessionsLoadGeneration;
  const [list, catalog] = await Promise.all([run(api.listSessions({ limit: SESSION_PAGE_SIZE })), run(api.listProjects())]);
  if (!list || generation !== sessionsLoadGeneration) return;
  const previouslySelected = sessions.find(row => row.id === selectedId);
  if (catalog) projects = catalog;
  // Once older pages have been requested, a hot refresh only replaces/updates the newest page.
  // Throwing the older rows away here would make scrolling history vanish every 400 ms while a
  // live chat is recording. Before pagination begins, replacing the first page is cheaper and
  // also removes a session that was deleted elsewhere.
  if (loadedOlderSessions) {
    // This page is authoritative for its covered range, including withdrawn openings.
    // Keep older pages, but do not merge a deleted newest row back into the sidebar.
    const oldest = list.sessions.at(-1);
    const present = new Set(list.sessions.map(row => row.id));
    sessions = sessions.filter(row => present.has(row.id) || (!!list.nextCursor && !!oldest &&
      (row.updatedAt < oldest.updatedAt || (row.updatedAt === oldest.updatedAt && row.id < oldest.id))));
    sessions = mergeSessionRows(sessions, list.sessions);
  }
  else {
    sessions = list.sessions;
    sessionPageCursor = list.nextCursor ?? null;
  }
  sessionTotal = typeof list.total === 'number' ? list.total : list.sessions.length;
  activeId = list.activeId;
  // Whole-set replacement on every page, older pages included: a block belongs to a
  // conversation, not to whichever page happened to carry its row.
  blockedChats = new Set(list.blocked);
  if (loadedOlderSessions) {
    for (const entry of list.pressure) pressure.set(entry.id, entry);
  } else {
    pressure = new Map(list.pressure.map((entry) => [entry.id, entry]));
  }
  if (selectedId !== null && !sessions.some((s) => s.id === selectedId)) {
    // A bounded newest page cannot prove an older selected session was removed.
    const wanted = selectedId, selection = selectionGeneration;
    let resolved: SessionSummary | null | undefined;
    try {
      const reply = await api.getSession(wanted, { limit: 1 });
      if (reply.ok && reply.data.summary?.id === wanted) resolved = reply.data.summary;
      else if (!reply.ok && /session not found/i.test(reply.error)) resolved = null;
    } catch { /* A read error is unknown, never an authoritative deletion. */ }
    if (generation !== sessionsLoadGeneration || selection !== selectionGeneration || selectedId !== wanted) return;
    if (resolved === null) clearSelectedSession();
    else {
      // Preserve the selected row and title across pagination and transient read failures.
      const retained = resolved ?? previouslySelected;
      if (retained) sessions = mergeSessionRows(sessions, [retained]);
    }
  }
  paintSessions(sessionHost);
  await loadDetail();
  void refreshInputQueue(deliveryHost);
}

async function loadMoreSessions(): Promise<void> {
  if (sessionPageLoading || !sessionPageCursor || sessions.length >= sessionTotal) return;
  sessionPageLoading = true;
  const cursor = sessionPageCursor;
  try {
    const page = await run(api.listSessions({ cursor, limit: SESSION_PAGE_SIZE }));
    if (!page) return;
    sessions = mergeSessionRows(sessions, page.sessions);
    loadedOlderSessions = true;
    sessionTotal = page.total;
    sessionPageCursor = page.nextCursor;
    blockedChats = new Set(page.blocked);
    for (const entry of page.pressure) pressure.set(entry.id, entry);
    paintSessions(sessionHost);
  } finally {
    sessionPageLoading = false;
  }
}




/** Repaint once at the nearest activity-window boundary; no polling clock is needed. */
function scheduleToolActivityExpiry(): void {
  window.clearTimeout(toolActivityTimer);
  toolActivityTimer = undefined;
  if (!visible) return;
  const now = Date.now();
  let nearest = Number.POSITIVE_INFINITY;
  for (const summary of sessions) {
    const lastToolCallAt = summary.lastToolCallAt;
    const lastActivityAt = Math.max(summary.startedAt, lastToolCallAt ?? 0);
    if (!recentChatActivity(summary, now)) continue;
    const expiry = summary.activityExpiresAt ?? lastActivityAt + CHAT_ACTIVE_MS;
    if (expiry > now) nearest = Math.min(nearest, expiry);
  }
  if (!Number.isFinite(nearest)) return;
  toolActivityTimer = window.setTimeout(() => paintSessions(sessionHost), Math.max(1, nearest - now + 1));
}

function canonicalMessageKey(event: SessionEvent): string | null {
  if (event.kind === 'tool_call') return `tool_call\u0000${event.call.callId}`;
  if (event.kind === 'native_image') return `native_image\u0000${event.messageId}\u0000${event.providerAssetId}`;
  if ((event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId) {
    return `${event.kind}\u0000${event.messageId}`;
  }
  return null;
}

/** Merge one sequence-cursor delta without letting canonical message revisions duplicate rows. */
function mergeDetailDelta(delta: SessionEvent[]): void {
  const merged = [...events];
  const floor = events.length ? Math.min(...events.map(positionOf)) : 0;
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
      // An old canonical revision is not newly authored history. Its original
      // page still owns it; admitting it here would evict an unrelated live row.
      if (positionOf(event) < floor) continue;
      if (key) messageRows.set(key, merged.length);
      merged.push(event);
    }
  }
  const folded = chronological(foldProgress(merged));
  events = retainTimelinePage(folded, 'newer');
}

let controlsGeneration = 0;
let controlledSessionId: string | null = null;
let controlledTurnId: string | null = null;
let controlledSelection = -1;
let controlledStopPending = false;
let controlledFinishWaiting = false;
let controlledQueueAtFinish = false;
let controlledCanInject = false;
let controlledCanSendDirectly = false;
let controlledRecovery: RecoveryCountdown[] = [];
let pendingComposerInputs: InputEntry[] = [];
let inputQueueGeneration = 0;
let goalIntentGeneration = 0;
let goalProgress: (Omit<TaskProgress, 'phase'> & { phase: string; selection: number; inputId?: string }) | null = null;
function cancelGoalRequest(): void {
  const requestId = goalProgress?.requestId;
  goalProgress = null;
  if (requestId) void api.cancelTaskRequest?.(requestId);
  paintGoalProgress();
}
type GoalDraftPresentation = { stage: string; model: string; text: string; error: string | null };
let goalDraftView: GoalDraftPresentation | null = null;
let goalWaitView: import('../shared/goal.js').GoalWait | null = null;
let finishGoalDraftView: GoalDraftPresentation | null = null;
function paintGoalProgress(): void {
  let row = document.getElementById('goalLifecycle');
  if (!row) { row = el('div', 'queued-input'); row.id = 'goalLifecycle'; row.setAttribute('role', 'status'); $('activeGoalRow').before(row); }
  const progress = goalProgress?.selection === selectionGeneration ? goalProgress : null;
  const entry = progress?.inputId ? pendingComposerInputs.find(item => item.id === progress.inputId) : undefined;
  const finishDraft = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? finishGoalDraftView : null;
  const draft = finishDraft ?? (controlledSessionId === selectedId && controlledSelection === selectionGeneration ? goalDraftView : null);
  const wait = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? goalWaitView : null;
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  if (off && !finishDraft) { row.hidden = true; row.replaceChildren(); row.setAttribute('aria-busy', 'false'); paintComposerStatusLine(); return; }
  let phase = progress?.phase ?? '';
  let text = progress?.text ?? '', error = progress?.error;
  if (entry) { phase = entry.state; error = entry.error ?? undefined; }
  if (draft && (!off || finishDraft) && (finishDraft || !['saving', 'failed'].includes(phase))) { phase = draft.stage; text = draft.text; error = draft.error ?? undefined; }
  else if (wait && !['saving', 'failed'].includes(phase)) { phase = 'settling'; text = ''; error = undefined; }
  const labels: Record<string, string> = { saving: t("Saving task…"), saved: t("Task saved · waiting for the next completed answer"),
    preparing: t("Preparing the opening message…"), generating: t("Generating the opening message…"), ready: t("Message ready · awaiting ChatGPT delivery"),
    sending: t("Preparing a continuation…"), answering: t("Generating a continuation…"), queued: t("Opening message queued"),
    browser: t("Sending opening message to ChatGPT…"), sent: t("Opening message sent"), tool: 'Opening message delivered to the active turn',
    failed: t("Task could not continue"), cancelled: t("Opening message cancelled"), paused: t("Automation paused · task text preserved"), 'no-reply': t("Goal reached") };
  if (phase === 'retrying') { text = ''; error = undefined; }
  labels.retrying = t("Provider busy · retry {0}{1}", [progress?.attempt ?? '', progress?.retryAt ? ' at ' + new Date(progress.retryAt).toLocaleTimeString() : '']);
  const mode = $<HTMLSelectElement>('chatAutomation').value === 'loop' ? t('Loop') : t('Goal');
  labels.settling = `${mode} · ${wait?.reason === 'native-busy' ? t('ChatGPT resumed work · waiting before retry') : wait?.reason === 'silence' ? t('Waiting before recovery reload') : wait?.reason === 'quiet' ? t('Waiting for tool inactivity') :
    wait?.reason === 'tools' ? t('Waiting for running tools') : wait?.reason === 'listening' ? t('Waiting for activity after recovery') : t('Answer settling')}`;
  const sharedRecoveryWait = phase === 'settling' && wait?.until !== undefined &&
    ['silence', 'listening', 'native-busy', 'quiet'].includes(wait.reason) && controlledRecovery.some(countdown =>
      ['silence', 'post-reload', 'native-busy', 'thinking-failed'].includes(countdown.kind) &&
      countdown.deadline === wait.until && (countdown.visibleAt ?? 0) <= Date.now());
  row.hidden = !phase || sharedRecoveryWait;
  if (row.hidden) { row.replaceChildren(); row.setAttribute('aria-busy', 'false'); paintComposerStatusLine(); return; }
  const busy = ['settling', 'saving', 'preparing', 'generating', 'retrying', 'sending', 'answering', 'browser', 'queued', 'ready'].includes(phase) && !error;
  row.setAttribute('aria-busy', String(busy));
  const marker = el('span', busy ? 'session-status is-working' : 'session-status');
  const body = el('div', 'queue-label'); body.append(el('span', '', error ? `${labels.failed}: ${goalErrorMessage(error)}` : labels[phase] ?? phase));
  if (text && ['generating', 'answering', 'preparing'].includes(phase)) { const preview = el('pre', 'goal-live-preview', text.slice(-8000)); body.append(preview); }
  row.replaceChildren(marker, body);
  if (phase === 'settling' && wait?.until) {
    const seconds = Math.max(0, Math.ceil((wait.until - Date.now()) / 1000));
    const timer = el('span', 'recovery-countdown', seconds ? t('Check in {0}', [`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`]) : t('Checking for activity…'));
    timer.setAttribute('role', 'timer'); timer.setAttribute('aria-live', 'off'); row.append(timer);
  }
  // Last, so the line summarises what the blocks just painted rather than the paint before.
  paintComposerStatusLine();
}
const cancelledStarts = new Set<string>();

let durationTimer: number | undefined;
function paintActiveGoal(): void {
  const row = $('activeGoalRow');
  const mode = $<HTMLSelectElement>('chatAutomation').value;
  row.hidden = !selectedId || mode === 'off';
  if (row.hidden) { row.replaceChildren(); paintComposerStatusLine(); return; }
  const objective = $<HTMLTextAreaElement>('sessionObjective').value.trim();
  const label = el('span', 'queue-label', () => `${mode === 'loop' ? t("Loop") : t("Pursuing goal")}${objective ? ' · ' + objective : ''}`);
  label.title = objective;
  row.replaceChildren(icon('i-pulse'), label,
    dockAction(() => t("Pause automation"), 'i-power', () => { const select = $<HTMLSelectElement>('chatAutomation'); select.value = 'off'; select.dispatchEvent(new Event('change')); }),
    dockAction(() => t("Edit task"), 'i-pencil', event => {
      // This opener is outside the menu; its click must not immediately dismiss it.
      event.stopPropagation();
      $<HTMLDetailsElement>('composerSettings').open = true;
      $<HTMLTextAreaElement>('sessionObjective').focus();
    }));
  // The row is one of the blocks the line summarises, so the line follows it.
  paintComposerStatusLine();
}
type TaskPlanDraft = { text: string; requestId: string | null; stages: string[] | null; sending: boolean; progress: TaskProgress | null; error: string | null };
// Planning belongs to its draft key. Completed stages own their captured objective
// independently of composer edits; existing sessions hand them to the durable queue.
const taskPlans = new Map<string, TaskPlanDraft>();
function currentPreparedPlan(): (TaskPlanDraft & { stages: string[] }) | null {
  const plan = taskPlans.get(draftKey());
  return plan?.stages ? plan as TaskPlanDraft & { stages: string[] } : null;
}
function cancelTaskPlan(key = draftKey()): void {
  const plan = taskPlans.get(key);
  taskPlans.delete(key);
  if (plan?.requestId) void api.cancelTaskRequest?.(plan.requestId);
  if (draftKey() === key) paintTaskPlan();
}
function paintTaskPlan(): void {
  const plan = taskPlans.get(draftKey());
  const preview = $('taskPlanPreview'); preview.replaceChildren();
  preview.hidden = !plan || (!plan.requestId && !plan.stages && !plan.error);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => plan && !plan.text ? t("Describe the task to turn into a plan…") : t("Ask anything…"));
  if (plan?.stages) paintPreparedPlan();
  else if (plan?.error) {
    const failure = plan.error;
    const error = el('div', 'muted', () => failure === 'invalid_goal_decision_json' ? t("The planner response could not be read.") : goalErrorMessage(failure));
    error.title = plan.error;
    preview.append(error, el('div', 'muted', () => t("Send again to retry, or cancel the plan.")));
  } else if (plan?.requestId) {
    const progress = plan.progress;
    const label = () => !progress ? t("Creating plan…") : progress.phase === 'retrying' ? t("Provider busy · retry {0}{1}", [progress.attempt ?? '', progress.retryAt ? t(' at {0}', [new Date(progress.retryAt).toLocaleTimeString()]) : '']) : progress.phase === 'cancelled' ? t("Plan cancelled") : progress.phase === 'preparing' ? t("Preparing plan…") : progress.phase === 'ready' ? t("Plan ready") : progress.phase === 'failed' ? t("Plan failed") : t("Writing plan…");
    preview.append(el('span', 'muted', label));
    if (progress?.text || progress?.error) preview.append(el('pre', 'task-progress-text', progress.error ? goalErrorMessage(progress.error) : progress.text));
  }
  paintTaskActions(); paintDeliveryControls(deliveryHost);
  // The preview is one of the blocks the line summarises, so the line follows it.
  paintComposerStatusLine();
}
async function createTaskPlan(backend: 'api' | 'chatgpt'): Promise<void> {
  const input = $<HTMLTextAreaElement>('chatInput'), text = authoredComposerText().trim();
  const key = draftKey();
  cancelTaskPlan(key);
  const sessionId = selectedId, projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const requestId = text ? crypto.randomUUID() : null;
  const plan: TaskPlanDraft = { text, requestId, stages: null, sending: false, progress: null, error: null };
  taskPlans.set(key, plan); paintTaskPlan();
  if (!requestId) { input.focus(); return; }
  const current = () => taskPlans.get(key) === plan;
  const unsubscribe = api.onTaskProgress?.(progress => {
    if (progress.requestId !== requestId || !current()) return;
    plan.progress = progress;
    if (draftKey() === key) paintTaskPlan();
  });
  try {
    const result = await api.draftTaskPlan(text, backend, requestId);
    if (!current()) return;
    const draft = draftKey() === key ? authoredComposerText() : inputDrafts.get(key) ?? '';
    if (draft.trim() !== text) { cancelTaskPlan(key); return; }
    if (result.ok) {
      plan.stages = result.data;
      plan.requestId = null;
      // The accepted result now owns the captured request. Retire only its
      // unchanged source draft, before queue admission can yield to new typing.
      inputDrafts.delete(key);
      if (draftKey() === key) { replaceComposerDraft(); input.value = ''; skillPicker?.restore(); }
      if (sessionId) await queuePreparedPlan(key, plan as TaskPlanDraft & { stages: string[] }, sessionId, projectId);
    }
    else plan.error = result.error;
  } catch (error) {
    if (current()) plan.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe?.(); plan.requestId = null;
    if (current() && draftKey() === key) paintTaskPlan();
  }
}
function paintPreparedPlan(): void {
  const plan = currentPreparedPlan();
  if (!plan) return;
  const preview = $('taskPlanPreview'); preview.hidden = plan.sending;
  // Sending hands presentation to the outbox/queued-stage rows. Keeping the editable
  // draft visible until the async receipt arrives paints the same plan twice. Retain
  // its data so a rejected send can restore the editable preview in the existing finally.
  if (plan.sending) { preview.replaceChildren(); paintComposerStatusLine(); return; }
  preview.replaceChildren(...plan.stages.map((stage, index) => {
    const row = el('div', 'plan-stage');
    const heading = el('div', 'plan-stage-heading');
    const label = el('span', 'stage-number', String(index + 1)); ui(label, 'aria-label', () => t("Stage {0}", [index + 1]));
    const text = el('span', 'queue-label', stage); text.title = stage; text.dir = 'auto';
    const field = document.createElement('textarea'); field.dir = 'auto'; field.value = stage; field.maxLength = 16000; field.hidden = true;
    ui(field, 'aria-label', () => t("Edit stage {0}", [index + 1]));
    const error = el('span', 'stage-error', () => t("Enter text or delete this stage.")); error.id = `planStageError-${index}`; error.hidden = !!stage.trim();
    const validate = () => { error.hidden = !!field.value.trim(); field.setAttribute('aria-invalid', String(!error.hidden)); paintDeliveryControls(deliveryHost); };
    field.setAttribute('aria-describedby', error.id); field.setAttribute('aria-invalid', String(!error.hidden));
    field.oninput = () => { plan.stages[index] = field.value; text.textContent = field.value; text.title = field.value; validate(); };
    const edit = dockAction(() => t("Edit stage {0}", [index + 1]), 'i-pencil', () => {
      field.hidden = !field.hidden; edit.setAttribute('aria-expanded', String(!field.hidden)); if (!field.hidden) field.focus();
    });
    edit.setAttribute('aria-expanded', 'false');
    const remove = dockAction(() => t("Delete stage {0}", [index + 1]), 'i-trash', () => {
      if (plan.sending) return;
      plan.stages.splice(index, 1);
      if (plan.stages.length) { paintPreparedPlan(); paintDeliveryControls(deliveryHost); } else cancelTaskPlan();
    });
    edit.disabled = remove.disabled = field.disabled = plan.sending;
    ui(heading, 'title', () => selectedId ? t("Queued at Session finish; edit or delete this checkpoint independently.") : index === 0 ? t("Send includes your complete request and the full plan. Later stages are queued as verification checkpoints.") : t("Included in the first message, then queued as a checkpoint at Session finish or after a completed answer when enabled."));
    heading.append(label, text, edit, remove); row.append(heading, field, error); return row;
  }));
  paintComposerStatusLine();
}
async function sendPreparedPlan(): Promise<void> {
  const key = draftKey(), plan = currentPreparedPlan();
  if (!plan || plan.sending) return;
  if (selectedId) {
    await queuePreparedPlan(key, plan, selectedId, sessions.find(row => row.id === selectedId)?.projectId ?? null);
    return;
  }
  const tasks = plan.stages.map(stage => stage.trim());
  if (!tasks.length || tasks.some(task => !task) || JSON.stringify(tasks).length > 12000) { toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return; }
  plan.sending = true; paintPreparedPlan();
  try {
    const sent = await sendComposer(undefined, tasks, plan.text);
    if (taskPlans.get(key) === plan && sent) { await refreshInputQueue(deliveryHost); if (taskPlans.get(key) === plan) cancelTaskPlan(key); }
  } finally {
    if (taskPlans.get(key) === plan) { plan.sending = false; if (draftKey() === key) paintTaskPlan(); }
  }
}
async function queuePreparedPlan(key: string, plan: TaskPlanDraft & { stages: string[] }, sessionId: string, projectId: string | null): Promise<void> {
  if (plan.sending) return;
  const stages = plan.stages.map(stage => stage.trim());
  if (!stages.length || stages.some(stage => !stage) || JSON.stringify(stages).length > 12000) {
    toast(t("Keep every stage nonempty and the plan below 12,000 characters.")); return;
  }
  plan.sending = true;
  if (draftKey() === key) paintTaskPlan();
  try {
    const result = await run(api.sendInput({ id: crypto.randomUUID(), sessionId, projectId,
      text: stages[0]!, objective: plan.text, authoredSource: 'objective', stages: stages.slice(1), mode: 'finish', dueAt: Date.now(), model: null, reasoningEffort: null }));
    if (result) {
      // The result already retired its source prompt. Admission leaves any newer
      // composer draft and attachments alone; the durable queue owns the stages.
      if (taskPlans.get(key) === plan) cancelTaskPlan(key);
      await refreshInputQueue(deliveryHost);
    }
  } finally {
    plan.sending = false;
    if (taskPlans.get(key) === plan && draftKey() === key) paintTaskPlan();
  }
}
function paintTaskActions(): void {
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  const save = $<HTMLButtonElement>('saveSessionObjective');
  const off = $<HTMLSelectElement>('chatAutomation').value === 'off';
  objective.hidden = off;
  document.querySelector<HTMLLabelElement>('label[for="sessionObjective"]')!.hidden = off;
  save.hidden = off;
  const saved = objective.dataset.saved === objective.value && !!objective.value.trim();
  save.disabled = objective.disabled || !objective.value.trim() || save.dataset.busy === 'true' || saved;
  ui(save.querySelector('span')!, 'textContent', () => save.dataset.busy === 'true' ? t("Saving…") : saved ? t("Saved") : t("Save task"));
  const text = authoredComposerText().trim();
  for (const id of ['createPlan']) {
    const button = $<HTMLButtonElement>(id);
    const plan = taskPlans.get(draftKey()), planMode = !!plan;
    if (plan?.requestId) { button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); }
    else { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
    button.disabled = plan?.sending === true;
    button.setAttribute('aria-pressed', String(planMode));
    ui(button.querySelector('span')!, 'textContent', () => planMode ? t("Cancel plan") : t("Create plan"));
    ui(button, 'title', () => planMode ? t("Return to a normal message; keep your draft") : text ? t("Split your message into editable stages") : t("Write a message in the composer first"));
  }
}
function paintLoopDelivery(): void {
  const model = confirmedComposerModel();
  $('loopDeliveryRow').hidden = $<HTMLSelectElement>('chatAutomation').value !== 'loop' ||
    !model || !isProModel(model.model, model.reasoningEffort);
}
function openingLoopDelivery(): boolean | undefined {
  return selectedId === null ? $<HTMLSelectElement>('loopDelivery').value === 'after-turn' : undefined;
}
function paintAutomationSwitch(): void {
  paintLoopDelivery();
  paintGoalProgress();
  paintActiveGoal();
  const select = $<HTMLSelectElement>('chatAutomation');
  for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === select.value));
    button.disabled = select.disabled;
  }
  // The mode is a labelled control in the toolbar, not a glyph the user has to open to read.
  ui($('composerModeLabel'), 'textContent', () => select.value === 'loop' ? t("Loop") : select.value === 'goal' ? t("Goal") : t("Ordinary"));
  paintComposerStatusLine();
  $<HTMLSelectElement>('sessionObjectiveMode').value = select.value === 'loop' ? 'loop' : 'goal';
  const loop = select.value === 'loop';
  ui(document.querySelector('label[for="sessionObjective"]')!, 'textContent', () => loop ? t("Loop instructions") : t("Goal"));
  ui($<HTMLTextAreaElement>('sessionObjective'), 'placeholder', () => loop ? t("What should each continuation focus on?") : t("What should this chat achieve?"));
  paintTaskActions();
}
async function refreshSessionControls(): Promise<void> {
  const id = selectedId, generation = ++controlsGeneration;
  const planHost = $('agentPlan');
  if (planHost.dataset.sessionId !== (id ?? '')) { renderAgentPlan(planHost, id, null); paintComposerStatusLine(); }
  const menu = $('sessionControls');
  if (controlledSessionId !== id || controlledSelection !== selectionGeneration) {
    // Retire the previous selection's projection before awaiting the new owner's IPC.
    // Replace the translation binding too, so a locale refresh cannot revive its status.
    ui($('sessionControlStatus'), 'textContent', () => '');
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
  }
  paintAutomationSwitch();
  if (!id) { controlledSessionId = null; controlledTurnId = null; paintDeliveryControls(deliveryHost); menu.hidden = false;
    $<HTMLTextAreaElement>('sessionObjective').disabled = false;
    paintTaskActions();
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    return; }
  const opening = pendingComposerInputs.find(row => row.opening && row.sessionId === id && ['queued', 'browser'].includes(row.state));
  if (!sessions.find(row => row.id === id)?.conversationId) {
    controlledSessionId = id; controlledSelection = selectionGeneration; controlledTurnId = null;
    controlledCanInject = false; controlledCanSendDirectly = false; controlledQueueAtFinish = false;
    controlledStopPending = false; controlledFinishWaiting = false;
    menu.hidden = false;
    goalDraftView = null; goalWaitView = null; finishGoalDraftView = null; controlledRecovery = [];
    $<HTMLSelectElement>('chatAutomation').value = opening?.automation ?? 'off';
    $<HTMLSelectElement>('loopDelivery').value = opening?.loopAfterTurn ? 'after-turn' : 'finish';
    const objective = $<HTMLTextAreaElement>('sessionObjective');
    objective.value = opening?.objective ?? ''; objective.disabled = true;
    objective.dataset.sessionId = id;
    for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
    paintAutomationSwitch(); paintDeliveryControls(deliveryHost);
    return;
  }
  const controls = await run(api.getSessionControls(id));
  if (generation !== controlsGeneration || id !== selectedId) return;
  renderAgentPlan(planHost, id, controls?.plan ?? null);
  paintComposerStatusLine();
  controlledSessionId = id;
  controlledSelection = selectionGeneration;
  controlledTurnId = controls?.activeTurnId ?? null;
  goalDraftView = controls?.goalDraft ?? null;
  goalWaitView = controls?.goalWait ?? null;
  finishGoalDraftView = controls?.finishGoalDraft ?? null;
  controlledStopPending = controls?.stopPending === true;
  controlledFinishWaiting = controls?.finishWaiting === true;
  controlledQueueAtFinish = controls?.queueAtFinish === true;
  controlledCanInject = controls?.canInject ?? controlledTurnId !== null;
  controlledCanSendDirectly = controls?.canSendDirectly === true;
  controlledRecovery = controls?.recovery ?? [];
  paintDeliveryControls(deliveryHost);
  paintStateLine();
  menu.hidden = !controls;
  $('compactSession').hidden = false;
  if (!controls) return;
  const objective = $<HTMLTextAreaElement>('sessionObjective');
  if (objective.dataset.sessionId !== id || !objective.dataset.edited) {
    objective.value = controls.objective;
    objective.dataset.saved = controls.objective;
    objective.dataset.sessionId = id;
    delete objective.dataset.edited;
    $<HTMLSelectElement>('sessionObjectiveMode').value = controls.automation === 'loop' ? 'loop' : 'goal';
  }
  objective.disabled = !!controls.blocked;
  paintTaskActions();
  const draftMode = $<HTMLSelectElement>('chatAutomation');
  if (!draftMode.dataset.edited) draftMode.value = controls.automation;
  if (!$<HTMLSelectElement>('loopDelivery').disabled)
    $<HTMLSelectElement>('loopDelivery').value = controls.loopAfterTurn ? 'after-turn' : 'finish';
  paintAutomationSwitch();
  $<HTMLButtonElement>('compactSession').disabled = !!controls.blocked || !!controls.job?.busy;
  $('cancelCompaction').hidden = !controls.job?.busy;
  ui($('sessionControlStatus'), 'textContent', () => controls.blocked === 'worker' ? t("This sub-agent is managed by its prime.") : controls.blocked === 'blocked' ? t("This chat is blocked.") : controls.job?.busy ? t("Compaction is running in ChatGPT.") : '');
}

async function loadDetail(navigate = false, olderBefore?: number, newerFrom?: number): Promise<void> {
  const prepend = olderBefore !== undefined;
  const wanted = selectedId;
  if (wanted !== null && historyBefore !== null && detailFor === wanted && !navigate) { void refreshSessionControls(); paintDetail(); return; }
  const generation = ++detailLoadGeneration;
  void refreshSessionControls();
  if (wanted === null) {
    handoffLoadGeneration++;
    historyBefore = null;
    events = [];
    totalEvents = 0;
    detailFor = null;
    detailCursor = null;
    $('timeline').style.removeProperty('--timeline-scroll-reserve');
    paintDetail();
    return;
  }
  const opening = detailFor !== wanted;
  if (opening) historyBefore = null;
  // Live deltas must not evict a historical page while the user is reading it.
  const incremental = !prepend && newerFrom === undefined && historyBefore === null && detailFor === wanted && detailCursor !== null;
  const detail = await run(
    api.getSession(wanted, newerFrom !== undefined ? { after: newerFrom, limit: MAX_TIMELINE_ROWS / 2 } : incremental ? { from: detailCursor!, limit: MAX_TIMELINE_ROWS } : { ...(olderBefore !== undefined ? { before: olderBefore } : historyBefore !== null ? { before: historyBefore } : {}), limit: prepend ? MAX_TIMELINE_ROWS / 2 : MAX_TIMELINE_ROWS })
  );
  if (generation !== detailLoadGeneration || selectedId !== wanted) return;
  if (!detail) {
    // A failed destination read must not leave another chat displayed indefinitely.
    // run() already presents the read error; keep the destination empty and retryable.
    if (opening) {
      $('timeline').replaceChildren();
      $('timeline').removeAttribute('inert');
      $('timeline').removeAttribute('aria-busy');
    }
    return;
  }
  // An empty older page is not navigation. Keep the live cursor and viewport intact.
  if (prepend && !detail.events.length) return;
  // User/assistant prose is canonical in messages.json, while structured page activity stays
  // append-only by design: ChatGPT can grow one commentary caption or rewrite one activity
  // label several times. `foldProgress` turns those snapshots back into the one logical row
  // their stable progressId/messageId names, then chronology places that row at its first
  // appearance. This helper existed already but was never wired into the desktop reader,
  // which is why "Inspecting…" and "Inspected…" still appeared as siblings.
  if (incremental) mergeDetailDelta(detail.events);
  else {
    const folded = chronological(foldProgress(detail.events));
    if (newerFrom !== undefined) {
      events = retainTimelinePage(chronological(foldProgress([...events, ...folded])), 'newer');
      // Reaching the live tail restores ordinary delta reads. Paging itself preserves
      // the reader's row even when they were at the bottom of the previous window.
      if (detail.events.length < MAX_TIMELINE_ROWS / 2) historyBefore = null;
    } else if (prepend) {
      const boundary = olderBefore!;
      historyBefore = boundary;
      const retained = events.filter(event => positionOf(event) >= boundary);
      events = retainTimelinePage(chronological(foldProgress([...folded, ...retained])), 'older');
    } else events = chronological([...folded].sort((a, b) => positionOf(a) - positionOf(b)).slice(-MAX_TIMELINE_ROWS));
    detailFor = wanted;
  }
  detailCursor = Math.max(opening ? 0 : detailCursor ?? 0,
    typeof detail.nextFrom === 'number'
      ? detail.nextFrom
      : detail.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), incremental ? detailCursor! : 0));
  totalEvents = detail.total;
  if (opening) $('timeline').style.removeProperty('--timeline-scroll-reserve');
  paintDetail(!prepend && newerFrom === undefined);
  // A selection opens at the latest message; the previous chat's viewport is not
  // a reading position in this one. Apply only after the current load has rendered.
  if (opening) $('chatBody').scrollTop = $('chatBody').scrollHeight;
  void loadHandoff();
  // A burst can contain more than one renderer-sized page between coalesced notifications.
  // Drain it page by page rather than silently jumping the cursor or lifting the payload cap.
  if (incremental && detail.events.length === MAX_TIMELINE_ROWS && selectedId === wanted) {
    window.setTimeout(() => void loadDetail(), 0);
  }
}

async function loadHandoff(): Promise<void> {
  const sessionId = selectedId;
  const generation = ++handoffLoadGeneration;
  const summary = sessions.find((s) => s.id === sessionId) ?? null;
  const wanted = summary?.lastHandoffId ?? null;
  if (wanted === null) {
    if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
    handoff = null;
    handoffFor = null;
    paintHandoff();
    return;
  }
  if (handoffFor === wanted) return;
  const loaded = await run(api.getHandoff(summary!.id, wanted));
  if (generation !== handoffLoadGeneration || selectedId !== sessionId) return;
  handoff = loaded ?? null;
  handoffFor = wanted;
  paintHandoff();
}

// ------------------------------------------------------------------ timeline

function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  // Recorded text is whatever language the user and ChatGPT were speaking. The stylesheet is
  // written left-to-right throughout, so an Arabic or Hebrew message rendered without this
  // reads with its punctuation and numbers on the wrong side. `auto` resolves from the first
  // strong character, so Latin text is unaffected.
  node.setAttribute('dir', 'auto');
  if (truncated) {
    node.append(el('span', 'cut', () => t(" … cut, {0} characters in the original", [compactNumber(chars)])));
  }
  return node;
}

const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  return safeExternalLink(trimmed) ? trimmed : null;
}

const PROVIDER_CITATION = /^\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/;
const PROVIDER_URL = /^\uE200url\uE202([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/;
/** Native citation labels and URLs may arrive before the DOM paints the rest of a canonical
 * revision. Use only exact source ranges with matching preceding prose, never substitute
 * the whole captured HTML or guess a destination from an opaque provider reference id. */
function citationLabels(source: string, capture?: StoredText): Map<string, string> {
  const links = new Map<string, string>();
  if (!capture?.text || capture.truncated || capture.text.length > MAX_RENDERED_HTML_CHARS) return links;
  const template = document.createElement('template');
  template.innerHTML = capture.text;
  // Provider reference ranges count Unicode code points; JS slice counts UTF-16
  // units. Emoji before a citation otherwise move every subsequent range.
  const offsets = new Uint32Array(source.length + 1);
  let points = 0, units = 0;
  for (const char of source) { offsets[points++] = units; units += char.length; }
  offsets[points] = units;
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
  const prose = (fragment: DocumentFragment) => {
    // Native HTML and Markdown emit different whitespace around hard breaks and
    // list paragraphs. Compare the same rendered word boundaries in both trees.
    for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
    for (const block of fragment.querySelectorAll('p,div,li,ul,ol,blockquote,pre,h1,h2,h3,h4,h5,h6,table,tr,td,th')) {
      block.prepend('\n'); block.append('\n');
    }
    return normalized(fragment.textContent ?? '');
  };
  for (const reference of template.content.querySelectorAll('[data-content-reference-start][data-content-reference-end]')) {
    const from = Number(reference.getAttribute('data-content-reference-start'));
    const to = Number(reference.getAttribute('data-content-reference-end'));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > points) continue;
    const start = offsets[from]!, end = offsets[to]!;
    const marker = source.slice(start, end);
    if (marker.match(PROVIDER_CITATION)?.[0] !== marker) continue;
    const before = document.createRange(); before.setStart(template.content, 0); before.setEndBefore(reference);
    const preceding = before.cloneContents();
    for (const prior of preceding.querySelectorAll('[data-content-reference-start]')) prior.remove();
    const canonical = document.createElement('template');
    canonical.innerHTML = marked.parse(source.slice(0, start).replace(/\uE200(?:cite|filecite)\uE202[^\uE200\uE201]*\uE201/g, ''), { async: false, gfm: true });
    if (prose(preceding) !== prose(canonical.content)) continue;
    if (marker.startsWith('\uE200filecite\uE202')) {
      const names = [...reference.querySelectorAll('[data-file-citation-primary-file-id] button')]
        .map(node => normalized(node.textContent ?? '')).filter(name => name.length > 0 && name.length <= 500);
      if (names.length) {
        const label = document.createElement('span');
        label.textContent = ` (${[...new Set(names)].join(', ')})`;
        links.set(marker, label.outerHTML);
      }
      continue;
    }
    const anchors: string[] = [], seen = new Set<string>();
    for (const candidate of reference.querySelectorAll('a[href]')) {
      const href = safeRenderedHref(candidate.getAttribute('href') ?? '');
      if (!href || !/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      const anchor = document.createElement('a'); anchor.href = href;
      anchor.textContent = new URL(href).hostname;
      ui(anchor, 'title', () => candidate.textContent?.trim().slice(0, 500) || t("Source"));
      anchors.push(anchor.outerHTML);
    }
    if (anchors.length) links.set(marker, ` (${anchors.join(', ')})`);
  }
  return links;
}

/**
 * Sanitizes ChatGPT's captured rendered HTML without reparsing Markdown.
 *
 * The page is untrusted input even though the extension produced the observation. Preserve
 * semantic Markdown tags, discard executable/form/embed content, strip every attribute by
 * default, and allow only the tiny attribute set that affects normal Markdown semantics.
 */
/**
 * One assistant message, as ChatGPT rendered it when that is available and whole, and as its
 * own markdown source when it is not.
 *
 * The two are laid out differently on purpose. Rendered markup carries its own block
 * structure, so it is flowed (`rich`). Markdown source is plain text whose every line break,
 * heading and list item is a newline, so it keeps `msg`'s pre-wrap — flowing it would run a
 * whole brief together into one paragraph.
 */
export function renderedMarkdown(source: string, capture?: StoredText): HTMLElement {
  // Fiber's canonical text can be complete while a background provider tab still
  // paints its first words. Render this revision directly; captured DOM HTML is
  // never evidence that it contains the current message revision.
  const text = withoutMessageReaction(source).slice(0, MAX_RENDERED_HTML_CHARS);
  const citations = text.includes('\uE200') ? citationLabels(text, capture) : new Map<string, string>();
  // An inline tokenizer leaves literal citation examples inside code spans/fences intact.
  const parser = new Marked({ gfm: true, extensions: [{
    name: 'providerReference', level: 'inline',
    start: value => value.indexOf('\uE200'),
    tokenizer(value) { const match = value.match(PROVIDER_URL) ?? value.match(PROVIDER_CITATION); return match ? { type: 'providerReference', raw: match[0] } : undefined; },
    renderer(token) {
      const url = token.raw.match(PROVIDER_URL);
      if (url) {
        // Unlike opaque citation IDs, a native url token already carries its exact
        // authored label and destination. Captured React anchors may have no href.
        const link = document.createElement('a'); ui(link, 'textContent', () => url[1] || url[2] || t("Link"));
        if (safeExternalLink(url[2] ?? '')) link.setAttribute('href', url[2]!);
        return link.outerHTML;
      }
      return citations.get(token.raw) ?? (token.raw.startsWith('\uE200filecite\uE202') ? '' : '<span title="The recording does not include this source URL">[source link unavailable]</span>');
    }
  }] });
  const html = parser.parse(text, { async: false });
  return renderedMessage({ text: html, chars: html.length, truncated: html.length > MAX_RENDERED_HTML_CHARS }, text);
}

export function renderedMessage(html: StoredText | null | undefined, fallback: string): HTMLElement {
  const box = el('div', 'msg');
  // Same reason as textBlock, for the markdown path — and it is the fallback rather than the
  // authority: an element below that carried its own direction keeps it.
  box.setAttribute('dir', 'auto');
  const safeFallback = fallback.slice(0, MAX_RENDERED_HTML_CHARS);
  // A capture the store had to cut is markup that stops mid-element — very often inside a
  // code block, whose wrapper chrome is far larger than the code in it — so it presents part
  // of the message and ends as an unclosed box. It is not a presentation of this message and
  // is not shown as one.
  if (!html || html.truncated || !html.text) {
    box.textContent = safeFallback;
    return box;
  }
  box.classList.add('rich');
  const template = document.createElement('template');
  // Parsing untrusted captured HTML constructs a second tree before sanitisation. Bound it
  // before innerHTML so a valid but huge recorded turn cannot freeze/OOM the renderer.
  template.innerHTML = html.text.slice(0, MAX_RENDERED_HTML_CHARS);
  const visit = (parent: ParentNode, directionOwned = false): void => {
    for (const node of [...parent.childNodes]) {
      // Namespace elements (SVG/MathML) are not HTMLElements. Checking HTMLElement here
      // would let exactly the foreign content in DROP_RENDERED_TAGS bypass traversal and
      // attribute stripping. nodeType is realm-agnostic and covers every DOM Element.
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tagName = element.tagName.toUpperCase();
      if (DROP_RENDERED_TAGS.has(tagName)) {
        element.remove();
        continue;
      }
      const sourceDir = element.getAttribute('dir')?.toLowerCase();
      const dir = sourceDir === 'ltr' || sourceDir === 'rtl' || sourceDir === 'auto' ? sourceDir : null;
      // Native first-strong detection belongs to each prose block, not the whole
      // answer. A list/quote or explicit captured direction owns its descendants:
      // nested auto scopes would exclude their text from that owner's scan.
      const automatic = !directionOwned && /^(P|H[1-6]|UL|OL|BLOCKQUOTE|TD|TH)$/.test(tagName);
      const code = tagName === 'PRE' || tagName === 'CODE' || tagName === 'KBD';
      const resolvedDir = RENDERED_TAGS.has(tagName) ? dir ?? (code ? 'ltr' : automatic ? 'auto' : null) : null;
      visit(element, directionOwned || !!resolvedDir);
      if (!RENDERED_TAGS.has(tagName)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const href = tagName === 'A' ? safeRenderedHref(element.getAttribute('href') ?? '') : null;
      const title = element.getAttribute('title');
      const start = tagName === 'OL' ? element.getAttribute('start') : null;
      const colSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('colspan') : null;
      const rowSpan = tagName === 'TD' || tagName === 'TH' ? element.getAttribute('rowspan') : null;
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      if (resolvedDir) element.setAttribute('dir', resolvedDir);
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noreferrer noopener');
      }
      if (title) element.setAttribute('title', title.slice(0, 500));
      if (start && /^\d{1,6}$/.test(start)) element.setAttribute('start', start);
      if (colSpan && /^\d{1,3}$/.test(colSpan)) element.setAttribute('colspan', colSpan);
      if (rowSpan && /^\d{1,3}$/.test(rowSpan)) element.setAttribute('rowspan', rowSpan);
    }
  };
  visit(template.content);
  box.append(template.content);
  const openLink = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !box.contains(anchor)) return;
    const href = safeRenderedHref(anchor.getAttribute('href') ?? '');
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView(); return; }
    // Electron deliberately denies arbitrary renderer navigation/window.open. A user
    // activation crosses the existing, independently validated main-process link API.
    void run(api.openLink(href));
  };
  box.addEventListener('click', openLink);
  box.addEventListener('auxclick', openLink);
  // Tables wrap to the transcript column. Extremely wide structural tables retain
  // their own horizontal scroll instead of widening/clipping the whole conversation.
  for (const table of box.querySelectorAll('table')) {
    const viewport = el('div', 'markdown-table');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    ui(viewport, 'aria-label', () => t("Table"));
    table.replaceWith(viewport);
    viewport.append(table);
  }
  if (!box.textContent?.trim() && safeFallback) {
    box.classList.remove('rich');
    box.textContent = safeFallback;
  }
  return box;
}

/**
 * Tool calls the user has opened, by their durable call id.
 *
 * The timeline is redrawn from scratch whenever anything is recorded, and a fresh
 * `<details>` is closed. So opening a call to read its arguments and then having ChatGPT
 * make one more MCP call — which is to say, the normal case — silently collapsed what you
 * were reading, several times a minute. Remembering the open set outside the DOM is what
 * makes a redraw invisible; the ids are the recorder's own, so they survive the rebuild.
 *
 * Cleared when a different session is selected, not on every repaint: the whole point is
 * that a repaint must not be able to change what is open.
 */
const openTools = new Set<string>();

/**
 * The rows currently on screen, by timeline key, with the signature they were drawn from.
 *
 * A repaint rebuilds only the rows whose signature changed and reuses every other element
 * as it is. That is what keeps the scroll position honest: a row the user has opened keeps
 * its height and its place, so the pane does not lurch when ChatGPT records one more call —
 * and the rebuilt-from-scratch list, which made the whole pane re-lay out on every event,
 * is what made reading an open call impossible while a chat was working.
 */
const rowCache = new Map<string, { sig: string; row: HTMLElement }>();

function forgetTimelineRows(): void {
  openTools.clear();
  rowCache.clear();
}

function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: { id: string; current: () => boolean }): HTMLElement {
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
  // Older recordings did not retain the reason an image asset was omitted. Explain
  // the missing local preview without inferring a historical provider receipt.
  if (call.tool === 'view_image' && call.outcome === 'ok' && images.length === 0) {
    raw.append(el('p', 'meta', () => t("No image preview was retained in this recording.")));
  }
  if (images.length && (context?.id || selectedId)) {
    const id = context?.id ?? selectedId!, generation = selectionGeneration;
    const attachments = el('div', 'tool-images');
    let loaded = false;
    const load = async () => {
      if (!box.open || loaded) return;
      loaded = true;
      for (const asset of images) {
        const data = await run(api.getSessionImage(id, asset.id));
        if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
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

function hasLaterModelActivity(time: number): boolean {
  return events.some(event => event.time > time && ['assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message'].includes(event.kind));
}

function paintInputReceipt(row: HTMLElement, item: ReturnType<typeof timelineItems>[number]): void {
  if (item.kind !== 'event' || item.event.kind !== 'user_message') return;
  const receipt = row.querySelector<HTMLElement>('.input-receipt');
  if (!receipt) return;
  receipt.hidden = hasLaterModelActivity(item.event.time);
  receipt.parentElement?.classList.toggle('has-input-receipt', !receipt.hidden);
}

/** The exact outbox input retains preview bytes until optional history storage succeeds. */
function retainedInputImages(event: Extract<SessionEvent, { kind: 'user_message' }>, sessionId: string | null): InputImage[] {
  if (!sessionId || !event.inputId) return [];
  const root = pendingComposerInputs.find(entry => entry.id === event.inputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId &&
    (entry.messageId ? entry.messageId === event.messageId : event.messageId === `input:${entry.id}`));
  if (!root) return [];
  const companion = root.companionInputId ? pendingComposerInputs.find(entry => entry.id === root.companionInputId &&
    (entry.sessionId ?? entry.deliveredSessionId) === sessionId && entry.messageId === root.messageId) : undefined;
  // Match combinedInput's canonical image order for asset-index fallback.
  return [...root.images ?? [], ...companion?.images ?? [], ...root.toolImages ?? []].slice(0, MAX_INPUT_IMAGES);
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

function eventBody(event: SessionEvent, context?: { id: string; current: () => boolean; history: readonly SessionEvent[] }): HTMLElement {
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
      const retained = retainedInputImages(event, context?.id ?? selectedId);
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
      // Native ChatGPT can prepend a blank paragraph. Ignore it only when a
      // complete instruction frame validates; keep the authored suffix exact.
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
      if (assets.length && (context?.id || selectedId)) {
        const id = context?.id ?? selectedId!, generation = selectionGeneration;
        void (async () => {
          for (const [index, asset] of assets.entries()) {
            const data = await run(api.getSessionImage(id, asset.id));
            if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
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
      const id = context?.id ?? selectedId;
      const generation = selectionGeneration;
      const currentRichRow = () => context ? context.current() : selectedId === id && selectionGeneration === generation;
      box.append(event.rich ? renderRichResponse(event.rich, event.message.text, id ? {
        sessionId: id,
        media: event.richMedia ?? [],
        current: currentRichRow,
        // Displaying persisted richOrigin is not a URL grant. The explicit button
        // performs no action or browser input: main rereads the exact canonical
        // historical assistant under the current window/selection witness.
        ...(event.richOrigin && event.messageId ? { openOriginal: async () => {
          const selected = acknowledgedUiSelection;
          if (!currentRichRow() || selected?.sessionId !== id) return false;
          try {
            const reply = await api.openRichOriginal(id, event.messageId!);
            return currentRichRow() && acknowledgedUiSelection?.generation === selected.generation &&
              reply.ok && reply.data === true;
          } catch { return false; }
        } } : {})
      } : undefined)
        : renderedMarkdown(event.message.text, event.renderedHtml));
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
      const id = context?.id ?? selectedId;
      if (event.asset && id) {
        const generation = selectionGeneration;
        void (async () => {
          const data = await run(api.getSessionImage(id, event.asset!.id));
          if (context ? !context.current() : id !== selectedId || generation !== selectionGeneration) return;
          // Only the fixed local image reader's bounded bytes may become an IMG source.
          // A malformed IPC reply must never trigger a remote image request or paint a
          // different MIME under this exact canonical generated-image asset.
          if (!localDataUrl(data, event.asset!.mimeType)) {
            const pane = context ? box.closest<HTMLElement>('.agent-panel-body') : $('chatBody');
            const timeline = context ? pane : $('timeline');
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
      const presentation = () => chatErrorPresentation(event, context?.history ?? events);
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
     * The timeline is how the user checks what the agents actually said to each other, and
     * a run of grey "Unknown event" rows in the middle of a multi-agent session reads as a
     * broken log — the one impression a session recorder cannot afford to give.
     */
    case 'agent_message': {
      const box = document.createElement('details');
      box.className = 'agent-communication';
      // Which end of the message this record is. The same message is written once here and
      // once in the other agent's session, so without this a pair reads as two messages.
      ui(box, 'title', () => event.delivery === 'sent'
          ? t("Sent by {0}; recorded when the app accepted it", [event.from])
          : t("Received by {0}; recorded when it acknowledged delivery", [event.to]));
      const summary = el('summary');
      const worker = event.from === 'prime' ? event.to : event.from;
      const avatar = el('span', 'agent-avatar', worker.replace(/^worker-/, ''));
      avatar.dataset.color = String([...worker].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
      avatar.setAttribute('aria-hidden', 'true');
      summary.append(avatar, el('span', '', () => communicationTitle(event)));
      const communicationKey = `agent:${context?.id ?? selectedId}:${event.seq}`;
      box.open = openTools.has(communicationKey);
      box.addEventListener('toggle', () => { if (box.open) openTools.add(communicationKey); else openTools.delete(communicationKey); });
      box.append(summary);
      box.append(textBlock('msg', event.message.text, event.message.truncated, event.message.chars));
      if (!context) {
        const matches = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && entry.origin.agentId === worker);
        if (matches.length === 1) {
          const open = el('button', 'btn agent-chat-open'); open.setAttribute('type', 'button');
          ui(open, 'aria-label', () => t("Open {0} chat", [worker]));
          const arrow = icon('i-out'); arrow.setAttribute('aria-hidden', 'true');
          open.append(el('span', '', () => t("Open worker chat")), arrow);
          open.onclick = () => void agentPanel?.open(matches[0]!.id); box.append(open);
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
  // One class per content family, so the stylesheet owns what a family looks like and
  // this builder only says which family a row belongs to. `ev-<kind>` stays: it is the
  // hook the reconciliation, grouping and fixtures already select on.
  const row = el('div', `ev ev-${event.kind} tl-row ${categoryClass(categoryFor(event.kind))}`);
  if (event.kind === 'assistant_message' && !event.rich && !event.richMediaUnavailable &&
      !withoutMessageReaction(event.message.text).trim()) row.hidden = true;
  tagImageRow(row, event);
  const time = document.createElement('time');
  time.textContent = clockTime(event.time);
  time.title = new Date(event.time).toLocaleString();
  const body = el('div', 'ev-body');
  const currentWorker = sessions.find(session => session.id === selectedId)?.origin;
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

/**
 * The agent chips above the timeline.
 *
 * Drawn only when this session actually has more than one attribution in it, so a
 * single-agent session — which is every session unless multi-agent mode is running —
 * keeps exactly the view it had before.
 */
function paintAgentFilter(): void {
  const box = $('chatAgentFilter');
  if (!deps.state()?.config.ui.developerMode) { box.hidden = true; agentFilter = null; return; }
  const named = [...new Set(events.flatMap((event) => (event.agent ? [event.agent] : [])))].sort();
  const anyUnattributed = events.some((event) => !event.agent);
  // A filter belongs to the session it was chosen in. Carrying it across a selection
  // change showed the next session's timeline as empty with no chip lit to explain why —
  // and agent ids repeat between runs, so it could also silently hide half of one. The
  // same guard catches an agent that simply is not in this session's events.
  if (filterFor !== selectedId) {
    agentFilter = null;
    filterFor = selectedId;
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
  if (agentFilter === null) return events;
  if (agentFilter === UNATTRIBUTED) return events.filter((event) => !event.agent);
  return events.filter((event) => event.agent === agentFilter);
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

/** Eviction follows the measured reader viewport, not an arbitrary half-page.
 * Keep the current visible rows plus the incoming stage; ordinary tall histories
 * still settle at 160 records. Dense collapsed activity has bounded extra room. */
function retainTimelinePage(source: SessionEvent[], direction: 'older' | 'newer'): SessionEvent[] {
  // Residency and navigation share the immutable origin domain. Display order
  // can move a final across its turn's tools, but must not cut a hole in a page.
  source = [...source].sort((a, b) => positionOf(a) - positionOf(b));
  const pane = $('chatBody');
  const edge = pane.getBoundingClientRect().top;
  const protectedKeys = new Set<string>();
  for (const row of $('timeline').querySelectorAll<HTMLElement>('[data-timeline-key]')) {
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
    const end = Math.min(source.length, Math.max(MAX_TIMELINE_ROWS, last + 1));
    return chronological(source.slice(0, Math.min(end, MAX_TIMELINE_RESIDENT_ROWS)));
  }
  const start = Math.max(0, Math.min(source.length - MAX_TIMELINE_ROWS, first));
  return chronological(source.slice(Math.max(start, source.length - MAX_TIMELINE_RESIDENT_ROWS)));
}

/** Newest-first selection, returned chronologically, under resident and text/HTML budgets. */
function boundedTimeline(source: SessionEvent[]): { shown: SessionEvent[]; omitted: number } {
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
 * The recorder stores a compaction as it happened: the brief request typed into chat A, the
 * brief ChatGPT answered with, the app's own "handoff saved" line, and the bootstrap typed
 * into chat B — four rows, three of them long, in an order that reflects when each was
 * observed rather than what they were. Read as a timeline they look like three separate
 * things going on; they are one thing with three steps, and this is that thing.
 */
interface CompactionBlock {
  token: string;
  /** The row this card takes the place of. */
  seq: number;
  time: number;
  prompt: Extract<SessionEvent, { kind: 'user_message' }> | null;
  /**
   * The turn ChatGPT answered the brief request in. The request is typed by the app, so its
   * row carries no local turn id of its own; the turn is the one that opens right after it.
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
 * A card opens at the marked brief request and absorbs what belongs to it: the turn
 * that answers it, the answer (the brief), the app's
 * handoff line. The marked bootstrap in the replacement chat closes the same card by token,
 * wherever it lands, and so does an app note naming the token. A bootstrap whose request has
 * scrolled out of the window still gets a card, with the steps it implies already done.
 *
 * Which turn answers the request is read from the log, not from the request row. The
 * request is typed by the app into the chat, so the extension records it with no local turn
 * id (or, on a reload, with the previous turn's); the generation ChatGPT opens for it is the
 * first `turn_start` after it. Keying on the request's own `turnId` left that start, the
 * brief, the end and the handoff as four loose rows under an empty card — the live shape.
 */
function timelineItems(source: SessionEvent[]): TimelineItem[] {
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
        // Chronology puts a turn's start before the message that opened it, so the request
        // turn's own start row is already on the list; it belongs to the card like the rest.
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
      // Local calls can finish or be refused after the source request. They remain
      // ordinary visible rows and cannot close the summary's grouping or decide its fate.
      // Only another authored user message starts an unrelated conversation step.
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
 * Success and failure come from the recorded continuation, never from later activity
 * in this timeline. Refused source calls are compatible with a still-running handoff.
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

function compactionRow(block: CompactionBlock, previous?: HTMLElement): HTMLElement {
  const key = `compaction:${block.token}`;
  const state = compactionState(block);

  // A Compact & Resume card is where the `handoff` family's rows went: the fold replaces the
  // brief/request/end/handoff events with one card, so it carries that family's identity
  // rather than inventing a kind of its own.
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
    // The marker is stripped in whichever form the page recorded it; `marker` is the exact
    // text that matched, so an escaped one is removed as completely as a clean one.
    const request = prompt.replace(continuationMarkerOf(prompt)?.marker ?? '', '');
    raw.append(textBlock('pre', request, block.prompt.message.truncated, block.prompt.message.chars));
  }
  if (block.brief) {
    const brief = block.brief;
    raw.append(el('h4', '', () => brief.final ? t("Summary") : t("Summary (still writing)")));
    raw.append(renderedMarkdown(block.brief.message.text));
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
    // Streaming changes only the affected section. Keep the disclosure, focus and
    // unchanged request mounted instead of replacing the whole reading surface.
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

/**
 * The header that opens one ChatGPT frontend's run inside this durable local session.
 *
 * The spine itself is drawn by the `.spine` container; these headers are the labelled divisions
 * on it. They read only what the session metadata and recorded events already say — the segment
 * list comes from `frontendSegments`, so nothing here decides lineage.
 */
function spineSegmentRow(segment: FrontendSegment): HTMLElement {
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
function withSpineSegments(rows: HTMLElement[], spine: FrontendSegment[]): HTMLElement[] {
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

/** What a row was drawn from; a different signature is a different row. */
function itemSignature(item: TimelineItem): string {
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
      // A badge-only revision patches the existing bubble, preserving loaded images
      // and selection. Every other recorded field still invalidates its body.
      const { seq: _seq, reaction: _reaction, ...body } = event;
      parts.push(JSON.stringify(body));
      // Bytes are immutable for an accepted input. Queue arrival must repaint a
      // canonical row even if its recorded revision did not change.
      parts.push(...retainedInputImages(event, selectedId).map(image => `${image.name}:${image.dataUrl.length}`));
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
        JSON.stringify(event.retiredRichImageAssetIds ?? []));
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
  // A canonical revision advances the update cursor, not the identity of the row
  // anchoring the viewport and the following activity disclosure.
  const message = canonicalMessageKey(item.event);
  return message ? `message:${message}` : `event:${item.event.seq}`;
}

/** One activity disclosure between authored messages; communication keeps its own identity inside. */
const toolGroups = new Map<string, HTMLDetailsElement>();
/** Keep retained scroll containers mounted: rebuilding a feed must not restart
 * disclosure animations or detach a result while the user is scrolling it. */
function groupToolRows(rows: HTMLElement[], scope = selectedId, groups = toolGroups): HTMLElement[] {
  const grouped: HTMLElement[] = [], retained = new Set<string>();
  for (let i = 0; i < rows.length;) {
    if (!rows[i]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message')) { grouped.push(rows[i++]!); continue; }
    let end = i + 1;
    while (end < rows.length && rows[end]!.matches('.ev-tool_call, .ev-page_tool, .ev-agent_message') && rows[end]!.dataset.activityBoundary === rows[i]!.dataset.activityBoundary) end++;
    if (end - i === 1) { grouped.push(rows[i++]!); continue; }
    // Paging can extend or trim the beginning of an activity group. Its first
    // member is therefore not a new disclosure/viewport identity.
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
function tagImageRow(row: HTMLElement, event: SessionEvent): void {
  if (event.kind !== 'native_image') return;
  row.dataset.imageAgent = event.agent ?? '';
  row.dataset.imageMessage = event.messageId;
  row.dataset.imageTurn = event.turnId ?? '';
}
function groupImageRows(rows: HTMLElement[]): HTMLElement[] {
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

function composerSessionSelection(summary: SessionSummary | null | undefined) {
  if (summary?.conversationId) return summary.selectedModel;
  const opening = pendingComposerInputs.find(row => row.opening && row.sessionId === summary?.id && ['queued', 'browser'].includes(row.state));
  return opening?.model ? { model: opening.model, reasoningEffort: opening.reasoningEffort ?? undefined, observedAt: opening.createdAt } : null;
}
function paintDetail(followBottom = historyBefore === null): void {
  paintStateLine();
  const summary = sessions.find((s) => s.id === selectedId) ?? null;
  applyComposerSessionModel(selectedId ? `${selectedId}:${selectionGeneration}` : null, composerSessionSelection(summary) ?? null);
  const config = deps.state()?.config;
  if (config) paintContextMeter(summary, config, confirmedComposerModel());
  const project = selectedLocalProject(sessionHost);
  $('chatProjectContext').hidden = !project;
  $('chatProjectName').textContent = project?.name ?? '';
  ui($('chatTitle'), 'textContent', () => summary ? summary.title || t("Untitled session") : t("New chat"));

  paintDeliveryControls(deliveryHost);
  paintAgentFilter();
  // Selection retires data/control ownership immediately, but the last painted rows
  // remain inert until the destination arrives. Queue/status repaints must not turn
  // this short loading interval into the New Chat welcome screen.
  if (selectedId !== null && detailFor !== selectedId) {
    $('inputQueue').setAttribute('inert', '');
    $('timelineEmpty').hidden = true;
    $('chatFoot').hidden = true;
    return;
  }
  $('timeline').removeAttribute('inert');
  $('timeline').removeAttribute('aria-busy');
  $('inputQueue').removeAttribute('inert');
  const filtered = visibleEvents();
  const windowed = boundedTimeline(filtered);
  const shown = windowed.shown;

  // Preserve the visible logical row when late transcript revisions change the
  // height above it; retaining absolute scrollTop would move the reader's content.
  const pane = $('chatBody');
  const restoreViewport = preserveTimelineViewport(pane, $('timeline'), followBottom);
  let restoreRichFocus: (() => void) | null = null;
  const timelineRows: HTMLElement[] = [];
  const keep = new Set<string>();
  let activityBoundary = '';
  paintRecoveryStatus();
  const oldest = shown.length ? Math.min(...shown.map(event => event.time)) : 0;
  const newest = shown.length ? Math.max(...shown.map(event => event.time)) : 0;
  const retiredInputs = pendingComposerInputs.filter(entry => historicalAutomaticInput(entry) &&
    (entry.sessionId ?? entry.deliveredSessionId) === selectedId && !inputNotices().has(entry.id) &&
    agentFilter === null && entry.createdAt >= oldest && (historyBefore === null || entry.createdAt <= newest))
    .sort((a, b) => a.createdAt - b.createdAt);
  const appendRetiredInputs = (until: number) => {
    while (retiredInputs.length && retiredInputs[0]!.createdAt <= until) {
      const entry = retiredInputs.shift()!;
      const key = `retired-input:${entry.id}`;
      const sig = JSON.stringify([entry.text, entry.error, entry.createdAt]);
      keep.add(key);
      const cached = rowCache.get(key);
      const row = cached?.sig === sig ? cached.row : inputMessageRow(deliveryHost, entry, true);
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
  const duplicateErrors = duplicateChatErrors(events);
  for (const item of timelineItems(shown)) {
    if (item.kind === 'event' && duplicateErrors.has(item.event.seq)) continue;
    appendRetiredInputs(item.kind === 'event' ? item.event.time : item.block.time);
    if (item.kind === 'compaction' || !['tool_call', 'page_tool', 'agent_message'].includes(item.event.kind)) activityBoundary = itemKey(item);
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && item.event.source === 'app' && item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
    if (!deps.state()?.config.ui.developerMode && item.kind === 'event' && ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind)) continue;
    const key = itemKey(item);
    const sig = itemSignature(item) + (item.kind === 'event' && item.event.kind === 'chat_error'
      ? JSON.stringify(chatErrorPresentation(item.event, events)) : '');
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
      // Revision cursor changes a bubble's contents, not its immutable viewport identity.
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
    row.dataset.activityBoundary = activityBoundary;
    paintInputReceipt(row, item);
    rowCache.set(key, { sig, row });
    timelineRows.push(row);
  }
  appendRetiredInputs(Infinity);
  for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);

  // The spine is a projection of recorded lineage: no handoff and no continuation origin means no
  // spine, and the transcript renders exactly as it did before this existed. A session that has
  // been compacted reads as one continuous column with a labelled frontend per run.
  //
  // It reads the session's full loaded history, not the windowed page or the filtered view: the
  // number of frontends a session has run in is a fact about the session, so it must not change as
  // the reader scrolls, and an agent filter must not erase a segment's joint.
  const spine = frontendSegments(events, summary?.origin ?? null);
  const timeline = $('timeline');
  timeline.classList.toggle('spine', spine.length > 0);
  reconcileChildren(timeline, spine.length === 0
    ? groupImageRows(groupToolRows(timelineRows))
    : withSpineSegments(groupImageRows(groupToolRows(timelineRows)), spine));
  retireStaleRichImageViewer();
  paintPendingInputs(deliveryHost);
  $('timelineEmpty').hidden = selectedId !== null || timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
  restoreViewport();
  restoreRichFocus?.();

  const facts: string[] = [];
  if (summary) {
    facts.push(t(totalEvents === 1 ? '{0} event' : '{0} events', [totalEvents]));
    if (events.length < totalEvents) facts.push(t("showing a bounded page of {0}", [events.length]));
    if (agentFilter !== null) {
      facts.push(t("filtered to {0} — {1} matched", [agentFilter === UNATTRIBUTED ? 'unattributed' : agentFilter, filtered.length]));
    }
    if (windowed.omitted > 0) facts.push(t("{0} newest rendered", [shown.length]));
    facts.push(t("~{0} rough current-chat context tokens", [compactNumber(summary.contextTokens)]));
    const level = pressureOf(pressure, summary.id);
    if (level && level.level !== 'ok') {
      facts.push(
        level.level === 'huge'
          ? t("past the compaction threshold — compact before continuing")
          : t("large — compaction is worth doing soon")
      );
    }
    if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed') {
      facts.push(t("last turn {0}", [t(TURN_OUTCOME_LABELS[summary.lastTurnOutcome])]));
    }
  }
  $('chatFoot').textContent = facts.join(' · ');
  $('chatFoot').hidden = !deps.state()?.config.ui.developerMode;
  $('chatFoot').classList.toggle('is-warn', pressureOf(pressure, selectedId ?? '')?.level === 'huge');
}

// -------------------------------------------------------------------- handoff

/**
 * The brief the last compaction of this session left behind.
 *
 * A record, not a control. The compaction itself happens in the ChatGPT conversation — the
 * chat writes its own brief as its final answer — so what is worth showing here is the
 * document that came out of it, and any warning attached to it.
 */
function paintHandoff(): void {
  const hand = $('handoffBox');
  if (handoff) {
    const saved = handoff;
    const parts: HTMLElement[] = [];
    const head = el('p', 'hint');
    ui(head, 'textContent', () => t("{0} characters · from {1} events (~{2} tokens) · {3}", [compactNumber(saved.text.length), saved.sourceEvents, compactNumber(saved.sourceTokens), ago(saved.createdAt)]));
    parts.push(head);
    for (const note of handoff.notes) parts.push(el('p', 'hint is-warn', note));
    parts.push(el('pre', 'pre', handoff.text));
    hand.replaceChildren(...parts);
    $('handoffHead').hidden = false;
    $('copyHandoff').hidden = false;
  } else {
    hand.replaceChildren();
    $('handoffHead').hidden = true;
    $('copyHandoff').hidden = true;
  }
  paintStateLine();
}

/** The live deadline takes precedence over the existing dismissible repair receipt. */
function paintRecoveryStatus(): boolean {
  const host = $('recoveryStatus');
  const countdowns = selectedId && controlledSessionId === selectedId && controlledSelection === selectionGeneration ? controlledRecovery : [];
  if (renderRecoveryCountdowns(host, countdowns)) { paintComposerStatusLine(); return true; }
  const recovery = detailFor === selectedId ? [...events].reverse().find(event => event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:')) : undefined;
  const sessionId = selectedId;
  const revision = recovery?.kind === 'progress' ? JSON.stringify([recovery.progressId, recovery.time, recovery.message.text]) : '';
  // Newer questions retire this live notice; the original receipt stays in history.
  const advanced = recovery && events.some(event => positionOf(event) > positionOf(recovery) &&
    ((event.kind === 'turn_start' && event.turnId !== recovery.turnId) ||
      (event.kind === 'user_message' && event.source === 'extension')));
  host.hidden = !recovery || !!advanced || Date.now() - recovery.time > 120000 || (!!sessionId && dismissedRecoveryNotices.get(sessionId) === revision);
  host.replaceChildren();
  if (!host.hidden && recovery?.kind === 'progress') {
    const row = el('div', 'recovery-notice');
    row.append(icon('i-pulse'), el('span', 'queue-label', recovery.message.text),
      dockAction(() => t('Dismiss recovery notice'), 'i-x', () => {
        if (sessionId) dismissedRecoveryNotices.set(sessionId, revision);
        host.hidden = true; host.replaceChildren();
      }));
    host.append(row);
  }
  paintComposerStatusLine();
  return false;
}

/** One line under the header saying what is happening right now. */
function paintStateLine(): void {
  window.clearTimeout(durationTimer);
  durationTimer = undefined;
  const note = $('chatState');
  const { tone, working, ticking } = stateLine();
  ui(note, 'textContent', () => stateLine().text);
  note.className = `subhead-note${tone ? ` ${tone}` : ''}`;
  // Running state and timer ownership cannot depend on a translated label.
  note.classList.toggle('is-working', working === true);
  const recovering = paintRecoveryStatus();
  const goalWaiting = controlledSessionId === selectedId && controlledSelection === selectionGeneration && !!goalWaitView;
  if (goalWaiting) paintGoalProgress();
  if (visible && (ticking || recovering || goalWaiting)) durationTimer = window.setTimeout(paintStateLine, 1000);
  repaintBadges(sessionHost);
}


function stateLine(): { text: string; tone: '' | 'is-live' | 'is-bad'; working?: boolean; ticking?: boolean } {
  if (!deps.state()?.config.ui.developerMode) {
    const summary = sessions.find(entry => entry.id === selectedId);
    if (!summary || detailFor !== selectedId) return { text: '', tone: '' };
    const active = controlledSessionId === selectedId && controlledSelection === selectionGeneration ? controlledTurnId : null;
    const lastBoundary = [...events].reverse().find(event => event.kind === 'turn_start' || event.kind === 'turn_end');
    const turnId = active ?? lastBoundary?.turnId;
    if (!turnId) return { text: '', tone: '' };
    const startedAt = summary.finishTurn?.turnId === turnId ? summary.finishTurn.startedAt
      : events.find(event => event.kind === 'turn_start' && event.turnId === turnId)?.time;
    const endedAt = events.find(event => event.kind === 'turn_end' && event.turnId === turnId)?.time;
    if (startedAt === undefined) return { text: active ? t("Working…") : '', tone: '', working: !!active };
    if (!active && endedAt === undefined) return { text: '', tone: '' };
    const seconds = Math.max(0, Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000));
    return { text: t("{0} for {1}{2}s", [active ? t("Working") : t("Worked"), seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : '', seconds % 60]), tone: '', working: !!active, ticking: !!active };
  }
  // Recording follows the conversation the browser can see. A tool call arrives over the
  // connector carrying nothing that identifies its caller, so work driven from the phone,
  // from another browser or from another machine can only be recorded as what it is:
  // real, complete, and not placeable in any chat this app can observe.
  const selected = sessions.find((entry) => entry.id === selectedId) ?? null;
  if (selected && selected.conversationId === null) {
    return {
      text: t("Work this app could not place in a chat — driven from another device, or with no ChatGPT tab open"),
      tone: ''
    };
  }

  const workers = swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
  if (workers.length === 0) return { text: '', tone: '' };
  const count = (state: AgentState): number => workers.filter((agent) => agent.state === state).length;
  const parts: string[] = [];
  if (count('active') > 0) parts.push(t("{0} working", [count('active')]));
  // "invited" is a worker whose ChatGPT tab has been asked for but has not joined yet.
  if (count('invited') > 0) parts.push(t("{0} opening", [count('invited')]));
  // Detached is a live worker with no tab: its turn is running on OpenAI's servers and its
  // tool calls still arrive here, so it is counted among the working rather than the lost.
  if (count('detached') > 0) parts.push(t("{0} working with no tab", [count('detached')]));
  if (count('waking') > 0) parts.push(t("{0} waking up", [count('waking')]));
  // Said as "waiting" rather than counted with the finished ones: these are the run's reusable
  // chats, and the number the user wants is how much of the run is still available to it.
  if (count('sleeping') > 0) parts.push(t("{0} sleeping", [count('sleeping')]));
  if (count('finished') > 0) parts.push(t("{0} finished", [count('finished')]));
  if (count('failed') > 0) parts.push(t("{0} failed", [count('failed')]));
  const live = count('invited') + count('active') + count('detached') + count('waking');
  return {
    text: `${workers.length === 1 ? t("1 worker") : t("{0} workers", [workers.length])} · ${parts.join(' · ')}`,
    tone: count('failed') > 0 ? 'is-bad' : live > 0 ? 'is-live' : ''
  };
}

// ----------------------------------------------------------------- settings

/**
 * Shows where the extension actually is on this machine.
 *
 * An installed build has no source tree, so "load extension/ from the repo" is advice
 * that cannot be followed. Asked once and cached, because the answer cannot change while
 * the app is running.
 */
let extensionPathShown = false;
async function showExtensionPath(): Promise<void> {
  if (extensionPathShown) return;
  extensionPathShown = true;
  const dir = await run(api.extensionPath());
  const node = $('extensionPath');
  if (dir) {
    ui(node, 'textContent', () => t("Extension folder: {0}", [dir]));
    node.classList.remove('is-warn');
  } else {
    ui(node, 'textContent', () => t("The extension folder is missing from this installation. Reinstall the app, or use the extension/ folder from a source checkout."));
    node.classList.add('is-warn');
    $<HTMLButtonElement>('bridgeFolder').disabled = true;
  }
}

function paintSwarm(state: SwarmState): void {
  swarm = state;
  paintStateLine();
  // Session rows borrow their live badge from the swarm, so a worker that just went to sleep
  // must not keep saying "active" until some unrelated session update repaints the list.
  paintSessions(sessionHost);
  const list = $('swarmList');
  if (state.agents.length === 0) {
    list.replaceChildren(
      el(
        'p',
        'hint',
        () => state.retainedHistory
          ? t("No workers are running. Reusable worker histories are parked and remain available to their prime chats; Clear swarm permanently removes them.")
          : t("No agents. The prime agent creates workers with the agents tool’s spawn action.")
      )
    );
  } else {
    list.replaceChildren(
      ...state.agents.map((agent) => {
        const row = el('div', 'agent');
        const top = el('div', 'model-top');
        const label = agent.label || agent.id;
        top.append(el('b', '', label));
        if (label !== agent.id) top.append(el('span', 'chip', agent.id));
        top.append(el('span', `chip is-${agent.state}`, agent.state));
        // Clearing is offered where the agent is, not only as one global reset at the
        // bottom of a settings form. The two rows mean different things and the tooltip
        // says which: the prime is the run, a worker is one slot.
        const over = agent.state === 'finished' || agent.state === 'failed';
        if (!over) {
          const clear = el('button', 'btn btn-quiet agent-clear');
          clear.append(icon('i-x'));
          clear.dataset.clear = agent.id;
          if (agent.runId) clear.dataset.runId = agent.runId;
          ui(clear, 'title', () => agent.role === 'prime'
              ? t("Clear session — ends this run and every worker in it")
              : t("Clear session — ends {0} and frees its slot", [agent.id]));
          top.append(clear);
        }
        const sub = el('div', 'model-sub');
        const bits = [t("{0} pending", [agent.pending]), t("{0} delivered", [agent.delivered])];
        if (agent.conversationId) bits.push(t("chat bound"));
        sub.textContent = bits.join(' · ');
        row.append(top, sub);
        if (agent.task) row.append(el('p', 'hint', agent.task));
        // Why it failed, not just that it did. A worker only reaches this state when its
        // chat could not be opened, and the reason is the only actionable part.
        if (agent.state === 'failed' && agent.result) row.append(el('p', 'hint is-warn', agent.result));
        return row;
      })
    );
  }
  // Usable whenever there is a run to clear, not only while a worker is still going.
  // Gating on `running` left finished-but-present swarm state with no way out, which is
  // exactly the state a user wants to clear before starting the next run.
  $<HTMLButtonElement>('swarmReset').disabled = state.agents.length === 0 && state.retainedHistory !== true;
}

/**
 * The meter's red line, derived from the one threshold the user actually sets.
 *
 * There used to be three numbers for one quantity — "suggest at", "urgent at" and
 * "compact at" — all measured in the same local estimate and all editable apart. That is
 * three ways to describe one line, and they drifted: a meter could sit red for an hour on
 * a chat whose automatic trigger was set far higher, or fill only halfway on the turn that
 * compaction actually fired. The threshold is now the amber line by definition, and the red
 * line sits a third further on, which is the relation the app's own defaults have always
 * carried (300k → 400k when the threshold was 300k; 400k → 533k now).
 */
function urgentFrom(threshold: number): number {
  return Math.min(4_000_000, Math.max(10_000, Math.round((threshold * 4) / 3)));
}

/** Reads the three config sections this panel owns, for the renderer's save path. */
export function chatSettingsPatch(current: Config): {
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  goal: Config['goal'];
  mcp: Config['mcp'];
} {
  const number = (id: string, fallback: number, min: number, max: number): number => {
    const raw = Number($<HTMLInputElement>(id).value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.round(raw)));
  };
  const threshold = number('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000);
  return {
    sessions: {
      record: $<HTMLInputElement>('sessRecord').checked,
      retainDays: 0,
      // Both follow the single threshold above rather than being typed separately.
      advisoryTokens: threshold,
      limitTokens: urgentFrom(threshold)
    },
    compaction: {
      auto: $<HTMLInputElement>('autoCompact').checked,
      autoTokens: threshold
    },
    multiAgent: {
      defaultModel: $<HTMLSelectElement>('workerModel').value,
      defaultReasoning: $<HTMLSelectElement>('workerReasoning').value as Config['multiAgent']['defaultReasoning'],
      // The exposure switch lives with every other ChatGPT tool switch, on Home. This
      // panel keeps only the worker count, so it reads the one control that exists.
      enabled: $<HTMLInputElement>('homeMaEnabled').checked,
      maxWorkers: number('maWorkers', current.multiAgent.maxWorkers, 1, 8),
      allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
      recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked
    },
    goal: {
      enabled: current.goal.enabled, mode: current.goal.mode,
      includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked,
      backend: $<HTMLSelectElement>('goalBackend').value as Config['goal']['backend'],
      loopBackend: $<HTMLSelectElement>('loopBackend').value as Config['goal']['loopBackend'],
      helperModel: $<HTMLSelectElement>('helperModel').value || current.goal.helperModel || 'gpt-5.6-sol',
      helperReasoning: ($<HTMLSelectElement>('helperReasoning').value || current.goal.helperReasoning || 'high') as Config['goal']['helperReasoning'],
      provider: {
        kind: ($<HTMLSelectElement>('goalProvider').value || current.goal.provider?.kind || 'openrouter') as Config['goal']['provider']['kind'],
        baseUrl: $<HTMLInputElement>('goalBaseUrl').value
      },
      // The api-backend model is picked from the catalogue and never typed, except on a
      // custom endpoint whose id is typed in its own field instead. `current` is the
      // fallback for the first save after a repaint.
      model:
        $<HTMLSelectElement>('goalProvider').value === 'custom'
          ? $<HTMLInputElement>('goalCustomModel').value.trim() || current.goal.model
          : goalModel || current.goal.model,
      reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
      // Blank means "restore the safe default", not "send an unconstrained system message".
      prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
      objectivePrompt:
        $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() ||
        DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
      loopPrompt:
        $<HTMLTextAreaElement>('goalLoopPrompt').value.trim() || DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
    },
    // The retired editor no longer owns this stored configuration.
    mcp: current.mcp ?? { instructions: '' }
  };
}

// --------------------------------------------------------------- the goal loop

/**
 * The OpenRouter model this panel currently has chosen.
 *
 * Kept beside the controls rather than in one, because the picker is a list that is not
 * loaded most of the time: an `<input>` would have to hold an id nobody typed, and a
 * `<select>` would have to hold several hundred options nobody asked for.
 */
let goalModel = DEFAULT_GOAL_MODEL;
/** The catalogue as far as it has been paged in, and how long it actually is. */
let goalModels: GoalModel[] = [];
let selectedGoalModel: GoalModel | undefined;
let goalCatalogEpoch = 0;
let goalTotal = 0;
let goalLoading = false;

function invalidateGoalModels(): void {
  goalCatalogEpoch++;
  goalModels = [];
  selectedGoalModel = undefined;
  goalTotal = 0;
}

function paintGoalReasoning(selected?: Config['goal']['reasoning'], changingModel = false): void {
  const select = $<HTMLSelectElement>('goalReasoning');
  const model = goalModels.find(model => model.id === goalModel) ?? (selectedGoalModel?.id === goalModel ? selectedGoalModel : undefined);
  const custom = $<HTMLSelectElement>('goalProvider').value === 'custom';
  renderGoalReasoning(select, custom ? undefined : model, custom,
    selected ?? (select.value || 'default') as Config['goal']['reasoning'], changingModel);
}

/** The release date OpenRouter publishes, as a person would date a model. */
function releasedOn(created: number): string {
  if (!created) return t("release date not published");
  return new Date(created * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Loads the next twenty models, newest first.
 *
 * Paged rather than fetched whole because the catalogue is several hundred entries long and
 * the question this list answers — what is new — is answered by the first screen of it.
 */
async function loadGoalModels(reset: boolean): Promise<void> {
  if (goalLoading) return;
  goalLoading = true;
  if (reset) {
    invalidateGoalModels();
  }
  const epoch = goalCatalogEpoch;
  ui($('goalModelsState'), 'textContent', () => t("Loading models from OpenRouter…"));
  $<HTMLButtonElement>('goalMore').disabled = true;
  const page = await run(api.listGoalModels(goalModels.length));
  goalLoading = false;
  if (epoch !== goalCatalogEpoch) return;
  if (!page) {
    // `run` has already shown the reason. Say what it means *here*: the list is empty and
    // the model in use has not changed.
    ui($('goalModelsState'), 'textContent', () => t("OpenRouter could not be reached. The model in use is unchanged."));
    $<HTMLButtonElement>('goalMore').disabled = goalModels.length === 0;
    return;
  }
  goalModels = [...goalModels, ...page.models];
  selectedGoalModel = page.selectedModel;
  goalTotal = page.total;
  paintGoalReasoning();
  paintGoalModels();
}

function paintGoalModels(): void {
  const list = $('goalModelList');
  // Emptying an element scrolls it back to the top, and this repaints the whole list every
  // time a page lands. Without holding the offset, paging in the next twenty threw the
  // reader back to the newest model — which is the one place they had already decided
  // against by scrolling away from it.
  const keep = list.scrollTop;
  list.textContent = '';
  for (const model of goalModels) {
    const row = el('button', 'goal-model');
    row.setAttribute('type', 'button');
    row.dataset.model = model.id;
    if (model.id === goalModel) row.dataset.chosen = '1';
    row.append(el('b', 'goal-model-name', model.name));
    const meta = [releasedOn(model.created), model.contextLength > 0 ? t("{0} ctx", [compactNumber(model.contextLength)]) : '']
      .filter(Boolean)
      .join(' · ');
    row.append(el('em', 'goal-model-meta', `${model.id} · ${meta}`));
    list.append(row);
  }
  const shown = goalModels.length;
  ui($('goalModelsState'), 'textContent', () => shown === 0 ? t("No models came back.") : t("Showing the {0} newest of {1}, newest release first.", [shown, goalTotal]));
  $<HTMLButtonElement>('goalMore').disabled = shown >= goalTotal;
  $<HTMLButtonElement>('goalMore').hidden = shown >= goalTotal;
  list.scrollTop = keep;
  // A page that did not fill the box leaves nothing to scroll, so the scroll handler can
  // never fire and the list would stop at twenty with more still to come. Ask again here.
  maybePageGoalModels();
}

/**
 * Pages the catalogue in as the list is scrolled.
 *
 * "Load 20 more" is the deliberate way to ask; scrolling to the bottom is the way people
 * actually ask. It fires a screenful early rather than at the exact bottom, so the next
 * twenty are usually already in place by the time the scroll arrives where they go.
 */
function maybePageGoalModels(): void {
  if (goalLoading || goalModels.length === 0 || goalModels.length >= goalTotal) return;
  const list = $('goalModelList');
  // A closed picker measures zero in every direction, which reads as "scrolled to the end"
  // and would page the whole catalogue in behind a panel nobody has open.
  if (list.clientHeight === 0) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight > GOAL_SCROLL_MARGIN) return;
  void loadGoalModels(false);
}

/** Keep an in-progress form edit when an unrelated main-process push carries the old value. */
function applyChatValue(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
  previous: string | number | undefined
): void {
  if (document.activeElement === input && previous !== undefined && input.value !== String(previous)) return;
  input.value = value;
}

/** Checkbox counterpart to applyChatValue. */
function applyChatChecked(input: HTMLInputElement, value: boolean, previous: boolean | undefined): void {
  if (document.activeElement === input && previous !== undefined && input.checked !== previous) return;
  input.checked = value;
}

/** Writes the goal block from app state. Called from chatApply, so it never guesses. */
function applyGoal(state: AppState, previous?: Config): void {
  const { config } = state;
  applyChatChecked($<HTMLInputElement>('goalIncludeToolCalls'), config.goal.includeToolCalls === true, previous?.goal.includeToolCalls);
  const automation = $<HTMLSelectElement>('chatAutomation');
  automation.disabled = false;
  ui(automation, 'title', () => t("Continue this chat automatically"));
  paintAutomationSwitch();
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  // This picker owns the last known OpenRouter selection. A custom deployment uses
  // its own input and must not replace that selection during an unrelated repaint.
  // A session opened directly on custom starts with the picker's defined default.
  if (config.goal.provider?.kind !== 'custom') goalModel = config.goal.model;
  const reasoningSelect = $<HTMLSelectElement>('goalReasoning');
  const reasoning = document.activeElement === reasoningSelect && previous && reasoningSelect.value !== previous.goal.reasoning
    ? reasoningSelect.value as Config['goal']['reasoning'] : config.goal.reasoning;
  if (previous && JSON.stringify(previous.goal.provider) !== JSON.stringify(config.goal.provider)) invalidateGoalModels();
  applyChatValue($<HTMLTextAreaElement>('goalPrompt'), config.goal.prompt, previous?.goal.prompt);
  applyChatValue(
    $<HTMLTextAreaElement>('goalObjectivePrompt'),
    config.goal.objectivePrompt,
    previous?.goal.objectivePrompt
  );
  applyChatValue(
    $<HTMLTextAreaElement>('goalLoopPrompt'),
    config.goal.loopPrompt,
    previous?.goal.loopPrompt
  );
  // Which endpoint the api backend talks to. The key sentence below only applies to
  // OpenRouter: a custom endpoint is often keyless, so a missing key never means custom.
  const customProvider = config.goal.provider?.kind === 'custom';
  const providerBaseUrl = config.goal.provider?.baseUrl ?? '';
  applyChatValue($<HTMLSelectElement>('goalProvider'), customProvider ? 'custom' : 'openrouter', previous?.goal.provider?.kind);
  applyChatValue($<HTMLInputElement>('goalBaseUrl'), providerBaseUrl, previous?.goal.provider?.baseUrl);
  applyChatValue($<HTMLInputElement>('goalCustomModel'), config.goal.model, previous?.goal.model);
  $('goalCustomPanel').hidden = !customProvider;
  $('goalPickerRow').hidden = customProvider;
  if (customProvider) $('goalModels').hidden = true;
  $('goalKeyField').hidden = customProvider;
  $('goalModelName').textContent = config.goal.model;
  const goalKey = $<HTMLInputElement>('goalKey');
  ui(goalKey, 'placeholder', () => state.hasGoalKey ? t("•••••••• stored") : 'sk-or-v1-…');
  goalKey.disabled = !secureStorageAvailable;
  ui($('goalKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasGoalKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply."));
  $('goalKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalKeyRemove').disabled = !state.hasGoalKey || !secureStorageAvailable;
  const goalCustomKey = $<HTMLInputElement>('goalCustomKey');
  ui(goalCustomKey, 'placeholder', () => state.hasCustomProviderKey ? t("•••••••• stored") : t("leave empty for a keyless local server"));
  goalCustomKey.disabled = !secureStorageAvailable;
  ui($('goalCustomKeyState'), 'textContent', () => !secureStorageAvailable
    ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable."))
    : state.hasCustomProviderKey
      ? t("A key is stored with secure OS credential storage. Type a new one to replace it.")
      : t("Optional. Stored with secure OS credential storage and sent only by the app to your configured API endpoint. The browser receives only the reply."));
  $('goalCustomKeyState').classList.toggle('is-warn', !secureStorageAvailable);
  $<HTMLButtonElement>('goalCustomKeyRemove').disabled = !state.hasCustomProviderKey || !secureStorageAvailable;
  paintGoalReasoning(reasoning);
  if (goalModels.length > 0) paintGoalModels();
}

function wireGoal(save: () => Promise<void>): void {
  $<HTMLTextAreaElement>('goalPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalPromptEdit').addEventListener('click', () => {
    const panel = $('goalPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalPrompt').focus();
  });
  $('goalPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalPrompt').value = DEFAULT_GOAL_SYSTEM_PROMPT;
    await save();
    toast('Goal prompt (no task) restored to default');
  });
  $<HTMLTextAreaElement>('goalObjectivePrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalObjectivePromptEdit').addEventListener('click', () => {
    const panel = $('goalObjectivePromptPanel');
    panel.hidden = !panel.hidden;
    $('goalObjectivePromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalObjectivePrompt').focus();
  });
  $('goalObjectivePromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalObjectivePrompt').value = DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
    await save();
    toast('Goal prompt (with a task) restored to default');
  });
  $<HTMLTextAreaElement>('goalLoopPrompt').maxLength = MAX_GOAL_SYSTEM_PROMPT_CHARS;
  $('goalLoopPromptEdit').addEventListener('click', () => {
    const panel = $('goalLoopPromptPanel');
    panel.hidden = !panel.hidden;
    $('goalLoopPromptEdit').textContent = panel.hidden ? 'Edit prompt' : 'Close prompt';
    if (!panel.hidden) $<HTMLTextAreaElement>('goalLoopPrompt').focus();
  });
  $('goalLoopPromptReset').addEventListener('click', async () => {
    $<HTMLTextAreaElement>('goalLoopPrompt').value = DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
    await save();
    toast('Loop prompt restored to default');
  });
  // The catalogue is fetched on the first press and kept afterwards: the picker closing is
  // not a reason to spend another round trip on a list that changes weekly.
  $('goalPick').addEventListener('click', () => {
    const panel = $('goalModels');
    panel.hidden = !panel.hidden;
    $('goalPick').textContent = panel.hidden ? 'Select model' : 'Close';
    if (!panel.hidden && goalModels.length === 0) void loadGoalModels(true);
  });
  $('goalMore').addEventListener('click', () => void loadGoalModels(false));
  $('goalReasoning').addEventListener('focus', () => {
    if ($<HTMLSelectElement>('goalProvider').value !== 'custom' && !goalModels.some(model => model.id === goalModel) && selectedGoalModel?.id !== goalModel)
      void loadGoalModels(true);
  });
  $('goalModelList').addEventListener('scroll', maybePageGoalModels);
  $('goalModelList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-model]');
    if (!row?.dataset.model) return;
    goalModel = row.dataset.model;
    $('goalModelName').textContent = goalModel;
    paintGoalReasoning(undefined, true);
    paintGoalModels();
    void save();
    toast(`Goal model set to ${goalModel}`);
  });
  // On blur, like every other key in this app: not saved keystroke by keystroke, and the
  // field is emptied the moment it has been handed over.
  $('goalKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalKey');
    const submitted = input.value;
    const key = submitted.trim();
    // Whitespace is not a key. Passing it through trim as an empty string used to invoke the
    // remove-key path and then claim a key was stored.
    if (key === '') return;
    const next = await run(api.setGoalKey(key));
    if (next) {
      invalidateGoalModels();
      // A blur can be followed immediately by refocus + new typing while IPC is in flight.
      // Clear only the exact value that successfully crossed the secret-store boundary.
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('OpenRouter key stored');
    }
  });
  $('goalKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setGoalKey(''));
    if (next) {
      invalidateGoalModels();
      applyGoal(next);
      toast('OpenRouter key removed');
    }
  });
  // Same blur-to-save discipline as the OpenRouter key above. Empty submits nothing:
  // a keyless local endpoint is a supported configuration, not a key being removed.
  $('goalCustomKey').addEventListener('blur', async () => {
    const input = $<HTMLInputElement>('goalCustomKey');
    const submitted = input.value;
    const key = submitted.trim();
    if (key === '') return;
    const next = await run(api.setCustomProviderKey(key));
    if (next) {
      if (input.value === submitted) input.value = '';
      applyGoal(next);
      toast('Custom provider key stored');
    }
  });
  $('goalCustomKeyRemove').addEventListener('click', async () => {
    const next = await run(api.setCustomProviderKey(''));
    if (next) {
      applyGoal(next);
      toast('Custom provider key removed');
    }
  });
}

/**
 * One clause under the row, not a paragraph: what the switch will do, and the fact that
 * the number it fires on is this app's own estimate rather than ChatGPT's accounting.
 */
function applyAutoCompactHint(config: Config): void {
  ui($('autoCompactHint'), 'textContent', () => config.compaction.auto
    ? t("Interrupts an active answer at this many tokens, writes a handoff, and opens a fresh chat.")
    : t("Off — only the Compact & resume button in the ChatGPT tab compacts."));
}

/**
 * Every control on the settings sheet, and the whole of it.
 *
 * A field that is not here does not save: it keeps what was typed until the next repaint
 * and then quietly reverts. `autoCompactTokens` was missing, which made the one number the
 * automatic trigger fires on the one control in the app that never kept what you typed.
 * Age retention is absent because history does not expire by age.
 */
const CHAT_INPUTS = [
  'chatBrowser',
  'sessRecord',
  'goalIncludeToolCalls',
  'planBackend',
  'finishTool', 'finishLeadMinutes', 'workerModel', 'workerReasoning', 'backgroundChats', 'browserOnly', 'autoRefreshPlugins',
  'goalBackend',
  'loopBackend',
  'helperModel', 'helperReasoning',
  'autoCompact',
  'autoCompactTokens',
  'maWorkers',
  'allowUnattributedCalls',
  'recoverAgentTabs',
  'autoContinue',
  'goalProvider',
  'goalBaseUrl',
  'goalCustomModel',
  'goalReasoning',
  'goalPrompt',
  'goalObjectivePrompt',
  'goalLoopPrompt'
];

/** Writes app state into this panel's controls. Called from the renderer's apply(). */
export function chatApply(state: AppState, previous?: Config): void {
  const { config, bridge } = state;
  if (visible && selectedId) void refreshSessionControls();
  paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  applyChatModels(config, previous);

  applyChatChecked($<HTMLInputElement>('sessRecord'), config.sessions.record, previous?.sessions.record);
  applyChatChecked($<HTMLInputElement>('autoCompact'), config.compaction.auto, previous?.compaction.auto);
  applyChatValue(
    $<HTMLInputElement>('autoCompactTokens'),
    String(config.compaction.autoTokens),
    previous?.compaction.autoTokens
  );
  applyAutoCompactHint(config);

  applyChatValue($<HTMLInputElement>('maWorkers'), String(config.multiAgent.maxWorkers), previous?.multiAgent.maxWorkers);
  applyChatChecked(
    $<HTMLInputElement>('allowUnattributedCalls'),
    config.multiAgent.allowUnattributedCalls,
    previous?.multiAgent.allowUnattributedCalls
  );
  applyChatChecked(
    $<HTMLInputElement>('recoverAgentTabs'),
    config.multiAgent.recoverAgentTabs,
    previous?.multiAgent.recoverAgentTabs
  );

  applyChatValue($<HTMLSelectElement>('workerModel'), config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel);
  applyChatValue($<HTMLSelectElement>('workerReasoning'), config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning);
  applyChatValue($<HTMLSelectElement>('goalBackend'), config.goal.backend ?? 'chatgpt', previous?.goal.backend);
  applyChatValue($<HTMLSelectElement>('loopBackend'), config.goal.loopBackend ?? 'chatgpt', previous?.goal.loopBackend);
  applyChatValue($<HTMLSelectElement>('helperModel'), config.goal.helperModel ?? 'gpt-5.6-sol', previous?.goal.helperModel);
  applyChatValue($<HTMLSelectElement>('helperReasoning'), config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning);
  applyGoal(state, previous);

  // Extension bridge. Connecting is automatic, so this reports rather than asks.
  const browserRequired = browserExtensionRequired(config);
  $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
  const secureStorageAvailable = state.secureStorage?.available ?? true;
  ui($('bridgeState'), 'textContent', () => !browserRequired
    ? t("Browser-backed features are off. The extension is not needed right now.")
    : !secureStorageAvailable
      ? (state.secureStorage?.detail ?? t("Secure credential storage is unavailable, so the extension cannot pair safely."))
    : !bridge.running
      ? t("The local bridge is off even though browser-backed features need it.")
      : bridge.present
        ? t("Connected. Listening on 127.0.0.1:{0} · last message {1}.", [bridge.port ?? '?', ago(bridge.lastSeenAt)])
        : bridge.paired
          ? t("Authorized, but the browser extension is not currently connected. {0}", [bridge.lastSeenAt === null ? t("It has not checked in since this app started.") : t("Last seen {0}.", [ago(bridge.lastSeenAt)])])
          : t("Listening on 127.0.0.1:{0} · no browser is authorized or connected yet.", [bridge.port ?? '?']));
  $('bridgeState').classList.toggle('is-warn', browserRequired && (!bridge.present || !secureStorageAvailable));
  void showExtensionPath();

  if (sessions.length > 0) paintSessions(sessionHost);
}

/** Called when the Chat tab becomes visible or is left, so it only polls when shown. */
export function chatVisible(next: boolean): void {
  if (visible === next) return;
  visible = next;
  reportVisibleSelection(next && selectedId !== null);
  if (next) void refreshAll();
  else {
    window.clearTimeout(toolActivityTimer);
    window.clearTimeout(durationTimer);
    toolActivityTimer = undefined;
  }
}

async function refreshAll(): Promise<void> {
  await loadSessions();
  const swarmNow = await run(api.getSwarm());
  if (swarmNow) paintSwarm(swarmNow);
}

/** Sessions change on every recorded event, so the reload is coalesced. */
function scheduleReload(): void {
  if (!visible) return;
  // One refresh owns the timer until its asynchronous read completes. Starting a
  // newer read every 400 ms can invalidate every result on a busy/slower store.
  if (listTimer !== undefined) { listRefreshDirty = true; return; }
  listTimer = window.setTimeout(() => {
    listRefreshDirty = false;
    void loadSessions().finally(() => {
      listTimer = undefined;
      if (listRefreshDirty) scheduleReload();
    });
  }, 400);
}



/** Local admission moves the draft; a native receipt alone may mark it sent. */

async function stopCurrentTurn(): Promise<void> {
  const id = selectedId, turnId = controlledTurnId, generation = selectionGeneration;
  if (!id || controlledSessionId !== id || controlledSelection !== generation || !turnId || controlledStopPending) return;
  controlledStopPending = true; paintDeliveryControls(deliveryHost);
  try { await run(api.stopSessionTurn(id, turnId)); }
  finally { if (selectedId === id && selectionGeneration === generation) { controlledStopPending = false; void refreshSessionControls(); } }
}
let composerDiscoveryGeneration = 0;
async function sendComposer(delivery?: 'finish', plan?: string[], planObjective?: string): Promise<boolean | void> {
  const input = $<HTMLTextAreaElement>('chatInput');
  const key = draftKey();
  const projectId = selectedId ? sessions.find(row => row.id === selectedId)?.projectId ?? null : selectedProjectId;
  const images = imageDrafts.get(key) ?? [];
  const text = plan?.[0] ?? (authoredComposerText().trim() || (images.length ? 'Please look at the attached files.' : ''));
  if ($<HTMLButtonElement>('chatSend').disabled) return;
  if (!text) {
    const target = selectedId, selection = selectionGeneration;
    const sameSelection = () => selectedId === target && selectionGeneration === selection;
    await refreshSessionControls();
    if (!sameSelection()) return;
    // An actual turn takes precedence over queued follow-ups. Stop never silently
    // becomes cancellation of a different pending input in that same chat.
    if (target && controlledSessionId === target && controlledSelection === selection && controlledTurnId) {
      await stopCurrentTurn(); return;
    }
    const pending = pendingComposerInput(deliveryHost);
    if (pending && ['queued', 'browser'].includes(pending.state)) {
      const wasStarting = deliveryHost.startingInputs().has(pending.id);
      if (wasStarting) cancelledStarts.add(pending.id);
      const cancelled = await run(api.cancelInput(pending.id));
      if (cancelled) {
        deliveryHost.startingInputs().delete(pending.id);
        pendingComposerInputs = pendingComposerInputs.filter(row => row.id !== pending.id);
        dismissInputNotice(deliveryHost, pending.id);
        paintDeliveryControls(deliveryHost);
      } else {
        cancelledStarts.delete(pending.id);
        if (sameSelection()) { await refreshSessionControls(); if (sameSelection()) await stopCurrentTurn(); }
      }
      void refreshInputQueue(deliveryHost);
    }
    return;
  }
  const discoveryGeneration = ++composerDiscoveryGeneration;
  const discoverySelection = selectionGeneration, discoverySession = selectedId, discoveryDraft = authoredComposerText();
  const modelSettings = confirmedComposerModel() ?? await ensureComposerModel();
  // Discovery can outlive navigation or draft edits. Only the latest unchanged
  // authored send may continue; a second click must never send the same text twice.
  if (discoveryGeneration !== composerDiscoveryGeneration || discoverySelection !== selectionGeneration || discoverySession !== selectedId ||
      authoredComposerText() !== discoveryDraft || (imageDrafts.get(key) ?? []).some((image, index) => image !== images[index]) ||
      (imageDrafts.get(key)?.length ?? 0) !== images.length) return false;
  if (!modelSettings) { toast(t("Model discovery could not confirm your selection. Choose an available model and thinking effort, then send again.")); return false; }
  const sessionId = selectedId;
  const generation = selectionGeneration;
  const chosenMode = delivery ?? $<HTMLSelectElement>('sendMode').value;
  const mode = chosenMode === 'tool' ? 'auto' : chosenMode === 'after-turn' && controlledSessionId === selectedId && controlledSelection === selectionGeneration && controlledQueueAtFinish ? 'finish' : chosenMode;
  const dueAt = Date.now();
  const id = crypto.randomUUID();
  const authoredDraft = authoredComposerText();
  const attachmentPayload = { images: images.filter((file): file is InputImage => 'dataUrl' in file), attachments: images.filter((file): file is InputAttachment => 'id' in file),
    ...(chosenMode === 'tool' && !plan ? { delivery: 'tool' as const } : {}),
    ...(mode === 'auto' && !plan && selectedId && controlledSessionId === selectedId && controlledSelection === generation &&
      controlledCanInject && images.some(file => 'id' in file) && injectableAttachments(images) ? { attachmentDelivery: 'tool' as const } : {}) };
  const objective = plan ? planObjective : mode === 'finish' ? undefined : $<HTMLTextAreaElement>('sessionObjective').value.trim() || undefined;
  const authoredSource = plan ? 'objective' as const : 'text' as const;
  deliveryHost.startingInputs().set(id, { id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn',
    dueAt, ...modelSettings, state: 'queued', owner: null, createdAt: dueAt, conversationId: null });
  replaceComposerDraft();
  input.value = ''; inputDrafts.delete(key);
  skillPicker?.restore();
  imageDrafts.delete(key); paintComposerImages(deliveryHost);
  if (sessionId === null) pendingNewInput = { id, generation };
  void refreshInputQueue(deliveryHost);
  paintDeliveryControls(deliveryHost);
  try {
    const result = await run(api.sendInput({ id, sessionId, projectId, text, ...attachmentPayload, stages: plan?.slice(1), objective, authoredSource, automation: mode === 'finish' ? undefined : $<HTMLSelectElement>('chatAutomation').value as InputAutomation, loopAfterTurn: openingLoopDelivery(), mode: mode === 'finish' ? 'finish' : mode === 'auto' ? 'auto' : 'after-turn', dueAt, ...modelSettings }));
    if (cancelledStarts.has(id)) return;
    if (!result) {
      // A disk failure after outbox commit still owns this input. Keep its exact
      // queue/error visible rather than restoring a second copy into the composer.
      const retained = (await run(api.listInputs()))?.find(row => row.id === id);
      if (retained) {
        pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== id), retained];
        await adoptAcceptedOpening(deliveryHost, retained);
        return true;
      }
      if (selectedId === sessionId && selectionGeneration === generation && !authoredComposerText()) {
        inputDrafts.set(key, authoredDraft); input.value = authoredDraft; skillPicker?.restore();
      }
      else if (!inputDrafts.get(key)) inputDrafts.set(key, authoredDraft);
      if (images.length) imageDrafts.set(key, [...images, ...(imageDrafts.get(key) ?? [])]);
      if (draftKey() === key) paintComposerImages(deliveryHost);
      if (pendingNewInput?.id === id) pendingNewInput = null;
      return;
    }
    // The accepted IPC result is newer than any queue read started before it. Keep
    // that durable row visible while the next listing crosses the process boundary.
    inputQueueGeneration++;
    pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== result.id), result];
    if (sessionId === null && selectionGeneration === generation && pendingNewInput?.id === id && result.automation &&
        ($<HTMLSelectElement>('chatAutomation').value !== result.automation || openingLoopDelivery() !== result.loopAfterTurn))
      await run(api.setInputAutomation(result.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, openingLoopDelivery()));
    if (sessionId === null && selectionGeneration === generation) {
      pendingNewInput = { id: result.id, generation };
      await adoptAcceptedOpening(deliveryHost, result);
    }
    $('composerStatus').textContent = '';
    void refreshInputQueue(deliveryHost);
    return true;
  } finally { cancelledStarts.delete(id); deliveryHost.startingInputs().delete(id); paintDeliveryControls(deliveryHost); void refreshInputQueue(deliveryHost); }
}

// ------------------------------------------------------------------- wiring

/**
 * Switches the session card's body.
 *
 * Settings is reachable only from the gear, so it is deliberately not one of the switcher
 * buttons: while it is open no switcher button is selected, and the gear itself carries
 * the selected state instead. That is what keeps a property sheet from reading as a third
 * view of this session.
 */
export function openChatView(name: string): void {
  showView(name);
}

function showView(name: string): void {
  if (currentChatView !== name) {
    currentChatView = name;
    reportVisibleSelection();
  }
  $('composer').hidden = name === 'settings';
  $('composerDock').hidden = name === 'settings';
  $('inputQueue').hidden = name !== 'timeline';
  for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-sel', button.dataset.view === name);
  }
  for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
    view.hidden = view.dataset.view !== name;
  }
  $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
  // The Skills list describes what is on disk, and opening the sheet is when the user is asking
  // about it. Reading it here rather than at startup keeps a filesystem scan off the launch path
  // for a page most launches never open, and a reopening always shows current truth rather than
  // whatever was true when the window appeared.
  if (name === 'settings') { skillsLibraryLoaded = true; void skillsLibrary?.refresh(); }
}

function selectSession(id: string): void {
  retireRichImageViewer();
  const ownerChanged = id !== selectedId;
  rememberDraft();
  selectionGeneration++; replaceComposerDraft();
  inputQueueGeneration++;
  $('finishQueue').replaceChildren(); $('finishQueue').hidden = true;
  newChatSelected = false;
  selectedId = id;
  reportVisibleSelection(true);
  const selected = sessions.find(row => row.id === id);
  applyComposerSessionModel(`${id}:${selectionGeneration}`, composerSessionSelection(selected) ?? null);
  const parent = selected?.origin?.kind === 'worker' ? selected.origin.fromSessionId : null;
  if (parent) expandedWorkers.add(parent);
  selectedProjectId = projectGroup(projects, parent ? sessions.find(row => row.id === parent)?.projectId : selected?.projectId);
  if (selectedProjectId) expandedProjects.add(selectedProjectId);
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => t("Ask anything…"));
  restoreDraft();
  if (ownerChanged) {
    // Retire the prior owner now; retain only its inert painted transcript until the
    // selected detail arrives. Existing async image/load generation fences still apply.
    events = [];
    totalEvents = 0;
    historyBefore = null;
    detailFor = null;
    detailCursor = null;
    forgetTimelineRows();
    $('timeline').setAttribute('inert', '');
    $('timeline').setAttribute('aria-busy', 'true');
    handoff = null;
    handoffFor = null;
    handoffLoadGeneration++;
  }
  paintSessions(sessionHost);
  if (ownerChanged) {
    paintDetail(false);
    paintHandoff();
  }
  void loadDetail();
  void refreshInputQueue(deliveryHost);
}

function selectNewChat(projectId: string | null = null): void {
  retireRichImageViewer();
  rememberDraft(); selectionGeneration++; replaceComposerDraft(); pendingNewInput = null;
  inputQueueGeneration++;
  $('finishQueue').replaceChildren(); $('finishQueue').hidden = true;
  newChatSelected = true; selectedId = null; selectedProjectId = projectId; detailFor = null; detailCursor = null;
  reportVisibleSelection(true);
  if (projectId) expandedProjects.add(projectId);
  applyComposerSessionModel(null, null);
  // New Chat selects its existing draft, just like a session. Navigation is not
  // permission to discard authored text, attachments or a prepared workflow.
  $('inputQueue').replaceChildren();
  restoreDraft(); showView('timeline'); paintSessions(sessionHost); void loadDetail();
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    $('composer').animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
  ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => projectId ? t("Message in {0}…", [projects.find(project => project.id === projectId)?.name ?? 'project']) : t("Ask anything…"));
  $<HTMLTextAreaElement>('chatInput').focus();
}


/**
 * The sidebar's read-and-call surface.
 *
 * Every accessor returns the live value: `sessions`, `selectedId`, `blockedChats` and the rest
 * are reassigned throughout this file, so a captured snapshot would draw a list that is one
 * refresh behind. The sets and the map are handed over by reference for the same reason.
 */
const sessionHost: SessionListHost = {
  sessions: () => sessions,
  projects: () => projects,
  selectedId: () => selectedId,
  sidebarOrder: () => sidebarOrder,
  expandedWorkers,
  expandedProjects,
  projectVisibleCounts,
  paint: () => ({
    selectedId, activeId, blockedChats, swarm,
    unattributedBlocked: () => unattributedBlocked(deps.state()),
    actions: sessionActions
  }),
  updatePanels,
  scheduleActivityExpiry: () => scheduleToolActivityExpiry(),
  newChatSelected: () => newChatSelected,
  selectedProjectId: () => selectedProjectId,
  selectNewChat,
  removeProject
};

/** What a row's buttons do. Each is a durable operation this file already owns. */
const sessionActions: SessionRowActions = {
  deleteSession,
  toggleUnattributedBlock,
  toggleSessionBlock
};

/** The outbox's read-and-call surface, live for the same reason as the sidebar's. */
const deliveryHost: DeliveryHost = {
  selectedId: () => selectedId,
  selectionGeneration: () => selectionGeneration,
  controlledSessionId: () => controlledSessionId,
  controlledTurnId: () => controlledTurnId,
  controlledSelection: () => controlledSelection,
  controlledQueueAtFinish: () => controlledQueueAtFinish,
  controlledCanInject: () => controlledCanInject,
  controlledCanSendDirectly: () => controlledCanSendDirectly,
  controlledFinishWaiting: () => controlledFinishWaiting,
  controlledStopPending: () => controlledStopPending,
  finishGoalDraftView: () => finishGoalDraftView !== null,
  preparedPlan: () => currentPreparedPlan(),
  hasPlan: key => taskPlans.has(key),
  draftKey,
  imageDrafts: () => imageDrafts,
  startingInputs: () => startingInputs,
  pendingComposerInputs: () => pendingComposerInputs,
  setPendingComposerInputs: next => { pendingComposerInputs = next; },
  pendingNewInput: () => pendingNewInput,
  setPendingNewInput: next => { pendingNewInput = next; },
  authoredComposerText,
  hasLaterModelActivity,
  restoreDraftToComposer,
  paintGoalProgress,
  projectGroup: id => projectGroup(projects, id),
  selectedProjectId: () => selectedProjectId,
  newChatSelected: () => newChatSelected,
  transcriptOwns,
  sessions: () => sessions,
  adoptSession: summary => { sessions = mergeSessionRows(sessions, [summary]); },
  selectSession,
  paintDetail: followBottom => paintDetail(followBottom),
  inputDrafts: () => inputDrafts,
  newChatTasks: () => newChatTasks,
  retireQueueReads: () => ++inputQueueGeneration,
  queueGeneration: () => inputQueueGeneration,
  cancelledStarts: () => cancelledStarts,
  refreshComposerModel: () => ensureComposerModel(true)
};

/**
 * Re-seat the panels that follow the current selection.
 *
 * The list replaces every row it draws, but the panes beside it — sub-agents, files, the
 * project terminal — belong to this file, so the list asks for the re-point rather than doing it.
 */
function updatePanels(): void {
  agentPanel?.update(selectedId, sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null));
  filePanel?.update(selectedLocalProject(sessionHost));
  workspaceTerminal?.update(selectedLocalProject(sessionHost));
  // The Skills page lists what this session's project can see, and its scope is the same object
  // the composer's picker sends. A selection that changes it invalidates the list — but only if
  // the page ever read one, so a launch that never opens Settings pays for no scan at all.
  const scope = JSON.stringify(skillsLibraryScope());
  if (skillsLibraryLoaded && skillsLibraryScopeKey !== scope) void skillsLibrary?.refresh();
  skillsLibraryScopeKey = scope;
  // A tool with nothing to offer is disabled rather than hidden, so the strip keeps its shape.
  workPanel?.refresh();
}

/** The Skills page's scope, kept in step with the composer picker's own. */
function skillsLibraryScope(): { sessionId: string | null; projectId: string | null } {
  return { sessionId: selectedId, projectId: selectedLocalProject(sessionHost)?.id ?? selectedProjectId };
}

/**
 * Whether the loaded transcript already carries a committed version of an outbox row.
 *
 * A committed row is the transcript's; only the live ones belong above it. That is a read of
 * this file's detail state, so the outbox asks rather than keeping a second copy of it.
 */
function transcriptOwns(entry: InputEntry): boolean {
  return detailFor === selectedId && !!(events.some(event =>
    event.kind === 'user_message' && (event.inputId === entry.id ||
      event.messageId === (entry.messageId ?? `input:${entry.id}`))) ||
    // History owns committed off-page rows. Keep only receipts newer than our loaded
    // publication cursor while the corresponding live snapshot arrives.
    ((entry.historyAnchored || entry.historyRecorded) &&
      (historyBefore !== null || (entry.historySeq !== undefined
        ? (detailCursor ?? 0) > entry.historySeq
        : events.length > 0))));
}

/** Put a failed message's payload back in the composer, attachments and all, for review. */
function restoreDraftToComposer(entry: InputEntry): void {
  const input = $<HTMLTextAreaElement>('chatInput');
  replaceComposerDraft();
  input.value = entry.text;
  if (entry.images?.length) imageDrafts.set(draftKey(), [...entry.images]);
  if (entry.attachments?.length) imageDrafts.set(draftKey(), [...(entry.images ?? []), ...entry.attachments]);
  rememberDraft(); skillPicker?.restore(); paintComposerImages(deliveryHost); paintDeliveryControls(deliveryHost); input.focus();
}

/**
 * Remove a project from the sidebar, keeping its conversations and files.
 *
 * The catalog, the disclosure sets and the composer's own draft all move at once, so this is
 * this file's operation; the list only draws the button that asks for it.
 */
async function removeProject(id: string): Promise<void> {
  const removed = await run(api.removeProject(id));
  if (!removed) return;
  // Reject list snapshots captured before this newer catalog commit.
  ++sessionsLoadGeneration;
  projects = projects.map(row => row.id === id ? removed : row);
  expandedProjects.delete(id); projectVisibleCounts.delete(id);
  if (selectedProjectId === id) {
    if (!selectedId) {
      const oldKey = draftKey();
      const authoredDraft = authoredComposerText();
      selectedProjectId = null; selectionGeneration++; replaceComposerDraft();
      reportVisibleSelection(true);
      // Keep the visible draft and its attachments while moving to unfiled.
      inputDrafts.set(draftKey(), authoredDraft); inputDrafts.delete(oldKey); newChatTasks.delete(oldKey);
      skillPicker?.restore();
      const images = imageDrafts.get(oldKey);
      if (images) imageDrafts.set(draftKey(), images);
      else imageDrafts.delete(draftKey());
      imageDrafts.delete(oldKey);
      $<HTMLTextAreaElement>('chatInput').placeholder = 'Ask anything…';
    } else selectedProjectId = null;
  }
  paintSessions(sessionHost); void refreshInputQueue(deliveryHost);
  toast('Project removed; conversations kept');
}

export function initChat(next: Deps): void {
  sidebarOrder = createSidebarOrder($('sessionList'), () => sessions
    .filter(entry => (entry.conversationId || entry.origin?.kind === 'desktop') && entry.origin?.kind !== 'worker')
    .map(entry => ({ id: entry.id, scope: projectGroup(projects, entry.projectId) ?? '' })), () => paintSessions(sessionHost));
  deps = next;
  reportVisibleSelection(true); // Initial New Chat/null is explicit; activity never supplies selection.
  document.addEventListener('visibilitychange', () => reportVisibleSelection(!document.hidden));
  window.addEventListener('focus', () => reportVisibleSelection(true));
  const fileToggle = el('button', 'btn file-panel-toggle') as HTMLButtonElement;
  fileToggle.id = 'filePanelToggle'; fileToggle.type = 'button'; fileToggle.hidden = true;
  fileToggle.append(icon('i-folder'));
  ui(fileToggle, 'aria-label', () => t('Toggle Files side panel')); fileToggle.setAttribute('aria-expanded', 'false');
  const agentToggle = el('button', 'btn btn-icon', '◫') as HTMLButtonElement;
  agentToggle.id = 'agentPanelToggle'; agentToggle.type = 'button'; agentToggle.hidden = true;
  ui(agentToggle, 'aria-label', () => t("Toggle sub-agent side panel")); agentToggle.setAttribute('aria-expanded', 'false');
  $('headerConnect').after(fileToggle, agentToggle);
  const agentToolGroups = new Map<string, HTMLDetailsElement>();
  const workHost = document.querySelector<HTMLElement>('[data-panel="chat"]')!;
  // The column is created before its tenants so it owns the host from the start.
  const work = workPanel = createWorkPanel({ host: workHost });
  agentPanel = createAgentPanel({
    host: workHost, toggle: agentToggle,
    onShow: () => filePanel?.hide(),
    load: id => run(api.getSession(id, { limit: 160 })), openMain: selectSession, working: sessionWorking,
    render: (source, id, current) => {
      let boundary = '';
      const rows = boundedTimeline(source).shown.flatMap(event => {
        if (!['tool_call', 'page_tool', 'agent_message'].includes(event.kind)) boundary = `event:${event.seq}`;
        if (!['user_message', 'assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', `ev ev-${event.kind} tl-row ${categoryClass(categoryFor(event.kind))}`); const body = el('div', 'ev-body');
        tagImageRow(row, event);
        row.dataset.timelineKey = `event:${event.seq}`; row.dataset.activityBoundary = boundary;
        body.append(eventBody(event, { id, current, history: source })); row.append(body); return [row];
      });
      return groupImageRows(groupToolRows(rows, `pane:${id}`, agentToolGroups));
    }
  });
  initChatModels(() => {
    paintLoopDelivery();
    const config = deps.state()?.config;
    if (config) paintContextMeter(sessions.find(session => session.id === selectedId) ?? null, config, confirmedComposerModel());
  });
  $('queueAtFinish').addEventListener('click', () => {
    if ($('queueAtFinish').hidden) return;
    $<HTMLSelectElement>('sendMode').value = 'after-turn';
    const input = $<HTMLTextAreaElement>('chatInput');
    if (input.value.trim() || imageDrafts.get(draftKey())?.length) void sendComposer('finish');
    else { input.focus(); paintDeliveryControls(deliveryHost); }
  });
  $('sendOptions').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-delivery]');
    if (!button || $('sendOptions').hidden) return;
    $<HTMLSelectElement>('sendMode').value = button.dataset.delivery!;
    paintDeliveryControls(deliveryHost);
  });
  $('automationSwitch').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!button || button.disabled) return;
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = button.dataset.mode!;
    select.dispatchEvent(new Event('change'));
  });
  $('chatAutomation').addEventListener('change', async () => {
    goalIntentGeneration++;
    const select = $<HTMLSelectElement>('chatAutomation');
    cancelGoalRequest();
    if (select.value === 'off') goalDraftView = null;
    select.dataset.edited = 'true'; paintAutomationSwitch();
    const id = selectedId, generation = selectionGeneration;
    const mode = select.value as InputAutomation;
    const opening = id && pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
    if (opening) {
      inputQueueGeneration++;
      opening.automation = mode;
      await run(api.setInputAutomation(opening.id, mode));
      void refreshInputQueue(deliveryHost); return;
    }
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation) await run(api.setInputAutomation(pending.id, mode));
      return;
    }
    select.disabled = true; paintAutomationSwitch();
    try { await run(api.setSessionAutomation(id, mode)); }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) { delete select.dataset.edited; void refreshSessionControls(); }
      paintAutomationSwitch();
    }
  });
  $('loopDelivery').addEventListener('change', async () => {
    const id = selectedId, generation = selectionGeneration;
    const select = $<HTMLSelectElement>('loopDelivery');
    const opening = id && pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
    if (opening) {
      inputQueueGeneration++;
      opening.loopAfterTurn = select.value === 'after-turn';
      opening.automation = $<HTMLSelectElement>('chatAutomation').value as InputAutomation;
      await run(api.setInputAutomation(opening.id, opening.automation, opening.loopAfterTurn));
      void refreshInputQueue(deliveryHost); return;
    }
    if (!id) {
      const pending = pendingNewInput;
      if (pending?.generation === generation)
        await run(api.setInputAutomation(pending.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, select.value === 'after-turn'));
      return;
    }
    select.disabled = true;
    try { await run(api.setSessionAutomation(id, 'loop', select.value === 'after-turn')); }
    finally {
      select.disabled = false;
      if (id === selectedId && generation === selectionGeneration) void refreshSessionControls();
    }
  });
  $('sessionObjective').addEventListener('input', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  $('sessionObjectiveMode').addEventListener('change', () => { cancelGoalRequest(); goalIntentGeneration++; $('sessionObjective').dataset.edited = 'true'; delete $('sessionObjective').dataset.saved; paintTaskActions(); });
  for (const buttonId of ['saveSessionObjective'] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId;
      const objective = $<HTMLTextAreaElement>('sessionObjective');
      if (!id) {
        const draft = objective.value, mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
        if (!draft.trim()) return;
        const settings = confirmedComposerModel();
        if (!settings) { toast('Reload model choices and select an available model and thinking effort before sending.'); return; }
        const selection = selectionGeneration, intent = goalIntentGeneration, requestId = crypto.randomUUID();
        const projectId = selectedProjectId;
        const { model, reasoningEffort } = settings;
        const automation = $<HTMLSelectElement>('chatAutomation');
        automation.value = mode;
        automation.dataset.edited = 'true'; paintAutomationSwitch();
        goalProgress = { requestId, selection, phase: 'preparing', text: '' };
        const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions(); paintGoalProgress();
        const current = () => selectedId === null && selectionGeneration === selection && goalIntentGeneration === intent && objective.value === draft && automation.value === mode;
        try {
          const result = await api.draftGoalOpening(draft.trim(), mode, requestId);
          const opening = result.ok ? result.data : null;
          if (!result.ok && current() && goalProgress?.requestId === requestId) goalProgress.error = result.error;
          if (!current()) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'paused'; paintGoalProgress(); } return; }
          if (!opening) { if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error ||= 'Opening message generation failed'; paintGoalProgress(); } return; }
          const dueAt = Date.now(), inputId = crypto.randomUUID();
          const entry: InputEntry = { id: inputId, sessionId: null, projectId, text: opening.reply, objective: draft.trim(), authoredSource: 'objective', automation: mode,
            loopAfterTurn: openingLoopDelivery(),
            mode: 'auto', dueAt, model, reasoningEffort, state: 'queued', owner: null, createdAt: dueAt, conversationId: null };
          deliveryHost.startingInputs().set(inputId, entry); pendingNewInput = { id: inputId, generation: selection };
          goalProgress = { requestId, selection, inputId, phase: 'queued', text: '' }; paintDeliveryControls(deliveryHost);
          try {
            const accepted = await run(api.sendInput(entry));
            if (accepted) { inputQueueGeneration++; pendingComposerInputs = [...pendingComposerInputs.filter(row => row.id !== inputId), accepted];
              // Off may arrive while sendInput is still validating/enqueuing, before
              // the outbox row exists. Reconcile that same pending intent after acceptance.
              if (selectionGeneration === selection && pendingNewInput?.id === inputId &&
                  (automation.value !== mode || openingLoopDelivery() !== entry.loopAfterTurn))
                await run(api.setInputAutomation(inputId, automation.value as InputAutomation, openingLoopDelivery()));
              await adoptAcceptedOpening(deliveryHost, accepted);
              if (current()) objective.dataset.saved = draft;
            } else if (goalProgress?.requestId === requestId) { goalProgress.phase = 'failed'; goalProgress.error = 'Opening message could not be queued'; }
          } finally { deliveryHost.startingInputs().delete(inputId); paintDeliveryControls(deliveryHost); void refreshInputQueue(deliveryHost); }
        } finally { delete button.dataset.busy; paintTaskActions(); }
        return;
      }
      if (objective.dataset.sessionId !== id) return;
      const selection = selectionGeneration, draft = objective.value;
      const text = objective.value.trim();
      if (!text) return;
      const mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
      const button = $<HTMLButtonElement>(buttonId); button.dataset.busy = 'true'; paintTaskActions();
      const requestId = crypto.randomUUID(); goalProgress = { requestId, selection, phase: 'saving', text: '' }; paintGoalProgress();
      try {
        const saved = await run(api.setSessionObjective(id, text, mode));
        if (goalProgress?.requestId === requestId) { goalProgress.phase = saved ? 'saved' : 'failed'; if (!saved) goalProgress.error = 'Task could not be saved'; paintGoalProgress(); }
        if (saved && selectedId === id && selectionGeneration === selection && objective.value === draft &&
            $<HTMLSelectElement>('sessionObjectiveMode').value === mode) { delete objective.dataset.edited; objective.dataset.saved = objective.value; }
      } finally {
        delete button.dataset.busy; paintTaskActions();
        if (selectedId === id) void refreshSessionControls();
      }
    });
  }
  for (const [buttonId, cancel] of [['compactSession', false], ['cancelCompaction', true]] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = selectedId; if (!id) return;
      const button = $<HTMLButtonElement>(buttonId); button.disabled = true;
      try { await run(cancel ? api.cancelSessionCompaction(id) : api.compactSession(id)); }
      finally { button.disabled = false; if (selectedId === id) void refreshSessionControls(); }
    });
  }
  const appendImages = (owner: ComposerDraftOwner, chosen: InputAttachment[] | null | undefined): boolean => {
    if (!chosen?.length) return false;
    if (!ownsComposerDraft(owner)) { toast(t("Files were not added because the draft changed.")); return false; }
    const combined = [...(imageDrafts.get(owner.key) ?? []), ...chosen];
    if (combined.length > 20 || combined.reduce((sum, file) => sum + ('size' in file ? file.size : 0), 0) > 512 * 1024 * 1024) { toast(t("Attach up to 20 files and 512 MB per message")); return false; }
    imageDrafts.set(owner.key, combined); paintComposerImages(deliveryHost);
    return true;
  };
  filePanel = createFilePanel({
    host: workHost, toggle: fileToggle,
    onShow: () => agentPanel?.hide(),
    captureAttachment: () => {
      const owner = composerDraftOwner();
      return attachment => appendImages(owner, [attachment]);
    }
  });
  filePanel.update(selectedLocalProject(sessionHost));
  workspaceTerminal = createWorkspaceTerminal({ host: workHost });
  workspaceTerminal.update(selectedLocalProject(sessionHost));
  // Three tools, one column. Registration decides the tab order and hands the slot its tenants.
  // Each pane keeps its own header button — one control, one owner, standalone or hosted — and the
  // strip follows those call sites instead of duplicating them.
  work.register('files', filePanel);
  work.register('agents', agentPanel);
  // The terminal has no project gate of its own: with no project it publishes that fact inside the
  // pane, so its tab stays reachable exactly as its header button always was.
  work.register('terminal', workspaceTerminal);
  work.refresh();
  $('attachImages').addEventListener('click', async () => {
    const owner = composerDraftOwner();
    appendImages(owner, await run(api.chooseFiles()));
  });
  skillPicker = initSkills({ input: $<HTMLTextAreaElement>('chatInput'), host: $('skillPicker'),
    openButton: $('composerSkills'), addButton: $('composerAddSkill'),
    selectedHost: $('composerSelectedSkills'), owner: () => `${draftKey()}:${composerDraftGeneration}`,
    scope: () => ({ sessionId: selectedId, projectId: selectedLocalProject(sessionHost)?.id ?? selectedProjectId }),
    draft: () => inputDrafts.get(draftKey()), saveDraft: text => inputDrafts.set(draftKey(), text),
    list: scope => api.skillLibrary(scope), command: name => {
      if (name === 'plan') { $('createPlan').click(); return; }
      if (name === 'compact') { $('compactSession').click(); return; }
      const automation = $<HTMLSelectElement>('chatAutomation'); automation.value = name;
      automation.dispatchEvent(new Event('change', { bubbles: true }));
    } });
  skillPicker.restore();
  // Same scope as the picker above, so the page and the composer can never disagree about which
  // skills exist: a repo skill in the open project belongs on both, or on neither.
  skillsLibrary = initSkillsLibrary({
    host: $('skillsLibraryList'),
    list: () => api.skillLibrary(skillsLibraryScope()),
    set: payload => api.setSkill(payload),
    notify: toast
  });
  // Loaded when the settings sheet is opened (`showView`), not here: a launch that never opens
  // Settings should not pay for the scan.
  skillsLibraryScopeKey = JSON.stringify(skillsLibraryScope());
  $('generateFinishGoal').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('generateFinishGoal'), id = selectedId, turnId = controlledTurnId;
    if (!id || !turnId || button.hidden || button.disabled || controlledSessionId !== id || controlledSelection !== selectionGeneration) return;
    const owner = `${id}:${turnId}`;
    button.dataset.busy = owner; paintDeliveryControls(deliveryHost);
    try { await run(api.generateFinishGoal(id, turnId)); }
    finally {
      if (button.dataset.busy === owner) delete button.dataset.busy;
      if (selectedId === id) void refreshSessionControls();
      else paintDeliveryControls(deliveryHost);
    }
  });
  $('composer').addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  $('composer').addEventListener('drop', async event => {
    if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const text = event.dataTransfer.getData('text/plain'), owner = composerDraftOwner();
    if (text) { const file = await run(api.attachText(text)); if (file) appendImages(owner, [file]); }
  });
  window.addEventListener('paste', async event => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    const owner = composerDraftOwner();
    if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(owner, await run(api.dropFiles(files)));
  });
  window.addEventListener('dragover', event => {
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', async event => {
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files), owner = composerDraftOwner();
    if (!files.length) return;
    if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) { toast('Attach up to 20 files per message'); return; }
    appendImages(owner, await run(api.dropFiles(files)));
  });
  api.onWriteSession?.(id => { selectSession(id); $<HTMLTextAreaElement>('chatInput').focus(); });
  $('newChat').addEventListener('click', () => {
    selectNewChat();
  });
  $('addProject').addEventListener('click', async event => {
    event.preventDefault();
    const button = $<HTMLButtonElement>('addProject'); button.disabled = true;
    const generation = selectionGeneration;
    try {
      const project = await run(api.addProject());
      if (!project) return;
      // The picker published a newer durable catalog. A list refresh started before it
      // may still return an empty catalog and otherwise erase this sidebar group.
      ++sessionsLoadGeneration;
      projects = [...projects.filter(row => row.id !== project.id), project];
      expandedProjects.add(project.id);
      if (generation === selectionGeneration) selectNewChat(project.id); else paintSessions(sessionHost);
    } finally { button.disabled = false; }
  });
  $('settingsSearch').addEventListener('input', () => applySettingsFilter());
  const composerMenus = [...document.querySelectorAll<HTMLDetailsElement>('.composer-menu, .session-controls')];
  document.addEventListener('click', (event) => {
    for (const menu of composerMenus) if (!menu.contains(event.target as Node) || ((event.target as HTMLElement).closest('button') && !(event.target as HTMLElement).closest('[data-keep-menu]'))) menu.open = false;
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') for (const menu of composerMenus) menu.open = false; });
  $('chatInput').addEventListener('input', () => {
    const hasText = !!authoredComposerText().trim();
    const plan = taskPlans.get(draftKey());
    if (plan && !plan.stages && (plan.requestId || !hasText)) {
      cancelTaskPlan();
      if (hasText) taskPlans.set(draftKey(), { text: '', requestId: null, stages: null, sending: false, progress: null, error: null });
    }
    paintDeliveryControls(deliveryHost); paintTaskActions();
  });
  $('chatInput').addEventListener('keydown', (event) => {
    if (skillPicker?.keydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (currentPreparedPlan() || authoredComposerText().trim() || imageDrafts.get(draftKey())?.length) $<HTMLFormElement>('composer').requestSubmit(); }
  });
  $('composerSettings').addEventListener('toggle', paintTaskActions);
  initContextMeter();
  initComposerStatusLine();
  $('createPlan').addEventListener('click', () => { if (taskPlans.has(draftKey())) cancelTaskPlan(); else void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); });
  $('composer').addEventListener('submit', (event) => { event.preventDefault(); if (currentPreparedPlan()) void sendPreparedPlan(); else if (taskPlans.has(draftKey())) { if (!$('createPlan').dataset.busy) void createTaskPlan(deps.state()?.config.ui.planBackend ?? 'chatgpt'); } else void sendComposer(); });

  $('sessionList').addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (!row?.dataset.id || row.dataset.id === selectedId) return;
    pendingNewInput = null;
    selectSession(row.dataset.id);
  });
  $('sessionList').closest<HTMLElement>('.scroll')?.addEventListener('scroll', () => maybePageSessions({
    visible, cursor: sessionPageCursor, loaded: sessions.length, total: sessionTotal,
    loadMore: () => void loadMoreSessions()
  }));
  // One bounded window pages in either direction, only on deliberate navigation.
  // Layout restoration must never drain history or jump straight to the live tail.
  const historyPane = $('chatBody');
  let historyIntent: string | null = null;
  let historyDirection = 0;
  const loadAtEdge = () => {
    if (!historyIntent || historyIntent !== selectedId || historyLoading || !selectedId || detailFor !== selectedId) return;
    const older = historyDirection < 0 && historyPane.scrollTop <= 80;
    const newer = historyDirection > 0 && historyBefore !== null && historyPane.scrollHeight - historyPane.clientHeight - historyPane.scrollTop <= 80;
    if (!older && !newer) return;
    historyIntent = null;
    if (newer) {
      const from = events.reduce((cursor, event) => Math.max(cursor, positionOf(event)), 0);
      historyLoading = true;
      void loadDetail(true, undefined, from).finally(() => { historyLoading = false; });
      return;
    }
    const windowed = boundedTimeline(visibleEvents());
    const boundaryRows = windowed.omitted > 0 && windowed.shown.length ? windowed.shown : events;
    const before = boundaryRows.length ? Math.min(...boundaryRows.map(positionOf)) : 1;
    if (before <= 1) return;
    historyLoading = true;
    void loadDetail(true, before).finally(() => { historyLoading = false; });
  };
  historyPane.addEventListener('wheel', event => { historyIntent = selectedId; historyDirection = Math.sign(event.deltaY); loadAtEdge(); }, { passive: true });
  let pointerScrollTop: number | null = null;
  historyPane.addEventListener('pointerdown', () => { pointerScrollTop = historyPane.scrollTop; });
  window.addEventListener('pointerup', () => { pointerScrollTop = null; });
  historyPane.addEventListener('keydown', event => {
    historyIntent = selectedId;
    historyDirection = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ? -1 : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1 : 0;
    loadAtEdge();
  });
  historyPane.addEventListener('scroll', () => {
    if (pointerScrollTop !== null) {
      historyDirection = Math.sign(historyPane.scrollTop - pointerScrollTop);
      pointerScrollTop = historyPane.scrollTop;
      historyIntent = selectedId;
    }
    loadAtEdge();
  }, { passive: true });

  $('chatView').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!button?.dataset.view) return;
    showView(button.dataset.view);
  });


  $('chatAgentFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-agent]');
    if (!button) return;
    agentFilter = button.dataset.agent === '' ? null : (button.dataset.agent ?? null);
    paintDetail();
  });

  $('chatRefresh').addEventListener('click', event => { event.preventDefault(); void refreshAll(); });

  $('copyHandoff').addEventListener('click', async () => {
    if (!handoff) return;
    const copied = await run(api.writeClipboard(handoff.text));
    if (copied) toast('Handoff copied');
  });

  $('swarmReset').addEventListener('click', async () => {
    const state = await run(api.resetSwarm());
    if (state) {
      paintSwarm(state);
      toast('Swarm cleared');
    }
  });

  // Which of the two things happened is decided in the main process and reported back,
  // so the toast describes the actual outcome rather than the intent of the click.
  $('swarmList').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-clear]');
    const id = button?.dataset.clear;
    if (!id) return;
    const outcome = await run(api.clearAgent(id, button?.dataset.runId));
    if (!outcome) return;
    paintSwarm(outcome.swarm);
    toast(
      outcome.cleared === 'run'
        ? 'Run cleared — every worker ended'
        : outcome.cleared === 'worker'
          ? `${id} cleared — its slot is free`
          : outcome.reason
    );
  });

  for (const id of CHAT_INPUTS) {
    $(id).addEventListener('change', () => void deps.save());
  }

  wireGoal(() => deps.save());

  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await run(api.unpairExtension());
    if (state) toast('Browser disconnected');
  });
  $('bridgeFolder').addEventListener('click', async () => {
    const dir = await run(api.openExtensionFolder());
    if (dir) toast('Extension folder opened');
  });

  api.onSessionChanged(scheduleReload);
  api.onTaskProgress(progress => {
    if (!goalProgress || progress.requestId !== goalProgress.requestId || goalProgress.selection !== selectionGeneration) return;
    Object.assign(goalProgress, progress); paintGoalProgress();
  });
  api.onSwarmChanged(paintSwarm);
}
