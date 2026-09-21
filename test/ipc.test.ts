/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RichActionRecord } from '../src/main/rich-actions.js';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, getConfig, initConfigPath, saveConfig, updateConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { appendEvent, createSession, initSessionStore, rebindSession, resetSessionStoreForTests, upsertMessageEvent, upsertRichMedia, upsertRichMessage } = await import('../src/main/session/store.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { pendingCommands, resetBridgeForTests, setBrowserOpener, startBridge, stopBridge } = await import(
  '../src/main/bridge.js'
);
const {
  bindConversation,
  finishAgent,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  snapshotRetiredWorkers,
  snapshotSwarm,
  spawn,
  swarmStateForCaller
} = await import('../src/main/agents.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { openInPreferredBrowser } = await import('../src/main/browser.js');
const { app, nativeTheme, safeStorage, shell, dialog } = await import('electron');
const { extensionDownloadUrl } = await import('../src/main/version.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} | null = null;
/** How many times the IPC layer asked the app to quit so a staged update can be applied. */
let quitToInstallCalls = 0;

const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(null, { patch, base }) as Promise<any>;
const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(null, payload) as Promise<any>;
const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(null, payload) as Promise<any>;
const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(null, payload) as Promise<any>;
const sessionList = (): Promise<any> => handlers.get('sessions:list')!(null, undefined) as Promise<any>;

function selectionWindow() {
  const mainFrame = {
    url: pathToFileURL(path.join(process.cwd(), 'src/renderer/index.html')).href,
    processId: 101, routingId: 7
  };
  const webContents = Object.assign(new EventEmitter(), {
    send: vi.fn(), mainFrame, getURL: () => mainFrame.url, isDestroyed: () => false,
    isLoadingMainFrame: () => true
  });
  const window = Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => false, isVisible: () => true,
    setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn()
  });
  currentWindow = window as any;
  return { window, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame } };
}

describe('main-owned, inert UI selection witness', () => {
  it('requires the exact current window/main frame, issues independent generations and never uses last activity', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const first = await createSession({ title: 'witness A', conversationId: 'selection-a' });
    const second = await createSession({ title: 'witness B', conversationId: 'selection-b' });
    const { event, webContents, mainFrame, window } = selectionWindow();
    const report = (sessionId: string | null, rendererGeneration: number, invokeEvent: unknown = event) =>
      handlers.get('sessions:uiSelection')!(invokeEvent, { sessionId, rendererGeneration }) as Promise<any>;
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect((await sessionList()).data.activeId).not.toEqual(currentUiSelectionFor(webContents as any)?.sessionId);
    const a = await report(first.id, 1);
    expect(a).toMatchObject({ ok: true, data: { sessionId: first.id, generation: expect.any(Number) } });
    expect(currentUiSelectionFor(webContents as any)).toEqual(a.data);
    const b = await report(second.id, 2);
    const back = await report(first.id, 3);
    const same = await report(first.id, 4);
    const empty = await report(null, 5);
    const again = await report(first.id, 6);
    expect([a, b, back, same, empty, again].map(reply => reply.data.generation)).toEqual(
      [...new Set([a, b, back, same, empty, again].map(reply => reply.data.generation))].sort((x, y) => x - y)
    );
    expect(currentUiSelectionFor(webContents as any)).toEqual(again.data);
    expect((await report(second.id, 5)).ok).toBe(false);
    expect((await report(first.id, 6)).ok).toBe(false);
    expect(currentUiSelectionFor(webContents as any)).toEqual(again.data);
    expect((await report(second.id, 7, { sender: webContents, senderFrame: {} })).ok).toBe(false);
    expect((await report(second.id, 7, { sender: {}, senderFrame: mainFrame })).ok).toBe(false);
    expect(currentUiSelectionFor(webContents as any)).toEqual(again.data);
    const changedURL = mainFrame.url;
    mainFrame.url = 'https://foreign.example/';
    expect((await report(second.id, 7)).ok).toBe(false);
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    mainFrame.url = changedURL;
    expect(currentUiSelectionFor(webContents as any)).toBeNull(); // A restored URL cannot resurrect the old witness.
    const foreign = selectionWindow();
    currentWindow = window as any;
    expect((await report(second.id, 7, foreign.event)).ok).toBe(false);
    expect(currentUiSelectionFor(foreign.webContents as any)).toBeNull();
    const replaced = selectionWindow();
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect((await report(second.id, 7)).ok).toBe(false);
    expect(currentUiSelectionFor(replaced.webContents as any)).toBeNull();
  });

  it('rejects malformed, unknown and deleted sessions, and revokes exact deletion without renderer cooperation', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const session = await createSession({ title: 'delete witness' });
    const other = await createSession({ title: 'unrelated deletion' });
    const { event, webContents } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    expect(await handler(event, { sessionId: session.id, rendererGeneration: -1 })).toMatchObject({ ok: false });
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 1, action: 'grant' })).toMatchObject({ ok: false });
    expect(await handler(event, { sessionId: 'missing00', rendererGeneration: 1 })).toMatchObject({ ok: false });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 2 })).toMatchObject({ ok: true });
    expect(await handler(event, { sessionId: other.id, rendererGeneration: 3, action: 'grant' })).toMatchObject({ ok: false });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 4 })).toMatchObject({ ok: true });
    expect(await handlers.get('sessions:delete')!(null, { id: other.id })).toMatchObject({ ok: true });
    expect(currentUiSelectionFor(webContents as any)?.sessionId).toBe(session.id);
    expect(await handlers.get('sessions:delete')!(null, { id: session.id })).toMatchObject({ ok: true });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 5 })).toMatchObject({ ok: false });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
  });

  it('invalidates synchronously before lookup and rejects out-of-order A→B→A completions and failed B', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const store = await import('../src/main/session/store.js');
    const a = await createSession({ title: 'race A' });
    const b = await createSession({ title: 'race B' });
    const { event, webContents } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    let release!: (value: Awaited<ReturnType<typeof store.getSession>>) => void;
    const original = store.getSession;
    const spy = vi.spyOn(store, 'getSession').mockImplementation(id => id === a.id && !release
      ? new Promise(resolve => { release = resolve; }) : original(id));
    try {
      const old = handler(event, { sessionId: a.id, rendererGeneration: 1 });
      expect(currentUiSelectionFor(webContents as any)).toBeNull();
      const winner = await handler(event, { sessionId: b.id, rendererGeneration: 2 }) as any;
      expect(winner).toMatchObject({ ok: true, data: { sessionId: b.id } });
      const back = await handler(event, { sessionId: a.id, rendererGeneration: 3 }) as any;
      expect(back).toMatchObject({ ok: true, data: { sessionId: a.id } });
      expect(back.data.generation).toBeGreaterThan(winner.data.generation);
      release(await original(a.id));
      expect(await old).toMatchObject({ ok: false });
      expect(currentUiSelectionFor(webContents as any)).toEqual(back.data);
      expect(await handler(event, { sessionId: 'unknown0', rendererGeneration: 4 })).toMatchObject({ ok: false });
      expect(currentUiSelectionFor(webContents as any)).toBeNull();
      expect(await handler(event, { sessionId: a.id, rendererGeneration: 5 })).toMatchObject({ ok: true });
    } finally { spy.mockRestore(); }
  });

  it('revokes a report that arrives while exact session deletion is still awaiting disk', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const store = await import('../src/main/session/store.js');
    const session = await createSession({ title: 'delete while reporting' });
    const { event, webContents } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 1 })).toMatchObject({ ok: true });
    const original = store.deleteSession;
    let finishDelete!: () => void;
    const spy = vi.spyOn(store, 'deleteSession').mockImplementation(id => id === session.id
      ? new Promise(resolve => { finishDelete = () => void original(id).then(resolve); }) : original(id));
    try {
      const pendingDelete = handlers.get('sessions:delete')!(null, { id: session.id });
      await vi.waitFor(() => expect(finishDelete).toBeTypeOf('function'));
      expect(currentUiSelectionFor(webContents as any)).toBeNull();
      expect(await handler(event, { sessionId: session.id, rendererGeneration: 2 })).toMatchObject({ ok: true });
      expect(currentUiSelectionFor(webContents as any)?.sessionId).toBe(session.id);
      finishDelete();
      expect(await pendingDelete).toMatchObject({ ok: true });
      expect(currentUiSelectionFor(webContents as any)).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('suspends a main-frame navigation before loading and accepts only the new app frame after reload', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const session = await createSession({ title: 'navigation boundary' });
    const { webContents, mainFrame, event } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    const original = await handler(event, { sessionId: session.id, rendererGeneration: 1 }) as any;
    expect(original.ok).toBe(true);
    // Electron announces navigation before a loading event or change to getURL(). The old
    // document must not resurrect itself by sending one more valid, increasing sequence.
    webContents.emit('did-start-navigation', {
      url: mainFrame.url, isSameDocument: false, isMainFrame: true, frame: mainFrame
    });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 2 })).toMatchObject({ ok: false });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    // An in-page completion does not finish an outside-document navigation, even if it
    // advertises the same app URL and the outgoing frame's real routing identity.
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 3 })).toMatchObject({ ok: false });
    webContents.emit('did-start-loading');
    const newFrame = { url: mainFrame.url, processId: 102, routingId: 8 };
    webContents.mainFrame = newFrame;
    (webContents as any).isLoadingMainFrame = () => false;
    webContents.emit('did-finish-load');
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 3 })).toMatchObject({ ok: false });
    const recovered = await handler({ sender: webContents, senderFrame: newFrame },
      { sessionId: session.id, rendererGeneration: 0 }) as any;
    expect(recovered).toMatchObject({ ok: true, data: { sessionId: session.id } });
    expect(recovered.data.generation).toBeGreaterThan(original.data.generation);
    expect(currentUiSelectionFor(webContents as any)).toEqual(recovered.data);
  });

  it('reopens only fresh reports after verified same-document main-frame navigation, never its old witness', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const a = await createSession({ title: 'in-page A' });
    const b = await createSession({ title: 'in-page B' });
    const { window, webContents, mainFrame, event } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    const first = await handler(event, { sessionId: a.id, rendererGeneration: 1 }) as any;
    expect(first).toMatchObject({ ok: true, data: { sessionId: a.id } });
    const report = (sessionId: string, rendererGeneration: number, invokeEvent: unknown = event) =>
      handler(invokeEvent, { sessionId, rendererGeneration }) as Promise<any>;

    // Electron delivers did-start-navigation then did-navigate-in-page for a same-document
    // transition. There is NO did-start-loading, provisional abort, or replaced mainFrame.
    (webContents as any).isLoadingMainFrame = () => false;
    webContents.emit('did-start-navigation', {
      url: mainFrame.url, isSameDocument: true, isMainFrame: true, frame: mainFrame
    });
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    expect(await report(b.id, 2)).toMatchObject({ ok: false }); // Old frame cannot report early.
    expect(currentUiSelectionFor(webContents as any)).toBeNull();

    // A subframe completion, foreign contents, wrong routing identity and wrong URL must
    // not make the pending transition reportable. The URL comes only from Electron.
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, false, mainFrame.processId, mainFrame.routingId);
    expect(await report(b.id, 3)).toMatchObject({ ok: false });
    const foreign = selectionWindow();
    currentWindow = window as any;
    foreign.webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
    expect(await report(b.id, 4)).toMatchObject({ ok: false });
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId + 1, mainFrame.routingId);
    expect(await report(b.id, 4)).toMatchObject({ ok: false });
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId + 1);
    expect(await report(b.id, 5)).toMatchObject({ ok: false });
    webContents.emit('did-navigate-in-page', {}, 'https://foreign.example/', true, mainFrame.processId, mainFrame.routingId);
    expect(await report(b.id, 6)).toMatchObject({ ok: false });
    webContents.mainFrame = { ...mainFrame };
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
    expect(await report(b.id, 6)).toMatchObject({ ok: false });
    webContents.mainFrame = mainFrame;

    expect(webContents.mainFrame).toBe(mainFrame);
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
    expect(currentUiSelectionFor(webContents as any)).toBeNull(); // Completion never restores A.
    expect(await report(a.id, 1)).toMatchObject({ ok: false }); // No renderer sequence reset.
    const second = await report(b.id, 7);
    expect(second).toMatchObject({ ok: true, data: { sessionId: b.id } });
    expect(second.data.generation).toBeGreaterThan(first.data.generation);
    const back = await report(a.id, 8);
    expect(back).toMatchObject({ ok: true, data: { sessionId: a.id } });
    expect(back.data.generation).toBeGreaterThan(second.data.generation);
    expect(currentUiSelectionFor(webContents as any)).toEqual(back.data);
  });

  it('cannot publish an in-flight old A report after same-document A→B→A completion', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const store = await import('../src/main/session/store.js');
    const a = await createSession({ title: 'in-page pending A' });
    const b = await createSession({ title: 'in-page pending B' });
    const { webContents, mainFrame, event } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    expect(await handler(event, { sessionId: a.id, rendererGeneration: 1 })).toMatchObject({ ok: true });
    let release!: (value: Awaited<ReturnType<typeof store.getSession>>) => void;
    const original = store.getSession;
    const spy = vi.spyOn(store, 'getSession').mockImplementation(id => id === a.id && !release
      ? new Promise(resolve => { release = resolve; }) : original(id));
    try {
      const pendingA = handler(event, { sessionId: a.id, rendererGeneration: 2 });
      expect(currentUiSelectionFor(webContents as any)).toBeNull();
      (webContents as any).isLoadingMainFrame = () => false;
      webContents.emit('did-start-navigation', {
        url: mainFrame.url, isSameDocument: true, isMainFrame: true, frame: mainFrame
      });
      expect(await handler(event, { sessionId: b.id, rendererGeneration: 3 })).toMatchObject({ ok: false });
      webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
      const winnerB = await handler(event, { sessionId: b.id, rendererGeneration: 4 }) as any;
      expect(winnerB).toMatchObject({ ok: true, data: { sessionId: b.id } });
      const winnerA = await handler(event, { sessionId: a.id, rendererGeneration: 5 }) as any;
      expect(winnerA).toMatchObject({ ok: true, data: { sessionId: a.id } });
      release(await original(a.id));
      expect(await pendingA).toMatchObject({ ok: false });
      expect(currentUiSelectionFor(webContents as any)).toEqual(winnerA.data);
      expect(winnerA.data.generation).toBeGreaterThan(winnerB.data.generation);
    } finally { spy.mockRestore(); }
  });

  it('ignores subframe navigation and never retires the current main-frame witness', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const session = await createSession({ title: 'subframe navigation' });
    const { webContents, mainFrame, event } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    const original = await handler(event, { sessionId: session.id, rendererGeneration: 1 }) as any;
    expect(original.ok).toBe(true);
    webContents.emit('did-start-navigation', {
      url: 'https://embedded.example/', isSameDocument: false, isMainFrame: false,
      frame: { url: 'https://embedded.example/' }
    });
    expect(currentUiSelectionFor(webContents as any)).toEqual(original.data);
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 2 })).toMatchObject({ ok: true });
    expect(webContents.mainFrame).toBe(mainFrame);
  });

  it('recovers a canceled main-frame navigation only after exact abort and old-frame readiness', async () => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const session = await createSession({ title: 'canceled navigation' });
    const { webContents, mainFrame, event } = selectionWindow();
    const handler = handlers.get('sessions:uiSelection')!;
    const original = await handler(event, { sessionId: session.id, rendererGeneration: 1 }) as any;
    expect(original.ok).toBe(true);
    webContents.emit('did-start-navigation', {
      url: 'https://external.example/', isSameDocument: false, isMainFrame: true, frame: mainFrame
    });
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 2 })).toMatchObject({ ok: false });
    // A stop-loading event alone is not proof that the external navigation was canceled.
    (webContents as any).isLoadingMainFrame = () => false;
    webContents.emit('did-stop-loading');
    expect(await handler(event, { sessionId: session.id, rendererGeneration: 3 })).toMatchObject({ ok: false });
    // Electron's aborted provisional load retains the original current app frame. No prior
    // witness is restored; a fresh selection report must validate this same frame again.
    webContents.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED',
      'https://external.example/', true, 1, 1);
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    const recovered = await handler(event, { sessionId: session.id, rendererGeneration: 4 }) as any;
    expect(recovered).toMatchObject({ ok: true, data: { sessionId: session.id } });
    expect(recovered.data.generation).toBeGreaterThan(original.data.generation);
  });

  it.each(['hide', 'did-start-loading', 'render-process-gone', 'destroyed', 'closed'])('revokes the original window on %s', async lifecycle => {
    const { currentUiSelectionFor } = await import('../src/main/ui-selection.js');
    const session = await createSession({ title: `lifecycle ${lifecycle}` });
    const { window, webContents, event } = selectionWindow();
    expect(await handlers.get('sessions:uiSelection')!(event, { sessionId: session.id, rendererGeneration: 1 })).toMatchObject({ ok: true });
    if (lifecycle === 'hide' || lifecycle === 'closed') window.emit(lifecycle);
    else webContents.emit(lifecycle);
    expect(currentUiSelectionFor(webContents as any)).toBeNull();
    if (lifecycle === 'did-start-loading') {
      webContents.emit('did-finish-load');
      expect(await handlers.get('sessions:uiSelection')!(event, { sessionId: session.id, rendererGeneration: 0 })).toMatchObject({ ok: true });
    }
    if (lifecycle === 'hide') {
      const restored = await handlers.get('sessions:uiSelection')!(event, { sessionId: session.id, rendererGeneration: 2 });
      expect(restored).toMatchObject({ ok: true });
    }
  });
});

