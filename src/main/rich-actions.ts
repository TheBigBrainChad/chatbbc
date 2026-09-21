/**
 * Task 11's INERT durable native-action foundation. This module accepts no production intent,
 * claim, tab opening, election, dispatch or native result. It exposes read-only status and
 * a main-private retirement of invalidated, already-claimed pre-dispatch records. Main UI
 * selection and saved canonical descriptors cannot prove human or live provider input;
 * Chrome action leases and accepted-input evidence are still absent. Never expose the
 * reconciliation method as an IPC, HTTP or browser executor.
 */
import { getConfig, getRecordingRevision, pendingRecordingOffDecision,
  recordingGenerationGrant, recordingWriteAllowed } from './config.js';
import { durableStoreReady, readDurableStrict, writeDurableNow } from './durable.js';
import { isChatBlocked } from './session/blocked-chats.js';
import { continuationForSession } from './session/continuation.js';
import { conversationWasSuperseded, findSessionByConversation, getSession,
  readCanonicalRichControlDescriptor, sessionAttachmentTransitionPending } from './session/store.js';

export type RichActionPhase = 'intent' | 'opening_spent' | 'elected' | 'may_have_dispatched'
  | 'observed' | 'unknown' | 'changed' | 'unavailable' | 'retired';

export type RichActionRecord = {
  id: string;
  phase: RichActionPhase;
  createdAt: number;
  claimOwner: string | null;
  sessionId: string;
  conversationId: string;
  bindingRevision: number;
  messageId: string;
  providerMessageId: string;
  revision: number;
  nodeId: string;
  /** Exact native form/group identity; never inferred from label or selected value. */
  groupId: string;
  kind: 'select' | 'continue';
  value: string | null;
  expectedSelected: boolean;
  expectedGroupSelection: string | null;
  tabId: number | null;
  documentId: string | null;
  navigationEpoch: number | null;
  openingSpent: boolean;
  resultDetail: string | null;
};

export type RichActionIntent = Pick<RichActionRecord,
  'sessionId' | 'conversationId' | 'bindingRevision' | 'messageId' | 'providerMessageId' |
  'revision' | 'nodeId' | 'groupId' | 'kind' | 'value' | 'expectedSelected' | 'expectedGroupSelection'>;

/** Structural description only. Nothing in this increment can issue an offer or grant. */
export type RichActionOffer = Pick<RichActionRecord,
  'id' | 'conversationId' | 'messageId' | 'providerMessageId' | 'revision' | 'nodeId' | 'groupId' |
  'kind' | 'value' | 'expectedSelected' | 'expectedGroupSelection' | 'documentId' | 'navigationEpoch'>;

export type RichActionResult = {
  id: string | null;
  state: 'pending' | 'observed' | 'unknown' | 'changed' | 'unavailable';
  detail: string | null;
};

export type RichActionSnapshot = {
  version: 1;
  actions: RichActionRecord[];
  receipts: Array<RichActionResult & { id: string; state: 'observed' | 'unknown' | 'changed' | 'unavailable'; detail: string }>;
};

/** PAGE-only, *state-only* future recapture custody. A stored row is NOT a verified
 * gesture, tab lease, pixel ticket or authority to bypass an image tombstone. */
export type RichRetryRecord = {
  kind: 'retry_capture';
  id: string;
  phase: 'intent' | 'opening_spent' | 'elected' | 'dispatch_spent' | 'retired';
  createdAt: number;
  claimOwner: string | null;
  sessionId: string;
  conversationId: string;
  bindingRevision: number;
  messageId: string;
  providerMessageId: string;
  richRevision: number;
  presentationSeq: number;
  mediaId: string;
  nodeId: string;
  source: 'page';
  /** Original stored rich origin, not the separately elected current Chrome document. */
  originDocumentId: string;
  originNavigationEpoch: number;
  /** Main-owned selection witness at intent issuance, never supplied as a browser grant. */
  selectionGeneration: number;
  recordingRevision: number;
  recordingGeneration: string;
  /** Only an in-process synchronous fence; not a durable cleanup identity. */
  cleanupEpoch: number;
  /** Requires a FUTURE store-owned durable tombstone incarnation to be usable. */
  removalIncarnation: string | null;
  confirmRemoved: boolean;
  tabId: number | null;
  documentId: string | null;
  documentGeneration: number | null;
  navigationEpoch: number | null;
  openingSpent: boolean;
  dispatchSpent: boolean;
  resultDetail: string | null;
};

export type RichRetryLedgerSnapshot = {
  version: 2;
  actions: Array<RichActionRecord | RichRetryRecord>;
  receipts: RichActionSnapshot['receipts'];
};
type RichLedgerSnapshot = RichActionSnapshot | RichRetryLedgerSnapshot;

const LEDGER = 'rich-actions';
const MAX_ACTIONS = 128;
const MAX_DETAIL = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[a-z0-9:._-]{1,190}$/i;
const SESSION = /^[a-z0-9-]{8,64}$/i;
const PHASES = new Set<RichActionPhase>([
  'intent', 'opening_spent', 'elected', 'may_have_dispatched',
  'observed', 'unknown', 'changed', 'unavailable', 'retired'
]);
const RESULTS = new Set<RichActionResult['state']>(['observed', 'unknown', 'changed', 'unavailable']);
const DOCUMENT = /^[a-z0-9_-]{1,128}$/i;
const RECORDING_GENERATION = /^[A-Za-z0-9_-]{43}$/;

