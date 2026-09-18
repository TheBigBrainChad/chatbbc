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
      .toEqual(['files', 'agents', 'terminal']);
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
    expect(mounted).toEqual([files.root, agents.root, terminal.root]);
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
    expect(dom.window.localStorage.getItem('chatbbc.work-panel-width')).toBe('700');
  });
});
