import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { RichNode, RichResponse } from '../src/shared/rich-response.js';
import type { RichMediaState } from '../src/shared/session.js';
import { renderRichResponse } from '../src/renderer/rich-response.js';

let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
});
afterAll(() => dom.window.close());

const prose = (id: string, text: string, style: 'body' | 'heading' | 'caption' | 'code' = 'body'): RichNode =>
  ({ id, kind: 'text', style, text });
const group = (id: string, layout: Extract<RichNode, { kind: 'group' }>['layout'], children: RichNode[]): RichNode =>
  ({ id, kind: 'group', layout, children });
const choice = (id: string, label: string, selected = false): RichNode => ({
  id, kind: 'control', control: 'choice', label, groupId: 'plan', value: id,
  selected, disabled: false, children: []
});
const fixture = (nodes: RichNode[]): RichResponse => ({
  version: 1, status: 'available', reason: null,
  conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: 'assistant:working:exchange:1789552000000',
  providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
  revision: 1, accessibleText: 'Choose a plan', nodes
});

it('renders a choice and two semantic cards without parsing component source or enabling actions', () => {
  const rich = fixture([group('options', 'grid', [
    group('first', 'card', [prose('first-title', 'Starter', 'heading'), choice('first-choice', 'Starter', true)]),
    group('second', 'card', [prose('second-title', 'Advanced', 'heading'), choice('second-choice', 'Advanced')])
  ]), { id: 'continue', kind: 'control', control: 'continue', label: 'Continue', groupId: null,
    value: null, selected: false, disabled: false, children: [] }]);
  const view = renderRichResponse(rich, '<text>source</text>');
  expect(view.querySelectorAll('.rich-card')).toHaveLength(2);
  expect(view.querySelector('.rich-layout.rich-grid')).not.toBeNull();
  expect(view.textContent).toContain('Starter');
  expect(view.textContent).not.toContain('<text>source</text>');
  expect(view.querySelector('[data-rich-control="first-choice"]')?.getAttribute('aria-checked')).toBe('true');
  const continueButton = view.querySelector<HTMLButtonElement>('[data-rich-control="continue"]')!;
  expect(continueButton.disabled).toBe(true);
  expect(continueButton.getAttribute('aria-disabled')).toBe('true');
  const click = vi.fn();
  (dom.window as any).api = { openLink: click, sendInput: click };
  continueButton.click();
  expect(click).not.toHaveBeenCalled();
  expect(view.querySelector('[data-rich-control="continue"]')?.closest('[tabindex="0"]')).not.toBeNull();
  expect(view.querySelector('script, form, iframe, a[href], img[src]')).toBeNull();
});

it('offers manual original only as an app-owned direct button; synthetic click, keyboard, stale and detached events never request it', async () => {
  const openOriginal = vi.fn(async () => true);
  let current = true;
  const rich = fixture([choice('historical-choice', 'Choose Forest')]);
  const view = renderRichResponse(rich, 'canonical source', {
    sessionId: '2026-09-02-test0001', media: [], current: () => current, openOriginal
  });
  document.body.append(view);
  try {
    const button = view.querySelector<HTMLButtonElement>('.rich-open-original')!;
    expect(button?.textContent).toBe('Open original in ChatGPT');
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(view.querySelector('[data-rich-control="historical-choice"]')?.getAttribute('aria-disabled')).toBe('true');
    button.click();
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openOriginal).not.toHaveBeenCalled();
    current = false;
    button.click();
    view.remove();
    button.click();
    expect(openOriginal).not.toHaveBeenCalled();
  } finally { view.remove(); }
  const broken = renderRichResponse({ ...rich, nodes: [] }, 'unavailable source', {
    sessionId: '2026-09-02-test0001', media: [], current: () => true, openOriginal
  });
  expect(broken.querySelector('.rich-open-original')).not.toBeNull();
  expect(broken.textContent).toContain('Rich content unavailable');
  broken.querySelector<HTMLButtonElement>('.rich-open-original')!.click();
  expect(openOriginal).not.toHaveBeenCalled();
});

it('contains wide tables and diagrams in labelled keyboard-scrollable regions with inert image slots', () => {
  const view = renderRichResponse(fixture([
    group('wide-table', 'table', [group('row', 'row', [prose('cell', 'Long cell')])]),
    group('diagram', 'diagram', [prose('diagram-text', 'Diagram description')]),
    { id: 'figure', kind: 'image', mediaId: 'image-b', alt: 'Architecture drawing', width: 1600, height: 900 }
  ]), 'raw');
  for (const selector of ['.rich-table', '.rich-diagram']) {
    const region = view.querySelector<HTMLElement>(selector)!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute('aria-label')).toBeTruthy();
  }
  expect(view.querySelector('.rich-table [role="table"] [role="row"] [role="cell"]')?.textContent).toContain('Long cell');
  const image = view.querySelector<HTMLElement>('.rich-image-slot')!;
  expect(image.style.aspectRatio).toBe('1600 / 900');
  expect(image.getAttribute('role')).toBe('img');
  expect(image.getAttribute('aria-label')).toBe('Architecture drawing — Image preview unavailable');
  expect(image.textContent).toMatch(/preview.*(loading|unavailable)/i);
  expect(view.querySelector('img, canvas, svg')).toBeNull();
});

