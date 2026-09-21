import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import sharp from '../src/main/sharp.js';
import type { RichResponse } from '../src/shared/rich-response.js';
import { renderRichResponse } from '../src/renderer/rich-response.js';
import { defaultConfig, getConfig, getRecordingRevision, initConfigPath, loadConfig, recordingGenerationGrant, recordingWriteAllowed, saveConfig, updateConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, readDurable, writeDurableNow } from '../src/main/durable.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { configureInputDelivery, listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { recordChatObservations, recordRichObservation, recordVerifiedChatObservations,
  resetRecorderForTests, sessionForConversation, type ChatObservation, type VerifiedRichObservation } from '../src/main/session/recorder.js';
import { appendEvent, clearImageStorage, createSession, getImageStorage, getSession, initSessionStore, readAsset,
  readEvents, readRecordedSessionImage, rebindSession, resetSessionStoreForTests, sessionsRoot, upsertMessageEvent,
  upsertNativeImageEvent, upsertRichMedia, upsertRichMessage, flushSessions, writeAsset } from '../src/main/session/store.js';

let directory: string;
const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const message = (id: string) => ({ kind: 'user_message' as const, source: 'app' as const,
  messageId: id, time: 100, message: text(id) });
const off = async () => {
  await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: false } });
  expect(getConfig().sessions.record).toBe(false);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(false);
};
// Re-enabling recording is an explicit current-state transition, not a stale whole-snapshot save.
const on = async () => updateConfig(latest => ({ ...latest, sessions: { ...latest.sessions, record: true } }));
/** Off must close admission before a previously started physical writer is released. */
function beginOffBehindWriter(): { saved: Promise<void>; closing: Promise<void> } {
  const saved = off();
  const closing = vi.waitFor(() => expect(recordingWriteAllowed(getRecordingRevision())).toBe(false));
  return { saved, closing };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbbc-recording-off-'));
  initConfigPath(directory);
  await loadConfig();
  initSessionStore(directory);
  initDurableStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  await flushDurable();
  resetRecorderForTests();
  resetSessionStoreForTests();
  await updateConfig(() => defaultConfig());
  await fs.rm(directory, { recursive: true, force: true });
});

/** Pause exactly one owner write while leaving the independent config writer able to commit. */
function gateRename(target: string) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!held && String(to) === target) { held = true; entered(); await gate; }
    return rename(from, to);
  }) as typeof fs.rename);
  return { reached, release, restore: () => spy.mockRestore() };
}

