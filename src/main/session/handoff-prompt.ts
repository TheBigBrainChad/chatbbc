/**
 * What a handoff brief has to contain, in one place.
 *
 * One caller, now. These rules used to be shared with an external writer — a second model
 * that was handed a packed recording of the session and asked for the same document — and
 * keeping the two prompts from drifting was the reason this file exists. That path is gone:
 * the brief is written by the ChatGPT conversation that *is* the recording, and the answer it
 * writes is the brief. What survives is the specification of the document itself, which is
 * worth having in one named place whatever ends up reading it.
 */

import { APP_TITLE } from '../version.js';

/** The rules and headings. */
export const HANDOFF_BRIEF_RULES = `Rules:
- The user's latest accepted requirements are authoritative. Preserve the original goal, final constraints, unresolved corrections, and explicit preferences. Omit repetition and superseded discussion unless it explains the current state.
- Mark work done only when tool evidence verifies it. Distinguish verified work, claims, current work, failures, and unstarted work.
- Keep exact paths, symbols, commands, errors, ids, and versions only when they affect continuation. Preserve dirty-tree hazards, active processes, and delegated work that the next agent must not overwrite or repeat.
- Do not copy raw tool transcripts, long outputs, code, plans, specs, or chronology. Point to durable artifacts and summarize only the state needed to use them.
- If Superpowers is active, name the exact skill/workflow and put the authoritative spec path, plan path, and .superpowers/sdd/.../progress.md path on one line. Include the worktree and current task/fix round when known. Tell the next agent to read those artifacts and verify the ledger and git history before acting.
- Keep the failure → root cause → change → verification link for unresolved or risky work. If evidence is incomplete or ambiguous, say so briefly rather than guessing.
- Target 1,500–3,000 tokens; hard maximum 4,000 tokens. Shorter is better when the state is simple.

Use only nonempty sections:

TASK — goal and final user requirements.
WORKFLOW — active skill plus authoritative spec, plan, ledger, and worktree paths.
STATE — current repository, session, process, and dirty-tree state.
VERIFIED DONE — completed work and concise evidence.
OPEN — in-progress, failed, unresolved, delegated, or unverified work; include relevant errors and what was tried.
NEXT — concrete actions in order, including the first file or command to inspect.
PRESERVE — user work or accepted decisions that must not be overwritten, undone, or repeated.`;

/**
 * The instruction typed into the ChatGPT conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * The brief leaves as the answer, deliberately. A tool call is a thing the model can retry,
 * skip, or make three different versions of, and every one of those was a way for a
 * compaction to end with the wrong brief or none. An answer cannot be retried: the page
 * watches this exact generation, and whatever it finally wrote is what gets carried across.
 * So there is nothing here to call, and nothing to get right except the writing.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(token = '', includeToolCalls = true): string {
  const identity = sourceContinuationMarker(token);
  return (
    (identity ? `${identity}\n\n` : '') +
    `${APP_TITLE} is compacting this conversation so a fresh chat can continue the work. ` +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${HANDOFF_BRIEF_RULES}\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    'Your reply to this message must be the brief itself and nothing else: no preamble, no closing remark, no ' +
    'question back, and no tool calls. The app reads this reply, stores it, and opens the fresh chat with it.'
  );
}
