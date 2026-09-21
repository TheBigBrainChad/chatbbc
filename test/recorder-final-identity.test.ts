import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, getConfig, initConfigPath, pendingRecordingOffDecision, saveConfig, updateConfig } from '../src/main/config.js';
import { closeConversation, liveConversations, recordChatObservations, recordToolCall, resetRecorderForTests } from '../src/main/session/recorder.js';
import { emptyEvidence, trackInFlight } from '../src/main/mcp/call-context.js';
import { appendEvent, flushSessions, getSession, initSessionStore, readEvents, readCompletedFinal, upsertMessageEvent, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { sessionInputPolicy } from '../src/main/session/input.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;

it.each(['same', 'new-question', 'new-turn'] as const)('accepts a later native Stop only for its still-current source (%s)', async change => {
  const conversationId = `native-stop-upgrade-${change}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', messageId: 'stop-question', text: 'Work', time: 10 },
    { kind: 'turn_start', turnId: 'stop-source', time: 11 },
    { kind: 'turn_end', turnId: 'stop-source', outcome: 'interrupted', time: 12 }
  ]);
  if (change === 'new-question') await recordChatObservations(conversationId, [{ kind: 'user_message', messageId: 'new-question', text: 'Next', time: 13 }]);
  if (change === 'new-turn') await recordChatObservations(conversationId, [{ kind: 'turn_start', turnId: 'new-turn', time: 13 }]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const stop = { kind: 'turn_end' as const, turnId: 'stop-source', outcome: 'stopped' as const, time: 14 };
  const accepted = await recordChatObservations(conversationId, [stop]);
  expect(accepted.activity.terminal).toBe(change === 'same');
  await recordChatObservations(conversationId, [stop]);
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends.filter(event => event.kind === 'turn_end' && event.outcome === 'stopped')).toHaveLength(change === 'same' ? 1 : 0);
  if (change === 'new-turn') expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
});

it('finds the latest real work behind a later revision of an old native label', async () => {
  const { readRecentEvents } = await import('../src/main/session/store.js');
  const { workSequence } = await import('../src/shared/session.js');
  const opened = await recordChatObservations('native-label-work-order', [
    { kind: 'turn_start', turnId: 'work-order', time: 10 },
    { kind: 'page_tool', messageId: 'old-step', turnId: 'work-order', text: 'Preparing', time: 11 },
    { kind: 'page_tool', messageId: 'new-step', turnId: 'work-order', text: 'Searching', time: 12 }
  ]);
  const [before] = await readRecentEvents(opened.sessionId!, 1, { kinds: ['page_tool', 'turn_start'] });
  await recordChatObservations('native-label-work-order', [{ kind: 'page_tool', messageId: 'old-step', turnId: 'work-order', text: 'Prepared', time: 13 }]);
  const [after] = await readRecentEvents(opened.sessionId!, 1, { kinds: ['page_tool', 'turn_start'] });
  expect(workSequence(after!)).toBe(workSequence(before!));
});
it('records an empty native image message and keeps its stable origin on replay', async () => {
  const image = { kind: 'user_message' as const, messageId: 'image-only-user', time: 100, text: '',
    attachments: [{ id: 'native-file', name: 'example.png', size: 123, mimeType: 'image/png' }] };
  const opened = await recordChatObservations('image-only-recording', [image]);
  const [before] = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(before).toMatchObject({ kind: 'user_message', message: { text: '' }, attachments: image.attachments });
  await recordChatObservations('image-only-recording', [{ kind: 'turn_start', time: 110, turnId: 'image-answer' }, image]);
  const users = await readEvents(opened.sessionId!, { kinds: ['user_message'] });
  expect(users).toHaveLength(1);
  expect(users[0]!.seq).toBe(before!.seq);
});
beforeAll(async () => {
  directory = await makeTempDir('clf-final-identity-');
  initConfigPath(directory);
  initSessionStore(directory);
  await saveConfig(defaultConfig());
});
beforeEach(() => { resetRecorderForTests(); resetSessionStoreForTests(); });
afterAll(async () => { resetRecorderForTests(); resetSessionStoreForTests(); await removeTempDir(directory); });

it('promotes one anonymous final after the exact question in its original start/end envelope and cold replay', async () => {
  const conversationId = 'same-envelope-question-goal';
  const envelope = [
    { kind: 'turn_start', time: 10, turnId: 'turn-A' },
    { kind: 'user_message', time: 11, turnId: 'turn-A', messageId: 'question-U', text: 'Complete this task' },
    { kind: 'assistant_message', time: 15, messageId: 'final-F', text: 'Completed answer', state: 'final', final: true },
    { kind: 'turn_end', time: 20, turnId: 'turn-A', outcome: 'unknown' }
  ] as const;
  const initial = await recordChatObservations(conversationId, envelope);
  const sessionId = initial.sessionId!;
  expect(initial.goalCandidates).toEqual([{ replyId: 'final-F', turnId: 'reply:final-F', eventSeq: 4 }]);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(row => row.time)).toEqual([20]);
  expect((await readEvents(sessionId, { kinds: ['assistant_message'] }))[0]).toMatchObject({
    messageId: 'final-F', final: true, goalEligible: true
  });
  const originalRows = await readEvents(sessionId);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const replay = await recordChatObservations(conversationId, envelope);
  expect(replay.stored).toBe(0);
  expect(replay.goalCandidates).toEqual(initial.goalCandidates);
  expect(await readEvents(sessionId)).toEqual(originalRows);
});

it('repairs only the optional Goal revision after its first write fails following a committed question/end', async () => {
  const conversationId = 'same-envelope-question-optional-retry';
  const envelope = [
    { kind: 'turn_start', time: 10, turnId: 'turn-A' },
    { kind: 'user_message', time: 11, turnId: 'turn-A', messageId: 'question-U', text: 'The original question' },
    { kind: 'assistant_message', time: 15, messageId: 'final-F', text: 'The complete result', state: 'final', final: true },
    { kind: 'turn_end', time: 20, turnId: 'turn-A', outcome: 'unknown' }
  ] as const;
  const originalRename = fs.rename;
  let finalRenames = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).includes(`${path.sep}messages${path.sep}`) && String(args[1]).endsWith('.json')) {
      finalRenames++;
      // The original user and assistant each publish a canonical shard first.
      // Fail only the third rename, which is the optional post-end Goal revision.
      if (finalRenames === 3) throw Object.assign(new Error('optional Goal publication failed'), { code: 'EIO' });
    }
    return originalRename(...args);
  });
  try {
    await expect(recordChatObservations(conversationId, envelope)).rejects.toThrow('optional Goal publication failed');
  } finally { spy.mockRestore(); }
  expect(finalRenames).toBe(3);
  const { findSessionByConversation } = await import('../src/main/session/store.js');
  const sessionId = (await findSessionByConversation(conversationId))!.id;
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(row => row.time)).toEqual([20]);
  expect((await readEvents(sessionId, { kinds: ['assistant_message'] }))[0]).not.toHaveProperty('goalEligible', true);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const retried = await recordChatObservations(conversationId, envelope);
  expect(retried.goalCandidates).toEqual([{ replyId: 'final-F', turnId: 'reply:final-F', eventSeq: 4 }]);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(row => row.time)).toEqual([20]);
  expect((await readEvents(sessionId, { kinds: ['assistant_message'] }))[0]).toMatchObject({ goalEligible: true });
});

it('refuses an independent newer question even when its reused turn marker matches the obsolete end', async () => {
  const conversationId = 'independent-question-reused-turn';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn-A' }
  ]);
  const sessionId = opened.sessionId!;
  const question = await recordChatObservations(conversationId, [{
    kind: 'user_message', time: 21, turnId: 'turn-A', messageId: 'new-question-V',
    text: 'This is a different request', authoredNow: true
  }]);
  expect(question.stored).toBe(1);
  const stale = await recordChatObservations(conversationId, [{
    kind: 'turn_end', time: 30, turnId: 'turn-A', outcome: 'completed'
  }]);
  expect(stale).toMatchObject({ stored: 0, activity: { terminal: false } });
  expect(stale.goalCandidates).toEqual([]);
  expect(stale.workerActivationProved).not.toBe(true);
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn-A');
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual([]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const cold = await recordChatObservations(conversationId, [{
    kind: 'turn_end', time: 31, turnId: 'turn-A', outcome: 'completed'
  }]);
  expect(cold.stored).toBe(0);
  expect(cold.activity.terminal).toBe(false);
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual([]);
});

it.each([false, true])('closes a running turn after an exact app tool handout, including cold recovery (restart=%s)', async restart => {
  const conversationId = `app-tool-handout-terminal-${restart}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'tool-turn' }
  ]);
  const inputId = 'c93ca2e6-5b9a-4cbb-b191-00b86d847fa4';
  await upsertMessageEvent(opened.sessionId!, {
    kind: 'user_message', source: 'app', time: 11,
    messageId: `input:${inputId}`, inputId, inputDelivery: 'offered',
    turnId: 'tool-turn', message: { text: 'Injected tool input', chars: 19, truncated: false }
  });
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const result = await recordChatObservations(conversationId, [{
    kind: 'turn_end', time: 12, turnId: 'tool-turn', outcome: 'completed'
  }]);
  expect(result).toMatchObject({ stored: 1, activity: { terminal: true } });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect((await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).map(row => row.turnId)).toEqual(['tool-turn']);
});