it('shows real pending, quota, tainted and removed reasons without a viewer or image IPC', () => {
  const reasons = ['pending', 'quota', 'tainted', 'oversized', 'removed'] as const;
  const getSessionImage = vi.fn();
  (dom.window as any).api = { getSessionImage };
  for (const reason of reasons) {
    const media: RichMediaState = {
      mediaId: 'figure-media', nodeId: 'figure', source: { kind: 'page', nodeId: 'figure' },
      status: reason === 'pending' ? 'pending' : 'unavailable',
      ...(reason === 'pending' ? {} : { reason })
    };
    const view = renderRichResponse(fixture([
      { id: 'figure', kind: 'image', mediaId: 'figure-media', alt: 'Blue forest', width: 320, height: 180 }
    ]), 'source', { sessionId: '2026-09-02-test0001', media: [media], current: () => true });
    expect(view.textContent?.toLowerCase()).toContain(reason === 'pending' ? 'loading' :
      reason === 'quota' ? 'storage' : reason === 'tainted' ? 'tainted' :
        reason === 'oversized' ? 'limit' : 'removed');
    expect(view.textContent).toContain('Blue forest');
    expect(view.querySelector('button, img[src], a[href]')).toBeNull();
  }
  expect(getSessionImage).not.toHaveBeenCalled();
});

it('offers only exact uniquely joined available local assets and keeps duplicate or mismatched media inert', () => {
  const rich = fixture([
    { id: 'figure', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 320, height: 180 },
    { id: 'coast', kind: 'image', mediaId: 'coast-media', alt: 'Coast', width: 320, height: 180 }
  ]);
  const media: RichMediaState = {
    mediaId: 'forest-media', nodeId: 'figure', source: { kind: 'page', nodeId: 'figure' },
    status: 'available', previewWidth: 320, previewHeight: 180,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
  };
  const options = (items: RichMediaState[]) => ({ sessionId: '2026-09-02-test0001', media: items, current: () => true });
  const valid = renderRichResponse(rich, 'source', options([media]));
  expect(valid.querySelectorAll<HTMLButtonElement>('.rich-image-slot button')).toHaveLength(1);
  expect(valid.querySelector<HTMLButtonElement>('.rich-image-slot button')?.textContent).toBe('View saved preview');
  expect(valid.querySelectorAll('img[src]')).toHaveLength(0);
  expect(valid.querySelector<HTMLElement>('[data-rich-node-id="coast"]')?.textContent).toContain('unavailable');
  for (const malformed of [[media, media], [{ ...media, nodeId: 'coast' }],
    [{ ...media, source: { kind: 'page' as const, nodeId: 'coast' } }]]) {
    const view = renderRichResponse(rich, 'source', options(malformed));
    expect(view.querySelector('button, img[src]')).toBeNull();
  }
  const duplicatedNodes = fixture([
    { id: 'figure', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 320, height: 180 },
    { id: 'second-figure', kind: 'image', mediaId: 'forest-media', alt: 'Different', width: 320, height: 180 }
  ]);
  expect(renderRichResponse(duplicatedNodes, 'source', options([media])).querySelector('button')).toBeNull();
});

it('hydrates an exact available rich image from its local saved-preview reader inside its card, never a provider URL', async () => {
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: '#335577' } }).webp().toBuffer();
  expect(await sharp(pixels).metadata()).toMatchObject({ format: 'webp', width: 4, height: 3 });
  const preview = `data:image/webp;base64,${pixels.toString('base64')}`;
  let resolve!: (reply: { ok: true; data: string }) => void;
  const getImage = vi.fn(() => new Promise<{ ok: true; data: string }>(done => { resolve = done; }));
  (dom.window as any).api = { getSessionImage: getImage };
  const rich = fixture([group('choices', 'grid', [group('forest-card', 'card', [
    { id: 'forest-picture', kind: 'image', mediaId: 'forest-media', alt: 'Forest option', width: 640, height: 480 },
    choice('forest-choice', 'Forest')
  ])])]);
  const media: RichMediaState = { mediaId: 'forest-media', nodeId: 'forest-picture',
    source: { kind: 'page', nodeId: 'forest-picture' }, status: 'available',
    previewWidth: 4, previewHeight: 3,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: pixels.length } };
  const view = renderRichResponse(rich, 'source', {
    sessionId: '2026-09-02-test0001', media: [media], current: () => true
  });
  document.body.append(view);
  try {
    await vi.waitFor(() => expect(getImage).toHaveBeenCalledExactlyOnceWith('2026-09-02-test0001', 'abcdef12.bin'));
    expect(view.querySelector('img[src]')).toBeNull(); // Pending local IPC cannot invent pixels.
    resolve({ ok: true, data: preview });
    await vi.waitFor(() => expect(view.querySelector<HTMLImageElement>('.rich-card .rich-image-slot img')?.src).toBe(preview));
    expect(view.querySelector('.rich-card .rich-image-slot img')?.getAttribute('alt')).toBe('Forest option');
    expect(view.querySelector('.rich-card [data-rich-control="forest-choice"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(view.querySelector('.rich-card img[src^="http"]')).toBeNull();
    expect(view.querySelector('.rich-image-slot')?.textContent).toContain('Saved preview');
  } finally { view.remove(); }
});