const RICH_PENDING = '11111111-2222-4333-8444-555555555555';
const RICH_UNKNOWN = '22222222-3333-4444-8555-666666666666';
const RICH_RECEIPT = '33333333-4444-4555-8666-777777777777';
const RICH_FOREIGN = '55555555-6666-4777-8888-999999999999';
const RICH_UNAVAILABLE = { ok: true, data: {
  id: null, state: 'unavailable', detail: 'Native interaction unavailable'
} };

/** Synthetic existing custody only: no production action ever creates these rows. */
async function seedStatusRows(sessionId: string): Promise<string> {
  const { resetRichActionsForTests } = await import('../src/main/rich-actions.js');
  const base: RichActionRecord = {
    id: RICH_PENDING, phase: 'intent', createdAt: 1789776000000, claimOwner: null,
    sessionId, conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', bindingRevision: 1,
    messageId: 'assistant:turn:1', providerMessageId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    revision: 1, nodeId: 'node-1', groupId: 'group-1', kind: 'select', value: 'Forest',
    expectedSelected: false, expectedGroupSelection: null, tabId: null,
    documentId: null, navigationEpoch: null, openingSpent: false, resultDetail: null
  };
  const dispatched: RichActionRecord = {
    ...base, id: RICH_UNKNOWN, phase: 'may_have_dispatched', claimOwner: 'a'.repeat(64),
    groupId: 'group-2', tabId: 42, documentId: 'doc-1', navigationEpoch: 7
  };
  const retired: RichActionRecord = {
    ...dispatched, id: RICH_RECEIPT, phase: 'retired', groupId: 'group-3',
    resultDetail: 'Synthetic receipt only'
  };
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  await writeDurableNow('rich-actions', { version: 1, actions: [base, dispatched, retired], receipts: [
    { id: RICH_RECEIPT, state: 'observed', detail: 'Synthetic receipt only' }
  ] });
  resetRichActionsForTests();
  return path.join(dir, 'state', 'rich-actions.json');
}

