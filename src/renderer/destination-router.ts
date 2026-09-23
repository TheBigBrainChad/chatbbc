import type { AppShell } from './app-shell.js';
import type { PresentationStore } from './presentation-store.js';

export type Destination = 'chats' | 'files' | 'agents' | 'usage' | 'settings';

export interface DestinationRouter {
  show(destination: Destination): void;
  current(): Destination;
}

const DESTINATIONS: readonly Destination[] = ['chats', 'files', 'agents', 'usage', 'settings'];

function isDestination(value: string): value is Destination {
  return (DESTINATIONS as readonly string[]).includes(value);
}

type Page = 'chat' | 'usage' | 'workspace';

function pageFor(destination: Destination): Page {
  if (destination === 'usage') return 'usage';
  if (destination === 'settings') return 'workspace';
  return 'chat';
}

/** Stage visibility only. The timeline node stays mounted. */
function projectPage(doc: Document, page: Page): void {
  const app = doc.querySelector<HTMLElement>('.app');
  if (!app) return;
  const settings = page !== 'chat';
  app.dataset.screen = settings ? 'settings' : 'chat';
  const settingsPages = doc.getElementById('settingsPages');
  if (settingsPages) settingsPages.hidden = page !== 'workspace';
  for (const node of doc.querySelectorAll<HTMLElement>('.panel')) {
    node.classList.toggle('is-active', node.dataset.panel === page);
  }
}

/**
 * One owner for rail destinations. It changes which stage is visible and which rail
 * destination is current. Usage, settings fields, and the transcript stay with their owners.
 */
export function createDestinationRouter(options: {
  shell: AppShell;
  store: PresentationStore;
  document?: Document;
  showPage?: (page: Page) => void;
}): DestinationRouter {
  const doc = options.document ?? options.shell.stage.ownerDocument;
  let current: Destination = 'chats';
  options.store.subscribe(state => state.shell.workbench, workbench => {
    if (!workbench.open && (current === 'files' || current === 'agents')) current = 'chats';
  });

  function show(destination: Destination): void {
    if (!isDestination(destination)) return;
    const page = pageFor(destination);
    if (options.showPage) options.showPage(page);
    else projectPage(doc, page);
    if (destination === 'files' || destination === 'agents') {
      options.shell.setDestination(destination);
      options.shell.setDestination('chats');
    } else if (destination === 'chats') {
      options.shell.setWorkbenchOpen(false);
      options.shell.setDestination('chats');
    } else {
      options.shell.setWorkbenchOpen(false);
      options.shell.setDestination(destination);
    }
    current = destination;
  }

  return { show, current: () => current };
}
