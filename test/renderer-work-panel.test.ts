import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkPanel, type WorkPanel } from '../src/renderer/work-panel.js';
import { attachWorkPanelResize } from '../src/renderer/work-panel-resize.js';
import { readRendererStyles } from './helpers.js';

let dom: JSDOM;
let host: HTMLElement;

beforeEach(() => {
  dom = new JSDOM(
    '<body><section class="panel is-active" data-panel="chat"><section class="card is-session"></section></section></body>',
    { url: 'https://cos.local/' }
  );
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  host = document.querySelector<HTMLElement>('[data-panel="chat"]')!;
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

/**
 * A tenant mounted the way the real ones mount: its own root element carries the shared
 * resize affordance, and the work panel places it and publishes its show/hide pair.
 */
function tenant(work: WorkPanel, name: string) {
  const root = document.createElement('aside');
  root.className = `${name}-panel`;
  root.hidden = true;
  attachWorkPanelResize(work.host, root);
  const show = vi.fn(() => { root.hidden = false; });
  const hide = vi.fn(() => { root.hidden = true; });
  work.register(name as 'files' | 'agents' | 'terminal', { element: root, show, hide });
  return { root, show, hide };
}

describe('the work panel', () => {
  it('has one tab strip carrying files, agents and terminal in that order', () => {
    const work = createWorkPanel({ host });
    expect(host.querySelectorAll('#workPanel')).toHaveLength(1);
    expect(work.panel.parentElement).toBe(host);
    expect([...work.panel.querySelectorAll<HTMLElement>('[data-work-tab]')].map(node => node.dataset.workTab))
      .toEqual(['files', 'agents', 'terminal', 'inspector', 'plan', 'session']);
  });

  it('gives every tenant the shared resize owner, and only that one', () => {
    const work = createWorkPanel({ host });
    const files = tenant(work, 'files');
    const agents = tenant(work, 'agents');
    const terminal = tenant(work, 'terminal');
    // Each pane's own root carries the affordance, so the width belongs to the slot and not to
    // whichever tool is showing. Asserting the harness built it is what makes this fail if a pane
    // stops asking for the owner — reading source text would pass on an import line alone.
    for (const pane of [files, agents, terminal]) {
      expect(pane.root.querySelectorAll('.work-panel-resize')).toHaveLength(1);
    }
    expect(host.style.getPropertyValue('--work-panel-width')).not.toBe('');
    // One shared slot: a resize driven from one tenant's handle moves the width all of them read.
    const handle = terminal.root.querySelector<HTMLElement>('.work-panel-resize')!;
    const before = host.style.getPropertyValue('--work-panel-width');
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }));
    expect(host.style.getPropertyValue('--work-panel-width')).not.toBe(before);
    expect(files.root.querySelector<HTMLElement>('.work-panel-resize')!.getAttribute('aria-valuenow'))
      .toBe(handle.getAttribute('aria-valuenow'));
  });

  /**
   * The Sub-agents pane builds its list lazily, so a tab that only flips `hidden` would open it
   * empty — and, because the pane's own update path repaints only while it is already visible, a
   * session switch would leave another session's rows on screen. The tab must go through the
   * pane's own show path, which is the one place that builds the list.
   */
  it('opens a tenant through its own show path rather than only revealing it', () => {
    const work = createWorkPanel({ host });
    const agents = tenant(work, 'agents');
    work.show('agents');
    expect(agents.show).toHaveBeenCalledTimes(1);
    expect(agents.root.hidden).toBe(false);
    // Selecting it again collapses, matching what the pane's own header button does.
    work.toggle('agents');
    expect(agents.hide).toHaveBeenCalledTimes(1);
    expect(agents.root.hidden).toBe(true);
  });

  /**
   * The strip is chrome: one row of mono labels, the selected one carrying the sidebar's own
   * selected fill, square, and split by hairlines — never an underline.
   */
  it('draws the strip as one row of square mono labels with a filled selected tab', async () => {
    const css = await readRendererStyles();
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      return match ? match[1]!.replace(/\s+/g, ' ') : '';
    };
    expect(rule('.work-panel-tabs')).toContain('display: flex');
    const tab = rule('.work-panel-tab');
    expect(tab).toContain('font-family: var(--ui-font-mono)');
    expect(tab).toContain('border-radius: 0');
    expect(tab).not.toContain('text-decoration');
    // The same selected fill the sidebar uses for its own selected row.
    expect(rule('.work-panel-tab.is-sel')).toContain('background: var(--hover)');
  });
});

