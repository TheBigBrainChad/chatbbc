import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { getRecordingRevision, pendingRecordingOffDecision, recordingGenerationGrant,
  recordingWriteAllowed } from './config.js';
import { readDurableStrict } from './durable.js';
import { parseRichActionSnapshot, parseRichRetryLedgerSnapshot } from './rich-actions.js';
import { isChatBlocked } from './session/blocked-chats.js';
import { snapshotContinuations } from './session/continuation.js';
import { conversationWasSuperseded, inspectInertRichRetrySource,
  readCanonicalRichMediaRetryEligibility, readWarmRichRetrySession, sessionAttachmentTransitionPending,
  type CanonicalRichMediaRetryEligibility } from './session/store.js';
import { currentUiSelectionFor } from './ui-selection.js';

type RetryAdmissionRequest = Readonly<{
  sessionId: string;
  messageId: string;
  mediaId: string;
  nodeId: string;
  richRevision: number;
}>;

/** A strict five-field value; a copied nonce, caller callback or isTrusted is not consent. */
function parseRequest(input: unknown): RetryAdmissionRequest | null {
  const names = ['sessionId', 'messageId', 'mediaId', 'nodeId', 'richRevision'];
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(input))) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) return null;
    const data: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      data[name] = descriptor.value;
    }
    if (typeof data.sessionId !== 'string' || !/^[0-9a-z-]{8,64}$/i.test(data.sessionId) ||
        typeof data.messageId !== 'string' || data.messageId.length < 1 || data.messageId.length > 190 ||
        /[\u0000-\u001f\u007f]/.test(data.messageId) ||
        typeof data.nodeId !== 'string' || !/^n-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))*$/.test(data.nodeId) ||
        typeof data.mediaId !== 'string' || data.mediaId !== `media-${data.nodeId}` ||
        data.mediaId.length > 190 ||
        typeof data.richRevision !== 'number' || !Number.isSafeInteger(data.richRevision) ||
        data.richRevision < 1) return null;
    return Object.freeze(data) as RetryAdmissionRequest;
  } catch { return null; }
}

/** Strict *physical* snapshot comparison, not one-shot ledger claim or CAS. */
async function readUnoccupiedPhysicalLedger(
  source: CanonicalRichMediaRetryEligibility
): Promise<string | null> {
  const read = await readDurableStrict('rich-actions');
  if (read.kind === 'absent') return 'absent';
  if (read.kind !== 'valid') return null;
  const legacy = parseRichActionSnapshot(read.value);
  if (legacy) return JSON.stringify(legacy);
  const v2 = parseRichRetryLedgerSnapshot(read.value);
  if (!v2 || v2.actions.some(row => row.kind === 'retry_capture' &&
      row.sessionId === source.sessionId && row.messageId === source.messageId &&
      row.mediaId === source.mediaId && row.nodeId === source.nodeId)) return null;
  // Retired and unknown same-slot custody conservatively veto too. The parser's
  // narrower admission rules are not permission to issue another retry here.
  return JSON.stringify(v2);
}

function nonremovedPage(source: CanonicalRichMediaRetryEligibility | null):
  source is CanonicalRichMediaRetryEligibility {
  return !!source && source.eligibilityOnly === true && source.source === 'page' &&
    !source.requiresRemovalConfirmation && source.reason !== 'removed' &&
    (source.status === 'pending' || source.status === 'unavailable');
}

function sameSource(a: CanonicalRichMediaRetryEligibility, b: CanonicalRichMediaRetryEligibility): boolean {
  return Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => a[key as keyof CanonicalRichMediaRetryEligibility] ===
      b[key as keyof CanonicalRichMediaRetryEligibility]);
}

/**
 * @internal Private, strictly read-only main/physical-source/ledger conjunction.
 * The event and window are invocation inputs from the future main owner, NOT a
 * verified human gesture. Success has no transferable descriptor or authority.
 * A future coordinator must independently reprove everything and obtain real consent.
 */
