import type { AppState } from '../shared/types.js';

export type WorkbenchTab = 'files' | 'agents' | 'terminal' | 'inspector' | 'plan' | 'session';

/** Process-memory projection. Durable facts stay with their main-process owners. */
export interface PresentationState {
  appGeneration: number;
  app: AppState | null;
  selectedSessionId: string | null;
  selectionGeneration: number;
  draft: { key: string; generation: number };
  shell: { workbench: { open: boolean; tab: WorkbenchTab | null } };
}

export type PresentationAction =
  | { type: 'appStateReceived'; generation: number; state: AppState }
  | { type: 'sessionSelected'; sessionId: string | null; generation: number }
  | { type: 'draftOwnerChanged'; key: string; generation: number }
  | { type: 'workbenchChanged'; open: boolean; tab: WorkbenchTab | null }
  | { type: 'selectionGenerationAdvanced' };

export interface PresentationStore {
  getState(): Readonly<PresentationState>;
  dispatch(action: PresentationAction): void;
  subscribe<T>(select: (state: PresentationState) => T,
    listener: (value: T, state: PresentationState) => void): () => void;
}

export function initialPresentationState(): PresentationState {
  return {
    appGeneration: 0,
    app: null,
    selectedSessionId: null,
    selectionGeneration: 0,
    draft: { key: 'new', generation: 0 },
    shell: { workbench: { open: false, tab: null } }
  };
}

function reduce(state: PresentationState, action: PresentationAction): PresentationState {
  switch (action.type) {
    case 'appStateReceived':
      if (action.generation < state.appGeneration) return state;
      if (action.generation === state.appGeneration && action.state === state.app) return state;
      return { ...state, appGeneration: action.generation, app: action.state };
    case 'sessionSelected':
      if (action.generation < state.selectionGeneration) return state;
      if (action.generation === state.selectionGeneration && action.sessionId === state.selectedSessionId) return state;
      return { ...state, selectedSessionId: action.sessionId, selectionGeneration: action.generation };
    case 'draftOwnerChanged':
      if (state.draft.key === action.key && state.draft.generation === action.generation) return state;
      return { ...state, draft: { key: action.key, generation: action.generation } };
    case 'workbenchChanged': {
      const current = state.shell.workbench;
      if (current.open === action.open && current.tab === action.tab) return state;
      return { ...state, shell: { ...state.shell, workbench: { open: action.open, tab: action.tab } } };
    }
    case 'selectionGenerationAdvanced':
      return { ...state, selectionGeneration: state.selectionGeneration + 1 };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export function createPresentationStore(initial: PresentationState): PresentationStore {
  let state = initial;
  const subscribers = new Set<{
    select: (state: PresentationState) => unknown;
    listener: (value: unknown, state: PresentationState) => void;
    current: unknown;
  }>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const subscriber of subscribers) {
        const value = subscriber.select(state);
        if (Object.is(value, subscriber.current)) continue;
        subscriber.current = value;
        subscriber.listener(value, state);
      }
    },
    subscribe(select, listener) {
      const subscriber = { select, listener: listener as (value: unknown, state: PresentationState) => void, current: select(state) as unknown };
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    }
  };
}

/** One renderer instance. Tests construct their own store and do not touch this. */
export const presentationStore = createPresentationStore(initialPresentationState());
