import { el } from './dom.js';
import { t, ui } from './i18n.js';

/** The loaded rich node a focus stage may show. The caller rereads it; this type holds no selector. */
export type RichFocusTarget = {
  sessionId: string;
  logicalMessageId: string;
  nodeId: string;
  revision: number;
  origin: number;
};

export type RichFocusStatus = 'pending' | 'confirmed' | 'changed' | 'unavailable' | 'unconfirmed';

export type RichFocusView = {
  revision: number;
  title: string;
  mode: 'artifact' | 'decision';
  source: string;
  meta: string;
  status: RichFocusStatus | null;
  /** Null when the media is not available. The stage must not invent a preview. */
  preview: HTMLElement | null;
};

export type RichFocusStage = {
  element: HTMLElement;
  open(target: RichFocusTarget): boolean;
  close(): void;
  refresh(): 'closed' | 'refreshed' | 'current';
  isOpen(): boolean;
  target(): RichFocusTarget | null;
};

type Shown = { revision: number; status: string; title: string; source: string };

export function openRichFocus(stage: RichFocusStage, target: RichFocusTarget): boolean {
  return stage.open(target);
}

export function closeRichFocus(stage: RichFocusStage): void {
  stage.close();
}

function statusText(status: RichFocusStatus): string {
  if (status === 'pending') return t('Pending');
  if (status === 'confirmed') return t('Confirmed');
  if (status === 'changed') return t('Changed');
  if (status === 'unavailable') return t('Unavailable');
  return t('Unconfirmed');
}

function tabLabel(name: 'preview' | 'structure' | 'metadata'): string {
  if (name === 'preview') return t('Preview');
  if (name === 'structure') return t('Structure');
  return t('Metadata');
}

/**
 * A chat-owned preview of one artifact or decision.
 * It does not move the canonical row. Closing focuses that row when it is still
 * resident, and otherwise the message group.
 */
export function createRichFocusStage(options: {
  host: () => HTMLElement;
  read: (target: RichFocusTarget) => RichFocusView | null;
  currentSession: () => string | null;
  focusOrigin: (origin: number) => boolean;
  focusMessage: (logicalMessageId: string) => boolean;
}): RichFocusStage {
  const element = el('section', 'rich-focus-stage');
  element.hidden = true;
  element.id = 'richFocusStage';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  ui(element, 'aria-label', () => t('Focused output'));
  let current: RichFocusTarget | null = null;
  let shown: Shown | null = null;

  const paint = (target: RichFocusTarget, view: RichFocusView): void => {
    const host = options.host();
    const wasHidden = element.hidden || element.parentElement !== host;
    const active = element.ownerDocument.activeElement as HTMLElement | null;
    const restore = !wasHidden && active && element.contains(active)
      ? (active.dataset.richFocusTab || (active.classList.contains('rich-focus-close') ? 'close' : ''))
      : '';
    if (element.parentElement !== host) host.append(element);
    element.hidden = false;
    element.dataset.shownRevision = String(view.revision);
    element.dataset.richStatus = view.status ?? '';
    const title = el('h2', 'rich-focus-title');
    title.id = 'richFocusTitle';
    title.dir = 'auto';
    title.textContent = view.title;
    element.setAttribute('aria-labelledby', title.id);
    const status = el('p', 'rich-focus-status');
    status.setAttribute('role', 'status');
    status.hidden = view.status === null;
    status.textContent = view.status ? statusText(view.status) : '';
    const closeButton = el('button', 'rich-focus-close', () => t('Close')) as HTMLButtonElement;
    closeButton.type = 'button';
    closeButton.addEventListener('click', () => close());
    const tabs = el('div', 'rich-focus-tabs');
    tabs.setAttribute('role', 'tablist');
    const preview = el('div', 'rich-focus-preview');
    if (view.preview) preview.append(view.preview);
    else preview.append(el('p', 'rich-focus-unavailable', () => t('Unavailable')));
    const source = el('pre', 'rich-focus-source');
    source.dir = 'ltr';
    source.textContent = view.source;
    const meta = el('p', 'rich-focus-meta');
    meta.dir = 'auto';
    meta.textContent = view.meta;
    const panel = el('div', 'rich-focus-panel');
    panel.setAttribute('role', 'tabpanel');
    const show = (name: 'preview' | 'structure' | 'metadata'): void => {
      for (const button of tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
        const selected = button.dataset.richFocusTab === name;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = 0;
      }
      if (name === 'structure') panel.replaceChildren(source);
      else if (name === 'metadata') panel.replaceChildren(meta);
      else if (view.mode === 'decision') {
        const fields = el('fieldset', 'rich-focus-decision');
        const legend = el('legend');
        legend.dir = 'auto';
        legend.textContent = view.title;
        fields.append(legend, preview);
        panel.replaceChildren(fields);
      } else panel.replaceChildren(preview);
    };
    for (const name of ['preview', 'structure', 'metadata'] as const) {
      const tab = el('button', 'rich-focus-tab', () => tabLabel(name)) as HTMLButtonElement;
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.richFocusTab = name;
      tab.addEventListener('click', () => show(name));
      tabs.append(tab);
    }
    show('preview');
    element.replaceChildren(title, status, closeButton, tabs, panel);
    current = { ...target, revision: view.revision };
    shown = { revision: view.revision, status: view.status ?? '', title: view.title, source: view.source };
    if (wasHidden) closeButton.focus();
    else if (restore === 'close') closeButton.focus();
    else if (restore === 'preview' || restore === 'structure' || restore === 'metadata') {
      element.querySelector<HTMLButtonElement>(`[data-rich-focus-tab="${restore}"]`)?.focus();
    }
  };

  const close = (): void => {
    const target = current;
    element.hidden = true;
    element.replaceChildren();
    delete element.dataset.shownRevision;
    delete element.dataset.richStatus;
    current = null;
    shown = null;
    if (!target) return;
    if (!options.focusOrigin(target.origin)) options.focusMessage(target.logicalMessageId);
  };

  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || element.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  return {
    element,
    open(target) {
      if (options.currentSession() !== target.sessionId) {
        if (current) close();
        return false;
      }
      const view = options.read(target);
      if (!view) {
        if (current) close();
        return false;
      }
      paint(target, view);
      return true;
    },
    close,
    refresh() {
      if (!current) return 'current';
      if (options.currentSession() !== current.sessionId) {
        close();
        return 'closed';
      }
      const view = options.read(current);
      if (!view) {
        close();
        return 'closed';
      }
      const next = { revision: view.revision, status: view.status ?? '', title: view.title, source: view.source };
      if (shown && shown.revision === next.revision && shown.status === next.status &&
          shown.title === next.title && shown.source === next.source) return 'current';
      paint(current, view);
      return 'refreshed';
    },
    isOpen: () => current !== null && !element.hidden,
    target: () => current ? { ...current } : null
  };
}
