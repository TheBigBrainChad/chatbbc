import type { PresentationStore } from './presentation-store.js';

/** CSS pixels. Container and media queries in shell.css use the same edges. */
export const SHELL_BREAKPOINTS = {
  workbenchOverlay: 1100,
  navigatorDrawer: 780,
  compactRail: 560
} as const;

export const APP_DESTINATIONS = ['chats', 'files', 'agents', 'usage', 'settings'] as const;
export type AppDestination = typeof APP_DESTINATIONS[number];
export type ShellCollapse = 'wide' | 'workbench' | 'navigator' | 'rail';

export function shellCollapse(width: number): ShellCollapse {
  if (width < SHELL_BREAKPOINTS.compactRail) return 'rail';
  if (width < SHELL_BREAKPOINTS.navigatorDrawer) return 'navigator';
  if (width < SHELL_BREAKPOINTS.workbenchOverlay) return 'workbench';
  return 'wide';
}

export interface AppShellRoots {
  rail: HTMLElement;
  navigator: HTMLElement;
  stage: HTMLElement;
  workbench: HTMLElement;
}

export interface AppShell {
  rail: HTMLElement;
  navigator: HTMLElement;
  stage: HTMLElement;
  workbench: HTMLElement;
  setDestination(destination: AppDestination): void;
  setWorkbenchOpen(open: boolean): void;
  dispose(): void;
}

function isDestination(value: string | null | undefined): value is AppDestination {
  return !!value && (APP_DESTINATIONS as readonly string[]).includes(value);
}

/**
 * Projects the four Adaptive Studio regions.
 * Visibility and focus only: no session, project, or browser mutation.
 */