describe('sender-bound, strictly read-only rich action status IPC', () => {
  const status = (event: unknown, payload: unknown): Promise<any> =>
    handlers.get('sessions:richActionStatus')!(event, payload) as Promise<any>;
  const request = (sessionId: string, actionId = RICH_PENDING) => ({ sessionId, actionId });
  const select = (event: unknown, sessionId: string | null, rendererGeneration: number): Promise<any> =>
    handlers.get('sessions:uiSelection')!(event, { sessionId, rendererGeneration }) as Promise<any>;

  afterEach(async () => {
    vi.restoreAllMocks();
    (await import('../src/main/rich-actions.js')).resetRichActionsForTests();
  });

  it('registers exactly the status reader, not a generic or native-action/opener channel', () => {
    expect(handlers.has('sessions:richActionStatus')).toBe(true);
    expect(handlers.has('sessions:richAction')).toBe(false);
    expect(handlers.has('sessions:richOpenOriginal')).toBe(true); // Manual history navigation, not native action.
  });

  it('reads only selected, existent local-session pending/unknown and synthetic persisted receipt without rewriting custody', async () => {
    const session = await createSession({ title: 'read-only status owner' });
    const other = await createSession({ title: 'foreign status owner' });
    const file = await seedStatusRows(session.id);
    const { event, webContents } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    vi.mocked(openInPreferredBrowser).mockClear();
    const before = await fs.readFile(file);
    expect(await status(event, request(session.id))).toEqual({ ok: true, data: {
      id: RICH_PENDING, state: 'pending', detail: null
    } });
    expect(await status(event, request(session.id, RICH_UNKNOWN))).toEqual({ ok: true, data: {
      id: RICH_UNKNOWN, state: 'unknown', detail: 'Outcome unconfirmed; no repeat authorized'
    } });
    expect(await status(event, request(session.id, RICH_RECEIPT))).toEqual({ ok: true, data: {
      id: RICH_RECEIPT, state: 'observed', detail: 'Synthetic receipt only'
    } });
    expect(await status(event, request(session.id, RICH_PENDING))).toMatchObject({ ok: true, data: { state: 'pending' } });
    expect(await fs.readFile(file)).toEqual(before);
    expect((await import('../src/main/ui-selection.js')).currentUiSelectionFor(webContents as any)?.sessionId).toBe(session.id);
    expect(openInPreferredBrowser).not.toHaveBeenCalled();
    // The same app-frame witness cannot use a different local session, even with a known ID.
    expect(await status(event, request(other.id, RICH_RECEIPT))).toEqual(RICH_UNAVAILABLE);
    expect(await status(event, request(session.id, RICH_FOREIGN))).toEqual(RICH_UNAVAILABLE);
  });

  it('rejects unknown payload keys, missing IDs and malformed UUIDs without invoking the ledger', async () => {
    const session = await createSession({ title: 'status schema' });
    await seedStatusRows(session.id);
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    const actions = await import('../src/main/rich-actions.js');
    const read = vi.spyOn(actions, 'readRichActionStatus');
    for (const payload of [null, {}, { sessionId: session.id }, request(session.id, 'not-uuid'),
      { ...request(session.id), url: 'https://chatgpt.com' },
      { ...request(session.id), action: 'arm' },
      { ...request(session.id), sessionId: 'A'.repeat(65) }]) {
      expect(await status(event, payload)).toEqual({ ok: false, error: 'Invalid input' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses foreign sender, subframe, dead/replaced window, hidden app, null selection and unselected history preview', async () => {
    const a = await createSession({ title: 'current status A' });
    const b = await createSession({ title: 'history preview B' });
    await seedStatusRows(a.id);
    const { event, webContents, mainFrame, window } = selectionWindow();
    expect(await status(event, request(a.id))).toEqual(RICH_UNAVAILABLE); // No witness from activeId.
    expect(await select(event, a.id, 1)).toMatchObject({ ok: true });
    expect(await status({ sender: {}, senderFrame: mainFrame }, request(a.id))).toEqual(RICH_UNAVAILABLE);
    expect(await status({ sender: webContents, senderFrame: {} }, request(a.id))).toEqual(RICH_UNAVAILABLE);
    expect(await status(null, request(a.id))).toEqual(RICH_UNAVAILABLE);
    expect(await status(event, request(b.id))).toEqual(RICH_UNAVAILABLE);
    (window as any).isVisible = () => false;
    expect(await status(event, request(a.id))).toEqual(RICH_UNAVAILABLE);
    (window as any).isVisible = () => true;
    expect(await select(event, null, 2)).toMatchObject({ ok: true });
    expect(await status(event, request(a.id))).toEqual(RICH_UNAVAILABLE);
    expect(await select(event, a.id, 3)).toMatchObject({ ok: true });
    const previous = currentWindow;
    const replaced = selectionWindow();
    expect(await status(event, request(a.id))).toEqual(RICH_UNAVAILABLE);
    currentWindow = previous;
    expect(await status(replaced.event, request(a.id))).toEqual(RICH_UNAVAILABLE);
    (window as any).isDestroyed = () => true;
    expect(await status(event, request(a.id))).toEqual(RICH_UNAVAILABLE);
  });

  it('revokes old status after main-frame navigation, pending selection and exact deletion', async () => {
    const session = await createSession({ title: 'status lifecycle' });
    await seedStatusRows(session.id);
    const { event, webContents, mainFrame } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    webContents.emit('did-start-navigation', {
      url: mainFrame.url, isSameDocument: true, isMainFrame: true, frame: mainFrame
    });
    expect(await status(event, request(session.id))).toEqual(RICH_UNAVAILABLE);
    (webContents as any).isLoadingMainFrame = () => false;
    webContents.emit('did-navigate-in-page', {}, mainFrame.url, true, mainFrame.processId, mainFrame.routingId);
    expect(await status(event, request(session.id))).toEqual(RICH_UNAVAILABLE); // Completion does not restore selection.
    expect(await select(event, session.id, 2)).toMatchObject({ ok: true });
    expect(await handlers.get('sessions:delete')!(null, { id: session.id })).toMatchObject({ ok: true });
    expect(await status(event, request(session.id))).toEqual(RICH_UNAVAILABLE);
    expect(await select(event, session.id, 3)).toMatchObject({ ok: false });
    expect(await status(event, request(session.id))).toEqual(RICH_UNAVAILABLE);
  });

  it('rechecks real session existence even when the selection witness remains', async () => {
    const store = await import('../src/main/session/store.js');
    const session = await createSession({ title: 'externally removed status owner' });
    await seedStatusRows(session.id);
    const { event, webContents } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    await store.deleteSession(session.id); // Bypass the ordinary IPC's proactive witness revocation.
    expect((await import('../src/main/ui-selection.js')).currentUiSelectionFor(webContents as any)?.sessionId).toBe(session.id);
    expect(await status(event, request(session.id, RICH_RECEIPT))).toEqual(RICH_UNAVAILABLE);
  });

  it('does not disclose an unsupported or removed action ledger', async () => {
    const session = await createSession({ title: 'unsupported status ledger' });
    const file = await seedStatusRows(session.id);
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    const actions = await import('../src/main/rich-actions.js');
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    // Retry Capture intentionally introduced strict v2 as a compatible union;
    // v3 remains unsupported and must never disclose the old control receipt.
    await fs.writeFile(file, JSON.stringify({ ...original, version: 3 }));
    actions.resetRichActionsForTests();
    expect(await status(event, request(session.id, RICH_RECEIPT))).toEqual(RICH_UNAVAILABLE);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(3);
    await fs.rm(file);
    actions.resetRichActionsForTests();
    expect(await status(event, request(session.id, RICH_RECEIPT))).toEqual(RICH_UNAVAILABLE);
    expect(await fs.readdir(path.dirname(file))).not.toContain('rich-actions.json');
  });

  it('discards a status lookup started at old A after A→B→A reselects the same ID with a newer main generation', async () => {
    const store = await import('../src/main/session/store.js');
    const a = await createSession({ title: 'stale status A' });
    const b = await createSession({ title: 'stale status B' });
    await seedStatusRows(a.id);
    const { event } = selectionWindow();
    expect(await select(event, a.id, 1)).toMatchObject({ ok: true });
    const original = store.getSession;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(store, 'getSession').mockImplementation(id => id === a.id && !release
      ? new Promise(resolve => { release = () => void original(id).then(resolve); entered(); }) : original(id));
    try {
      const stale = status(event, request(a.id));
      await reached;
      expect(await select(event, b.id, 2)).toMatchObject({ ok: true });
      expect(await select(event, a.id, 3)).toMatchObject({ ok: true });
      release();
      expect(await stale).toEqual(RICH_UNAVAILABLE);
      expect(await status(event, request(a.id))).toMatchObject({ ok: true, data: { id: RICH_PENDING, state: 'pending' } });
    } finally { held.mockRestore(); }
  });

  it('discards a stale receipt after the awaited ledger read even when A→B→A ends on the same session', async () => {
    const actions = await import('../src/main/rich-actions.js');
    const a = await createSession({ title: 'ledger-await A' });
    const b = await createSession({ title: 'ledger-await B' });
    await seedStatusRows(a.id);
    const { event } = selectionWindow();
    expect(await select(event, a.id, 1)).toMatchObject({ ok: true });
    const original = actions.readRichActionStatus;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(actions, 'readRichActionStatus').mockImplementation(async (...args) => {
      const result = await original(...args);
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return result;
    });
    try {
      const stale = status(event, request(a.id, RICH_RECEIPT));
      await reached;
      expect(await select(event, b.id, 2)).toMatchObject({ ok: true });
      expect(await select(event, a.id, 3)).toMatchObject({ ok: true });
      release();
      expect(await stale).toEqual(RICH_UNAVAILABLE);
    } finally { held.mockRestore(); }
  });

  it('does not disclose a receipt if a store-owned deletion completed during its awaited ledger read', async () => {
    const store = await import('../src/main/session/store.js');
    const actions = await import('../src/main/rich-actions.js');
    const session = await createSession({ title: 'deleted during rich read' });
    await seedStatusRows(session.id);
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    const original = actions.readRichActionStatus;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(actions, 'readRichActionStatus').mockImplementation(async (...args) => {
      const result = await original(...args);
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return result;
    });
    try {
      const pending = status(event, request(session.id, RICH_RECEIPT));
      await reached;
      await store.deleteSession(session.id); // Store also deletes empty abandoned input reservations.
      release();
      expect(await pending).toEqual(RICH_UNAVAILABLE);
    } finally { held.mockRestore(); }
  });

  it('does not disclose a synthetic receipt when its session was removed or the ledger is corrupt', async () => {
    const session = await createSession({ title: 'removed status' });
    const file = await seedStatusRows(session.id);
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    await fs.writeFile(file, '{bad ledger');
    (await import('../src/main/rich-actions.js')).resetRichActionsForTests();
    expect(await status(event, request(session.id, RICH_RECEIPT))).toEqual(RICH_UNAVAILABLE);
    expect(await fs.readFile(file, 'utf8')).toBe('{bad ledger');
  });
});

describe('selected-session, read-only PAGE retry eligibility IPC', () => {
  const messageId = 'assistant:working:exchange:1789552000000';
  const providerMessageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const mediaId = 'card-image-b';
  const nodeId = 'image-node-b';
  const retry = (event: unknown, payload: unknown): Promise<any> =>
    handlers.get('sessions:richRetryEligibility')!(event, payload) as Promise<any>;
  const request = (sessionId: string, richRevision = 1) =>
    ({ sessionId, messageId, mediaId, nodeId, richRevision });
  const select = (event: unknown, sessionId: string | null, rendererGeneration: number): Promise<any> =>
    handlers.get('sessions:uiSelection')!(event, { sessionId, rendererGeneration }) as Promise<any>;
  async function page(kind: 'page' | 'native' = 'page') {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'PAGE retry eligibility', conversationId });
    const text = 'A diagram follows.';
    const origin = { conversationId, bindingRevision: 0, documentId: 'document-a', navigationEpoch: 1 };
    const media = { mediaId, nodeId, source: kind === 'page'
      ? { kind: 'page' as const, nodeId }
      : { kind: 'native' as const, providerMessageId, providerAssetId: 'generated-asset-one' },
      status: 'pending' as const };
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId, providerMessageId, message: { text, chars: text.length, truncated: false }, final: true });
    expect(await upsertRichMessage(session.id, messageId, {
      version: 1, status: 'available', reason: null, conversationId, messageId,
      providerMessageId, revision: 0, accessibleText: text,
      nodes: [{ kind: 'image', id: nodeId, mediaId, alt: 'Reference', width: 800, height: 600 }]
    }, origin)).toBe('stored');
    expect(await upsertRichMedia(session.id, messageId, media, origin, 1)).toBe('stored');
    return { session, origin, media };
  }

  afterEach(() => vi.restoreAllMocks());

  it('returns only inert PAGE display metadata without granting capture, opening, or rewriting the assistant shard', async () => {
    const { session } = await page();
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    vi.mocked(openInPreferredBrowser).mockClear();
    const shard = path.join(dir, 'sessions', session.id, 'messages',
      (await import('node:crypto')).createHash('sha256').update(`assistant_message\u0000${messageId}`).digest('hex') + '.json');
    const before = await fs.readFile(shard);
    const ledger = path.join(dir, 'state', 'rich-actions.json');
    const beforeLedger = await fs.readFile(ledger).catch(() => null);
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: {
      status: 'pending', reason: null, requiresRemovalConfirmation: false, eligibilityOnly: true
    } });
    expect(await fs.readFile(shard)).toEqual(before);
    expect(await fs.readdir(path.join(dir, 'sessions', session.id, 'assets')).catch(() => [])).toEqual([]);
    expect(await fs.readFile(ledger).catch(() => null)).toEqual(beforeLedger);
    expect(openInPreferredBrowser).not.toHaveBeenCalled();
    expect(handlers.has('sessions:richRetryImage')).toBe(false);
    expect(handlers.has('sessions:richAction')).toBe(false);
  });

  it('refuses caller URLs, selectors, missing IDs, foreign frames and unselected history without a canonical read', async () => {
    const { session } = await page();
    const other = await createSession({ title: 'foreign retry session', conversationId: randomUUID() });
    const { event, webContents, mainFrame, window } = selectionWindow();
    const store = await import('../src/main/session/store.js');
    const read = vi.spyOn(store, 'readCanonicalRichMediaRetryEligibility');
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: null });
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    for (const bad of [null, {}, { ...request(session.id), url: 'https://example.test/image' },
      { ...request(session.id), selector: 'img' }, { ...request(session.id), source: 'native' },
      { ...request(session.id), richRevision: 0 }, { ...request(session.id), richRevision: 1.5 },
      { ...request(session.id), nodeId: 'x'.repeat(191) }, { ...request(session.id), messageId: 'bad\u0000id' }]) {
      expect(await retry(event, bad)).toEqual({ ok: false, error: 'Invalid input' });
    }
    expect(await retry({ sender: {}, senderFrame: mainFrame }, request(session.id))).toEqual({ ok: true, data: null });
    expect(await retry({ sender: webContents, senderFrame: {} }, request(session.id))).toEqual({ ok: true, data: null });
    expect(await retry(event, request(other.id))).toEqual({ ok: true, data: null });
    (window as any).isVisible = () => false;
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: null });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses stale rich revisions and native sources, reports removed PAGE confirmation, and closes on Recording Off or rebind', async () => {
    const { session, origin, media } = await page();
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    expect(await retry(event, request(session.id, 2))).toEqual({ ok: true, data: null });
    const native = await page('native');
    expect(await select(event, native.session.id, 2)).toMatchObject({ ok: true });
    expect(await retry(event, request(native.session.id))).toEqual({ ok: true, data: null });
    expect(await select(event, session.id, 3)).toMatchObject({ ok: true });
    expect(await upsertRichMedia(session.id, messageId, {
      ...media, status: 'unavailable', reason: 'removed'
    }, origin, 1)).toBe('stored');
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: {
      status: 'unavailable', reason: 'removed', requiresRemovalConfirmation: true, eligibilityOnly: true
    } });
    await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: false } }));
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: null });
    await updateConfig(config => ({ ...config, sessions: { ...config.sessions, record: true } }));
    expect(await retry(event, request(session.id))).toMatchObject({ ok: true, data: { eligibilityOnly: true } });
    expect(await rebindSession(session.id, origin.conversationId, randomUUID())).toBe(true);
    expect(await retry(event, request(session.id))).toEqual({ ok: true, data: null });
  });

  it('discards an old eligibility result after A→B→A selected-session generation changes during the canonical read', async () => {
    const { session } = await page();
    const other = await createSession({ title: 'middle retry selection', conversationId: randomUUID() });
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    const store = await import('../src/main/session/store.js');
    const original = store.readCanonicalRichMediaRetryEligibility;
    let release!: () => void;
    let entered!: () => void;
    let first = true;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(store, 'readCanonicalRichMediaRetryEligibility').mockImplementation(async (...args) => {
      if (!first) return original(...args);
      first = false;
      const result = await original(...args);
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return result;
    });
    try {
      const stale = retry(event, request(session.id));
      await reached;
      expect(await select(event, other.id, 2)).toMatchObject({ ok: true });
      expect(await select(event, session.id, 3)).toMatchObject({ ok: true });
      release();
      expect(await stale).toEqual({ ok: true, data: null });
      expect(await retry(event, request(session.id))).toMatchObject({ ok: true, data: { eligibilityOnly: true } });
    } finally { held.mockRestore(); }
  });
});