it('never lets a later tool handout hide an independently authored newer question with the same turn marker', async () => {
  const conversationId = 'app-handout-after-newer-native-question';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'tool-turn' }
  ]);
  expect((await recordChatObservations(conversationId, [{
    kind: 'user_message', time: 11, turnId: 'tool-turn', messageId: 'new-question-V',
    text: 'Independent question', authoredNow: true
  }])).stored).toBe(1);
  const inputId = 'afaa1a41-c9a4-48d4-a085-b9256a2ee788';
  await upsertMessageEvent(opened.sessionId!, {
    kind: 'user_message', source: 'app', time: 12,
    messageId: `input:${inputId}`, inputId, inputDelivery: 'confirmed',
    turnId: 'tool-turn', message: { text: 'Tool handout', chars: 12, truncated: false }
  });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const stale = await recordChatObservations(conversationId, [{
    kind: 'turn_end', time: 13, turnId: 'tool-turn', outcome: 'completed'
  }]);
  expect(stale).toMatchObject({ stored: 0, activity: { terminal: false } });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('tool-turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toEqual([]);
});

it('refuses an ambiguous second question inside one turn envelope without promoting its final', async () => {
  const conversationId = 'ambiguous-same-envelope-questions';
  const batch = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn-A' },
    { kind: 'user_message', time: 11, turnId: 'turn-A', messageId: 'question-U', text: 'First question' },
    { kind: 'user_message', time: 12, turnId: 'turn-A', messageId: 'question-V', text: 'Second question' },
    { kind: 'assistant_message', time: 15, messageId: 'final-F', text: 'An ambiguous answer', state: 'final', final: true },
    { kind: 'turn_end', time: 20, turnId: 'turn-A', outcome: 'unknown' }
  ]);
  expect(batch.goalCandidates).toEqual([]);
  expect(await readEvents(batch.sessionId!, { kinds: ['turn_end'] })).toEqual([]);
  expect((await readEvents(batch.sessionId!, { kinds: ['assistant_message'] }))[0]).not.toHaveProperty('goalEligible', true);
});

