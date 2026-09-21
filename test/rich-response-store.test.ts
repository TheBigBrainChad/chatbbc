import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, getConfig, getRecordingRevision, initConfigPath, saveConfig, updateConfig } from '../src/main/config.js';
import * as config from '../src/main/config.js';
import { recordRichObservation, resetRecorderForTests } from '../src/main/session/recorder.js';
import {
  createSession, findSessionByConversation, flushSessions, getSession, initSessionStore, readEvents, rebindSession,
  sessionAttachmentTransitionPending, readCanonicalRichMessageOrigin, readCanonicalRichControlDescriptor,
  resetSessionStoreForTests, sessionsRoot, upsertMessageEvent, upsertRichMessage
} from '../src/main/session/store.js';
import { parseRichResponse, type RichNode } from '../src/shared/rich-response.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const PROVIDER = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
const OTHER = '3150f756-bf2d-45fa-ac0f-45010b2239fc';
const MESSAGE = 'assistant:working:exchange:1789552000000';
const origin = (bindingRevision = 0, conversationId = A, documentId = 'document-a', navigationEpoch = 1) =>
  ({ conversationId, bindingRevision, documentId, navigationEpoch });
const rich = (text = 'Choose', providerMessageId: string | null = PROVIDER) => {
  const parsed = parseRichResponse({
    version: 1, status: 'available', reason: null, conversationId: A, messageId: MESSAGE,
    providerMessageId, revision: 999, accessibleText: text,
    nodes: [{ id: 'n1', kind: 'text', style: 'body', text }]
  });
  if (!parsed) throw new Error('Invalid synthetic rich fixture');
  return parsed;
};
const richControls = (nodes: RichNode[]) => {
  const parsed = parseRichResponse({
    version: 1, status: 'available', reason: null, conversationId: A, messageId: MESSAGE,
    providerMessageId: PROVIDER, revision: 999, accessibleText: 'Choose a scene', nodes
  });
  if (!parsed) throw new Error('Invalid synthetic control tree');
  return parsed;
};
const choice = (id: string, value: string, selected = false, disabled = false, groupId: string | null = 'scene'): RichNode =>
  ({ id, kind: 'control', control: 'choice', label: value, groupId, value, selected, disabled,
    children: [] });
const continueControl = (id = 'continue', disabled = false, groupId: string | null = 'scene'): RichNode =>
  ({ id, kind: 'control', control: 'continue', label: 'Continue', groupId, value: null,
    selected: false, disabled, children: [] });
const sceneForm = (children: RichNode[]): RichNode =>
  ({ id: 'scene-form', kind: 'group', layout: 'card', children });
const answer = (text = 'Choose', providerMessageId = PROVIDER) => ({
  kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
  messageId: MESSAGE, message: { text, chars: text.length, truncated: false },
  providerMessageId, turnId: 'turn-owned', state: 'final' as const, final: true,
  goalEligible: true
});

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('clf-rich-store-');
  initConfigPath(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});
afterAll(async () => {
  resetRecorderForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});
beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
  A = randomUUID();
  B = randomUUID();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await saveConfig(defaultConfig());
});