it('keeps a canonical image-card choice and wide diagram readable but non-actionable after rebind and disk reload', async () => {
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const session = await createSession({ conversationId: conversationA });
  const messageId = 'assistant:working:exchange:1789552000000';
  const providerMessageId = randomUUID();
  const original = { conversationId: conversationA, bindingRevision: 0, documentId: 'fixture-document', navigationEpoch: 1 };
  const control = (id: string, label: string, selected: boolean) => ({
    id, kind: 'control' as const, control: 'choice' as const, label, groupId: 'choice-group',
    value: id, selected, disabled: false, children: []
  });
  const image = (id: string, mediaId: string, alt: string) =>
    ({ id, kind: 'image' as const, mediaId, alt, width: 640, height: 480 });
  const rich: RichResponse = {
    version: 1, status: 'available', reason: null, conversationId: conversationA,
    messageId, providerMessageId, revision: 0, accessibleText: 'Choose between two image-backed options',
    nodes: [
      { id: 'choices', kind: 'group', layout: 'grid', children: [
        { id: 'forest-card', kind: 'group', layout: 'card', children: [
          image('forest-picture', 'forest-media', 'Forest option'), control('forest-choice', 'Forest', true)
        ] },
        { id: 'coast-card', kind: 'group', layout: 'card', children: [
          image('coast-picture', 'coast-media', 'Coast option'), control('coast-choice', 'Coast', false)
        ] }
      ] },
      { id: 'continue', kind: 'control', control: 'continue', label: 'Continue', groupId: null,
        value: null, selected: false, disabled: false, children: [] },
      { id: 'wide-table', kind: 'group', layout: 'table', children: Array.from({ length: 2 }, (_, row) => ({
        id: `table-row-${row}`, kind: 'group' as const, layout: 'row' as const,
        children: Array.from({ length: 12 }, (_, column) => ({
          id: `cell-${row}-${column}`, kind: 'text' as const, style: 'body' as const,
          text: `Column ${column + 1}, row ${row + 1}: ${'wide comparison '.repeat(6)}`
        }))
      })) },
      { id: 'diagram', kind: 'group', layout: 'diagram', children: [
        { id: 'diagram-lane', kind: 'group', layout: 'row', children: Array.from({ length: 12 }, (_, index) => ({
          id: `diagram-node-${index}`, kind: 'text' as const, style: 'caption' as const,
          text: `Architecture component ${index + 1}: routed through a separate diagram node`
        })) }
      ] }
    ]
  };
  await upsertMessageEvent(session.id, {
    kind: 'assistant_message', source: 'extension', time: 100, messageId, providerMessageId,
    message: text('Choose between two image-backed options'), turnId: 'fixture-turn', state: 'final', final: true
  });
  expect(await upsertRichMessage(session.id, messageId, rich, original)).toBe('stored');
  for (const [mediaId, nodeId] of [['forest-media', 'forest-picture'], ['coast-media', 'coast-picture']]) {
    expect(await upsertRichMedia(session.id, messageId,
      { mediaId: mediaId!, nodeId: nodeId!, source: { kind: 'page', nodeId: nodeId! }, status: 'pending' },
      original, 1)).toBe('stored');
  }
  expect(await rebindSession(session.id, conversationA, conversationB)).toBe(true);
  await flushSessions();
  resetSessionStoreForTests();
  const rows = (await readEvents(session.id)).filter(row => row.kind === 'assistant_message');
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row).toMatchObject({ messageId, providerMessageId,
    richOrigin: original, rich: { revision: 1 }, richMedia: [{ status: 'pending' }, { status: 'pending' }] });
  if (row?.kind !== 'assistant_message' || !row.rich) throw Error('Missing saved rich assistant');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  try {
    const view = renderRichResponse(row.rich, '<text>untrusted source</text>', {
      sessionId: session.id, media: row.richMedia ?? [], current: () => false
    });
    expect(view.querySelectorAll('.rich-card')).toHaveLength(2);
    expect(view.querySelectorAll('.rich-image-slot')).toHaveLength(2);
    expect(view.querySelectorAll('.rich-table, .rich-diagram')).toHaveLength(2);
    const table = view.querySelector<HTMLElement>('.rich-table')!;
    const diagram = view.querySelector<HTMLElement>('.rich-diagram')!;
    expect(table.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(table.querySelectorAll('[role="cell"]')).toHaveLength(24);
    expect(diagram.querySelectorAll('[data-rich-node-id^="diagram-node-"]')).toHaveLength(12);
    for (const region of [table, diagram]) {
      expect(region.getAttribute('role')).toBe('region');
      expect(region.getAttribute('aria-label')).toContain('scroll horizontally');
      expect(region.tabIndex).toBe(0);
    }
    // Structural and focus tests do not measure physical scrollWidth or Electron layout.
    expect(view.querySelectorAll('.rich-control[aria-disabled="true"]')).toHaveLength(3);
    // The recorded Continue is visibly rendered as an inert disabled button;
    // no live image source, enabled action, executable node or raw DIL is exposed.
    expect(view.querySelectorAll('button:disabled')).toHaveLength(1);
    expect(view.querySelector('img[src], button:not(:disabled), script, text')).toBeNull();
    expect(view.textContent).not.toContain('<text>untrusted source</text>');
    // Metadata-only pixels and a stored selection are not proof of current native input.
    expect(view.textContent).toContain('Image preview is loading');
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
});

it('persists a single generated image, a two-asset gallery and an image-only final as exact native rows', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const single = randomUUID(), gallery = randomUUID(), imageOnly = randomUUID();
  const first = { kind: 'native_image' as const, source: 'extension' as const,
    providerRole: 'tool' as const, providerChannel: 'final' as const,
    providerStatus: 'finished_successfully' as const, width: 4, height: 3,
    previewWidth: 4, previewHeight: 3 };
  const pending = await upsertNativeImageEvent(session.id, {
    ...first, time: 100, messageId: single, providerAssetId: 'file_single', previewStatus: 'pending'
  });
  expect(pending.accepted).toBe(true);
  const fixtures = [
    { messageId: single, providerAssetId: 'file_single', color: '#335577' },
    { messageId: gallery, providerAssetId: 'file_gallery_one', color: '#557733' },
    { messageId: gallery, providerAssetId: 'file_gallery_two', color: '#773355' },
    { messageId: imageOnly, providerAssetId: 'file_image_only', color: '#224466' }
  ];
  const expected = new Map<string, Buffer>();
  for (const [index, fixture] of fixtures.entries()) {
    const pixels = await sharp({ create: { width: 4, height: 3, channels: 3,
      background: fixture.color } }).webp().toBuffer();
    const asset = await writeAsset(session.id, pixels, 'image/webp');
    expected.set(asset.id, pixels);
    const result = await upsertNativeImageEvent(session.id, {
      ...first, time: 101 + index, messageId: fixture.messageId,
      providerAssetId: fixture.providerAssetId, previewStatus: 'available', asset
    });
    expect(result.accepted).toBe(true);
    expect(result.event).toMatchObject({ messageId: fixture.messageId,
      providerAssetId: fixture.providerAssetId, previewStatus: 'available', asset });
  }
  await flushSessions();
  resetSessionStoreForTests();
  const rows = (await readEvents(session.id)).filter(row => row.kind === 'native_image');
  expect(rows).toHaveLength(4); // Pending → available updated the same exact single-image tuple.
  expect(rows.filter(row => row.messageId === single)).toHaveLength(1);
  expect(rows.filter(row => row.messageId === gallery)).toHaveLength(2);
  expect(rows.filter(row => row.messageId === imageOnly)).toHaveLength(1);
  expect((await readEvents(session.id)).filter(row => row.kind === 'assistant_message' &&
    row.messageId === imageOnly)).toHaveLength(0); // No invented caption or text row.
  for (const row of rows) {
    if (row.kind !== 'native_image' || !row.asset) throw Error('Missing native image preview');
    expect(await readAsset(session.id, row.asset.id)).toEqual(expected.get(row.asset.id));
  }
});

it('renders available, pending and unsupported inline previews without inventing originals or unknown components', () => {
  const rich: RichResponse = {
    version: 1, status: 'available', reason: null, conversationId: randomUUID(),
    messageId: 'assistant:fixture:three-inline-images', providerMessageId: randomUUID(),
    revision: 1, accessibleText: 'Three reference images',
    nodes: [
      { id: 'saved', kind: 'image', mediaId: 'media-saved', alt: 'Saved Forest', width: 320, height: 180 },
      { id: 'loading', kind: 'image', mediaId: 'media-loading', alt: 'Loading Coast', width: 320, height: 180 },
      { id: 'unsupported', kind: 'image', mediaId: 'media-unsupported', alt: 'Unsupported Desert', width: 320, height: 180 }
    ]
  };
  const media = [
    { mediaId: 'media-saved', nodeId: 'saved', source: { kind: 'page' as const, nodeId: 'saved' },
      status: 'available' as const, previewWidth: 320, previewHeight: 180,
      asset: { id: 'abcdef12.bin', mimeType: 'image/webp', bytes: 12 } },
    { mediaId: 'media-loading', nodeId: 'loading', source: { kind: 'page' as const, nodeId: 'loading' },
      status: 'pending' as const },
    { mediaId: 'media-unsupported', nodeId: 'unsupported', source: { kind: 'page' as const, nodeId: 'unsupported' },
      status: 'unavailable' as const, reason: 'unsupported' as const }
  ];
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  try {
    const view = renderRichResponse(rich, '<bad-raw-component/>', {
      sessionId: '2026-09-02-test0001', media, current: () => false
    });
    expect(view.querySelectorAll('.rich-image-slot')).toHaveLength(3);
    expect(view.querySelector('[data-rich-node-id="saved"]')?.textContent).toContain('Saved preview');
    expect(view.querySelector('[data-rich-node-id="saved"] button')?.textContent).toBe('View saved preview');
    expect(view.querySelector('[data-rich-node-id="loading"]')?.textContent).toContain('Image preview is loading');
    expect(view.querySelector('[data-rich-node-id="unsupported"]')?.textContent).toContain('unsupported source');
    expect(view.querySelector('img[src], a[href], script')).toBeNull();
    expect(view.textContent).not.toContain('<bad-raw-component/>');

    const unknown = { ...rich, nodes: [{ id: 'unknown', kind: 'provider-executable', code: 'alert(1)' }] } as unknown as RichResponse;
    const fallback = renderRichResponse(unknown, '<untrusted provider component/>');
    expect(fallback.classList.contains('rich-unavailable')).toBe(true);
    expect(fallback.querySelector('.rich-unavailable-label')?.textContent).toContain('open original in ChatGPT');
    expect(fallback.querySelector('button, img, script, a[href]')).toBeNull();
    expect(fallback.querySelector('details pre')?.textContent).toBe('<untrusted provider component/>');
    expect(fallback.querySelector('.rich-unavailable-label')?.textContent).not.toContain('untrusted provider component');
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
  }
});