it('hydrates a custody-bearing PAGE saved preview and rejects incomplete or malformed page custody without image IPC', async () => {
  const pixels = await sharp({ create: { width: 5, height: 4, channels: 3,
    background: '#29496b' } }).webp().toBuffer();
  const assetId = `${createHash('sha256').update(pixels).digest('hex').slice(0, 32)}.bin`;
  const preview = `data:image/webp;base64,${pixels.toString('base64')}`;
  const getImage = vi.fn(async () => ({ ok: true as const, data: preview }));
  Object.assign(dom.window, { api: { getSessionImage: getImage } });
  const rich = fixture([
    { id: 'page-picture', kind: 'image', mediaId: 'page-media', alt: 'Saved PAGE preview',
      width: 500, height: 400 }
  ]);
  const media: RichMediaState = {
    mediaId: 'page-media', nodeId: 'page-picture',
    source: { kind: 'page', nodeId: 'page-picture' },
    pageSource: { slotVersion: 4, sequence: 3,
      incarnation: `src_${'a'.repeat(32)}_3`, recordingRevision: 7 },
    status: 'available', previewWidth: 5, previewHeight: 4,
    asset: { id: assetId, mimeType: 'image/webp', bytes: pixels.length }
  };
  const valid = renderRichResponse(rich, 'Canonical source', {
    sessionId: '2026-09-02-test0001', media: [media], current: () => true
  });
  document.body.append(valid);
  try {
    await vi.waitFor(() => expect(getImage)
      .toHaveBeenCalledExactlyOnceWith('2026-09-02-test0001', assetId));
    await vi.waitFor(() => expect(valid.querySelector<HTMLImageElement>(
      '[data-rich-node-id="page-picture"] img')?.src).toBe(preview));
  } finally { valid.remove(); }

  for (const pageSource of [
    { slotVersion: 4 },
    { slotVersion: 4, sequence: 3 },
    { ...media.pageSource!, slotVersion: -1 }
  ] satisfies RichMediaState['pageSource'][]) {
    getImage.mockClear();
    const refused = renderRichResponse(rich, 'Canonical source', {
      sessionId: '2026-09-02-test0001', media: [{ ...media, pageSource }],
      current: () => true
    });
    document.body.append(refused);
    try {
      await Promise.resolve();
      const slot = refused.querySelector<HTMLElement>('[data-rich-node-id="page-picture"]')!;
      expect(slot.getAttribute('role')).toBe('img');
      expect(slot.textContent).toContain('Image preview unavailable');
      expect(slot.querySelector('button, img[src]')).toBeNull();
      expect(getImage).not.toHaveBeenCalled();
    } finally { refused.remove(); }
  }
});

it('hydrates two independently owned saved previews inside their corresponding inert choice cards', async () => {
  const first = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: '#335577' } }).webp().toBuffer();
  const second = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: '#775533' } }).webp().toBuffer();
  const id = (bytes: Buffer) => `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.bin`;
  const previews = new Map([[id(first), `data:image/webp;base64,${first.toString('base64')}`],
    [id(second), `data:image/webp;base64,${second.toString('base64')}`]]);
  const getImage = vi.fn(async (_sessionId: string, assetId: string) => ({
    ok: true as const, data: previews.get(assetId) ?? ''
  }));
  (dom.window as any).api = { getSessionImage: getImage };
  const rich = fixture([group('choices', 'grid', [
    group('forest-card', 'card', [
      { id: 'forest-picture', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 640, height: 480 },
      choice('forest-choice', 'Forest')
    ]),
    group('coast-card', 'card', [
      { id: 'coast-picture', kind: 'image', mediaId: 'coast-media', alt: 'Coast', width: 640, height: 480 },
      choice('coast-choice', 'Coast')
    ])
  ])]);
  const media = (mediaId: string, nodeId: string, bytes: Buffer): RichMediaState => ({
    mediaId, nodeId, source: { kind: 'page', nodeId }, status: 'available',
    previewWidth: 4, previewHeight: 3,
    asset: { id: id(bytes), mimeType: 'image/webp', bytes: bytes.length }
  });
  const view = renderRichResponse(rich, 'source', {
    sessionId: '2026-09-02-test0001', current: () => true,
    media: [media('forest-media', 'forest-picture', first),
      media('coast-media', 'coast-picture', second)]
  });
  document.body.append(view);
  try {
    // jsdom verifies exact local data placement, not browser rasterization or live capture.
    await vi.waitFor(() => expect(view.querySelectorAll('.rich-card .rich-image-slot img')).toHaveLength(2));
    expect(getImage.mock.calls).toEqual([
      ['2026-09-02-test0001', id(first)], ['2026-09-02-test0001', id(second)]
    ]);
    expect([...view.querySelectorAll<HTMLImageElement>('.rich-card img')].map(img => img.src))
      .toEqual([previews.get(id(first)), previews.get(id(second))]);
    expect([...view.querySelectorAll('.rich-card')].map(card => card.querySelector('img')?.alt))
      .toEqual(['Forest', 'Coast']);
    expect([...view.querySelectorAll('.rich-card')].every(card =>
      card.querySelector('[data-rich-control]')?.getAttribute('aria-disabled') === 'true')).toBe(true);
  } finally { view.remove(); }
});

