import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { RichMediaState } from '../src/shared/session.js';
import { openRichImageViewer, retireRichImageViewer } from '../src/renderer/rich-image.js';

let dom: JSDOM;
let trigger: HTMLButtonElement;
let image: ReturnType<typeof vi.fn>;
let unavailable: ReturnType<typeof vi.fn<() => void>>;
let current: boolean;
const sessionId = '2026-09-02-test0001';
const localImage = 'data:image/webp;base64,UklGRgAAAAA=';

const available = (): RichMediaState => ({
  mediaId: 'media-one', nodeId: 'figure', source: { kind: 'page', nodeId: 'figure' },
  status: 'available', previewWidth: 320, previewHeight: 180,
  asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
});
const owner = () => ({ trigger, current: () => current, unavailable: () => unavailable() });

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/', pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new dom.window.Event('close'));
  };
  trigger = dom.window.document.createElement('button');
  trigger.textContent = 'View saved preview';
  dom.window.document.body.append(trigger);
  trigger.focus();
  image = vi.fn(async () => ({ ok: true, data: localImage }));
  unavailable = vi.fn();
  current = true;
  (dom.window as any).api = { getSessionImage: image };
});
afterEach(() => { retireRichImageViewer(); dom.window.close(); vi.restoreAllMocks(); });

it('opens only the locally authorized saved preview with alt, retained pixel geometry, focus and close return', async () => {
  const objectUrl = vi.spyOn(URL, 'createObjectURL');
  const fetch = vi.fn();
  (dom.window as any).fetch = fetch;
  await openRichImageViewer(sessionId, available(), 'Forest and trees', owner());
  expect(image).toHaveBeenCalledExactlyOnceWith(sessionId, 'abcdef12.bin');
  const dialog = document.querySelector<HTMLDialogElement>('.rich-image-viewer')!;
  expect(dialog.getAttribute('role')).toBe('dialog');
  expect(dialog.getAttribute('aria-label')).toBe('Saved preview');
  expect(dialog.textContent).toContain('Saved preview · 320 × 180 px');
  const picture = dialog.querySelector('img')!;
  expect(picture.alt).toBe('Forest and trees');
  expect(picture.src).toBe(localImage);
  expect(dialog.style.getPropertyValue('--rich-preview-width')).toBe('320px');
  expect(dialog.style.getPropertyValue('--rich-preview-height')).toBe('180px');
  const close = dialog.querySelector<HTMLButtonElement>('button')!;
  expect(document.activeElement).toBe(close);
  close.click();
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(fetch).not.toHaveBeenCalled();
  expect(objectUrl).not.toHaveBeenCalled();
  expect(unavailable).not.toHaveBeenCalled();
});

it('closes on Escape and backdrop and does not restore focus to a detached trigger', async () => {
  await openRichImageViewer(sessionId, available(), 'Coast', owner());
  const first = document.querySelector<HTMLDialogElement>('.rich-image-viewer')!;
  const cancel = new dom.window.Event('cancel', { cancelable: true });
  first.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(document.activeElement).toBe(trigger);

  await openRichImageViewer(sessionId, available(), 'Coast', owner());
  const second = document.querySelector<HTMLDialogElement>('.rich-image-viewer')!;
  second.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  expect(document.querySelector('.rich-image-viewer')).toBeNull();

  await openRichImageViewer(sessionId, available(), 'Coast', owner());
  trigger.remove();
  retireRichImageViewer();
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(document.activeElement).not.toBe(trigger);
});

it('contains keyboard and outside focus while open, then releases focus containment on close and retirement', async () => {
  const outside = document.createElement('button');
  outside.textContent = 'Other action';
  document.body.append(outside);
  await openRichImageViewer(sessionId, available(), 'Focus-safe preview', owner());
  const dialog = document.querySelector<HTMLDialogElement>('.rich-image-viewer')!;
  const close = dialog.querySelector<HTMLButtonElement>('button')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  for (const shiftKey of [false, true]) {
    const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    close.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
  }
  outside.focus();
  expect(document.activeElement).toBe(close);
  close.click();
  outside.focus();
  expect(document.activeElement).toBe(outside);

  await openRichImageViewer(sessionId, available(), 'Focus-safe preview', owner());
  retireRichImageViewer();
  outside.focus();
  expect(document.activeElement).toBe(outside);
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
});

