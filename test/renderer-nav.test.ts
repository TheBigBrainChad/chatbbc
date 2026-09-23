import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '../src/shared/projects.js';
import { createChatNavigator, navigatorRows, type ChatNavigator, type NavigatorSession } from '../src/renderer/chat-navigator.js';
import { createPresentationStore, initialPresentationState } from '../src/renderer/presentation-store.js';
import type { SessionListHost } from '../src/renderer/session-list.js';
import { createSidebarOrder } from '../src/renderer/sidebar-order.js';

const html = () => fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

describe('workspace destination ownership', () => {
  it('replaces legacy tabs with Settings-owned controls for every retained panel', async () => {
    const text = await html();
    expect(text).not.toContain('id="tabs"');
    expect(text).not.toContain('data-tab=');
    expect(text).not.toContain('id="backToChat"');
    expect(text).not.toContain('id="workspaceSettings"');
    expect(text).toContain('id="settingsPages"');
    for (const panel of ['workspace', 'automation', 'appearance', 'activity']) {
      expect(text).toContain(`data-settings-panel="${panel}"`);
    }
    expect(text).toContain('id="setupBadge"');
  });
});


describe('the global rail', () => {
  it('places Chats, Files, Agents, Usage, and Settings around the current navigator and stage', async () => {
    const text = await html();
    const railAt = text.indexOf('id="globalRail"');
    const navAt = text.indexOf('id="chatNavigator"');
    const sessionAt = text.indexOf('id="sessionList"');
    const stageAt = text.indexOf('id="conversationStage"');
    const timelineAt = text.indexOf('id="timeline"');
    const composerAt = text.indexOf('id="composer"');
    const workAt = text.indexOf('id="contextWorkbench"');
    expect(railAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(railAt);
    expect(sessionAt).toBeGreaterThan(navAt);
    expect(stageAt).toBeGreaterThan(sessionAt);
    expect(timelineAt).toBeGreaterThan(stageAt);
    expect(composerAt).toBeGreaterThan(timelineAt);
    expect(workAt).toBeGreaterThan(composerAt);
    const rail = text.slice(railAt, navAt);
    expect([...rail.matchAll(/data-destination="([a-z]+)"/g)].map(match => match[1])).toEqual([
      'chats', 'files', 'agents', 'usage', 'settings'
    ]);
  });

  it('moves rail focus with the arrow keys and keeps Chats selected until activation', async () => {
    const dom = new JSDOM(await html(), { url: 'https://cos.local/' });
    const { document } = dom.window;
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { createPresentationStore, initialPresentationState } = await import('../src/renderer/presentation-store.js');
    const shell = createAppShell({
      document,
      store: createPresentationStore(initialPresentationState()),
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#globalRail [data-destination]')];
    expect(buttons.map(button => button.dataset.destination)).toEqual(['chats', 'files', 'agents', 'usage', 'settings']);
    expect(buttons.map(button => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(buttons[0]!.getAttribute('aria-current')).toBe('page');
    buttons[0]!.focus();
    const key = (target: HTMLElement, name: string) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: name, bubbles: true, cancelable: true
    }));
    key(buttons[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.map(button => button.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(buttons[0]!.getAttribute('aria-current')).toBe('page');
    key(buttons[1]!, 'End');
    expect(document.activeElement).toBe(buttons[4]);
    key(buttons[4]!, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[4]);
    key(buttons[4]!, 'ArrowRight');
    expect(document.activeElement).toBe(buttons[4]);
    key(buttons[4]!, 'Home');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0]!, 'ArrowUp');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    shell.dispose();
    dom.window.close();
  });

  it('migrates the sidebar width into one navigator preference and deletes the old key', async () => {
    const dom = new JSDOM(await html(), { url: 'https://cos.local/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    dom.window.localStorage.setItem('chatbbc.sidebar-width', '360');
    dom.window.localStorage.setItem('chatbbc.sidebar-width.collapsed', 'true');
    const { initSidebarResize } = await import('../src/renderer/sidebar-resize.js');
    initSidebarResize();
    expect(dom.window.localStorage.getItem('chatbbc.navigator-width')).toBe('360');
    expect(dom.window.localStorage.getItem('chatbbc.navigator-collapsed')).toBe('true');
    // The migration is complete: no runtime branch or duplicate preference survives it.
    expect(dom.window.localStorage.getItem('chatbbc.sidebar-width')).toBeNull();
    expect(dom.window.localStorage.getItem('chatbbc.sidebar-width.collapsed')).toBeNull();
    dom.window.close();
    vi.unstubAllGlobals();
  });
});

const session = (id: string, overrides: Partial<NavigatorSession> = {}): NavigatorSession => ({
  id,
  title: id,
  conversationId: `chat-${id}`,
  chatIds: [`chat-${id}`],
  startedAt: 1,
  updatedAt: 1,
  endedAt: null,
  events: 0,
  userMessages: 0,
  toolCalls: 0,
  lastToolCallAt: null,
  processExitNonzero: 0,
  toolRejected: 0,
  toolInternalErrors: 0,
  errors: 0,
  estimatedTokens: 0,
  contextTokens: 0,
  lastHandoffId: null,
  lastHandoffAt: null,
  lastTurnOutcome: null,
  agents: [],
  origin: null,
  ...overrides
});

const project = (id: string, overrides: Partial<LocalProject> = {}): LocalProject => ({
  id,
  name: id,
  path: `/projects/${id}`,
  createdAt: 1,
  ...overrides
});

describe('chat navigator projection', () => {
  it('keeps chats primary and scopes worker identities to their prime family', () => {
    const sessions = [
      session('prime-a', { title: 'Prime A', updatedAt: 30 }),
      session('worker-a', {
        title: 'Worker',
        updatedAt: 20,
        origin: { kind: 'worker', fromSessionId: 'prime-a', agentId: 'worker-1', task: 'inspect' }
      }),
      session('chat-b', { title: 'Chat B', updatedAt: 10 })
    ];
    const rows = navigatorRows({ sessions, projects: [], query: '', selectedSessionId: 'prime-a' });
    expect(rows.filter(row => row.kind === 'chat').map(row => row.sessionId)).toEqual(['prime-a', 'chat-b']);
    expect(rows.filter(row => row.kind === 'worker').map(row => row.key)).toEqual(['prime-a:worker-1']);
  });

  it('ranks authored chat previews before file and image-set matches', () => {
    const rows = navigatorRows({
      sessions: [session('prime-a', {
        title: 'Launch notes',
        preview: 'Aurora launch brief'
      })],
      projects: [project('studio')],
      query: 'aurora',
      selectedSessionId: null,
      files: [{ projectId: 'studio', path: 'notes/aurora.md', name: 'aurora.md' }],
      imageSets: [{ key: 'set-1', sessionId: 'prime-a', title: 'Aurora concepts' }]
    });
    expect(rows.map(row => row.kind)).toEqual(['chat', 'file', 'image-set']);
  });

  it('keeps a selected worker child addressable when its prime is off the loaded page', () => {
    const rows = navigatorRows({
      sessions: [session('worker-a', {
        origin: { kind: 'worker', fromSessionId: 'off-page-prime', agentId: 'worker-1', task: 'inspect' }
      })],
      projects: [],
      query: '',
      selectedSessionId: 'worker-a'
    });
    expect(rows).toEqual([expect.objectContaining({
      kind: 'worker',
      key: 'off-page-prime:worker-1',
      parentSessionId: 'off-page-prime',
      selected: true
    })]);
  });

  it('regroups chats immediately when a project is removed without changing chat identity', () => {
    const rows = navigatorRows({
      sessions: [session('chat-a', { projectId: 'retired' })],
      projects: [project('retired', { ungrouped: true })],
      query: '',
      selectedSessionId: 'chat-a'
    });
    expect(rows.some(row => row.kind === 'project')).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({
      kind: 'chat',
      sessionId: 'chat-a',
      projectId: null,
      selected: true
    }));
  });

  it('bounds ranked results and keeps stable updatedAt/id order within one rank', () => {
    const sessions = Array.from({ length: 140 }, (_, index) =>
      session(`chat-${String(index).padStart(3, '0')}`, { title: `Aurora ${index}`, updatedAt: index % 3 }));
    const rows = navigatorRows({ sessions, projects: [], query: 'aurora', selectedSessionId: null });
    expect(rows).toHaveLength(100);
    const chats = rows.filter(row => row.kind === 'chat');
    expect(chats[0]).toEqual(expect.objectContaining({ sessionId: 'chat-137' }));
    expect(chats[1]).toEqual(expect.objectContaining({ sessionId: 'chat-134' }));
  });

  it('fences A to B to A selection through the presentation store and ignores current-row activation', async () => {
    const dom = new JSDOM(`<!doctype html><body><aside id="chatNavigator">
      <div class="sidebar-primary"></div><section class="sidebar-sessions"><div class="scroll">
      <div id="sessionList"><div id="projectList"></div><p id="projectsEmpty"></p><div id="chatList"></div><p id="sessionsEmpty"></p></div>
      </div></section></aside></body>`, { url: 'https://cos.local/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    const store = createPresentationStore(initialPresentationState());
    store.dispatch({ type: 'sessionSelected', sessionId: 'a', generation: 0 });
    const sessions = [session('a', { updatedAt: 2 }), session('b', { updatedAt: 1 })];
    const projects = [project('studio')];
    const selected: string[] = [];
    const newChats: Array<string | null> = [];
    let navigator!: ChatNavigator;
    const host: SessionListHost = {
      sessions: () => sessions,
      projects: () => projects,
      selectedId: () => store.getState().selectedSessionId,
      sidebarOrder: () => undefined,
      expandedWorkers: new Set(),
      expandedProjects: new Set(),
      projectVisibleCounts: new Map(),
      paint: () => ({
        selectedId: store.getState().selectedSessionId,
        activeId: null,
        blockedChats: new Set(),
        swarm: null,
        unattributedBlocked: () => false,
        actions: { deleteSession: async () => {}, toggleUnattributedBlock: async () => {}, toggleSessionBlock: async () => {} }
      }),
      updatePanels: () => {},
      scheduleActivityExpiry: () => {},
      newChatSelected: () => false,
      selectedProjectId: () => null,
      selectNewChat: projectId => { newChats.push(projectId); },
      removeProject: async () => {}
    };
    const selectSession = (sessionId: string) => {
      selected.push(sessionId);
      store.dispatch({ type: 'selectionGenerationAdvanced' });
      store.dispatch({ type: 'sessionSelected', sessionId, generation: store.getState().selectionGeneration });
      navigator.update({ sessions, projects, query: '', selectedSessionId: sessionId });
    };
    navigator = createChatNavigator({
      root: dom.window.document.getElementById('chatNavigator')!,
      host,
      store,
      selectSession,
      document: dom.window.document
    });
    navigator.update({ sessions, projects, query: '', selectedSessionId: 'a' });
    dom.window.document.querySelector<HTMLElement>('[data-id="b"]')!.click();
    dom.window.document.querySelector<HTMLElement>('[data-id="a"]')!.click();
    dom.window.document.querySelector<HTMLElement>('[data-id="a"]')!.click();
    expect(selected).toEqual(['b', 'a']);
    expect(store.getState()).toMatchObject({ selectedSessionId: 'a', selectionGeneration: 2 });
    navigator.openProject('studio');
    expect(host.expandedProjects).toContain('studio');
    expect(newChats).toEqual([]);
    expect(store.getState().selectedSessionId).toBe('a');
    navigator.dispose();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('keeps partial-page order and clamps keyboard reordering to the current group', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="list"><div data-id="a" data-sort-scope="p" tabindex="0"></div><div data-id="b" data-sort-scope="p" tabindex="0"></div><div data-id="c" data-sort-scope="q" tabindex="0"></div></div></body>', { url: 'https://cos.local/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    const list = dom.window.document.getElementById('list')!;
    for (const row of list.children) Object.defineProperty(row, 'getClientRects', { value: () => [{ width: 1, height: 1 }] });
    const entries = [{ id: 'off-page', scope: 'p' }, { id: 'a', scope: 'p' }, { id: 'b', scope: 'p' }, { id: 'c', scope: 'q' }];
    const order = createSidebarOrder(list, () => entries, () => {});
    const key = (target: Element, name: string) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: name, altKey: true, bubbles: true, cancelable: true
    }));
    key(list.children[0]!, 'ArrowUp');
    key(list.children[1]!, 'ArrowDown');
    expect(order.ordered('p', entries.filter(row => row.scope === 'p')).map(row => row.id)).toEqual(['off-page', 'a', 'b']);
    expect(order.ordered('q', entries.filter(row => row.scope === 'q')).map(row => row.id)).toEqual(['c']);
    dom.window.close();
    vi.unstubAllGlobals();
  });
});

describe('destination router', () => {
  function mount() {
    const dom = new JSDOM(`<div class="app" id="appShell" data-screen="chat">
      <nav id="globalRail">
        <button type="button" data-destination="chats" aria-current="page"></button>
        <button type="button" data-destination="files"></button>
        <button type="button" data-destination="agents"></button>
        <button type="button" data-destination="usage"></button>
        <button type="button" data-destination="settings"></button>
      </nav>
      <div id="chatNavigator"></div>
      <main id="conversationStage">
        <section class="panel is-active" data-panel="chat"><div id="timeline"></div></section>
        <section class="panel" data-panel="usage"></section>
        <section class="panel" data-panel="workspace"></section>
      </main>
      <aside id="contextWorkbench"></aside>
      <nav id="settingsPages" hidden></nav>
      <input id="appearance-accent-hex" value="#000000" />
    </div>`, { url: 'https://cos.local/' });
    const { document } = dom.window;
    return { dom, document };
  }

  it('returns to the same chat without reloading it after Settings', async () => {
    const { createDestinationRouter } = await import('../src/renderer/destination-router.js');
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { dom, document } = mount();
    const store = createPresentationStore(initialPresentationState());
    const shell = createAppShell({
      document,
      store,
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const router = createDestinationRouter({ shell, store, document });
    router.show('chats');
    const timeline = document.querySelector('#timeline');
    router.show('settings');
    router.show('chats');
    expect(document.querySelector('#timeline')).toBe(timeline);
    expect(document.getElementById('appShell')!.dataset.screen).toBe('chat');
    shell.dispose();
    dom.window.close();
  });

  it('does not overwrite a dirty appearance field on a state push', async () => {
    const { createDestinationRouter } = await import('../src/renderer/destination-router.js');
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { dom, document } = mount();
    const store = createPresentationStore(initialPresentationState());
    const shell = createAppShell({
      document,
      store,
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const router = createDestinationRouter({ shell, store, document });
    router.show('settings');
    const field = document.getElementById('appearance-accent-hex') as HTMLInputElement;
    field.focus();
    field.value = '#123456';
    store.dispatch({ type: 'appStateReceived', generation: 1, state: { config: { ui: { appearance: { accent: '#abcdef' } } } } as never });
    expect(field.value).toBe('#123456');
    shell.dispose();
    dom.window.close();
  });

  it('keeps Chats current while Files or Agents open the workbench', async () => {
    const { createDestinationRouter } = await import('../src/renderer/destination-router.js');
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { dom, document } = mount();
    const store = createPresentationStore(initialPresentationState());
    const shell = createAppShell({
      document,
      store,
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const router = createDestinationRouter({ shell, store, document });
    const timeline = document.querySelector('#timeline');
    router.show('files');
    expect(document.querySelector('#timeline')).toBe(timeline);
    expect(document.querySelector('[data-destination="chats"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-destination="files"]')!.hasAttribute('aria-current')).toBe(false);
    expect(document.getElementById('appShell')!.dataset.workbenchOpen).toBe('true');
    expect(document.getElementById('appShell')!.dataset.screen).toBe('chat');
    expect(router.current()).toBe('files');
    router.show('agents');
    expect(document.querySelector('[data-destination="chats"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('appShell')!.dataset.workbenchOpen).toBe('true');
    expect(router.current()).toBe('agents');
    store.dispatch({ type: 'workbenchChanged', open: false, tab: 'agents' });
    expect(router.current()).toBe('chats');
    expect(document.getElementById('appShell')!.dataset.screen).toBe('chat');
    router.show('chats');
    expect(document.getElementById('appShell')!.dataset.workbenchOpen).toBe('false');
    expect(router.current()).toBe('chats');
    shell.dispose();
    dom.window.close();
  });

  it('opens Usage without the workbench and keeps the chat mounted', async () => {
    const { createDestinationRouter } = await import('../src/renderer/destination-router.js');
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { dom, document } = mount();
    const store = createPresentationStore(initialPresentationState());
    const shell = createAppShell({
      document,
      store,
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const router = createDestinationRouter({ shell, store, document });
    router.show('files');
    const timeline = document.querySelector('#timeline');
    router.show('usage');
    expect(document.querySelector('#timeline')).toBe(timeline);
    expect(document.querySelector('[data-panel="usage"]')!.classList.contains('is-active')).toBe(true);
    expect(document.querySelector('[data-destination="usage"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('appShell')!.dataset.screen).toBe('settings');
    expect(document.getElementById('appShell')!.dataset.workbenchOpen).toBe('false');
    expect(router.current()).toBe('usage');
    shell.dispose();
    dom.window.close();
  });

  it('sends a rail click through one destination handler', async () => {
    const { createDestinationRouter } = await import('../src/renderer/destination-router.js');
    const { createAppShell } = await import('../src/renderer/app-shell.js');
    const { dom, document } = mount();
    const store = createPresentationStore(initialPresentationState());
    const shell = createAppShell({
      document,
      store,
      roots: {
        rail: document.getElementById('globalRail')!,
        navigator: document.getElementById('chatNavigator')!,
        stage: document.getElementById('conversationStage')!,
        workbench: document.getElementById('contextWorkbench')!
      }
    });
    const router = createDestinationRouter({ shell, store, document });
    let opens = 0;
    store.subscribe(state => state.shell.workbench, workbench => { if (workbench.open) opens += 1; });
    shell.setDestinationHandler(destination => router.show(destination));
    document.querySelector<HTMLButtonElement>('[data-destination="files"]')!.click();
    expect(opens).toBe(1);
    expect(document.getElementById('appShell')!.dataset.workbenchOpen).toBe('true');
    expect(document.querySelector('[data-destination="chats"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('[data-destination="files"]')!.hasAttribute('aria-current')).toBe(false);
    expect(router.current()).toBe('files');
    expect(document.getElementById('appShell')!.dataset.screen).toBe('chat');
    shell.dispose();
    dom.window.close();
  });

  it('keeps secondary surfaces opaque until compositor glass is active', async () => {
    const pages = await fs.readFile(path.resolve(__dirname, '../src/renderer/styles/pages.css'), 'utf8');
    const dialogs = await fs.readFile(path.resolve(__dirname, '../src/renderer/styles/dialogs.css'), 'utf8');
    expect(pages).toContain("[data-panel='setup']");
    expect(pages).toContain("[data-panel='plugins']");
    expect(pages).toContain(".plugin-connection:not(.is-configured)");
    expect(pages).toContain("data-glass-mode='hyprland-blur'");
    expect(pages).not.toContain('var(--glass-high, var(--card))');
    const glassAt = pages.indexOf("data-glass-mode='hyprland-blur'");
    expect(pages.indexOf('var(--glass-high)')).toBeGreaterThan(glassAt);
    expect(dialogs).toContain('background: var(--card)');
    expect(dialogs).toContain("data-glass-mode='transparent'");
    expect(dialogs.indexOf('var(--glass-high)')).toBeGreaterThan(dialogs.indexOf('background: var(--card)'));
  });
});