it.each([false, true])('records stopped partial-answer revisions without restoring activity (restart=%s)', async restart => {
  const conversationId = `stopped-partial-${restart}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'stopped-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'stopped-turn', messageId: 'partial', text: 'Working', state: 'streaming', activeNow: true },
    { kind: 'turn_end', time: 12, turnId: 'stopped-turn', outcome: 'stopped' }
  ]);
  if (restart) { await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests(); }
  const revised = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'partial', text: 'Preserved partial answer', state: 'streaming', activeNow: true }
  ]);
  expect(revised.activity).toMatchObject({ meaningful: false, working: false, terminal: false });
  expect((await readEvents(opened.sessionId!, { kinds: ['assistant_message'] }))[0]).toMatchObject({ message: { text: 'Preserved partial answer' } });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: 30, turnId: 'new-turn' }]);
  const old = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 31, turnId: 'new-turn', messageId: 'partial', text: 'Historical partial revision', state: 'streaming', activeNow: true }
  ]);
  expect(old.activity.working).toBe(false);
  const current = await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 32, turnId: 'new-turn', messageId: 'new-answer', text: 'New work', state: 'streaming', activeNow: true }
  ]);
  expect(current.activity.working).toBe(true);
});

it.each(['missing', 'replaced', 'matching', 'restart'])('closes the canonical reply owner after reload with a %s page turn id', async mode => {
  const conversationId = `canonical-final-${mode}`;
  const turnId = `original-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId },
    { kind: 'assistant_message', time: 11, turnId, messageId: 'stable-answer', text: 'Working', state: 'streaming' }
  ]);
  await closeConversation(conversationId);
  if (mode === 'restart') {
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  }
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'stable-answer',
    text: 'The full canonical answer.', state: 'final' as const, final: true,
    ...(mode === 'matching' ? { turnId } : mode === 'replaced' ? { turnId: 'replacement-page-id' } : {}) };
  const recovered = await recordChatObservations(conversationId, [final]);
  const sessionId = opened.sessionId!;
  expect(recovered.sessionId).toBe(sessionId);
  const [message] = await readEvents(sessionId, { kinds: ['assistant_message'] });
  expect(message).toMatchObject({ turnId, state: 'final', message: { text: final.text } });
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBeNull();
  expect(recovered.activity).toMatchObject({ terminal: true, endedTurnId: turnId });
  await recordChatObservations(conversationId, [final]);
  expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['missing', 'current-page-id'])('never closes newer work from an old canonical answer with %s identity', async mode => {
  const conversationId = `historical-final-${mode}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'old-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'old-turn', messageId: 'old-answer', text: 'Old result', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'old-turn', outcome: 'completed' },
    { kind: 'turn_start', time: 20, turnId: 'new-turn' }
  ]);
  const result = await recordChatObservations(conversationId, [{
    kind: 'assistant_message', time: 30, messageId: 'old-answer', text: 'Old result', state: 'final', final: true,
    ...(mode === 'current-page-id' ? { turnId: 'new-turn' } : {})
  }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('new-turn');
  expect(result.activity.terminal).toBe(false);
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it.each(['stopped', 'failed', 'unknown'] as const)('does not turn an explicit %s verdict into completion', async outcome => {
  const conversationId = `explicit-final-${outcome}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'original-turn' },
    { kind: 'assistant_message', time: 11, turnId: 'original-turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Recovered prose', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'original-turn', outcome }
  ]);
  const ends = await readEvents(opened.sessionId!, { kinds: ['turn_end'] });
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ outcome });
});