describe('switching tenants', () => {
  it('hosts all three at once and only changes visibility', () => {
    const work = createWorkPanel({ host });
    const files = tenant(work, 'files');
    const agents = tenant(work, 'agents');
    const terminal = tenant(work, 'terminal');

    work.toggle('files');
    const mounted = [...work.body.children];
    expect(mounted).toEqual([work.outputInspector.element, files.root, agents.root, terminal.root]);
    expect(files.root.hidden).toBe(false);
    expect([agents.root.hidden, terminal.root.hidden]).toEqual([true, true]);
    // Retiring a pane already hidden would discard what it holds, so nobody is asked to hide.
    expect([agents.hide.mock.calls.length, terminal.hide.mock.calls.length]).toEqual([0, 0]);

    work.toggle('agents');
    // The same nodes, never rebuilt: an expanded folder, a draft and a live shell all survive.
    expect([...work.body.children]).toEqual(mounted);
    expect(files.hide).toHaveBeenCalledTimes(1);
    expect(agents.root.hidden).toBe(false);
    expect(terminal.root.hidden).toBe(true);
    expect(terminal.hide).not.toHaveBeenCalled();

    work.toggle('terminal');
    expect([...work.body.children]).toEqual(mounted);
    expect(terminal.root.hidden).toBe(false);
    expect([files.root.hidden, agents.root.hidden]).toEqual([true, true]);
  });

  it('marks the strip and the chat column for the tenant that is showing', () => {
    const work = createWorkPanel({ host });
    tenant(work, 'files');
    tenant(work, 'agents');
    tenant(work, 'terminal');
    const tab = (name: string): HTMLElement => work.panel.querySelector<HTMLElement>(`[data-work-tab="${name}"]`)!;
    const selected = (name: string): string | null => tab(name).getAttribute('aria-selected');

    expect(work.panel.hidden).toBe(true);
    expect(host.classList.contains('has-work-panel')).toBe(false);

    work.toggle('files');
    expect(work.panel.hidden).toBe(false);
    expect(host.classList.contains('has-work-panel')).toBe(true);
    expect([selected('files'), selected('agents')]).toEqual(['true', 'false']);
    expect(tab('files').classList.contains('is-sel')).toBe(true);
    expect(tab('agents').classList.contains('is-sel')).toBe(false);

    work.toggle('agents');
    expect([selected('files'), selected('agents')]).toEqual(['false', 'true']);

    // The tab the reader is already on puts the column away, like every other toggle here.
    work.toggle('agents');
    expect(work.panel.hidden).toBe(true);
    expect(host.classList.contains('has-work-panel')).toBe(false);
    expect([tab('files').classList.contains('is-sel'), tab('agents').classList.contains('is-sel')])
      .toEqual([false, false]);
    expect(host.style.getPropertyValue('--work-panel-width')).not.toBe('');
  });
});

