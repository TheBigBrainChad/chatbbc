import { $, ago, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import type { createSidebarOrder } from './sidebar-order.js';
import { sessionWorkingAt, workerReportedFinish } from '../shared/session-activity.js';
import type { AppState } from '../shared/types.js';
import type { ActivitySummary, AgentState, SessionSummary, SwarmState, TokenPressure } from '../shared/session.js';
import type { LocalProject } from '../shared/projects.js';

/**
 * The session sidebar: which chat is where, and what it is doing.
 *
 * chat.ts keeps the durable facts — the session array, the selection, the project catalog and
 * the disclosure sets — and this module owns only how they are drawn. Everything read here is
 * handed in per call through {@link SessionListHost}, whose accessors return the live objects
 * rather than copies: a group a selection just opened has to be visible to the very next paint,
 * and a snapshot would silently lose it.
 */

/** What the list needs from chat.ts. */
export interface SessionListHost {
  sessions(): SessionSummary[];
  projects(): LocalProject[];
  selectedId(): string | null;
  sidebarOrder(): ReturnType<typeof createSidebarOrder> | undefined;
  /** Window-local disclosure intent: the same sets chat.ts mutates when a selection opens a group. */
  expandedWorkers: Set<string>;
  expandedProjects: Set<string>;
  projectVisibleCounts: Map<string, number>;
  /** A row's per-draw facts, rebuilt for each paint so no repaint shows a stale election. */
  paint(): SessionListPaint;
  /** Re-seat the panels that follow the current selection. */
  updatePanels(): void;
  /** Re-arm the single repaint at the nearest activity-window boundary. */
  scheduleActivityExpiry(): void;
  /** True while the New Chat draft, rather than a recorded session, owns the composer. */
  newChatSelected(): boolean;
  /** The project a New Chat draft would join, when one is elected. */
  selectedProjectId(): string | null;
  selectNewChat(projectId: string | null): void;
  /** Remove a project from the sidebar, keeping its conversations and files. */
  removeProject(id: string): Promise<void>;
}

/** The per-row facts a badge or a button is drawn from. */
export interface SessionListPaint {
  selectedId: string | null;
  activeId: string | null;
  blockedChats: Set<string>;
  swarm: SwarmState | null;
  /**
   * Whether the Unattributed stream is blocked, as a callback.
   *
   * It stays lazy because it is only meaningful for the one row that has no conversation, and
   * reading the app's config on every paint would make every other row pay for it.
   */
  unattributedBlocked(): boolean;
  actions: SessionRowActions;
}

/** What a row's buttons ask chat.ts to do. */
export interface SessionRowActions {
  deleteSession(id: string): Promise<void>;
  toggleUnattributedBlock(blocked: boolean): Promise<void>;
  toggleSessionBlock(id: string, blocked: boolean): Promise<void>;
}

/** Sprite id per tool-call family. Deliberately reuses the existing icon set. */
export const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

/**
 * How close to the end of the sidebar counts as asking for the next page, in pixels.
 * A little over one row, so the fetch starts while there is still something to read.
 */
const SESSION_SCROLL_MARGIN = 72;
const PROJECT_TASK_PAGE_SIZE = 5;
const PROJECT_TASK_PAGE_INCREMENT = 8;

/** The project a session belongs to, or null when it is unfiled or ungrouped. */
export function projectGroup(projects: LocalProject[], id: string | null | undefined): string | null {
  return id && !projects.find(project => project.id === id)?.ungrouped ? id : null;
}

/**
 * The project the composer is currently working in.
 *
 * A selected worker inherits its parent task's project, because the worker is working where the
 * task it was opened for is working; a New Chat uses the project it was started from.
 */
export function selectedLocalProject(host: SessionListHost): LocalProject | null {
  const sessions = host.sessions();
  const projects = host.projects();
  const selectedId = host.selectedId();
  if (selectedId) {
    const selected = sessions.find(row => row.id === selectedId);
    const inherited = selected?.origin?.kind === 'worker' && selected.origin.fromSessionId
      ? sessions.find(row => row.id === selected.origin?.fromSessionId)?.projectId : undefined;
    const id = selected?.projectId ?? inherited;
    return id ? projects.find(project => project.id === id) ?? null : null;
  }
  const projectId = host.selectedProjectId();
  return host.newChatSelected() && projectId
    ? projects.find(project => project.id === projectId && !project.ungrouped) ?? null : null;
}

/** The latest measured context pressure for a session, if the app has one. */
export function pressureOf(pressure: Map<string, TokenPressure>, id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
}

/** A short word about a session, drawn as a chip on its row. */
export interface Badge {
  text: string;
  tone: '' | 'is-active' | 'is-finished' | 'is-failed';
}

/** Live word per worker state, in the user's vocabulary rather than the protocol's. */
export const AGENT_BADGE: Record<AgentState, Badge> = {
  invited: { text: 'opening', tone: 'is-active' },
  active: { text: 'active', tone: 'is-active' },
  // Still working, as far as this app knows — only its browser tab is gone. Said as
  // "no tab" rather than "detached" because that is the part a user can act on.
  detached: { text: 'no tab', tone: 'is-active' },
  // Between jobs, not over. Its chat is intact and the prime can put it back to work in it,
  // so the word has to read as a pause rather than as an ending — a user who reads "finished"
  // here closes the tab, which is the one thing that costs nothing and helps nothing.
  sleeping: { text: 'sleeping', tone: '' },
  waking: { text: 'waking', tone: 'is-active' },
  finished: { text: 'finished', tone: 'is-finished' },
  failed: { text: 'failed', tone: 'is-failed' }
};

/** Keep callback arguments separate from the shared predicate's explicit clock. */
export function sessionWorking(summary: SessionSummary): boolean {
  return sessionWorkingAt(summary, Date.now());
}

/**
 * Is the Unattributed stream blocked?
 *
 * There is no per-chat block to read: the whole point of this row is that the app cannot say
 * which chat these calls came from, so the only switch that can answer for them is the
 * app-wide one. Off is a block — a call the app cannot attribute is refused — which is why the
 * row draws it with the same button and the same word as a blocked chat.
 */
export function unattributedBlocked(state: AppState | null): boolean {
  return state?.config.multiAgent.allowUnattributedCalls === false;
}

/**
 * What a row is, and what it is doing right now.
 *
 * Once resume and multi-agent mode are in use, most rows in the list are chats this app
 * opened, and they are all recorded within a minute of each other. A name alone cannot
 * separate them — which run a chat belonged to, whether its tab ever opened, whether the
 * worker in it ever joined — and that is how a user loses track of a delayed tab. The
 * first badge is durable and comes from the session itself; the second is live and comes
 * from the swarm or the compaction currently reported by the app.
 */
export function sessionBadges(summary: SessionSummary, paint: SessionListPaint): Badge[] {
  const badges: Badge[] = [];
  const origin = summary.origin;
  // The one session that is not a chat. Saying so on the row is what stops it reading
  // as a chat that mysteriously lost its name.
  if (summary.conversationId === null) {
    return paint.unattributedBlocked()
      ? [{ text: 'blocked', tone: 'is-failed' }, { text: 'not a chat', tone: '' }]
      : [{ text: 'not a chat', tone: '' }];
  }
  // First, and in the failure tone: a blocked chat is the one state on this row that says the
  // app is actively refusing work, and the user came to the list to find it at a glance.
  if (paint.blockedChats.has(summary.conversationId)) badges.push({ text: 'blocked', tone: 'is-failed' });
  if (origin?.kind === 'worker') badges.push({ text: origin.agentId ?? 'worker', tone: '' });
  else if (origin?.kind === 'resume') badges.push({ text: 'resumed', tone: '' });
  else if (summary.agents.includes('prime')) badges.push({ text: 'prime', tone: '' });

  // Agent ids are reused across runs (`worker-1`, `worker-2`, ...). Matching only by that
  // short id made old worker sessions inherit the *current* run's live badge, so a worker
  // chat from 20 minutes ago suddenly said "active" again when a new worker-2 started.
  // Conversation id is the durable identity of the actual ChatGPT tab, so only that exact
  // worker session may borrow the live swarm state.
  const agent = origin?.agentId
    ? paint.swarm?.agents.find(
        (entry) =>
          entry.id === origin.agentId &&
          Boolean(entry.conversationId) &&
          entry.conversationId === summary.conversationId
      )
    : paint.swarm?.agents.find(
        (entry) => entry.role === 'prime' && entry.conversationId === summary.conversationId
      );
  // Owning a run is not the same as running a turn. Exact chat activity wins; only an idle
  // worker falls back to its broker lifecycle label.
  // Exact recorded tool activity belongs to the session, not to the renderer's current swarm
  // projection. A parked/restarted run can lose its AgentView while the chat still makes calls.
  const workerStopped = agent?.role === 'worker' && ['sleeping', 'finished', 'failed'].includes(agent.state);
  if (workerStopped) badges.push(AGENT_BADGE[agent.state]);
  // The swarm no longer shows this worker — its run parked when it and its siblings stopped —
  // but its own session records that its last call was the finish report. That is a worker
  // between jobs, and "sleeping" is the word that says its chat can be woken.
  else if (!agent && workerReportedFinish(summary)) badges.push(AGENT_BADGE.sleeping);
  else if (sessionWorking(summary)) badges.push(AGENT_BADGE.active);
  else if (agent && agent.role !== 'prime') badges.push(AGENT_BADGE[agent.state]);
  return badges;
}

export function sessionRow(summary: SessionSummary, paint: SessionListPaint): HTMLElement {
  const row = el('div', 'sess');
  row.dataset.id = summary.id;
  if (summary.id === paint.selectedId) row.classList.add('is-sel');
  if (summary.id === paint.activeId && summary.endedAt === null) row.classList.add('is-live');

  const top = el('div', 'sess-top');
  const title = el('b', '', () => summary.title || t("Untitled session")); title.dir = 'auto';
  top.append(title);
  const badges = sessionBadges(summary, paint);
  ui(row, 'title', () => [summary.title || t("Untitled session"), ...badges.map((badge) => t(badge.text)), ago(summary.updatedAt)].join(' · '));
  const showTip = () => {
    document.getElementById('sessionTooltip')?.remove();
    const tip = el('div', 'session-tooltip', row.title);
    tip.id = 'sessionTooltip'; tip.setAttribute('role', 'tooltip');
    const bounds = row.getBoundingClientRect();
    tip.style.left = `${Math.min(bounds.right + 10, window.innerWidth - 290)}px`;
    tip.style.top = `${Math.min(bounds.top, window.innerHeight - 110)}px`;
    document.body.append(tip);
  };
  row.addEventListener('pointerenter', showTip);
  row.addEventListener('pointerleave', () => document.getElementById('sessionTooltip')?.remove());
  row.addEventListener('click', () => document.getElementById('sessionTooltip')?.remove());
  const status = badges.find((badge) => badge.tone);
  if (status) {
    const indicator = el('span', `session-status ${status.tone}`);
    ui(indicator, 'title', () => t(status.text));
    ui(indicator, 'aria-label', () => t(status.text));
    top.append(indicator);
  }
  const actionBar = el('div', 'sess-actions');

  const remove = document.createElement('button');
  remove.className = 'btn sess-action sess-del';
  remove.type = 'button';
  ui(remove, 'title', () => t("Delete this recorded session"));
  remove.append(icon('i-trash'));
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    void paint.actions.deleteSession(summary.id);
  });

  const actions: HTMLButtonElement[] = [];
  if (summary.conversationId === null) {
    // The same button in the same column as a chat's, because it is the same decision: may
    // this activity use local tools? It has no conversation to be stored against, so it moves
    // the app-wide switch — the checkbox on the settings sheet — and nothing else.
    const blocked = paint.unattributedBlocked();
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    ui(block, 'title', () => blocked
      ? t("Allow unattributed calls: self-contained calls run again even when the app cannot prove which chat sent them")
      : t("Block unattributed calls: every call the app cannot attribute to a chat is refused and the chat is told to stop"));
    block.append(icon(blocked ? 'i-play' : 'i-ban'));
    block.addEventListener('click', (event) => {
      event.stopPropagation();
      void paint.actions.toggleUnattributedBlock(!blocked);
    });
    actions.push(block);

    actionBar.append(...actions, remove);
    row.append(top, actionBar);
    return row;
  }
  if (summary.conversationId) {
    // The stop this app can actually make. It does not touch the running ChatGPT turn — nothing
    // here can — it takes this chat's tools away, and a model whose every call is refused with
    // an instruction to stop finishes its turn on its own.
    const blocked = paint.blockedChats.has(summary.conversationId);
    const block = document.createElement('button');
    block.className = `btn sess-action sess-block${blocked ? ' is-blocked' : ''}`;
    block.type = 'button';
    ui(block, 'title', () => blocked
      ? t("Release this chat: its tool calls run again")
      : t("Block this chat: every tool call it makes is refused and it is told to stop"));
    block.append(icon(blocked ? 'i-play' : 'i-ban'));
    block.addEventListener('click', (event) => {
      event.stopPropagation();
      void paint.actions.toggleSessionBlock(summary.id, !blocked);
    });
    actions.push(block);

    const open = document.createElement('button');
    open.className = 'btn sess-action sess-open';
    open.type = 'button';
    ui(open, 'title', () => t("Open this chat in Chrome"));
    open.append(icon('i-out'));
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      void run(window.api.openSessionChat(summary.id));
    });
    actions.push(open);
  }

  actionBar.append(...actions, remove);
  row.append(top, actionBar);
  return row;
}

