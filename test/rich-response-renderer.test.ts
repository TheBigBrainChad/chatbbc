import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { RichNode, RichResponse } from '../src/shared/rich-response.js';
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
