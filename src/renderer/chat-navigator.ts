import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { paintSessions, projectGroup, sessionRow, type SessionListHost } from './session-list.js';
import type { SidebarOrder } from './sidebar-order.js';
import type { PresentationStore } from './presentation-store.js';
import type { LocalProject } from '../shared/projects.js';
import type { SessionSummary } from '../shared/session.js';

const MAX_RANKED_ROWS = 100;

export interface NavigatorFile {
  projectId: string;
  path: string;
  name: string;
  /** Bounded text already held by the file owner. The navigator never loads it. */
  preview?: string;
}

export interface NavigatorImageSet {
  /** Canonical set identity supplied by the transcript owner. */
  key: string;
  sessionId: string;
  title: string;
  projectId?: string | null;
}
export type NavigatorSession = SessionSummary & {
  /** Bounded authored preview already carried by a loaded session projection. */
  preview?: string;
};

export interface ChatNavigatorView {
  sessions: readonly NavigatorSession[];
  projects: readonly LocalProject[];
  query?: string;
  selectedSessionId: string | null;
  /** Currently loaded metadata only. Supplying these arrays never grants a read. */
  files?: readonly NavigatorFile[];
  imageSets?: readonly NavigatorImageSet[];
  order?: Pick<SidebarOrder, 'ordered'>;
}

export type NavigatorRow =
  | { kind: 'project'; key: string; projectId: string; title: string }
  | { kind: 'chat'; key: string; sessionId: string; projectId: string | null; title: string; preview: string; selected: boolean }
  | { kind: 'worker'; key: string; sessionId: string; parentSessionId: string; projectId: string | null; title: string; preview: string; selected: boolean }
  | { kind: 'file'; key: string; projectId: string; path: string; title: string }
  | { kind: 'image-set'; key: string; sessionId: string; projectId: string | null; title: string }
  | { kind: 'empty'; key: 'empty'; reason: 'no-chats' | 'no-results' };

export interface ChatNavigator {
  update(view: ChatNavigatorView): void;
  focusSearch(): void;
  openProject(projectId: string | null): void;
  dispose(): void;
}

export interface ChatNavigatorOptions {
  root: HTMLElement;
  host: SessionListHost;
  store: PresentationStore;
  selectSession(sessionId: string): void;
  openFile?(file: NavigatorFile): void;
  openImageSet?(set: NavigatorImageSet): void;
  document?: Document;
}

function newestFirst(left: NavigatorSession, right: NavigatorSession): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  return right.id.localeCompare(left.id);
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Pure projection over metadata the renderer already holds. It never pages, reads history, or
 * asks the filesystem for a broader index. Search is deliberately capped independently of the
 * loaded session-page count.
 */