it('defers an offscreen inline preview until viewport admission and releases its pixels when it leaves', async () => {
  const originalObserver = (dom.window as any).IntersectionObserver;
  let emit!: (visible: boolean) => void;
  let observed: Element | null = null;
  class ViewportObserver {
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
    observe(target: Element): void {
      observed = target;
      emit = visible => this.callback([{
        target, isIntersecting: visible
      } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect(): void { observed = null; }
  }
  (dom.window as any).IntersectionObserver = ViewportObserver;
  const data = 'data:image/webp;base64,UklGRgAAAAA=';
  const read = vi.fn(async () => ({ ok: true as const, data }));
  (dom.window as any).api = { getSessionImage: read };
  const image: RichNode = { id: 'offscreen-image', kind: 'image', mediaId: 'offscreen-media',
    alt: 'Viewport image', width: 320, height: 180 };
  const media: RichMediaState = { mediaId: 'offscreen-media', nodeId: 'offscreen-image',
    source: { kind: 'page', nodeId: 'offscreen-image' }, status: 'available',
    previewWidth: 320, previewHeight: 180,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 } };
  const view = renderRichResponse(fixture([image]), 'source', {
    sessionId: '2026-09-02-test0001', media: [media], current: () => true
  });
  document.body.append(view);
  try {
    await vi.waitFor(() => expect(observed).toBe(view.querySelector('.rich-image-slot')));
    expect(read).not.toHaveBeenCalled();
    emit(true);
    await vi.waitFor(() => expect(view.querySelector('img[src]')?.getAttribute('src')).toBe(data));
    emit(false);
    expect(view.querySelector('img[src]')).toBeNull();
    expect(view.querySelector('.rich-image-slot button')?.textContent).toBe('View saved preview');
    emit(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.querySelector('img[src]')?.getAttribute('src')).toBe(data));
  } finally {
    view.remove();
    (dom.window as any).IntersectionObserver = originalObserver;
  }
});

it('limits inline decoding to four concurrent reads while retaining every preview in its exact slot', async () => {
  const data = 'data:image/webp;base64,UklGRgAAAAA=';
  const completes: Array<() => void> = [];
  const read = vi.fn(() => new Promise<{ ok: true; data: string }>(resolve => {
    completes.push(() => resolve({ ok: true, data }));
  }));
  (dom.window as any).api = { getSessionImage: read };
  const nodes: RichNode[] = Array.from({ length: 6 }, (_, index) => ({
    id: `bounded-node-${index}`, kind: 'image' as const,
    mediaId: `bounded-media-${index}`, alt: `Saved image ${index}`, width: 4, height: 3
  }));
  const media: RichMediaState[] = nodes.map((node, index) => ({
    mediaId: `bounded-media-${index}`, nodeId: node.id,
    source: { kind: 'page', nodeId: node.id }, status: 'available',
    previewWidth: 4, previewHeight: 3,
    asset: { id: `${String(index).padStart(8, '0')}.bin`, mimeType: 'image/webp', bytes: 12 }
  }));
  const view = renderRichResponse(fixture(nodes), 'source', {
    sessionId: '2026-09-02-test0001', media, current: () => true
  });
  document.body.append(view);
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect(completes).toHaveLength(4); // Remaining two cannot hold IPC responses yet.
    completes[0]!();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    completes[1]!();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6));
    completes.slice(2).forEach(complete => complete());
    await vi.waitFor(() => expect(view.querySelectorAll('.rich-image-slot img[src]')).toHaveLength(6));
    expect([...view.querySelectorAll<HTMLImageElement>('.rich-image-slot img')].map(img => img.alt))
      .toEqual(nodes.map((_, index) => `Saved image ${index}`));
  } finally { view.remove(); }
});