describe('exact manual historical rich original IPC', () => {
  const B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const provider = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
  const messageId = 'assistant:working:exchange:1789552000000';
  const openOriginal = (event: unknown, sessionId: string, id = messageId): Promise<any> =>
    handlers.get('sessions:richOpenOriginal')!(event, { sessionId, messageId: id }) as Promise<any>;
  const select = (event: unknown, sessionId: string | null, generation: number): Promise<any> =>
    handlers.get('sessions:uiSelection')!(event, { sessionId, rendererGeneration: generation }) as Promise<any>;
  async function owner() {
    // The session store survives tests in this file: reusing an earlier A creates
    // an actual duplicate historical owner and correctly refuses later launches.
    const A = randomUUID();
    const session = await createSession({ title: 'manual original', conversationId: A });
    const text = 'Source answer';
    await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: 100,
      messageId, providerMessageId: provider, message: { text, chars: text.length, truncated: false }, final: true });
    expect(await upsertRichMessage(session.id, messageId, {
      version: 1, status: 'available', reason: null, conversationId: A, messageId,
      providerMessageId: provider, revision: 0, accessibleText: text,
      nodes: [{ id: 'n1', kind: 'text', style: 'body', text }]
    }, { conversationId: A, bindingRevision: 0, documentId: 'doc-a', navigationEpoch: 1 })).toBe('stored');
    return session;
  }

  it('opens the canonical assistant’s stored superseded A, not the current B or a renderer URL', async () => {
    const session = await owner();
    const A = session.conversationId!;
    expect(await rebindSession(session.id, A, B)).toBe(true);
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    vi.mocked(openInPreferredBrowser).mockClear();
    expect(await openOriginal(event, session.id)).toEqual({ ok: true, data: true });
    expect(openInPreferredBrowser).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/c/${A}`);
    expect(await handlers.get('sessions:richActionStatus')!(event, { sessionId: session.id,
      actionId: '11111111-2222-4333-8444-555555555555' })).toMatchObject({ ok: true, data: { state: 'unavailable' } });
    expect(handlers.has('sessions:richAction')).toBe(false);
  });

  it('reports the completed browser launch even when selection changes while the opener is pending', async () => {
    const session = await owner();
    const A = session.conversationId!;
    const other = await createSession({ title: 'selected during launch', conversationId: B });
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    let started!: () => void;
    let finish!: (browser: string) => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(openInPreferredBrowser).mockImplementationOnce(() => new Promise<string>(resolve => {
      finish = resolve;
      started();
    }));
    const pending = openOriginal(event, session.id);
    let settled = false;
    void pending.then(() => { settled = true; });
    await reached; // All origin/owner/selection checks have passed; launch is now in progress.
    expect(await select(event, other.id, 2)).toMatchObject({ ok: true });
    await Promise.resolve();
    expect(settled).toBe(false); // No success before the real opener resolves.
    finish('chrome.exe');
    expect(await pending).toEqual({ ok: true, data: true });
    expect(openInPreferredBrowser).toHaveBeenCalledWith(`https://chatgpt.com/c/${A}`);
  });

  it('reports a rejected browser launch as unsuccessful without another opening attempt', async () => {
    const session = await owner();
    const A = session.conversationId!;
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    vi.mocked(openInPreferredBrowser).mockClear().mockRejectedValueOnce(new Error('Browser launch failed'));
    expect(await openOriginal(event, session.id)).toEqual({ ok: true, data: false });
    expect(openInPreferredBrowser).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/c/${A}`);
  });

  it('refuses malformed input, unselected/foreign sender, unknown assistant and nonunique historical owner without opening', async () => {
    const session = await owner();
    const A = session.conversationId!;
    const foreign = await createSession({ title: 'another session', conversationId: B });
    const { event, webContents, mainFrame } = selectionWindow();
    vi.mocked(openInPreferredBrowser).mockClear();
    expect(await openOriginal(event, session.id)).toEqual({ ok: true, data: false });
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    for (const bad of [null, {}, { sessionId: session.id },
      { sessionId: session.id, messageId, url: `https://chatgpt.com/c/${B}` },
      { sessionId: session.id, messageId, action: 'continue' },
      { sessionId: session.id, messageId: 'x'.repeat(191) }]) {
      expect(await handlers.get('sessions:richOpenOriginal')!(event, bad)).toEqual({ ok: false, error: 'Invalid input' });
    }
    expect(await openOriginal({ sender: {}, senderFrame: mainFrame }, session.id)).toEqual({ ok: true, data: false });
    expect(await openOriginal({ sender: webContents, senderFrame: {} }, session.id)).toEqual({ ok: true, data: false });
    expect(await openOriginal(event, foreign.id)).toEqual({ ok: true, data: false });
    expect(await openOriginal(event, session.id, 'different-logical-id')).toEqual({ ok: true, data: false });
    await createSession({ title: 'duplicate current owner', conversationId: A });
    expect(await openOriginal(event, session.id)).toEqual({ ok: true, data: false });
    expect(openInPreferredBrowser).not.toHaveBeenCalled();
  });

  it('rejects a request that began in A but finished after A→B→A main selection changes', async () => {
    const session = await owner();
    const other = await createSession({ title: 'middle selection', conversationId: B });
    const { event } = selectionWindow();
    expect(await select(event, session.id, 1)).toMatchObject({ ok: true });
    const store = await import('../src/main/session/store.js');
    const original = store.readCanonicalRichMessageOrigin;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(store, 'readCanonicalRichMessageOrigin').mockImplementation(async (...args) => {
      const result = await original(...args);
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return result;
    });
    vi.mocked(openInPreferredBrowser).mockClear();
    try {
      const pending = openOriginal(event, session.id);
      await reached;
      expect(await select(event, other.id, 2)).toMatchObject({ ok: true });
      expect(await select(event, session.id, 3)).toMatchObject({ ok: true });
      release();
      expect(await pending).toEqual({ ok: true, data: false });
      expect(openInPreferredBrowser).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

it('keeps recording off against stale unrelated Settings saves, then accepts an explicit on choice', async () => {
  const base = getConfig();
  const off = { ...base, sessions: { ...base.sessions, record: false, retainDays: 60 } };
  expect(await save(off, base)).toMatchObject({ ok: true });
  expect(getConfig().sessions).toMatchObject({ record: false, retainDays: 0 });
  expect((await handlers.get('state:get')!(null, undefined) as any).data.config.sessions.record).toBe(false);

  const staleUnrelated = { ...base, ui: { ...base.ui, autoConnect: !base.ui.autoConnect } };
  expect(await save(staleUnrelated, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.autoConnect).toBe(!base.ui.autoConnect);
  expect(getConfig().sessions).toMatchObject({ record: false, retainDays: 0 });
  expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).sessions.record).toBe(false);

  const fresh = getConfig();
  expect(await save({ ...fresh, sessions: { ...fresh.sessions, record: true } }, fresh)).toMatchObject({ ok: true });
  expect(getConfig().sessions).toMatchObject({ record: true, retainDays: 0 });
});

it('persists arbitrary colors through Settings IPC and preserves concurrent per-field edits', async () => {
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  const base = getConfig();
  const appearance = defaultAppearance(); appearance.dark.sidebar = '#fa89c2'; appearance.font = 'serif';
  expect(await save({ ...base, ui: { ...base.ui, appearance } }, base)).toMatchObject({ ok: true });
  const nextAppearance = defaultAppearance(); nextAppearance.dark.accent = '#4a6be2';
  expect(await save({ ...base, ui: { ...base.ui, appearance: nextAppearance } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.appearance).toMatchObject({ font: 'serif', dark: { sidebar: '#fa89c2', accent: '#4a6be2' } });
  const current = getConfig();
  expect(await save({ ...current, ui: { ...current.ui, appearance: { ...current.ui.appearance, fontSize: 100 } } }, current)).toMatchObject({ ok: false });
  expect(getConfig().ui.appearance).toEqual(current.ui.appearance);
});

it('switches setup IDs and encrypted key ownership without changing shared settings', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const original = getConfig();
  const tunnelA = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await saveConfig({ ...original, tunnel: { ...original.tunnel, tunnelId: tunnelA } });
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  expect(await secret('fixture-setup-a')).toMatchObject({ ok: true });
  const added = await profile({ action: 'add', name: 'Second account' });
  expect(added).toMatchObject({ ok: true, data: { hasApiKey: false } });
  const second = getConfig().tunnel.profileId!;
  expect(getConfig().tunnel.tunnelId).toBe('');
  const shared = getConfig();
  expect(shared.roots).toEqual(original.roots); expect(shared.multiAgent).toEqual(original.multiAgent);
  expect(await secret('fixture-setup-b', second)).toMatchObject({ ok: true });
  const baseB = getConfig();
  expect(await save({ ...baseB, tunnel: { ...baseB.tunnel, tunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })).toMatchObject({ ok: true });
  expect(await profile({ action: 'select', id: 'default' })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.tunnelId).toBe(tunnelA);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  expect(await getSecret(`setup:${second}`)).toBe('fixture-setup-b');
  // A late write still names B even when A is now selected.
  await secret('fixture-setup-b-edited', second);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  const stored = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  expect(stored).not.toContain('fixture-setup-');
  expect((await profile({ action: 'select', id: second })).data.hasApiKey).toBe(true);
  expect(getConfig().tunnel.tunnelId).toBe('tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it('removes active and inactive profiles with their exact keys, preserving the final profile', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  await secret('fixture-default-key');
  await profile({ action: 'add', name: 'Second' });
  const second = getConfig().tunnel.profileId!;
  await secret('fixture-second-key', second);
  await profile({ action: 'add', name: 'Third' });
  const third = getConfig().tunnel.profileId!;
  await secret('fixture-third-key', third);
  expect(await profile({ action: 'remove', id: second })).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileId).toBe(third);
  expect(await getSecret(`setup:${second}`)).toBeNull();
  expect(await getSecret(`setup:${third}`)).toBe('fixture-third-key');
  expect(await profile({ action: 'remove', id: third })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.profileId).toBe('default');
  expect(await getSecret(`setup:${third}`)).toBeNull();
  expect(await secret('late-key', third)).toMatchObject({ ok: false });
  expect(await profile({ action: 'select', id: third })).toMatchObject({ ok: false });
  expect(await profile({ action: 'remove', id: 'default' })).toMatchObject({ ok: false });
  expect(await getSecret('openaiApiKey')).toBe('fixture-default-key');
});

it('rejects stale profile tunnel edits after A to B to A while accepting unrelated settings', async () => {
  const base = getConfig();
  await handlers.get('setup:profile')!(null, { action: 'add', name: 'Other' });
  await handlers.get('setup:profile')!(null, { action: 'select', id: 'default' });
  expect(await save({ ...base, tunnel: { ...base.tunnel, tunnelId: 'tunnel_cccccccccccccccccccccccccccccccc' } }, base)).toMatchObject({ ok: false });
  expect(await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileEpoch).toBe(2);
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it('forwards canonical input commitment when recording is enabled', async () => {
  const input = await import('../src/main/session/input.js');
  const store = await import('../src/main/session/store.js');
  const previous = await readDurable('session-input');
  const session = await createSession({ title: 'Input commitment fixture', conversationId: 'input-commitment-fixture' });
  const id = '30000000-0000-4000-8000-000000000001';
  try {
    await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: true } });
    await writeDurableNow('session-input', [{ id, sessionId: session.id, text: 'Delivered fixture', mode: 'auto', model: null,
      reasoningEffort: null, dueAt: 100, createdAt: 100, state: 'sent', owner: null, conversationId: 'input-commitment-fixture',
      messageId: `input:${id}`, offeredAt: 200, deliveredAt: 300, historyRecorded: false,
      toolImages: [{ name: 'invalid.webp', dataUrl: 'data:image/webp;base64,YQ==' }] }]);
    input.resetInputForTests();
    const result = await handlers.get('sessions:outbox')!(null, undefined) as any;
    expect(result.ok).toBe(true);
    const row = result.data[0];
    expect(getConfig().sessions).toMatchObject({ record: true, retainDays: 0 });
    expect(row.historyAnchored).toBe(true);
    expect(row.historyRecorded).not.toBe(true);
    expect((await readDurable<any[]>('session-input'))![0].historyAnchored).toBe(true);
    const canonical = (await store.readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ inputId: id, time: 200 });
  } finally {
    await writeDurableNow('session-input', previous ?? []);
    input.resetInputForTests();
  }
});

it('validates dropped file count and stages arbitrary native file types', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: Array(21).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ files: [''] })).toMatchObject({ ok: false });
  expect(await drop({ files: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: true, data: [expect.objectContaining({ name: 'package.json', mimeType: 'application/json' })] });
});