// Only own enumerable data descriptors are inspected. No getters, inherited objects, symbols,
// arbitrary provider payloads, executable fields or caller-provided URLs survive parsing.
function fields(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length) return null;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch { return null; }
}

function elements(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > MAX_ACTIONS || Reflect.ownKeys(value).length !== length.value + 1) return null;
    const out: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      out.push(descriptor.value);
    }
    return out;
  } catch { return null; }
}

const count = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const opaque = (value: unknown): value is string => typeof value === 'string' && OPAQUE.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const detail = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_DETAIL && !/[\u0000-\u001f]/.test(value);

function parseAction(value: unknown): RichActionRecord | null {
  const record = fields(value, [
    'id', 'phase', 'createdAt', 'claimOwner', 'sessionId', 'conversationId', 'bindingRevision',
    'messageId', 'providerMessageId', 'revision', 'nodeId', 'groupId', 'kind', 'value',
    'expectedSelected', 'expectedGroupSelection', 'tabId', 'documentId',
    'navigationEpoch', 'openingSpent', 'resultDetail'
  ]);
  if (!record || !uuid(record.id) || !PHASES.has(record.phase as RichActionPhase) ||
      !count(record.createdAt, 1) ||
      !(record.claimOwner === null || (typeof record.claimOwner === 'string' && /^[a-f0-9]{64}$/.test(record.claimOwner))) ||
      typeof record.sessionId !== 'string' || !SESSION.test(record.sessionId) || !uuid(record.conversationId) ||
      !count(record.bindingRevision) || !opaque(record.messageId) || !uuid(record.providerMessageId) ||
      !count(record.revision, 1) || !opaque(record.nodeId) || !opaque(record.groupId) ||
      (record.kind !== 'select' && record.kind !== 'continue') ||
      !(record.value === null || (typeof record.value === 'string' && record.value.length > 0 && record.value.length <= 512)) ||
      typeof record.expectedSelected !== 'boolean' ||
      !(record.expectedGroupSelection === null || opaque(record.expectedGroupSelection)) ||
      !(record.tabId === null || count(record.tabId)) ||
      !(record.documentId === null || (typeof record.documentId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(record.documentId))) ||
      !(record.navigationEpoch === null || count(record.navigationEpoch)) ||
      typeof record.openingSpent !== 'boolean' ||
      !(record.resultDetail === null || detail(record.resultDetail))) return null;

  const phase = record.phase as RichActionPhase;
  const elected = record.tabId !== null && record.documentId !== null && record.navigationEpoch !== null;
  if ((record.tabId !== null || record.documentId !== null || record.navigationEpoch !== null) && !elected) return null;
  if (record.kind === 'continue' && (record.value !== null || record.expectedGroupSelection === null)) return null;
  if (record.kind === 'select' && record.value === null) return null;
  if (phase === 'intent' && (record.openingSpent || elected || record.resultDetail !== null)) return null;
  if (phase === 'opening_spent' && (!record.openingSpent || elected || record.claimOwner === null || record.resultDetail !== null)) return null;
  if (['elected', 'may_have_dispatched'].includes(phase) &&
      (!elected || record.claimOwner === null || record.resultDetail !== null)) return null;
  // A result and receipt must retire atomically. No halfway observed/unknown record can
  // masquerade as an authoritative durable result; older formats fail closed.
  if (['observed', 'unknown', 'changed', 'unavailable'].includes(phase)) return null;
  if (phase === 'retired' && (record.claimOwner === null || !detail(record.resultDetail))) return null;
  return { ...record } as unknown as RichActionRecord; // All fields detached to the allowlisted record.
}

function parseReceipt(value: unknown): RichActionSnapshot['receipts'][number] | null {
  const receipt = fields(value, ['id', 'state', 'detail']);
  if (!receipt || !uuid(receipt.id) || !RESULTS.has(receipt.state as RichActionResult['state']) ||
      !detail(receipt.detail)) return null;
  return { id: receipt.id, state: receipt.state as RichActionSnapshot['receipts'][number]['state'], detail: receipt.detail };
}

/** Only a complete, bounded, version-one and internally consistent snapshot is readable.
 * This is NOT evidence that any action was authorized or native input succeeded. */
export function parseRichActionSnapshot(value: unknown): RichActionSnapshot | null {
  const root = fields(value, ['version', 'actions', 'receipts']);
  if (!root || root.version !== 1) return null;
  const inputActions = elements(root.actions);
  const inputReceipts = elements(root.receipts);
  if (!inputActions || !inputReceipts) return null;
  const actions: RichActionRecord[] = [];
  const receipts: RichActionSnapshot['receipts'] = [];
  const actionIds = new Set<string>();
  const receiptIds = new Set<string>();
  const pendingGroups = new Set<string>();
  for (const item of inputActions) {
    const parsed = parseAction(item);
    if (!parsed || actionIds.has(parsed.id)) return null;
    if (parsed.phase !== 'retired') {
      const owner = JSON.stringify([parsed.sessionId, parsed.messageId, parsed.groupId]);
      if (pendingGroups.has(owner)) return null;
      pendingGroups.add(owner);
    }
    actionIds.add(parsed.id);
    actions.push(parsed);
  }
  for (const item of inputReceipts) {
    const parsed = parseReceipt(item);
    if (!parsed || receiptIds.has(parsed.id)) return null;
    receiptIds.add(parsed.id);
    receipts.push(parsed);
  }
  for (const action of actions) {
    const receipt = receipts.find(candidate => candidate.id === action.id);
    if (action.phase === 'retired'
      ? !receipt || receipt.detail !== action.resultDetail
      : receipt !== undefined) return null;
    // A claimed/opening-only record cannot have observed a native postcondition.
    // This checks consistency, not proof of actual browser input or an executed click.
    if (receipt?.state === 'observed' && action.tabId === null) return null;
  }
  if (receipts.some(receipt => !actionIds.has(receipt.id))) return null;
  return { version: 1, actions, receipts };
}