// A local test may supply the internal bridge handoff to exercise recorder/storage races.
// This fixture is NOT evidence of a real Chrome sender or a bridge-issued ticket.
function richObservation(conversationId: string, messageId: string, providerMessageId: string,
  content = 'Choice projection', withText = false): ChatObservation {
  return {
    kind: 'assistant_message', time: 200, messageId, providerMessageId,
    ...(withText ? { text: 'Original authored prose', state: 'streaming' as const } : { richOnly: true }),
    rich: {
      version: 1, status: 'available', reason: null, conversationId, messageId,
      providerMessageId, revision: 15, accessibleText: content,
      nodes: [{ id: 'choice-text', kind: 'text', style: 'body', text: content }]
    }
  };
}

function bridgeProof(item: ChatObservation, sessionId: string,
  options: { bindingRevision?: number; navigationEpoch?: number; documentId?: string;
    generation?: string; revision?: number; expiresAt?: number; messageId?: string;
    providerMessageId?: string; captureId?: string } = {}): WeakMap<ChatObservation, VerifiedRichObservation> {
  const captureId = options.captureId ?? randomBytes(24).toString('base64url');
  const generation = options.generation ?? recordingGenerationGrant();
  if (!generation || !item.messageId || !item.providerMessageId || !item.rich)
    throw new Error('Fixture requires an On generation and exact assistant identity');
  const ticket = Object.freeze({
    captureId, conversationId: item.rich.conversationId, sessionId,
    bindingRevision: options.bindingRevision ?? 0, tab: 10,
    documentId: options.documentId ?? 'document-a', documentGeneration: 1,
    spaEpoch: options.navigationEpoch ?? 1, recordingGeneration: generation,
    recordingRevision: options.revision ?? getRecordingRevision(),
    expiresAt: options.expiresAt ?? Date.now() + 60_000
  });
  const seal = Object.freeze({ captureId, scanToken: 'fresh-scan-token',
    messageId: options.messageId ?? item.messageId,
    providerMessageId: options.providerMessageId ?? item.providerMessageId });
  const proof = Object.freeze({ rawIndex: 0, observation: item, ticket, seal,
    isTicketLive: () => true, expectedRecordingRevision: ticket.recordingRevision });
  return new WeakMap([[item, proof]]);
}

const canonicalAssistant = (messageId: string, providerMessageId: string) => ({
  kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
  messageId, providerMessageId, message: text('Original authored prose'),
  state: 'streaming' as const, final: false, turnId: 'original-turn'
});

it('refuses body-supplied rich and an unknown rich-only chat without first-sight side effects', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000000';
  const rawId = randomUUID();
  const forged = { ...richObservation(conversationId, messageId, rawId),
    richOrigin: { conversationId, bindingRevision: 0, documentId: 'document-a', navigationEpoch: 1 },
    captureId: randomBytes(24).toString('base64url') } as ChatObservation;
  expect(await recordRichObservation(conversationId, forged)).toBe('refused');
  expect(await recordChatObservations(conversationId, [forged])).toMatchObject({
    sessionId: null, stored: 0, goalCandidates: [], committedObservations: []
  });
  expect(await fs.readdir(sessionsRoot()).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  })).toEqual([]);

  const known = await createSession({ conversationId });
  const trustedFixture = bridgeProof(forged, known.id);
  expect(await recordVerifiedChatObservations(conversationId, [forged], null, trustedFixture)).toMatchObject({
    sessionId: null, stored: 0, goalCandidates: [], committedObservations: []
  });
  expect((await readEvents(known.id)).filter(event => event.kind === 'assistant_message')).toEqual([]);
});

it('stores verified rich-only presentation on one existing assistant shard without advancing original work or Goal', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000001';
  const rawId = randomUUID();
  const session = await createSession({ conversationId });
  const original = await upsertMessageEvent(session.id, canonicalAssistant(messageId, rawId));
  const observation = richObservation(conversationId, messageId, rawId);
  const verified = bridgeProof(observation, session.id);
  const accepted = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(accepted).toMatchObject({ sessionId: session.id, stored: 1,
    presentationOnly: true, goalCandidates: [], committedObservations: [],
    activity: { meaningful: false, working: false, terminal: false } });
  const [row] = (await readEvents(session.id)).filter(event => event.kind === 'assistant_message');
  expect(row).toMatchObject({ messageId, providerMessageId: rawId,
    message: text('Original authored prose'), turnId: 'original-turn',
    origin: original.event.origin, contentSeq: original.event.contentSeq,
    rich: { accessibleText: 'Choice projection', revision: 1 },
    richOrigin: { conversationId, bindingRevision: 0, documentId: 'document-a', navigationEpoch: 1 } });
  if (!row || row.kind !== 'assistant_message') throw new Error('Exact canonical assistant missing');
  expect(row.finalContentSeq).toBe(original.event.kind === 'assistant_message'
    ? original.event.finalContentSeq : undefined);
  expect((await readEvents(session.id)).filter(event => event.kind === 'assistant_message')).toHaveLength(1);
  const replay = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(replay.stored).toBe(0);
  expect(replay.committedObservations).toEqual([]);
  expect((await readEvents(session.id)).filter(event => event.kind === 'assistant_message')).toHaveLength(1);
});