it('does not leak a focus guard if selection retires the viewer during initial modal focus', async () => {
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');
  const originalFocus = dom.window.HTMLElement.prototype.focus;
  const retiringFocus = vi.spyOn(dom.window.HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement, options?: FocusOptions
  ) {
    originalFocus.call(this, options);
    if (this.closest('.rich-image-viewer') && this.tagName === 'BUTTON') retireRichImageViewer();
  });
  await openRichImageViewer(sessionId, available(), 'Retired while opening', owner());
  const focusListeners = (spy: typeof added) => spy.mock.calls
    .filter(([name]) => name === 'focusin').map(([, listener]) => listener);
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(focusListeners(removed)).toEqual(focusListeners(added));

  retiringFocus.mockRestore();
  const outside = document.createElement('button');
  document.body.append(outside);
  await openRichImageViewer(sessionId, available(), 'Next current preview', owner());
  const dialog = document.querySelector<HTMLDialogElement>('.rich-image-viewer')!;
  const close = dialog.querySelector<HTMLButtonElement>('button')!;
  outside.focus();
  expect(document.activeElement).toBe(close);
  retireRichImageViewer();
  expect(focusListeners(removed)).toEqual(focusListeners(added));
});

it('does not fetch without available asset metadata or on an invalid retained geometry', async () => {
  for (const media of [
    { ...available(), status: 'pending', asset: undefined },
    { ...available(), status: 'unavailable', reason: 'removed', asset: undefined },
    { ...available(), status: 'available', asset: undefined },
    { ...available(), previewWidth: 0 },
    { ...available(), previewHeight: 2000 },
    { ...available(), asset: { id: 'https://remote.example/image', mimeType: 'image/webp', bytes: 12 } }
  ] as RichMediaState[]) {
    await openRichImageViewer(sessionId, media, 'Alt', owner());
    expect(document.querySelector('.rich-image-viewer')).toBeNull();
  }
  expect(image).not.toHaveBeenCalled();
});

