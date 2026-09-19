import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
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
