import { el } from './dom.js';
import { t, ui } from './i18n.js';

/** The transcript row that owns this inspection. A later payload is a different owner. */
export interface InspectorOwner {
  sessionId: string;
  generation: number;
  origin: number;
  payloadId?: string;
}

export interface InspectorAction {
  id: string;
  label: string;
  run: () => void;
}

/** Facts the caller already has. The inspector does not load a session to obtain them. */
export interface InspectorPayload {
  payloadId: string;
  title: string;
  kind: 'message' | 'image' | 'artifact';
  detail?: string;
  actions?: readonly InspectorAction[];
}

export interface OutputInspector {
  element: HTMLElement;
  select(owner: InspectorOwner): void;
  resolve(owner: InspectorOwner, payload: InspectorPayload): void;
  isEmpty(): boolean;
}

function kindLabel(kind: InspectorPayload['kind']): string {
  if (kind === 'message') return t('Message');
  if (kind === 'image') return t('Image');
  return t('Artifact');
}

function sameOwner(selected: InspectorOwner, claimed: InspectorOwner, payloadId: string): boolean {
  if (selected.sessionId !== claimed.sessionId || selected.generation !== claimed.generation || selected.origin !== claimed.origin) return false;
  if (selected.payloadId !== undefined && selected.payloadId !== payloadId) return false;
  if (claimed.payloadId !== undefined && claimed.payloadId !== payloadId) return false;
  return true;
}

/**
 * Metadata for the exact selected message, image, or artifact.
 * A resolve that names a replaced session, generation, or origin is ignored.
 */
export function createOutputInspector(): OutputInspector {
  const element = el('aside', 'output-inspector');
  element.hidden = true;
  const body = el('div', 'output-inspector-body');
  element.append(body);
  let selected: InspectorOwner | null = null;

  const clear = (): void => {
    body.replaceChildren();
    element.hidden = true;
  };

  return {
    element,
    select(owner) {
      selected = {
        sessionId: owner.sessionId,
        generation: owner.generation,
        origin: owner.origin,
        ...(owner.payloadId !== undefined ? { payloadId: owner.payloadId } : {})
      };
      clear();
    },
    resolve(owner, payload) {
      if (!selected || !sameOwner(selected, owner, payload.payloadId)) return;
      element.hidden = false;
      const title = el('h2', 'output-inspector-title', payload.title);
      const meta = el('p', 'output-inspector-meta');
      ui(meta, 'textContent', () => `${kindLabel(payload.kind)} · ${payload.payloadId}`);
      const nodes: HTMLElement[] = [title, meta];
      if (payload.detail) nodes.push(el('p', 'output-inspector-detail', payload.detail));
      if (payload.actions?.length) {
        const actions = el('div', 'output-inspector-actions');
        for (const action of payload.actions) {
          const button = el('button', 'btn', action.label) as HTMLButtonElement;
          button.type = 'button';
          button.dataset.action = action.id;
          button.addEventListener('click', () => action.run());
          actions.append(button);
        }
        nodes.push(actions);
      }
      body.replaceChildren(...nodes);
    },
    isEmpty: () => body.childElementCount === 0
  };
}
