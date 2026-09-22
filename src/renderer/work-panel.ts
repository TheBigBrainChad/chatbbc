import { el } from './dom.js';
import { t } from './i18n.js';
import { createOutputInspector, type OutputInspector } from './output-inspector.js';
import { widenWorkPanel, workbenchMode } from './work-panel-resize.js';

export type WorkTab = 'files' | 'agents' | 'terminal' | 'inspector' | 'plan' | 'session';

/** The object the workbench is showing. Origin and payload stay with that object. */
export interface WorkbenchSelection {
  tab: WorkTab;
  ownerKey: string;
  origin?: number;
  payloadId?: string;
}

/**
 * A tool the work panel hosts. It keeps everything inside its own element and already knows how
 * to show and hide itself, which is where its lazy work lives: the first directory read, the
 * watcher refresh, a shell fit. `available` is the pane's own statement that it has something to
 * show — the same fact its header button publishes by hiding itself.
 * `beforeReplace` refuses a project or session change that would drop what the tenant still holds.
 */
export interface WorkPanelTenant {
  element: HTMLElement;
  show: () => void;
  hide: () => void;
  available?: () => boolean;
  beforeReplace?: (selection: WorkbenchSelection) => boolean;
}

export interface WorkPanel {
  host: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  register: (tab: WorkTab, tenant: WorkPanelTenant) => void;
  show: (tab: WorkTab) => void;
  toggle: (tab: WorkTab) => void;
  select: (selection: WorkbenchSelection, trigger?: HTMLElement | null) => void;
  close: () => void;
  selection: () => WorkbenchSelection | null;
  outputInspector: OutputInspector;
  /** Re-read the panes after anything that changes what they have to offer. */
  refresh: () => void;
}

const TABS = ['files', 'agents', 'terminal', 'inspector', 'plan', 'session'] as const;
const LABEL: Readonly<Record<WorkTab, () => string>> = {
  files: () => t('Files'),
  agents: () => t('Sub-agents'),
  terminal: () => t('Terminal'),
  inspector: () => t('Inspector'),
  plan: () => t('Plan'),
  session: () => t('Session')
};

/**
 * One right-hand column. Files, Sub-agents, Terminal, the output inspector, plan, and session
 * metadata are tenants of this column, not separate surfaces.
 *
 * Nothing is rebuilt on a switch, so an expanded folder, an unsaved draft and a live shell all
 * survive one. The width is not the strip's business either: `work-panel-resize.ts` stays the one
 * owner of `--work-panel-width`, and the terminal asks it for the column's maximum while selected.
 * Below the wide breakpoint the same column is an overlay instead of a split.
 */