export async function inspectMainRetryAdmission(
  event: IpcMainInvokeEvent, request: unknown, currentWindow: BrowserWindow | null
): Promise<Readonly<{ kind: 'admission_matches'; authority: 'none' }> | null> {
  const wanted = parseRequest(request);
  if (!wanted) return null;
  const { sessionId, messageId, mediaId, nodeId, richRevision } = wanted;
  const selectedGeneration = (() => {
    if (!currentWindow || currentWindow.isDestroyed() || !currentWindow.isVisible() ||
        currentWindow.webContents.isDestroyed() || !event?.sender ||
        event.sender !== currentWindow.webContents || !event.senderFrame ||
        event.senderFrame !== currentWindow.webContents.mainFrame) return null;
    const witness = currentUiSelectionFor(event.sender);
    return witness?.sessionId === sessionId ? witness.generation : null;
  })();
  if (selectedGeneration === null) return null;
  const recordingRevision = getRecordingRevision();
  const recordingGeneration = recordingGenerationGrant();
  if (recordingGeneration === null) return null;

  // Do not call continuationForSession(): its read sweeps expired entries and can
  // write durable state. This pure snapshot conservatively vetoes *all* not-yet-
  // terminal entries, even expired ones, until their ordinary owner retires them.
  const current = (conversationId: string | null): boolean => {
    try {
      const selected = event?.sender ? currentUiSelectionFor(event.sender) : null;
      if (!currentWindow || currentWindow.isDestroyed() || !currentWindow.isVisible() ||
          currentWindow.webContents.isDestroyed() || !event?.sender ||
          event.sender !== currentWindow.webContents || !event.senderFrame ||
          event.senderFrame !== currentWindow.webContents.mainFrame ||
          selected?.sessionId !== sessionId || selected.generation !== selectedGeneration ||
          recordingGenerationGrant() !== recordingGeneration ||
          getRecordingRevision() !== recordingRevision ||
          !recordingWriteAllowed(recordingRevision) || pendingRecordingOffDecision() ||
          sessionAttachmentTransitionPending(sessionId) ||
          snapshotContinuations().entries.some(row => row.sessionId === sessionId &&
            row.state !== 'committed' && row.state !== 'aborted') ||
          (conversationId !== null && isChatBlocked(conversationId))) return false;
      return true;
    } catch { return false; }
  };

  if (!current(null)) return null;
  try {
    const before = readWarmRichRetrySession(sessionId);
    if (!before?.conversationId || !current(before.conversationId)) return null;
    const bindingRevision = before.bindingRevision ?? 0;
    const source = await readCanonicalRichMediaRetryEligibility(sessionId, messageId, mediaId,
      nodeId, richRevision, { warmOnly: true });
    if (!current(before.conversationId) || !nonremovedPage(source) ||
        source.sessionId !== sessionId || source.conversationId !== before.conversationId ||
        source.bindingRevision !== bindingRevision || source.recordingRevision !== recordingRevision ||
        source.messageId !== messageId || source.mediaId !== mediaId || source.nodeId !== nodeId ||
        source.richRevision !== richRevision) return null;
    const superseded = await conversationWasSuperseded(source.conversationId);
    if (superseded || !current(source.conversationId)) return null;

    // Freeze the complete expectation from physically read store facts, never the
    // renderer. The store validates source/cleanup/deletion/owner epochs internally.
    const exact = Object.freeze({ sessionId, conversationId: source.conversationId,
      bindingRevision: source.bindingRevision, messageId, providerMessageId: source.providerMessageId,
      richRevision, presentationSeq: source.presentationSeq, mediaId, nodeId,
      originDocumentId: source.documentId, originNavigationEpoch: source.navigationEpoch,
      recordingRevision, recordingGeneration, cleanupEpoch: source.cleanupEpoch });
    const firstLedger = await readUnoccupiedPhysicalLedger(source);
    if (firstLedger === null || !current(source.conversationId)) return null;
    const sourceMatch = await inspectInertRichRetrySource(exact, { warmOnly: true });
    if (!sourceMatch || sourceMatch.authority !== 'none' ||
        sourceMatch.kind !== 'source_matches' || !current(source.conversationId)) return null;
    const secondLedger = await readUnoccupiedPhysicalLedger(source);
    if (secondLedger === null || secondLedger !== firstLedger || !current(source.conversationId)) return null;
    const latest = await readCanonicalRichMediaRetryEligibility(sessionId, messageId, mediaId,
      nodeId, richRevision, { warmOnly: true });
    if (!nonremovedPage(latest) || !sameSource(source, latest) || !current(source.conversationId)) return null;
    const finalSession = readWarmRichRetrySession(sessionId);
    if (!finalSession || finalSession.conversationId !== source.conversationId ||
        (finalSession.bindingRevision ?? 0) !== bindingRevision || !current(source.conversationId)) return null;
    const finalLedger = await readUnoccupiedPhysicalLedger(source);
    if (finalLedger === null || finalLedger !== firstLedger || !current(source.conversationId)) return null;
    return Object.freeze({ kind: 'admission_matches', authority: 'none' });
  } catch { return null; }
}