const RETRY_FIELDS = [
  'kind', 'id', 'phase', 'createdAt', 'claimOwner', 'sessionId', 'conversationId',
  'bindingRevision', 'messageId', 'providerMessageId', 'richRevision', 'presentationSeq',
  'mediaId', 'nodeId', 'source', 'originDocumentId', 'originNavigationEpoch',
  'selectionGeneration', 'recordingRevision', 'recordingGeneration', 'cleanupEpoch',
  'removalIncarnation', 'confirmRemoved', 'tabId', 'documentId', 'documentGeneration',
  'navigationEpoch', 'openingSpent', 'dispatchSpent', 'resultDetail'
] as const;

function parseRetry(value: unknown): RichRetryRecord | null {
  const record = fields(value, RETRY_FIELDS);
  if (!record || record.kind !== 'retry_capture' || !uuid(record.id) ||
      !['intent', 'opening_spent', 'elected', 'dispatch_spent', 'retired'].includes(record.phase as string) ||
      !count(record.createdAt, 1) ||
      !(record.claimOwner === null || (typeof record.claimOwner === 'string' && /^[a-f0-9]{64}$/.test(record.claimOwner))) ||
      typeof record.sessionId !== 'string' || !SESSION.test(record.sessionId) ||
      !uuid(record.conversationId) || !count(record.bindingRevision) ||
      !opaque(record.messageId) || !uuid(record.providerMessageId) ||
      !count(record.richRevision, 1) || !count(record.presentationSeq, 1) ||
      !opaque(record.mediaId) || !opaque(record.nodeId) ||
      record.mediaId !== `media-${record.nodeId}` || record.source !== 'page' ||
      typeof record.originDocumentId !== 'string' || !DOCUMENT.test(record.originDocumentId) ||
      !count(record.originNavigationEpoch) || !count(record.selectionGeneration, 1) ||
      !count(record.recordingRevision) || typeof record.recordingGeneration !== 'string' ||
      !RECORDING_GENERATION.test(record.recordingGeneration) || !count(record.cleanupEpoch) ||
      typeof record.confirmRemoved !== 'boolean' ||
      !(record.confirmRemoved ? uuid(record.removalIncarnation) : record.removalIncarnation === null) ||
      !(record.tabId === null || count(record.tabId)) ||
      !(record.documentId === null || (typeof record.documentId === 'string' && DOCUMENT.test(record.documentId))) ||
      !(record.documentGeneration === null || count(record.documentGeneration, 1)) ||
      !(record.navigationEpoch === null || count(record.navigationEpoch)) ||
      typeof record.openingSpent !== 'boolean' || typeof record.dispatchSpent !== 'boolean' ||
      !(record.resultDetail === null || detail(record.resultDetail))) return null;
  const elected = record.tabId !== null && record.documentId !== null &&
    record.documentGeneration !== null && record.navigationEpoch !== null;
  if ([record.tabId, record.documentId, record.documentGeneration, record.navigationEpoch]
    .some(value => value !== null) && !elected) return null;
  if (record.phase === 'intent' && (elected || record.openingSpent || record.dispatchSpent ||
      record.resultDetail !== null)) return null;
  if (record.phase === 'opening_spent' && (!record.openingSpent || elected ||
      record.dispatchSpent || record.claimOwner === null || record.resultDetail !== null)) return null;
  if (record.phase === 'elected' && (!elected || record.claimOwner === null ||
      record.dispatchSpent || record.resultDetail !== null)) return null;
  if (record.phase === 'dispatch_spent' && (!elected || !record.dispatchSpent ||
      record.claimOwner === null || record.resultDetail !== null)) return null;
  if (record.phase === 'retired' && (record.claimOwner === null || !detail(record.resultDetail))) return null;
  if (record.phase !== 'retired' && record.resultDetail !== null) return null;
  if (record.phase !== 'retired' && record.dispatchSpent !== (record.phase === 'dispatch_spent')) return null;
  if (record.dispatchSpent && !elected) return null;
  return { ...record } as unknown as RichRetryRecord;
}

/** Strict v2 only: valid v1 rows/receipts survive migration untouched, but a
 * malformed mixed row, unknown version or conflicting retry slot quarantines all. */