it('atomically seeds exact inert page-image slots only for a private verified rich recorder write', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000059';
  const providerMessageId = randomUUID();
  const session = await createSession({ conversationId });
  const original = await upsertMessageEvent(session.id, canonicalAssistant(messageId, providerMessageId));
  const before = await getSession(session.id);
  const observation = richObservation(conversationId, messageId, providerMessageId);
  observation.rich = {
    ...observation.rich!, nodes: [{ kind: 'group', id: 'image-card', layout: 'card', children: [
      { kind: 'image', id: 'exact-reference-image', mediaId: 'exact-reference-media',
        alt: 'The observed reference', width: 640, height: 480 }
    ] }]
  };
  const verified = bridgeProof(observation, session.id);
  const accepted = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(accepted).toMatchObject({ sessionId: session.id, stored: 1,
    presentationOnly: true, goalCandidates: [], committedObservations: [],
    activity: { meaningful: false, working: false, terminal: false } });
  const expected = { mediaId: 'exact-reference-media', nodeId: 'exact-reference-image',
    source: { kind: 'page', nodeId: 'exact-reference-image' },
    status: 'pending', reason: 'not_loaded' };
  const assistant = (await readEvents(session.id)).filter(row => row.kind === 'assistant_message');
  expect(assistant).toHaveLength(1);
  expect(assistant[0]).toMatchObject({ messageId, providerMessageId,
    message: text('Original authored prose'), origin: original.event.origin,
    contentSeq: original.event.contentSeq, rich: { revision: 1 }, richMedia: [expected] });
  expect((await readEvents(session.id)).filter(row => row.kind === 'native_image')).toEqual([]);
  expect(await fs.readdir(path.join(sessionsRoot(), session.id, 'assets')).catch(() => [])).toEqual([]);
  expect(await getSession(session.id)).toMatchObject({
    events: before?.events, estimatedTokens: before?.estimatedTokens,
    contextTokens: before?.contextTokens, lastAssistantFinalAt: before?.lastAssistantFinalAt,
    updatedAt: before?.updatedAt
  });
  const replay = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(replay.stored).toBe(0);
  await flushSessions(); resetSessionStoreForTests();
  const afterReload = (await readEvents(session.id)).filter(row => row.kind === 'assistant_message');
  expect(afterReload).toHaveLength(1);
  expect(afterReload[0]).toMatchObject({ rich: { revision: 1 }, richMedia: [expected],
    message: text('Original authored prose'), origin: original.event.origin });
});

it('counts actual physical mixed prose and rich revisions separately without inventing a second assistant', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000007';
  const rawId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const observation = richObservation(conversationId, messageId, rawId, 'Extra layout', true);
  const verified = bridgeProof(observation, sessionId!);
  const accepted = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(accepted.stored).toBe(2);
  expect(accepted.committedObservations).toEqual([observation]);
  expect(accepted.goalCandidates).toEqual([]);
  const rows = (await readEvents(sessionId!)).filter(event => event.kind === 'assistant_message');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ messageId, providerMessageId: rawId,
    message: text('Original authored prose'), rich: { accessibleText: 'Extra layout', revision: 1 } });
  const replay = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
  expect(replay.stored).toBe(0);
  expect((await readEvents(sessionId!)).filter(event => event.kind === 'assistant_message')).toHaveLength(1);
});

it('marks a mixed replay with unchanged prose and newly stored rich as presentation-only', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000009';
  const rawId = randomUUID();
  const session = await createSession({ conversationId });
  await upsertMessageEvent(session.id, canonicalAssistant(messageId, rawId));
  const observation = richObservation(conversationId, messageId, rawId, 'Late layout', true);
  const accepted = await recordVerifiedChatObservations(conversationId, [observation], null,
    bridgeProof(observation, session.id));
  expect(accepted).toMatchObject({ sessionId: session.id, stored: 1,
    presentationOnly: true, goalCandidates: [], committedObservations: [],
    activity: { meaningful: false, working: false, terminal: false } });
  expect((await readEvents(session.id)).filter(event => event.kind === 'assistant_message')).toMatchObject([
    { messageId, message: text('Original authored prose'), rich: { accessibleText: 'Late layout' } }
  ]);
});

it('commits canonical mixed prose before optional rich and preserves that disk prefix across Recording Off', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000002';
  const rawId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const observation = richObservation(conversationId, messageId, rawId, 'Optional after prose', true);
  const verified = bridgeProof(observation, sessionId!);
  const shard = path.join(sessionsRoot(), sessionId!, 'messages',
    `${createHash('sha256').update(`assistant_message\u0000${messageId}`).digest('hex')}.json`);
  const gate = gateRename(shard);
  let recording: ReturnType<typeof recordVerifiedChatObservations> | null = null;
  let saving: Promise<void> | null = null;
  try {
    recording = recordVerifiedChatObservations(conversationId, [observation], null, verified);
    await gate.reached;
    saving = off();
    await vi.waitFor(() => expect(recordingWriteAllowed(getRecordingRevision())).toBe(false));
    gate.release();
    await saving;
    const accepted = await recording;
    expect(accepted).toMatchObject({ sessionId, stored: 1, committedObservations: [observation] });
    const rows = (await readEvents(sessionId!)).filter(event => event.kind === 'assistant_message');
    expect(rows).toMatchObject([{ messageId, message: text('Original authored prose') }]);
    expect(rows[0]).not.toHaveProperty('rich');
    expect((await fs.stat(shard)).isFile()).toBe(true);
    await on();
    // The old ticket's original G/revision never becomes a fresh recording admission.
    const replay = await recordVerifiedChatObservations(conversationId, [observation], null, verified);
    expect(replay.stored).toBe(0);
    expect((await readEvents(sessionId!)).filter(event => event.kind === 'assistant_message')).toHaveLength(1);
  } finally {
    gate.release();
    await Promise.allSettled([recording, saving].filter(pending => pending !== null));
    gate.restore();
  }
});