it.each(['canonical', 'explicit'])('keeps a turn reopened for late tools open until fresh %s completion', async completion => {
  const conversationId = `reopened-final-${completion}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 30, messageId: 'answer',
    text: 'First final', state: 'final', final: true }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  // A fresh canonical revision may finish the same turn; silence cannot.
  await recordChatObservations(conversationId, completion === 'canonical'
    ? [{ kind: 'assistant_message', time: 40, messageId: 'answer', text: 'A new final after the late work.', state: 'final', final: true }]
    : [{ kind: 'turn_end', time: 40, turnId: 'turn', outcome: 'completed' }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('accepts a new end after an app reopen beyond the recent read budget but never replays its old end', async () => {
  const conversationId = 'reopened-final-beyond-recent-tail';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer',
      text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  const sessionId = opened.sessionId!;
  await appendEvent(sessionId, { source: 'app', kind: 'turn_start', time: 20,
    turnId: 'turn', detail: 'The same server turn resumed' });
  resetRecorderForTests();
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 21,
    messageId: 'answer', text: 'First final', state: 'final', final: true }]);
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn');

  // Synthetic, individually valid durable rows prove this is not just a 2 MiB
  // cached-history issue: the most recent lifecycle boundary is >8 MiB behind
  // the journal tail and must still be checked without trusting absence in a page.
  const filler = 'x'.repeat(480_000);
  for (let index = 0; index < 20; index++) {
    await appendEvent(sessionId, { source: 'extension', kind: 'page_tool',
      time: 30 + index, messageId: `long-label-${index}`, label: filler });
  }
  await recordChatObservations(conversationId, [{ kind: 'turn_end', time: 12,
    turnId: 'turn', outcome: 'completed' }]);
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn');
  await recordChatObservations(conversationId, [{ kind: 'turn_end', time: 100,
    turnId: 'turn', outcome: 'completed' }]);
  expect((await getSession(sessionId))?.activeTurnId).toBeNull();
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([12, 100]);
}, 60_000);

it('strengthens only the latest interrupted end to Stop beyond 8 MiB of unrelated activity', async () => {
  const conversationId = 'stop-upgrade-beyond-recent-tail';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', messageId: 'stop-question', text: 'Work', time: 10 },
    { kind: 'turn_start', turnId: 'stop-source', time: 11 },
    { kind: 'turn_end', turnId: 'stop-source', outcome: 'interrupted', time: 12 }
  ]);
  const sessionId = opened.sessionId!;
  const filler = 'x'.repeat(480_000);
  for (let index = 0; index < 20; index++) {
    await appendEvent(sessionId, { source: 'extension', kind: 'page_tool',
      time: 30 + index, messageId: `stop-long-label-${index}`, label: filler });
  }
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  const stop = { kind: 'turn_end' as const, turnId: 'stop-source', outcome: 'stopped' as const, time: 100 };
  const accepted = await recordChatObservations(conversationId, [stop]);
  expect(accepted).toMatchObject({ stored: 1, activity: { terminal: true } });
  await recordChatObservations(conversationId, [stop]);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.kind === 'turn_end' && event.outcome))
    .toEqual(['interrupted', 'stopped']);
  await recordChatObservations(conversationId, [{ kind: 'user_message', messageId: 'new-stop-question', text: 'Next', time: 101 }]);
  const obsolete = await recordChatObservations(conversationId, [{ ...stop, time: 102 }]);
  expect(obsolete.activity.terminal).toBe(false);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([12, 100]);
}, 60_000);

it('refuses a Stop upgrade when the latest journal suffix is damaged', async () => {
  const conversationId = 'stop-corrupt-journal-suffix';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', turnId: 'turn', time: 10 },
    { kind: 'turn_end', turnId: 'turn', outcome: 'interrupted', time: 12 }
  ]);
  const sessionId = opened.sessionId!;
  await fs.appendFile(path.join(directory, 'sessions', sessionId, 'events.jsonl'), '{damaged-row}\n');
  await expect(recordChatObservations(conversationId, [{
    kind: 'turn_end', turnId: 'turn', outcome: 'stopped', time: 20
  }])).rejects.toThrow(/damaged journal/);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([12]);
});

it('rejects a replayed Stop before an app reopen and accepts only the new generation', async () => {
  const conversationId = 'stop-prior-end-reopened';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', turnId: 'turn', time: 10 },
    { kind: 'turn_end', turnId: 'turn', outcome: 'completed', time: 12 }
  ]);
  const sessionId = opened.sessionId!;
  await appendEvent(sessionId, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn' });
  resetRecorderForTests();
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', messageId: 'answer',
    text: 'Late work', state: 'streaming', time: 21 }]);
  const obsolete = await recordChatObservations(conversationId, [{
    kind: 'turn_end', turnId: 'turn', outcome: 'stopped', time: 12
  }]);
  expect(obsolete.activity.terminal).toBe(false);
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn');
  const accepted = await recordChatObservations(conversationId, [{
    kind: 'turn_end', turnId: 'turn', outcome: 'stopped', time: 22
  }]);
  expect(accepted.activity.terminal).toBe(true);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([12, 22]);
});

it.each(['A-to-B', 'A-to-B-to-A'] as const)(
  'refuses obsolete A completion after a %s rebind during the boundary scan', async route => {
  const conversationId = `turn-end-boundary-race-a-${route}`;
  const destinationId = `turn-end-boundary-race-b-${route}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  const sessionId = opened.sessionId!;
  await appendEvent(sessionId, { source: 'app', kind: 'turn_start', time: 20,
    turnId: 'turn', detail: 'Late tools prove this turn reopened' });
  await flushSessions();
  resetRecorderForTests();
  // Rebuild the live reopened generation before racing the next page end.
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 21,
    messageId: 'answer', text: 'Still working', state: 'streaming' }]);
  expect((await getSession(sessionId))?.activeTurnId).toBe('turn');

  const originalOpen = fs.open;
  let journalReads = 0;
  let rebounded = false;
  let moving: Promise<boolean> | null = null;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('events.jsonl') && args[1] === 'r' && ++journalReads === 1) {
      const read = handle.read.bind(handle);
      (handle as any).read = async (...readArgs: any[]) => {
        const bytes = await (read as any)(...readArgs);
        if (!rebounded) {
          rebounded = true;
          // The rebind raises its synchronous pending fence before waiting for the
          // session queue. Awaiting it inside that queue's reader would deadlock.
          moving = route === 'A-to-B'
            ? rebindSession(sessionId, conversationId, destinationId)
            : (async () => {
                const first = await rebindSession(sessionId, conversationId, destinationId);
                const second = await rebindSession(sessionId, destinationId, conversationId);
                return first && second;
              })();
        }
        return bytes;
      };
    }
    return handle;
  });
  try {
    await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: 40, turnId: 'turn', outcome: 'completed' }
    ]);
  } finally { spy.mockRestore(); }
  expect(rebounded).toBe(true);
  expect(await moving).toBe(true);
  expect((await getSession(sessionId))?.conversationId).toBe(route === 'A-to-B' ? destinationId : conversationId);
  expect((await getSession(sessionId))?.bindingRevision).toBe(route === 'A-to-B' ? 1 : 2);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([12]);
});

