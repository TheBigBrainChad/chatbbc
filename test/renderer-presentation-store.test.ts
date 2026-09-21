import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/types.js';
import { createPresentationStore, initialPresentationState } from '../src/renderer/presentation-store.js';

const state3 = { marker: 3 } as unknown as AppState;
const state4 = { marker: 4 } as unknown as AppState;
const changedStatusOnly = { marker: 5 } as unknown as AppState;

describe('renderer presentation store', () => {
  it('rejects an older app-state and selection generation', () => {
    const store = createPresentationStore(initialPresentationState());
    store.dispatch({ type: 'appStateReceived', generation: 4, state: state4 });
    store.dispatch({ type: 'appStateReceived', generation: 3, state: state3 });
    store.dispatch({ type: 'sessionSelected', sessionId: 'b', generation: 8 });
    store.dispatch({ type: 'sessionSelected', sessionId: 'a', generation: 7 });
    expect(store.getState()).toMatchObject({ appGeneration: 4, selectedSessionId: 'b', selectionGeneration: 8, app: state4 });
  });

  it('notifies only selectors whose value changed', () => {
    const store = createPresentationStore(initialPresentationState());
    const listener = vi.fn();
    store.subscribe(state => state.shell.workbench, listener);
    store.dispatch({ type: 'appStateReceived', generation: 2, state: changedStatusOnly });
    expect(listener).not.toHaveBeenCalled();
    store.dispatch({ type: 'workbenchChanged', open: true, tab: 'files' });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toEqual({ open: true, tab: 'files' });
  });

  it('keeps draft and selection projections process-local', () => {
    const store = createPresentationStore(initialPresentationState());
    store.dispatch({ type: 'draftOwnerChanged', key: 'session:a', generation: 2 });
    store.dispatch({ type: 'selectionGenerationAdvanced' });
    expect(store.getState()).toMatchObject({
      draft: { key: 'session:a', generation: 2 },
      selectionGeneration: 1,
      selectedSessionId: null
    });
    expect(store).not.toHaveProperty('save');
  });
});