it('refuses duplicate raw ownership and stale A→B→A binding but accepts a fresh revision', async () => {
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000003';
  const rawId = randomUUID();
  const session = await createSession({ conversationId: conversationA });
  await upsertMessageEvent(session.id, canonicalAssistant(messageId, rawId));
  const original = richObservation(conversationA, messageId, rawId);
  const initialProof = bridgeProof(original, session.id);
  await upsertMessageEvent(session.id, canonicalAssistant('assistant:duplicate:1789552000004', randomUUID()));
  await upsertMessageEvent(session.id, canonicalAssistant('assistant:duplicate:1789552000004', rawId));
  expect((await recordVerifiedChatObservations(conversationA, [original], null, initialProof)).stored).toBe(0);
  expect((await readEvents(session.id)).some(event => event.kind === 'assistant_message' && event.rich)).toBe(false);
  await upsertMessageEvent(session.id, { ...canonicalAssistant('assistant:duplicate:1789552000004', randomUUID()) });
  expect(await rebindSession(session.id, conversationA, conversationB)).toBe(true);
  expect(await rebindSession(session.id, conversationB, conversationA)).toBe(true);
  expect((await recordVerifiedChatObservations(conversationA, [original], null, initialProof)).stored).toBe(0);
  const fresh = richObservation(conversationA, messageId, rawId, 'Fresh after return');
  const accepted = await recordVerifiedChatObservations(conversationA, [fresh], null,
    bridgeProof(fresh, session.id, { bindingRevision: 2, documentId: 'document-return', navigationEpoch: 3 }));
  expect(accepted.stored).toBe(1);
  const [row] = (await readEvents(session.id)).filter(event => event.kind === 'assistant_message' && event.messageId === messageId);
  expect(row).toMatchObject({ rich: { accessibleText: 'Fresh after return' },
    richOrigin: { conversationId: conversationA, bindingRevision: 2, documentId: 'document-return', navigationEpoch: 3 } });
  expect((await recordVerifiedChatObservations(conversationA, [original], null, initialProof)).stored).toBe(0);
});

it('requires the ticket to name the one uniquely current attached session', async () => {
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000006';
  const providerMessageId = randomUUID();
  const owner = await createSession({ conversationId: conversationA });
  const foreign = await createSession({ conversationId: conversationB });
  await upsertMessageEvent(owner.id, canonicalAssistant(messageId, providerMessageId));
  const observation = richObservation(conversationA, messageId, providerMessageId);
  expect((await recordVerifiedChatObservations(conversationA, [observation], null,
    bridgeProof(observation, foreign.id))).stored).toBe(0);
  await createSession({ conversationId: conversationA });
  expect((await recordVerifiedChatObservations(conversationA, [observation], null,
    bridgeProof(observation, owner.id))).stored).toBe(0);
  expect((await readEvents(owner.id)).some(event => event.kind === 'assistant_message' && event.rich)).toBe(false);
});

it('refuses verified rich while an attachment move has not published its durable result', async () => {
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000008';
  const rawId = randomUUID();
  const session = await createSession({ conversationId: conversationA });
  await upsertMessageEvent(session.id, canonicalAssistant(messageId, rawId));
  const observation = richObservation(conversationA, messageId, rawId);
  const proof = bridgeProof(observation, session.id);
  const gate = gateRename(path.join(sessionsRoot(), session.id, 'meta.json'));
  let moving: ReturnType<typeof rebindSession> | null = null;
  let recording: ReturnType<typeof recordVerifiedChatObservations> | null = null;
  try {
    moving = rebindSession(session.id, conversationA, conversationB);
    await gate.reached;
    // The recorder must refuse immediately on the pending admission latch; waiting
    // for this blocked store queue would let an old A ticket race publication.
    recording = recordVerifiedChatObservations(conversationA, [observation], null, proof);
    const result = await Promise.race([
      recording,
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 150))
    ]);
    expect(result).not.toBe('blocked');
    expect(result).toMatchObject({ sessionId: null, stored: 0, committedObservations: [] });
    gate.release();
    expect(await moving).toBe(true);
    expect((await readEvents(session.id)).some(event => event.kind === 'assistant_message' && event.rich)).toBe(false);
  } finally {
    gate.release();
    await Promise.allSettled([moving, recording].filter(pending => pending !== null));
    gate.restore();
  }
});

it('rejects mismatched proof identity, sealed provider, expiry and old G after Off→On', async () => {
  const conversationId = randomUUID();
  const messageId = 'assistant:working:exchange:1789552000005';
  const rawId = randomUUID();
  const session = await createSession({ conversationId });
  await upsertMessageEvent(session.id, canonicalAssistant(messageId, rawId));
  const item = richObservation(conversationId, messageId, rawId);
  const valid = bridgeProof(item, session.id);
  const copied = { ...item };
  expect((await recordVerifiedChatObservations(conversationId, [copied], null, valid)).stored).toBe(0);
  expect((await recordVerifiedChatObservations(conversationId, [item], null,
    bridgeProof(item, session.id, { providerMessageId: randomUUID() }))).stored).toBe(0);
  expect((await recordVerifiedChatObservations(conversationId, [item], null,
    bridgeProof(item, session.id, { messageId: 'assistant:other:1789552000005' }))).stored).toBe(0);
  expect((await recordVerifiedChatObservations(conversationId, [item], null,
    bridgeProof(item, session.id, { expiresAt: Date.now() - 1 }))).stored).toBe(0);
  await off();
  await on();
  expect((await recordVerifiedChatObservations(conversationId, [item], null, valid)).stored).toBe(0);
  expect((await readEvents(session.id)).some(event => event.kind === 'assistant_message' && event.rich)).toBe(false);
});

it('refuses a second canonical user and assistant queued before the persisted Off transition', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const queuedUser = upsertMessageEvent(session.id, message('after-off'));
    const queuedAssistant = upsertMessageEvent(session.id, {
      kind: 'assistant_message', source: 'extension', messageId: 'assistant-after-off', time: 102,
      message: text('private assistant prose'), final: true
    });
    void queuedUser.catch(() => undefined);
    void queuedAssistant.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    expect(getConfig().sessions.record).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    gate.release();
    await disabling.saved;
    await baseline;
    expect((await fs.stat(shard)).isFile()).toBe(true);
    await expect(queuedUser).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    await expect(queuedAssistant).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind.endsWith('_message'))).toMatchObject([
      { kind: 'user_message', messageId: 'baseline' }
    ]);
  } finally { gate.release(); gate.restore(); }
});

it('refuses queued native image metadata after Off without creating its canonical shard', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const pending = upsertNativeImageEvent(session.id, { kind: 'native_image', source: 'extension', time: 101,
      messageId: 'native-after-off', providerAssetId: 'file_native_after_off', providerRole: 'tool',
      providerStatus: 'finished_successfully', previewStatus: 'pending' });
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'native_image')).toHaveLength(0);
  } finally { gate.release(); gate.restore(); }
});

