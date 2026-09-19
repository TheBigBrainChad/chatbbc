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