it.each(['before', 'after'] as const)(
  'reconciles a %s-disk append failure without inventing or losing an end receipt', async failure => {
  const conversationId = `turn-end-append-${failure}`;
  const opened = await recordChatObservations(conversationId, [{
    kind: 'turn_start', turnId: 'turn', time: 10
  }]);
  const sessionId = opened.sessionId!;
  const actualAppend = fs.appendFile;
  let injected = false;
  const spy = vi.spyOn(fs, 'appendFile').mockImplementation(async (...args: Parameters<typeof fs.appendFile>) => {
    if (!injected && String(args[0]).endsWith('events.jsonl') &&
        String(args[1]).includes('"kind":"turn_end"')) {
      injected = true;
      if (failure === 'after') await actualAppend(...args);
      throw Object.assign(new Error('injected append failure'), { code: 'EIO' });
    }
    return actualAppend(...args);
  });
  const end = { kind: 'turn_end' as const, turnId: 'turn', time: 20, outcome: 'completed' as const };
  try {
    if (failure === 'before') await expect(recordChatObservations(conversationId, [end]))
      .rejects.toThrow('injected append failure');
    else expect((await recordChatObservations(conversationId, [end])).stored).toBe(1);
  } finally { spy.mockRestore(); }
  expect(injected).toBe(true);
  const retried = await recordChatObservations(conversationId, [end]);
  expect(retried.stored).toBe(failure === 'before' ? 1 : 0);
  expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([20]);
});