function sortSessionRows(rows: SessionSummary[]): SessionSummary[] {
  return rows.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}

/**
 * Fold a freshly read page into the rows already held, newest first.
 *
 * A page is authoritative for the rows it carries; rows it does not mention keep their place,
 * which is what lets a hot refresh update the newest page without discarding older ones. The
 * caller owns the resulting array.
 */
export function mergeSessionRows(current: SessionSummary[], rows: SessionSummary[]): SessionSummary[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of rows) merged.set(entry.id, entry);
  return sortSessionRows([...merged.values()]);
}

/**
 * Ask for the next page when the sidebar is scrolled to within a row of its end.
 *
 * Whether another page exists is chat.ts's fact, not the sidebar's, so this stays a pure
 * decision over the paging state it is handed and the fetch itself is a callback.
 */
export function maybePageSessions(paging: {
  visible: boolean; cursor: unknown; loaded: number; total: number; loadMore: () => void;
}): void {
  if (!paging.visible || !paging.cursor || paging.loaded >= paging.total) return;
  const pane = $('sessionList').closest<HTMLElement>('.scroll');
  if (!pane) return;
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= SESSION_SCROLL_MARGIN) paging.loadMore();
}

/** Unattributed activity stays one disclosure; it is the only bucket with no chat to open. */
let diagnosticsExpanded = false;

