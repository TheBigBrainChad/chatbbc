/**
 * The composer's own surface.
 *
 * Task 7's defect was that seven recorded delivery states collapsed into one `i-clock` glyph,
 * and that five heterogeneous dock blocks stacked as separate rows. Both are structural: the
 * row must carry the fact in text, and the blocks must live behind one status line. jsdom does
 * no layout, so this holds the structure and the wiring, not the pixels — the Electron fixtures
 * (`verify-composer-layout.cjs`, `verify-composer-context.cjs`) measure the geometry.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { readRendererStyles } from './helpers.js';

let document: Document;
let css = '';
let outboxSource = '';
let chatSource = '';

beforeAll(async () => {
  const [html, styles, outbox, chat] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    readRendererStyles(),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'outbox-view.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  css = styles;
  outboxSource = outbox;
  chatSource = chat;
});

/** The declarations of one selector, whitespace-normalised, as `renderer-layout.test.ts` reads them. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : '';
}

describe('the composer dock', () => {
  it('keeps every block it used to stack, with its ids and its paint function', () => {
    const dock = document.getElementById('composerDock')!;
    for (const id of ['agentPlan', 'recoveryStatus', 'taskPlanPreview', 'finishQueue', 'activeGoalRow']) {
      const node = document.getElementById(id);
      expect(node, `${id} was deleted`).not.toBeNull();
      expect(dock.contains(node), `${id} left the dock`).toBe(true);
    }
    // Deleted, not hidden: the point of the task is that one line replaces the pile.
    for (const owner of ['paintGoalProgress', 'paintTaskPlan', 'paintRecoveryStatus']) {
      expect(chatSource, `${owner} lost its owner`).toContain(`function ${owner}(`);
    }
    // agentPlan and finishQueue are painted from their own modules.
    expect(chatSource).toContain('renderAgentPlan(');
    expect(outboxSource).toContain("$('finishQueue')");
  });

  it('puts those blocks behind one collapsible status line', () => {
    const line = document.getElementById('composerStatusLine')!;
    expect(line.closest('#composerDock')).not.toBeNull();
    expect(line.tagName.toLowerCase()).toBe('details');
    const body = document.getElementById('composerStatusBody')!;
    for (const id of ['agentPlan', 'recoveryStatus', 'taskPlanPreview', 'finishQueue', 'activeGoalRow']) {
      expect(body.contains(document.getElementById(id)!), `${id} is outside the disclosure`).toBe(true);
    }
    // Closed by default: the line is the summary, the pile is on request.
    expect((line as HTMLDetailsElement).open).toBe(false);
    expect(line.hasAttribute('hidden')).toBe(true);
    expect(document.getElementById('composerStatusSegments')!.closest('summary')).not.toBeNull();
  });

  it('shows a segment only while its fact is live', () => {
    // The line reads the blocks it summarises rather than keeping a second copy of their data.
    expect(css).toContain('[hidden]');
    // No second timer: the countdown is read from the row an existing renderer ticks.
    expect(chatSource).not.toMatch(/composerStatus[\s\S]{0,200}setInterval/);
    expect(chatSource).toContain('paintComposerStatusLine()');
  });
});

describe('the composer toolbar', () => {
  it('labels Attach instead of leaving a bare plus', () => {
    const summary = document.querySelector('#attachmentMenu > summary')!;
    expect(summary.textContent?.trim()).toBe('Attach');
    expect(summary.querySelector('span')?.textContent).toBe('Attach');
    expect(summary.getAttribute('aria-label')).toBe('Add attachments');
  });

  it('surfaces the mode as a visible Ordinary / Goal / Loop control', () => {
    const summary = document.querySelector('#composerSettings > summary')!;
    expect(document.getElementById('composerModeLabel')?.textContent).toBe('Ordinary');
    expect(summary.closest('#composerSettings')).not.toBeNull();
    const modes = [...document.querySelectorAll('#automationSwitch [data-mode]')].map(button => button.textContent);
    expect(modes).toEqual(['Ordinary', 'Goal', 'Loop']);
    // The visible label is driven by the select the app already owns, not by a copy of it.
    expect(chatSource).toContain("ui($('composerModeLabel')");
  });

  it('states the context estimate in words beside the ring', () => {
    const label = document.getElementById('contextMeterLabel')!;
    expect(document.getElementById('contextMeterButton')!.contains(label)).toBe(true);
    expect(rule('#contextMeterButton')).toContain('display: flex');
    expect(rule('#contextMeterButton')).not.toContain('width: 28px');
  });
});

describe('the delivery row', () => {
  it('renders the stage as text, never as a tooltip-only glyph', () => {
    // The old row set the whole meaning as a title and drew one icon; nothing may reintroduce it.
    expect(outboxSource).not.toContain("'pending-message-status'");
    expect(outboxSource).not.toContain('receipt.hidden');
    expect(outboxSource).toContain("head.append(el('span', 'msg-label'");
    expect(outboxSource).toContain("row.dataset.tone = stage.tone");
    expect(outboxSource).toContain('lifecycleOf(entry)');
  });

  it('gives every tone its own left rail, and no tone fills the card', () => {
    for (const tone of ['queued', 'scheduled', 'composer', 'turn', 'sent', 'failed']) {
      const declarations = rule(`.pending-message.msg.tone-${tone}`);
      expect(declarations, `tone-${tone} has no rule`).toContain('border-left-color');
    }
    // Radii are 0 across the redesign; the row must not invent a shape.
    const base = rule('.pending-message.msg');
    expect(base).toContain('border-left-width: 2px');
    expect(base).not.toContain('border-radius');
    // The transcript's prose body answers to `.msg` too, so the row's rule must be scoped
    // to the row rather than left to collide with it.
    expect(outboxSource).toContain("el('div', 'pending-message msg')");
    expect(css).toContain('.pending-message.msg > .msg-head');
  });
});
