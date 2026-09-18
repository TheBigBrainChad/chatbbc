import { $, el } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * The one status line above the composer.
 *
 * The dock used to stack five heterogeneous blocks — the agent plan, the recovery countdown,
 * the staged-plan preview, the queued tasks and the goal row — and an idle chat showed the
 * pile anyway. Here they keep their own ids, their own owners and their own paint functions;
 * this module only says what is live in one line, and the disclosure opens to reveal them.
 *
 * Every segment summarises a block that is already on screen, read from what that block just
 * painted: the mode from the automation select, the plan's progress from the count its heading
 * shows, the queue from the rows the queue block holds, and the countdown from the timer an
 * existing renderer ticks. Nothing here owns a deadline, counts anything itself or decides
 * anything — a countdown still grants no authority, and no second timer is introduced.
 */

/**
 * The painted text of one element, addressed by its whole selector.
 *
 * This is `querySelector`, not `$`: every caller names an element *inside* a block
 * (`#agentPlan .agent-plan-count`), and `getElementById` matches an id literally, so a
 * compound selector there resolves to null and the segment silently disappears.
 */
const textOf = (selector: string): string => document.querySelector(selector)?.textContent?.trim() ?? '';

/** The live segments, in the order the line reads them. */
function segments(): string[] {
  const parts: string[] = [];
  const mode = $<HTMLSelectElement>('chatAutomation')?.value ?? 'off';
  if (mode === 'loop') parts.push(t("loop"));
  else if (mode === 'goal') parts.push(t("goal"));
  const plan = $('agentPlan');
  if (!plan.hidden) {
    const progress = textOf('#agentPlan .agent-plan-count').replace(/\s+/g, '');
    if (progress) parts.push(t("plan {0}", [progress]));
  }
  const preview = $('taskPlanPreview');
  if (!preview.hidden) parts.push(preview.querySelector('.plan-stage') ? t("plan ready") : t("planning"));
  const queued = $('finishQueue').querySelectorAll(':scope > .queued-input').length;
  if (queued > 0) parts.push(t("queue {0}", [String(queued)]));
  // The countdown's own renderer already formats it; reading the painted text keeps one
  // formatter instead of a second one that would drift from it.
  const settling = textOf('#goalLifecycle .recovery-countdown') || textOf('#recoveryStatus .recovery-countdown');
  if (settling) parts.push(t("settling {0}", [settling]));
  const notice = $('recoveryStatus').querySelector('.recovery-notice > .queue-label');
  if (notice?.textContent) parts.push(notice.textContent);
  return parts;
}

/** The five blocks the line summarises, in the order the dock shows them. */
const DOCK_BLOCKS = ['agentPlan', 'recoveryStatus', 'taskPlanPreview', 'finishQueue', 'activeGoalRow'] as const;

/**
 * Repaint the line from the blocks it summarises.
 *
 * Called after those blocks are painted, so it never computes a fact of its own. The line is
 * hidden only when it has no segment and none of the blocks is showing anything — so a block
 * that paints a fact no segment names still cannot be stranded behind a closed disclosure.
 */
export function paintComposerStatusLine(): void {
  const line = $<HTMLDetailsElement>('composerStatusLine');
  const box = $('composerStatusSegments');
  const parts = segments();
  const live = DOCK_BLOCKS.some(id => !$(id).hidden);
  line.hidden = parts.length === 0 && !live;
  if (parts.length === 0) { box.replaceChildren(); return; }
  const existing = [...box.children] as HTMLElement[];
  for (const [index, text] of parts.entries()) {
    const node = existing[index] ?? el('span', 'composer-status-segment');
    if (!existing[index]) box.append(node);
    if (node.textContent !== text) node.textContent = text;
  }
  for (let index = parts.length; index < existing.length; index++) existing[index]!.remove();
}

/** Label the disclosure once, at boot, so a translation change keeps naming it. */
export function initComposerStatusLine(): void {
  ui($('composerStatusToggle'), 'aria-label', () => t("Composer status"));
}
