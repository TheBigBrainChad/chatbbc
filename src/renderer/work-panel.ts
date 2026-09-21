import { el } from './dom.js';
import { t } from './i18n.js';
import { widenWorkPanel } from './work-panel-resize.js';

export type WorkTab = 'files' | 'agents' | 'terminal';

/**
 * A tool the work panel hosts. It keeps everything inside its own element and already knows how
 * to show and hide itself, which is where its lazy work lives: the first directory read, the
 * watcher refresh, a shell fit. `available` is the pane's own statement that it has something to
 * show — the same fact its header button publishes by hiding itself.
 */
export interface WorkPanelTenant {
  element: HTMLElement;
  show: () => void;
  hide: () => void;
  available?: () => boolean;
}

export interface WorkPanel {
  host: HTMLElement;
  panel: HTMLElement;
  body: HTMLElement;
  register: (tab: WorkTab, tenant: WorkPanelTenant) => void;
  show: (tab: WorkTab) => void;
  toggle: (tab: WorkTab) => void;
  /** Re-read the panes after anything that changes what they have to offer. */
  refresh: () => void;
}

const TABS = ['files', 'agents', 'terminal'] as const;
const LABEL: Readonly<Record<WorkTab, () => string>> = {
  files: () => t('Files'),
  agents: () => t('Sub-agents'),
  terminal: () => t('Terminal')
};

/**
 * One right-hand column with three tenants.
 *
 * Files, Sub-agents and Terminal used to be three surfaces: two mutually exclusive side panes and
 * a bottom drawer. They are one column with a tab strip now, and the strip is a projection of the
 * panes rather than a second copy of them. A pane's own `hidden` attribute stays the single
 * statement of which tool is showing, whichever path changed it — this strip, a pane's header
 * button, Escape, a project change — and a mutation observer per pane is what keeps the strip
 * honest about all of those, so no third place can disagree.
 *
 * Nothing is rebuilt on a switch, so an expanded folder, an unsaved draft and a live shell all
 * survive one. The width is not the strip's business either: `work-panel-resize.ts` stays the one
 * owner of `--work-panel-width`, and the terminal asks it for the column's maximum while selected.
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
  let release: (() => void) | null = null;

  for (const tab of TABS) {
    const button = el('button', 'work-panel-tab', LABEL[tab]) as HTMLButtonElement;
    button.type = 'button'; button.dataset.workTab = tab;
    button.id = `workPanelTab-${tab}`;
    // A declared tablist has to be drivable by keyboard, so each tab owns a tabpanel and the
    // arrow keys move between them in the usual way. Roles without that would announce a widget
    // the reader cannot use.
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

  function refresh(): void {
    const next = visible();
    if (next !== shown) {
      release?.(); release = null;
      // A terminal in a chat-sized column is about fifty columns, which is no width to read
      // build output at. It takes the column's maximum until the reader leaves the tab.
      if (next === 'terminal') release = widenWorkPanel(host, tenants.get('terminal')!.element);
      shown = next;
    }
    panel.hidden = next === null;
    host.classList.toggle('has-work-panel', next !== null);
    onChange?.({ open: next !== null, tab: next });
    for (const [tab, button] of buttons) {
      const selected = tab === next;
      button.classList.toggle('is-sel', selected);
      button.setAttribute('aria-selected', String(selected));
      // Roving tabindex: the strip is one stop, and the arrow keys move within it.
      button.tabIndex = selected ? 0 : -1;
      button.disabled = tenants.get(tab)?.available?.() === false;
      // Each pane is a tabpanel labelled by its own tab. `aria-controls` is deliberately not used:
      // a pane keeps the id it is referenced by elsewhere, and pointing at a different one would
      // mean either clobbering that id or naming an element that does not exist.
      const pane = tenants.get(tab)?.element;
      if (pane) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', button.id); }
    }
  }

  function show(tab: WorkTab): void {
    const tenant = tenants.get(tab);
    if (!tenant || tenant.available?.() === false) return;
    if (!tenant.element.hidden) { refresh(); return; }
    for (const [other, value] of tenants) if (other !== tab && !value.element.hidden) value.hide();
    tenant.show();
    refresh();
  }

  function toggle(tab: WorkTab): void {
    const tenant = tenants.get(tab);
    if (!tenant || tenant.available?.() === false) return;
    // Pressing the tab you are already on puts the column away, like the header button does.
    if (tenant.element.hidden) show(tab);
    else { tenant.hide(); refresh(); }
  }

  panel.append(strip, body);
  host.append(panel);
  refresh();

  return {
    host, panel, body,
    register(tab, tenant): void {
      tenants.set(tab, tenant);
      // The pane's host is the chat panel; the work panel owns where it sits now. The pane keeps
      // its OWN id (`#workspaceTerminal` and friends are referenced elsewhere), so the tab
      // announces which component it controls by name rather than by owning its element's id.
      body.append(tenant.element);
      const Observer = host.ownerDocument.defaultView?.MutationObserver;
      if (Observer) new Observer(records => {
        // A pane can be shown by its own header button, not only by this strip. One column holds
        // one tool, so whichever pane just appeared retires the rest.
        const revealed = records.map(record => record.target as HTMLElement).find(node => !node.hidden);
        if (revealed) for (const value of tenants.values()) if (value.element !== revealed && !value.element.hidden) value.hide();
        refresh();
      }).observe(tenant.element, { attributes: true, attributeFilter: ['hidden'] });
      refresh();
    },
    show,
    toggle,
    refresh
  };
}
