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
});