it.each([true, false])('preserves turn-end custody when provisional Recording Off %s', async offSucceeds => {
  const conversationId = `end-pending-off-${offSucceeds}`;
  const opened = await recordChatObservations(conversationId, [{
    kind: 'turn_start', turnId: 'turn', time: 10
  }]);
  const sessionId = opened.sessionId!;
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  let intercepted = false;
  let disabling: Promise<unknown> | null = null;
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (!intercepted && String(args[0]).endsWith('events.jsonl') && args[1] === 'r') {
      intercepted = true;
      const read = handle.read.bind(handle);
      (handle as any).read = async (...readArgs: any[]) => {
        const bytes = await (read as any)(...readArgs);
        disabling = saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
        void disabling.catch(() => undefined);
        await vi.waitFor(() => expect(pendingRecordingOffDecision()).not.toBeNull());
        return bytes;
      };
    }
    return handle;
  });
  const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    if (!offSucceeds && String(args[1]) === path.join(directory, 'config.json')) {
      throw Object.assign(new Error('injected Recording Off failure'), { code: 'EIO' });
    }
    return originalRename(...args);
  });
  try {
    const end = { kind: 'turn_end' as const, turnId: 'turn', time: 20, outcome: 'completed' as const };
    if (offSucceeds) {
      expect(await recordChatObservations(conversationId, [end]))
        .toMatchObject({ stored: 0, activity: { terminal: false } });
      await disabling;
      expect((await readEvents(sessionId, { kinds: ['turn_end'] }))).toHaveLength(0);
    } else {
      await expect(recordChatObservations(conversationId, [end])).rejects.toThrow('Recording is disabled');
      await expect(disabling).rejects.toThrow('injected Recording Off failure');
      expect(getConfig().sessions.record).toBe(true);
      expect((await recordChatObservations(conversationId, [end])).stored).toBe(1);
      expect((await readEvents(sessionId, { kinds: ['turn_end'] })).map(event => event.time)).toEqual([20]);
    }
    expect(intercepted).toBe(true);
  } finally {
    openSpy.mockRestore();
    renameSpy.mockRestore();
    await Promise.allSettled([disabling].filter(promise => promise !== null));
    if (!getConfig().sessions.record) {
      await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
    }
  }
});

it('does not close the old turn after a newer user message arrives in the recovery batch', async () => {
  const conversationId = 'new-user-during-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true },
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});

it('commits a recovered final while its running tool still blocks delivery', async () => {
  const conversationId = 'final-with-running-tool';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  const final = { kind: 'assistant_message' as const, time: 20, messageId: 'answer', text: 'Full answer', state: 'final' as const, final: true };
  await trackInFlight({ startedAt: 12, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId: 'running-call', transportKey: null } }, async () => {
    await recordChatObservations(conversationId, [final]);
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
  });
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
});