/**
 * Draw the whole sidebar: projects, their tasks, worker groups and the diagnostics bucket.
 *
 * The disclosure sets and the visible-count map are borrowed by reference and mutated in place,
 * because they are the same window-local facts chat.ts reads when a selection opens a group. A
 * copy here would be a second owner of one fact.
 */
export function paintSessions(host: SessionListHost): void {
  const sessions = host.sessions();
  const projects = host.projects();
  const selectedId = host.selectedId();
  const sidebarOrder = host.sidebarOrder();
  const expandedWorkers = host.expandedWorkers;
  const expandedProjects = host.expandedProjects;
  const projectVisibleCounts = host.projectVisibleCounts;
  const paint = host.paint();
  // Keep the pointer's elected rows alive while asynchronous activity snapshots arrive.
  if (sidebarOrder?.interacting) return;
  document.getElementById('sessionTooltip')?.remove();
  const projectList = $('projectList'), chatList = $('chatList');
  // Activity replaces sidebar nodes. Keep an actively focused project disclosure
  // attached to its exact project, without moving focus from the composer or settings.
  const focused = document.activeElement;
  const focusedProject = focused instanceof HTMLElement && projectList.contains(focused) && focused.matches('.project-heading')
    ? focused.closest<HTMLElement>('.project-group')?.dataset.projectId : undefined;
  const children = new Map<string, SessionSummary[]>();
  const ids = new Set(sessions.map((entry) => entry.id));
  for (const entry of sessions) {
    if (entry.origin?.kind !== 'worker') continue;
    const parent = entry.origin.fromSessionId;
    const key = parent && ids.has(parent) && parent !== entry.id ? parent : 'other-workers';
    children.set(key, [...(children.get(key) ?? []), entry]);
  }
  const rows: HTMLElement[] = [];
  // A task and its expanded workers are one sidebar item for project pagination.
  const projectRows = new Map<string, Array<{ rows: HTMLElement[]; selected: boolean }>>();
  const diagnostics: SessionSummary[] = [];
  const group = (key: string, workers: SessionSummary[], parentRow?: HTMLElement, target = rows): void => {
    const button = el('button', 'worker-toggle');
    button.append(icon('i-chev'));
    ui(button, 'title', () => t("{0} sub-agents · {1} active", [workers.length, workers.filter(sessionWorking).length]));
    ui(button, 'aria-label', () => t("{0} {1} sub-agents", [expandedWorkers.has(key) ? t("Collapse") : t("Expand"), workers.length]));
    button.setAttribute('type', 'button'); button.setAttribute('aria-expanded', String(expandedWorkers.has(key)));
    button.addEventListener('click', (event) => { event.stopPropagation(); expandedWorkers.has(key) ? expandedWorkers.delete(key) : expandedWorkers.add(key); paintSessions(host); });
    if (parentRow) { parentRow.append(button); parentRow.title += ` · ${button.title}`; } else target.push(button);
    if (expandedWorkers.has(key)) { const box = el('div', 'worker-group'); box.append(...workers.map(entry => sessionRow(entry, paint))); target.push(box); }
  };
  const orderedSessions = sidebarOrder
    ? [...new Set(sessions.map(entry => projectGroup(projects, entry.projectId) ?? ''))].flatMap(scope =>
      sidebarOrder!.ordered(scope, sessions.filter(entry => (projectGroup(projects, entry.projectId) ?? '') === scope)))
    : sessions;
  for (const entry of orderedSessions) {
    if (entry.origin?.kind === 'worker') continue;
    if (!entry.conversationId && entry.origin?.kind !== 'desktop') { diagnostics.push(entry); continue; }
    const projectId = projectGroup(projects, entry.projectId);
    const target: HTMLElement[] = projectId ? [] : rows;
    const row = sessionRow(entry, paint); target.push(row);
    row.dataset.sortScope = projectId ?? ''; row.tabIndex = 0;
    const workers = children.get(entry.id); if (workers) group(entry.id, workers, row, target);
    if (projectId) {
      const tasks = projectRows.get(projectId) ?? [];
      tasks.push({ rows: target, selected: entry.id === selectedId || workers?.some(worker => worker.id === selectedId) === true });
      projectRows.set(projectId, tasks);
    }
  }
  const otherWorkers = children.get('other-workers') ?? [];
  if (otherWorkers.length) {
    const history = document.createElement('details'); history.className = 'session-diagnostics';
    history.open = expandedWorkers.has('other-workers');
    history.append(el('summary', '', () => t("Sub-agent history · {0}", [otherWorkers.length])));
    history.append(...otherWorkers.map(entry => sessionRow(entry, paint)));
    history.addEventListener('toggle', () => { if (history.isConnected) history.open ? expandedWorkers.add('other-workers') : expandedWorkers.delete('other-workers'); });
    rows.push(history);
  }
  const projectIds = [...new Set([...projects.filter(project => !project.ungrouped).map(project => project.id), ...projectRows.keys()])];
  const projectSections: HTMLElement[] = [];
  for (const id of projectIds) {
    const project = projects.find(row => row.id === id);
    const section = document.createElement('details'); section.className = 'project-group'; section.dataset.projectId = id;
    section.open = expandedProjects.has(id);
    const heading = el('summary', 'project-heading');
    const label = el('span', 'project-name', () => project?.name ?? t("Unavailable project"));
    ui(heading, 'title', () => project?.path ?? t("Unavailable project"));
    heading.append(icon('i-folder'), label); section.append(heading);
    // Native `toggle` is queued after activation. A concurrent activity repaint can replace
    // this node first and lose the click. Commit the summary's pointer/keyboard click to the
    // one disclosure owner synchronously, then project it onto this details element.
    heading.addEventListener('click', event => {
      event.preventDefault();
      const open = !expandedProjects.has(id);
      if (open) expandedProjects.add(id); else expandedProjects.delete(id);
      section.open = open;
    });
    if (project) {
      const create = el('button', 'btn project-new'); create.append(icon('i-pencil')); create.setAttribute('type', 'button'); create.dataset.newProject = id;
      ui(create, 'title', () => t("New chat in this project")); create.setAttribute('aria-label', create.title);
      create.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); host.selectNewChat(id); }); heading.append(create);
      const remove = el('button', 'btn project-remove') as HTMLButtonElement;
      remove.type = 'button'; remove.append(icon('i-trash'));
      ui(remove, 'title', () => t("Remove project from sidebar; keep conversations and files"));
      ui(remove, 'aria-label', () => t("Remove project {0}", [project.name]));
      remove.addEventListener('click', async event => {
        event.preventDefault(); event.stopPropagation();
        // One removal at a time: the button is the only in-flight guard, exactly as before.
        if (remove.disabled) return;
        remove.disabled = true;
        try { await host.removeProject(id); }
        finally { remove.disabled = false; }
      });
      heading.append(remove);
    }
    const tasks = projectRows.get(id) ?? [];
    const count = projectVisibleCounts.get(id) ?? PROJECT_TASK_PAGE_SIZE;
    const shown = tasks.filter((task, index) => index < count || task.selected);
    section.append(...shown.flatMap(task => task.rows));
    if (shown.length < tasks.length) {
      const more = el('button', 'btn project-show-more', () => t("Show more")) as HTMLButtonElement;
      more.type = 'button'; ui(more, 'aria-label', () => t("Show more tasks in {0}", [project?.name ?? t("this project")]));
      more.addEventListener('click', () => { projectVisibleCounts.set(id, count + PROJECT_TASK_PAGE_INCREMENT); paintSessions(host); });
      section.append(more);
    }
    projectSections.push(section);
  }
  if (diagnostics.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'session-diagnostics';
    disclosure.open = diagnosticsExpanded;
    disclosure.append(el('summary', '', () => t("Unattributed activity · {0}", [diagnostics.length])));
    disclosure.append(...diagnostics.map(entry => sessionRow(entry, paint)));
    disclosure.addEventListener('toggle', () => { diagnosticsExpanded = disclosure.open; });
    rows.push(disclosure);
  }
  // Both scopes keep the existing sessionList drag/order owner and durable project binding.
  projectList.replaceChildren(...projectSections);
  chatList.replaceChildren(...rows);
  if (focusedProject) projectSections.find(section => section.dataset.projectId === focusedProject)
    ?.querySelector<HTMLElement>('.project-heading')?.focus({ preventScroll: true });
  host.updatePanels();
  badgeKey = badgeSignature(sessions, paint);
  $('projectsEmpty').hidden = projectSections.length > 0;
  $('sessionsEmpty').hidden = rows.length > 0;

  host.scheduleActivityExpiry();
}

/** Badges the list is currently drawn with. See repaintBadges. */
let badgeKey = '';

function badgeSignature(sessions: SessionSummary[], paint: SessionListPaint): string {
  return sessions.map((entry) => sessionBadges(entry, paint).map((badge) => badge.text).join(',')).join('|');
}

/**
 * Redraws the list when a row's badges would change, and not otherwise.
 *
 * The badges follow live state, which changes as fast as the recorder writes. Rebuilding every
 * row for each of those would be a list that flickers while it is being read, so the redraw is
 * keyed on the badges themselves.
 */
export function repaintBadges(host: SessionListHost): void {
  if (badgeSignature(host.sessions(), host.paint()) === badgeKey) return;
  paintSessions(host);
}