it('times out four hung UI reads without exceeding four physical IPCs or painting late pixels', async () => {
  const data = 'data:image/webp;base64,UklGRgAAAAA=';
  const late: Array<(reply: { ok: true; data: string }) => void> = [];
  let started = 0;
  const read = vi.fn(() => {
    started++;
    if (started <= 4) return new Promise<{ ok: true; data: string }>(resolve => { late.push(resolve); });
    return Promise.resolve({ ok: true as const, data });
  });
  (dom.window as any).api = { getSessionImage: read };
  const nodes: RichNode[] = Array.from({ length: 5 }, (_, index) => ({
    id: `timeout-node-${index}`, kind: 'image' as const,
    mediaId: `timeout-media-${index}`, alt: `Timed image ${index}`, width: 4, height: 3
  }));
  const media: RichMediaState[] = nodes.map((node, index) => ({
    mediaId: `timeout-media-${index}`, nodeId: node.id,
    source: { kind: 'page', nodeId: node.id }, status: 'available',
    previewWidth: 4, previewHeight: 3,
    asset: { id: `${String(index).padStart(8, '0')}.bin`, mimeType: 'image/webp', bytes: 12 }
  }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const view = renderRichResponse(fixture(nodes), 'source', {
    sessionId: '2026-09-02-test0001', media, current: () => true
  });
  document.body.append(view);
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    expect(view.querySelectorAll('img[src]')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(12_000);
    await Promise.resolve();
    // Promise.race cannot cancel the underlying named IPC. It remains bounded to
    // four actual outstanding invokes even after logical timeouts release UI slots.
    expect(read).toHaveBeenCalledTimes(4);
    expect(view.querySelectorAll('.rich-image-slot button')).toHaveLength(5);
    late[0]!({ ok: true, data }); // A genuinely settled IPC releases capacity.
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(0); // Drain the fifth reader's async source and DOM insertion.
    expect(view.querySelectorAll('img[src]')).toHaveLength(1);
    expect(view.querySelector('[data-rich-node-id="timeout-node-4"] img[src]')).not.toBeNull();
    late.slice(1).forEach(resolve => resolve({ ok: true, data }));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.querySelectorAll('img[src]')).toHaveLength(1);
    expect(view.querySelectorAll('.rich-image-slot button')).toHaveLength(5);
  } finally {
    view.remove();
    vi.useRealTimers();
  }
});

it('evicts large inline base64 images under a measured resident budget without retiring saved viewers', async () => {
  // A plausible 7 MiB owned asset can produce ~9 MiB of base64 data. Three such
  // resident URLs exceed the inline 24 MiB code-unit cap even in a DOM-only test.
  const data = `data:image/webp;base64,${'A'.repeat(9 * 1024 * 1024)}`;
  const read = vi.fn(async () => ({ ok: true as const, data }));
  (dom.window as any).api = { getSessionImage: read };
  const nodes: RichNode[] = Array.from({ length: 3 }, (_, index) => ({
    id: `large-node-${index}`, kind: 'image' as const,
    mediaId: `large-media-${index}`, alt: `Large image ${index}`, width: 1600, height: 1600
  }));
  const media: RichMediaState[] = nodes.map((node, index) => ({
    mediaId: `large-media-${index}`, nodeId: node.id,
    source: { kind: 'page', nodeId: node.id }, status: 'available',
    previewWidth: 1600, previewHeight: 1600,
    asset: { id: `${String(index).padStart(8, '0')}.bin`, mimeType: 'image/webp', bytes: 7 * 1024 * 1024 }
  }));
  const view = renderRichResponse(fixture(nodes), 'source', {
    sessionId: '2026-09-02-test0001', media, current: () => true
  });
  document.body.append(view);
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(view.querySelectorAll('.rich-image-slot img[src]')).toHaveLength(2));
    expect(view.querySelector('[data-rich-node-id="large-node-0"] img[src]')).toBeNull();
    expect([...view.querySelectorAll<HTMLImageElement>('.rich-image-slot img')].map(img => img.alt))
      .toEqual(['Large image 1', 'Large image 2']);
    expect(view.querySelectorAll('.rich-image-slot button')).toHaveLength(3);
  } finally { view.remove(); }
});