it.each([
  null,
  'https://remote.example/image.webp',
  'blob:https://remote.example/abc',
  'data:image/png;base64,YQ==',
  'data:text/html;base64,YQ==',
  'data:image/webp;base64,%%%%'
])('refuses a missing, foreign or invalid image reply (%s), without remote authority', async response => {
  image.mockResolvedValueOnce({ ok: true, data: response });
  const fetch = vi.fn(); (dom.window as any).fetch = fetch;
  await openRichImageViewer(sessionId, available(), 'Alt', owner());
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(unavailable).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('refuses a failed local IPC reply and leaves no retry or browser input', async () => {
  image.mockRejectedValueOnce(new Error('asset removed'));
  (dom.window as any).api.retryRichImage = vi.fn();
  (dom.window as any).api.sendInput = vi.fn();
  await openRichImageViewer(sessionId, available(), 'Alt', owner());
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(unavailable).toHaveBeenCalledOnce();
  expect((dom.window as any).api.retryRichImage).not.toHaveBeenCalled();
  expect((dom.window as any).api.sendInput).not.toHaveBeenCalled();
});

it('permits only one pending viewer, and retires an old A → B → A request after selection changes', async () => {
  let resolve!: (value: unknown) => void;
  image.mockImplementation(() => new Promise(done => { resolve = done; }));
  const first = openRichImageViewer(sessionId, available(), 'Alt', owner());
  const duplicate = openRichImageViewer(sessionId, available(), 'Alt', owner());
  expect(image).toHaveBeenCalledTimes(1);
  current = false;
  retireRichImageViewer();
  current = true;
  resolve({ ok: true, data: localImage });
  await Promise.all([first, duplicate]);
  expect(document.querySelector('.rich-image-viewer')).toBeNull();
  expect(unavailable).not.toHaveBeenCalled();
});

it('groups images by canonical response across intervening metadata revisions', async () => {
  const { imageSetsForTimeline } = await import('../src/renderer/image-set.js');
  const image = (seq: number, messageId: string, asset: string, extra: Record<string, unknown> = {}) => ({
    kind: 'native_image', seq, messageId, providerAssetId: asset, previewStatus: 'available' as const,
    asset: { id: 'abcdef12.bin' }, ...extra
  });
  const sets = imageSetsForTimeline([
    image(1, 'response-a', 'asset-a', { origin: 1, width: 10, height: 8 }),
    { kind: 'progress', seq: 2, messageId: 'activity' },
    image(4, 'response-a', 'asset-b', { origin: 4 }),
    image(3, 'response-a', 'asset-a', { origin: 1, previewStatus: 'unavailable', previewError: 'quota' })
  ]);
  expect(sets).toHaveLength(1);
  expect(sets[0]!.responseId).toBe('response-a');
  expect(sets[0]!.origin).toBe(1);
  expect(sets[0]!.images.map(item => item.providerAssetId)).toEqual(['asset-a', 'asset-b']);
  expect(sets[0]!.images[0]).toMatchObject({ previewStatus: 'unavailable', previewError: 'quota', origin: 1, hasPreview: false, width: 10, height: 8 });
  expect(sets[0]!.completeness).toBe('partial');
});

it('does not merge adjacent images from different responses', async () => {
  const { imageSetsForTimeline } = await import('../src/renderer/image-set.js');
  const image = (seq: number, messageId: string, asset: string) => ({
    kind: 'native_image', seq, messageId, providerAssetId: asset, previewStatus: 'pending' as const
  });
  expect(imageSetsForTimeline([image(1, 'response-a', 'asset-a'), image(2, 'response-b', 'asset-b')])
    .map(set => set.images.length)).toEqual([1, 1]);
});

it('keeps a removed preview in the set without treating it as available', async () => {
  const { imageSetsForTimeline } = await import('../src/renderer/image-set.js');
  const sets = imageSetsForTimeline([{
    kind: 'native_image', seq: 9, origin: 2, messageId: 'response-a', providerAssetId: 'asset-a',
    previewStatus: 'unavailable', previewError: 'removed'
  }]);
  expect(sets[0]).toMatchObject({ completeness: 'unavailable', origin: 2, images: [{ hasPreview: false, previewError: 'removed' }] });
});

it('moves inside one set without fetching every preview or starting a download', async () => {
  const { openImageSetViewer, retireImageSetViewer } = await import('../src/renderer/image-set.js');
  const gallery = document.createElement('div');
  gallery.className = 'generated-image-gallery';
  const row = (asset: string, preview: string, src?: string) => {
    const node = document.createElement('div');
    node.className = 'ev ev-native_image';
    node.dataset.imageMessage = 'response-a';
    node.dataset.imageAsset = asset;
    node.dataset.imagePreview = preview;
    node.dataset.imageStatus = 'available';
    node.dataset.imageWidth = '320';
    node.dataset.imageHeight = '180';
    const open = document.createElement('button');
    open.className = 'image-set-open';
    node.append(open);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      node.append(img);
    }
    return node;
  };
  const localImage = 'data:image/webp;base64,UklGRgAAAAA=';
  const first = row('asset-a', 'abcdef12.bin', localImage);
  const second = row('asset-b', 'abcdef13.bin');
  gallery.append(first, second);
  document.body.append(gallery);
  const workbench = document.createElement('button');
  workbench.id = 'workPanelTab-files';
  const opened = vi.fn();
  workbench.addEventListener('click', opened);
  document.body.append(workbench);
  await openImageSetViewer({ row: first, sessionId, current: () => current });
  const dialog = document.querySelector<HTMLDialogElement>('dialog.image-set-viewer')!;
  expect(dialog.querySelector('.image-set-position')?.textContent).toBe('1 / 2');
  expect(dialog.querySelectorAll('.image-set-thumb')).toHaveLength(2);
  expect(dialog.querySelector('.image-set-thumb')?.getAttribute('aria-pressed')).toBe('true');
  expect(dialog.querySelector('.image-set-stage img')?.getAttribute('src')).toBe(localImage);
  expect(image).not.toHaveBeenCalled();
  expect(dialog.style.getPropertyValue('--image-set-width')).toBe('320px');
  dialog.querySelector<HTMLButtonElement>('.image-set-download')!.click();
  expect(image).not.toHaveBeenCalled();
  dialog.querySelector<HTMLButtonElement>('.image-set-next')!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(image).toHaveBeenCalledExactlyOnceWith(sessionId, 'abcdef13.bin');
  expect(dialog.querySelectorAll('.image-set-thumb')[1]?.getAttribute('aria-pressed')).toBe('true');
  const stage = dialog.querySelector('.image-set-stage')!;
  stage.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true }));
  stage.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 80, clientY: 4, bubbles: true }));
  stage.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
  expect(dialog.querySelector('.image-set-position')?.textContent).toBe('1 / 2');
  expect(image).toHaveBeenCalledOnce();
  dialog.querySelector<HTMLButtonElement>('.image-set-zoom-in')!.click();
  expect(dialog.querySelector<HTMLImageElement>('img')?.style.transform).toContain('scale(1.5)');
  dialog.querySelector<HTMLButtonElement>('.image-set-workbench')!.click();
  expect(opened).toHaveBeenCalledOnce();
  current = false;
  dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(document.querySelector('dialog.image-set-viewer')).toBeNull();
  expect(image).toHaveBeenCalledOnce();
  retireImageSetViewer();
});