it('publishes Goal draft progress through the session refresh channel without a new transcript event', async () => {
  const { startGoalDraft, resetGoalStateForTests } = await import('../src/main/goal.js');
  const session = await createSession({ title: 'Goal progress', conversationId: 'ipc-goal-progress' });
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  try {
    startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'finished-turn', deferStart: true });
    expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
  } finally {
    resetGoalStateForTests();
  }
});

it('stages clipboard image bytes with a preview through the general attachment owner', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: [{ name: 'huge.png', bytes: new Uint8Array(12 * 1024 * 1024 + 1) }] })).toMatchObject({ ok: false });
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const pasted = await drop({ files: [{ name: 'screenshot.png', bytes: new Uint8Array(bytes) }] });
  expect(pasted).toMatchObject({ ok: true, data: [{ name: 'screenshot.png', size: bytes.length, mimeType: 'image/png', preview: expect.stringMatching(/^data:image\/webp;base64,/) }] });
  const { readInputAttachmentChunk } = await import('../src/main/session/input-attachments.js');
  expect(await readInputAttachmentChunk(pasted.data[0], 0)).toBe(bytes.toString('base64'));
});

it('does not authorize the composer Generate Goal action from an absent or stale finish wait', async () => {
  const generate = (payload: unknown) => handlers.get('sessions:generateFinishGoal')!(null, payload) as Promise<any>;
  const session = await createSession({ title: 'No finish wait', conversationId: 'finish-action-ipc-chat' });
  expect(await generate({ id: session.id })).toMatchObject({ ok: false });
  expect(await generate({ id: session.id, expectedTurnId: 'old-turn' })).toMatchObject({ ok: false });
});

it('round-trips Goal controls and cannot revive old periodic input when Off cancellation fails then On retries', async () => {
  const outbox = await import('../src/main/session/input.js');
  const durable = await import('../src/main/durable.js');
  const store = await import('../src/main/session/store.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const config = (minutes: number) => ({ ...settings({ record: true, multiAgent: false }),
    ui: { ...defaultConfig().ui, finishTool: true },
    goal: { ...defaultConfig().goal, impulseMinutes: minutes, includeToolCalls: true } });
  let write: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await save(config(1))).toMatchObject({ ok: true });
    expect(getConfig().goal).toMatchObject({ impulseMinutes: 1, includeToolCalls: true });
    const session = await createSession({ title: 'Periodic ownership', conversationId: 'periodic-settings-chat' });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'periodic-turn', time: Date.now() });
    await store.observeSessionModel(session.id, 'periodic-settings-chat', 'gpt-6-astra', Date.now());
    const row = await outbox.enqueueInput({ id: 'f0f00014-1111-4111-8111-111111111111', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, userRequested: true });
    // Seed an old-version row; current code deliberately refuses new periodic input.
    await writeDurableNow('session-input', [{ ...row, finishOwner: { turnId: 'periodic-turn', periodic: true } }]);
    outbox.resetInputForTests();
    write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('Cancellation disk failure'));
    expect(await save(config(0))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Off was published before retirement.
    write.mockRejectedValueOnce(new Error('Still cannot retire'));
    expect(await save(config(1))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Failed retirement cannot publish On.
    write.mockRestore(); write = undefined;
    expect(await save(config(1))).toMatchObject({ ok: true });
    outbox.resetInputForTests();
    expect((await outbox.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual({ messages: [], reminder: '' });
  } finally {
    write?.mockRestore();
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('native opening cancellation aborts the exact IPC invocation and prevents a late ready result', async () => {
  const goal = await import('../src/main/goal.js');
  const requestId = 'ad3ecbf4-c3a1-4d0d-9e9f-619787bcf982';
  let signal: AbortSignal | undefined;
  const draft = vi.spyOn(goal, 'draftOpeningMessage').mockImplementation(async (_text, _mode, _progress, current) => {
    signal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  });
  try {
    const opening = handlers.get('sessions:goalOpening')!(null, { text: 'Implement safely', mode: 'goal', requestId });
    const cancelled = await handlers.get('tasks:cancel')!(null, { requestId }) as any;
    expect(cancelled).toEqual({ ok: true, data: true });
    expect(signal?.aborted).toBe(true);
    expect(await opening).toMatchObject({ ok: false, error: 'task_cancelled' });
    expect(draft).toHaveBeenCalledTimes(1);
  } finally { draft.mockRestore(); }
});

it('projects exact retained worker parents without adopting same-name unrelated recordings', async () => {
  const prime = await createSession({ title: 'Parent', conversationId: 'parent-projection' });
  spawn({ workers: [{ task: 'test parent identity' }], caller: { conversationId: 'parent-projection' } });
  expect(bindConversation('worker-1', 'worker-projection')).toBe(true);
  const origin = { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'test parent identity' };
  const child = await createSession({ title: 'Child', conversationId: 'worker-projection', origin });
  const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-worker', origin });
  const result = await sessionList();
  expect(result.ok).toBe(true);
  expect(result.data.sessions.find((row: any) => row.id === child.id).origin.fromSessionId).toBe(prime.id);
  expect(result.data.sessions.find((row: any) => row.id === unrelated.id).origin.fromSessionId).toBeNull();
  restoreSwarm(null); // End this fixture without user-clear retiring it into later tests.
});

it('adds picker-selected projects, reuses containing approval, and leaves cancellation unchanged', async () => {
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const folder = path.join(dir, 'picker-project');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await writeDurableNow('projects', []);
  const add = () => handlers.get('projects:add')!(null, {}) as Promise<any>;
  expect((await add()).data).toBeNull();
  expect(getConfig().roots).toHaveLength(0);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [folder] });
  const first = await add();
  expect(first.ok, first.error).toBe(true);
  expect(first.data.name).toBe('picker-project');
  expect(getConfig().roots).toHaveLength(1);
  expect((await add()).data.id).toBe(first.data.id);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path.join(folder, 'child')] });
  expect((await add()).data.name).toBe('child');
  expect(getConfig().roots).toHaveLength(1);
  const listed = await handlers.get('projects:list')!(null, {}) as any;
  expect(listed.data).toHaveLength(2);
  const removed = await handlers.get('projects:remove')!(null, { id: first.data.id }) as any;
  expect(removed).toMatchObject({ ok: true, data: { id: first.data.id, ungrouped: true } });
  expect(getConfig().roots).toHaveLength(1);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await handlers.get('projects:remove')!(null, { id: folder })).toMatchObject({ ok: false });
});