export function parseRichRetryLedgerSnapshot(value: unknown): RichRetryLedgerSnapshot | null {
  const root = fields(value, ['version', 'actions', 'receipts']);
  if (!root || root.version !== 2) return null;
  const inputActions = elements(root.actions);
  const inputReceipts = elements(root.receipts);
  if (!inputActions || !inputReceipts) return null;
  const actions: RichRetryLedgerSnapshot['actions'] = [];
  const receipts: RichRetryLedgerSnapshot['receipts'] = [];
  const actionIds = new Set<string>();
  const receiptIds = new Set<string>();
  const groups = new Set<string>();
  for (const item of inputActions) {
    const parsed = parseAction(item) ?? parseRetry(item);
    if (!parsed || actionIds.has(parsed.id)) return null;
    actionIds.add(parsed.id);
    if (parsed.kind !== 'retry_capture' && parsed.phase !== 'retired') {
      const group = JSON.stringify([parsed.sessionId, parsed.messageId, parsed.groupId]);
      if (groups.has(group)) return null;
      groups.add(group);
    }
    actions.push(parsed);
  }
  for (const item of inputReceipts) {
    const receipt = parseReceipt(item);
    if (!receipt || receiptIds.has(receipt.id)) return null;
    receiptIds.add(receipt.id);
    receipts.push(receipt);
  }
  const outstanding = new Set<string>();
  for (const action of actions) {
    const receipt = receipts.find(row => row.id === action.id);
    if (action.phase === 'retired'
      ? !receipt || receipt.detail !== action.resultDetail
      : receipt !== undefined) return null;
    if (action.kind === 'retry_capture') {
      // No v2 retry receipt contains authenticated canonical asset-postcondition
      // evidence yet. A disk-seeded observed receipt must never become UI success;
      // this restriction does NOT change legacy v1 select/continue receipts.
      if (receipt?.state === 'observed') return null;
      // Once either opening OR capture might have happened, a negative outcome
      // cannot release the exact slot without independently persisted proof.
      if (receipt && (action.openingSpent || action.dispatchSpent
        ? receipt.state !== 'unknown' : receipt.state === 'unknown')) return null;
      // Unknown retirement is unresolved custody, not permission to create a
      // new try for the same physical slot. Do not evict it to free capacity.
      if (action.phase !== 'retired' || receipt?.state === 'unknown') {
        const slot = JSON.stringify([action.sessionId, action.messageId, action.mediaId, action.nodeId]);
        if (outstanding.has(slot)) return null;
        outstanding.add(slot);
      }
    } else if (receipt?.state === 'observed' && action.tabId === null) return null;
  }
  if (receipts.some(row => !actionIds.has(row.id))) return null;
  return { version: 2, actions, receipts };
}

function parseLedger(value: unknown): RichLedgerSnapshot | null {
  const old = parseRichActionSnapshot(value);
  return old ?? parseRichRetryLedgerSnapshot(value);
}

/** @internal Pure STATE simulation, NOT a gesture, opening/capture grant or
 * observed asset receipt. Even `dispatch_spent` returns a snapshot, never an offer.
 * No production caller is wired in this cut. */
export function reduceInertRichRetrySnapshot(
  existing: unknown, transition: unknown
): { kind: 'refused' } | { kind: 'changed' | 'unchanged'; snapshot: RichRetryLedgerSnapshot } {
  const refused = (): { kind: 'refused' } => ({ kind: 'refused' });
  const source = parseLedger(existing);
  if (!source) return refused();
  let kind: unknown;
  try {
    if (!transition || typeof transition !== 'object' || Array.isArray(transition) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(transition))) return refused();
    const descriptor = Object.getOwnPropertyDescriptor(transition, 'kind');
    if (!descriptor?.enumerable || !('value' in descriptor)) return refused();
    kind = descriptor.value;
  } catch { return refused(); }
  if (!['create', 'claim', 'opening_spent', 'elect', 'dispatch_spent', 'retire'].includes(kind as string))
    return refused();
  const names = kind === 'create' ? ['kind', 'record'] : [
    'kind', 'expected', 'owner',
    ...(kind === 'elect' ? ['tabId', 'documentId', 'documentGeneration', 'navigationEpoch'] : []),
    ...(kind === 'retire' ? ['outcome', 'detail'] : [])
  ];
  const command = fields(transition, names);
  if (!command) return refused();
  if (kind === 'create') {
    const row = parseRetry(command.record);
    if (!row || row.phase !== 'intent' || row.claimOwner !== null ||
        source.actions.length >= MAX_ACTIONS || source.actions.some(saved => saved.id === row.id ||
          (saved.kind === 'retry_capture' && (saved.phase !== 'retired' ||
            source.receipts.some(receipt => receipt.id === saved.id && receipt.state === 'unknown')) &&
            saved.sessionId === row.sessionId && saved.messageId === row.messageId &&
            saved.mediaId === row.mediaId && saved.nodeId === row.nodeId))) return refused();
    const checked = parseRichRetryLedgerSnapshot({ version: 2,
      actions: [...source.actions, row], receipts: source.receipts });
    return checked ? { kind: 'changed', snapshot: checked } : refused();
  }
  const expected = parseRetry(command.expected);
  if (!expected || typeof command.owner !== 'string' || !/^[a-f0-9]{64}$/.test(command.owner))
    return refused();
  const index = source.actions.findIndex(row => row.id === expected.id && row.kind === 'retry_capture');
  if (index < 0) return refused();
  const row = source.actions[index] as RichRetryRecord;
  const same = (excluded: readonly string[] = []): boolean =>
    RETRY_FIELDS.every(field => excluded.includes(field) || row[field] === expected[field]);
  const unchanged = (): { kind: 'unchanged'; snapshot: RichRetryLedgerSnapshot } | { kind: 'refused' } => {
    if (source.version !== 2) return refused();
    return { kind: 'unchanged', snapshot: source };
  };
  if (kind === 'retire' && row.phase === 'retired') {
    const receipt = source.receipts.find(item => item.id === row.id);
    return row.claimOwner === command.owner && same(['phase', 'resultDetail']) &&
      receipt?.state === command.outcome && receipt?.detail === command.detail &&
      expected.phase !== 'retired' ? unchanged() : refused();
  }
  if (kind === 'claim') {
    if (expected.phase !== 'intent' || expected.claimOwner !== null || !same(['claimOwner'])) return refused();
    if (row.claimOwner === command.owner) return unchanged();
    if (row.claimOwner !== null) return refused();
  } else if (row.claimOwner !== command.owner || !same()) return refused();
  let next: RichRetryRecord;
  const receipts = source.receipts.map(item => ({ ...item }));
  switch (kind) {
    case 'claim':
      next = { ...row, claimOwner: command.owner as string };
      break;
    case 'opening_spent':
      if (row.phase !== 'intent' || row.openingSpent) return refused();
      next = { ...row, phase: 'opening_spent', openingSpent: true };
      break;
    case 'elect':
      if (!['intent', 'opening_spent'].includes(row.phase) || !count(command.tabId) ||
          typeof command.documentId !== 'string' || !DOCUMENT.test(command.documentId) ||
          !count(command.documentGeneration, 1) || !count(command.navigationEpoch)) return refused();
      next = { ...row, phase: 'elected', tabId: command.tabId,
        documentId: command.documentId, documentGeneration: command.documentGeneration,
        navigationEpoch: command.navigationEpoch } as RichRetryRecord;
      break;
    case 'dispatch_spent':
      if (row.phase !== 'elected' || row.dispatchSpent) return refused();
      next = { ...row, phase: 'dispatch_spent', dispatchSpent: true };
      break;
    case 'retire':
      // No verified asset/slot postcondition exists in Cut1: NEVER invent observed.
      // A spent opening may have created a tab even if its ACK vanished; a spent
      // capture may have observed pixels. Neither can be marked changed/unavailable
      // solely from a caller's outcome string and then free the exact retry slot.
      if (row.phase === 'retired' || !detail(command.detail) ||
          !['unknown', 'changed', 'unavailable'].includes(command.outcome as string) ||
          (row.openingSpent || row.dispatchSpent
            ? command.outcome !== 'unknown' : command.outcome === 'unknown')) return refused();
      next = { ...row, phase: 'retired', resultDetail: command.detail as string };
      receipts.push({ id: row.id, state: command.outcome as 'unknown' | 'changed' | 'unavailable',
        detail: command.detail as string });
      break;
    default:
      return refused();
  }
  const checked = parseRichRetryLedgerSnapshot({ version: 2,
    actions: source.actions.map((saved, position) => position === index ? next : saved), receipts });
  return checked ? { kind: 'changed', snapshot: checked } : refused();
}