it('bounds decoded RGBA residency and rehydrates a still-visible evicted slot when another leaves', async () => {
  const originalObserver = (dom.window as any).IntersectionObserver;
  const visibility = new Map<Element, (visible: boolean) => void>();
  class ViewportObserver {
    private target: Element | null = null;
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.target = target;
      visibility.set(target, visible => this.callback([{
        target, isIntersecting: visible
      } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    disconnect(): void {
      if (this.target) visibility.delete(this.target);
      this.target = null;
    }
  }
  (dom.window as any).IntersectionObserver = ViewportObserver;
  const data = 'data:image/webp;base64,UklGRgAAAAA=';
  const read = vi.fn(async () => ({ ok: true as const, data }));
  (dom.window as any).api = { getSessionImage: read };
  // Each legal 1600² preview could decode to ~10 MiB of RGBA despite tiny WebP.
  const nodes: RichNode[] = Array.from({ length: 4 }, (_, index) => ({
    id: `pixel-node-${index}`, kind: 'image' as const,
    mediaId: `pixel-media-${index}`, alt: `Pixel image ${index}`, width: 1600, height: 1600
  }));
  const media: RichMediaState[] = nodes.map((node, index) => ({
    mediaId: `pixel-media-${index}`, nodeId: node.id,
    source: { kind: 'page', nodeId: node.id }, status: 'available',
    previewWidth: 1600, previewHeight: 1600,
    asset: { id: `${String(index).padStart(8, '0')}.bin`, mimeType: 'image/webp', bytes: 12 }
  }));
  const view = renderRichResponse(fixture(nodes), 'source', {
    sessionId: '2026-09-02-test0001', media, current: () => true
  });
  document.body.append(view);
  try {
    const slots = [...view.querySelectorAll<HTMLElement>('.rich-image-slot')];
    await vi.waitFor(() => expect(visibility.size).toBe(4));
    for (const slot of slots) visibility.get(slot)!(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(view.querySelectorAll('.rich-image-slot img[src]')).toHaveLength(3));
    expect(slots[0]!.querySelector('img[src]')).toBeNull(); // Oldest still-visible image was evicted.
    expect(slots[0]!.querySelector('button')?.textContent).toBe('View saved preview');
    visibility.get(slots[3]!)!(false); // A genuinely offscreen image frees enough decoded pixels.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(slots[0]!.querySelector('img[src]')).not.toBeNull());
    expect(slots[3]!.querySelector('img[src]')).toBeNull();
    expect(view.querySelectorAll('.rich-image-slot img[src]')).toHaveLength(3);
  } finally {
    view.remove();
    (dom.window as any).IntersectionObserver = originalObserver;
  }
});

it('retains the saved viewer through a transient inline read failure and bounds automatic retries', async () => {
  const originalObserver = (dom.window as any).IntersectionObserver;
  let emit!: (visible: boolean) => void;
  class ViewportObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      emit = visible => this.callback([{
        target, isIntersecting: visible
      } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect(): void {}
  }
  (dom.window as any).IntersectionObserver = ViewportObserver;
  const read = vi.fn().mockRejectedValueOnce(new Error('transient IPC error'))
    .mockResolvedValueOnce({ ok: true, data: 'data:image/webp;base64,UklGRgAAAAA=' });
  (dom.window as any).api = { getSessionImage: read };
  const view = renderRichResponse(fixture([{
    id: 'retry-node', kind: 'image', mediaId: 'retry-media', alt: 'Retry image', width: 4, height: 3
  }]), 'source', { sessionId: '2026-09-02-test0001', current: () => true, media: [{
    mediaId: 'retry-media', nodeId: 'retry-node', source: { kind: 'page', nodeId: 'retry-node' },
    status: 'available', previewWidth: 4, previewHeight: 3,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
  }] });
  document.body.append(view);
  try {
    await vi.waitFor(() => expect(typeof emit).toBe('function'));
    emit(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(view.textContent).toContain('could not load inline'));
    expect(view.querySelector('button')?.textContent).toBe('View saved preview');
    emit(false);
    emit(true);
    await vi.waitFor(() => expect(view.querySelector('img[src]')).not.toBeNull());
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.textContent).toContain('Saved preview');
  } finally {
    view.remove();
    (dom.window as any).IntersectionObserver = originalObserver;
  }
});

it('never paints a stale A→B→A rich image read or a nonlocal/invalid image reply', async () => {
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3,
    background: '#335577' } }).webp().toBuffer();
  const validPreview = `data:image/webp;base64,${pixels.toString('base64')}`;
  let selectedGeneration = 1;
  let resolve!: (reply: { ok: true; data: string }) => void;
  const getImage = vi.fn(() => new Promise<{ ok: true; data: string }>(done => { resolve = done; }));
  (dom.window as any).api = { getSessionImage: getImage };
  const rich = fixture([{ id: 'forest-picture', kind: 'image', mediaId: 'forest-media',
    alt: 'Forest option', width: 640, height: 480 }]);
  const media: RichMediaState = { mediaId: 'forest-media', nodeId: 'forest-picture',
    source: { kind: 'page', nodeId: 'forest-picture' }, status: 'available',
    previewWidth: 4, previewHeight: 3,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 } };
  const old = renderRichResponse(rich, 'source', { sessionId: '2026-09-02-test0001',
    media: [media], current: () => selectedGeneration === 1 });
  document.body.append(old);
  try {
    await vi.waitFor(() => expect(getImage).toHaveBeenCalledTimes(1));
    selectedGeneration = 2;
    selectedGeneration = 3;
    // Valid local pixels must not resurrect an image after selection A→B→A.
    resolve({ ok: true, data: validPreview });
    await Promise.resolve();
    await Promise.resolve();
    expect(old.querySelector('img[src], a[href], script')).toBeNull();
  } finally { old.remove(); }

  for (const invalid of ['https://remote.example/unsafe.webp',
    'data:image/png;base64,Ymx1ZQ==', 'data:image/webp;base64,NOT-BASE64']) {
    const freshRead = vi.fn(async () => ({ ok: true, data: invalid }));
    (dom.window as any).api = { getSessionImage: freshRead };
    const fresh = renderRichResponse(rich, 'source', { sessionId: '2026-09-02-test0001',
      media: [media], current: () => true });
    document.body.append(fresh);
    try {
      await vi.waitFor(() => expect(fresh.querySelector('.rich-image-slot')?.textContent).toContain('Image preview unavailable'));
      expect(fresh.querySelector('img[src], a[href], script, .rich-image-slot button')).toBeNull();
    } finally { fresh.remove(); }
  }
});