describe('rich revisions of an existing canonical assistant shard', () => {
  it('reads a detached, read-only exact current control descriptor with historical selection only', async () => {
    const session = await createSession({ title: 'control descriptor', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const forest = await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest');
    expect(forest).toMatchObject({
      sessionId: session.id, conversationId: A, messageId: MESSAGE,
      providerMessageId: PROVIDER, bindingRevision: 0, documentId: 'document-a',
      navigationEpoch: 1, richRevision: 1, nodeId: 'forest', groupId: 'scene',
      kind: 'select', value: 'Forest', expectedSelected: false,
      expectedGroupSelection: 'Coast', historicalSelectionOnly: true
    });
    const follow = await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'continue');
    expect(follow).toMatchObject({ kind: 'continue', value: null,
      expectedGroupSelection: 'Coast', historicalSelectionOnly: true });
    expect(Object.isFrozen(forest)).toBe(true);
    expect(Object.isFrozen(follow)).toBe(true);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'missing')).toBeNull();
    expect(await readCanonicalRichControlDescriptor(session.id, 'wrong-message', 'forest')).toBeNull();
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toMatchObject({ conversationId: A });
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    expect(await rebindSession(session.id, B, A)).toBe(true);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    // Manual historical navigation stays available on the original committed shard.
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toMatchObject({ conversationId: A });
  });

  it('refuses controls whose structure cannot identify one exact native choice group', async () => {
    const session = await createSession({ title: 'ambiguous controls', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const attempt = async (nodes: RichNode[], nodeId: string) => {
      expect(await upsertRichMessage(session.id, MESSAGE, richControls(nodes), origin())).toBe('stored');
      expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, nodeId)).toBeNull();
    };
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Forest'), continueControl()])], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest', true), choice('coast', 'Coast', true), continueControl()])], 'continue');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      continueControl(), continueControl('second-continue')])], 'forest');
    // An ungrouped sibling within the SAME physical form is not proof of an
    // independent control. Do not ignore it when declaring the group unique.
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      continueControl(), continueControl('ungrouped-continue', false, null)])], 'continue');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      choice('ungrouped-choice', 'Forest', true, false, null), continueControl()])], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      choice('other-group', 'Forest', true, false, 'other'), continueControl()])], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest', false, true), choice('coast', 'Coast', true),
      continueControl()])], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      continueControl('continue', true)])], 'continue');
    await attempt([sceneForm([choice('forest', 'Forest', false, false, null),
      choice('coast', 'Coast', true), continueControl()])], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast'), continueControl()])], 'continue');
    await attempt([{
      id: 'outside', kind: 'group', layout: 'row', children: [
        { id: 'one-form', kind: 'group', layout: 'card', children: [choice('forest', 'Forest')] },
        { id: 'two-form', kind: 'group', layout: 'card', children: [choice('coast', 'Coast', true), continueControl()] }
      ]
    }], 'forest');
    await attempt([sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true),
      { id: 'link', kind: 'control', control: 'button', label: 'Press', groupId: 'scene',
        value: null, selected: false, disabled: false, children: [] }])], 'link');
  });

  it('keeps a choice form together across nested layout groups without lending independent forms authority', async () => {
    const session = await createSession({ title: 'nested rich choice layout', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const innerRow = (children: RichNode[]): RichNode => ({
      id: 'nested-row', kind: 'group', layout: 'row', children
    });
    expect(await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([innerRow([choice('forest', 'Forest'), choice('coast', 'Coast', true)]), continueControl()])
    ]), origin())).toBe('stored');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toMatchObject({
      nodeId: 'forest', groupId: 'scene', expectedGroupSelection: 'Coast'
    });
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'continue')).toMatchObject({
      nodeId: 'continue', kind: 'continue', expectedGroupSelection: 'Coast'
    });

    // The same enclosing card has one ungrouped Continue outside the nested row.
    // No nested presentation group may hide this competing native form member.
    expect(await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([innerRow([choice('forest', 'Forest'), choice('coast', 'Coast', true)]),
        continueControl('ungrouped-continue', false, null)])
    ]), origin())).toBe('stored');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();

    // A generic outer layout does not turn two independent cards into one form.
    expect(await upsertRichMessage(session.id, MESSAGE, richControls([{
      id: 'outer-row', kind: 'group', layout: 'row', children: [
        { id: 'form-one', kind: 'group', layout: 'card', children: [
          choice('forest', 'Forest', false, false, 'one'),
          choice('coast', 'Coast', true, false, 'one'),
          continueControl('continue-one', false, 'one')
        ] },
        { id: 'form-two', kind: 'group', layout: 'card', children: [
          choice('hill', 'Hill', false, false, 'two'),
          choice('lake', 'Lake', true, false, 'two'),
          continueControl('continue-two', false, 'two')
        ] }
      ]
    }]), origin())).toBe('stored');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toMatchObject({
      nodeId: 'forest', groupId: 'one', expectedGroupSelection: 'Coast'
    });
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'continue-two')).toMatchObject({
      nodeId: 'continue-two', groupId: 'two', expectedGroupSelection: 'Lake'
    });
  });

  it('keeps separate stored forms independently readable without granting native action', async () => {
    const session = await createSession({ title: 'separate inert forms', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([{
      id: 'two-cards', kind: 'group', layout: 'row', children: [
        sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()]),
        { id: 'other-form', kind: 'group', layout: 'card', children: [
          choice('mountain', 'Mountain', true, false, 'mountain-group'),
          continueControl('other-continue', false, 'mountain-group')
        ] }
      ]
    }]), origin());
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toMatchObject({
      groupId: 'scene', expectedGroupSelection: 'Coast', historicalSelectionOnly: true
    });
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'other-continue')).toMatchObject({
      groupId: 'mountain-group', expectedGroupSelection: 'Mountain', historicalSelectionOnly: true
    });
  });

  it('rejects a deleted or corrupt physical control shard without borrowing the in-memory rich tree', async () => {
    const session = await createSession({ title: 'physical control', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const filename = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const shard = path.join(sessionsRoot(), session.id, 'messages', filename);
    const bytes = await fs.readFile(shard);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    await fs.writeFile(shard, '{broken');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    await fs.writeFile(shard, bytes);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    await fs.rm(shard);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    const shadow = path.join(sessionsRoot(), session.id, 'shadow.json');
    await fs.writeFile(shadow, bytes);
    await fs.symlink(shadow, shard);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
  });

  it('refuses an identical SHA shard under a symlinked messages directory, not just a symlinked file', async () => {
    const session = await createSession({ title: 'physical directory custody', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const dir = path.join(sessionsRoot(), session.id, 'messages');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    const relocated = path.join(sessionsRoot(), session.id, 'relocated-messages');
    await fs.rename(dir, relocated);
    await fs.symlink(relocated, dir, 'dir');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
    await fs.rm(dir);
    await fs.rename(relocated, dir);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
  });

  it('refuses an exact control if another current session claims its conversation', async () => {
    const session = await createSession({ title: 'original owner', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    const duplicate = await createSession({ title: 'colliding current owner', conversationId: A });
    expect((await findSessionByConversation(A, { requireUnique: true }))).toBeNull();
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    expect(await readCanonicalRichControlDescriptor(duplicate.id, MESSAGE, 'forest')).toBeNull();
  });

  it('refuses a second physical provider-identical SHA shard even when memory alias folding hides it', async () => {
    const session = await createSession({ title: 'physical provider duplicates', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const directory = path.join(sessionsRoot(), session.id, 'messages');
    const originalName = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const original = JSON.parse(await fs.readFile(path.join(directory, originalName), 'utf8'));
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    const aliasId = 'independent-physical-alias';
    const aliasName = `${createHash('sha256').update(`assistant_message\u0000${aliasId}`).digest('hex')}.json`;
    await fs.writeFile(path.join(directory, aliasName), JSON.stringify({
      ...original, messageId: aliasId, rich: { ...original.rich, messageId: aliasId }
    }));
    // Physical evidence must not disappear merely because the permissive history
    // reader has never indexed the new file, or deliberately folds aliases on reopen.
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
    await flushSessions();
    resetSessionStoreForTests();
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    await fs.rm(path.join(directory, aliasName));
    resetSessionStoreForTests();
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
  });

  it('refuses a legacy provider alias inserted after the first absent-map check while shards are scanned', async () => {
    const session = await createSession({ title: 'legacy alias inserted mid-verification', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const base = path.join(sessionsRoot(), session.id);
    const directory = path.join(base, 'messages');
    const legacy = path.join(base, 'messages.json');
    const exactName = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const original = JSON.parse(await fs.readFile(path.join(directory, exactName), 'utf8'));
    await fs.rm(legacy);
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    const aliasId = 'legacy-late-provider-alias';
    const aliasKey = `assistant_message\u0000${aliasId}`;
    const opendir = fs.opendir.bind(fs);
    let inserted = false;
    const spy = vi.spyOn(fs, 'opendir').mockImplementation((async (target, options) => {
      if (String(target) === directory && !inserted) {
        inserted = true;
        await fs.writeFile(legacy, JSON.stringify({
          [aliasKey]: { ...original, messageId: aliasId, rich: { ...original.rich, messageId: aliasId } }
        }));
      }
      return opendir(target, options);
    }) as typeof fs.opendir);
    try {
      expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
      expect(inserted).toBe(true);
      expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts an independent provider shard but fails closed on damaged or legacy duplicate custody', async () => {
    const session = await createSession({ title: 'bounded physical custody', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, richControls([
      sceneForm([choice('forest', 'Forest'), choice('coast', 'Coast', true), continueControl()])
    ]), origin());
    const directory = path.join(sessionsRoot(), session.id, 'messages');
    const initialName = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const initial = JSON.parse(await fs.readFile(path.join(directory, initialName), 'utf8'));
    const otherId = 'independent-provider';
    const otherKey = `assistant_message\u0000${otherId}`;
    const otherName = `${createHash('sha256').update(otherKey).digest('hex')}.json`;
    const other = { ...initial, messageId: otherId, providerMessageId: OTHER,
      rich: { ...initial.rich, messageId: otherId, providerMessageId: OTHER } };
    const otherPath = path.join(directory, otherName);
    await fs.writeFile(otherPath, JSON.stringify(other));
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    await fs.writeFile(otherPath, '{broken unrelated assistant');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    await fs.writeFile(otherPath, JSON.stringify(other));
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
    const legacy = path.join(sessionsRoot(), session.id, 'messages.json');
    await fs.writeFile(legacy, JSON.stringify({ [otherKey]: { ...other, providerMessageId: PROVIDER } }));
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).toBeNull();
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
    await fs.writeFile(legacy, '{}');
    expect(await readCanonicalRichControlDescriptor(session.id, MESSAGE, 'forest')).not.toBeNull();
  });

  it('reads only the physically present exact canonical assistant shard for manual historical origin, never a legacy fallback', async () => {
    const session = await createSession({ title: 'manual historical original', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const exact = await readCanonicalRichMessageOrigin(session.id, MESSAGE);
    expect(exact).toMatchObject({ messageId: MESSAGE, providerMessageId: PROVIDER,
      conversationId: A, richRevision: 1, bindingRevision: 0 });
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toEqual(exact);
    const filename = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const shard = path.join(sessionsRoot(), session.id, 'messages', filename);
    const original = await fs.readFile(shard, 'utf8');
    // Even if a legacy event or in-memory map can still display this answer, its
    // missing/corrupt current canonical shard cannot authorize opening a browser.
    await fs.writeFile(shard, '{broken canonical');
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
    await fs.writeFile(shard, original);
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toEqual(exact);
    await fs.rm(shard);
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
  });

  it('refuses a mismatched or duplicate provider identity instead of opening another logical assistant', async () => {
    const session = await createSession({ title: 'exact manual original', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await upsertRichMessage(session.id, MESSAGE, rich(), origin());
    expect(await readCanonicalRichMessageOrigin(session.id, 'unrelated-logical-message')).toBeNull();
    const filename = `${createHash('sha256').update(`assistant_message\u0000${MESSAGE}`).digest('hex')}.json`;
    const shard = path.join(sessionsRoot(), session.id, 'messages', filename);
    const original = await fs.readFile(shard, 'utf8');
    await fs.writeFile(shard, JSON.stringify({ ...JSON.parse(original), providerMessageId: OTHER }));
    expect(await readCanonicalRichMessageOrigin(session.id, MESSAGE)).toBeNull();
  });

  it('enriches one exact logical message durably without changing content, turn or Goal facts', async () => {
    const session = await createSession({ title: 'rich canonical', conversationId: A });
    const first = await upsertMessageEvent(session.id, answer());
    const before = await getSession(session.id);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const rows = await readEvents(session.id);
    expect(rows.filter(row => row.kind === 'assistant_message')).toHaveLength(1);
    const stored = rows.find(row => row.kind === 'assistant_message');
    expect(first.event.kind).toBe('assistant_message');
    if (first.event.kind !== 'assistant_message') throw new Error('expected assistant');
    expect(stored).toMatchObject({
      messageId: MESSAGE, origin: first.event.origin, contentSeq: first.event.contentSeq,
      finalContentSeq: first.event.finalContentSeq, turnId: first.event.turnId,
      goalEligible: first.event.goalEligible, message: first.event.message,
      rich: { revision: 1, accessibleText: 'Choose' }, richOrigin: origin()
    });
    expect(stored!.seq).toBeGreaterThan(first.event.seq); // delivery cursor, not work sequence
    const after = await getSession(session.id);
    expect(after).toMatchObject({ events: before?.events, estimatedTokens: before?.estimatedTokens,
      contextTokens: before?.contextTokens, lastAssistantFinalAt: before?.lastAssistantFinalAt,
      activeTurnId: before?.activeTurnId, finishTurn: before?.finishTurn, updatedAt: before?.updatedAt });
    await flushSessions();
    resetSessionStoreForTests();
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toEqual(stored);
    expect((await getSession(session.id))?.bindingRevision).toBe(0);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('unchanged');
  });

  it('keeps same-provider rich through ordinary same-text upserts, but invalidates changed text or provider', async () => {
    const session = await createSession({ title: 'rich preservation', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const repeat = await upsertMessageEvent(session.id, { ...answer(), renderedHtml: { text: '<p>Choose</p>', chars: 13, truncated: false } });
    expect(repeat.event.kind === 'assistant_message' && repeat.event.rich?.revision).toBe(1);
    const replaced = await upsertMessageEvent(session.id, answer('Choose again'));
    expect(replaced.event.kind === 'assistant_message' && replaced.event.rich).toBeUndefined();
    expect(replaced.event.kind === 'assistant_message' && replaced.event.richOrigin).toBeUndefined();
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose again'), origin())).toBe('stored');
    const drift = await upsertMessageEvent(session.id, answer('Choose again', OTHER));
    expect(drift.event.kind === 'assistant_message' && drift.event.rich).toBeUndefined();
  });

  it('rejects missing or foreign logical/provider identity rather than creating a transcript row', async () => {
    const session = await createSession({ title: 'rich identity', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, 'unknown-row', rich(), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose', OTHER), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Choose', null), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin(0, B))).toBe('refused');
    expect((await readEvents(session.id)).filter(row => row.kind === 'assistant_message')).toHaveLength(1);
  });

  it('persists every successful A→B→A revision and refuses stale snapshots inside the store queue', async () => {
    const session = await createSession({ title: 'rich binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect(await rebindSession(session.id, B, A)).toBe(true);
    expect(await rebindSession(session.id, B, A)).toBe(false);
    expect((await getSession(session.id))?.bindingRevision).toBe(2);
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Stale'), origin())).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Fresh'), origin(2, A, 'document-return', 0))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Old'), origin())).toBe('refused');
    await flushSessions();
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.bindingRevision).toBe(2);
    const row = (await readEvents(session.id)).find(event => event.kind === 'assistant_message');
    expect(row).toMatchObject({ rich: { accessibleText: 'Fresh', revision: 2 }, richOrigin: origin(2, A, 'document-return', 0) });
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Again stale'), origin())).toBe('refused');
  });

  it('refuses a late original recording revision after physical Off→On without changing canonical history', async () => {
    const session = await createSession({ title: 'rich recording generation', conversationId: A });
    const first = await upsertMessageEvent(session.id, answer());
    if (first.event.kind !== 'assistant_message') throw new Error('expected assistant shard');
    const originalRecordingRevision = getRecordingRevision();
    await flushSessions();
    const shards = path.join(sessionsRoot(), session.id, 'messages');
    const names = await fs.readdir(shards);
    expect(names).toHaveLength(1);
    const originalBytes = await fs.readFile(path.join(shards, names[0]!));
    const originalSession = await getSession(session.id);

    await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
    try {
      expect(await upsertRichMessage(session.id, MESSAGE, rich('Off'), origin(), originalRecordingRevision)).toBe('refused');
    } finally {
      await updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
    }
    const freshRecordingRevision = getRecordingRevision();
    expect(freshRecordingRevision).toBe(originalRecordingRevision + 2);
    // The old capture arrives for its first store call only after the new On generation.
    resetSessionStoreForTests();
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Stale'), origin(), originalRecordingRevision)).toBe('refused');
    expect(await fs.readdir(shards)).toEqual(names);
    expect(await fs.readFile(path.join(shards, names[0]!))).toEqual(originalBytes);
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toEqual({ ...first.event, turnOrigin: null });
    expect(await getSession(session.id)).toMatchObject({
      events: originalSession?.events, estimatedTokens: originalSession?.estimatedTokens,
      contextTokens: originalSession?.contextTokens, lastAssistantFinalAt: originalSession?.lastAssistantFinalAt,
      activeTurnId: originalSession?.activeTurnId, finishTurn: originalSession?.finishTurn
    });

    expect(await upsertRichMessage(session.id, MESSAGE, rich('Fresh'), origin(), freshRecordingRevision)).toBe('stored');
    const fresh = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
    expect(fresh).toMatchObject({
      message: first.event.message, contentSeq: first.event.contentSeq,
      finalContentSeq: first.event.finalContentSeq, goalEligible: first.event.goalEligible,
      rich: { accessibleText: 'Fresh', revision: 1 }
    });
    // An omitted original revision keeps the existing generic rich-store contract.
    expect(await upsertRichMessage(session.id, MESSAGE, rich('Generic'), origin())).toBe('stored');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({
      message: first.event.message, contentSeq: first.event.contentSeq,
      finalContentSeq: first.event.finalContentSeq, goalEligible: first.event.goalEligible,
      rich: { accessibleText: 'Generic', revision: 2 }
    });
    expect(await fs.readdir(shards)).toEqual(names);
  });

  it('exposes pending attachment transition from call entry through physical commit and live publication', async () => {
    const session = await createSession({ title: 'pending rebind', conversationId: A });
    const metaPath = path.join(sessionsRoot(), session.id, 'meta.json');
    const rename = fs.rename.bind(fs);
    let firstReached!: () => void;
    let secondReached!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstPhysicalCommit = new Promise<void>(resolve => { firstReached = resolve; });
    const secondPhysicalCommit = new Promise<void>(resolve => { secondReached = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let commits = 0;
    const pending: Promise<boolean>[] = [];
    const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      await rename(from, to);
      if (String(to) === metaPath) {
        commits++;
        if (commits === 1) { firstReached(); await firstGate; }
        if (commits === 2) { secondReached(); await secondGate; }
      }
    }) as typeof fs.rename);
    try {
      expect(sessionAttachmentTransitionPending(session.id)).toBe(false);
      const first = rebindSession(session.id, A, B);
      pending.push(first);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(true);
      await firstPhysicalCommit;
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).conversationId).toBe(B);
      expect((await getSession(session.id))?.conversationId).toBe(A);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(true);

      const second = rebindSession(session.id, B, A);
      pending.push(second);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(true);
      releaseFirst();
      await secondPhysicalCommit;
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).conversationId).toBe(A);
      expect((await getSession(session.id))?.conversationId).toBe(B);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(true); // second pending after first settles
      releaseSecond();
      expect(await Promise.all([first, second])).toEqual([true, true]);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(false);
      expect(await getSession(session.id)).toMatchObject({ conversationId: A, bindingRevision: 2 });
      expect(await rebindSession(session.id, B, A)).toBe(false);
      expect(sessionAttachmentTransitionPending(session.id)).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled(pending);
      spy.mockRestore();
    }
  });

  it('refuses attachment acquisition while an opening exists live before its first metadata checkpoint', async () => {
    const id = randomUUID();
    const metaPath = path.join(sessionsRoot(), id, 'meta.json');
    const rename = fs.rename.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === metaPath) { entered(); await gate; }
      return rename(from, to);
    }) as typeof fs.rename);
    let creation: Promise<Awaited<ReturnType<typeof createSession>>> | null = null;
    try {
      creation = createSession({ reservedId: id, title: 'first checkpoint', conversationId: A });
      await reached;
      await expect(fs.stat(metaPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await getSession(id))?.conversationId).toBe(A);
      expect((await findSessionByConversation(A, { requireUnique: true }))?.id).toBe(id);
      expect(sessionAttachmentTransitionPending(id)).toBe(true);
    } finally {
      release();
      if (creation) await Promise.allSettled([creation]);
      spy.mockRestore();
    }
    expect(await creation).toMatchObject({ id, conversationId: A });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).conversationId).toBe(A);
    expect(sessionAttachmentTransitionPending(id)).toBe(false);

    const failedId = randomUUID();
    const failedMeta = path.join(sessionsRoot(), failedId, 'meta.json');
    const fault = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === failedMeta) throw new Error('creation rename failed');
      return rename(from, to);
    }) as typeof fs.rename);
    try {
      await expect(createSession({ reservedId: failedId, conversationId: B })).rejects.toThrow('creation rename failed');
      expect(sessionAttachmentTransitionPending(failedId)).toBe(false);
    } finally {
      fault.mockRestore();
    }
  });

  it('rejects stale or conflicting document/epoch and assigns monotonically newer rich revisions', async () => {
    const session = await createSession({ title: 'rich epochs', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin(0, A, 'doc', 3))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('old'), origin(0, A, 'doc', 2))).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('foreign'), origin(0, A, 'different-doc', 4))).toBe('refused');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('updated'), origin(0, A, 'doc', 4))).toBe('stored');
    expect(await upsertRichMessage(session.id, MESSAGE, rich('updated'), origin(0, A, 'doc', 4))).toBe('unchanged');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ rich: { revision: 2 } });
  });

  it('does not publish a failed atomic shard write and succeeds on safe retry', async () => {
    const session = await createSession({ title: 'rich failure', conversationId: A });
    const first = await upsertMessageEvent(session.id, answer());
    const realRename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, 'rename').mockImplementation((async (oldPath, newPath) => {
      if (String(newPath).includes(path.join(session.id, 'messages'))) throw new Error('simulated disk fault');
      return realRename(oldPath, newPath);
    }) as typeof fs.rename);
    await expect(upsertRichMessage(session.id, MESSAGE, rich(), origin())).rejects.toThrow('simulated disk fault');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toEqual({ ...first.event, turnOrigin: null });
    fault.mockRestore();
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ rich: { revision: 1 } });
    expect(sessionsRoot()).toBeTruthy();
  });

  it('refuses uncorroborated recorder observations and recording-Off even with a claimed document', async () => {
    const session = await createSession({ title: 'rich ingestion refused', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const item = { kind: 'assistant_message' as const, time: 100, messageId: MESSAGE,
      providerMessageId: PROVIDER, rich: rich(), documentId: 'fabricated', navigationEpoch: 1 };
    expect(await recordRichObservation(A, item)).toBe('refused');
    // Current config normalizes record:true as a product invariant; simulate a future
    // recording-disabled runtime at the consumer boundary without widening this task.
    const enabled = config.getConfig();
    const off = vi.spyOn(config, 'getConfig').mockReturnValue({ ...enabled, sessions: { ...enabled.sessions, record: false } });
    try {
      expect(await recordRichObservation(A, item)).toBe('refused');
      expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('refused');
    } finally {
      off.mockRestore();
    }
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).not.toHaveProperty('rich');
  });

  it('treats a pre-feature metadata checkpoint as binding revision zero', async () => {
    const session = await createSession({ title: 'legacy binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    await flushSessions();
    const file = path.join(sessionsRoot(), session.id, 'meta.json');
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    delete persisted.bindingRevision;
    await fs.writeFile(file, JSON.stringify(persisted), 'utf8');
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.bindingRevision).toBe(0);
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('never increments or publishes a failed rebind metadata checkpoint', async () => {
    const session = await createSession({ title: 'failed binding', conversationId: A });
    const realRename = fs.rename.bind(fs);
    const fault = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
      if (String(to) === path.join(sessionsRoot(), session.id, 'meta.json')) throw new Error('meta fault');
      return realRename(from, to);
    }) as typeof fs.rename);
    expect(await rebindSession(session.id, A, B)).toBe(false);
    expect(sessionAttachmentTransitionPending(session.id)).toBe(false);
    expect(await getSession(session.id)).toMatchObject({ conversationId: A, bindingRevision: 0 });
    fault.mockRestore();
    resetSessionStoreForTests();
    expect(await getSession(session.id)).toMatchObject({ conversationId: A, bindingRevision: 0 });
    expect(await rebindSession(session.id, A, B)).toBe(true);
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('never lets an ordinary upsert inject rich fields or replace the store-owned revision', async () => {
    const session = await createSession({ title: 'no rich smuggling', conversationId: A });
    const injected = { ...answer(), rich: rich(), richOrigin: origin(),
      richMediaUnavailable: 'unsupported' as const, retiredRichImageAssetIds: ['file_injected'] };
    const first = await upsertMessageEvent(session.id, injected);
    expect(first.event).not.toHaveProperty('rich');
    expect(first.event).not.toHaveProperty('richOrigin');
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), origin())).toBe('stored');
    const repeat = await upsertMessageEvent(session.id, { ...injected, rich: rich('malicious overwrite') });
    expect(repeat.event).toMatchObject({ rich: { accessibleText: 'Choose', revision: 1 } });
  });

  it('serializes a stale async rich request behind the exact rebind without reattaching A', async () => {
    const session = await createSession({ title: 'serialized binding', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    const first = upsertRichMessage(session.id, MESSAGE, rich(), origin());
    const moved = rebindSession(session.id, A, B);
    const stale = upsertRichMessage(session.id, MESSAGE, rich('stale'), origin());
    expect(await Promise.all([first, moved, stale])).toEqual(['stored', true, 'refused']);
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({
      rich: { accessibleText: 'Choose', revision: 1 }
    });
    expect((await getSession(session.id))?.bindingRevision).toBe(1);
  });

  it('snapshots origin descriptors without invoking untrusted Proxy property getters', async () => {
    const session = await createSession({ title: 'origin snapshots', conversationId: A });
    await upsertMessageEvent(session.id, answer());
    let gets = 0;
    const spoof = new Proxy(origin(), { get(target, key, receiver) {
      gets++;
      return key === 'conversationId' ? B : Reflect.get(target, key, receiver);
    } });
    expect(await upsertRichMessage(session.id, MESSAGE, rich(), spoof)).toBe('stored');
    expect(gets).toBe(0);
    expect((await readEvents(session.id)).find(row => row.kind === 'assistant_message')).toMatchObject({ richOrigin: origin() });
  });
});