export function navigatorRows(view: ChatNavigatorView): NavigatorRow[] {
  const projects = [...view.projects];
  const sessions = [...view.sessions];
  const projectById = new Map(projects.map(entry => [entry.id, entry]));
  const primeById = new Map(sessions.filter(entry => entry.origin?.kind !== 'worker').map(entry => [entry.id, entry]));
  const chats = sessions.filter(entry => entry.origin?.kind !== 'worker' &&
    (entry.conversationId !== null || entry.origin?.kind === 'desktop'));
  const workers = sessions.filter(entry => entry.origin?.kind === 'worker');
  const scopeOf = (entry: NavigatorSession): string | null => {
    const own = projectGroup(projects, entry.projectId);
    if (own) return own;
    const parent = entry.origin?.kind === 'worker' && entry.origin.fromSessionId
      ? primeById.get(entry.origin.fromSessionId) : undefined;
    return projectGroup(projects, parent?.projectId);
  };
  const ordered = <T extends NavigatorSession>(scope: string, rows: T[]): T[] =>
    view.order ? view.order.ordered(scope, rows) : [...rows].sort(newestFirst);
  const chatRow = (entry: NavigatorSession): NavigatorRow => ({
    kind: 'chat',
    key: `chat:${entry.id}`,
    sessionId: entry.id,
    projectId: scopeOf(entry),
    title: entry.title,
    preview: entry.preview ?? entry.origin?.task ?? '',
    selected: entry.id === view.selectedSessionId
  });
  const workerRow = (entry: NavigatorSession): NavigatorRow => {
    const parentSessionId = entry.origin?.fromSessionId ?? `orphan:${entry.id}`;
    return {
      kind: 'worker',
      key: `${parentSessionId}:${entry.origin?.agentId ?? entry.id}`,
      sessionId: entry.id,
      parentSessionId,
      projectId: scopeOf(entry),
      title: entry.title,
      preview: entry.preview ?? entry.origin?.task ?? '',
      selected: entry.id === view.selectedSessionId
    };
  };

  const query = normalized(view.query ?? '');
  if (!query) {
    const rows: NavigatorRow[] = [];
    const children = new Map<string, NavigatorSession[]>();
    for (const worker of workers) {
      const parent = worker.origin?.fromSessionId;
      if (parent && primeById.has(parent)) children.set(parent, [...(children.get(parent) ?? []), worker]);
    }
    for (const project of projects.filter(entry => !entry.ungrouped)) {
      rows.push({ kind: 'project', key: `project:${project.id}`, projectId: project.id, title: project.name });
      for (const chat of ordered(project.id, chats.filter(entry => scopeOf(entry) === project.id))) {
        rows.push(chatRow(chat));
        rows.push(...ordered(`worker:${chat.id}`, children.get(chat.id) ?? []).map(workerRow));
      }
    }
    for (const chat of ordered('', chats.filter(entry => scopeOf(entry) === null))) {
      rows.push(chatRow(chat));
      rows.push(...ordered(`worker:${chat.id}`, children.get(chat.id) ?? []).map(workerRow));
    }
    const attachedWorkers = new Set([...children.values()].flatMap(group => group.map(entry => entry.id)));
    rows.push(...workers.filter(entry => !attachedWorkers.has(entry.id)).sort(newestFirst).map(workerRow));
    return rows.length ? rows : [{ kind: 'empty', key: 'empty', reason: 'no-chats' }];
  }

  type Ranked = { rank: number; updatedAt: number; id: string; row: NavigatorRow };
  const ranked: Ranked[] = [];
  for (const entry of chats) {
    const title = normalized(entry.title);
    const preview = normalized(entry.preview ?? entry.origin?.task ?? '');
    if (!title.includes(query) && !preview.includes(query)) continue;
    ranked.push({ rank: title.includes(query) ? 0 : 1, updatedAt: entry.updatedAt, id: entry.id, row: chatRow(entry) });
  }
  for (const entry of workers) {
    const title = normalized(entry.title);
    const preview = normalized(entry.preview ?? entry.origin?.task ?? '');
    if (!title.includes(query) && !preview.includes(query)) continue;
    ranked.push({ rank: title.includes(query) ? 0 : 1, updatedAt: entry.updatedAt, id: entry.id, row: workerRow(entry) });
  }
  for (const entry of projects) {
    if (!entry.ungrouped && normalized(entry.name).includes(query)) {
      ranked.push({ rank: 1, updatedAt: entry.createdAt, id: entry.id, row: { kind: 'project', key: `project:${entry.id}`, projectId: entry.id, title: entry.name } });
    }
  }
  for (const entry of view.files ?? []) {
    if (!normalized(`${entry.name} ${entry.path} ${entry.preview ?? ''}`).includes(query)) continue;
    ranked.push({ rank: 2, updatedAt: 0, id: `${entry.projectId}:${entry.path}`, row: {
      kind: 'file', key: `file:${entry.projectId}:${entry.path}`, projectId: entry.projectId, path: entry.path, title: entry.name
    } });
  }
  for (const entry of view.imageSets ?? []) {
    if (!normalized(entry.title).includes(query)) continue;
    ranked.push({ rank: 3, updatedAt: 0, id: entry.key, row: {
      kind: 'image-set', key: `image-set:${entry.key}`, sessionId: entry.sessionId,
      projectId: entry.projectId && projectById.get(entry.projectId)?.ungrouped !== true ? entry.projectId : null,
      title: entry.title
    } });
  }
  const rows = ranked.sort((left, right) => left.rank - right.rank || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    .slice(0, MAX_RANKED_ROWS).map(entry => entry.row);
  return rows.length ? rows : [{ kind: 'empty', key: 'empty', reason: 'no-results' }];
}

/** One navigator around the existing session-list owner; ordinary browsing keeps its exact DOM. */
export function createChatNavigator(options: ChatNavigatorOptions): ChatNavigator {
  const doc = options.document ?? options.root.ownerDocument;
  const foundSessionList = doc.getElementById('sessionList');
  const primary = options.root.querySelector<HTMLElement>('.sidebar-primary');
  if (!foundSessionList || !primary) throw new Error('Chat navigator requires the existing session list and primary controls');
  const sessionList = foundSessionList;
  const search = doc.createElement('input');
  search.id = 'navigatorSearch';
  search.type = 'search';
  search.className = 'navigator-search';
  ui(search, 'aria-label', () => [t('Chats'), t('Search files'), t('Image')].join(' · '));
  ui(search, 'placeholder', () => [t('Chats'), t('Search files'), t('Image')].join(' · '));
  const results = el('div', 'navigator-results');
  results.id = 'navigatorResults';
  results.hidden = true;
  sessionList.after(results);
  primary.after(search);

  let current: ChatNavigatorView = {
    sessions: [], projects: [], query: '', selectedSessionId: options.store.getState().selectedSessionId
  };
  let disposed = false;

  function resultElement(row: NavigatorRow): HTMLElement {
    if (row.kind === 'empty') return el('p', 'empty navigator-empty', () => t('No chats outside projects yet.'));
    if (row.kind === 'chat' || row.kind === 'worker') {
      const summary = current.sessions.find(entry => entry.id === row.sessionId);
      if (summary) return sessionRow(summary, options.host.paint());
    }
    const node = el('button', 'navigator-result') as HTMLButtonElement;
    node.type = 'button'; node.dataset.navigatorKind = row.kind;
    if (row.kind === 'project') {
      node.dataset.projectId = row.projectId;
      node.append(icon('i-folder'), el('span', '', row.title));
    } else if (row.kind === 'file') {
      node.dataset.projectId = row.projectId; node.dataset.path = row.path;
      node.append(icon('i-file'), el('span', '', row.title));
    } else if (row.kind === 'image-set') {
      node.dataset.imageSet = row.key.slice('image-set:'.length);
      node.append(icon('i-image'), el('span', '', row.title));
    }
    return node;
  }

  function paint(): void {
    if (disposed) return;
    paintSessions(options.host);
    const query = search.value;
    current = { ...current, query, selectedSessionId: options.store.getState().selectedSessionId };
    const searching = normalized(query).length > 0;
    sessionList.hidden = searching;
    results.hidden = !searching;
    if (searching) results.replaceChildren(...navigatorRows(current).map(resultElement));
    else results.replaceChildren();
  }

  function onInput(): void {
    current = { ...current, query: search.value };
    paint();
  }

  function onClick(event: Event): void {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-id], [data-project-id], [data-image-set]');
    if (!target || !options.root.contains(target)) return;
    const sessionId = target.dataset.id;
    if (sessionId) {
      if (sessionId !== options.store.getState().selectedSessionId) options.selectSession(sessionId);
      return;
    }
    if (!results.contains(target)) return;
    if (target.dataset.imageSet) {
      const set = current.imageSets?.find(entry => entry.key === target.dataset.imageSet);
      if (set) options.openImageSet?.(set);
      return;
    }
    const projectId = target.dataset.projectId;
    const path = target.dataset.path;
    if (projectId && path) {
      const file = current.files?.find(entry => entry.projectId === projectId && entry.path === path);
      if (file) options.openFile?.(file);
      return;
    }
    if (projectId) openProject(projectId);
  }

  function openProject(projectId: string | null): void {
    if (!projectId) return;
    options.host.expandedProjects.add(projectId);
    search.value = '';
    current = { ...current, query: '' };
    paint();
    const group = [...sessionList.querySelectorAll<HTMLElement>('[data-project-id]')]
      .find(entry => entry.dataset.projectId === projectId);
    group?.querySelector<HTMLElement>('.project-heading')?.focus({ preventScroll: true });
    group?.scrollIntoView?.({ block: 'nearest' });
  }

  search.addEventListener('input', onInput);
  options.root.addEventListener('click', onClick);
  const unsubscribe = options.store.subscribe(state => state.selectedSessionId, selectedSessionId => {
    if (disposed || current.selectedSessionId === selectedSessionId) return;
    current = { ...current, selectedSessionId };
    paint();
  });

  return {
    update(view) {
      current = { ...view, query: view.query ?? current.query, sessions: [...view.sessions], projects: [...view.projects] };
      if (view.query !== undefined && search.value !== view.query) search.value = view.query;
      paint();
    },
    focusSearch() { search.focus(); },
    openProject,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      search.removeEventListener('input', onInput);
      options.root.removeEventListener('click', onClick);
      search.remove();
      results.remove();
      sessionList.hidden = false;
    }
  };
}