it('renders malformed media entries as inert placeholders while preserving the rest of the rich answer', () => {
  const rich = fixture([
    prose('introduction', 'Keep this answer readable'),
    { id: 'figure', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 320, height: 180 }
  ]);
  const valid: RichMediaState = {
    mediaId: 'forest-media', nodeId: 'figure', source: { kind: 'page', nodeId: 'figure' },
    status: 'available', previewWidth: 320, previewHeight: 180,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
  };
  const unknownSource = { ...valid, source: {
    kind: 'unknown', providerMessageId: rich.providerMessageId,
    providerAssetId: 'native-asset'
  } };
  const badEntries: unknown[][] = [
    [null], [undefined], [{ ...valid, source: undefined }],
    [{ ...valid, source: null }], [unknownSource], [valid, null],
    [{ ...valid, source: { kind: 'native', providerMessageId: rich.providerMessageId } }]
  ];
  const getSessionImage = vi.fn();
  (dom.window as any).api = { getSessionImage };
  for (const entries of badEntries) {
    const view = renderRichResponse(rich, 'source', {
      sessionId: '2026-09-02-test0001', media: entries as RichMediaState[], current: () => true
    });
    const slot = view.querySelector<HTMLElement>('.rich-image-slot')!;
    expect(view.querySelector('.rich-body')?.textContent).toBe('Keep this answer readable');
    expect(slot.getAttribute('role')).toBe('img');
    expect(slot.textContent).toContain('Image preview unavailable');
    expect(view.querySelector('button, img[src], a[href]')).toBeNull();
  }
  expect(getSessionImage).not.toHaveBeenCalled();
});

it('does not execute media getters or trust a proxy property read instead of its own data descriptor', () => {
  const rich = fixture([
    { id: 'figure', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 320, height: 180 }
  ]);
  const valid: RichMediaState = {
    mediaId: 'forest-media', nodeId: 'figure', source: { kind: 'page', nodeId: 'figure' },
    status: 'available', previewWidth: 320, previewHeight: 180,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
  };
  const getter = vi.fn(() => 'forest-media');
  const withGetter = Object.defineProperty({ ...valid }, 'mediaId', { enumerable: true, get: getter });
  const contradictorySource = new Proxy({ kind: 'unknown', providerMessageId: rich.providerMessageId,
    providerAssetId: 'native-asset' }, {
    get(target, name, receiver) {
      return name === 'kind' ? 'native' : Reflect.get(target, name, receiver);
    }
  });
  const throwingProxy = new Proxy(valid, { ownKeys: () => { throw Error('untrusted media proxy'); } });
  const mediaArrays: unknown[] = [
    [withGetter], [{ ...valid, source: contradictorySource }], [throwingProxy],
    Object.defineProperty([valid], '0', { get: () => { throw Error('untrusted array getter'); } })
  ];
  for (const value of mediaArrays) {
    const view = renderRichResponse(rich, 'source', {
      sessionId: '2026-09-02-test0001', media: value as RichMediaState[], current: () => true
    });
    expect(view.querySelector('.rich-image-slot')?.getAttribute('role')).toBe('img');
    expect(view.querySelector('.rich-image-slot')?.textContent).toContain('Image preview unavailable');
    expect(view.querySelector('button, img[src]')).toBeNull();
  }
  expect(getter).not.toHaveBeenCalled();
});

it('permits an exact native provider source only when its shape and provider ownership match', () => {
  const rich = fixture([
    { id: 'figure', kind: 'image', mediaId: 'forest-media', alt: 'Forest', width: 320, height: 180 }
  ]);
  const media: RichMediaState = {
    mediaId: 'forest-media', nodeId: 'figure',
    source: { kind: 'native', providerMessageId: rich.providerMessageId!, providerAssetId: 'native-asset' },
    status: 'available', previewWidth: 320, previewHeight: 180,
    asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 }
  };
  const options = (entry: RichMediaState) => ({
    sessionId: '2026-09-02-test0001', media: [entry], current: () => true
  });
  expect(renderRichResponse(rich, 'source', options(media)).querySelectorAll('.rich-image-slot button')).toHaveLength(1);
  expect(renderRichResponse(rich, 'source', options({ ...media,
    source: { kind: 'native', providerMessageId: 'unrelated-message', providerAssetId: 'native-asset' }
  })).querySelector('button')).toBeNull();
});

it('prints code literally and isolates bidirectional prose without executing or creating authored tags', () => {
  const source = '<text onclick="alert(1)">literal</text>';
  const view = renderRichResponse(fixture([
    prose('arabic', 'مرحبا بالعالم'), prose('code', source, 'code'), prose('caption', 'Caption', 'caption')
  ]), 'fallback');
  expect(view.querySelector('pre code')?.textContent).toBe(source);
  expect(view.querySelector('text, script, [onclick]')).toBeNull();
  expect(view.querySelector('.rich-body')?.getAttribute('dir')).toBe('auto');
  expect(view.querySelector('pre')?.getAttribute('dir')).toBe('ltr');
});