it('shows the selected position while that preview read is still pending', async () => {
  const { openImageSetViewer, retireImageSetViewer } = await import('../src/renderer/image-set.js');
  let resolveImage: (value: unknown) => void = () => {};
  image.mockImplementation(() => new Promise(resolve => { resolveImage = resolve; }));
  const gallery = document.createElement('div');
  gallery.className = 'generated-image-gallery';
  const row = (asset: string, preview: string, src?: string) => {
    const node = document.createElement('div');
    node.className = 'ev ev-native_image';
    node.dataset.imageMessage = 'response-a';
    node.dataset.imageAsset = asset;
    node.dataset.imagePreview = preview;
    node.dataset.imageStatus = 'available';
    node.dataset.imageWidth = '32';
    node.dataset.imageHeight = '32';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      node.append(img);
    }
    gallery.append(node);
    return node;
  };
  const first = row('asset-a', 'abcdef12.bin', localImage);
  row('asset-b', 'abcdef13.bin');
  document.body.append(gallery);
  await openImageSetViewer({ row: first, sessionId, current: () => current });
  const dialog = document.querySelector<HTMLDialogElement>('dialog.image-set-viewer')!;
  dialog.querySelector<HTMLButtonElement>('.image-set-next')!.click();
  expect(dialog.querySelector('.image-set-position')?.textContent).toBe('2 / 2');
  expect(dialog.querySelector('.image-set-stage img')?.hasAttribute('src')).toBe(false);
  resolveImage({ ok: true, data: localImage });
  await Promise.resolve();
  await Promise.resolve();
  expect(dialog.querySelector('.image-set-stage img')?.getAttribute('src')).toBe(localImage);
  expect(image).toHaveBeenCalledExactlyOnceWith(sessionId, 'abcdef13.bin');
  retireImageSetViewer();
});

it('requests one exact original or bounded set and paints state receipts without reading provider URLs', async () => {
  const { applyImageSetMembers } = await import('../src/renderer/image-set.js');
  const download = vi.fn(async (_session: string, _message: string, assetIds: string[]) => ({ ok: true, data: {
    id: '11111111-2222-4333-8444-555555555555',
    sessionId,
    logicalMessageId: 'response-a',
    createdAt: 1,
    items: assetIds.map((assetId, index) => ({
      id: index === 0 ? '22222222-3333-4444-8555-666666666666' : '33333333-4444-4555-8666-777777777777',
      assetId,
      filename: `ChatBBC image 0${index + 1}.png`,
      state: 'requested',
      detail: null
    }))
  } }));
  let changed: ((batch: any) => void) | null = null;
  (window as any).api = {
    getSessionImage: image,
    downloadGeneratedAssets: download,
    generatedAssetDownloads: async () => ({ ok: true, data: [] }),
    onGeneratedAssetDownloadChanged: (listener: (batch: any) => void) => {
      changed = listener;
      return () => undefined;
    }
  };
  const gallery = document.createElement('div');
  gallery.className = 'generated-image-gallery';
  document.body.append(gallery);
  applyImageSetMembers(gallery, {
    responseId: 'response-a',
    origin: 1,
    completeness: 'complete',
    images: [
      { providerAssetId: 'file_AuroraOriginal0001', origin: 1, previewStatus: 'pending', hasPreview: false },
      { providerAssetId: 'file_AuroraOriginal0002', origin: 2, previewStatus: 'pending', hasPreview: false }
    ]
  }, { sessionId, current: () => current });
  const one = gallery.querySelector<HTMLButtonElement>('.image-set-download')!;
  one.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(download).toHaveBeenCalledWith(sessionId, 'response-a', ['file_AuroraOriginal0001']);
  expect(one.textContent).toBe('Download requested');
  const all = gallery.querySelector<HTMLButtonElement>('.image-set-download-all')!;
  all.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(download).toHaveBeenLastCalledWith(sessionId, 'response-a',
    ['file_AuroraOriginal0001', 'file_AuroraOriginal0002']);
  changed!({
    id: '11111111-2222-4333-8444-555555555555',
    sessionId,
    logicalMessageId: 'response-a',
    createdAt: 1,
    items: [
      { id: '22222222-3333-4444-8555-666666666666', assetId: 'file_AuroraOriginal0001',
        filename: 'ChatBBC image 01.png', state: 'complete', detail: null },
      { id: '33333333-4444-4555-8666-777777777777', assetId: 'file_AuroraOriginal0002',
        filename: 'ChatBBC image 02.png', state: 'unconfirmed', detail: null }
    ]
  });
  expect(one.textContent).toBe('Saved to browser Downloads');
  expect(all.textContent).toBe('Download outcome unconfirmed');
  expect(JSON.stringify(download.mock.calls)).not.toMatch(/https?:|signedUrl/i);
});