it('keeps the exact native final completed when the same Pro request calls tools afterwards', async () => {
  const conversationId = 'native-final-late-tools';
  const requestId = 'wfr_native_final';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'tool_evidence', time: 11, fiberConversationId: conversationId,
      calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ]);
  const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, requestId, startedAt });
  await call(12);
  await recordChatObservations(conversationId, [
    { kind: 'assistant_message', time: 20, turnId: 'turn', messageId: 'answer', providerMessageId: 'native-answer',
      text: 'Completed native answer', state: 'final', final: true },
    { kind: 'turn_end', time: 21, turnId: 'turn', outcome: 'completed' }
  ]);
  await call(22);
  await call(23);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_start'] })).toHaveLength(1);
  expect(await readEvents(opened.sessionId!, { kinds: ['tool_call'] })).toHaveLength(3);
});

it('dates recovered completion by observation when testing later request activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'final-observation-time';
    const requestId = 'wfr_final_observation';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'turn' },
      { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' },
      { kind: 'tool_evidence', time: 12, fiberConversationId: conversationId,
        calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
    ]);
    const call = (startedAt: number) => recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok', durationMs: 1, requestId, startedAt });
    await call(100);
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 11, authoredTime: true,
      messageId: 'answer', text: 'Full answer', state: 'final', final: true }]);
    await call(1500); // Started before the final was observed, despite its old creation time.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
    await call(2001); // This new same-request call really proves the completion false.
    expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  } finally { clock.mockRestore(); }
});

