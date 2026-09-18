import { t, ui } from './i18n.js';
/**
 * The handful of DOM helpers both panels need.
 *
 * Nothing here knows about app state, and nothing here uses innerHTML — every node is
 * built from text, so a session title or a tool argument can never become markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One icon from the sprite in index.html. */
export function icon(name: string, className = 'ico'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

export function el(tag: string, className = '', text: string | (() => string) = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === 'function') ui(node, 'textContent', text);
  else if (text) node.textContent = text;
  return node;
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Filter complete settings sections so headings, controls and their context stay together. */
export function filterSettingsSections(view: HTMLElement, search: string): void {
  const query = search.trim().toLowerCase();
  let matches = 0;
  for (const heading of view.querySelectorAll<HTMLElement>('.settings-section-title')) {
    const pane = heading.nextElementSibling as HTMLElement | null;
    if (!pane?.classList.contains('pane')) continue;
    const visible = !query || `${heading.textContent} ${pane.textContent}`.toLowerCase().includes(query);
    heading.hidden = pane.hidden = !visible;
    if (visible) matches++;
  }
  const empty = view.querySelector<HTMLElement>('#settingsSearchEmpty');
  if (empty) empty.hidden = !query || matches > 0;
}

/**
 * Re-apply the settings search to the settings view as it currently stands.
 *
 * The filter is text-based, so any section whose rows arrive after the query was typed was
 * evaluated against an empty pane and stays hidden with no reason to be re-examined. A pane that
 * fills asynchronously calls this once its rows land. Reading the live input value here, rather
 * than taking a copy, is what makes that correct: the user may have typed more in the meantime.
 */
export function applySettingsFilter(): void {
  const view = document.querySelector<HTMLElement>('[data-view="settings"]');
  const search = document.getElementById('settingsSearch') as HTMLInputElement | null;
  if (view && search) filterSettingsSections(view, search.value);
}

let toastTimer: number | undefined;

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const node = el('div', 'toast', message);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

/** Unwraps an IPC reply, showing the main process's own error text on failure. */
export async function run<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>
): Promise<T | null> {
  const reply = await promise;
  if (!reply.ok) {
    toast(reply.error);
    return null;
  }
  return reply.data;
}

/** "12s ago" for a timestamp the main process vouched for, "never" for null. */
export function ago(atMs: number | null): string {
  if (atMs === null) return t("never");
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("just now");
  if (seconds < 90) return t("{0}s ago", [seconds]);
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? t("{0}m ago", [minutes]) : t("{0}h ago", [Math.round(minutes / 60)]);
}

/** The same age as one glanceable token: "8s", "2m", "—" when there is nothing. */
export function shortAgo(atMs: number | null): string {
  if (atMs === null) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (seconds < 3) return t("now");
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** A clock time for one event in a timeline. */
export function clockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString();
}

/** "1.2k", "3.4M" — for token and character counts that get large. */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** "812 B", "12.3 KB", "1.4 MB" — a file or skill size, read as a size rather than a count. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Bring `parent`'s children into `children` order, reusing the nodes already there.
 *
 * Both the timeline and the outbox repaint while the user may be reading or dragging a row,
 * so an existing node is moved into place rather than replaced: that is what keeps focus,
 * text selection and an in-progress drag attached to the row they belong to.
 */
export function reconcileChildren(parent: Element, children: HTMLElement[]): void {
  const keep = new Set<Node>(children);
  for (const old of [...parent.childNodes]) if (!keep.has(old)) old.remove();
  let cursor = parent.firstChild;
  for (const child of children) {
    if (child !== cursor) parent.insertBefore(child, cursor);
    cursor = child.nextSibling;
  }
}