export function createAppShell(options: {
  store: PresentationStore;
  roots: AppShellRoots;
  document?: Document;
}): AppShell {
  const { store, roots } = options;
  const doc = options.document ?? roots.rail.ownerDocument;
  const view = doc.defaultView;
  const frame = roots.stage.closest<HTMLElement>('.app') ?? doc.querySelector<HTMLElement>('.app');
  if (!frame) throw new Error('Adaptive Studio shell has no app frame');
  const app = frame;

  let collapse: ShellCollapse = 'wide';
  let navigatorTrigger: HTMLElement | null = roots.rail.querySelector<HTMLElement>('[data-destination="chats"]');
  let workbenchTrigger: HTMLElement | null = null;
  let disposed = false;

  const railButtons = (): HTMLButtonElement[] => APP_DESTINATIONS.flatMap(destination => {
    const button = roots.rail.querySelector<HTMLButtonElement>(`[data-destination="${destination}"]`);
    return button ? [button] : [];
  });
  const isDrawer = (band: ShellCollapse): boolean => band === 'navigator' || band === 'rail';
  const isOverlay = (band: ShellCollapse): boolean => band !== 'wide';

  function width(): number {
    const measured = app.clientWidth;
    if (measured > 0) return measured;
    return view?.innerWidth ?? SHELL_BREAKPOINTS.workbenchOverlay;
  }

  function paintDestination(destination: AppDestination): void {
    for (const button of railButtons()) {
      if (button.dataset.destination === destination) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  function projectChrome(): void {
    roots.workbench.inert = app.dataset.workbenchOpen !== 'true';
    roots.navigator.inert = isDrawer(collapse) && app.dataset.navigatorOpen !== 'true';
  }

  function paintWorkbench(open: boolean): void {
    app.dataset.workbenchOpen = String(open);
    projectChrome();
  }

  function setNavigatorOpen(open: boolean): void {
    app.dataset.navigatorOpen = String(open);
    projectChrome();
  }

  function syncCollapse(): void {
    const next = shellCollapse(width());
    const enteredDrawer = isDrawer(next) && !isDrawer(collapse);
    collapse = next;
    app.dataset.collapse = next;
    roots.rail.setAttribute('aria-orientation', next === 'rail' ? 'horizontal' : 'vertical');
    if (enteredDrawer) setNavigatorOpen(false);
    else projectChrome();
  }

  function focusRoving(index: number): void {
    const buttons = railButtons();
    if (buttons.length === 0) return;
    const next = Math.max(0, Math.min(buttons.length - 1, index));
    buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
    buttons[next]?.focus();
  }

  function setDestination(destination: AppDestination): void {
    if (!isDestination(destination)) return;
    paintDestination(destination);
    if (destination === 'files' || destination === 'agents') {
      workbenchTrigger = railButtons().find(button => button.dataset.destination === destination) ?? workbenchTrigger;
      store.dispatch({ type: 'workbenchChanged', open: true, tab: destination });
    }
  }

  function setWorkbenchOpen(open: boolean): void {
    const current = store.getState().shell.workbench;
    store.dispatch({
      type: 'workbenchChanged',
      open,
      tab: open ? (current.tab ?? 'files') : current.tab
    });
  }

  function onRailKeydown(event: KeyboardEvent): void {
    const buttons = railButtons();
    const index = buttons.indexOf(doc.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    focusRoving(next);
  }

  function onRailClick(event: MouseEvent): void {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-destination]');
    if (!button || !roots.rail.contains(button) || !isDestination(button.dataset.destination)) return;
    const destination = button.dataset.destination;
    const index = railButtons().indexOf(button);
    if (index >= 0) railButtons().forEach((item, i) => { item.tabIndex = i === index ? 0 : -1; });
    setDestination(destination);
    if (destination === 'chats' && isDrawer(collapse)) {
      const open = app.dataset.navigatorOpen !== 'true';
      setNavigatorOpen(open);
      if (open) navigatorTrigger = button;
    }
    if (destination === 'files' || destination === 'agents') workbenchTrigger = button;
  }

  function higherLayerOpen(): boolean {
    if (doc.querySelector('dialog[open]')) return true;
    const connection = doc.getElementById('connectionPopover');
    if (connection && !connection.hidden) return true;
    return !!doc.querySelector('#viewMenu[open], .composer-menu[open], .session-controls[open]');
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || disposed || higherLayerOpen()) return;
    const workbenchOnTop = isOverlay(collapse) && app.dataset.workbenchOpen === 'true';
    const navigatorOnTop = !workbenchOnTop && isDrawer(collapse) && app.dataset.navigatorOpen === 'true';
    if (!workbenchOnTop && !navigatorOnTop) return;
    event.preventDefault();
    event.stopPropagation();
    if (workbenchOnTop) {
      setWorkbenchOpen(false);
      (workbenchTrigger ?? roots.rail.querySelector<HTMLElement>('[data-destination="files"]'))?.focus();
      return;
    }
    setNavigatorOpen(false);
    (navigatorTrigger ?? roots.rail.querySelector<HTMLElement>('[data-destination="chats"]'))?.focus();
  }

  function adoptWorkbench(): void {
    const panel = doc.getElementById('workPanel');
    if (panel && !roots.workbench.contains(panel)) roots.workbench.append(panel);
  }

  const unsubscribe = store.subscribe(state => state.shell.workbench, workbench => {
    paintWorkbench(workbench.open);
  });

  const selected = railButtons().find(button => button.getAttribute('aria-current') === 'page')?.dataset.destination;
  paintDestination(isDestination(selected) ? selected : 'chats');
  paintWorkbench(store.getState().shell.workbench.open);
  if (app.dataset.navigatorOpen !== 'true') setNavigatorOpen(false);
  collapse = shellCollapse(width());
  app.dataset.collapse = collapse;
  roots.rail.setAttribute('aria-orientation', collapse === 'rail' ? 'horizontal' : 'vertical');
  projectChrome();
  const selectedIndex = Math.max(0, railButtons().findIndex(button => button.getAttribute('aria-current') === 'page'));
  railButtons().forEach((button, index) => { button.tabIndex = index === selectedIndex ? 0 : -1; });

  roots.rail.addEventListener('keydown', onRailKeydown);
  roots.rail.addEventListener('click', onRailClick);
  doc.addEventListener('keydown', onEscape, true);
  const onResize = (): void => syncCollapse();
  view?.addEventListener('resize', onResize);
  adoptWorkbench();
  const observer = view ? new view.MutationObserver(() => adoptWorkbench()) : null;
  if (observer && doc.body) observer.observe(doc.body, { childList: true, subtree: true });

  return {
    rail: roots.rail,
    navigator: roots.navigator,
    stage: roots.stage,
    workbench: roots.workbench,
    setDestination,
    setWorkbenchOpen,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      roots.rail.removeEventListener('keydown', onRailKeydown);
      roots.rail.removeEventListener('click', onRailClick);
      doc.removeEventListener('keydown', onEscape, true);
      view?.removeEventListener('resize', onResize);
      observer?.disconnect();
    }
  };
}