/** @internal Source-only simulation of an ALREADY EXISTING v1 record. This pure
 * function is not wired to the ledger, browser, bridge or IPC and returns no
 * permission, offer, claimed user gesture or native postcondition. In particular,
 * producing a hypothetical may_have_dispatched snapshot is NOT a click grant:
 * a future owner would first need an independently reviewed durable cut and all
 * current human/Chrome ownership checks. Never feed its output to a live writer. */
export function reduceInertRichActionSnapshot(
  existing: unknown, transition: unknown
): { kind: 'refused' } | { kind: 'changed' | 'unchanged'; snapshot: RichActionSnapshot } {
  const refused = (): { kind: 'refused' } => ({ kind: 'refused' });
  const source = parseRichActionSnapshot(existing);
  if (!source) return refused();
  // Read a data descriptor before selecting the command's exact allowlist: no
  // arbitrary caller getter or inherited "kind" can choose a permissive parser.
  let kind: unknown;
  try {
    if (!transition || typeof transition !== 'object' || Array.isArray(transition) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(transition))) return refused();
    const descriptor = Object.getOwnPropertyDescriptor(transition, 'kind');
    if (!descriptor?.enumerable || !('value' in descriptor)) return refused();
    kind = descriptor.value;
  } catch { return refused(); }
  if (!['claim', 'opening_spent', 'elect', 'may_have_dispatched', 'retire'].includes(kind as string))
    return refused();
  const names = ['kind', 'expected', 'owner',
    ...(kind === 'elect' ? ['tabId', 'documentId', 'navigationEpoch'] : []),
    ...(kind === 'retire' ? ['outcome', 'detail'] : [])];
  const request = fields(transition, names);
  if (!request || typeof request.owner !== 'string' || !/^[a-f0-9]{64}$/.test(request.owner))
    return refused();
  const expected = parseAction(request.expected);
  if (!expected) return refused();
  const index = source.actions.findIndex(row => row.id === expected.id);
  if (index < 0) return refused(); // This reducer never mints an intent or evicts a row.
  const current = source.actions[index]!;
  const same = (excluded: readonly string[] = []): boolean =>
    Object.keys(current).every(key => excluded.includes(key) ||
      current[key as keyof RichActionRecord] === expected[key as keyof RichActionRecord]);
  const unchanged = (): { kind: 'unchanged'; snapshot: RichActionSnapshot } =>
    ({ kind: 'unchanged', snapshot: source });

  if (kind === 'claim') {
    if (expected.phase !== 'intent' || expected.claimOwner !== null ||
        !same(['claimOwner'])) return refused();
    if (current.claimOwner === request.owner) return unchanged();
    if (current.claimOwner !== null) return refused();
  } else if (current.claimOwner !== request.owner) {
    // An unclaimed intent cannot be retired by inventing a claim fingerprint.
    return refused();
  } else if (kind === 'retire' && current.phase === 'retired') {
    const receipt = source.receipts.find(row => row.id === current.id);
    return same(['phase', 'resultDetail']) &&
      (expected.phase === 'intent' || expected.phase === 'opening_spent' || expected.phase === 'elected' ||
        expected.phase === 'retired') &&
      receipt !== undefined && receipt.state === request.outcome && receipt.detail === request.detail
      ? unchanged() : refused();
  } else if (!same()) {
    // A stale expected phase, binding, revision, owner, document or node is not
    // evidence for even a hypothetical transition on this record.
    return refused();
  }

  let next: RichActionRecord;
  const receipts = source.receipts.map(receipt => ({ ...receipt }));
  switch (kind) {
    case 'claim':
      next = { ...current, claimOwner: request.owner as string };
      break;
    case 'opening_spent':
      if (current.phase !== 'intent') return refused();
      next = { ...current, phase: 'opening_spent', openingSpent: true };
      break;
    case 'elect':
      if ((current.phase !== 'intent' && current.phase !== 'opening_spent') ||
          !count(request.tabId) ||
          typeof request.documentId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(request.documentId) ||
          !count(request.navigationEpoch)) return refused();
      next = { ...current, phase: 'elected', tabId: request.tabId,
        documentId: request.documentId, navigationEpoch: request.navigationEpoch };
      break;
    case 'may_have_dispatched':
      // The *first* exact elected state may advance once in a simulation.
      // Dispatch, retry, terminal observation and restoration are NOT implemented.
      if (current.phase !== 'elected') return refused();
      next = { ...current, phase: 'may_have_dispatched' };
      break;
    case 'retire':
      // v1 cannot represent retired unclaimed intent. Nor can it prove a
      // post-dispatch negative or an observed browser result from historical data.
      if (!['intent', 'opening_spent', 'elected'].includes(current.phase) ||
          (request.outcome !== 'changed' && request.outcome !== 'unavailable') ||
          !detail(request.detail)) return refused();
      next = { ...current, phase: 'retired', resultDetail: request.detail };
      receipts.push({ id: current.id, state: request.outcome, detail: request.detail });
      break;
    default:
      return refused();
  }
  const actions = source.actions.map((row, at) => at === index ? next : { ...row });
  const checked = parseRichActionSnapshot({ version: 1, actions, receipts });
  return checked ? { kind: 'changed', snapshot: checked } : refused();
}