export function createWorkPanel(options: {
  host: HTMLElement;
  onChange?: (presentation: { open: boolean; tab: WorkTab | null }) => void;
}): WorkPanel {
  const { host, onChange } = options;
  const panel = el('section', 'work-panel'); panel.id = 'workPanel'; panel.hidden = true;
  const strip = el('div', 'work-panel-tabs'); strip.setAttribute('role', 'tablist');
  const body = el('div', 'work-panel-body'); body.id = 'workPanelBody';
  const buttons = new Map<WorkTab, HTMLButtonElement>();
  const tenants = new Map<WorkTab, WorkPanelTenant>();
  let shown: WorkTab | null = null;
  let chosen: WorkbenchSelection | null = null;
  let trigger: HTMLElement | null = null;
  let release: (() => void) | null = null;
  let settling = false;

  for (const tab of TABS) {
    const button = el('button', 'work-panel-tab', LABEL[tab]) as HTMLButtonElement;
    button.type = 'button'; button.dataset.workTab = tab;
    button.id = `workPanelTab-${tab}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.addEventListener('click', () => toggle(tab));
    button.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : 0;
      if (step === 0) return;
      event.preventDefault();
      const open = TABS.filter(candidate => buttons.get(candidate)?.disabled !== true);
      if (open.length === 0) return;
      const at = open.indexOf(tab);
      const next = step === -Infinity ? open[0]! : step === Infinity ? open[open.length - 1]!
        : open[(at + step + open.length) % open.length]!;
      buttons.get(next)!.focus();
      show(next);
    });
    buttons.set(tab, button); strip.append(button);
  }

  /** One column, so at most one tenant is visible and the first one found is the one showing. */
  const visible = (): WorkTab | null =>
    TABS.find(tab => tenants.get(tab)?.element.hidden === false) ?? null;

  function studioFrame(): HTMLElement {
    return host.closest<HTMLElement>('.app') ?? host;
  }

  function studioWidth(): number {
    const measured = studioFrame().getBoundingClientRect?.().width ?? 0;
    if (measured > 0) return measured;
    return host.ownerDocument.defaultView?.innerWidth ?? 0;
  }

  function applyLayout(): void {
    const width = studioWidth();
    panel.classList.toggle('is-overlay', width > 0 && workbenchMode(width) === 'overlay');
  }

  function refresh(): void {
    const next = visible();
    if (next !== shown) {
      release?.(); release = null;
      if (next === 'terminal') release = widenWorkPanel(host, tenants.get('terminal')!.element);
      shown = next;
    }
    if (next === null && !settling) chosen = null;
    panel.hidden = next === null;
    host.classList.toggle('has-work-panel', next !== null);
    applyLayout();
    onChange?.({ open: next !== null, tab: next });
    for (const [tab, button] of buttons) {
      const selected = tab === next;
      const tenant = tenants.get(tab);
      button.classList.toggle('is-sel', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = !tenant || tenant.available?.() === false;
      const pane = tenant?.element;
      if (pane) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', button.id); }
    }
  }

  function show(tab: WorkTab): void {
    const ownerKey = chosen?.tab === tab ? chosen.ownerKey : tab;
    select({ tab, ownerKey }, trigger);
  }

  function toggle(tab: WorkTab): void {
    const tenant = tenants.get(tab);
    if (!tenant || tenant.available?.() === false) return;
    if (tenant.element.hidden) show(tab);
    else { tenant.hide(); refresh(); }
  }

  function select(selection: WorkbenchSelection, nextTrigger?: HTMLElement | null): void {
    const tenant = tenants.get(selection.tab);
    if (!tenant || tenant.available?.() === false) return;
    const ownerChanges = chosen !== null && chosen.tab === selection.tab && chosen.ownerKey !== selection.ownerKey;
    if (ownerChanges && tenant.beforeReplace?.(selection) === false) return;
    if (nextTrigger) trigger = nextTrigger;
    chosen = { ...selection };
    if (tenant.element.hidden) {
      settling = true;
      try {
        for (const [other, value] of tenants) if (other !== selection.tab && !value.element.hidden) value.hide();
        tenant.show();
      } finally { settling = false; }
    }
    refresh();
  }

  function close(): void {
    const current = visible();
    if (current) tenants.get(current)?.hide();
    chosen = null;
    refresh();
    trigger?.focus();
  }

  panel.append(strip, body);
  host.append(panel);
  const view = host.ownerDocument.defaultView;
  view?.addEventListener('resize', applyLayout);
  const FrameObserver = view?.ResizeObserver;
  if (FrameObserver) new FrameObserver(() => applyLayout()).observe(studioFrame());
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  });
  refresh();

  function register(tab: WorkTab, tenant: WorkPanelTenant): void {
    tenants.set(tab, tenant);
    body.append(tenant.element);
    const Observer = host.ownerDocument.defaultView?.MutationObserver;
    if (Observer) new Observer(records => {
      const revealed = records.map(record => record.target as HTMLElement).find(node => !node.hidden);
      if (revealed) for (const value of tenants.values()) if (value.element !== revealed && !value.element.hidden) value.hide();
      refresh();
    }).observe(tenant.element, { attributes: true, attributeFilter: ['hidden'] });
    refresh();
  }

  const outputInspector = createOutputInspector();
  register('inspector', {
    element: outputInspector.element,
    show(): void { outputInspector.element.hidden = false; },
    hide(): void { outputInspector.element.hidden = true; },
    available: () => true
  });

  return {
    host, panel, body,
    register,
    show,
    toggle,
    select,
    close,
    selection: () => chosen ? { ...chosen } : null,
    refresh,
    outputInspector
  };
}