/** The whole settings object the renderer sends, with the parts a test cares about set. */
function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
    tunnel: base.tunnel,
    ui: base.ui,
    sessions: { ...base.sessions, record: over.record },
    compaction: base.compaction,
    multiAgent: { ...base.multiAgent, enabled: over.multiAgent },
    goal: base.goal
  };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-ipc-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersist(() => writeDurableSoon('ipc-swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('ipc-swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('ipc-retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow('ipc-retired-workers', snapshot));
  registerIpc(
    () => currentWindow as any,
    () => {
      quitToInstallCalls += 1;
    }
  );
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  onSwarmPersist(null);
  onSwarmPersistNow(null);
  onRetiredWorkersPersist(null);
  onRetiredWorkersPersistNow(null);
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  currentWindow = null;
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  nativeTheme.themeSource = 'system';
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(shell.openPath).mockReset().mockResolvedValue('');
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined);
  vi.mocked(app.getVersion).mockReset().mockReturnValue('0.0.0');
  resetSwarm();
  resetBridgeForTests();
  resetWorkspaces();
  // The app opens the worker's chat itself; a command only exists while a page it opened
  // still has it to redeem.
  setBrowserOpener(async () => undefined);
  // Deliberately re-enable from the latest committed state. A detached saveConfig
  // snapshot must not silently undo a prior test's committed Recording Off.
  await updateConfig(() => ({
    ...defaultConfig(),
    sessions: { ...defaultConfig().sessions, record: true },
    multiAgent: { enabled: true, maxWorkers: 3, allowUnattributedCalls: false, recoverAgentTabs: true }
  }));
});

it('keeps origin history navigation separate from live revision cursors over IPC', async () => {
  const session = await createSession({ title: 'History cursors' });
  const message = { kind: 'assistant_message' as const, source: 'extension' as const, time: 10,
    messageId: 'review', message: { text: 'Detailed review', truncated: false, chars: 15 }, final: true };
  const first = await upsertMessageEvent(session.id, message);
  await appendEvent(session.id, { kind: 'note', source: 'app', time: 20, message: { text: 'Later work', truncated: false, chars: 10 } });
  const revision = await upsertMessageEvent(session.id, { ...message, renderedHtml: { text: '<p>Detailed review</p>', truncated: false, chars: 22 } });
  const read = (options: object) => handlers.get('sessions:events')!(null, { id: session.id, ...options }) as Promise<any>;
  const tail = await read({ limit: 1 });
  expect(tail.ok).toBe(true);
  expect(tail.data.events[0].kind).toBe('note');
  const older = await read({ before: tail.data.events[0].seq, limit: 1 });
  expect(older.data.events[0]).toMatchObject({ kind: 'assistant_message', origin: first.event.seq, seq: revision.event.seq });
  const newer = await read({ after: first.event.seq, limit: 1 });
  expect(newer.data.events[0].kind).toBe('note');
  const delta = await read({ from: revision.event.seq, limit: 1 });
  expect(delta.data.events[0].messageId).toBe('review');
  expect(delta.data.nextFrom).toBe(revision.event.seq + 1);
});

describe('explicit settings replace the published tool contract', () => {
  it.each(['finish', 'command'] as const)('withdraws %s from real endpoint publication after its setting is disabled', async kind => {
    const { startMcpServer } = await import('../src/main/mcp/server.js');
    const { effectiveCapabilities } = await import('../src/main/config.js');
    const { publishPluginSurface, pluginRefreshPublications, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    const initial = getConfig();
    await saveConfig({ ...initial, ui: { ...initial.ui, finishTool: true }, capabilities: { ...initial.capabilities, read: true } });
    const endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
    // `buildServer` is async — it consults `listSkillLibrary`, which walks the filesystem — so its
    // `observe` callback runs after an await rather than synchronously inside `publication()`.
    // Counting this call's own publication is what makes the read below deterministic: waiting for
    // a row to merely exist would pass on the previous call's stale row, which is exactly the
    // failure this test is about. `setImmediate` rather than a microtask drain, because the wait
    // has to cover real I/O, and a bounded loop rather than a sleep, so a genuine break reports
    // itself instead of hanging.
    let published = 0;
    const snapshot = async () => {
      const mark = published;
      endpoint.publication!('core', (name, version, instructions, tools) => {
        published += 1;
        publishPluginSurface('core', name, version, instructions, tools);
      });
      for (let attempt = 0; published === mark; attempt++) {
        if (attempt >= 5_000) throw new Error('the tool contract was never republished');
        await new Promise(resolve => setImmediate(resolve));
      }
      return pluginRefreshPublications().find(row => row.surface === 'core')!;
    };
    try {
      const before = await snapshot();
      const tool = kind === 'finish' ? 'session_finish' : 'exec_command';
      expect(before.tools.map(row => row.name)).toContain(tool);
      expect(before.tools.map(row => row.name)).not.toContain('session');
      const current = getConfig();
      const patch = { ...current, ...(kind === 'finish'
        ? { ui: { ...current.ui, finishTool: false } }
        : { capabilities: { ...current.capabilities, command: false } }) };
      expect((await save(patch)).ok).toBe(true);
      const after = await snapshot();
      expect(after.tools.map(row => row.name)).not.toContain(tool);
      expect(after.tools.map(row => row.name)).not.toContain('session');
      expect(after.schemaId).not.toBe(before.schemaId);
      const saved = getConfig();
      expect((await save({ ...saved, ui: { ...saved.ui, theme: 'dark' } })).ok).toBe(true);
      expect((await snapshot()).schemaId).toBe(after.schemaId);
    } finally { await endpoint.stop(); resetPluginRefreshForTests(); }
  });
});

describe('startup state without secure storage', () => {
  it('still returns a usable app/bridge state instead of crashing state discovery', async () => {
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const reply = (await handlers.get('state:get')!(null, undefined)) as any;
    expect(reply.ok).toBe(true);
    expect(reply.data.secureStorage.available).toBe(false);
    expect(reply.data.hasApiKey).toBe(false);
    expect(reply.data.hasGoalKey).toBe(false);
    expect(reply.data.bridge.paired).toBe(false);
  });
});

describe('turning multi-agent mode off', () => {
  /**
   * Pausing execution must withdraw queued browser work before the bridge goes away. The
   * durable worker history itself survives; only the pending transport is cancelled.
   */
  it('cancels the run’s queued worker chats before the bridge goes away', async () => {
    await startBridge();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: 'c-prime' } });
    // Opening is asynchronous, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingCommands().length).toBe(1);

    // The worker teardown is independent of the saved recording preference and bridge lifetime.
    await save(settings({ record: false, multiAgent: false }));

    expect(getConfig().multiAgent.enabled).toBe(false);
    expect(pendingCommands(), 'a worker chat was left queued for a run that has ended').toEqual([]);
  });

  it('does not acknowledge the toggle until the parked retained history is durable', async () => {
    const prime = '11111111-2222-4333-8444-555555555555';
    const worker = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'must stay fenced after disable' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);
    expect(await readDurable('ipc-swarm')).not.toBeNull();

    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(await readDurable<any>('ipc-swarm')).toMatchObject({
      version: 6,
      runId: null,
      primeConversationId: null,
      agents: [],
      dormantRuns: [
        expect.objectContaining({
          primeConversationId: prime,
          agents: expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({
                id: 'worker-1',
                conversationId: worker,
                state: 'sleeping',
                revivable: true
              })
            })
          ])
        })
      ]
    });
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({ workers: [] });
  });

  it('survives a disabled restart and re-enable with the exact old worker chat still revivable', async () => {
    const prime = '22222222-3333-4444-8555-666666666666';
    const worker = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    spawn({ workers: [{ task: 'remember this exact worker' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved).not.toBeNull();

    // The startup path restores authority even while the feature is off, then canonicalizes
    // any leftover active incarnation into parked history. Reproduce that process boundary here.
    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    expect(snapshotSwarm()).toMatchObject({
      runId: null,
      dormantRuns: [expect.objectContaining({ primeConversationId: prime })]
    });

    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: prime }).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worker-1',
          conversationId: worker,
          state: 'sleeping',
          revivable: true
        })
      ])
    );

    sendMessage({ conversationId: prime }, 'worker-1', 'continue in the exact worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: worker })
    ]);
  });

  it('preserves every parked owner when disabling a different prime that is still active', async () => {
    const primeA = '33333333-4444-4555-8666-777777777777';
    const workerA = 'cccccccc-dddd-4eee-8fff-000000000001';
    spawn({ workers: [{ task: 'A retained history' }], caller: { conversationId: primeA } });
    expect(bindConversation('worker-1', workerA)).toBe(true);
    finishAgent({ conversationId: workerA }, 'A is parked already');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB = '44444444-5555-4666-8777-888888888888';
    const workerB = 'dddddddd-eeee-4fff-8000-000000000002';
    spawn({ workers: [{ task: 'B is live when disabled' }], caller: { conversationId: primeB } });
    expect(bindConversation('worker-1', workerB)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved?.runId).toBeNull();
    expect(saved?.dormantRuns).toHaveLength(2);
    expect(saved?.dormantRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primeConversationId: primeA }),
        expect.objectContaining({ primeConversationId: primeB })
      ])
    );

    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: primeA }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerA
    });
    expect(swarmStateForCaller({ conversationId: primeB }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerB
    });
  });

  it('keeps disabled history until the explicit Clear swarm IPC destroys it', async () => {
    const prime = '55555555-6666-4777-8888-999999999999';
    const worker = 'eeeeeeee-ffff-4000-8111-000000000003';
    spawn({ workers: [{ task: 'survive disable until explicit clear' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    expect((await readDurable<any>('ipc-swarm'))?.dormantRuns).toHaveLength(1);

    const cleared = await handlers.get('swarm:reset')!(null, undefined) as any;
    expect(cleared.ok, cleared.error).toBe(true);
    expect(await readDurable('ipc-swarm')).toBeNull();
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({
      workers: expect.arrayContaining([expect.objectContaining({ id: 'worker-1', conversationId: worker })])
    });
  });
});

describe('bounded IPC identities and OS launch results', () => {
  it('reports shell.openPath failure instead of claiming the extension folder opened', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Access is denied');
    const reply = (await handlers.get('bridge:openExtensionFolder')!(null, undefined)) as {
      ok: boolean;
      error?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/could not open.*access is denied/i);
  });

  it('opens the extension recovery ZIP from the installed app version, never releases/latest', async () => {
    vi.mocked(app.getVersion).mockReturnValueOnce('1.8.8');
    const reply = await handlers.get('bridge:downloadExtension')!(null, undefined);

    expect(reply).toEqual({ ok: true, data: true });
    expect(shell.openExternal).toHaveBeenCalledWith(extensionDownloadUrl('1.8.8'));
    expect(extensionDownloadUrl('1.8.8')).toBe(
      'https://github.com/TheBigBrainChad/chatbbc/releases/download/v1.8.8/ChatBBC-Extension.zip'
    );
    expect(vi.mocked(shell.openExternal).mock.calls[0]?.[0]).not.toContain('/releases/latest/');
  });

  it('bounds and validates an agent id before it reaches the global broker', async () => {
    const clear = handlers.get('swarm:clearAgent')!;
    const oversized = (await clear(null, 'worker-' + 'x'.repeat(200_000))) as { ok: boolean; error?: string };
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatch(/64|too big/i);

    const punctuation = (await clear(null, 'worker-1\nspoofed')) as { ok: boolean; error?: string };
    expect(punctuation.ok).toBe(false);
  });
});

describe('ChatGPT browser settings', () => {
  it('persists Edge and keeps it through an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const result = await save({ ...base, ui: { ...base.ui, chatBrowser: 'edge' } }, base);
    expect(result.ok, result.error).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.chatBrowser).toBe('edge');
    const stale = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ chatBrowser: 'edge', theme: 'light' });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, chatBrowser: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.chatBrowser).toBe('edge');
  });
});