describe('the terminal tab', () => {
  it('widens the slot to its maximum and gives the reader their width back', () => {
    host.getBoundingClientRect = () => ({ width: 1600 } as DOMRect);
    const work = createWorkPanel({ host });
    tenant(work, 'files');
    tenant(work, 'terminal');

    work.toggle('files');
    const chosen = host.style.getPropertyValue('--work-panel-width');
    expect(chosen).toMatch(/^\d+px$/);

    work.toggle('terminal');
    // The same maximum `End` reaches in the one resize owner: the host minus the 360px chat.
    expect(host.style.getPropertyValue('--work-panel-width')).toBe('1240px');

    work.toggle('files');
    expect(host.style.getPropertyValue('--work-panel-width')).toBe(chosen);
  });

  /**
   * The widening is a view of the slot, not a preference: the width the reader chose is still
   * where their next visit starts, so the saved layout must survive a terminal visit untouched.
   */
  it('leaves the saved width alone while it is widened', () => {
    host.getBoundingClientRect = () => ({ width: 1600 } as DOMRect);
    dom.window.localStorage.setItem('chatbbc.work-panel-width', '700');
    const work = createWorkPanel({ host });
    tenant(work, 'terminal');

    work.toggle('terminal');
    expect(host.style.getPropertyValue('--work-panel-width')).toBe('1240px');
    // The migrated preference is where the reader's width now lives; the legacy key is gone.
    expect(dom.window.localStorage.getItem('chatbbc.workbench-width')).toBe('700');
    expect(dom.window.localStorage.getItem('chatbbc.work-panel-width')).toBeNull();
  });

  it('migrates a work-panel width into the workbench preference once and deletes the old key', () => {
    host.getBoundingClientRect = () => ({ width: 1600 } as DOMRect);
    dom.window.localStorage.setItem('chatbbc.work-panel-width', '640');
    const work = createWorkPanel({ host });
    const files = tenant(work, 'files');
    expect(dom.window.localStorage.getItem('chatbbc.workbench-width')).toBe('640');
    expect(dom.window.localStorage.getItem('chatbbc.work-panel-width')).toBeNull();
    expect(host.style.getPropertyValue('--work-panel-width')).toBe('640px');

    const handle = files.root.querySelector<HTMLElement>('.work-panel-resize')!;
    handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(dom.window.localStorage.getItem('chatbbc.workbench-width')).toBe('650');

    dom.window.localStorage.setItem('chatbbc.workbench-width', '510');
    const host2 = document.createElement('section');
    host2.getBoundingClientRect = () => ({ width: 1600 } as DOMRect);
    document.body.append(host2);
    const pane = document.createElement('aside');
    attachWorkPanelResize(host2, pane);
    expect(host2.style.getPropertyValue('--work-panel-width')).toBe('510px');
    // A legacy value cannot override the authoritative key on a later mount.
    dom.window.localStorage.setItem('chatbbc.work-panel-width', '640');
    const host3 = document.createElement('section');
    host3.getBoundingClientRect = () => ({ width: 1600 } as DOMRect);
    document.body.append(host3);
    attachWorkPanelResize(host3, document.createElement('aside'));
    expect(host3.style.getPropertyValue('--work-panel-width')).toBe('510px');
    expect(dom.window.localStorage.getItem('chatbbc.work-panel-width')).toBeNull();

    pane.querySelector<HTMLElement>('.work-panel-resize')!.dispatchEvent(new dom.window.MouseEvent('dblclick'));
    expect(dom.window.localStorage.getItem('chatbbc.workbench-width')).toBeNull();
  });
});