it('does not revive an old queued transcript write when Recording is switched Off then On before its queue runs', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const pending = upsertMessageEvent(session.id, message('old-epoch'));
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await on();
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
    await upsertMessageEvent(session.id, message('new-epoch'));
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(2);
  } finally { gate.release(); gate.restore(); }
});

it('refuses a journal transcript row queued before Off while preserving the preceding committed row', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const journal = path.join(sessionsRoot(), session.id, 'events.jsonl');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = fs.appendFile.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'appendFile').mockImplementation((async (name, ...args) => {
    if (!held && String(name) === journal) { held = true; entered(); await gate; }
    return (append as (...args: unknown[]) => Promise<void>)(name, ...args);
  }) as typeof fs.appendFile);
  try {
    const baseline = appendEvent(session.id, { source: 'extension', kind: 'turn_start', time: 100, turnId: 'prior' });
    await reached;
    const pending = appendEvent(session.id, { source: 'extension', kind: 'turn_start', time: 101, turnId: 'after-off' });
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    await baseline;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    expect((await readEvents(session.id)).filter(event => event.kind === 'turn_start').map(event => event.turnId)).toEqual(['prior']);
  } finally { release(); spy.mockRestore(); }
});

it('refuses a direct image asset queued before Off without modifying quota or creating pixels', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const firstBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#113355' } }).png().toBuffer();
  const nextBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#994433' } }).png().toBuffer();
  const firstId = `${createHash('sha256').update(firstBytes).digest('hex').slice(0, 32)}.png`;
  const nextId = `${createHash('sha256').update(nextBytes).digest('hex').slice(0, 32)}.png`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const write = fs.writeFile.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (name, ...args) => {
    // writeAsset stages a private .<hash>.<pid>.<nonce>.tmp before atomic hard-link
    // publication. Holding the final hash filename waits forever and never exercises Off.
    if (!held && String(name).startsWith(path.join(sessionsRoot(), session.id, 'assets', `.${firstId}.`)) &&
        String(name).endsWith('.tmp')) { held = true; entered(); await gate; }
    return (write as (...args: unknown[]) => Promise<void>)(name, ...args);
  }) as typeof fs.writeFile);
  try {
    const first = writeAsset(session.id, firstBytes, 'image/png');
    await reached;
    const pending = writeAsset(session.id, nextBytes, 'image/png');
    void pending.catch(() => undefined);
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    await first;
    await expect(pending).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    await expect(fs.stat(path.join(sessionsRoot(), session.id, 'assets', nextId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await getImageStorage()).usedBytes).toBe(firstBytes.length);
  } finally { release(); spy.mockRestore(); }
});

it('acknowledges an input receipt without a fabricated anchor if its first row waits beyond Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    const anchors: number[] = [];
    const pending = recordDeliveredInput({ id: 'receipt-after-off', sessionId: session.id, state: 'sent',
      messageId: 'input:receipt-after-off', deliveredAt: 200, text: 'private receipt' } as InputEntry,
    seq => anchors.push(seq));
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    expect(await pending).toBe(true);
    expect(anchors).toEqual([]);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { gate.release(); gate.restore(); }
});

it('durably settles a sent outbox receipt suppressed at Off without an anchor or later On backfill', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const row: InputEntry = {
    id: randomUUID(), sessionId: session.id, text: 'sent before disabled recording',
    mode: 'auto', model: null, reasoningEffort: null, dueAt: 100, createdAt: 100,
    state: 'sent', owner: null, conversationId: session.conversationId,
    messageId: 'input:privacy-receipt', deliveredAt: 200, historyRecorded: false
  };
  const shard = path.join(sessionsRoot(), session.id, 'messages',
    `${createHash('sha256').update('user_message\u0000baseline').digest('hex')}.json`);
  const gate = gateRename(shard);
  try {
    const baseline = upsertMessageEvent(session.id, message('baseline'));
    await gate.reached;
    await writeDurableNow('session-input', [row]);
    let entered!: () => void;
    const invoked = new Promise<void>(resolve => { entered = resolve; });
    configureInputDelivery({
      recordDelivered: (entry, anchor) => { entered(); return recordDeliveredInput(entry, anchor); },
      changed: () => {}, applyAutomation: async () => {}
    });
    const reconciling = listInputs();
    await invoked;
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    gate.release();
    await disabling.saved;
    await baseline;
    expect(await reconciling).toMatchObject([{ historyRecorded: true }]);
    expect((await readDurable<InputEntry[]>('session-input'))).toMatchObject([{ historyRecorded: true }]);
    expect((await readDurable<InputEntry[]>('session-input'))![0]?.historyAnchored).not.toBe(true);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
    await on();
    expect(await listInputs()).toMatchObject([{ historyRecorded: true }]);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { gate.release(); gate.restore(); }
});

it('keeps previously committed input text but suppresses its preview after Off during Sharp', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#227755' } }).webp().toBuffer();
  const assetId = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.bin`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stats = sharp.prototype.stats;
  let held = false;
  const spy = vi.spyOn(sharp.prototype, 'stats').mockImplementation(async function (this: ReturnType<typeof sharp>, ...args: Parameters<typeof stats>) {
    if (!held) { held = true; entered(); await gate; }
    return stats.apply(this, args);
  });
  try {
    const anchors: number[] = [];
    const receipt: InputEntry = { id: 'receipt-text-only', sessionId: session.id, state: 'sent',
      messageId: 'input:receipt-text-only', deliveredAt: 200, text: 'keep committed text',
      images: [{ name: 'privacy.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] } as InputEntry;
    const pending = recordDeliveredInput(receipt, seq => anchors.push(seq));
    await reached;
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    expect(await pending).toBe(true);
    expect(anchors).toHaveLength(1);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toMatchObject([
      { messageId: 'input:receipt-text-only', assets: undefined }
    ]);
    await expect(fs.stat(path.join(sessionsRoot(), session.id, 'assets', assetId))).rejects.toMatchObject({ code: 'ENOENT' });
    await on();
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(1);
  } finally { release(); spy.mockRestore(); }
});

it('does not enrich an existing native image after Off during Sharp decode', async () => {
  const conversationId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const data = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123987' } }).webp().toBuffer();
  const assetId = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.bin`;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stats = sharp.prototype.stats;
  let held = false;
  const spy = vi.spyOn(sharp.prototype, 'stats').mockImplementation(async function (this: ReturnType<typeof sharp>, ...args: Parameters<typeof stats>) {
    if (!held) { held = true; entered(); await gate; }
    return stats.apply(this, args);
  });
  try {
    const pending = recordChatObservations(conversationId, [{ kind: 'native_image', time: 200,
      messageId: randomUUID(), providerAssetId: 'file_privacy_image', providerRole: 'tool',
      providerStatus: 'finished_successfully', previewStatus: 'available', previewWidth: 4, previewHeight: 3,
      previewDataUrl: `data:image/webp;base64,${data.toString('base64')}` }]);
    await reached;
    expect((await readEvents(sessionId!, { kinds: ['native_image'] })).at(0)).toMatchObject({ previewStatus: 'pending' });
    const disabling = beginOffBehindWriter();
    await disabling.closing;
    release();
    await disabling.saved;
    expect((await pending).stored).toBe(1);
    expect((await readEvents(sessionId!, { kinds: ['native_image'] })).at(0)).toMatchObject({ previewStatus: 'pending', asset: undefined });
    await expect(fs.stat(path.join(sessionsRoot(), sessionId!, 'assets', assetId))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); spy.mockRestore(); }
});

