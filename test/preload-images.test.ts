import { expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async (_channel: string, _payload?: unknown): Promise<unknown> => ({ ok: true, data: [] })), expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

it('transports pathless clipboard bytes and disk paths through one bounded image import', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenCalledWith('sessions:dropFiles', { files: [{ name: 'clipboard.png', bytes }, '/disk.png'] });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

it('exposes only the fixed, typed UI-selection reporting channel', async () => {
  vi.resetModules(); // The preceding test imported the preload; its spy calls are cleared per test.
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  invoke.mockImplementationOnce(async () => ({ ok: true, data: { sessionId: '12345678', generation: 42 } as any }));
  expect(await api.reportUiSelection({ sessionId: '12345678', rendererGeneration: 7 })).toEqual({
    ok: true, data: { sessionId: '12345678', generation: 42 }
  });
  expect(invoke).toHaveBeenLastCalledWith('sessions:uiSelection', { sessionId: '12345678', rendererGeneration: 7 });
  expect(api.invoke).toBeUndefined();
});

it('exposes a read-only rich-status wrapper with only the exact two identifiers', async () => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue({ ok: true, data: {
    id: '11111111-2222-4333-8444-555555555555', state: 'pending', detail: null
  } });
  expose.mockClear();
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  expect(await api.richActionStatus('2026-09-19-aaaaaaaa', '11111111-2222-4333-8444-555555555555'))
    .toEqual({ ok: true, data: {
      id: '11111111-2222-4333-8444-555555555555', state: 'pending', detail: null
    } });
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith('sessions:richActionStatus', {
    sessionId: '2026-09-19-aaaaaaaa', actionId: '11111111-2222-4333-8444-555555555555'
  });
  expect(api.invoke).toBeUndefined();
  expect(api.richAction).toBeUndefined();
  expect(api.openRichOriginal).toBeDefined(); // Fixed manual navigation, not richAction.
});

it('exposes only exact session/message identifiers for fixed manual original navigation, never a URL or command', async () => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue({ ok: true, data: true });
  expose.mockClear();
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  expect(await api.openRichOriginal('2026-09-19-aaaaaaaa', 'assistant:working:exchange:1789552000000'))
    .toEqual({ ok: true, data: true });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('sessions:richOpenOriginal', {
    sessionId: '2026-09-19-aaaaaaaa', messageId: 'assistant:working:exchange:1789552000000'
  });
  expect(api.invoke).toBeUndefined();
  expect(api.richAction).toBeUndefined();
});

it('exposes a fixed read-only PAGE eligibility request without browser, URL, or retry command authority', async () => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue({ ok: true, data: {
    status: 'unavailable', reason: 'removed', requiresRemovalConfirmation: true, eligibilityOnly: true
  } });
  expose.mockClear();
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  expect(await api.richRetryEligibility('2026-09-19-aaaaaaaa', 'assistant:working:exchange:1789552000000',
    'card-image-b', 'image-node-b', 1)).toEqual({ ok: true, data: {
      status: 'unavailable', reason: 'removed', requiresRemovalConfirmation: true, eligibilityOnly: true
    } });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('sessions:richRetryEligibility', {
    sessionId: '2026-09-19-aaaaaaaa', messageId: 'assistant:working:exchange:1789552000000',
    mediaId: 'card-image-b', nodeId: 'image-node-b', richRevision: 1
  });
  expect(api.invoke).toBeUndefined();
  expect(api.retryRichImage).toBeUndefined();
  expect(api.richAction).toBeUndefined();
});