describe('settings writes from more than one UI', () => {
  it('validates and persists the Plugins tunnel id through Settings, including explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'a'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).tunnel.pluginsTunnelId).toBe(tunnelId);
    for (const invalid of ['not-a-tunnel', `tunnel_${'g'.repeat(32)}`, `tunnel_${'a'.repeat(31)}`, 'x'.repeat(129)]) {
      const current = getConfig();
      expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: invalid } }, current)).ok).toBe(false);
      expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    }
    const current = getConfig();
    expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: '' } }, current)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe('');
  });

  it('preserves a newer Plugins tunnel across stale and legacy renderer saves', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'b'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    const legacy = { ...base, tunnel: { ...base.tunnel } };
    delete legacy.tunnel.pluginsTunnelId;
    expect((await save({ ...legacy, ui: { ...legacy.ui, minimizeToTray: !legacy.ui.minimizeToTray } }, legacy)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(getConfig().ui.minimizeToTray).toBe(!legacy.ui.minimizeToTray);
  });

  it('changes login registration only on a changed preference and reports failure after other effects', async () => {
    const lifecycle = await import('../src/main/window-lifecycle.js');
    const connection = await import('../src/main/connection.js');
    const applied = vi.spyOn(connection, 'applySettings');
    const login = vi.spyOn(lifecycle, 'applyLoginStartup').mockImplementation(() => { throw new Error('login registration refused'); });
    try {
      const base = defaultConfig();
      await saveConfig(base);
      const cosmetic = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
      expect(cosmetic.ok, cosmetic.error).toBe(true);
      expect(login).not.toHaveBeenCalled();
      applied.mockClear();
      const current = getConfig();
      const changed = await save({ ...current, ui: { ...current.ui, theme: 'dark', startAtLogin: true } }, current);
      expect(changed.ok).toBe(false);
      expect(changed.error).toContain('login registration refused');
      expect(getConfig().ui.startAtLogin).toBe(true);
      expect(nativeTheme.themeSource).toBe('dark');
      expect(applied).toHaveBeenCalledOnce();
      expect(login).toHaveBeenCalledOnce();
      expect(applied.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]!);
    } finally { login.mockRestore(); applied.mockRestore(); }
  });
  it('rotates only the active Goal provider and exposes key presence without the secret', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, goal: { ...base.goal, provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
    const goal = await import('../src/main/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      await handlers.get('secret:set')!({}, { key: 'openRouterApiKey', value: 'synthetic-inactive-key' });
      expect(retired).not.toHaveBeenCalled();
      const response = await handlers.get('secret:set')!({}, { key: 'customProviderApiKey', value: 'synthetic-active-key' });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(response)).not.toContain('synthetic-active-key');
    } finally { retired.mockRestore(); }
  });
  it('persists connector instructions through IPC, preserves concurrent edits, and allows explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const wanted = { ...base, mcp: { instructions: 'Use the approved project only.' }, ui: { ...base.ui, browserOnly: true } };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    const legacy = { ...base } as any; delete legacy.mcp;
    expect((await save(legacy, legacy)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    const current = getConfig();
    expect((await save({ ...current, mcp: { instructions: '' } }, current)).ok).toBe(true);
    expect(getConfig().mcp.instructions).toBe('');
    expect((await save({ ...current, mcp: { instructions: 'x'.repeat(4001) } }, current)).ok).toBe(false);
    expect(getConfig().mcp.instructions).toBe('');
  });
  it('saves helper settings and tab retention through the renderer schema and merge boundary', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = { ...base, ui: { ...base.ui, tabsToKeepOpen: 6 }, goal: {
      ...base.goal, helperModel: 'account-helper', helperReasoning: 'medium' as const
    } };
    const result = await save(wanted, base);
    expect(result.ok, result.error).toBe(true);
    expect(getConfig().ui.tabsToKeepOpen).toBe(6);
    expect(getConfig().goal).toMatchObject({ helperModel: 'account-helper', helperReasoning: 'medium', model: base.goal.model });
  });
  it('persists the planner backend and preserves it across an unrelated stale settings save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const selected = await save({ ...base, ui: { ...base.ui, planBackend: 'api' } }, base);
    expect(selected.ok, selected.error).toBe(true);
    expect(getConfig().ui.planBackend).toBe('api');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.planBackend).toBe('api');
    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ planBackend: 'api', minimizeToTray: !base.ui.minimizeToTray });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'chatgpt' } }, current)).ok).toBe(true);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
  });
  it('does not let a stale renderer snapshot undo a newer extension setting', async () => {
    currentWindow = {
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const original = defaultConfig();
    const base = {
      ...original,
      ui: { ...original.ui, theme: 'light' as const },
      goal: { ...original.goal, enabled: true }
    };
    await saveConfig(base);

    // The extension writes after the renderer has already captured `base` for an unrelated
    // form edit. This is exactly the race a serialized config queue cannot solve by itself.
    await saveConfig({ ...base, goal: { ...base.goal, enabled: false } });
    const wanted = { ...base, ui: { ...base.ui, theme: 'dark' as const } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.theme).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#181818');
    if (process.platform === 'win32') expect(currentWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 36, color: '#00000000', symbolColor: '#ffffff'
    });
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('preserves a newer unattributed-call choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, allowUnattributedCalls: true }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.allowUnattributedCalls).toBe(true);
  });

  it('preserves a newer agent-tab recovery choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, recoverAgentTabs: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.recoverAgentTabs).toBe(false);
  });
});

describe('root namespace invariants', () => {
  it('approves a dropped folder path exactly like the picker, and refuses a dropped file', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await saveConfig({ ...defaultConfig(), roots: [] });
    const folder = path.join(dir, 'dropped-project');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(dir, 'dropped-file.txt');
    await fs.writeFile(file, 'not a folder');
    const addPath = (payload: unknown): Promise<any> => handlers.get('roots:addPath')!(null, payload) as Promise<any>;

    const added = await addPath({ path: folder });
    expect(added.ok).toBe(true);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['dropped-project']);

    // The drop zone is not a second, weaker approval path: the same validation applies.
    const refused = await addPath({ path: file });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not a folder/i);
    expect((await addPath({ path: '' })).ok).toBe(false);
    expect(getConfig().roots).toHaveLength(1);
  });

  it('refuses a live rename into the reserved /skills namespace', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [
        { name: 'project', path: 'C:\\Users\\example\\project' },
        { name: 'skills-folder', path: 'C:\\Users\\example\\skills-folder' }
      ]
    });

    const reply = await renameRoot({ name: 'project', newName: 'skills' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/reserved/i);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['project', 'skills-folder']);
  });

  it('moves live workspace bindings with a root rename and drops them with root removal', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    });
    setWorkspaceFor('chat:conv-root-change', {
      virtual: '/project/src',
      real: 'C:\\Users\\example\\project\\src'
    });

    const renamed = await renameRoot({ name: 'project', newName: 'repo' });
    expect(renamed.ok, renamed.error).toBe(true);
    expect(workspaceEntries()).toEqual([{ key: 'chat:conv-root-change', virtual: '/repo/src' }]);

    const removed = await removeRoot({ name: 'repo' });
    expect(removed.ok, removed.error).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses stale root rename/remove requests instead of reporting a no-op as success', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const renamed = await renameRoot({ name: 'gone', newName: 'other' });
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/not an approved folder/i);
    const removed = await removeRoot({ name: 'gone' });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/not an approved folder/i);
  });
});

/** Exercise the real IPC policy for both Settings buttons and authored chat links. */
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    for (const url of offered) expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(null, { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    expect(await open(null, { url: 'https://example.com/reference#section' })).toEqual({ ok: true, data: true });
  });

  it.each(['https://example.com/path?q=hello', 'http://localhost:3000/', 'mailto:person@example.com?subject=Hello'])(
    'opens an authored external link: %s', async url => {
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
  );
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'ms-settings:privacy',
    'x-apple.systempreferences:unapproved', 'https://user:password@example.com/', '//example.com/',
    'https:example.com', 'https://example.com/\nfoo', 'mailto:a@example.com?body=%0Ainjected', 'https://example.com/\\path'])(
    'refuses unsafe authored link: %s', async url => {
    const before = vi.mocked(shell.openExternal).mock.calls.length;
    const refused = (await handlers.get('link:open')!(null, { url })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
    expect(vi.mocked(shell.openExternal).mock.calls.length).toBe(before);
  });

  it('serializes non-Error throws into a real IPC error string', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce('Windows shell refused the request');
    const reply = (await handlers.get('link:open')!(null, {
      url: 'https://openrouter.ai/settings/keys'
    })) as { ok: boolean; error?: string };
    expect(reply).toEqual({ ok: false, error: 'Windows shell refused the request' });
  });
});

