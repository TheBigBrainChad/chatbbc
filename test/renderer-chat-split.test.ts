import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const renderer = path.resolve(__dirname, '../src/renderer');

describe('renderer chat split', () => {
  it('moves session list and outbox rendering into their own modules', async () => {
    const list = await fs.readFile(path.join(renderer, 'session-list.ts'), 'utf8');
    const outbox = await fs.readFile(path.join(renderer, 'outbox-view.ts'), 'utf8');
    expect(list).toContain('export function paintSessions');
    expect(list).toContain('export function sessionRow');
    expect(outbox).toContain('export function inputMessageRow');
    expect(outbox).toContain('export function pendingComposerInput');
  });

  it('no longer defines them in chat.ts', async () => {
    const chat = await fs.readFile(path.join(renderer, 'chat.ts'), 'utf8');
    expect(chat).not.toContain('function paintSessions(');
    expect(chat).not.toContain('function inputMessageRow(');
    // The extractions are what this file asserts; the line count was only ever a proxy for them,
    // and it moves with unrelated work. Pin the shape instead: the moved code lives in its own
    // modules and `chat.ts` no longer carries it.
    expect(chat.split('\n').length).toBeLessThan(4200);
  });

  it('reads session, selection, draft, and app state from the presentation store', async () => {
    const chat = await fs.readFile(path.join(renderer, 'chat.ts'), 'utf8');
    const main = await fs.readFile(path.join(renderer, 'main.ts'), 'utf8');
    expect(chat).not.toMatch(/^let selectedId\b/m);
    expect(chat).not.toMatch(/^let selectionGeneration\b/m);
    expect(chat).not.toMatch(/\bselectedId =[^=]/);
    expect(chat).not.toMatch(/\bselectionGeneration =[^=]/);
    expect(chat).toMatch(/function selectedId\(\): string \| null \{\n  return presentationStore\.getState\(\)\.selectedSessionId;\n\}/);
    expect(chat).toMatch(/function selectionGeneration\(\): number \{\n  return presentationStore\.getState\(\)\.selectionGeneration;\n\}/);
    expect(chat).toMatch(/function draftKey\(\): string \{\n  return presentationStore\.getState\(\)\.draft\.key;\n\}/);
    expect(chat).toMatch(/function ownsComposerDraft\(owner: ComposerDraftOwner\): boolean \{\n  const draft = presentationStore\.getState\(\)\.draft;\n  return owner\.key === draft\.key && owner\.generation === draft\.generation;\n\}/);
    expect(chat).toContain('selectedId: () => selectedId()');
    expect(chat).toContain('selectionGeneration: () => selectionGeneration()');
    expect(chat).toContain('selectedId: selectedId()');
    const syncDraftKey = chat.match(/function syncDraftKey\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(syncDraftKey.indexOf('projectedDraftKey()')).toBeGreaterThan(-1);
    expect(syncDraftKey.indexOf('projectedDraftKey()')).toBeLessThan(syncDraftKey.indexOf('getState().draft'));
    expect(syncDraftKey).not.toContain('draft.key === key');
    const replaceComposerDraft = chat.match(/function replaceComposerDraft\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(replaceComposerDraft).toContain('projectedDraftKey()');
    expect(replaceComposerDraft).not.toContain('key: draftKey()');
    expect(main).not.toMatch(/^let state\b/m);
    expect(main).not.toMatch(/^state =[^=]/m);
    expect(main).toContain('state: () => presentationStore.getState().app');
    expect(main).toContain('return presentationStore.getState().app;');
  });
});
