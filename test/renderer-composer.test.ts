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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRendererStyles } from './helpers.js';
import { paintComposerStatusLine } from '../src/renderer/composer-status-line.js';
import { renderAgentPlan } from '../src/renderer/agent-plan.js';
import { renderRecoveryCountdowns } from '../src/renderer/recovery.js';
import type { AgentPlan } from '../src/shared/agent-plan.js';

let document: Document;
let htmlSource = '';
let css = '';
let outboxSource = '';
let chatSource = '';
let statusLineSource = '';

beforeAll(async () => {
  const [html, styles, outbox, chat, statusLine] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
    readRendererStyles(),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'outbox-view.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'chat.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'composer-status-line.ts'), 'utf8')
  ]);
  document = new JSDOM(html).window.document;
  htmlSource = html;
  css = styles;
  outboxSource = outbox;
  chatSource = chat;
  statusLineSource = statusLine;
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

  it('computes nothing of its own: no second clock, no second counter', () => {
    // The line summarises blocks that own their own timers and counts. If it ever grew a
    // timer of its own, a countdown would keep running with nothing behind it — exactly the
    // second source of truth this task exists to avoid.
    expect(statusLineSource).not.toMatch(/setInterval|setTimeout|Date\.now/);
  });

  it('is repainted by every painter of a block it summarises', () => {
    // One call site somewhere in the file says nothing about the other five blocks: a painter
    // that forgot to repaint would leave the line describing the paint before its own.
    const bodyOf = (source: string, name: string): string => {
      const start = source.indexOf(`function ${name}(`);
      expect(start, `${name} was renamed or deleted`).toBeGreaterThan(-1);
      const end = source.indexOf('\n}', start);
      return source.slice(start, end === -1 ? source.length : end);
    };
    for (const painter of ['paintGoalProgress', 'paintActiveGoal', 'paintTaskPlan', 'paintPreparedPlan',
      'paintRecoveryStatus', 'paintAutomationSwitch', 'refreshSessionControls']) {
      expect(bodyOf(chatSource, painter), `${painter} no longer repaints the line`).toContain('paintComposerStatusLine()');
    }
    // The queue block is painted from its own module, and the line follows that paint.
    expect(bodyOf(outboxSource, 'refreshInputQueue')).toContain('paintComposerStatusLine()');
  });
});

/**
 * The line's observable behaviour: what the user reads for a given set of live blocks.
 *
 * The structural assertions above cannot see a segment that never renders, which is exactly
 * how `plan x/y` and `settling …` went missing while their blocks were on screen. These paint
 * the real modules into the shipped markup and read the summary back.
 */
describe('the composer status line', () => {
  const plan: AgentPlan = {
    updatedAt: 1,
    plan: [
      { step: 'Inspect the source', status: 'completed' },
      { step: 'Repair ownership', status: 'in_progress' }
    ]
  };
  let dom: JSDOM | undefined;
  afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });

  /** A fresh mount of the shipped shell, so every segment is painted against the real markup. */
  function mount(): Document {
    dom = new JSDOM(htmlSource, { url: 'https://local.test/' });
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    return dom.window.document;
  }
  /** What the user reads: the segments the summary actually holds, in order. */
  const lineText = (doc: Document): string =>
    [...doc.querySelectorAll('#composerStatusSegments > .composer-status-segment')].map(node => node.textContent).join(' · ');

  it('hides itself when nothing is live', () => {
    const doc = mount();
    const line = doc.getElementById('composerStatusLine') as HTMLDetailsElement;
    paintComposerStatusLine();
    expect(line.hidden).toBe(true);
    expect(doc.getElementById('composerStatusSegments')!.childElementCount).toBe(0);
    // jsdom applies no cascade, so the attribute alone proves nothing on screen: the line
    // also needs the one rule that outranks its own `display: block`.
    expect(rule('[hidden]'), 'the hidden attribute no longer wins in the cascade').toContain('display: none !important');
    expect(rule('.composer-status-line')).toContain('display: block');
  });

  it('reads a live plan count into the line, and drops the segment with the plan', () => {
    const doc = mount();
    const line = doc.getElementById('composerStatusLine') as HTMLDetailsElement;
    renderAgentPlan(doc.getElementById('agentPlan')!, 'chat-a', plan);
    paintComposerStatusLine();
    expect(line.hidden).toBe(false);
    expect(lineText(doc)).toContain('plan 1/2');

    renderAgentPlan(doc.getElementById('agentPlan')!, 'chat-a', null);
    paintComposerStatusLine();
    expect(lineText(doc)).toBe('');
    expect(line.hidden).toBe(true);
  });

  it('names the countdown the recovery block is ticking', () => {
    const doc = mount();
    const now = 1_000_000;
    renderRecoveryCountdowns(doc.getElementById('recoveryStatus')!, [{ kind: 'thinking-failed', deadline: now + 120_000 }], now);
    const painted = doc.querySelector('#recoveryStatus .recovery-countdown')!.textContent!;
    paintComposerStatusLine();
    // The line repeats the countdown the block owns instead of formatting a second one.
    expect(painted).toBe('Check in 2:00');
    expect(lineText(doc)).toContain(`settling ${painted}`);
  });

  it('names the countdown the goal row is ticking', () => {
    const doc = mount();
    const row = doc.createElement('div');
    row.id = 'goalLifecycle'; row.className = 'queued-input';
    const timer = doc.createElement('span');
    timer.className = 'recovery-countdown'; timer.textContent = 'Check in 4:59';
    row.append(timer);
    doc.getElementById('activeGoalRow')!.before(row);
    paintComposerStatusLine();
    expect(lineText(doc)).toContain('settling Check in 4:59');
  });

  it('counts the queued rows a live queue block is showing', () => {
    const doc = mount();
    const queue = doc.getElementById('finishQueue')!;
    for (const text of ['first follow-up', 'second follow-up']) {
      const card = doc.createElement('div');
      card.className = 'queued-input'; card.textContent = text;
      queue.append(card);
    }
    queue.hidden = false;
    paintComposerStatusLine();
    expect(lineText(doc)).toContain('queue 2');
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