/**
 * The Install button, from the renderer's side of the wire.
 *
 * There is one thing to be sure of here: a press with nothing staged must not quit the app. The
 * button exists because this app is closed to the tray and a quit is rare and deliberate, so a
 * press that closed the window and installed nothing would be worse than no button at all.
 */
describe('installing a downloaded update on request', () => {
  it('refuses, and does not quit, when nothing has been downloaded', async () => {
    const before = quitToInstallCalls;
    const reply = (await handlers.get('update:install')!(null, undefined)) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no downloaded update/i);
    expect(quitToInstallCalls).toBe(before);
  });
});

/**
 * OpenRouter publishes twelve ids that begin with `~` — `~deepseek/deepseek-v4-flash-latest`
 * and its siblings — and they are aliases that always resolve to the newest model in a
 * family. The picker lists them because the catalogue does, so a validator that refused the
 * `~` made the one kind of entry most worth choosing the one kind that could not be saved:
 * the click reported an error and the model in use silently stayed where it was.
 */
describe('the goal model id', () => {
  const withModel = (model: string) => ({ ...settings({ record: false, multiAgent: false }), goal: { ...defaultConfig().goal, model } });

  it('accepts the family aliases OpenRouter marks with a tilde', async () => {
    const reply = await save(withModel('~z-ai/glm-latest'));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe('~z-ai/glm-latest');
  });

  it('still accepts an ordinary pinned id, with or without a variant suffix', async () => {
    expect((await save(withModel('deepseek/deepseek-v4-flash-0731'))).ok).toBe(true);
    expect((await save(withModel('openai/gpt-5.2-mini:nitro'))).ok).toBe(true);
  });

  it('refuses something that is not a model id at all', async () => {
    const reply = await save(withModel('not a model'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/vendor\/model/);
  });

  /** The shipped default is one of those aliases, so it has to survive its own validator. */
  it('accepts the default this app ships with', async () => {
    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe(defaultConfig().goal.model);
  });

  it('accepts a bare endpoint id while custom and stores the base URL verbatim', async () => {
    const patch = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1/' },
        model: 'llama3.1'
      }
    };
    const reply = await save(patch);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.provider).toEqual({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/' });
    expect(getConfig().goal.model).toBe('llama3.1');
  });

  it('still refuses a bare id while on OpenRouter, and an unknown provider kind', async () => {
    const custom = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' },
        model: 'llama3.1'
      }
    };
    // Same model, OpenRouter provider: the vendor/model shape still applies.
    const openrouter = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'openrouter' as const, baseUrl: '' } }
    };
    expect((await save(openrouter)).ok).toBe(false);
    const unknown = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'own' as never, baseUrl: '' } }
    };
    expect((await save(unknown)).ok).toBe(false);
  });
});

describe('the custom provider key slot', () => {
  const storeSecret = (payload: unknown): Promise<any> =>
    handlers.get('secret:set')!(null, payload) as Promise<any>;

  it('stores a custom key in its own slot and refuses an unnamed one', async () => {
    const prior = await handlers.get('state:get')!(null, undefined) as any;
    const stored = await storeSecret({ value: 'sk-custom-1', key: 'customProviderApiKey' });
    expect(stored.ok, stored.error).toBe(true);
    expect(stored.data.hasCustomProviderKey).toBe(true);
    // The OpenRouter slot is untouched: naming is exact, never a shared bucket.
    expect(stored.data.hasGoalKey).toBe(prior.data.hasGoalKey);
    const cleared = await storeSecret({ value: '', key: 'customProviderApiKey' });
    expect(cleared.ok).toBe(true);
    expect(cleared.data.hasCustomProviderKey).toBe(false);
    const refused = await storeSecret({ value: 'x', key: 'nobodyDefinedThis' });
    expect(refused.ok).toBe(false);
  });
});

describe('the editable goal system prompt', () => {
  it('stores a deliberate custom prompt', async () => {
    const prompt = 'Only continue explicit missing work. Return NO_REPLY when ChatGPT says done.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, prompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.prompt).toBe(prompt);
  });

  it('refuses blank and unbounded prompts at the renderer boundary', async () => {
    const base = settings({ record: false, multiAgent: false });
    expect((await save({ ...base, goal: { ...base.goal, prompt: '   ' } })).ok).toBe(false);
    expect((await save({ ...base, goal: { ...base.goal, prompt: 'x'.repeat(20_001) } })).ok).toBe(false);
  });

  /**
   * The driver prompt crosses the same boundary as the gate, so it needs the same guards.
   * It used to be a source constant no renderer could reach; now that it is editable, a
   * blank or unbounded value has to be refused here rather than reaching the goal loop.
   */
  it('stores the goal driver prompt and holds it to the same bounds', async () => {
    const objectivePrompt = 'Drive to the goal. NO_REPLY once it is reached.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, objectivePrompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.objectivePrompt).toBe(objectivePrompt);

    expect((await save({ ...base, goal: { ...base.goal, objectivePrompt: '   ' } })).ok).toBe(false);
    expect(
      (await save({ ...base, goal: { ...base.goal, objectivePrompt: 'x'.repeat(20_001) } })).ok
    ).toBe(false);
  });
});

describe('session IPC contracts', () => {
  it('projects absent live activity without persisting the runtime deadline', async () => {
    const { observeSessionModel, getSession } = await import('../src/main/session/store.js');
    const pro = await createSession({ title: 'Idle Pro', conversationId: 'idle-pro-projection' });
    const sol = await createSession({ title: 'Idle Sol', conversationId: 'idle-sol-projection' });
    await observeSessionModel(pro.id, pro.conversationId!, 'gpt-6', Date.now(), 'pro');
    await observeSessionModel(sol.id, sol.conversationId!, 'gpt-5.6', Date.now(), 'medium');
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions.find((row: any) => row.id === pro.id).activityExpiresAt).toBeNull();
    expect(reply.data.sessions.find((row: any) => row.id === sol.id).activityExpiresAt).toBeNull();
    expect(await getSession(pro.id)).not.toHaveProperty('activityExpiresAt');
  });

  it('keeps total as the whole session size on an explicit event page', async () => {
    const session = await createSession({ title: 'paged IPC total', conversationId: null });
    for (let index = 0; index < 5; index++) {
      await appendEvent(session.id, {
        time: 10_000 + index,
        source: 'app',
        kind: 'note',
        message: { text: `note-${index}`, truncated: false, chars: 6 }
      });
    }

    const reply = await sessionEvents({ id: session.id, from: 3, limit: 2 });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.events).toHaveLength(2);
    expect(reply.data.total).toBe(5);
  });

  it('does not send pressure rows for sessions it already omitted from the capped list', async () => {
    for (let index = 0; index < 61; index++) {
      await createSession({ title: `list cap ${index}`, conversationId: null });
    }
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions).toHaveLength(60);
    expect(reply.data.pressure).toHaveLength(60);
    expect(new Set(reply.data.pressure.map((entry: { id: string }) => entry.id))).toEqual(
      new Set(reply.data.sessions.map((entry: { id: string }) => entry.id))
    );
  });

  it('projects compaction pressure from the current chat context, not session lifetime history', async () => {
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'reset context pressure', conversationId: chatA });
    await appendEvent(session.id, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: { text: 'x'.repeat(8_000), truncated: false, chars: 8_000 }
    });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const reply = await sessionList();
    const listed = reply.data.sessions.find((entry: { id: string }) => entry.id === session.id);
    const pressure = reply.data.pressure.find((entry: { id: string }) => entry.id === session.id);
    expect(listed.estimatedTokens).toBeGreaterThan(0);
    expect(listed.contextTokens).toBe(0);
    expect(pressure.estimated).toBe(0);
    expect(pressure.level).toBe('ok');
  });

  it('blocks and releases the stored conversation, and never a renderer-supplied one', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'rogue chat', conversationId });

    const blocked = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(blocked.data).toEqual([conversationId]);
    expect(isChatBlocked(conversationId)).toBe(true);

    const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
    expect(released.ok, released.error).toBe(true);
    expect(released.data).toEqual([]);
    expect(isChatBlocked(conversationId)).toBe(false);

    // The renderer names a session; it can neither name a conversation nor block a session
    // that has none — the same boundary `sessions:openChat` holds.
    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = (await handlers.get('sessions:block')!(null, { id: unattributed.id, blocked: true })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
    resetBlockedChatsForTests();
  });

  it('releases a block when the row that carries its button is deleted', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'blocked then deleted', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    // Otherwise the conversation stays refused with nothing left in the app to release it.
    expect(isChatBlocked(conversationId)).toBe(false);
  });

  it('reports the blocked set with every session list, so one paint marks every row', async () => {
    const { resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while blocked', conversationId });

    expect((await sessionList()).data.blocked).toEqual([]);
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect((await sessionList()).data.blocked).toEqual([conversationId]);
    resetBlockedChatsForTests();
  });

  it('opens only the stored conversation URL in Chrome', async () => {
    const session = await createSession({
      title: 'open me',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    });
    const reply = await handlers.get('sessions:openChat')!(null, { id: session.id }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(openInPreferredBrowser).toHaveBeenCalledWith(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );

    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = await handlers.get('sessions:openChat')!(null, { id: unattributed.id }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
  });
});

describe('renderer pushes after the window is gone', () => {
  it('does not touch a destroyed BrowserWindow, whose members all throw', async () => {
    // Electron keeps the object after the window is destroyed, so the existing `?.` on
    // `getWindow()` never fires: the reference is truthy and reading `.webContents` throws.
    // The log push is the one that matters, because `onLog` listeners run synchronously on
    // the writer's stack — during a quit that turned every teardown log line into a throw
    // inside the teardown step that wrote it.
    const { logInfo } = await import('../src/main/logger.js');
    let touchedWebContents = false;
    const destroyed = {
      isDestroyed: () => true,
      get webContents() {
        touchedWebContents = true;
        throw new Error('Object has been destroyed');
      }
    } as unknown as import('electron').BrowserWindow;

    registerIpc(
      () => destroyed,
      () => {}
    );
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});

describe('Stop IPC exact session and turn authority', () => {
  it('requires an explicit current turn and cannot stop a replacement conversation', async () => {
    const invoke = (payload: unknown) => handlers.get('sessions:stopTurn')!(null, payload) as Promise<any>;
    const conversationId = 'f1111111-aaaa-4bbb-8ccc-111111111111';
    const session = await createSession({ title: 'Stop IPC', conversationId });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'ipc-stop-one' });
    expect((await invoke({ id: session.id })).ok).toBe(false);
    expect(await invoke({ id: session.id, expectedTurnId: 'other-turn' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    // A stored historical start alone cannot authorize stopping a browser turn.
    expect(await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    await rebindSession(session.id, conversationId, 'f2222222-aaaa-4bbb-8ccc-111111111111');
    expect((await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).ok).toBe(false);
    const missing = await createSession({ title: 'No browser ownership', conversationId: null });
    expect(await invoke({ id: missing.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'session_not_recorded' });
  });
});