it('keeps pre-Off image history readable and permits explicit owner retirement and cleanup while Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#335599' } }).png().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/png');
  await upsertMessageEvent(session.id, { ...message('historical-image'), assets: [asset] });
  await off();
  expect(await readRecordedSessionImage(session.id, asset.id)).toBe(`data:image/png;base64,${pixels.toString('base64')}`);
  expect(await clearImageStorage('all')).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });
  expect(await readAsset(session.id, asset.id)).toBeNull();
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message')).toMatchObject({
    retiredImageAssetIds: [asset.id], assets: undefined
  });
});

it('retains durable handoff control markers while transcript recording is Off', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  await off();
  await appendEvent(session.id, {
    source: 'app', kind: 'handoff', time: 200, handoffId: 'handoff-privacy', chars: 24, reason: 'compaction'
  });
  expect((await readEvents(session.id)).filter(event => event.kind === 'handoff')).toMatchObject([
    { handoffId: 'handoff-privacy' }
  ]);
});

it('does not acknowledge Recording Off while an already-started asset write can still create pixels', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const pixels = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#aa3355' } }).png().toBuffer();
  const assetId = `${createHash('sha256').update(pixels).digest('hex').slice(0, 32)}.png`;
  const target = path.join(sessionsRoot(), session.id, 'assets', assetId);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, ...args) => {
    // The physical in-flight write targets a private staging file; the stable hash
    // path appears only after fs.link publishes that completed staging inode.
    if (String(file).startsWith(path.join(path.dirname(target), `.${assetId}.`)) &&
        String(file).endsWith('.tmp')) { entered(); await gate; }
    return (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
  }) as typeof fs.writeFile);
  let assetWrite: Promise<unknown> | null = null;
  let offSave: Promise<unknown> | null = null;
  try {
    assetWrite = writeAsset(session.id, pixels, 'image/png');
    await reached;
    offSave = off();
    // An independent config rename used to resolve while this physical write was held.
    // The Off acknowledgement must now wait for the original owner to leave that write.
    const acknowledgedBeforeRelease = await Promise.race([
      offSave.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 150))
    ]);
    release();
    await assetWrite;
    await offSave;
    expect(acknowledgedBeforeRelease).toBe(false);
    expect((await fs.stat(target)).size).toBe(pixels.length);
  } finally {
    release();
    await Promise.allSettled([assetWrite, offSave].filter((promise): promise is Promise<unknown> => promise !== null));
    spy.mockRestore();
  }
});

