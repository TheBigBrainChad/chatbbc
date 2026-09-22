import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import {
  clearTimelineReserve, focusTimelineMessage, focusTimelineOrigin, preserveTimelineViewport,
  TIMELINE_RESERVE_PROPERTY
} from '../src/renderer/timeline-scroll.js';

it('anchors the logical reader row across late growth and replacement, while retaining nested tool scroll', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="reader"><details open><p>Tool result</p></details></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    let row = timeline.firstElementChild as HTMLElement;
    let documentTop = 450;
    pane.scrollTop = 400;
    Object.defineProperties(pane, { clientHeight: { value: 200 }, scrollHeight: { value: 1500 } });
    pane.getBoundingClientRect = () => ({ top: 20 } as DOMRect);
    const measure = () => ({ top: 20 + documentTop - pane.scrollTop, bottom: 220 + documentTop - pane.scrollTop, height: 200 } as DOMRect);
    row.getBoundingClientRect = measure;
    const result = row.querySelector('p')!;
    result.scrollTop = 75;
    let restore = preserveTimelineViewport(pane, timeline);
    documentTop += 180;
    restore();
    expect(pane.scrollTop).toBe(580);
    expect(measure().top).toBe(70);
    expect(result.scrollTop).toBe(75);
    expect(row.querySelector('details')!.open).toBe(true);

    restore = preserveTimelineViewport(pane, timeline);
    const replacement = row.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = measure;
    row.replaceWith(replacement); row = replacement;
    documentTop += 90;
    restore();
    expect(pane.scrollTop).toBe(670);
    expect(measure().top).toBe(70);

    restore = preserveTimelineViewport(pane, timeline);
    row.remove(); restore();
    expect(pane.scrollTop).toBe(670);
    pane.scrollTop = 1300;
    restore = preserveTimelineViewport(pane, timeline);
    restore();
    expect(pane.scrollTop).toBe(1500); // Browser clamps to the new bottom.
  } finally { dom.window.close(); }
});

it('uses another visible row when a paged activity group loses its old key', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline"><div data-timeline-key="old-group"></div><div data-timeline-key="message"></div></div></div>');
  try {
    const pane = dom.window.document.getElementById('pane')!;
    const timeline = dom.window.document.getElementById('timeline')!;
    const group = timeline.children[0] as HTMLElement, message = timeline.children[1] as HTMLElement;
    let added = 0;
    pane.scrollTop = 0;
    Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 4000 } });
    pane.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    group.getBoundingClientRect = () => ({ top: added - pane.scrollTop, bottom: added + 30 - pane.scrollTop, height: 30 } as DOMRect);
    message.getBoundingClientRect = () => ({ top: added + 30 - pane.scrollTop, bottom: added + 100 - pane.scrollTop, height: 70 } as DOMRect);
    const restore = preserveTimelineViewport(pane, timeline, false);
    group.remove(); added = 2000;
    restore();
    expect(message.getBoundingClientRect().top).toBe(30);
    expect(pane.scrollTop).toBe(2000);
  } finally { dom.window.close(); }
});

it('focuses the row drawn from one immutable origin, and refuses one that is not on screen', () => {
  const dom = new JSDOM('<div id="pane"><div id="timeline">' +
    '<div data-timeline-key="first" data-timeline-origin="1"><p>First</p></div>' +
    '<div data-timeline-key="revised" data-timeline-origin="2"><p>Revised</p></div>' +
    '</div></div>');
  try {
    const document = dom.window.document;
    const pane = document.getElementById('pane')!;
    const timeline = document.getElementById('timeline')!;
    (dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
    pane.scrollTop = 120;
    expect(focusTimelineOrigin(timeline, 2)).toBe(true);
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('data-timeline-key')).toBe('revised');
    // An origin that is not resident is not a reason to read history, or to move the reader.
    expect(focusTimelineOrigin(timeline, 404)).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(pane.scrollTop).toBe(120);
  } finally { dom.window.close(); }
});

it('focuses one generated-image gallery by its exact message id', () => {
  const dom = new JSDOM('<div id="timeline"><div class="generated-image-gallery">' +
    '<div class="ev" data-image-message="kept"></div><div class="ev" data-image-message="other"></div></div></div>');
  try {
    const document = dom.window.document;
    const timeline = document.getElementById('timeline')!;
    (dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
    const gallery = timeline.firstElementChild as HTMLElement;
    expect(gallery.querySelectorAll('.ev')).toHaveLength(2);
    expect(focusTimelineMessage(timeline, 'other')).toBe(true);
    expect(document.activeElement).toBe(gallery);
    expect(focusTimelineMessage(timeline, 'missing')).toBe(false);
    expect(document.activeElement).toBe(gallery);
  } finally { dom.window.close(); }
});

it('clears a stale tail reserve, so a new selection owns its own space', () => {
  const dom = new JSDOM('<div id="timeline"></div>');
  try {
    const timeline = dom.window.document.getElementById('timeline')!;
    timeline.style.setProperty(TIMELINE_RESERVE_PROPERTY, '420px');
    clearTimelineReserve(timeline);
    expect(timeline.style.getPropertyValue(TIMELINE_RESERVE_PROPERTY)).toBe('');
  } finally { dom.window.close(); }
});
