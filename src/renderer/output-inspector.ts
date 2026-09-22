import { el } from './dom.js';

/** The transcript row that owns this inspection. A later row is a different owner. */
export interface InspectorOwner {
  sessionId: string;
  generation: number;
  origin: number;
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

function sameOwner(left: InspectorOwner, right: InspectorOwner): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation && left.origin === right.origin;
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
      selected = { sessionId: owner.sessionId, generation: owner.generation, origin: owner.origin };
      clear();
    },
    resolve(owner, payload) {
      if (!selected || !sameOwner(selected, owner)) return;
      element.hidden = false;
      const title = el('h2', 'output-inspector-title', payload.title);
      const meta = el('p', 'output-inspector-meta', `${payload.kind} · ${payload.payloadId}`);
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
