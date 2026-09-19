/**
 * Task 11's INERT durable native-action foundation. This module accepts no production intent,
 * claim, tab opening, election, dispatch or result. It exposes only strictly read-only status
 * from a versioned snapshot. Current main-owned UI selection, live provider input proof and
 * Chrome registered-document action leases DO NOT exist yet; no historical descriptor can
 * substitute for them. Do not wire these functions to HTTP, IPC or a browser executor.
 */
import { durableStoreReady, readDurableStrict } from './durable.js';

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

let transitionQueue = Promise.resolve();
let loaded: 'not_loaded' | 'absent' | 'valid' | 'quarantined' = 'not_loaded';
let snapshot: RichActionSnapshot | null = null;

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
    const parsed = parseRichActionSnapshot(read.value);
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
    if (action.phase === 'may_have_dispatched') {
      return { id, state: 'unknown', detail: 'Outcome unconfirmed; no repeat authorized' };
    }
    return { id, state: 'pending', detail: null };
  });
}

// Deliberately NO durable writes, action allocation, claims, tab openings or grants. Keeping
// named non-arming methods eases later review without publishing an unsafe half-bridge.
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
}
