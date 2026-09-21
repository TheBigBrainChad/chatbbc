import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const html = () => fs.readFile(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

describe('settings navigation', () => {
  it('offers exactly five destinations', async () => {
    const text = await html();
    const tabs = [...text.matchAll(/data-tab="([a-z-]+)"/g)].map(m => m[1]);
    expect(tabs.sort()).toEqual(['activity', 'appearance', 'automation', 'usage', 'workspace']);
  });

  it('keeps Setup reachable without being a nav peer', async () => {
    const text = await html();
    expect(text).not.toContain('data-tab="setup"');
    expect(text).toContain('data-panel="setup"'); // the wizard page still exists
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

  it('migrates the sidebar width into one navigator preference and leaves the old key', async () => {
    const dom = new JSDOM(await html(), { url: 'https://cos.local/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    dom.window.localStorage.setItem('chatbbc.sidebar-width', '360');
    const { initSidebarResize } = await import('../src/renderer/sidebar-resize.js');
    initSidebarResize();
    expect(dom.window.localStorage.getItem('chatbbc.navigator-width')).toBe('360');
    expect(dom.window.localStorage.getItem('chatbbc.sidebar-width')).toBe('360');
    dom.window.close();
    vi.unstubAllGlobals();
  });
});