describe('workbench selection', () => {
  function mount(work: WorkPanel, name: 'files' | 'agents' | 'terminal' | 'inspector' | 'plan' | 'session', beforeReplace?: (selection: { tab: string; ownerKey: string }) => boolean) {
    const root = document.createElement('aside');
    root.hidden = true;
    const show = vi.fn(() => { root.hidden = false; });
    const hide = vi.fn(() => { root.hidden = true; });
    work.register(name, { element: root, show, hide, ...(beforeReplace ? { beforeReplace } : {}) });
    return { root, show, hide };
  }

  it('carries inspector, plan, and session after the original tenants', () => {
    const work = createWorkPanel({ host });
    expect([...work.panel.querySelectorAll<HTMLElement>('[data-work-tab]')].map(node => node.dataset.workTab))
      .toEqual(['files', 'agents', 'terminal', 'inspector', 'plan', 'session']);
  });

  it('preserves editor draft and PTY while switching tenants', () => {
    const work = createWorkPanel({ host });
    const files = mount(work, 'files');
    const terminal = mount(work, 'terminal');
    const agents = mount(work, 'agents');
    const editor = document.createElement('textarea');
    files.root.append(editor);
    const screen = document.createElement('pre');
    terminal.root.append(screen);

    work.select({ tab: 'files', ownerKey: 'project:a' });
    editor.value = 'changed';
    work.select({ tab: 'terminal', ownerKey: 'project:a' });
    screen.textContent = 'echo alive';
    work.select({ tab: 'agents', ownerKey: 'project:a' });
    work.select({ tab: 'files', ownerKey: 'project:a' });
    expect(editor.value).toBe('changed');
    expect(files.root.isConnected).toBe(true);
    work.select({ tab: 'terminal', ownerKey: 'project:a' });
    expect(screen.textContent).toContain('alive');
    expect(terminal.root.isConnected).toBe(true);
    expect(agents.root.isConnected).toBe(true);
  });

  it('closes on Escape and returns focus to the exact trigger', () => {
    const work = createWorkPanel({ host });
    mount(work, 'files');
    const trigger = document.createElement('button');
    host.append(trigger);
    trigger.focus();
    work.select({ tab: 'files', ownerKey: 'project:a' }, trigger);
    expect(work.panel.hidden).toBe(false);
    work.panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(work.panel.hidden).toBe(true);
    expect(dom.window.document.activeElement).toBe(trigger);
  });

  it('uses an overlay below the wide breakpoint and a split at wide width', () => {
    host.getBoundingClientRect = () => ({ width: 800, height: 700, top: 0, left: 0, right: 800, bottom: 700, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    const work = createWorkPanel({ host });
    mount(work, 'files');
    work.select({ tab: 'files', ownerKey: 'project:a' });
    expect(work.panel.classList.contains('is-overlay')).toBe(true);
    host.getBoundingClientRect = () => ({ width: 1400, height: 700, top: 0, left: 0, right: 1400, bottom: 700, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    work.refresh();
    expect(work.panel.classList.contains('is-overlay')).toBe(false);
  });

  it('still switches tabs when a tenant would refuse a different owner', () => {
    const work = createWorkPanel({ host });
    const files = mount(work, 'files', () => false);
    const terminal = mount(work, 'terminal', () => false);
    work.select({ tab: 'files', ownerKey: 'project:a' });
    work.select({ tab: 'terminal', ownerKey: 'project:a' });
    expect(terminal.root.hidden).toBe(false);
    expect(files.root.hidden).toBe(true);
  });

  it('keeps the current owner when the tenant refuses replacement', () => {
    const work = createWorkPanel({ host });
    let allow = false;
    mount(work, 'files', () => allow);
    work.select({ tab: 'files', ownerKey: 'project:a' });
    work.select({ tab: 'files', ownerKey: 'project:b' });
    expect(work.selection()?.ownerKey).toBe('project:a');
    allow = true;
    work.select({ tab: 'files', ownerKey: 'project:b' });
    expect(work.selection()?.ownerKey).toBe('project:b');
  });

  it('hosts the output inspector and follows the studio frame on resize', () => {
    const app = document.createElement('div');
    app.className = 'app';
    host.replaceWith(app);
    app.append(host);
    let studio = 800;
    const box = (width: number) => ({ width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    app.getBoundingClientRect = () => box(studio);
    host.getBoundingClientRect = () => box(420);
    const work = createWorkPanel({ host });
    const button = work.panel.querySelector<HTMLButtonElement>('[data-work-tab="inspector"]')!;
    expect(button.disabled).toBe(false);
    expect(work.panel.querySelector<HTMLButtonElement>('[data-work-tab="plan"]')!.disabled).toBe(true);
    expect(work.panel.querySelector<HTMLButtonElement>('[data-work-tab="session"]')!.disabled).toBe(true);
    work.select({ tab: 'inspector', ownerKey: 'session:A' });
    expect(work.outputInspector.element.hidden).toBe(false);
    expect(work.panel.contains(work.outputInspector.element)).toBe(true);
    expect(work.panel.classList.contains('is-overlay')).toBe(true);
    studio = 1400;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(work.panel.classList.contains('is-overlay')).toBe(false);
  });

  it('rejects an inspector payload from a replaced transcript origin', async () => {
    const { createOutputInspector } = await import('../src/renderer/output-inspector.js');
    const inspector = createOutputInspector();
    inspector.select({ sessionId: 'A', generation: 1, origin: 8 });
    inspector.select({ sessionId: 'B', generation: 2, origin: 1 });
    inspector.resolve(
      { sessionId: 'A', generation: 1, origin: 8 },
      { payloadId: 'late', title: 'from A', kind: 'message' }
    );
    expect(inspector.isEmpty()).toBe(true);
    inspector.resolve(
      { sessionId: 'B', generation: 2, origin: 1 },
      { payloadId: 'live', title: 'from B', kind: 'artifact', detail: 'meta' }
    );
    expect(inspector.isEmpty()).toBe(false);
    expect(inspector.element.textContent).toContain('from B');
    expect(inspector.element.textContent).not.toContain('from A');
    const detail = inspector.element.querySelector('.output-inspector-detail');
    expect(detail?.textContent).toBe('meta');
    expect(detail?.getAttribute('role')).toBe('status');
  });

  it('rejects a stale payload from the same origin', () => {
    const work = createWorkPanel({ host });
    const inspector = work.outputInspector;
    inspector.select({ sessionId: 'A', generation: 1, origin: 8, payloadId: 'keep' });
    inspector.select({ sessionId: 'A', generation: 1, origin: 8, payloadId: 'next' });
    inspector.resolve(
      { sessionId: 'A', generation: 1, origin: 8, payloadId: 'keep' },
      { payloadId: 'keep', title: 'stale', kind: 'image' }
    );
    expect(inspector.isEmpty()).toBe(true);
    inspector.resolve(
      { sessionId: 'A', generation: 1, origin: 8, payloadId: 'next' },
      { payloadId: 'next', title: 'current', kind: 'image' }
    );
    expect(inspector.element.querySelector('.output-inspector-meta')?.textContent).toBe('Image · next');
    expect(inspector.element.textContent).toContain('current');
    expect(inspector.element.textContent).not.toContain('stale');
  });

  it('keeps an overlay workbench from taking a focused rich output', async () => {
    const { createRichFocusStage } = await import('../src/renderer/rich-focus-stage.js');
    const chat = document.createElement('div');
    chat.id = 'chatBody';
    host.append(chat);
    const stage = createRichFocusStage({
      host: () => chat,
      currentSession: () => 'A',
      read: () => ({
        revision: 1, title: 'Sketch', mode: 'artifact', source: '<p>Hello</p>',
        meta: 'm · 1', status: null, preview: document.createElement('p')
      }),
      focusOrigin: () => true,
      focusMessage: () => false
    });
    host.getBoundingClientRect = () => ({ width: 800, height: 700, top: 0, left: 0, right: 800, bottom: 700, x: 0, y: 0, toJSON() { return {}; } }) as DOMRect;
    const work = createWorkPanel({ host });
    const trigger = work.panel.querySelector<HTMLButtonElement>('[data-work-tab="inspector"]')!;
    work.select({ tab: 'inspector', ownerKey: 'session:A' }, trigger);
    expect(work.panel.classList.contains('is-overlay')).toBe(true);
    expect(stage.open({
      sessionId: 'A', logicalMessageId: 'm', nodeId: 'art1', revision: 1, origin: 2
    })).toBe(true);
    expect(work.panel.contains(stage.element)).toBe(false);
    expect(chat.contains(stage.element)).toBe(true);
    const closeButton = stage.element.querySelector<HTMLButtonElement>('.rich-focus-close')!;
    closeButton.focus();
    work.close();
    expect(work.panel.hidden).toBe(true);
    expect(document.activeElement).toBe(closeButton);
    work.panel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(closeButton);
  });
});
