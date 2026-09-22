import { JSDOM } from 'jsdom';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), workspace: vi.fn(), command: true,
  pty: { onData: vi.fn(), onExit: vi.fn(), pause: vi.fn(), resume: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
}));
vi.mock('node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('../src/main/projects.js', () => ({ projectWorkspace: mocks.workspace }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => ({ command: mocks.command }) }));
vi.mock('../src/main/codex/shell.js', () => ({ defaultUserShell: () => ({ shellPath: 'shell', shellType: 'bash' }) }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24; options: { theme?: unknown } = {};
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    dispose(): void {}
    writeln(): void {}
    write(_data: string, done?: () => void): void { done?.(); }
    onData(): { dispose(): void } { return { dispose() {} }; }
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean { return false; }
    getSelection(): string { return ''; }
  }
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
import { WorkspaceTerminals } from '../src/main/workspace-terminal.js';
beforeEach(() => { vi.clearAllMocks(); mocks.command = true; mocks.spawn.mockReturnValue(mocks.pty); mocks.workspace.mockResolvedValue({ real: '/project' }); });

it('captures project cwd and cancels a pending spawn when its tab closes', async () => {
  let resolve!: (value: { real: string }) => void;
  mocks.workspace.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const service = new WorkspaceTerminals(vi.fn());
  const opening = service.create('one', 'project-a', 80, 24); service.close('one');
  resolve({ real: '/project' }); await expect(opening).rejects.toThrow('cancelled'); expect(mocks.spawn).not.toHaveBeenCalled();
  await expect(service.create('two', 'project-a', 80, 24)).resolves.toMatchObject({ cwd: '/project' });
  expect(mocks.spawn).toHaveBeenCalledWith('shell', [], expect.objectContaining({ cwd: '/project', cols: 80, rows: 24 }));
  service.dispose(); expect(mocks.pty.kill).toHaveBeenCalledOnce();
});
it('rechecks command permission and original project identity before interactive input', async () => {
  const service = new WorkspaceTerminals(vi.fn()); await service.create('one', 'project-a', 80, 24);
  mocks.command = false; await expect(service.write('one', 'rm file\r')).rejects.toThrow('disabled');
  mocks.command = true; mocks.workspace.mockResolvedValue({ real: '/other' });
  await expect(service.write('one', 'pwd\r')).rejects.toThrow('changed'); expect(mocks.pty.write).not.toHaveBeenCalled();
  service.dispose();
});
it('pauses output until xterm has parsed it and releases exited or disposed terminals', async () => {
  const emit = vi.fn(), service = new WorkspaceTerminals(emit); await service.create('one', 'project-a', 80, 24);
  const data = mocks.pty.onData.mock.calls[0]![0]; data('a'.repeat(262_144));
  expect(emit).toHaveBeenCalledTimes(16); expect(mocks.pty.pause).toHaveBeenCalledOnce();
  service.acknowledge('one', 262_144); expect(mocks.pty.resume).toHaveBeenCalledOnce();
  mocks.pty.onExit.mock.calls[0]![0]({ exitCode: 7 }); expect(emit).toHaveBeenLastCalledWith({ id: 'one', exitCode: 7 });
  await expect(service.write('one', 'echo x')).rejects.toThrow('closed');
  service.dispose(); expect(mocks.pty.kill).not.toHaveBeenCalled();
});
it('bounds active plus pending tabs and prevents spawn after renderer retirement', async () => {
  const service = new WorkspaceTerminals(vi.fn());
  for (let index = 0; index < 8; index++) await service.create(String(index), 'project-a', 80, 24);
  await expect(service.create('ninth', 'project-a', 80, 24)).rejects.toThrow('maximum 8');
  service.dispose(); expect(mocks.pty.kill).toHaveBeenCalledTimes(8);
});

it('keeps the open shell when the renderer project changes', async () => {
  const dom = new JSDOM('<div class="app"></div><button id="headerConnect"></button>', { url: 'https://cos.local/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  const closed: string[] = [];
  Object.assign(dom.window, {
    api: {
      terminalCreate: async () => ({ ok: true, data: { shell: 'bash', cwd: '/project' } }),
      terminalWrite: async () => ({ ok: true }),
      terminalResize: async () => ({ ok: true }),
      terminalAck: async () => ({ ok: true }),
      terminalClose: async (id: string) => { closed.push(id); return { ok: true }; },
      onTerminalEvent: () => () => undefined,
      writeClipboard: async () => ({ ok: true, data: true })
    }
  });
  const { createWorkspaceTerminal } = await import('../src/renderer/workspace-terminal.js');
  const host = dom.window.document.querySelector<HTMLElement>('.app')!;
  const terminal = createWorkspaceTerminal({ host });
  const project = { id: '11111111-1111-4111-8111-111111111111', name: 'alpha', path: '/alpha', createdAt: 1 };
  const other = { id: '22222222-2222-4222-8222-222222222222', name: 'beta', path: '/beta', createdAt: 2 };
  terminal.update(project);
  terminal.show();
  await new Promise(resolve => setTimeout(resolve, 0));
  const screen = terminal.element.querySelector('.terminal-screen');
  expect(screen).not.toBeNull();
  expect(terminal.beforeReplace({ tab: 'terminal', ownerKey: other.id })).toBe(true);
  terminal.update(other);
  expect(terminal.element.querySelector('.terminal-screen')).toBe(screen);
  expect(closed).toEqual([]);
  dom.window.close();
});