it('shows a truthful unavailable card and collapsed canonical source for explicit or invalid rich data', () => {
  const rich = { ...fixture([]), status: 'unavailable' as const, reason: 'ambiguous' as const,
    accessibleText: 'An illustration could not be captured' };
  const source = '<grid>canonical component source</grid>';
  for (const input of [rich, fixture([]), { ...fixture([]), nodes: [{ ...prose('bad', 'unsafe'), onload: 'run()' }] }]) {
    const view = renderRichResponse(input as RichResponse, source);
    expect(view.textContent).toContain('Rich content unavailable');
    expect(view.classList.contains('rich-unavailable')).toBe(true);
    const disclosure = view.querySelector<HTMLDetailsElement>('details.rich-source')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('pre')?.textContent).toBe(source);
    expect(view.querySelector('grid, script, img')).toBeNull();
  }
});

it('shows only a fully validated unavailable response accessible summary outside the collapsed source', () => {
  const source = '<grid>original component source</grid>';
  const valid: RichResponse = { ...fixture([]), status: 'unavailable', reason: 'unsupported',
    accessibleText: 'A diagram of three linked services' };
  const visible = renderRichResponse(valid, source);
  expect(visible.querySelector('.rich-accessible-summary')?.textContent).toBe('A diagram of three linked services');
  expect(visible.querySelector('details.rich-source')?.hasAttribute('open')).toBe(false);
  expect(visible.querySelector('details.rich-source pre')?.textContent).toBe(source);
  expect(visible.querySelector('script, grid, img')).toBeNull();

  const invalid = renderRichResponse({ ...valid, accessibleText: 'UNVERIFIED CONTENT',
    onclick: 'run()' } as unknown as RichResponse, source);
  expect(invalid.querySelector('.rich-accessible-summary')).toBeNull();
  expect(invalid.textContent).not.toContain('UNVERIFIED CONTENT');
  expect(invalid.querySelector('details.rich-source pre')?.textContent).toBe(source);
});

const artifact = (mode: 'static' | 'semantic', html: string | null, media: string[] = []): RichNode => ({
  id: 'art1', kind: 'artifact', mode, title: 'Sketch', html, media
});

it.each([
  '<svg><rect /></svg>',
  '<img src="http://remote/x" alt="remote">',
  '<input value="name">',
  '<div style="background: url(http://remote/x)">x</div>'
])('makes a rendered static artifact inert: %s', html => {
  const view = renderRichResponse(fixture([artifact('static', html)]), 'source');
  expect(view.querySelector('iframe')).toBeNull();
  expect(view.textContent).toContain('Open original in ChatGPT');
  expect(view.innerHTML).not.toMatch(/<script|onclick|https:|<form|@import|\bhref=|<svg|<input/i);
});

it('sandboxes admitted static markup and renders a semantic artifact as a typed heading', () => {
  const dataUrl = 'data:image/png;base64,aaaa';
  const view = renderRichResponse(fixture([
    artifact('static', '<p>Hello</p><img data-media-id="shot" alt="cat">', ['shot'])
  ]), 'source', {
    sessionId: '2026-09-02-test0001', media: [], current: () => true,
    admittedArtifactMedia: new Map([['shot', dataUrl]])
  });
  const frame = view.querySelector('iframe');
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute('sandbox')).toBe('');
  expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame!.srcdoc).toContain("default-src 'none'");
  expect(frame!.srcdoc).toContain(dataUrl);
  expect(frame!.srcdoc).toContain('Hello');
  expect(frame!.srcdoc).not.toMatch(/allow-scripts|allow-same-origin|https:/i);
  expect(view.querySelector('h3.rich-heading')?.textContent).toBe('Sketch');
  expect(view.querySelector('h3.rich-heading')?.getAttribute('dir')).toBe('auto');
  const semantic = renderRichResponse(fixture([artifact('semantic', null)]), 'source');
  expect(semantic.querySelector('iframe')).toBeNull();
  expect(semantic.querySelector('h3.rich-heading')?.textContent).toBe('Sketch');
  expect(semantic.querySelector('h3.rich-heading')?.getAttribute('dir')).toBe('auto');
});

it('does not paint an unadmitted artifact image or a data URL that was not already local', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const many = renderRichResponse(fixture([artifact('static', '<p>Hello</p>', ids)]), 'source', {
    sessionId: '2026-09-02-test0001', media: [], current: () => true,
    admittedArtifactMedia: new Map([['a', 'data:image/png;base64,aaaa'], ['b', 'data:image/png;base64,aaaa'], ['c', 'data:image/png;base64,aaaa']])
  });
  expect(many.querySelector('iframe')).toBeNull();
  expect(many.textContent).toContain('Open original in ChatGPT');
  const remote = renderRichResponse(fixture([
    artifact('static', '<img data-media-id="shot" alt="cat">', ['shot'])
  ]), 'source', {
    sessionId: '2026-09-02-test0001', media: [], current: () => true,
    admittedArtifactMedia: new Map([['shot', 'https://remote/x']])
  });
  expect(remote.querySelector('iframe')).toBeNull();
  expect(remote.innerHTML).not.toMatch(/https:/i);
});