it.each(['html', 'authored-time', 'goal-eligibility'])('does not settle late work from an old final gaining %s metadata', async metadata => {
  const conversationId = `final-metadata-${metadata}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'First final', state: 'final', final: true },
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn', detail: 'Late tools reopened this turn' });
  resetRecorderForTests();
  const oldFinal = { kind: 'assistant_message' as const, time: 30, messageId: 'answer', text: 'First final', state: 'final' as const, final: true,
    ...(metadata === 'html' ? { renderedHtml: '<p>First final</p>' } : {}),
    ...(metadata === 'authored-time' ? { authoredTime: true } : {}),
    ...(metadata === 'goal-eligibility' ? { goalEligible: true } : {}) };
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [oldFinal]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(1);
});

it('repairs a durable app reopen from the exact native final after restart', async () => {
  const conversationId = 'native-final-repair';
  const final = { kind: 'assistant_message' as const, time: 11, turnId: 'turn', messageId: 'answer',
    providerMessageId: 'native-answer', text: 'Completed answer', state: 'final' as const, final: true };
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' }, final,
    { kind: 'turn_end', time: 12, turnId: 'turn', outcome: 'completed' }
  ]);
  await appendEvent(opened.sessionId!, { kind: 'turn_start', source: 'app', time: 20, turnId: 'turn' });
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  await recordChatObservations(conversationId, [{ ...final, time: 30 }]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBeNull();
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(2);
});

it('does not close an old turn when its revised final follows a newer user message in the batch', async () => {
  const conversationId = 'new-user-before-final-recovery';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'turn_start', time: 10, turnId: 'turn' },
    { kind: 'assistant_message', time: 11, turnId: 'turn', messageId: 'answer', text: 'Partial', state: 'streaming' }
  ]);
  await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 21, messageId: 'next-user', text: 'New work', authoredNow: true },
    { kind: 'assistant_message', time: 20, messageId: 'answer', text: 'Final answer', state: 'final', final: true }
  ]);
  expect((await getSession(opened.sessionId!))?.activeTurnId).toBe('turn');
  expect(await readEvents(opened.sessionId!, { kinds: ['turn_end'] })).toHaveLength(0);
});


it.each([false, true])('accepts a textless native final only with exact provider identity (%s)', async native => {
  const conversationId = `image-final-${native}`;
  const result = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 10, messageId: 'image-question', text: 'Generate two images' },
    { kind: 'turn_start', time: 11, turnId: 'image-turn' },
    { kind: 'assistant_message', time: 20, messageId: 'image-final', turnId: 'image-turn', text: '',
      ...(native ? { providerMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } : {}), state: 'final', final: true, goalEligible: true },
    { kind: 'turn_end', time: 21, turnId: 'image-turn', outcome: 'completed' }
  ]);
  expect(!!await readCompletedFinal(result.sessionId!, conversationId)).toBe(native);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  expect(!!await readCompletedFinal(result.sessionId!, conversationId)).toBe(native);
  await recordChatObservations(conversationId, [{ kind: 'user_message', time: 30,
    messageId: 'new-image-question', text: 'Generate another image', authoredNow: true }]);
  expect(await readCompletedFinal(result.sessionId!, conversationId)).toBeNull();
});

it('uses an unowned canonical final as a settled ordinary input boundary without inventing a turn', async () => {
  const conversationId = 'unowned-final-current-question';
  const opened = await recordChatObservations(conversationId, [
    { kind: 'model_selection', time: 1, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: 10, messageId: 'question', text: 'Report the findings' },
    { kind: 'assistant_message', time: 20, messageId: 'reply', text: 'Complete report', state: 'final', final: true }
  ]);
  const id = opened.sessionId!;
  expect(await readCompletedFinal(id, conversationId)).toMatchObject({ messageId: 'reply', turnId: null });
  expect(await sessionInputPolicy(id)).toMatchObject({ browserAllowed: true, settled: true });
  expect(await readEvents(id, { kinds: ['turn_start', 'turn_end'] })).toEqual([]);
  await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
  expect(await readCompletedFinal(id, conversationId)).toMatchObject({ messageId: 'reply', turnId: null });
  await recordChatObservations(conversationId, [{ kind: 'user_message', time: 30, messageId: 'new-question', text: 'New work', authoredNow: true }]);
  await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 40, messageId: 'reply', text: 'Complete report plus metadata', state: 'final', final: true }]);
  expect(await readCompletedFinal(id, conversationId)).toBeNull();
  expect((await sessionInputPolicy(id)).settled).toBe(false);
});

it('preserves final acceptance across metadata, late call recording and restart, but rejects fresh work and rebinding', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const conversationId = 'completion-observed-time';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 1, messageId: 'question', text: 'Do work' },
      { kind: 'assistant_message', time: 10, messageId: 'answer', text: 'Done', state: 'final', final: true }
    ]);
    const id = opened.sessionId!;
    clock.mockReturnValue(2000);
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: 10, messageId: 'answer', text: 'Done', renderedHtml: '<p>Done</p>', state: 'final', final: true }]);
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    const call = (time: number) => appendEvent(id, { kind: 'tool_call', source: 'mcp', time,
      call: { callId: `call-${time}`, tool: 'read', attribution: 'request_id', attributionMethod: 'request_id', conversationId, requestId: 'request',
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false }, summary: { kind: 'read', title: 'Read', tone: 'good' }, outcome: 'ok', durationMs: 1 } });
    await call(500); // Starts after provider creation, before actual final acceptance.
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 1000 });
    await call(1500);
    expect(await readCompletedFinal(id, conversationId)).toBeNull();
    await upsertMessageEvent(id, { kind: 'assistant_message', source: 'extension', time: 10,
      messageId: 'answer', message: { text: 'A fresh final after more work', chars: 29, truncated: false }, state: 'final', final: true });
    expect(await readCompletedFinal(id, conversationId)).toMatchObject({ completedAt: 2000 });
    expect(await rebindSession(id, conversationId, 'completion-new-binding')).toBe(true);
    expect(await readCompletedFinal(id, conversationId)).toBeNull();
  } finally { clock.mockRestore(); }
});

it.each(['question', 'rebind'] as const)('rejects a final snapshot when %s changes during its disk read', async change => {
  const conversationId = `completion-race-${change}`;
  const opened = await recordChatObservations(conversationId, [
    { kind: 'user_message', time: 1, messageId: 'question', text: 'Do work' },
    { kind: 'assistant_message', time: 2, messageId: 'answer', text: 'Done', state: 'final', final: true }
  ]);
  await flushSessions();
  const originalOpen = fs.open;
  let intercepted = false;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (!intercepted && String(args[0]).endsWith('events.jsonl') && args[1] === 'r') {
      intercepted = true;
      if (change === 'rebind') await rebindSession(opened.sessionId!, conversationId, 'race-destination');
      else await upsertMessageEvent(opened.sessionId!, { kind: 'user_message', source: 'extension', time: 3,
        messageId: 'new-question', message: { text: 'Next', chars: 4, truncated: false } });
    }
    return originalOpen(...args);
  });
  try {
    expect(await readCompletedFinal(opened.sessionId!, conversationId)).toBeNull();
    expect(intercepted).toBe(true);
  } finally { spy.mockRestore(); }
});