let transitionQueue = Promise.resolve();
let loaded: 'not_loaded' | 'absent' | 'valid' | 'quarantined' = 'not_loaded';
let snapshot: RichLedgerSnapshot | null = null;
/** Process-memory only. Restoring a saved pre-dispatch row NEVER reacquires its
 * original user/selection/Chrome claim or permits continuing an old opening. */
const freshRetryIds = new Set<string>();

function enqueueRichTransition<T>(work: () => Promise<T>): Promise<T> {
  const result = transitionQueue.then(work);
  transitionQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function restoreNow(): Promise<'absent' | 'valid' | 'quarantined' | 'unavailable'> {
  if (!durableStoreReady()) return 'unavailable';
  if (loaded !== 'not_loaded') return loaded;
  const read = await readDurableStrict(LEDGER);
  if (read.kind === 'absent') {
    snapshot = { version: 1, actions: [], receipts: [] };
    loaded = 'absent';
  } else if (read.kind === 'valid') {
    const parsed = parseLedger(read.value);
    if (parsed) {
      snapshot = parsed;
      loaded = 'valid';
    } else {
      snapshot = null;
      loaded = 'quarantined';
    }
  } else {
    snapshot = null;
    loaded = 'quarantined';
  }
  return loaded;
}

/** Read-only restore; quarantine never rewrites a corrupt/unsupported or unreadable file.
 * Without a verified durable root, even an ENOENT-looking load cannot create new authority. */
export function restoreRichActionLedger(): Promise<'absent' | 'valid' | 'quarantined' | 'unavailable'> {
  return enqueueRichTransition(restoreNow);
}

const unavailable = (): RichActionResult => ({ id: null, state: 'unavailable', detail: 'Native interaction unavailable' });

function quarantineRichActions(): void {
  snapshot = null;
  loaded = 'quarantined';
  freshRetryIds.clear();
}

/** Decide only whether an EXISTING claimed record is no longer usable. This is never
 * eligibility for a browser action; a missing physical descriptor cannot prove a change. */
async function inertInvalidation(row: RichActionRecord): Promise<'changed' | 'unavailable' | 'defer' | null> {
  // An attempted Recording Off closes admission immediately but may fail its
  // config.json rename. It is NOT a committed reason to durably retire a claim.
  const policy = (): 'defer' | 'unavailable' | null => {
    if (pendingRecordingOffDecision()) return 'defer';
    if (!getConfig().sessions.record || isChatBlocked(row.conversationId) ||
        continuationForSession(row.sessionId) || sessionAttachmentTransitionPending(row.sessionId))
      return 'unavailable';
    return null;
  };
  const initial = policy();
  if (initial) return initial;
  const session = await getSession(row.sessionId);
  const afterSession = policy();
  if (afterSession) return afterSession;
  if (!session || session.conversationId !== row.conversationId ||
      (session.bindingRevision ?? 0) !== row.bindingRevision) return 'unavailable';
  const owner = await findSessionByConversation(row.conversationId, { requireUnique: true });
  const afterOwner = policy();
  if (afterOwner) return afterOwner;
  if (owner?.id !== row.sessionId) return 'unavailable';
  const superseded = await conversationWasSuperseded(row.conversationId);
  const afterSupersession = policy();
  if (afterSupersession) return afterSupersession;
  if (superseded) return 'unavailable';
  const exact = await readCanonicalRichControlDescriptor(row.sessionId, row.messageId, row.nodeId);
  const afterDescriptor = policy();
  if (afterDescriptor) return afterDescriptor;
  if (!exact) return 'unavailable';
  if (exact.sessionId !== row.sessionId || exact.conversationId !== row.conversationId ||
      exact.bindingRevision !== row.bindingRevision || exact.messageId !== row.messageId ||
      exact.providerMessageId !== row.providerMessageId || exact.richRevision !== row.revision ||
      exact.nodeId !== row.nodeId || exact.groupId !== row.groupId || exact.kind !== row.kind ||
      exact.value !== row.value || exact.expectedSelected !== row.expectedSelected ||
      exact.expectedGroupSelection !== row.expectedGroupSelection) return 'changed';
  // This policy can change during the descriptor's own I/O and uniqueness checks.
  const latest = await getSession(row.sessionId);
  const afterLatest = policy();
  if (afterLatest) return afterLatest;
  if (!latest || latest.conversationId !== row.conversationId ||
      (latest.bindingRevision ?? 0) !== row.bindingRevision) return 'unavailable';
  return null;
}

/** @internal Main-private cleanup of an ALREADY PERSISTED AND CLAIMED pre-dispatch row.
 * This method issues no intent, browser authority, grant or native result. No IPC/bridge
 * caller is registered. Unclaimed and potentially dispatched records stay untouched. */
export function reconcileInertRichAction(sessionId: string, id: string): Promise<RichActionResult> {
  return enqueueRichTransition(async () => {
    if (typeof sessionId !== 'string' || !SESSION.test(sessionId) || !uuid(id) ||
        await restoreNow() !== 'valid' || !snapshot) return unavailable();
    const row = snapshot.actions.find(action => action.sessionId === sessionId && action.id === id);
    // Retry custody is a separate schema and may not pass through native controls.
    if (!row || row.kind === 'retry_capture') return unavailable();
    if (row.phase === 'may_have_dispatched')
      return { id, state: 'unknown', detail: 'Outcome unconfirmed; no repeat authorized' };
    if (row.phase === 'retired') {
      const receipt = snapshot.receipts.find(saved => saved.id === id);
      return receipt ? { ...receipt } : unavailable();
    }
    if (!row.claimOwner || !['intent', 'opening_spent', 'elected'].includes(row.phase)) return unavailable();
    try {
      const first = await inertInvalidation(row);
      if (first === 'defer') return unavailable();
      if (!first) return { id, state: 'pending', detail: null };
      // Recheck the current physical source BEFORE the final disk comparison.
      // Any awaited descriptor read can permit an independent ledger replacement.
      const outcome = await inertInvalidation(row);
      if (outcome === 'defer') return unavailable();
      if (!outcome) return { id, state: 'pending', detail: null };
      // This is the LAST awaited source check's successor, not its predecessor.
      // It detects a replacement during that check but is NOT a cross-process
      // filesystem compare-and-swap: another process may replace after this read.
      const physical = await readDurableStrict(LEDGER);
      if (physical.kind !== 'valid' || !snapshot ||
          JSON.stringify(parseLedger(physical.value)) !== JSON.stringify(snapshot)) {
        quarantineRichActions();
        return unavailable();
      }
      if (pendingRecordingOffDecision()) return unavailable();
      const resultDetail = outcome === 'changed' ? 'Canonical rich control changed' : 'Native interaction unavailable';
      const allRows: Array<RichActionRecord | RichRetryRecord> = [...snapshot.actions];
      const controlSnapshot: RichActionSnapshot = { version: 1,
        actions: allRows.filter((item): item is RichActionRecord => item.kind !== 'retry_capture'),
        receipts: snapshot.receipts.filter(item => snapshot!.actions.some(action =>
          action.kind !== 'retry_capture' && action.id === item.id)) };
      const reduced = reduceInertRichActionSnapshot(controlSnapshot, {
        kind: 'retire', expected: row, owner: row.claimOwner, outcome, detail: resultDetail
      });
      if (reduced.kind !== 'changed' || !durableStoreReady()) return unavailable();
      const next: RichLedgerSnapshot = snapshot.version === 1 ? reduced.snapshot : {
        version: 2, actions: snapshot.actions.map(item => item.id === row.id
          ? reduced.snapshot.actions.find(changed => changed.id === row.id)! : item),
        receipts: [...snapshot.receipts, ...reduced.snapshot.receipts.filter(item =>
          !snapshot!.receipts.some(existing => existing.id === item.id))]
      };
      if (!parseLedger(next)) return unavailable();
      // Physically publish the record and receipt together before updating memory or
      // acknowledging. A failed/ambiguous rename is quarantined, including retained retries.
      await writeDurableNow(LEDGER, next, { retryOnFailure: false });
      const committed = await readDurableStrict(LEDGER);
      if (committed.kind !== 'valid' ||
          JSON.stringify(parseLedger(committed.value)) !== JSON.stringify(next)) {
        quarantineRichActions();
        return unavailable();
      }
      snapshot = next;
      return { id, state: outcome, detail: resultDetail };
    } catch {
      quarantineRichActions();
      return unavailable();
    }
  });
}

export function readRichActionStatus(sessionId: string, id: string): Promise<RichActionResult> {
  return enqueueRichTransition(async () => {
    if (typeof sessionId !== 'string' || !SESSION.test(sessionId) || !uuid(id) ||
        await restoreNow() !== 'valid' || !snapshot) return unavailable();
    const action = snapshot.actions.find(row => row.id === id && row.sessionId === sessionId);
    if (!action) return unavailable();
    if (action.phase === 'retired') {
      const receipt = snapshot.receipts.find(row => row.id === action.id);
      return receipt ? { ...receipt } : unavailable();
    }
    if (action.phase === 'may_have_dispatched' || action.phase === 'dispatch_spent') {
      return { id, state: 'unknown', detail: 'Outcome unconfirmed; no repeat authorized' };
    }
    if (action.kind === 'retry_capture' && !freshRetryIds.has(action.id)) return unavailable();
    return { id, state: 'pending', detail: null };
  });
}

/** @internal UNWIRED main-private state checkpoint for future PAGE Retry wiring.
 * The caller's predicate is an additional cancellation fence, NOT authenticated
 * user intent or Chrome proof. This returns state ONLY: no offer/ticket/tab/click.
 * The later action owner MUST independently prove physical source, UI gesture,
 * selected generation and Chrome source at every real authority boundary. */
export function checkpointInertRichRetry(
  transition: unknown, stillCurrent: () => boolean
): Promise<{ kind: 'refused' | 'changed' | 'unchanged' }> {
  return enqueueRichTransition(async () => {
    const refused = { kind: 'refused' as const };
    const current = (): boolean => {
      try { return typeof stillCurrent === 'function' && stillCurrent() === true; }
      catch { return false; }
    };
    if (!current() || !durableStoreReady()) return refused;
    const state = await restoreNow();
    if ((state !== 'valid' && state !== 'absent') || !snapshot || !current()) return refused;
    const reduced = reduceInertRichRetrySnapshot(snapshot, transition);
    if (reduced.kind === 'refused') return refused;
    if (reduced.kind === 'unchanged') return { kind: 'unchanged' as const };
    const changed = reduced.snapshot.actions.find(action => action.kind === 'retry_capture' &&
      !snapshot!.actions.some(prior => prior.id === action.id &&
        JSON.stringify(prior) === JSON.stringify(action))) as RichRetryRecord | undefined;
    if (!changed || !recordingWriteAllowed(changed.recordingRevision) ||
        recordingGenerationGrant() !== changed.recordingGeneration ||
        getRecordingRevision() !== changed.recordingRevision || !current()) return refused;
    // Store has no durable removal incarnation yet. Its schema may carry one for
    // future compatibility, but Cut1 cannot persist a purported removed override.
    if (changed.confirmRemoved) return refused;
    const prior = snapshot.actions.find(item => item.kind === 'retry_capture' && item.id === changed.id);
    if (prior && !freshRetryIds.has(changed.id) && changed.phase !== 'retired') return refused;
    if (prior && !freshRetryIds.has(changed.id) && changed.phase === 'retired' &&
        !(prior.kind === 'retry_capture' && prior.dispatchSpent &&
          reduced.snapshot.receipts.some(item => item.id === changed.id && item.state === 'unknown'))) return refused;
    try {
      // A serial in-process queue is insufficient against an independent disk
      // writer. Verify this exact physical predecessor immediately before commit.
      const physical = await readDurableStrict(LEDGER);
      if ((physical.kind !== 'absent' || state !== 'absent') &&
          (physical.kind !== 'valid' || state !== 'valid' ||
            JSON.stringify(parseLedger(physical.value)) !== JSON.stringify(snapshot))) {
        quarantineRichActions();
        return refused;
      }
      if (!current() || !recordingWriteAllowed(changed.recordingRevision) ||
          recordingGenerationGrant() !== changed.recordingGeneration) return refused;
      await writeDurableNow(LEDGER, reduced.snapshot, { retryOnFailure: false });
      const readback = await readDurableStrict(LEDGER);
      if (readback.kind !== 'valid' ||
          JSON.stringify(parseRichRetryLedgerSnapshot(readback.value)) !== JSON.stringify(reduced.snapshot) ||
          !current() || !recordingWriteAllowed(changed.recordingRevision) ||
          recordingGenerationGrant() !== changed.recordingGeneration) {
        quarantineRichActions();
        return refused;
      }
      snapshot = reduced.snapshot;
      loaded = 'valid';
      if (!prior) freshRetryIds.add(changed.id);
      return { kind: 'changed' as const };
    } catch {
      // Even a rename which physically succeeded before throwing cannot be
      // replayed: the whole in-process ledger is quarantined until fresh restore.
      quarantineRichActions();
      return refused;
    }
  });
}

// No action allocation, claims, tab openings, native dispatch or grants. A separate
// main-private reconciliation may only durably retire an invalidated existing claim.
export async function beginRichAction(_intent: RichActionIntent): Promise<RichActionResult> {
  return unavailable();
}
export async function electRichAction(_id: string, _tabId: number | null,
  _documentId: string | null, _navigationEpoch: number | null): Promise<boolean> {
  return false;
}
export async function armRichAction(_id: string, _documentId: string,
  _navigationEpoch: number): Promise<boolean> {
  return false;
}
export async function finishRichAction(_id: string, _outcome: 'observed' | 'unknown' | 'changed' | 'unavailable',
  _detail: string): Promise<RichActionResult> {
  return unavailable();
}

/** Test-only reset: no disk mutation, admission override or click authority. */
export function resetRichActionsForTests(): void {
  loaded = 'not_loaded';
  snapshot = null;
  transitionQueue = Promise.resolve();
  freshRetryIds.clear();
}