it('does not acknowledge Recording Off while first-sight recording creates a session outside writer queues', async () => {
  const conversationId = randomUUID();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = fs.writeFile.bind(fs);
  let blocked = false;
  let firstSightWriteSettled = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, ...args) => {
    if (!blocked && String(file).endsWith(path.join('messages.json'))) {
      blocked = true;
      entered();
      await gate;
      const result = await (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
      firstSightWriteSettled = true;
      return result;
    }
    return (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
  }) as typeof fs.writeFile);
  let creating: Promise<string | null> | null = null;
  let saving: Promise<void> | null = null;
  try {
    creating = sessionForConversation(conversationId);
    void creating.catch(() => undefined);
    await reached;
    saving = off();
    await vi.waitFor(() => expect(recordingWriteAllowed(getRecordingRevision())).toBe(false));
    const acknowledgedBeforeRelease = await Promise.race([
      saving.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 150))
    ]);
    expect(acknowledgedBeforeRelease).toBe(false);
    await expect(sessionForConversation(randomUUID())).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    release();
    await saving;
    expect(firstSightWriteSettled).toBe(true);
    await expect(creating).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    const sessions = await fs.readdir(sessionsRoot());
    expect(sessions).toHaveLength(1);
    // Session creation began while On; its later session_start must not append after Off.
    expect(await fs.readFile(path.join(sessionsRoot(), sessions[0]!, 'events.jsonl'), 'utf8')).toBe('');
    expect(await readEvents(sessions[0]!)).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([creating, saving].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('rejects a stalled first-sight physical writer at the 15-second Off drain deadline without publishing Off', async () => {
  const revision = getRecordingRevision();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = fs.writeFile.bind(fs);
  let held = false;
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation((async (file, ...args) => {
    if (!held && String(file).endsWith(path.join('messages.json'))) {
      held = true;
      entered();
      await gate;
    }
    return (originalWrite as (...args: unknown[]) => Promise<void>)(file, ...args);
  }) as typeof fs.writeFile);
  let creating: Promise<string | null> | null = null;
  let disabling: Promise<void> | null = null;
  let queuedOn: Promise<unknown> | null = null;
  try {
    creating = sessionForConversation(randomUUID());
    void creating.catch(() => undefined);
    await reached;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    disabling = off();
    void disabling.catch(() => undefined);
    queuedOn = on();
    for (let attempt = 0; attempt < 30 && recordingWriteAllowed(revision); attempt++) await Promise.resolve();
    expect(recordingWriteAllowed(revision)).toBe(false);
    let finished = false;
    void disabling.finally(() => { finished = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(finished).toBe(false);
    expect(getConfig().sessions.record).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(disabling).rejects.toThrow('Recording Off could not settle active writes');
    await queuedOn;
    expect(getConfig().sessions.record).toBe(true);
    expect(getRecordingRevision()).toBe(revision);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    release();
    expect(await creating).toBeTruthy();
    expect(getConfig().sessions.record).toBe(true);
  } finally {
    release();
    vi.useRealTimers();
    await Promise.allSettled([creating, disabling, queuedOn].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('flushes a pre-Off dirty session summary before acknowledging Off and leaves no delayed metadata writer', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const meta = path.join(sessionsRoot(), session.id, 'meta.json');
  const originalRename = fs.rename.bind(fs);
  let acknowledged = false;
  let lateMetaWrites = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (acknowledged && String(to) === meta) lateMetaWrites++;
    return originalRename(from, to);
  }) as typeof fs.rename);
  try {
    await appendEvent(session.id, { kind: 'turn_start', source: 'extension', time: 100, turnId: 'pre-off' });
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(0);
    await off();
    acknowledged = true;
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 1650));
    expect(lateMetaWrites).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('rejects Off on a metadata checkpoint EIO and retries the dirty summary before any later Off acknowledgement', async () => {
  const session = await createSession({ conversationId: randomUUID() });
  const meta = path.join(sessionsRoot(), session.id, 'meta.json');
  await appendEvent(session.id, { kind: 'turn_start', source: 'extension', time: 100, turnId: 'checkpoint-eio' });
  const priorRevision = getRecordingRevision();
  const rename = fs.rename.bind(fs);
  let failOnce = true;
  let acknowledged = false;
  let writesAfterAck = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to) === meta) {
      if (acknowledged) writesAfterAck++;
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('Metadata checkpoint EIO'), { code: 'EIO' });
      }
    }
    return rename(from, to);
  }) as typeof fs.rename);
  try {
    await expect(off()).rejects.toThrow('Metadata checkpoint EIO');
    expect(getConfig().sessions.record).toBe(true);
    expect(getRecordingRevision()).toBe(priorRevision);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(0);
    expect((await readEvents(session.id)).some(row => row.kind === 'turn_start' && row.turnId === 'checkpoint-eio')).toBe(true);
    expect(JSON.parse(await fs.readFile(meta, 'utf8')).events).toBe(1);
    await off();
    acknowledged = true;
    await readEvents(session.id);
    expect(writesAfterAck).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('settles all started metadata flushes before rejecting a failed Off', async () => {
  const blocked = await createSession({ conversationId: randomUUID() });
  const failing = await createSession({ conversationId: randomUUID() });
  await appendEvent(blocked.id, { kind: 'turn_start', source: 'extension', time: 100, turnId: 'held-meta' });
  await appendEvent(failing.id, { kind: 'turn_start', source: 'extension', time: 101, turnId: 'failing-meta' });
  const heldTarget = path.join(sessionsRoot(), blocked.id, 'meta.json');
  const failedTarget = path.join(sessionsRoot(), failing.id, 'meta.json');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  let failed = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to) === heldTarget) { entered(); await gate; }
    if (String(to) === failedTarget && !failed) {
      failed = true;
      throw Object.assign(new Error('Second metadata EIO'), { code: 'EIO' });
    }
    return rename(from, to);
  }) as typeof fs.rename);
  let saving: Promise<void> | null = null;
  try {
    saving = off();
    void saving.catch(() => undefined);
    await reached;
    await vi.waitFor(() => expect(failed).toBe(true));
    expect(await Promise.race([saving.then(() => 'resolved', () => 'rejected'),
      new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 100))])).toBe('waiting');
    expect(getConfig().sessions.record).toBe(true);
    release();
    await expect(saving).rejects.toThrow('Second metadata EIO');
    expect(JSON.parse(await fs.readFile(path.join(sessionsRoot(), blocked.id, 'meta.json'), 'utf8')).events).toBe(1);
    expect(getConfig().sessions.record).toBe(true);
  } finally {
    release();
    await Promise.allSettled([saving].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('keeps observations retryable when a pending Recording Off fails to save', async () => {
  const conversationId = randomUUID();
  const sessionId = await sessionForConversation(conversationId);
  expect(sessionId).toBeTruthy();
  const originalRename = fs.rename.bind(fs);
  const target = path.join(directory, 'config.json');
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (String(to) === target) {
      entered();
      await gate;
      throw Object.assign(new Error('Config rename failed'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fs.rename);
  const observation = { kind: 'user_message' as const, time: 200, messageId: randomUUID(), text: 'must survive failed Off' };
  let saving: Promise<void> | null = null;
  let recording: ReturnType<typeof recordChatObservations> | null = null;
  try {
    saving = off();
    void saving.catch(() => undefined);
    await reached;
    expect(getConfig().sessions.record).toBe(true);
    expect(recordingWriteAllowed(getRecordingRevision())).toBe(false);
    recording = recordChatObservations(conversationId, [observation]);
    await expect(recording).rejects.toMatchObject({ code: 'RECORDING_DISABLED' });
    release();
    await expect(saving).rejects.toThrow('Config rename failed');
    expect(getConfig().sessions.record).toBe(true);
    expect((await recordChatObservations(conversationId, [observation])).stored).toBeGreaterThan(0);
    expect((await readEvents(sessionId!)).filter(event => event.kind === 'user_message')).toMatchObject([
      { messageId: observation.messageId, message: text(observation.text) }
    ]);
  } finally {
    release();
    await Promise.allSettled([recording, saving].filter(promise => promise !== null));
    spy.mockRestore();
  }
});

it('retains the committed On setting and reopens recording admission when the Off config rename fails', async () => {
  const originalRename = fs.rename.bind(fs);
  const priorRevision = getRecordingRevision();
  let refused = false;
  const spy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
    if (!refused && String(to) === path.join(directory, 'config.json')) {
      refused = true;
      throw Object.assign(new Error('Config rename failed'), { code: 'EIO' });
    }
    return originalRename(from, to);
  }) as typeof fs.rename);
  try {
    await expect(off()).rejects.toThrow('Config rename failed');
    expect(getConfig().sessions.record).toBe(true);
    expect(getRecordingRevision()).toBe(priorRevision);
    expect(recordingWriteAllowed(priorRevision)).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).sessions.record).toBe(true);
    const session = await createSession({ conversationId: randomUUID() });
    await upsertMessageEvent(session.id, message('recording-still-on'));
    expect((await readEvents(session.id)).some(event => event.kind === 'user_message' &&
      event.messageId === 'recording-still-on')).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
