/**
 * Durable session history.
 *
 * Deliberately separate from the in-memory diagnostics log in logger.ts. That log
 * stays small, redacted and RAM-only; this one is an explicit opt-in feature that
 * writes what actually happened to disk so a five-hour session can be recovered.
 *
 * Structured activity is append-only JSONL. ChatGPT messages are different: streaming
 * changes the content of one logical message, so storing each snapshot as another event
 * creates duplicate transcript rows by construction. New writes live as one atomically
 * replaceable shard per stable logical website identity. A legacy messages.json map is read
 * as an overlay until each record is naturally rewritten, avoiding a startup-wide migration.
 * Identity is decided by the page/Fiber producer before it gets here; this store never guesses
 * that two different website ids are one message from their text, turn or timing.
 *
 *   sessions/<id>/events.jsonl    tool/turn/error/activity events, append-only
 *   sessions/<id>/messages/*.json canonical user/assistant messages, one logical id per shard
 *   sessions/<id>/messages.json   legacy canonical map, read during lazy migration
 *   sessions/<id>/meta.json       the summary, rewritten atomically
 *   sessions/<id>/assets/<id>     screenshots and other binaries
 *   sessions/<id>/handoffs/<id>.json
 */

import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { isProModel } from '../../shared/chat-models.js';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from '../sharp.js';
import type {
  AssetRef,
  Handoff,
  ImageStorageClearMode,
  ImageStorageClearResult,
  ImageStorageInfo,
  NewSessionEvent,
  ReasoningEffort,
  RichMediaState,
  RichOrigin,
  SessionEvent,
  SessionOrigin,
  SessionSummary,
  StoredText
} from '../../shared/session.js';
import { continuationMarkerOf, eventTokens, MAX_TOOL_RESULT_TOKENS, normalizedToolOutcome, storedTextTokens, workSequence } from '../../shared/session.js';
import { parseRichResponse, type RichNode, type RichResponse } from '../../shared/rich-response.js';
import { parseRichOrigin } from './rich-response.js';
import { applyTurnIdentity, authoredTimeOf, chronological, injectedUserMessage, positionOf, projectTimeline,
  recordedRequestTurn, responseTurnId, type Chronological, type TimelineTurns } from '../../shared/chronology.js';
import { automaticTitle, firstTitleMessage, legacyContextTitle, refreshUserTitle } from './title.js';
import { agentPlanSchema, agentPlanUpdateSchema, MAX_AGENT_PLAN_BYTES, type AgentPlan, type AgentPlanUpdate } from '../../shared/agent-plan.js';
import { getConfig, getRecordingRevision, recordingGenerationGrant, recordingWriteAllowed, registerRecordingWriteDrain } from '../config.js';
import { logError, logInfo, logWarn } from '../logger.js';
import { isChatBlocked } from './blocked-chats.js';

/**
 * Caps on how much of a value is written *inline*, into the JSONL line itself.
 *
 * These are not caps on what is kept. Anything longer is written whole, redacted, as a
 * `.txt` asset beside the log and referenced by `StoredText.assetId`, so the exact
 * arguments of an edit and the exact output of a command stay recoverable however
 * large they were — which is the entire premise of calling this history the source of
 * truth. What the caps buy is a log whose lines a reader can still parse and a summary
 * pass can still skim.
 */
// A Compact & Resume handoff becomes the next chat's opening user message. This is a wire /
// storage safety bound, not the prompt's much smaller token budget. Keep enough headroom for
// legacy briefs without turning the carried document into an inline stub plus asset reference.
// Truly runaway messages still spill to assets through storeText().
export const MAX_USER_MESSAGE_CHARS = 256_000;
export const MAX_MESSAGE_CHARS = 12_000;
export const MAX_TOOL_ARGS_CHARS = 8_000;
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** Nothing is spilled to an overflow asset past this; a note records the shortfall. */
export const MAX_OVERFLOW_ASSET_CHARS = 8 * 1024 * 1024;
/** A single line that cannot be parsed back is dropped; this bounds the damage. */
const MAX_LINE_BYTES = 512 * 1024;
/** How many sessions the UI shows. Lookups and pruning still see every session. */
const MAX_LISTED_SESSIONS = 200;
/** Bound for legacy/model-facing full-list scans. Identity and retention use the uncapped cached catalog. */
const MAX_SCANNED_SESSIONS = 5_000;
/** Keep the uncapped authoritative scan fast without opening thousands of files at once. */
const ATTACHMENT_CATALOG_READ_CONCURRENCY = 64;

let root = '';
/**
 * Current-conversation misses already proven against this process's durable catalog.
 *
 * Browser activity polls repeatedly ask about chats this app has never recorded. Re-scanning
 * every session folder for the same negative answer is pure work. Positive ownership remains
 * sourced from metadata; this cache only remembers a miss, and every operation that can create
 * that exact current attachment invalidates its key before a later lookup may trust it.
 */
const missingCurrentConversations = new Set<string>();

interface AttachmentCatalog {
  /** Durable summary projection used for attachment identity and the renderer summary index. */
  summaries: Map<string, SessionSummary>;
  /** Durable closed-session order. Open sessions are overlaid live and excluded while paging. */
  orderedIds: string[];
  current: Map<string, Set<string>>;
  historical: Map<string, Set<string>>;
}

/**
 * Derived, rebuildable attachment index. Durable `meta.json` remains the authority.
 *
 * Some model-facing compatibility reads intentionally cap directory scans at 5,000. Conversation
 * identity and retention cannot use that cap: an arbitrary readdir prefix is not proof that an
 * older chat has no owner or is exempt from expiry. The catalog performs one uncapped,
 * crash-reconciling pass on first authoritative lookup, then normal `/activity`, renderer and
 * retention reads reuse it. Attachment mutations update it only after their durable write lands.
 */
let attachmentCatalog: AttachmentCatalog | null = null;
let attachmentCatalogLoading: Promise<AttachmentCatalog> | null = null;
/**
 * Invalidates an in-flight catalog build on ownership changes or when a live overlay retires.
 * Ordinary event/meta ticks do not touch it.
 */
let attachmentEpoch = 0;
const MAX_MISSING_CONVERSATION_CACHE = 1024;

function rememberMissingCurrentConversation(conversationId: string): void {
  missingCurrentConversations.add(conversationId);
  if (missingCurrentConversations.size <= MAX_MISSING_CONVERSATION_CACHE) return;
  const oldest = missingCurrentConversations.values().next().value as string | undefined;
  if (oldest) missingCurrentConversations.delete(oldest);
}

export function initSessionStore(userDataDir: string): void {
  root = path.join(userDataDir, 'sessions');
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  assetMutationEpoch = 0;
  assetWrittenEpoch.clear();
  removedAssetEpoch.clear();
  uncertainCleanupSessions.clear();
  sessionDeletionEpoch = 0;
  deletingSessions.clear();
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

export function sessionsRoot(): string {
  return root;
}

/**
 * Refuses to touch the disk before somebody has said where.
 *
 * `root` starts empty, and `path.join('', id)` is a *relative* path — so an uninitialised
 * store does not fail, it writes real session folders into whatever the process's working
 * directory happens to be. That stayed invisible for as long as recording was off by
 * default; the moment it was switched on, a test run began scattering recordings through
 * the repository. In the app proper this cannot happen — `initSessionStore` is called
 * during start-up — which is exactly why it needs to be loud rather than left to chance.
 */
function assertReady(): void {
  if (root === '') {
    throw new Error('The session store was used before initSessionStore() named a directory');
  }
}

function sessionDir(id: string): string {
  assertReady();
  return path.join(root, id);
}

/** Ids are generated here and never taken from a caller, so this is a sanity check. */
function assertSessionId(id: string): void {
  if (!/^[0-9a-z-]{8,64}$/i.test(id)) throw new Error('Invalid session id');
}

// ------------------------------------------------------------------ state

interface OpenSession {
  summary: SessionSummary;
  nextSeq: number;
  /** Highest durable journal/message seq already reflected by `summary`. */
  historySeq: number;
  /** Recent durable events, so incremental /activity polls do not reread the whole JSONL. */
  tail: SessionEvent[];
  /** Earliest cursor covered by tail; reopening starts with no journal rows cached. */
  tailFrom: number;
  activityHydrated: boolean;
  /** Serialises appends so two events can never interleave inside one line. */
  queue: Promise<void>;
  /** Canonical messages and background calls, replaced by stable message/call identity. */
  messages: Map<string, CanonicalEvent>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

const open = new Map<string, OpenSession>();
/** Synchronous admission fence across durable rebind and delayed live attachment publication. */
const pendingAttachmentTransitions = new Map<string, number>();
export function sessionAttachmentTransitionPending(id: string): boolean {
  return (pendingAttachmentTransitions.get(id) ?? 0) > 0;
}
/** One disk reconstruction per session; direct concurrent callers must share it. */
const opening = new Map<string, Promise<OpenSession>>();
interface DurableSessionSnapshot {
  summary: SessionSummary;
  messages: Map<string, CanonicalEvent>;
  historySeq: number;
  reconciled: boolean;
}
/** Read-only recovery also shares one durable high-water check/rebuild per session. */
const reconciling = new Map<string, Promise<DurableSessionSnapshot | null>>();
const MAX_EVENT_TAIL = 4096;
/** Hard ceiling for a bounded recent-history disk read. */
const MAX_RECENT_READ_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ASSET_BYTES = 192 * 1024 * 1024;
export const MAX_GLOBAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const sessionAssetUsage = new Map<string, number>();
let globalAssetUsage: number | null = null;
let assetWriteQueue = Promise.resolve();
let assetMutationEpoch = 0;
const assetWrittenEpoch = new Map<string, number>();
const removedAssetEpoch = new Map<string, number>();
/** A cleanup rename with an unprovable physical outcome must never leave a
 * cached pre-cleanup owner free to overwrite its canonical shard. This fence
 * covers the shared physical publication gate, including direct queue writers. */
const uncertainCleanupSessions = new Set<string>();
/** An explicit session deletion must also invalidate image reads already awaiting a queue. */
let sessionDeletionEpoch = 0;
const deletingSessions = new Set<string>();
/** First-sight recorder sessions write initial files outside the ordinary per-session queue. */
const recordingSessionCreations = new Set<Promise<SessionSummary>>();

// Config owns the Off transition. Drain only these existing writers while its
// admission gate is closed; do not invert asset -> session cleanup lock ordering
// or hold a session queue while awaiting an asset queue.
registerRecordingWriteDrain(async () => {
  await Promise.allSettled([...recordingSessionCreations]);
  await Promise.allSettled([...opening.values()]);
  // An admitted append can finish its queue and leave a delayed summary timer. Flush
  // those summaries inside this barrier so their physical meta/backup writes cannot
  // start after Off was acknowledged.
  // Every flush must settle before a failure releases the config admission gate.
  // Promise.all would reject while another session could still be writing meta.json.
  const metaFlushes = await Promise.allSettled([...open.values()].map(entry => flushSessionEntry(entry, true)));
  await assetWriteQueue;
  const failed = metaFlushes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
});

function enqueueAssetOperation<T>(operation: () => Promise<T>): Promise<T> {
  const work = assetWriteQueue.then(operation);
  assetWriteQueue = work.then(() => undefined, () => undefined);
  return work;
}

function localAssetKey(sessionId: string, assetId: string): string {
  return `${sessionId}\u0000${assetId}`;
}

function admittedAssets(sessionId: string, assets: readonly AssetRef[] | undefined): AssetRef[] | undefined {
  if (!assets) return undefined;
  const kept = assets.filter((asset) => {
    const key = localAssetKey(sessionId, asset.id);
    const writtenAt = assetWrittenEpoch.get(key);
    const removedAt = removedAssetEpoch.get(key);
    return writtenAt === undefined || removedAt === undefined || writtenAt >= removedAt;
  });
  return kept.length ? kept : undefined;
}

function deniedAssetIds(sessionId: string, assets: readonly AssetRef[] | undefined): string[] {
  if (!assets) return [];
  const admitted = new Set(admittedAssets(sessionId, assets)?.map((asset) => asset.id));
  return assets.filter((asset) => !admitted.has(asset.id)).map((asset) => asset.id);
}

function mergedRetiredAssetIds(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const ids = [...new Set(groups.flatMap((group) => group ?? []))];
  return ids.length ? ids : undefined;
}

type MessageEvent = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;
type NativeImageEvent = Extract<SessionEvent, { kind: 'native_image' }>;
type CanonicalEvent = MessageEvent | NativeImageEvent | Extract<SessionEvent, { kind: 'tool_call' }>;
type NewMessageEvent = MessageEvent extends infer Event
  ? Event extends MessageEvent
    ? Omit<Event, 'seq'>
    : never
  : never;
type NewNativeImageEvent = Omit<NativeImageEvent, 'seq' | 'origin'>;

/** Internal checkpoint field persisted beside the public summary projection. */
const META_HISTORY_SEQ = '__historySeq';
// Alias shards remain forensic history, so the watermark alone cannot tell whether
// their duplicate token/event contributions have already been removed from metadata.
const META_CANONICAL_PROJECTION = '__canonicalProjection';
const META_TOKEN_ESTIMATE = '__tokenEstimate';
type PersistedSummary = SessionSummary & { [META_HISTORY_SEQ]?: number; [META_CANONICAL_PROJECTION]?: number; [META_TOKEN_ESTIMATE]?: number };
interface MetaCheckpoint {
  summary: SessionSummary;
  /** Null means metadata written by a version that did not yet persist a history watermark. */
  historySeq: number | null;
  canonicalProjectionCurrent: boolean;
  tokenEstimateCurrent: boolean;
  /** Derived migration signal; never persisted. */
  outcomeCountersMissing: boolean;
  /** Derived final-message activity boundary was added after the original summaries. */
  activityBoundaryMissing: boolean;
}

function messageKey(event: SessionEvent | Omit<MessageEvent, 'seq'> | NewNativeImageEvent): string | null {
  if (event.kind === 'tool_call') return event.call?.callId ? `tool_call\u0000${event.call.callId}` : null;
  if (event.kind === 'native_image') return event.messageId && event.providerAssetId
    ? `native_image\u0000${event.messageId}\u0000${event.providerAssetId}` : null;
  return (event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId
    ? `${event.kind}\u0000${event.messageId}` : null;
}

/** Exact equality for the fixed StoredText wire shape without serialising large prose. */
function storedTextEqual(left: StoredText | undefined, right: StoredText | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.text === right.text &&
    left.truncated === right.truncated &&
    left.chars === right.chars &&
    left.assetId === right.assetId &&
    left.digest === right.digest
  );
}

/** Copy only own enumerable data descriptors; neither extra fields nor getters are metadata. */
function richMediaFields(value: unknown, required: readonly string[], allowed: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  try {
    if (Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length || keys.length > allowed.length ||
        keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : null;
  } catch { return null; }
}

const richMediaOpaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9:_-]{1,190}$/i.test(value);
const richMediaReasons = new Set(['not_loaded', 'unsupported', 'ambiguous', 'tainted', 'oversized', 'invalid', 'quota', 'removed']);
const pageSourceToken = /^src_[a-f0-9]{32}_([0-9a-z]{1,11})$/;

/** The isolated source observer uses a fresh random identity and its monotonic counter.
 * URLs, arbitrary caller aliases and a token paired with a different counter are invalid. */
function validPageSourceWitness(incarnation: unknown, sequence: unknown): incarnation is string {
  if (typeof incarnation !== 'string' || !Number.isSafeInteger(sequence) ||
      (sequence as number) < 1) return false;
  const match = pageSourceToken.exec(incarnation);
  return Boolean(match && (sequence as number).toString(36) === match[1]);
}

/** The complete persisted slot barrier is store-owned; legacy slots have no barrier.
 * A version alone means a new document must reacquire the source. A version plus
 * sequence but no incarnation means a same-document SPA transition must reacquire. */
function parsePageSource(value: unknown): NonNullable<RichMediaState['pageSource']> | null {
  const fields = richMediaFields(value, ['slotVersion'],
    ['slotVersion', 'sequence', 'incarnation', 'recordingRevision']);
  if (!fields || !Number.isSafeInteger(fields.slotVersion) || (fields.slotVersion as number) < 1 ||
      (fields.slotVersion as number) >= Number.MAX_SAFE_INTEGER ||
      (Object.hasOwn(fields, 'incarnation') && !Object.hasOwn(fields, 'sequence')) ||
      (Object.hasOwn(fields, 'incarnation') && !Object.hasOwn(fields, 'recordingRevision')) ||
      (Object.hasOwn(fields, 'recordingRevision') && (!Number.isSafeInteger(fields.recordingRevision) ||
        (fields.recordingRevision as number) < 0)) ||
      (Object.hasOwn(fields, 'sequence') && (!Number.isSafeInteger(fields.sequence) ||
        (fields.sequence as number) < 1))) return null;
  if (Object.hasOwn(fields, 'incarnation') &&
      !validPageSourceWitness(fields.incarnation, fields.sequence)) return null;
  return { slotVersion: fields.slotVersion as number,
    ...(Object.hasOwn(fields, 'sequence') ? { sequence: fields.sequence as number } : {}),
    ...(Object.hasOwn(fields, 'incarnation') ? { incarnation: fields.incarnation as string } : {}),
    ...(Object.hasOwn(fields, 'recordingRevision')
      ? { recordingRevision: fields.recordingRevision as number } : {}) };
}

/** Only metadata may enter this store seam. Task 6/10 must precede pixels and asset references. */
function parseMetadataRichMedia(value: unknown): RichMediaState | null {
  const fields = richMediaFields(value, ['mediaId', 'nodeId', 'source', 'status'],
    ['mediaId', 'nodeId', 'source', 'status', 'reason']);
  if (!fields || !richMediaOpaque(fields.mediaId) || !richMediaOpaque(fields.nodeId) ||
      (fields.status !== 'pending' && fields.status !== 'unavailable')) return null;
  const status = fields.status;
  if (status === 'pending'
    ? Object.hasOwn(fields, 'reason') && fields.reason !== 'not_loaded'
    : !richMediaReasons.has(fields.reason as string)) return null;
  const source = richMediaFields(fields.source, ['kind'],
    ['kind', 'nodeId', 'providerMessageId', 'providerAssetId']);
  if (!source) return null;
  let cleanSource: RichMediaState['source'];
  if (source.kind === 'page' && Object.keys(source).length === 2 &&
      source.nodeId === fields.nodeId) {
    cleanSource = { kind: 'page', nodeId: fields.nodeId };
  } else if (source.kind === 'native' && Object.keys(source).length === 3 &&
      typeof source.providerMessageId === 'string' && /^[a-z0-9-]{8,100}$/i.test(source.providerMessageId) &&
      richMediaOpaque(source.providerAssetId)) {
    cleanSource = { kind: 'native', providerMessageId: source.providerMessageId, providerAssetId: source.providerAssetId };
  } else return null;
  return { mediaId: fields.mediaId, nodeId: fields.nodeId, source: cleanSource, status,
    ...(Object.hasOwn(fields, 'reason') ? { reason: fields.reason as RichMediaState['reason'] } : {}) };
}

/** Persisted adjuncts may contain a private source barrier and future validated assets;
 * the public raw metadata parser above continues to reject both. */
function parseDurableRichMedia(value: unknown): RichMediaState | null {
  const fields = richMediaFields(value, ['mediaId', 'nodeId', 'source', 'status'],
    ['mediaId', 'nodeId', 'source', 'status', 'reason', 'previewWidth', 'previewHeight', 'asset', 'pageSource']);
  if (!fields) return null;
  const base = parseMetadataRichMedia({ mediaId: fields.mediaId, nodeId: fields.nodeId,
    source: fields.source, status: 'pending' });
  if (!base) return null;
  const hasBarrier = Object.hasOwn(fields, 'pageSource');
  if (hasBarrier && base.source.kind !== 'page') return null;
  const pageSource = hasBarrier ? parsePageSource(fields.pageSource) : null;
  if (hasBarrier && !pageSource) return null;
  const source = pageSource ? { pageSource } : {};
  if (fields.status === 'available') {
    // An available slot carrying a version-only (unwitnessed) barrier is invalid:
    // no future writer may publish bytes before a committed source incarnation.
    if (pageSource && !pageSource.incarnation) return null;
    if (Object.hasOwn(fields, 'reason') || !Number.isSafeInteger(fields.previewWidth) ||
        !Number.isSafeInteger(fields.previewHeight) || (fields.previewWidth as number) < 1 ||
        (fields.previewHeight as number) < 1 || (fields.previewWidth as number) > 1600 ||
        (fields.previewHeight as number) > 1600 ||
        (fields.previewWidth as number) * (fields.previewHeight as number) > 2_560_000) return null;
    const asset = richMediaFields(fields.asset, ['id', 'mimeType', 'bytes'], ['id', 'mimeType', 'bytes']);
    if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(asset.id) ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType as string) ||
        !Number.isSafeInteger(asset.bytes) || (asset.bytes as number) < 1 ||
        (asset.bytes as number) > MAX_ASSET_BYTES) return null;
    return { ...base, ...source, status: 'available', previewWidth: fields.previewWidth as number,
      previewHeight: fields.previewHeight as number, asset: asset as unknown as AssetRef };
  }
  const { pageSource: _barrier, ...metadata } = fields;
  const clean = parseMetadataRichMedia(metadata);
  return clean ? { ...clean, ...source } : null;
}

/** One opaque media identity must resolve to precisely one validated rich image node. */
function exactRichImageNode(rich: RichResponse, mediaId: string, nodeId: string): boolean {
  if (rich.status !== 'available') return false;
  let count = 0;
  const pending = [...rich.nodes];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === 'image' && node.mediaId === mediaId) {
      count++;
      if (node.id !== nodeId || count > 1) return false;
    }
    if (node.kind === 'group' || node.kind === 'control') pending.push(...node.children);
  }
  return count === 1;
}

/** Null means corrupt or mismatched durable predecessor; [] is a valid absent adjunct. */
function validatedRichMedia(value: unknown, rich: RichResponse, providerMessageId: string,
  maxVersion = Number.MAX_SAFE_INTEGER): RichMediaState[] | null {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value > 64 ||
        length.value < 0 || length.enumerable || length.configurable ||
        Reflect.ownKeys(value).length !== length.value + 1) return null;
    const clean: RichMediaState[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < length.value; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field?.enumerable || !('value' in field)) return null;
      const media = parseDurableRichMedia(field.value);
      if (!media || ids.has(media.mediaId) || !exactRichImageNode(rich, media.mediaId, media.nodeId) ||
          (media.pageSource && media.pageSource.slotVersion > maxVersion) ||
          (media.source.kind === 'native' && media.source.providerMessageId !== providerMessageId)) return null;
      ids.add(media.mediaId);
      clean.push(media);
    }
    return clean;
  } catch { return null; }
}

/** Legacy metadata-only removals have exactly two fields and NEVER acquire a
 * cleanup credential on read, hydration or generic metadata upsert. Only physical
 * explicit cleanup may persist the four-field variant. This local subtype remains
 * structurally compatible with the narrower shared session display type. */
type RetiredRichMediaSlot = { mediaId: string; nodeId: string } &
  ({ removalIncarnation?: never; retiredAssetId?: never } |
   { removalIncarnation: string; retiredAssetId: string });
const MAX_RETIRED_RICH_MEDIA_SLOTS = 4096;
const removalIncarnationUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const retiredRichImageAssetId = /^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/;

/** Removal is a canonical logical-slot fact, not a byte hash or a currently mounted IMG.
 * A temporarily absent node must not drop this fence and permit passive recapture later. */
function parsedRetiredRichMediaSlots(value: unknown): RetiredRichMediaSlot[] | null {
  if (value === undefined) return [];
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_RETIRED_RICH_MEDIA_SLOTS ||
        Reflect.ownKeys(value).length !== value.length + 1) return null;
    const clean: RetiredRichMediaSlot[] = [];
    const seen = new Set<string>();
    const incarnations = new Set<string>();
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor) || !descriptor.value ||
          typeof descriptor.value !== 'object' || Array.isArray(descriptor.value) ||
          ![null, Object.prototype].includes(Object.getPrototypeOf(descriptor.value))) return null;
      const fields = richMediaFields(descriptor.value, ['mediaId', 'nodeId'],
        ['mediaId', 'nodeId', 'removalIncarnation', 'retiredAssetId']);
      if (!fields || !richMediaOpaque(fields.mediaId) || !richMediaOpaque(fields.nodeId) ||
          seen.has(fields.mediaId)) return null;
      seen.add(fields.mediaId);
      const hasIncarnation = Object.hasOwn(fields, 'removalIncarnation');
      const hasAsset = Object.hasOwn(fields, 'retiredAssetId');
      if (hasIncarnation !== hasAsset || (hasIncarnation &&
          (typeof fields.removalIncarnation !== 'string' ||
           !removalIncarnationUUID.test(fields.removalIncarnation) ||
           incarnations.has(fields.removalIncarnation.toLowerCase()) ||
           typeof fields.retiredAssetId !== 'string' ||
           !retiredRichImageAssetId.test(fields.retiredAssetId)))) return null;
      if (hasIncarnation) {
        incarnations.add((fields.removalIncarnation as string).toLowerCase());
        clean.push({ mediaId: fields.mediaId, nodeId: fields.nodeId,
          removalIncarnation: fields.removalIncarnation as string,
          retiredAssetId: fields.retiredAssetId as string });
      } else clean.push({ mediaId: fields.mediaId, nodeId: fields.nodeId });
    }
    return clean;
  } catch { return null; }
}

function mergedRetiredRichMediaSlots(
  prior: readonly RetiredRichMediaSlot[], additions: readonly RetiredRichMediaSlot[]
): RetiredRichMediaSlot[] | null {
  const merged = [...prior];
  const known = new Map(prior.map(slot => [slot.mediaId, slot.nodeId]));
  for (const slot of additions) {
    const existing = known.get(slot.mediaId);
    if (existing !== undefined && existing !== slot.nodeId) return null;
    if (existing === undefined) {
      if (merged.length >= MAX_RETIRED_RICH_MEDIA_SLOTS) return null;
      known.set(slot.mediaId, slot.nodeId);
      // Preserve the exact previously parsed two- or four-field value. Merging
      // metadata must never manufacture or silently upgrade a legacy tombstone.
      merged.push({ ...slot });
    }
  }
  return merged;
}

/** An assistant-wide floor closes the gap when a rich revision omits a PAGE slot,
 * or a changed authored message removes rich entirely. The slot can reappear later,
 * but a stale earlier expectedVersion=0 must never become valid again. */
function richSourceVersionFloor(row: Extract<SessionEvent, { kind: 'assistant_message' }>): number | null {
  if (row.richSourceVersionFloor === undefined) return 0;
  return Number.isSafeInteger(row.richSourceVersionFloor) && row.richSourceVersionFloor > 0 &&
    Number.isSafeInteger(row.seq) && row.richSourceVersionFloor <= row.seq
    ? row.richSourceVersionFloor : null;
}

/** Derive inert PAGE slots solely from a validated rich tree on an explicitly verified write.
 * Prior same-document metadata has already been validated against its original tree. A reused
 * media id on another image is ambiguous: neither old state nor a fresh pending slot may win. */
function seededPageRichMedia(
  rich: RichResponse, prior: readonly RichMediaState[], removed: readonly RetiredRichMediaSlot[],
  sameOrigin: boolean, sameDocument: boolean, sourceFloor: number, recordingRevision: number
): RichMediaState[] | null {
  const priorById = new Map(prior.map(item => [item.mediaId, item]));
  const removedById = new Map(removed.map(item => [item.mediaId, item.nodeId]));
  const seen = new Set<string>();
  const media: RichMediaState[] = [];
  const nodes = [...rich.nodes].reverse();
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.kind === 'group' || node.kind === 'control') {
      for (let index = node.children.length - 1; index >= 0; index--) nodes.push(node.children[index]!);
    } else if (node.kind === 'image') {
      if (seen.has(node.mediaId) || media.length >= 64) return null;
      seen.add(node.mediaId);
      const existing = priorById.get(node.mediaId);
      if (existing && existing.nodeId !== node.id) return null;
      const removedNode = removedById.get(node.mediaId);
      if (removedNode !== undefined && (removedNode !== node.id || existing?.status === 'available')) return null;
      const sameSourceOwner = sameOrigin && (!existing?.pageSource ||
        existing.pageSource.recordingRevision === undefined ||
        existing.pageSource.recordingRevision === recordingRevision);
      // A source witness belongs to its original physical document and SPA. Never carry
      // previously available pixels into an independently observed owner; retain only
      // the store version so a late old capture cannot publish after A→B→A.
      const staleSource = existing?.pageSource && !sameSourceOwner
        ? { slotVersion: existing.pageSource.slotVersion,
          ...(sameDocument && existing.pageSource.sequence !== undefined
            ? { sequence: existing.pageSource.sequence } : {}) }
        : !existing && sourceFloor > 0 ? { slotVersion: sourceFloor } : null;
      const pending: RichMediaState = { mediaId: node.mediaId, nodeId: node.id,
        source: { kind: 'page', nodeId: node.id }, status: 'pending', reason: 'not_loaded',
        ...(staleSource ? { pageSource: staleSource } : {}) };
      media.push(removedNode !== undefined
        ? existing?.status === 'unavailable' && existing.reason === 'removed' ? existing :
          { mediaId: node.mediaId, nodeId: node.id, source: { kind: 'page', nodeId: node.id },
            status: 'unavailable', reason: 'removed',
            ...(existing?.pageSource ? { pageSource: staleSource ?? existing.pageSource } : {}) }
        : sameSourceOwner && existing ? existing : pending);
    }
  }
  return media;
}

function emptySummary(id: string, title: string, conversationId: string | null): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    bindingRevision: 0,
    chatIds: conversationId ? [conversationId] : [],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    events: 0,
    timelineTurns: {},
    nativeQuestion: null,
    requestTurns: {},
    userMessages: 0,
    toolCalls: 0,
    lastToolCallAt: null,
    lastAssistantFinalAt: null,
    lastTurnEndAt: null,
    lastFinishReportAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastCommittedResumeHandoffId: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    finishTurn: null,
    agents: [],
    origin: null
  };
}

/**
 * Persists one summary atomically, without any live-entry bookkeeping.
 *
 * Split out so a *staged* summary can be written before it is published into memory. That
 * ordering is what makes the compaction rebind safe to fail: see rebindSession.
 */
async function writeSummary(summary: SessionSummary, historySeq: number): Promise<void> {
  const dir = sessionDir(summary.id);
  const target = path.join(dir, 'meta.json');
  const backup = path.join(dir, 'meta.backup.json');
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const persisted: PersistedSummary = { ...summary, [META_HISTORY_SEQ]: historySeq, [META_CANONICAL_PROJECTION]: 1, [META_TOKEN_ESTIMATE]: 1 };
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), 'utf8');
    // Preserve the last validated checkpoint. Never copy arbitrary corrupt bytes over the
    // backup: parse/id validation is what makes this a recovery source rather than a second
    // name for the same damage.
    try {
      const current = JSON.parse(await fs.readFile(target, 'utf8')) as SessionSummary;
      if (current?.id === summary.id) {
        const backupTmp = `${backup}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(backupTmp, JSON.stringify(current, null, 2), 'utf8');
          await fs.rename(backupTmp, backup);
        } finally {
          await fs.rm(backupTmp, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // First write, or an already damaged primary. Keep any existing valid backup.
    }
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function writeMeta(entry: OpenSession): Promise<void> {
  await writeSummary(entry.summary, entry.historySeq);
  // The attachment catalog is also the process-lifetime summary index used by the paged UI.
  // Ordinary event ticks stay in `open` and are overlaid live, but once metadata is actually
  // written keep the cached durable projection current too. Do not rebuild attachment maps:
  // rename/end/token changes do not change conversation ownership.
  publishCachedSummary(entry.summary, false);
  entry.metaDirty = false;
}

function enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T> {
  const work = entry.queue.then(operation);
  entry.queue = work.then(
    () => undefined,
    (err: Error) => logError(`session ${label} failed: ${err.message}`)
  );
  return work;
}

/** Only transcript and media admission uses this refusal. Existing history, outbox control,
 * cleanup, handoff recovery and the completion of a previously recorded process continue. */
export class RecordingDisabledError extends Error {
  readonly code = 'RECORDING_DISABLED';
  constructor() { super('Recording is disabled'); }
}

export function isRecordingDisabledError(error: unknown): error is RecordingDisabledError {
  return error instanceof RecordingDisabledError;
}

function requireRecording(revision: number): void {
  if (!getConfig().sessions.record || !recordingWriteAllowed(revision)) throw new RecordingDisabledError();
}

/** These are durable control markers; Off must not interrupt an accepted compaction/finish. */
function isRecordingControl(event: NewSessionEvent): boolean {
  return event.kind === 'handoff' || (event.kind === 'progress' && !!event.finishControl);
}

/**
 * The summary is rewritten on a short delay rather than on every event. A long agent
 * session appends thousands of events; rewriting the summary for each one would turn
 * an append-only log into a write-amplified one for no benefit.
 */
function scheduleMeta(entry: OpenSession): void {
  entry.metaDirty = true;
  if (entry.metaTimer) return;
  entry.metaTimer = setTimeout(() => {
    entry.metaTimer = null;
    void enqueueSessionOperation(entry, 'meta write', async () => {
      if (entry.metaDirty) await writeMeta(entry);
    });
  }, 1500);
  entry.metaTimer.unref?.();
}

/** Flushes any pending summary write. Called before the app quits and before reads. */
export async function flushSessions(): Promise<void> {
  for (const entry of open.values()) {
    await flushSessionEntry(entry);
  }
}

/**
 * Waits only for mutations that belong to one session, then makes its summary current on disk.
 *
 * A read of session A must not become a global write barrier for every other open session.
 * Besides the avoidable latency, the old `flushSessions()` call meant polling one chat could
 * force metadata churn for dozens of unrelated generating chats. The per-session queue already
 * is the serialization boundary, so joining that target queue is both sufficient and stronger:
 * it also waits for an in-flight reconstruction of this exact session before deciding whether
 * there is anything live to flush.
 */
async function flushSession(sessionId: string): Promise<void> {
  let entry = open.get(sessionId);
  if (!entry) {
    const reconstructing = opening.get(sessionId);
    if (reconstructing) entry = await reconstructing;
  }
  if (entry) await flushSessionEntry(entry);
}

async function flushSessionEntry(entry: OpenSession, strict = false): Promise<void> {
  if (entry.metaTimer) {
    clearTimeout(entry.metaTimer);
    entry.metaTimer = null;
  }
  const flush = enqueueSessionOperation(entry, 'meta flush', async () => {
    if (entry.metaDirty) await writeMeta(entry);
  });
  if (strict) await flush;
  else await flush.catch(() => undefined);
}

// ----------------------------------------------------------------- create

export function createSession(options: {
  /** Reserved by an accepted opening outbox row; never supplied by model tools. */
  reservedId?: string;
  title?: string;
  titleSource?: SessionSummary['titleSource'];
  conversationId?: string | null;
  origin?: SessionOrigin | null;
  /** Recorder's original admission epoch; omitted for independent outbox/control reservations. */
  recordingRevision?: number;
}): Promise<SessionSummary> {
  if (options.recordingRevision !== undefined) {
    try { requireRecording(options.recordingRevision); }
    catch (error) { return Promise.reject(error); }
  }
  const creating = createSessionFiles(options);
  if (options.recordingRevision !== undefined) {
    recordingSessionCreations.add(creating);
    void creating.finally(() => recordingSessionCreations.delete(creating)).catch(() => undefined);
  }
  return creating;
}

async function createSessionFiles(options: Parameters<typeof createSession>[0]): Promise<SessionSummary> {
  const id = options.reservedId ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  assertSessionId(id);
  if (options.reservedId) {
    const existing = await getSession(id);
    if (existing) {
      if (existing.origin?.kind !== 'desktop') throw new Error('Reserved opening session belongs to different work');
      return existing;
    }
  }
  const summary = emptySummary(id, options.title?.trim() || 'ChatGPT session', options.conversationId ?? null);
  summary.origin = options.origin ?? null;
  if (options.titleSource) summary.titleSource = options.titleSource;
  if (options.origin?.fromSessionId) {
    const source = await getSession(options.origin.fromSessionId);
    if (source?.projectId) summary.projectId = source.projectId;
  }
  // A prior asynchronous owner/title lookup cannot start a first recording after Off
  // has closed admission. Once creation begins, config awaits the whole promise.
  if (options.recordingRevision !== undefined) requireRecording(options.recordingRevision);
  // Invalidate before exposing the in-flight live entry. A cached miss must never hide a
  // session that this process has started creating, even while its first durable write awaits.
  if (summary.conversationId) missingCurrentConversations.delete(summary.conversationId);
  const entry: OpenSession = {
    summary,
    nextSeq: 1,
    historySeq: 0,
    tail: [],
    tailFrom: 1,
    activityHydrated: true,
    queue: Promise.resolve(),
    messages: new Map(),
    metaDirty: false,
    metaTimer: null
  };
  // An opening becomes visible in `open` before its first metadata checkpoint.
  // A capture may resolve that live A, but must not mint attachment authority
  // until the first durable meta and attachment index publication are complete.
  pendingAttachmentTransitions.set(id, (pendingAttachmentTransitions.get(id) ?? 0) + 1);
  open.set(id, entry);
  try {
    await fs.mkdir(sessionDir(id), { recursive: true });
    // A missing shard directory after publication could hide lost owners. Create it
    // even for empty sessions so cleanup can treat later absence as unknown.
    await fs.mkdir(path.join(sessionDir(id), 'messages'), { recursive: true });
    await fs.writeFile(path.join(sessionDir(id), 'events.jsonl'), '', { flag: 'a' });
    // A reserved opening can retry after its shard was created but meta publication failed.
    // Never append another object or overwrite already-recorded canonical messages.
    await fs.writeFile(path.join(sessionDir(id), 'messages.json'), '{}', { flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await writeMeta(entry);
    publishAttachmentSummary(entry.summary);
  } catch (error) {
    if (open.get(id) === entry) open.delete(id);
    throw error;
  } finally {
    const remaining = (pendingAttachmentTransitions.get(id) ?? 1) - 1;
    if (remaining > 0) pendingAttachmentTransitions.set(id, remaining);
    else pendingAttachmentTransitions.delete(id);
  }
  return { ...summary };
}

// ----------------------------------------------------------------- append

/** Reads the highest seq already on disk, so a restart never reuses a number. */
async function lastSeqOnDisk(id: string): Promise<number> {
  try {
    const file = path.join(sessionDir(id), 'events.jsonl');
    const stat = await fs.stat(file);
    // One valid event line may be almost MAX_LINE_BYTES and a crash can leave another
    // almost-full torn line after it. Read enough for both, otherwise the only parseable
    // predecessor can sit outside the tail window and restart would reuse sequence 1.
    const from = Math.max(0, stat.size - (MAX_LINE_BYTES * 2 + 2));
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionEvent;
          if (typeof parsed.seq === 'number') return parsed.seq;
        } catch {
          // A torn final line is expected after a crash; keep looking backwards.
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // No file yet, or unreadable: start from zero and let the append recreate it.
  }
  return 0;
}

/**
 * Closes off a torn last line before anything is appended after it.
 *
 * A crash mid-append leaves a line with no newline. Appending straight onto it would
 * glue a perfectly good new event onto the wreckage and lose that one too, so the
 * damage is sealed with a newline first: one event lost, which is the promise.
 */
async function sealTornTail(id: string): Promise<void> {
  const file = path.join(sessionDir(id), 'events.jsonl');
  try {
    const stat = await fs.stat(file);
    if (stat.size === 0) return;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, stat.size - 1);
      if (buffer[0] === 0x0a) return;
    } finally {
      await handle.close();
    }
    await fs.appendFile(file, '\n', 'utf8');
    logWarn(`session ${id}: sealed an unterminated final line before appending`);
  } catch {
    // No file yet, or unreadable: the append will recreate it.
  }
}

/** Canonical message snapshot file. Unknown/legacy shapes are ignored, never guessed. */
async function readCanonicalMessages(id: string, aliasesCollapsed?: () => void): Promise<Map<string, CanonicalEvent>> {
  const out = new Map<string, CanonicalEvent>();
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const event = value as CanonicalEvent;
      if ((event.kind !== 'user_message' && event.kind !== 'assistant_message' && event.kind !== 'native_image' && event.kind !== 'tool_call') || typeof event.seq !== 'number') continue;
      const expected = messageKey(event);
      if (!expected || expected !== key) continue;
      out.set(key, event);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`session ${id}: canonical message file unreadable; legacy event log remains available`);
    }
  }
  // Incremental shards overlay the legacy whole-map snapshot. This makes migration lazy:
  // the first post-upgrade revision writes only its own logical message, while untouched
  // history remains readable from messages.json.
  const shards = path.join(sessionDir(id), 'messages');
  try {
    const names = await fs.readdir(shards);
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const raw = await fs.readFile(path.join(shards, name), 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) continue;
        const event = JSON.parse(raw) as CanonicalEvent;
        const key = messageKey(event);
        if (!key) continue;
        const expectedName = `${createHash('sha256').update(key).digest('hex')}.json`;
        if (expectedName !== name) continue;
        out.set(key, event);
      } catch {
        logWarn(`session ${id}: ignored unreadable canonical message shard ${name}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`session ${id}: canonical message shards unreadable`);
  }
  // Older builds persisted reload timestamp aliases as separate shards. Project
  // those exact provider UUIDs as one message without deleting forensic history.
  // First observation owns chronology; the latest terminal revision owns content.
  const providers = new Map<string, Array<[string, Extract<MessageEvent, { kind: 'assistant_message' }>]>>();
  for (const [key, event] of [...out].sort(([, a], [, b]) => (a.origin ?? a.seq) - (b.origin ?? b.seq))) {
    if (event.kind !== 'assistant_message' || !event.providerMessageId) continue;
    const group = providers.get(event.providerMessageId) ?? [];
    group.push([key, event]);
    providers.set(event.providerMessageId, group);
  }
  for (const group of providers.values()) {
    if (group.length < 2) continue;
    aliasesCollapsed?.();
    const [firstKey, first] = group[0]!;
    // Keep the winning content's own seq intact until selection finishes: a later
    // streaming alias advances the read cursor but must not outrank a terminal revision.
    let latest = first, seq = first.seq;
    for (const [key, event] of group) {
      const latestFinal = latest.final === true || latest.state === 'final';
      const eventFinal = event.final === true || event.state === 'final';
      if (latestFinal !== eventFinal ? eventFinal : event.seq > latest.seq) latest = event;
      seq = Math.max(seq, event.seq);
      out.delete(key);
    }
    out.set(firstKey, { ...latest, messageId: first.messageId, origin: first.origin ?? first.seq,
      time: first.time, seq, turnId: group.find(([, event]) => event.turnId)?.[1].turnId,
      ...(group.some(([, event]) => event.goalEligible === true) ? { goalEligible: true } : {}) });
  }
  return out;
}

/** History reads may omit a damaged SHA shard, but a canonical write must inspect
 * its physical predecessor independently. ENOENT is the only absent owner; an
 * unreadable, mismatched or malformed existing shard remains forensic evidence. */
async function canonicalWritePredecessor(target: string, key: string, proposed: CanonicalEvent): Promise<{
  raw: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number
} | null> {
  const uncertain = (): Error => new Error('Canonical message predecessor is uncertain');
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw uncertain();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANONICAL_MESSAGE_BYTES) throw uncertain();
  const raw = await readBoundedOwnerSource(target, stat);
  if (raw === null) throw uncertain();
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw uncertain();
    const owner = stored as CanonicalEvent;
    if (!Number.isSafeInteger(owner.seq) || messageKey(owner) !== key) throw uncertain();
    if (owner.kind === 'assistant_message') {
      const removed = parsedRetiredRichMediaSlots(owner.retiredRichMediaSlots);
      const retiredAssets = owner.retiredRichImageAssetIds;
      const hasRetirementFields = owner.retiredRichMediaSlots !== undefined || retiredAssets !== undefined;
      if (removed === null || (retiredAssets !== undefined &&
          (!Array.isArray(retiredAssets) || retiredAssets.some(id => typeof id !== 'string'))) ||
          (cleanupRichMedia(owner) === null && (hasRetirementFields ||
            proposed.kind !== 'assistant_message' || proposed.richMedia !== undefined ||
            proposed.retiredRichMediaSlots !== undefined || proposed.retiredRichImageAssetIds !== undefined))) {
        throw uncertain();
      }
      // An ordinary text observation may scrub malformed legacy media only by
      // dropping it, and only when NO retirement field exists on either side.
      // A malformed retired owner remains physical deletion evidence.
    }
  } catch { throw uncertain(); }
  return { raw, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

async function writeCanonicalMessage(id: string, key: string, event: CanonicalEvent,
  stillAuthorized?: () => boolean): Promise<void> {
  if (uncertainCleanupSessions.has(id)) throw new Error('Canonical cleanup ownership is uncertain');
  const dir = path.join(sessionDir(id), 'messages');
  await fs.mkdir(dir, { recursive: true });
  const name = `${createHash('sha256').update(key).digest('hex')}.json`;
  const target = path.join(dir, name);
  const predecessor = await canonicalWritePredecessor(target, key, event);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(event);
  if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) {
    throw new Error('Canonical message is too large');
  }
  try {
    await fs.writeFile(tmp, text, 'utf8');
    // A private bridge lease can be revoked while this async temp write is in
    // progress. Check at the final atomic rename, not only when entering the
    // session queue. Canonical writers without private custody remain unchanged.
    if (uncertainCleanupSessions.has(id)) throw new Error('Canonical cleanup ownership is uncertain');
    if (stillAuthorized && !stillAuthorized()) throw new Error('page_pixel_ticket_revoked');
    const current = await canonicalWritePredecessor(target, key, event);
    if (JSON.stringify(current) !== JSON.stringify(predecessor)) {
      throw new Error('Canonical message predecessor is uncertain');
    }
    if (uncertainCleanupSessions.has(id)) throw new Error('Canonical cleanup ownership is uncertain');
    if (stillAuthorized && !stillAuthorized()) throw new Error('page_pixel_ticket_revoked');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Explicit slow-path reconstruction from the durable journal plus canonical message shards.
 *
 * A stale metadata checkpoint cannot be patched incrementally for canonical revisions: the
 * shard contains only the newest body, so the token weight of the superseded revision is gone.
 * Rebuild the history-derived projection exactly, then preserve metadata-only facts (title,
 * attachment lineage, compaction latch, close state) from the last valid checkpoint.
 */
async function rebuildSummaryFromHistory(
  id: string,
  messages: Map<string, CanonicalEvent>,
  checkpoint: SessionSummary | null,
  historySeq: number,
  preserveAttachmentTurn = false,
  migrateTokenEstimate = false
): Promise<SessionSummary> {
  const rebuilt = emptySummary(id, 'Recovered session', null);
  let sawProjected = false;
  let historicalReturnReduction = 0;
  const canonicalKeys = new Set(messages.keys());
  // Canonical shards are applied after the journal for token accounting. Response identity
  // instead follows original authored order; retain only the small identity fields here.
  const identities: Chronological[] = [];
  const collectIdentity = (event: SessionEvent): void => {
    if (!['user_message', 'turn_start', 'turn_end', 'tool_call'].includes(event.kind)) return;
    identities.push({ seq: event.seq, origin: positionOf(event), time: event.time, kind: event.kind,
      source: event.source, turnId: event.turnId,
      ...(event.kind === 'user_message' ? { messageId: event.messageId, inputId: event.inputId } : {}),
      ...(event.kind === 'tool_call' ? { call: { requestId: event.call.requestId,
        conversationId: event.call.conversationId, attribution: event.call.attribution } } : {}) });
  };
  let carry = Buffer.alloc(0);
  const handle = await fs.open(path.join(sessionDir(id), 'events.jsonl'), 'r').catch(() => null);
  const accept = (line: Buffer): void => {
    if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
    try {
      const event = JSON.parse(line.toString('utf8')) as SessionEvent;
      if (!event || typeof event.seq !== 'number' || typeof event.kind !== 'string') return;
      // Once a stable website message has a canonical shard, any old append-only snapshot with
      // the same identity is legacy storage for that same logical event, not another event.
      if (
        messageKey(event) &&
        canonicalKeys.has(messageKey(event)!)
      ) {
        return;
      }
      if (!sawProjected) {
        rebuilt.startedAt = event.time;
        rebuilt.updatedAt = event.time;
      }
      if (!sawProjected && event.kind === 'session_start') rebuilt.title = event.title || rebuilt.title;
      const eventConversation = 'conversationId' in event && typeof event.conversationId === 'string' ? event.conversationId : null;
      if (eventConversation) {
        rebuilt.conversationId = eventConversation;
        if (!rebuilt.chatIds.includes(eventConversation)) rebuilt.chatIds.push(eventConversation);
      }
      // Rebind already removed old frontends from current context. During estimation
      // migration, their return reductions belong only to the lifetime total.
      if (migrateTokenEstimate && event.kind === 'tool_call' && checkpoint?.conversationId &&
          event.call.conversationId && event.call.conversationId !== checkpoint.conversationId) {
        historicalReturnReduction += Math.max(0, storedTextTokens(event.call.result) - MAX_TOOL_RESULT_TOKENS);
      }
      applyToSummary(rebuilt, event);
      collectIdentity(event);
      sawProjected = true;
    } catch {
      // A torn or corrupt line costs that line, not the complete session projection.
    }
  };
  try {
    if (handle) {
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        let joined = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const newline = joined.indexOf(0x0a, start);
          if (newline < 0) break;
          accept(joined.subarray(start, newline));
          start = newline + 1;
        }
        carry = joined.subarray(start);
        if (carry.length > MAX_LINE_BYTES) carry = Buffer.alloc(0);
      }
      accept(carry);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  for (const message of [...messages.values()].sort((left, right) => left.seq - right.seq)) {
    if (!sawProjected) {
      rebuilt.startedAt = message.time;
      rebuilt.updatedAt = message.time;
    }
    applyToSummary(rebuilt, message);
    collectIdentity(message);
    sawProjected = true;
  }
  if (!sawProjected) {
    throw new Error(`Session ${id} has no recoverable metadata or history`);
  }

  rebuilt.timelineTurns = {}; rebuilt.requestTurns = {}; rebuilt.nativeQuestion = null;
  for (const event of identities.sort((a, b) => positionOf(a) - positionOf(b))) applyTurnIdentity(rebuilt, event);

  const summary = checkpoint
    ? {
        ...checkpoint,
        updatedAt: Math.max(checkpoint.updatedAt, rebuilt.updatedAt),
        events: rebuilt.events,
        timelineTurns: rebuilt.timelineTurns,
        requestTurns: rebuilt.requestTurns,
        nativeQuestion: rebuilt.nativeQuestion,
        userMessages: rebuilt.userMessages,
        toolCalls: rebuilt.toolCalls,
        lastToolCallAt: rebuilt.lastToolCallAt,
        lastAssistantFinalAt: rebuilt.lastAssistantFinalAt,
        lastTurnEndAt: rebuilt.lastTurnEndAt,
        lastFinishReportAt: rebuilt.lastFinishReportAt,
        processExitNonzero: rebuilt.processExitNonzero,
        toolRejected: rebuilt.toolRejected,
        toolInternalErrors: rebuilt.toolInternalErrors,
        errors: rebuilt.errors,
        estimatedTokens: rebuilt.estimatedTokens,
        // `contextTokens` may have been reset by a durable rebind, which is metadata-only and
        // therefore cannot be reconstructed from the event log. Every history mutation changes
        // lifetime/context token totals by the same delta, so applying the rebuilt lifetime delta
        // to the checkpoint preserves that reset while still recovering message revisions exactly.
        contextTokens: Math.max(0, checkpoint.contextTokens + (rebuilt.estimatedTokens - checkpoint.estimatedTokens) + historicalReturnReduction),
        lastHandoffId: rebuilt.lastHandoffId,
        lastHandoffAt: rebuilt.lastHandoffAt,
        lastTurnOutcome: rebuilt.lastTurnOutcome,
        activeTurnId: preserveAttachmentTurn ? checkpoint.activeTurnId ?? null : rebuilt.activeTurnId ?? null,
        finishTurn: rebuilt.finishTurn?.conversationId === checkpoint.conversationId ? rebuilt.finishTurn : null,
        agents: [...new Set([...checkpoint.agents, ...rebuilt.agents])]
      }
    : rebuilt;
  logWarn(`session ${id}: rebuilt metadata from durable event/message history`);
  await writeSummary(summary, historySeq);
  return summary;
}

/**
 * Reads the durable source of truth without making the session live.
 *
 * `meta.json` is a projection and can legitimately lag the journal or a canonical message
 * shard after a crash. Read-only callers still need the repaired projection, but routing them
 * through `ensureOpen()` would change lifetime semantics: merely viewing old history would put
 * it in `open` and make retention skip it. This helper performs the same high-water recovery
 * while leaving `open` untouched.
 */
async function readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null> {
  assertSessionId(id);
  const existing = reconciling.get(id);
  if (existing) return existing;
  const work = (async () => {
    let aliasesCollapsed = false;
    const messages = await readCanonicalMessages(id, () => { aliasesCollapsed = true; });
    let messageSeq = 0;
    for (const event of messages.values()) messageSeq = Math.max(messageSeq, event.seq);
    const journalSeq = await lastSeqOnDisk(id);
    const historySeq = Math.max(journalSeq, messageSeq);
    const checkpoint = await readMetaCheckpoint(id);
    const titleRepaired = checkpoint ? refreshUserTitle(checkpoint.summary, messages.values()) : false;

    // A pre-taxonomy checkpoint can have a current watermark but stale outcome classification.
    if (
      checkpoint?.historySeq === historySeq &&
      checkpoint.tokenEstimateCurrent &&
      (!aliasesCollapsed || checkpoint.canonicalProjectionCurrent) &&
      !checkpoint.outcomeCountersMissing &&
      !checkpoint.activityBoundaryMissing &&
      checkpoint.summary.timelineTurns !== undefined &&
      checkpoint.summary.requestTurns !== undefined &&
      checkpoint.summary.nativeQuestion !== undefined &&
      checkpoint.summary.finishTurn !== undefined
    ) {
      // A successful no-op migration is still a completed migration. Without this stamp,
      // every launch rereads all old transcripts that happened to contain no aliases.
      const migrated = !checkpoint.canonicalProjectionCurrent || titleRepaired;
      if (migrated) await writeSummary(checkpoint.summary, historySeq);
      return { summary: checkpoint.summary, messages, historySeq, reconciled: migrated };
    }
    if (checkpoint && historySeq === 0) {
      // Nothing to replay: stamp the empty legacy projection in place.
      const summary = {
        ...checkpoint.summary,
        ...(checkpoint.outcomeCountersMissing ? { errors: 0 } : {}),
        timelineTurns: {},
        nativeQuestion: null,
        requestTurns: {},
        lastToolCallAt: null,
        lastAssistantFinalAt: null,
        lastTurnEndAt: null,
        lastFinishReportAt: null,
        finishTurn: null
      };
      await writeSummary(summary, 0);
      return { summary, messages, historySeq: 0, reconciled: true };
    }
    if (!checkpoint && historySeq === 0) return null;

    const summary = await rebuildSummaryFromHistory(id, messages, checkpoint?.summary ?? null, historySeq, checkpoint?.historySeq === historySeq, !!checkpoint && !checkpoint.tokenEstimateCurrent);
    return { summary, messages, historySeq, reconciled: true };
  })();
  reconciling.set(id, work);
  try {
    return await work;
  } finally {
    if (reconciling.get(id) === work) reconciling.delete(id);
  }
}

async function readAuthoritativeSummary(id: string): Promise<SessionSummary | null> {
  const live = open.get(id);
  if (live) return live.summary;
  const becomingLive = opening.get(id);
  if (becomingLive) return (await becomingLive).summary;
  const snapshot = await readDurableSnapshot(id);
  if (!snapshot) return null;
  // If a process-lifetime catalog already exists, or one is concurrently being built and may
  // already have passed this row, invalidate/update it after a recovery write. The catalog's own
  // build calls readDurableSnapshot directly, so its normal stale-row repairs do not self-loop.
  if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
    publishAttachmentSummary(snapshot.summary);
  }
  return snapshot.summary;
}

async function ensureOpen(id: string): Promise<OpenSession> {
  assertSessionId(id);
  const existing = open.get(id);
  if (existing) return existing;
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const reconstruction = (async () => {
    await sealTornTail(id);
    const snapshot = await readDurableSnapshot(id);
    if (!snapshot) throw new Error(`Session ${id} has no recoverable metadata or history`);
    const entry: OpenSession = {
      summary: snapshot.summary,
      nextSeq: snapshot.historySeq + 1,
      historySeq: snapshot.historySeq,
      tail: [],
      tailFrom: snapshot.historySeq + 1,
      activityHydrated: false,
      queue: Promise.resolve(),
      messages: snapshot.messages,
      metaDirty: false,
      metaTimer: null
    };
    open.set(id, entry);
    if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
      publishAttachmentSummary(entry.summary);
    }
    return entry;
  })();
  opening.set(id, reconstruction);
  try {
    return await reconstruction;
  } finally {
    if (opening.get(id) === reconstruction) opening.delete(id);
  }
}

/** A hold-call result or app status is not evidence of new work. */
function noteFinishWork(summary: SessionSummary, event: SessionEvent): void {
  if (!summary.finishTurn || (event.turnId && event.turnId !== summary.finishTurn.turnId)) return;
  const meaningful = event.kind === 'user_message' || event.kind === 'assistant_message' ||
    (event.kind === 'progress' && event.source !== 'app') ||
    (event.kind === 'tool_call' && !['keep_astra_on_forever', 'session_finish'].includes(event.call.tool));
  if (meaningful) summary.finishTurn = { ...summary.finishTurn, workSeq: Math.max(summary.finishTurn.workSeq,
    workSequence(event)) };
}

function applyToSummary(summary: SessionSummary, event: SessionEvent): void {
  applyTurnIdentity(summary, event);
  summary.events += 1;
  // Never backwards. A tool call is written once the app knows which chat it belongs to,
  // which can be after the page has already reported the end of the turn it ran in, and
  // the call carries the time it started. Taking that literally would age a session back
  // to before its own last event and drop it down a list sorted by recency.
  summary.updatedAt = Math.max(summary.updatedAt, event.time);
  const tokens = eventTokens(event);
  summary.estimatedTokens += tokens;
  // What the attached chat is carrying. Reset by a compaction rebind; see rebindSession.
  summary.contextTokens += tokens;
  if (event.kind === 'user_message') summary.userMessages += 1;
  if (event.kind === 'tool_call') {
    summary.toolCalls += 1;
    summary.lastToolCallAt = Math.max(summary.lastToolCallAt ?? 0, event.time);
    if (event.call.endsActivity === true) {
      summary.lastFinishReportAt = Math.max(summary.lastFinishReportAt ?? 0, event.time);
    }
    const outcome = normalizedToolOutcome(event.call);
    if (outcome === 'process_exit_nonzero') summary.processExitNonzero += 1;
    if (outcome === 'tool_rejected') summary.toolRejected += 1;
    if (outcome === 'tool_internal_error') {
      summary.toolInternalErrors += 1;
      summary.errors += 1;
    }
  }
  if (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) {
    summary.lastAssistantFinalAt = Math.max(summary.lastAssistantFinalAt ?? 0, event.time);
  }
  if (event.kind === 'chat_error') summary.errors += 1;
  if (event.kind === 'turn_end') {
    summary.lastTurnOutcome = event.outcome;
    summary.lastTurnEndAt = Math.max(summary.lastTurnEndAt ?? 0, event.time);
  }
  if (event.kind === 'turn_start') {
    summary.activeTurnId = event.turnId ?? `seq-${event.seq}`;
    if (summary.finishTurn?.turnId !== summary.activeTurnId) summary.finishTurn = {
      turnId: summary.activeTurnId, conversationId: summary.conversationId, startedAt: event.time,
      notified: false, released: false, decisionRevision: null, workSeq: 0, decisionSeq: 0, decisionInputRevision: null
    };
  }
  if (event.kind === 'progress' && event.source === 'app' && event.turnId && summary.finishTurn?.turnId === event.turnId) {
    const finish = { ...summary.finishTurn };
    summary.finishTurn = finish;
    // IDs cover already-shipped event rows; new rows additionally carry typed control.
    if (event.progressId === `finish:${event.turnId}` || event.finishControl?.state === 'notified') finish.notified = true;
    const prefix = `finish-goal:${event.turnId}:`;
    const revision = event.finishControl?.state === 'decision' ? event.finishControl.revision
      : event.progressId?.startsWith(prefix) ? event.progressId.slice(prefix.length) : null;
    if (revision && /^[a-f0-9]{64}$/.test(revision) && finish.decisionRevision !== revision) {
      finish.decisionRevision = revision;
      finish.decisionAt = event.time;
      finish.decisionSeq = Number.isSafeInteger(event.finishControl?.workSeq) ? event.finishControl!.workSeq! : event.seq;
      finish.decisionInputRevision = event.finishControl?.inputRevision ?? null;
    } else if (revision === finish.decisionRevision && event.finishControl?.state === 'decision' && Number.isSafeInteger(event.finishControl.workSeq)) {
      finish.decisionSeq = Math.max(finish.decisionSeq, event.finishControl.workSeq!);
    }
    if (event.finishControl) finish.conversationId = event.finishControl.conversationId;
    if (event.finishControl?.state === 'released') finish.released = true;
  }
  noteFinishWork(summary, event);
  if (event.kind === 'turn_end' && (!event.turnId || summary.activeTurnId === event.turnId)) summary.activeTurnId = null;
  if (event.kind === 'handoff') {
    summary.lastHandoffId = event.handoffId;
    summary.lastHandoffAt = event.time;
  }
  if (event.agent && !summary.agents.includes(event.agent)) summary.agents.push(event.agent);
}

/**
 * Whether this chat is over its automatic-compaction line.
 *
 * A level, and deliberately not the edge this used to be. The edge version armed on the
 * below-to-above crossing and then waited for that turn to end cleanly, which had two
 * consequences the design never wanted: a single interrupted turn destroyed the trigger
 * forever (a counter that only grows never crosses the same line twice), and every
 * compaction it did manage to fire landed *after* the model had finished answering — the
 * one moment where a handoff is pointless, because the work it would carry across is
 * already done.
 *
 * So this half of the rule is just "over the line". The other half — that
 * the model is working *right now* — is a fact about the open browser connection rather
 * than about the recording, so it is asked at the point of use, in bridge.ts. That is what
 * keeps a stale 500k chat quiet when it is merely opened: it is over the line all day, and
 * nothing is running in it. The existing continuation transaction is the durable authority
 * once a stopped/settled chat asks for its handoff prompt; pre-barrier refusal owns no durable
 * state and may be attempted by a later generation.
 */
export function automaticCompactionAllowed(summary?: SessionSummary | null): boolean {
  const config = getConfig();
  const selected = summary?.selectedModel;
  // The selected model owns this exemption; Infinite Astra with Sol still compacts.
  return config.compaction.auto &&
    !(selected?.conversationId === summary?.conversationId && isProModel(selected?.model, selected?.reasoningEffort));
}

export function autoCompactionReady(summary: SessionSummary | null | undefined): boolean {
  if (!summary) return false;
  const refusal = summary.autoCompactionRefusal;
  if (refusal?.conversationId === summary.conversationId &&
      (!summary.activeTurnId || summary.activeTurnId === refusal.turnId)) return false;
  const config = getConfig().compaction;
  return automaticCompactionAllowed(summary) && config.autoTokens > 0 && summary.contextTokens >= config.autoTokens;
}

/** Persist eligibility before retiring the ticket, so a restart cannot refile the refused turn. */
export async function refuseAutomaticCompactionNow(id: string, conversationId: string, turnId: string | null): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'automatic compaction refusal', async () => {
    if (entry.summary.conversationId !== conversationId ||
        (entry.summary.activeTurnId && entry.summary.activeTurnId !== turnId)) return;
    const staged = { ...entry.summary, autoCompactionRefusal: { conversationId, turnId } };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/** The sole physical event writer. Call only while this entry's queue is owned; a
 * conditional lifecycle commit needs the same uncertain-write reconciliation as appendEvent. */
async function appendEventWithinQueue(
  sessionId: string, entry: OpenSession, event: NewSessionEvent, revision: number
): Promise<SessionEvent> {
  if (!isRecordingControl(event)) requireRecording(revision);
  let admitted = event;
  if (event.kind === 'tool_call') {
    const denied = deniedAssetIds(sessionId, event.call.assets);
    admitted = { ...event, call: {
      ...event.call,
      assets: admittedAssets(sessionId, event.call.assets),
      ...(denied.length ? { retiredImageAssetIds: mergedRetiredAssetIds(event.call.retiredImageAssetIds, denied) } : {})
    } };
  } else if (event.kind === 'user_message') {
    const denied = deniedAssetIds(sessionId, event.assets);
    admitted = {
      ...event,
      assets: admittedAssets(sessionId, event.assets),
      ...(denied.length ? { retiredImageAssetIds: mergedRetiredAssetIds(event.retiredImageAssetIds, denied) } : {})
    };
  }
  const full = { ...admitted, seq: entry.nextSeq } as SessionEvent;
  const line = `${JSON.stringify(full)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new Error('Session event is too large to store');
  }
  try {
    await fs.appendFile(path.join(sessionDir(sessionId), 'events.jsonl'), line, 'utf8');
  } catch (error) {
    // The write may have reached disk before it rejected. Reconcile before the
    // next queued writer; neither an uncertain commit nor a torn line changes counts.
    await sealTornTail(sessionId);
    const durableSeq = await lastSeqOnDisk(sessionId);
    if (durableSeq < full.seq) {
      entry.nextSeq = Math.max(entry.nextSeq, durableSeq + 1);
      throw error;
    }
    logWarn(`session ${sessionId}: append reported an error after sequence ${full.seq} was already durable`);
  }
  entry.nextSeq += 1;
  entry.tail.push(full);
  if (entry.tail.length > MAX_EVENT_TAIL) {
    const removed = entry.tail.splice(0, entry.tail.length - MAX_EVENT_TAIL);
    entry.tailFrom = removed[removed.length - 1]!.seq + 1;
  }
  applyToSummary(entry.summary, full);
  entry.historySeq = full.seq;
  scheduleMeta(entry);
  return full;
}

/** Assigns sequence, writes and projects one event in the session queue. Sequence,
 * rather than producer timestamps, defines the order of independently arriving events. */
export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  const revision = getRecordingRevision();
  if (!isRecordingControl(event) && !getConfig().sessions.record) return Promise.reject(new RecordingDisabledError());
  return ensureOpen(sessionId).then(entry =>
    enqueueSessionOperation(entry, 'append', () => appendEventWithinQueue(sessionId, entry, event, revision)));
}

/**
 * An end is authority over the CURRENT session turn, not simply a journal row.
 * Session rebinds, newly authored questions and other lifecycle writers share this queue.
 * Its strict read and physical append must therefore be one operation. A refusal never
 * creates a receipt or updates the live/Goal/worker projections in the recorder.
 */
export async function appendTurnEndIfCurrent(
  sessionId: string,
  expectedAttachment: { conversationId: string; bindingRevision: number },
  event: Extract<NewSessionEvent, { kind: 'turn_end' }>,
  revision: number,
  sameEnvelopeUserWorkSeq?: number
): Promise<
  | { appended: Extract<SessionEvent, { kind: 'turn_end' }>; priorEnd: boolean }
  | { replay: Extract<SessionEvent, { kind: 'turn_end' }> }
  | { refused: true }
> {
  assertSessionId(sessionId);
  // A provisional Off may fail. Preserve the recorder's existing wait-and-retry
  // behavior: only an ownership/lifecycle refusal returns an ordinary zero receipt.
  requireRecording(revision);
  if (!event.turnId || sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId))
    return { refused: true };
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'conditional turn end', async () => {
    const authorized = () => !deletingSessions.has(sessionId) && !sessionAttachmentTransitionPending(sessionId) &&
      entry.summary.conversationId === expectedAttachment.conversationId &&
      (entry.summary.bindingRevision ?? 0) === expectedAttachment.bindingRevision;
    if (!authorized()) return { refused: true };
    requireRecording(revision);
    // Infinity removes the UI reader's 8 MiB cap. A damaged line or missing journal
    // cannot prove absence of a newer question; strictIdentity throws, preserving retry.
    const [latest] = await readRecentEventsFromDisk(sessionId, 1, {
      kinds: ['turn_start', 'turn_end', 'user_message'], before: Number.POSITIVE_INFINITY,
      strictIdentity: true
    });
    if (!latest) return { refused: true };
    let lifecycle: SessionEvent = latest;
    if (latest.kind === 'user_message') {
      // A tool-input handout is a local delivery correction to the ALREADY running
      // model turn, not a newly authored native question. It is recorded as a
      // canonical app user row after the start, sometimes after a separate HTTP
      // /events batch. Only its exact stable input identity, original tool turn
      // and app-owned receipt distinguish it; a recycled turnId alone never does.
      const exactToolInput = (row: SessionEvent): boolean => row.kind === 'user_message' &&
        row.source === 'app' && typeof row.inputId === 'string' && row.inputId.length > 0 &&
        row.messageId === `input:${row.inputId}` && row.turnId === event.turnId &&
        (row.inputDelivery === 'offered' || row.inputDelivery === 'confirmed' ||
          row.inputDelivery === undefined);
      if (exactToolInput(latest)) {
        const [preceding] = await readRecentEventsFromDisk(sessionId, 1, {
          kinds: ['turn_start', 'turn_end'], before: Number.POSITIVE_INFINITY,
          strictIdentity: true
        });
        if (!preceding || preceding.kind !== 'turn_start' || preceding.turnId !== event.turnId ||
            preceding.seq >= workSequence(latest)) return { refused: true };
        // The latest app correction could obscure a different real question V
        // between the start and this end. Scan the strict canonical history for
        // the newest NON-correction question, not just the latest user row. A
        // genuinely same-envelope U is permitted only by its immutable workSeq.
        const [authored] = await readRecentEventsFromDisk(sessionId, 1, {
          kinds: ['user_message'], before: Number.POSITIVE_INFINITY, strictIdentity: true,
          acceptEvent: row => row.kind === 'user_message' &&
            workSequence(row) > preceding.seq && !exactToolInput(row)
        });
        if (authored && ((authored.turnId && authored.turnId !== event.turnId) ||
            !Number.isSafeInteger(sameEnvelopeUserWorkSeq) ||
            sameEnvelopeUserWorkSeq !== workSequence(authored))) return { refused: true };
        lifecycle = preceding;
      } else {
        // A page may report its question AFTER its turn_start in the same envelope.
        // A recycled page turn ID is not question identity. Only this envelope's
        // freshly committed canonical question permits crossing that boundary.
        if ((latest.turnId && latest.turnId !== event.turnId) ||
            !Number.isSafeInteger(sameEnvelopeUserWorkSeq) ||
            sameEnvelopeUserWorkSeq !== workSequence(latest))
          return { refused: true };
        const [preceding] = await readRecentEventsFromDisk(sessionId, 1, {
          kinds: ['turn_start', 'turn_end'], before: Number.POSITIVE_INFINITY,
          strictIdentity: true
        });
        if (!preceding || preceding.kind !== 'turn_start' || preceding.turnId !== event.turnId ||
            preceding.seq >= workSequence(latest)) return { refused: true };
        lifecycle = preceding;
      }
    }
    if (lifecycle.turnId !== event.turnId) return { refused: true };
    let priorEnd = false;
    if (lifecycle.kind === 'turn_end') {
      // Exact replay can finish a separately admitted optional canonical promotion
      // after a failed Recording Off. It still has zero physical event count.
      if (lifecycle.source === event.source && lifecycle.time === event.time &&
          lifecycle.outcome === event.outcome && lifecycle.reason === event.reason &&
          lifecycle.detail === event.detail) {
        return authorized() ? { replay: lifecycle } : { refused: true };
      }
      // A later native Stop can strengthen the latest interrupted/failed verdict once.
      // It cannot overwrite an already stopped/completed turn or a newer question.
      if (event.outcome !== 'stopped' ||
          (lifecycle.outcome !== 'interrupted' && lifecycle.outcome !== 'failed') ||
          event.time < lifecycle.time) return { refused: true };
      priorEnd = true;
    } else if (lifecycle.kind === 'turn_start') {
      if (event.time < lifecycle.time) return { refused: true };
      const [previousEnd] = await readRecentEventsFromDisk(sessionId, 1, {
        kinds: ['turn_end'], before: Number.POSITIVE_INFINITY, strictIdentity: true,
        acceptEvent: row => row.kind === 'turn_end' && row.turnId === event.turnId
      });
      priorEnd = !!previousEnd;
      if (priorEnd && (lifecycle.source !== 'app' || previousEnd!.seq >= lifecycle.seq ||
          event.time <= lifecycle.time)) return { refused: true };
    } else return { refused: true };
    // The other owner may have requested a rebind/delete while this async read ran.
    // Refuse even before its queued metadata commit, and again at the write boundary.
    if (!authorized()) return { refused: true };
    const appended = await appendEventWithinQueue(sessionId, entry, event, revision);
    if (appended.kind !== 'turn_end') throw new Error('Conditional turn end wrote the wrong event');
    return { appended, priorEnd };
  });
}

/**
 * Creates or revises one canonical ChatGPT message by its own stable id.
 *
 * `seq` is the revision/cursor sequence so an incremental reader notices an update. `origin`
 * preserves the sequence/time position where that stable website message first appeared, so
 * revisions cannot move either a user response boundary or assistant prose through later work.
 */
type MessageUpsertSuccess = { event: MessageEvent; changed: boolean; contentChanged: boolean };
type MessageUpsertAttachment = { conversationId: string; bindingRevision: number };

// Optional, narrow owner predicate for a supplemental canonical revision. Ordinary
// message writers retain their unchanged success contract and recording guard.
export function upsertMessageEvent(
  sessionId: string, event: NewMessageEvent,
  options: { preferTime?: boolean; work?: boolean; expectedAttachment: MessageUpsertAttachment }
): Promise<MessageUpsertSuccess | { refused: 'binding_changed' }>;
export function upsertMessageEvent(
  sessionId: string, event: NewMessageEvent,
  options?: { preferTime?: boolean; work?: boolean }
): Promise<MessageUpsertSuccess>;
export function upsertMessageEvent(
  sessionId: string,
  event: NewMessageEvent,
  options: { preferTime?: boolean; work?: boolean; expectedAttachment?: MessageUpsertAttachment } = {}
): Promise<MessageUpsertSuccess | { refused: 'binding_changed' }> {
  const directKey = messageKey(event as MessageEvent);
  if (!directKey) throw new Error('Canonical message update requires ChatGPT messageId');
  const revision = getRecordingRevision();
  if (!getConfig().sessions.record) return Promise.reject(new RecordingDisabledError());
  return ensureOpen(sessionId).then((entry) => {
    const write = entry.queue.then(async () => {
      requireRecording(revision);
      // This check and the eventual canonical write own one session-queue slot,
      // exactly like rebindSession. A queued A→B (or A→B→A) commit cannot
      // interleave after this predicate and before the shard replacement.
      if (options.expectedAttachment &&
          (entry.summary.conversationId !== options.expectedAttachment.conversationId ||
           (entry.summary.bindingRevision ?? 0) !== options.expectedAttachment.bindingRevision)) {
        return { refused: 'binding_changed' as const };
      }
      // Rich is store-owned: ordinary text upserts cannot insert page-claimed structure.
      if (event.kind === 'assistant_message') {
        const { rich: _rich, richOrigin: _richOrigin, richMedia: _media, richMediaUnavailable: _unavailable,
          richSourceVersionFloor: _sourceFloor, retiredRichImageAssetIds: _retired,
          retiredRichMediaSlots: _retiredSlots, ...plain } = event;
        event = plain as NewMessageEvent;
      }
      // Provider create_time can change after a tab reload while the actual message
      // UUID stays identical. Preserve the first canonical anchor on that exact
      // evidence; never collapse distinct authored segments by working-turn tuple
      // or matching text. Legacy observations without a provider UUID keep their key.
      const providerMessageId = event.kind === 'assistant_message' ? event.providerMessageId : undefined;
      const providerMatches = providerMessageId
        ? [...entry.messages.entries()].filter(([, candidate]) => candidate.kind === 'assistant_message' &&
            candidate.providerMessageId === providerMessageId)
        : [];
      const key = !entry.messages.has(directKey) && providerMatches.length === 1 ? providerMatches[0]![0] : directKey;
      const candidate = entry.messages.get(key);
      const previous = candidate?.kind === 'tool_call' ? undefined : candidate;
      const oldSourceFloor = previous?.kind === 'assistant_message' ? richSourceVersionFloor(previous) : 0;
      const previousMedia = previous?.kind === 'assistant_message' && previous.richMedia !== undefined
        ? cleanupRichMedia(previous) : [];
      const sourceProtected = previous?.kind === 'assistant_message' &&
        ((oldSourceFloor ?? 0) > 0 || (Array.isArray(previous.richMedia) &&
          previous.richMedia.some(media => media?.pageSource !== undefined)));
      // Malformed durable source custody cannot be erased by an ordinary page text
      // revision and subsequently reacquired as a brand-new version-zero slot.
      if (previous?.kind === 'assistant_message' &&
          (oldSourceFloor === null || (sourceProtected && previousMedia === null))) {
        return { event: previous, changed: false, contentChanged: false };
      }
      // A changed provider timestamp caused this alias; it is not a correction of
      // the original anchor. Same-key DOM-to-Fiber timestamp promotion still applies.
      const preferTime = options.preferTime === true && key === directKey;
      if (previous && key !== directKey) event = { ...event, messageId: previous.messageId };
      // Final is terminal for one canonical ChatGPT message. The page can briefly re-report
      // an older streaming DOM snapshot after settling/remounting; accepting that snapshot
      // would turn a completed answer back into a partial one and could replace its text.
      if (
        previous?.kind === 'assistant_message' &&
        event.kind === 'assistant_message' &&
        (previous.final === true || previous.state === 'final') &&
        event.final !== true &&
        event.state !== 'final'
      ) {
        return { event: previous, changed: false, contentChanged: false };
      }

      // Message bodies can be hundreds of kilobytes. The old path JSON.stringify-compared the
      // same StoredText pair once while preserving rendered HTML and then again while deciding
      // whether the observation changed at all. StoredText has a fixed five-field shape, so a
      // direct comparison is exact and avoids repeated full-string serialisation/allocation on
      // every streaming observation.
      const sameMessage =
        previous?.kind === event.kind && storedTextEqual(previous.message, event.message);
      const sameRichOwner = previous?.kind === 'assistant_message' && event.kind === 'assistant_message' &&
        sameMessage && previous.providerMessageId === (event.providerMessageId ?? previous.providerMessageId);
      const retainedRichMedia = sameRichOwner && previous.rich && previous.richOrigin &&
        parseRichOrigin(previous.richOrigin) && parseRichResponse(previous.rich) && previous.providerMessageId
          ? validatedRichMedia(previous.richMedia, previous.rich, previous.providerMessageId, previous.seq)
          : null;

      const nextEvent: NewMessageEvent =
        previous?.kind === 'assistant_message' && event.kind === 'assistant_message'
          ? {
              ...event,
              // The producer already supplied the stable website identity. Keep that exact
              // identity through every revision; a different id is a different logical row.
              messageId: previous.messageId,
              authoredAt: authoredTimeOf(previous) ?? event.authoredAt,
              providerMessageId: event.providerMessageId ?? previous.providerMessageId,
              // `final` is a compatibility mirror of state, not an independent truth.
              state: event.state === 'final' || event.final === true ? 'final' : 'streaming',
              final: event.state === 'final' || event.final === true,
              // Goal eligibility is an accepted fact about this stable reply, not a property a
              // later sparse page snapshot may retract. This is what makes a 503/reload replay
              // re-offer the same durable obligation instead of silently dropping it.
              ...(previous.goalEligible === true ? { goalEligible: true } : {}),
              // A sparse re-observation of the same prose must not throw away the richer
              // representation we already captured. If the prose itself changed, omitting
              // HTML deliberately falls back to the new plain text instead of showing stale
              // markup for different content.
              ...(event.renderedHtml === undefined && sameMessage
                ? { renderedHtml: previous.renderedHtml }
                : {}),
              ...(sameRichOwner && previous.rich ? { rich: previous.rich, richOrigin: previous.richOrigin } : {}),
              ...(retainedRichMedia?.length ? { richMedia: retainedRichMedia } : {}),
              ...((oldSourceFloor ?? 0) > 0 ? { richSourceVersionFloor: !sameRichOwner
                ? entry.nextSeq : oldSourceFloor! } : {}),
              ...(sameRichOwner && previous.richMediaUnavailable ? { richMediaUnavailable: previous.richMediaUnavailable } : {}),
              // Removal tombstones survive ordinary re-observations even if authored text changes.
              ...(previous.retiredRichImageAssetIds ? { retiredRichImageAssetIds: previous.retiredRichImageAssetIds } : {}),
              ...(previous.retiredRichMediaSlots ? { retiredRichMediaSlots: previous.retiredRichMediaSlots } : {})
            }
          : previous?.kind === 'user_message' && event.kind === 'user_message'
            ? { ...event, inputId: event.inputId ?? previous.inputId,
                authoredAt: previous.authoredAt ?? event.authoredAt,
                authoredText: event.authoredText ?? previous.authoredText,
                reaction: event.reaction === undefined ? previous.reaction : event.reaction,
                // App-owned originals/previews retain their outbox identity when the
                // provider later observes different native attachment ids for that send.
                attachments: previous.inputId ? previous.attachments ?? event.attachments : event.attachments ?? previous.attachments,
                inputDelivery: previous.inputDelivery === 'confirmed' ? 'confirmed' : event.inputDelivery ?? previous.inputDelivery,
                model: event.model ?? previous.model,
                reasoningEffort: event.reasoningEffort ?? previous.reasoningEffort,
                retiredImageAssetIds: mergedRetiredAssetIds(previous.retiredImageAssetIds,
                  deniedAssetIds(sessionId, event.assets ?? previous.assets)),
                assets: admittedAssets(sessionId,
                  retainedAssets(event.assets ?? previous.assets, previous.retiredImageAssetIds)) }
            : event.kind === 'user_message'
              ? {
                  ...event,
                  retiredImageAssetIds: mergedRetiredAssetIds(event.retiredImageAssetIds,
                    deniedAssetIds(sessionId, event.assets)),
                  assets: admittedAssets(sessionId, event.assets)
                }
              : event;
      // A canonical assistant message belongs to exactly one generation permanently. Ownership
      // may still be *promoted* from "not known yet" to a durable generation id when the
      // recorder learns it late, but a settled assistant answer may never move to another turn.
      // User messages are different: their page-side turn marker is a boundary hint and can be
      // revised as ChatGPT re-homes the same stable user object, so preserve that existing
      // behaviour instead of freezing it under the first marker we happened to observe.
      //
      // Live 2026-08-21, session `00000019`: ChatGPT re-mounted its stop control for two
      // seconds well after a page load, the extension minted generation `g-11kz85q585v4s-0-1`
      // for it, and the re-observation of the already finished 08:40:34 answer re-filed that
      // answer under a turn that started at 08:45:22. The consequences are not cosmetic — the
      // answer is torn away from the eight tool calls that produced it, so the extension can
      // no longer prove its reconstruction of that turn complete and drops the whole response
      // back to ChatGPT's native rendering, and the desktop timeline draws an empty turn with
      // a five-minute-old message inside it.
      const settledTurnId =
        previous?.kind === 'assistant_message' && nextEvent.kind === 'assistant_message'
          ? previous.turnId ?? nextEvent.turnId ?? undefined
          : nextEvent.turnId ?? undefined;
      if (
        previous &&
        previous.kind === nextEvent.kind &&
        sameMessage &&
        nextEvent.authoredAt === previous.authoredAt &&
        nextEvent.model === previous.model &&
        nextEvent.reasoningEffort === previous.reasoningEffort &&
        (previous.kind !== 'assistant_message' ||
          (nextEvent.kind === 'assistant_message' &&
            storedTextEqual(previous.renderedHtml, nextEvent.renderedHtml) &&
            previous.state === nextEvent.state &&
            previous.final === nextEvent.final &&
            previous.goalEligible === nextEvent.goalEligible &&
            previous.providerMessageId === nextEvent.providerMessageId)) &&
        (nextEvent.kind !== 'user_message' || previous.kind !== 'user_message' ||
          (nextEvent.reaction === previous.reaction && nextEvent.inputId === previous.inputId && nextEvent.authoredText === previous.authoredText && nextEvent.inputDelivery === previous.inputDelivery && JSON.stringify(nextEvent.assets) === JSON.stringify(previous.assets) && JSON.stringify(nextEvent.retiredImageAssetIds) === JSON.stringify(previous.retiredImageAssetIds) && JSON.stringify(nextEvent.attachments) === JSON.stringify(previous.attachments))) &&
        (previous.turnId ?? undefined) === settledTurnId &&
        (previous.kind !== 'assistant_message' || JSON.stringify(previous.richMedia) === JSON.stringify(
          nextEvent.kind === 'assistant_message' ? nextEvent.richMedia : undefined)) &&
        (nextEvent.agent === undefined || previous.agent === nextEvent.agent) &&
        (!preferTime || previous.time === nextEvent.time)
      ) {
        return { event: previous, changed: false, contentChanged: false };
      }
      const full = {
        ...nextEvent,
        // Cursor revisions publish richer markup/identity without manufacturing work.
        // A reload may reserialize an existing user bubble. Its updated text belongs
        // in history, but only a just-authored observation may revoke its recovery.
        // A new question identity and the first final still advance this work stamp.
        contentSeq: options.work === false &&
          ((nextEvent.kind === 'user_message' && !!previous) || (nextEvent.kind === 'assistant_message' && !nextEvent.final))
          ? previous ? workSequence(previous) : 0
          : sameMessage && previous && (nextEvent.kind !== 'assistant_message' ||
          (previous.kind === 'assistant_message' && (previous.final === true || previous.state === 'final') === nextEvent.final))
          ? workSequence(previous) : entry.nextSeq,
        ...(nextEvent.kind === 'assistant_message' && nextEvent.final
          ? { finalContentSeq: sameMessage && previous?.kind === 'assistant_message' &&
                (previous.final === true || previous.state === 'final')
              // Old records do not distinguish a content revision from an HTML update.
              // Keep their first anchor until genuinely new final content is observed.
              ? previous.finalContentSeq ?? previous.origin ?? previous.seq
              : entry.nextSeq,
              finalObservedAt: sameMessage && previous?.kind === 'assistant_message' &&
                (previous.final === true || previous.state === 'final')
                ? previous.finalObservedAt : Date.now() }
          : {}),
        // First appearance is chronology; current seq is delivery cursor/revision.
        // A page-model authored timestamp is stronger than a DOM first-sight timestamp. The
        // recorder opts into that correction explicitly; ordinary revisions still keep the
        // original first-seen time forever.
        time: preferTime ? nextEvent.time : previous?.time ?? nextEvent.time,
        ...(settledTurnId === undefined ? {} : { turnId: settledTurnId }),
        ...(previous?.agent && !nextEvent.agent ? { agent: previous.agent } : {}),
        ...(nextEvent.kind === 'assistant_message' || nextEvent.kind === 'user_message'
          ? { origin: previous?.kind === nextEvent.kind ? previous.origin ?? previous.seq : entry.nextSeq }
          : {}),
        seq: entry.nextSeq
      } as MessageEvent;

      await writeCanonicalMessage(sessionId, key, full);

      entry.nextSeq += 1;
      entry.messages.set(key, full);
      if (full.kind === 'user_message') refreshUserTitle(entry.summary, entry.messages.values());
      if (!previous) {
        applyToSummary(entry.summary, full);
      } else {
        // A revision is not another logical event. Only its text/token weight and recency
        // replace what the previous snapshot contributed to the session projection.
        const delta = eventTokens(full) - eventTokens(previous);
        entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
        entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
        entry.summary.updatedAt = Math.max(entry.summary.updatedAt, nextEvent.time);
        noteFinishWork(entry.summary, full);
        if (full.kind === 'assistant_message' && (full.final === true || full.state === 'final')) {
          entry.summary.lastAssistantFinalAt = Math.max(
            entry.summary.lastAssistantFinalAt ?? 0,
            nextEvent.time
          );
        }
        if (full.agent && !entry.summary.agents.includes(full.agent)) entry.summary.agents.push(full.agent);
      }
      entry.historySeq = full.seq;
      scheduleMeta(entry);
      return { event: full, changed: true, contentChanged: !sameMessage };
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => logError(`session message upsert failed: ${err.message}`)
    );
    return write;
  });
}

/**
 * Only an already-recorded exact logical assistant row can own a rich projection. A caller
 * must separately corroborate Chrome MessageSender and DOM/Fiber association; this layer
 * checks the supplied origin against the durable binding under the SAME queue as rebind.
 */
export function upsertRichMessage(
  sessionId: string, messageId: string, rich: RichResponse, origin: RichOrigin,
  expectedRecordingRevision?: number, seedPageMedia = false, stillAuthorized?: () => boolean
): Promise<'stored' | 'unchanged' | 'refused'> {
  const revision = getRecordingRevision();
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'rich message upsert', async () => {
    // The acquisition's original revision may predate this *invocation* after a
    // journal replay or restart. Compare it with current config inside this queue,
    // before even inspecting or replacing the existing canonical shard.
    if (!getConfig().sessions.record || !recordingWriteAllowed(revision) ||
        (seedPageMedia && expectedRecordingRevision === undefined) ||
        (expectedRecordingRevision !== undefined && expectedRecordingRevision !== getRecordingRevision()) ||
        (stillAuthorized && !stillAuthorized())) return 'refused';
    const capture = parseRichOrigin(origin);
    if (!capture) return 'refused';
    const clean = parseRichResponse(rich);
    if (!clean || !messageId || clean.messageId !== messageId ||
        clean.conversationId !== capture.conversationId || !clean.providerMessageId ||
        entry.summary.conversationId !== capture.conversationId ||
        (entry.summary.bindingRevision ?? 0) !== capture.bindingRevision) return 'refused';

    const key = `assistant_message\u0000${messageId}`;
    const previous = entry.messages.get(key);
    if (!previous || previous.kind !== 'assistant_message' || previous.messageId !== messageId ||
        !previous.providerMessageId || previous.providerMessageId !== clean.providerMessageId) return 'refused';
    const priorSourceFloor = richSourceVersionFloor(previous);
    if (priorSourceFloor === null) return 'refused';
    // A provider UUID claimed by two logical rows cannot corroborate either one.
    if ([...entry.messages.entries()].some(([otherKey, other]) => otherKey !== key &&
        other.kind === 'assistant_message' && other.providerMessageId === clean.providerMessageId)) return 'refused';

    // A malformed durable predecessor cannot authorize a replacement snapshot.
    const priorOrigin = previous.richOrigin ? parseRichOrigin(previous.richOrigin) : null;
    if (previous.richOrigin && !priorOrigin) return 'refused';
    if (previous.rich && !priorOrigin) return 'refused';
    // Shards and legacy snapshots are read as JSON without an eager rich schema pass.
    // Reject corruption inside this serialized queue before assigning a revision or
    // seeding any media. Never coerce a persisted revision (e.g. "3" + 1 => "31")
    // or let a prior projection claim a different logical/raw assistant identity.
    const priorRich = previous.rich === undefined ? null : parseRichResponse(previous.rich);
    if (previous.rich !== undefined && (!priorRich || !priorOrigin ||
        priorRich.conversationId !== capture.conversationId ||
        priorRich.messageId !== messageId ||
        priorRich.providerMessageId !== previous.providerMessageId)) return 'refused';
    if (priorOrigin) {
      if (priorOrigin.conversationId !== capture.conversationId ||
          priorOrigin.bindingRevision > capture.bindingRevision) return 'refused';
      if (priorOrigin.bindingRevision === capture.bindingRevision &&
          (priorOrigin.documentId !== capture.documentId || priorOrigin.navigationEpoch > capture.navigationEpoch)) return 'refused';
    }
    if ((priorRich?.revision ?? 0) >= Number.MAX_SAFE_INTEGER) return 'refused';
    const nextRevision = (priorRich?.revision ?? 0) + 1;
    // Store, never the extension, assigns revision. A re-observation of identical structure
    // from a newer navigation may refresh provenance without claiming changed content.
    const storedRich = { ...clean, revision: nextRevision };
    const sameContent = priorRich && JSON.stringify({ ...priorRich, revision: 0 }) ===
      JSON.stringify({ ...storedRich, revision: 0 });
    const sameOrigin = priorOrigin && priorOrigin.conversationId === capture.conversationId &&
      priorOrigin.bindingRevision === capture.bindingRevision && priorOrigin.documentId === capture.documentId &&
      priorOrigin.navigationEpoch === capture.navigationEpoch;
    const keptMedia = sameContent && sameOrigin && priorRich && previous.providerMessageId
      ? validatedRichMedia(previous.richMedia, priorRich, previous.providerMessageId, previous.seq) : [];
    // A private verified recorder opts in explicitly. Derive every page slot before the ONE
    // canonical rename; a later metadata write may be refused by Recording Off after this
    // rich prefix physically commits, so a separate seeding step could lose its image slots.
    // Preserve same-owner validated metadata (including unavailable/removed and future saved
    // previews) through changes to unrelated layout nodes. A changed attachment starts fresh.
    const priorMedia = previous.richMedia !== undefined ? cleanupRichMedia(previous) : [];
    const priorRemoved = parsedRetiredRichMediaSlots(previous.retiredRichMediaSlots);
    if (priorMedia === null || priorRemoved === null || priorMedia.some(media =>
      (media.pageSource?.slotVersion ?? 0) > priorSourceFloor)) return 'refused';
    // Legacy shards can have a removed current slot but no separately persisted slot
    // fence. Materialize it before a changed rich tree can omit the image entirely.
    const nextRemoved = mergedRetiredRichMediaSlots(priorRemoved, priorMedia
      .filter(item => item.status === 'unavailable' && item.reason === 'removed')
      .map(item => ({ mediaId: item.mediaId, nodeId: item.nodeId })));
    if (nextRemoved === null) return 'refused';
    const sameDocument = priorOrigin && priorOrigin.conversationId === capture.conversationId &&
      priorOrigin.bindingRevision === capture.bindingRevision && priorOrigin.documentId === capture.documentId;
    const seededMedia = seedPageMedia
      ? seededPageRichMedia(clean, priorMedia, nextRemoved, Boolean(sameOrigin), Boolean(sameDocument),
        priorSourceFloor, revision) : null;
    if (seedPageMedia && seededMedia === null) return 'refused';
    const sourceInvalidated = priorMedia.some(media => media.pageSource &&
      !(seededMedia ?? []).some(next => next.mediaId === media.mediaId &&
        next.nodeId === media.nodeId && next.pageSource?.slotVersion === media.pageSource?.slotVersion &&
        next.pageSource?.incarnation === media.pageSource?.incarnation));
    const nextSourceFloor = sourceInvalidated ? entry.nextSeq : priorSourceFloor;
    if (sameContent && sameOrigin && (seedPageMedia
      ? JSON.stringify(priorMedia) === JSON.stringify(seededMedia)
      : keptMedia !== null) && JSON.stringify(priorRemoved) === JSON.stringify(nextRemoved)) return 'unchanged';

    const { richMedia: _priorMedia, retiredRichMediaSlots: _priorRemoved,
      richSourceVersionFloor: _priorSourceFloor, ...priorWithoutMedia } = previous;
    const full: Extract<SessionEvent, { kind: 'assistant_message' }> = {
      ...priorWithoutMedia, rich: sameContent && priorRich ? priorRich : storedRich,
      richOrigin: capture,
      ...(seedPageMedia && seededMedia?.length ? { richMedia: seededMedia } : {}),
      ...(nextSourceFloor > 0 ? { richSourceVersionFloor: nextSourceFloor } : {}),
      ...(nextRemoved.length ? { retiredRichMediaSlots: nextRemoved } : {}),
      seq: entry.nextSeq // presentation delivery cursor only; never advance content/work/Goal.
    };
    await writeCanonicalMessage(sessionId, key, full, stillAuthorized);
    entry.nextSeq += 1;
    entry.messages.set(key, full);
    entry.historySeq = full.seq;
    scheduleMeta(entry);
    return 'stored';
  }));
}

/**
 * Synthetic/internal metadata-only boundary. Verified PAGE pixel observations use the
 * separate source-begin/settlement APIs; this generic setter grants no pixel custody.
 * It does not create sessions, messages, image rows, asset references or pixels.
 */
export function upsertRichMedia(
  sessionId: string, messageId: string, media: RichMediaState, origin: RichOrigin,
  expectedRichRevision: number, expectedRecordingRevision?: number
): Promise<'stored' | 'unchanged' | 'refused'> {
  const revision = getRecordingRevision();
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'rich media upsert', async () => {
    if (!getConfig().sessions.record || !recordingWriteAllowed(revision) ||
        (expectedRecordingRevision !== undefined && expectedRecordingRevision !== getRecordingRevision())) return 'refused';
    const capture = parseRichOrigin(origin);
    const clean = parseMetadataRichMedia(media);
    if (!capture || !clean || !messageId || !Number.isSafeInteger(expectedRichRevision) ||
        expectedRichRevision < 1 || entry.summary.conversationId !== capture.conversationId ||
        (entry.summary.bindingRevision ?? 0) !== capture.bindingRevision) return 'refused';

    const key = `assistant_message\u0000${messageId}`;
    const previous = entry.messages.get(key);
    if (!previous || previous.kind !== 'assistant_message' || previous.messageId !== messageId ||
        !previous.providerMessageId || !previous.rich || !previous.richOrigin) return 'refused';
    const storedOrigin = parseRichOrigin(previous.richOrigin);
    const storedRich = parseRichResponse(previous.rich);
    if (!storedOrigin || !storedRich || storedRich.status !== 'available' ||
        storedRich.revision !== expectedRichRevision || storedRich.messageId !== messageId ||
        storedRich.conversationId !== capture.conversationId ||
        storedRich.providerMessageId !== previous.providerMessageId ||
        storedOrigin.conversationId !== capture.conversationId ||
        storedOrigin.bindingRevision !== capture.bindingRevision ||
        storedOrigin.documentId !== capture.documentId ||
        storedOrigin.navigationEpoch !== capture.navigationEpoch ||
        !exactRichImageNode(storedRich, clean.mediaId, clean.nodeId) ||
        (clean.source.kind === 'native' && clean.source.providerMessageId !== previous.providerMessageId)) return 'refused';
    // Provider aliases are forensic records, never a second authority to attach a slot.
    if ([...entry.messages.entries()].some(([otherKey, other]) => otherKey !== key &&
        other.kind === 'assistant_message' && other.providerMessageId === previous.providerMessageId)) return 'refused';

    const current = validatedRichMedia(previous.richMedia, storedRich, previous.providerMessageId, previous.seq);
    const sourceFloor = richSourceVersionFloor(previous);
    const priorRemoved = parsedRetiredRichMediaSlots(previous.retiredRichMediaSlots);
    if (!current || priorRemoved === null || sourceFloor === null || current.some(media =>
      (media.pageSource?.slotVersion ?? 0) > sourceFloor)) return 'refused';
    const alreadyRemoved = priorRemoved.find(slot => slot.mediaId === clean.mediaId);
    if (alreadyRemoved && (alreadyRemoved.nodeId !== clean.nodeId ||
        clean.status !== 'unavailable' || clean.reason !== 'removed')) return 'refused';
    const nextRemoved = clean.status === 'unavailable' && clean.reason === 'removed'
      ? mergedRetiredRichMediaSlots(priorRemoved, [{ mediaId: clean.mediaId, nodeId: clean.nodeId }])
      : priorRemoved;
    if (nextRemoved === null) return 'refused';
    const existing = current.find(item => item.mediaId === clean.mediaId);
    if (existing && (existing.nodeId !== clean.nodeId ||
        JSON.stringify(existing.source) !== JSON.stringify(clean.source) ||
        (existing.status === 'unavailable' && clean.status === 'pending') ||
        (existing.status === 'available' && clean.status === 'pending') ||
        (existing.reason === 'removed' && clean.reason !== 'removed'))) return 'refused';
    // Public metadata cannot choose, replace or delete the store-owned PAGE barrier.
    const next = existing?.pageSource ? { ...clean, pageSource: existing.pageSource } : clean;
    if (existing && JSON.stringify(existing) === JSON.stringify(next) &&
        JSON.stringify(priorRemoved) === JSON.stringify(nextRemoved)) return 'unchanged';
    if (!existing && current.length >= 64) return 'refused';
    const nextMedia = existing ? current.map(item => item.mediaId === clean.mediaId ? next : item) : [...current, next];
    const full: Extract<SessionEvent, { kind: 'assistant_message' }> = {
      ...previous, richMedia: nextMedia,
      ...(nextRemoved.length ? { retiredRichMediaSlots: nextRemoved } : {}),
      seq: entry.nextSeq // Presentation cursor only; content/Goal/turn/summary are untouched.
    };
    await writeCanonicalMessage(sessionId, key, full);
    entry.messages.set(key, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    scheduleMeta(entry);
    return 'stored';
  }), () => 'refused' as const);
}

/** A read of one existing canonical PAGE slot. The caller still has to acquire a
 * separate Chrome-attested, purpose-bound ticket before treating this as a capture
 * target; these fields carry no permission to scan or publish pixels. */
export type PageRichPixelTarget = Readonly<{
  richRevision: number;
  richOrigin: RichOrigin;
  slotVersion: number;
  sourceIncarnation: string | null;
  sourceSequence: number | null;
  status: RichMediaState['status'];
  removed: false;
}>;

function canonicalPageRichTarget(
  entry: OpenSession, messageId: string, providerMessageId: string, mediaId: string, nodeId: string
): { row: Extract<SessionEvent, { kind: 'assistant_message' }>;
     rich: RichResponse; origin: RichOrigin; media: RichMediaState; index: number;
     all: RichMediaState[] } | null {
  if (!messageId || !providerMessageId || !richMediaOpaque(mediaId) || !richMediaOpaque(nodeId) ||
      !Number.isSafeInteger(entry.summary.bindingRevision ?? 0)) return null;
  const key = `assistant_message\u0000${messageId}`;
  const row = entry.messages.get(key);
  if (!row || row.kind !== 'assistant_message' || row.messageId !== messageId ||
      row.providerMessageId !== providerMessageId || !row.rich || !row.richOrigin ||
      !Number.isSafeInteger(row.seq) || row.seq < 1) return null;
  const sourceFloor = richSourceVersionFloor(row);
  if (sourceFloor === null) return null;
  const rich = parseRichResponse(row.rich);
  const origin = parseRichOrigin(row.richOrigin);
  if (!rich || rich.status !== 'available' || rich.revision < 1 ||
      rich.messageId !== messageId || rich.providerMessageId !== providerMessageId ||
      !origin || rich.conversationId !== origin.conversationId ||
      entry.summary.conversationId !== origin.conversationId ||
      (entry.summary.bindingRevision ?? 0) !== origin.bindingRevision ||
      !exactRichImageNode(rich, mediaId, nodeId) ||
      [...entry.messages.entries()].some(([otherKey, other]) => otherKey !== key &&
        other.kind === 'assistant_message' && other.providerMessageId === providerMessageId)) return null;
  const all = cleanupRichMedia(row);
  const removed = parsedRetiredRichMediaSlots(row.retiredRichMediaSlots);
  if (!all || removed === null || removed.some(slot => slot.mediaId === mediaId)) return null;
  const index = all.findIndex(media => media.mediaId === mediaId && media.nodeId === nodeId);
  if (index < 0 || all[index]!.source.kind !== 'page' ||
      (all[index]!.pageSource?.slotVersion ?? 0) > sourceFloor) return null;
  return { row, rich, origin, media: all[index]!, index, all };
}

export function readPageRichPixelTarget(
  sessionId: string, messageId: string, providerMessageId: string, mediaId: string, nodeId: string
): Promise<PageRichPixelTarget | null> {
  if (sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId)) return Promise.resolve(null);
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'page rich pixel target', async () => {
    if (sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId) ||
        !getConfig().sessions.record || !recordingWriteAllowed(getRecordingRevision())) return null;
    const target = canonicalPageRichTarget(entry, messageId, providerMessageId, mediaId, nodeId);
    if (!target) return null;
    const { media, rich, origin } = target;
    return Object.freeze({ richRevision: rich.revision, richOrigin: Object.freeze({ ...origin }),
      slotVersion: media.pageSource?.slotVersion ?? richSourceVersionFloor(target.row) ?? 0,
      sourceIncarnation: media.pageSource?.incarnation ?? null,
      sourceSequence: media.pageSource?.sequence ?? null,
      status: media.status, removed: false as const });
  }), () => null);
}

/** Bridge/recorder-only proposed seam: the future caller must construct these fields
 * from its PRIVATE pixel ticket and worker journal receipt plus the isolated source
 * witness. Supplying matching fields to this method alone does NOT authenticate Chrome,
 * authorize a pixel, create an asset, or publish available status. */
export type VerifiedPageRichMediaSourceBegin = Readonly<{
  messageId: string; providerMessageId: string; mediaId: string; nodeId: string;
  richRevision: number; origin: RichOrigin; expectedRecordingRevision: number;
  expectedSlotVersion: number; sourceIncarnation: string; sourceSequence: number;
}>;

export function beginVerifiedPageRichMediaSource(
  sessionId: string, proof: VerifiedPageRichMediaSourceBegin, stillAuthorized?: () => boolean
): Promise<{ status: 'stored' | 'unchanged' | 'refused'; slotVersion?: number }> {
  const refused = { status: 'refused' as const };
  const keys = ['messageId', 'providerMessageId', 'mediaId', 'nodeId', 'richRevision', 'origin',
    'expectedRecordingRevision', 'expectedSlotVersion', 'sourceIncarnation', 'sourceSequence'];
  const fields = richMediaFields(proof, keys, keys);
  const origin = fields ? parseRichOrigin(fields.origin) : null;
  if (!fields || !origin || typeof fields.messageId !== 'string' ||
      typeof fields.providerMessageId !== 'string' ||
      !richMediaOpaque(fields.mediaId) || !richMediaOpaque(fields.nodeId) ||
      !Number.isSafeInteger(fields.richRevision) || (fields.richRevision as number) < 1 ||
      !Number.isSafeInteger(fields.expectedSlotVersion) || (fields.expectedSlotVersion as number) < 0 ||
      !Number.isSafeInteger(fields.expectedRecordingRevision) || (fields.expectedRecordingRevision as number) < 0 ||
      !validPageSourceWitness(fields.sourceIncarnation, fields.sourceSequence) ||
      sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId) ||
      (stillAuthorized && !stillAuthorized())) return Promise.resolve(refused);
  const revision = fields.expectedRecordingRevision as number;
  if (revision !== getRecordingRevision() || !getConfig().sessions.record || !recordingWriteAllowed(revision))
    return Promise.resolve(refused);
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'page source begin', async () => {
    if ((stillAuthorized && !stillAuthorized()) || sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId) ||
        getRecordingRevision() !== revision || !getConfig().sessions.record ||
        !recordingWriteAllowed(revision)) return refused;
    const target = canonicalPageRichTarget(entry, fields.messageId as string,
      fields.providerMessageId as string, fields.mediaId as string, fields.nodeId as string);
    if ((stillAuthorized && !stillAuthorized()) || !target || target.rich.revision !== fields.richRevision ||
        target.origin.conversationId !== origin.conversationId ||
        target.origin.bindingRevision !== origin.bindingRevision ||
        target.origin.documentId !== origin.documentId ||
        target.origin.navigationEpoch !== origin.navigationEpoch) return refused;
    const { row, media, index, all } = target;
    const old = media.pageSource;
    const token = fields.sourceIncarnation as string;
    const sequence = fields.sourceSequence as number;
    // At-least-once journal delivery may replay after a successful physical write.
    // This is idempotent only for the exact same current source, owner and revision.
    if (old?.incarnation === token && old.sequence === sequence && old.recordingRevision === revision) {
      return { status: 'unchanged' as const, slotVersion: old.slotVersion };
    }
    if ((old?.slotVersion ?? richSourceVersionFloor(row)) !== fields.expectedSlotVersion ||
        (old?.sequence !== undefined && sequence <= old.sequence) ||
        (old?.incarnation === token) ||
        all.some((other, otherIndex) => otherIndex !== index && other.pageSource?.incarnation === token) ||
        !Number.isSafeInteger(entry.nextSeq) || entry.nextSeq >= Number.MAX_SAFE_INTEGER) return refused;
    const slotVersion = entry.nextSeq;
    const replacement: RichMediaState = { mediaId: media.mediaId, nodeId: media.nodeId,
      source: { kind: 'page', nodeId: media.nodeId }, status: 'pending', reason: 'not_loaded',
      pageSource: { slotVersion, incarnation: token, sequence, recordingRevision: revision } };
    const full: Extract<SessionEvent, { kind: 'assistant_message' }> = {
      ...row, richMedia: all.map((item, at) => at === index ? replacement : item),
      richSourceVersionFloor: slotVersion, seq: slotVersion
    };
    await writeCanonicalMessage(sessionId, `assistant_message\u0000${fields.messageId}`, full, stillAuthorized);
    entry.messages.set(`assistant_message\u0000${fields.messageId}`, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    scheduleMeta(entry);
    return { status: 'stored' as const, slotVersion };
  }), () => refused);
}

/** The verified recorder owns the pixel decode and writeAsset call. This narrowly
 * scoped store settlement accepts only its already admitted AssetRef or reason and
 * commits a supplemental canonical revision under the original PAGE source barrier.
 * A raw rich_media observation cannot call this path or grant its own revision. */
export type VerifiedPageRichMediaSettlement = VerifiedPageRichMediaSourceBegin & Readonly<
  { status: 'available'; asset: AssetRef; previewWidth: number; previewHeight: number } |
  { status: 'unavailable'; reason: Exclude<NonNullable<RichMediaState['reason']>, 'not_loaded' | 'removed'> }
>;

export function settleVerifiedPageRichMedia(
  sessionId: string, proof: VerifiedPageRichMediaSettlement, stillAuthorized?: () => boolean
): Promise<'stored' | 'unchanged' | 'refused'> {
  const refused = 'refused' as const;
  const common = ['messageId', 'providerMessageId', 'mediaId', 'nodeId', 'richRevision', 'origin',
    'expectedRecordingRevision', 'expectedSlotVersion', 'sourceIncarnation', 'sourceSequence', 'status'];
  const fields = richMediaFields(proof, common,
    [...common, 'asset', 'previewWidth', 'previewHeight', 'reason']);
  if (!fields || (fields.status !== 'available' && fields.status !== 'unavailable')) return Promise.resolve(refused);
  const required = fields.status === 'available'
    ? [...common, 'asset', 'previewWidth', 'previewHeight'] : [...common, 'reason'];
  if (!richMediaFields(proof, required, required)) return Promise.resolve(refused);
  const origin = parseRichOrigin(fields.origin);
  if (!origin || typeof fields.messageId !== 'string' || typeof fields.providerMessageId !== 'string' ||
      !richMediaOpaque(fields.mediaId) || !richMediaOpaque(fields.nodeId) ||
      !Number.isSafeInteger(fields.richRevision) || (fields.richRevision as number) < 1 ||
      !Number.isSafeInteger(fields.expectedSlotVersion) || (fields.expectedSlotVersion as number) < 1 ||
      !Number.isSafeInteger(fields.expectedRecordingRevision) || (fields.expectedRecordingRevision as number) < 0 ||
      !validPageSourceWitness(fields.sourceIncarnation, fields.sourceSequence) ||
      sessionAttachmentTransitionPending(sessionId) || deletingSessions.has(sessionId) ||
      (stillAuthorized && !stillAuthorized())) return Promise.resolve(refused);
  const revision = fields.expectedRecordingRevision as number;
  if (revision !== getRecordingRevision() || !getConfig().sessions.record || !recordingWriteAllowed(revision))
    return Promise.resolve(refused);
  let validatedAsset: AssetRef | null = null;
  if (fields.status === 'available') {
    const asset = richMediaFields(fields.asset, ['id', 'mimeType', 'bytes'], ['id', 'mimeType', 'bytes']);
    if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{32}\.bin$/.test(asset.id) ||
        asset.mimeType !== 'image/webp' || !Number.isSafeInteger(asset.bytes) ||
        (asset.bytes as number) < 1 || (asset.bytes as number) > 384_000 ||
        !Number.isSafeInteger(fields.previewWidth) || !Number.isSafeInteger(fields.previewHeight) ||
        (fields.previewWidth as number) < 1 || (fields.previewHeight as number) < 1 ||
        (fields.previewWidth as number) > 1600 || (fields.previewHeight as number) > 1600 ||
        (fields.previewWidth as number) * (fields.previewHeight as number) > 2_560_000) return Promise.resolve(refused);
    validatedAsset = { id: asset.id, mimeType: 'image/webp', bytes: asset.bytes as number };
  } else if (typeof fields.reason !== 'string' || !richMediaReasons.has(fields.reason) ||
      fields.reason === 'not_loaded' || fields.reason === 'removed') return Promise.resolve(refused);

  // The explicit image-cleanup owner holds assetQueue → sessionQueue. Match that
  // order for publication, preventing its selection epoch from advancing between
  // an asset check and the canonical reference rename. No session queue awaits an
  // asset queue. A later cleanup waits for this commit and retires its reference.
  const requestedAssetEpoch = assetMutationEpoch;
  const requestedDeletionEpoch = sessionDeletionEpoch;
  return enqueueAssetOperation(async () => {
    if ((stillAuthorized && !stillAuthorized()) ||
        assetMutationEpoch !== requestedAssetEpoch || sessionDeletionEpoch !== requestedDeletionEpoch ||
        deletingSessions.has(sessionId)) return refused;
    return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'page rich pixel settlement', async () => {
      if ((stillAuthorized && !stillAuthorized()) ||
          assetMutationEpoch !== requestedAssetEpoch || sessionDeletionEpoch !== requestedDeletionEpoch ||
          deletingSessions.has(sessionId) || sessionAttachmentTransitionPending(sessionId) ||
          getRecordingRevision() !== revision || !getConfig().sessions.record ||
          !recordingWriteAllowed(revision)) return refused;
      const target = canonicalPageRichTarget(entry, fields.messageId as string,
        fields.providerMessageId as string, fields.mediaId as string, fields.nodeId as string);
      if (!target || target.rich.revision !== fields.richRevision ||
          target.origin.conversationId !== origin.conversationId ||
          target.origin.bindingRevision !== origin.bindingRevision ||
          target.origin.documentId !== origin.documentId ||
          target.origin.navigationEpoch !== origin.navigationEpoch) return refused;
      const { row, media, index, all } = target;
      if (!media.pageSource || media.pageSource.slotVersion !== fields.expectedSlotVersion ||
          media.pageSource.incarnation !== fields.sourceIncarnation ||
          media.pageSource.sequence !== fields.sourceSequence ||
          media.pageSource.recordingRevision !== revision) return refused;
      if (validatedAsset) {
        const retired = row.retiredRichImageAssetIds;
        if (retired !== undefined && (!Array.isArray(retired) || retired.length > 4096 ||
            retired.some(id => typeof id !== 'string' || !/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(id)) ||
            new Set(retired).size !== retired.length || retired.includes(validatedAsset.id))) return refused;
        const key = localAssetKey(sessionId, validatedAsset.id);
        const removedAt = removedAssetEpoch.get(key);
        const writtenAt = assetWrittenEpoch.get(key);
        if ((removedAt !== undefined && (writtenAt === undefined || writtenAt < removedAt)) ||
            !admittedAssets(sessionId, [validatedAsset])?.length) return refused;
      }
      const replacement: RichMediaState = validatedAsset
        ? { mediaId: media.mediaId, nodeId: media.nodeId, source: media.source,
          pageSource: media.pageSource, status: 'available',
          previewWidth: fields.previewWidth as number, previewHeight: fields.previewHeight as number,
          asset: validatedAsset }
        : { mediaId: media.mediaId, nodeId: media.nodeId, source: media.source,
          pageSource: media.pageSource, status: 'unavailable',
          reason: fields.reason as NonNullable<RichMediaState['reason']> };
      if (media.status !== 'pending') {
        // The durable parser and publisher may enumerate the same fields in a
        // different order. Replay identity is the exact immutable source and
        // semantic payload, not JSON property insertion order.
        const sameAvailable = media.status === 'available' && replacement.status === 'available' &&
          media.reason === undefined && media.previewWidth === replacement.previewWidth &&
          media.previewHeight === replacement.previewHeight &&
          media.asset?.id === replacement.asset?.id &&
          media.asset?.mimeType === replacement.asset?.mimeType &&
          media.asset?.bytes === replacement.asset?.bytes;
        const sameUnavailable = media.status === 'unavailable' && replacement.status === 'unavailable' &&
          media.reason === replacement.reason;
        return sameAvailable || sameUnavailable ? 'unchanged' : refused;
      }
      if (media.reason !== 'not_loaded' || !Number.isSafeInteger(entry.nextSeq) ||
          entry.nextSeq >= Number.MAX_SAFE_INTEGER) return refused;
      const full: Extract<SessionEvent, { kind: 'assistant_message' }> = {
        ...row, richMedia: all.map((item, at) => at === index ? replacement : item), seq: entry.nextSeq
      };
      await writeCanonicalMessage(sessionId, `assistant_message\u0000${fields.messageId}`, full, stillAuthorized);
      entry.messages.set(`assistant_message\u0000${fields.messageId}`, full);
      entry.nextSeq += 1;
      entry.historySeq = full.seq;
      scheduleMeta(entry);
      return 'stored' as const;
    }), () => refused);
  });
}

/**
 * Creates or enriches one ChatGPT-native generated image by exact provider tuple.
 *
 * Metadata is canonical before preview capture starts. A later asset revision advances the
 * sequence cursor while retaining the first origin/time and never contributes completion,
 * Goal, tool-call, or activity facts. Local turn ownership may strengthen once from unknown;
 * later document-local turn hints are ignored because reload remints them, while a conflicting
 * durable agent owner still fails closed.
 */
export function upsertNativeImageEvent(
  sessionId: string,
  event: NewNativeImageEvent
): Promise<{ event: NativeImageEvent; changed: boolean; accepted: boolean }> {
  const key = messageKey(event);
  if (!key) throw new Error('Canonical native image requires provider message and asset ids');
  const revision = getRecordingRevision();
  if (!getConfig().sessions.record) return Promise.reject(new RecordingDisabledError());
  return ensureOpen(sessionId).then((entry) => {
    const write = entry.queue.then(async () => {
      requireRecording(revision);
      const candidate = entry.messages.get(key);
      const previous = candidate?.kind === 'native_image' ? candidate : undefined;
      if (candidate && !previous) throw new Error('Canonical native image identity collision');
      if (
        previous &&
        (previous.providerRole !== event.providerRole ||
          (previous.agent && event.agent && previous.agent !== event.agent))
      ) return { event: previous, changed: false, accepted: false };
      // Explicit image-storage cleanup is a durable decision for this exact provider tuple.
      // A later tab reload may rediscover and re-encode the same native image; accepting it
      // would silently refill storage immediately after the user cleared it.
      if (previous?.previewError === 'removed' && !previous.asset) {
        return { event: previous, changed: false, accepted: false };
      }

      const incomingAsset = event.asset ? admittedAssets(sessionId, [event.asset])?.[0] : undefined;
      const staleAsset = Boolean(event.asset && !incomingAsset);
      const asset = previous?.asset ?? incomingAsset;
      const previewError = previous?.previewError === 'quota' && !asset
        ? 'quota'
        : staleAsset
          ? 'removed'
          : event.previewError ?? previous?.previewError;
      const previewStatus = asset
        ? 'available'
        : previewError
          ? 'unavailable'
          : event.previewStatus;
      const next: NewNativeImageEvent = {
        ...event,
        time: previous?.time ?? event.time,
        ...(previous?.turnId ? { turnId: previous.turnId } : event.turnId ? { turnId: event.turnId } : {}),
        ...(previous?.agent && !event.agent ? { agent: previous.agent } : {}),
        providerChannel: previous?.providerChannel ?? event.providerChannel,
        providerStatus: previous?.providerStatus === 'finished_successfully'
          ? previous.providerStatus : event.providerStatus ?? previous?.providerStatus,
        width: previous?.width ?? event.width,
        height: previous?.height ?? event.height,
        asset: undefined,
        previewStatus,
        previewError,
        ...(asset ? {
          asset,
          previewStatus: 'available',
          previewWidth: previous?.previewWidth ?? event.previewWidth,
          previewHeight: previous?.previewHeight ?? event.previewHeight,
          previewError: undefined
        } : {})
      };
      if (previous) {
        const unchanged =
          previous.turnId === next.turnId && previous.agent === next.agent &&
          previous.providerChannel === next.providerChannel && previous.providerStatus === next.providerStatus &&
          previous.width === next.width && previous.height === next.height &&
          previous.previewWidth === next.previewWidth && previous.previewHeight === next.previewHeight &&
          previous.previewStatus === next.previewStatus && previous.previewError === next.previewError &&
          previous.asset?.id === next.asset?.id && previous.asset?.mimeType === next.asset?.mimeType &&
          previous.asset?.bytes === next.asset?.bytes;
        if (unchanged) return { event: previous, changed: false, accepted: true };
      }
      const full: NativeImageEvent = {
        ...next,
        origin: previous?.origin ?? previous?.seq ?? entry.nextSeq,
        seq: entry.nextSeq
      };
      await writeCanonicalMessage(sessionId, key, full);
      entry.messages.set(key, full);
      entry.nextSeq += 1;
      entry.historySeq = full.seq;
      if (!previous) applyToSummary(entry.summary, full);
      scheduleMeta(entry);
      return { event: full, changed: true, accepted: true };
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => logError(`session native image upsert failed: ${err.message}`)
    );
    return write;
  });
}

function retainedAssets(assets: readonly AssetRef[] | undefined, retired: readonly string[] | undefined): AssetRef[] | undefined {
  if (!assets) return undefined;
  if (!retired?.length) return [...assets];
  const denied = new Set(retired);
  const kept = assets.filter((asset) => !denied.has(asset.id));
  return kept.length ? kept : undefined;
}

/** Canonical background launch: the call UUID owns its later process status. */
export async function recordProcessCall(sessionId: string, event: Omit<Extract<SessionEvent, { kind: 'tool_call' }>, 'seq'>): Promise<void> {
  const revision = getRecordingRevision();
  requireRecording(revision);
  const entry = await ensureOpen(sessionId);
  await enqueueSessionOperation(entry, 'process call', async () => {
    requireRecording(revision);
    const key = messageKey({ ...event, seq: 0 })!;
    if (entry.messages.has(key)) throw new Error('Process call identity already recorded');
    const denied = deniedAssetIds(sessionId, event.call.assets);
    const full = {
      ...event,
      call: {
        ...event.call,
        assets: admittedAssets(sessionId, event.call.assets),
        retiredImageAssetIds: mergedRetiredAssetIds(event.call.retiredImageAssetIds, denied)
      },
      seq: entry.nextSeq,
      origin: entry.nextSeq
    };
    await writeCanonicalMessage(sessionId, key, full);
    entry.messages.set(key, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    applyToSummary(entry.summary, full);
    scheduleMeta(entry);
  });
}

/** Exit revises its launch; it is not a tool invocation, output receipt or turn boundary. */
export async function completeProcessCall(sessionId: string, callId: string, completion: {
  completedAt: number; durationMs: number; exitCode: number | null; benignExit?: boolean;
}): Promise<void> {
  const entry = await ensureOpen(sessionId);
  await enqueueSessionOperation(entry, 'process completion', async () => {
    const key = `tool_call\u0000${callId}`;
    const previous = entry.messages.get(key);
    if (previous?.kind !== 'tool_call' || !previous.call.process || previous.call.process.completedAt !== undefined) return;
    const { exitCode } = completion;
    const failed = exitCode !== null && exitCode !== 0 && completion.benignExit !== true;
    const full: Extract<SessionEvent, { kind: 'tool_call' }> = {
      ...previous, seq: entry.nextSeq,
      call: { ...previous.call, process: { ...previous.call.process, ...completion }, summary: {
        ...previous.call.summary,
        title: previous.call.summary.title.replace(/^Started /, failed ? 'Command failed ' : 'Completed '),
        metric: exitCode === null ? 'finished (exit unknown)' : failed ? `✕ exit ${exitCode}` : '✓ finished',
        tone: exitCode === null ? 'warn' : failed ? 'bad' : 'good'
      } }
    };
    await writeCanonicalMessage(sessionId, key, full);
    entry.messages.set(key, full);
    entry.nextSeq += 1;
    entry.historySeq = full.seq;
    const delta = eventTokens(full) - eventTokens(previous);
    entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
    if (full.call.conversationId === entry.summary.conversationId)
      entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
    scheduleMeta(entry);
  });
}

// ------------------------------------------------------------------- read

export interface ReadOptions {
  /** First sequence number to return, inclusive. */
  from?: number;
  limit?: number;
  kinds?: readonly SessionEvent['kind'][];
  agent?: string;
}

/**
 * Reads events back.
 *
 * A malformed line is skipped and counted rather than throwing: the whole point of
 * an append-only log is that a half-written final line costs one event, not the
 * session. Reading the file in one go is fine at the sizes the caps allow.
 */
export async function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  // /activity is an incremental feed. Canonical messages use their latest revision seq for
  // the cursor while preserving their first-appearance time/origin for chronology.
  const active = open.get(sessionId);
  const timeline = active?.summary ?? (await readDurableSnapshot(sessionId))?.summary;
  if (options.from !== undefined && active) {
    if (from >= active.nextSeq) return [];
    const cacheFloor = active.tailFrom;
    if (from >= cacheFloor) {
      const cached: SessionEvent[] = [...active.tail, ...active.messages.values()].filter((parsed) => {
        if (parsed.seq < from) return false;
        if (options.kinds && !options.kinds.includes(parsed.kind)) return false;
        if (options.agent && parsed.agent !== options.agent) return false;
        return true;
      });
      // `from` is a sequence cursor. Page in sequence order first and only then apply the
      // presentation chronology inside that bounded page; otherwise chronology may move a later
      // row ahead of an earlier seq at the slice boundary and advancing the cursor would skip it.
      const page = cached.sort((left, right) => left.seq - right.seq).slice(0, limit);
      return chronological(projectTimeline(page, timeline?.timelineTurns, timeline?.requestTurns, active.messages.values()));
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') raw = '';
    else throw err;
  }
  const messages = active?.messages ?? (await readCanonicalMessages(sessionId));
  const canonicalKeys = new Set(messages.keys());
  const out: SessionEvent[] = [];
  let damaged = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      damaged++;
      continue;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged++;
      continue;
    }
    if (parsed.seq < from) continue;
    if (options.kinds && !options.kinds.includes(parsed.kind)) continue;
    if (options.agent && parsed.agent !== options.agent) continue;
    // Once a message has a canonical record, a pre-1.8 append-only snapshot with the same
    // ChatGPT identity is legacy journal history, not another transcript item.
    if (messageKey(parsed) && canonicalKeys.has(messageKey(parsed)!)) {
      continue;
    }
    out.push(parsed);
  }
  for (const message of messages.values()) {
    if (message.seq < from) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    out.push(message);
  }
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable event line(s)`);
  // `seq` is the immutable cursor domain; logical chronology is only allowed to reorder a
  // bounded turn whose `turn_start` is present in this read window. Global time sorting used
  // to move unrelated/replayed page history across turn boundaries and disagreed with the
  // extension renderer, which already used the shared rule. One function now defines the
  // transcript order everywhere.
  if (options.from !== undefined) {
    const page = out.sort((left, right) => left.seq - right.seq).slice(0, limit);
    return chronological(projectTimeline(page, timeline?.timelineTurns, timeline?.requestTurns, messages.values()));
  }
  return chronological(projectTimeline(out, timeline?.timelineTurns, timeline?.requestTurns, messages.values())).slice(0, limit);
}

/**
 * Manual history navigation only: an exact physically persisted assistant shard,
 * never the permissive merged transcript reader, an old JSONL event or a model URL.
 * This gives no browser/native-action authority; the sender and current selection
 * are separate main-process checks at the eventual fixed IPC boundary.
 */
export type CanonicalRichMessageOrigin = Readonly<{
  messageId: string;
  providerMessageId: string;
  conversationId: string;
  richRevision: number;
  bindingRevision: number;
}>;

const richMessageIdValid = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 190 && !/[\u0000-\u001f\u007f]/.test(id);

/** Historical navigation and inert control inspection must not mistake a permissively
 * alias-collapsed transcript for unique physical provider ownership. All checks happen
 * inside the session queue; an unreadable or oversized custody set is unavailable. */
async function strictRichAssistantShard(
  sessionId: string, key: string, providerMessageId: string
): Promise<SessionEvent | null> {
  const base = sessionDir(sessionId);
  const directory = path.join(base, 'messages');
  const filename = `${createHash('sha256').update(key).digest('hex')}.json`;
  const ancestry = [root, base, directory];
  const directoryStats: Array<Awaited<ReturnType<typeof fs.lstat>>> = [];
  try {
    const realPaths: string[] = [];
    for (const component of ancestry) {
      const stat = await fs.lstat(component);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      directoryStats.push(stat);
      realPaths.push(await fs.realpath(component));
    }
    if (!sameFilesystemPath(path.dirname(realPaths[1]!), realPaths[0]!) ||
        !sameFilesystemPath(path.dirname(realPaths[2]!), realPaths[1]!) ||
        path.basename(realPaths[1]!) !== sessionId || path.basename(realPaths[2]!) !== 'messages') return null;

    const target = path.join(directory, filename);
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size < 2 ||
        targetStat.size > MAX_CANONICAL_MESSAGE_BYTES ||
        !sameFilesystemPath(path.dirname(await fs.realpath(target)), realPaths[2]!)) return null;
    const raw = await readBoundedOwnerSource(target, targetStat);
    if (raw === null) return null;
    const persisted: SessionEvent = JSON.parse(raw);
    if (persisted.kind !== 'assistant_message' || messageKey(persisted) !== key ||
        persisted.providerMessageId !== providerMessageId) return null;

    // The migration-era whole-map snapshot can still claim another logical owner.
    // Do not use readCanonicalMessages(): that reader silently folds physical aliases.
    const legacy = path.join(base, 'messages.json');
    let legacyBefore: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      const legacyStat = await fs.lstat(legacy);
      if (!legacyStat.isFile() || legacyStat.isSymbolicLink() ||
          legacyStat.size > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
      legacyBefore = legacyStat;
      const legacyRaw = await readBoundedOwnerSource(legacy, legacyStat);
      if (legacyRaw === null) return null;
      const values: unknown = JSON.parse(legacyRaw);
      if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
      for (const [legacyKey, value] of Object.entries(values)) {
        const row = value as CanonicalEvent;
        if (!row || typeof row !== 'object' || messageKey(row) !== legacyKey) return null;
        if (legacyKey !== key && row.kind === 'assistant_message' &&
            row.providerMessageId === providerMessageId) return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }

    const listing = await fs.opendir(directory);
    try {
      let entries = 0;
      let bytes = 0;
      let foundTarget = false;
      for await (const item of listing) {
        if (++entries > 8192) return null;
        if (!item.name.endsWith('.json')) continue; // queued atomic writers use .tmp
        if (!/^[a-f0-9]{64}\.json$/.test(item.name)) return null;
        const file = path.join(directory, item.name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 ||
            stat.size > MAX_CANONICAL_MESSAGE_BYTES ||
            (bytes += stat.size) > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
        const content = await readBoundedOwnerSource(file, stat);
        if (content === null) return null;
        const row: CanonicalEvent = JSON.parse(content);
        const rowKey = messageKey(row);
        if (!rowKey || !Number.isSafeInteger(row.seq) ||
            `${createHash('sha256').update(rowKey).digest('hex')}.json` !== item.name) return null;
        if (rowKey === key) {
          if (foundTarget || JSON.stringify(row) !== JSON.stringify(persisted)) return null;
          foundTarget = true;
        } else if (row.kind === 'assistant_message' && row.providerMessageId === providerMessageId) return null;
      }
      if (!foundTarget) return null;
    } finally { await listing.close().catch(() => undefined); }

    // A rename during an awaited read must not silently change the custody path.
    // Detect replacement of an already-read target and newly inserted physical aliases
    // even when the directory inode itself remains unchanged.
    const targetAfter = await fs.lstat(target);
    if (!targetAfter.isFile() || targetAfter.isSymbolicLink() ||
        targetAfter.dev !== targetStat.dev || targetAfter.ino !== targetStat.ino ||
        targetAfter.size !== targetStat.size || targetAfter.mtimeMs !== targetStat.mtimeMs ||
        targetAfter.ctimeMs !== targetStat.ctimeMs) return null;
    // Checking an absent legacy map only once is insufficient: an alias can be
    // inserted in the session parent during our awaited shard enumeration.
    // Require its final existence and exact file identity to match that first read.
    try {
      const legacyAfter = await fs.lstat(legacy);
      if (!legacyBefore || !legacyAfter.isFile() || legacyAfter.isSymbolicLink() ||
          legacyAfter.dev !== legacyBefore.dev || legacyAfter.ino !== legacyBefore.ino ||
          legacyAfter.size !== legacyBefore.size || legacyAfter.mtimeMs !== legacyBefore.mtimeMs ||
          legacyAfter.ctimeMs !== legacyBefore.ctimeMs) return null;
    } catch (error) {
      if (legacyBefore || (error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    for (let index = 0; index < ancestry.length; index++) {
      const after = await fs.lstat(ancestry[index]!);
      const before = directoryStats[index]!;
      if (!after.isDirectory() || after.isSymbolicLink() ||
          after.dev !== before.dev || after.ino !== before.ino ||
          (index > 0 && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) ||
          !sameFilesystemPath(await fs.realpath(ancestry[index]!), realPaths[index]!)) return null;
    }
    return persisted;
  } catch { return null; }
}

/** Shared strict physical proof for historical navigation and the inert control descriptor.
 * Caller MUST hold this session's queue. Neither result authenticates a browser gesture. */
async function verifiedRichAssistant(
  entry: OpenSession, sessionId: string, messageId: string
): Promise<{ rich: RichResponse; origin: RichOrigin; providerMessageId: string } | null> {
  if (deletingSessions.has(sessionId) || sessionAttachmentTransitionPending(sessionId)) return null;
  const key = `assistant_message\u0000${messageId}`;
  const current = entry.messages.get(key);
  if (!current || current.kind !== 'assistant_message' || current.messageId !== messageId ||
      !current.providerMessageId || !current.rich || !current.richOrigin ||
      !Number.isSafeInteger(current.seq) || current.seq < 1) return null;
  // Never substitute a permissive JSONL/legacy fallback or an alias-collapsed memory row
  // when the exact SHA-named modern shard is absent, replaced or corrupt.
  const persisted = await strictRichAssistantShard(sessionId, key, current.providerMessageId);
  if (!persisted || persisted.kind !== 'assistant_message' ||
      JSON.stringify(persisted) !== JSON.stringify(current) ||
      persisted.messageId !== messageId ||
      persisted.providerMessageId !== current.providerMessageId) return null;
  const rich = parseRichResponse(persisted.rich);
  const origin = parseRichOrigin(persisted.richOrigin);
  if (!rich || !origin || !rich.providerMessageId || rich.revision < 1 ||
      rich.messageId !== messageId || rich.providerMessageId !== persisted.providerMessageId ||
      rich.conversationId !== origin.conversationId ||
      !entry.summary.chatIds.includes(origin.conversationId) ||
      !Number.isSafeInteger(entry.summary.bindingRevision ?? 0) ||
      origin.bindingRevision > (entry.summary.bindingRevision ?? 0) ||
      [...entry.messages.entries()].some(([otherKey, row]) => otherKey !== key &&
        row.kind === 'assistant_message' && row.providerMessageId === persisted.providerMessageId)) return null;
  return { rich, origin, providerMessageId: persisted.providerMessageId! };
}

export function readCanonicalRichMessageOrigin(
  sessionId: string, messageId: string
): Promise<CanonicalRichMessageOrigin | null> {
  if (!richMessageIdValid(messageId) || deletingSessions.has(sessionId)) return Promise.resolve(null);
  assertSessionId(sessionId);
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'manual rich origin read', async () => {
    const exact = await verifiedRichAssistant(entry, sessionId, messageId);
    if (!exact) return null;
    return Object.freeze({ messageId, providerMessageId: exact.providerMessageId,
      conversationId: exact.origin.conversationId, richRevision: exact.rich.revision,
      bindingRevision: exact.origin.bindingRevision });
  })).catch(() => null);
}

/** Current canonical PAGE image metadata suitable for displaying an explicit Retry choice.
 * This is a snapshot, not a capture ticket, deletion override, browser-opening permission,
 * native tuple association or grant. A later consumer must acquire its own one-use authority
 * and reprove every identity after each await; native generated-image reuse is not enabled. */
export type CanonicalRichMediaRetryEligibility = Readonly<{
  sessionId: string;
  conversationId: string;
  messageId: string;
  providerMessageId: string;
  bindingRevision: number;
  documentId: string;
  navigationEpoch: number;
  richRevision: number;
  recordingRevision: number;
  cleanupEpoch: number;
  presentationSeq: number;
  mediaId: string;
  nodeId: string;
  source: 'page';
  status: 'pending' | 'unavailable';
  reason: RichMediaState['reason'] | null;
  requiresRemovalConfirmation: boolean;
  eligibilityOnly: true;
}>;

/** @internal A purely in-memory admission fence. Never hydrate, repair metadata,
 * seal a journal tail or build the attachment catalog for a Retry inquiry. A
 * cold or ambiguous owner is unavailable until ordinary session recovery runs. */
export function readWarmRichRetrySession(sessionId: string): SessionSummary | null {
  const entry = open.get(sessionId);
  const catalog = attachmentCatalog;
  const conversationId = entry?.summary.conversationId;
  if (!entry || !conversationId || !catalog || attachmentCatalogLoading ||
      opening.has(sessionId) || reconciling.has(sessionId) ||
      deletingSessions.has(sessionId) || sessionAttachmentTransitionPending(sessionId)) return null;
  const owners = catalog.current.get(conversationId);
  if (!owners || owners.size !== 1 || !owners.has(sessionId) ||
      [...open].some(([id, other]) => id !== sessionId &&
        other.summary.conversationId === conversationId)) return null;
  return { ...entry.summary };
}

export function readCanonicalRichMediaRetryEligibility(
  sessionId: string, messageId: string, mediaId: string, nodeId: string, expectedRichRevision: number,
  options: Readonly<{ warmOnly?: boolean }> = {}
): Promise<CanonicalRichMediaRetryEligibility | null> {
  if (!richMessageIdValid(messageId) || !richMediaOpaque(mediaId) || !richMediaOpaque(nodeId) ||
      !Number.isSafeInteger(expectedRichRevision) || expectedRichRevision < 1 ||
      deletingSessions.has(sessionId) || sessionAttachmentTransitionPending(sessionId)) return Promise.resolve(null);
  assertSessionId(sessionId);
  // Cleanup revokes eligibility synchronously at its request edge, even before it
  // reaches the session queue to persist the removed-slot and asset tombstones.
  const cleanupEpoch = assetMutationEpoch;
  const deletionEpoch = sessionDeletionEpoch;
  const recordingRevision = getRecordingRevision();
  const stillReadable = (): boolean => assetMutationEpoch === cleanupEpoch &&
    sessionDeletionEpoch === deletionEpoch && !deletingSessions.has(sessionId) &&
    !sessionAttachmentTransitionPending(sessionId) && recordingWriteAllowed(recordingRevision);
  if (!stillReadable() || (options.warmOnly === true && !readWarmRichRetrySession(sessionId)))
    return Promise.resolve(null);
  // The warm-only path must NEVER run ensureOpen: it seals torn journals,
  // reconciles metadata and changes retention lifetime for cold sessions.
  const initial = options.warmOnly === true ? Promise.resolve(open.get(sessionId)!) : ensureOpen(sessionId);
  return initial.then(entry => enqueueSessionOperation(entry, 'inert rich media retry read', async () => {
    if (!stillReadable()) return null;
    const exact = await verifiedRichAssistant(entry, sessionId, messageId);
    if (!exact || !stillReadable() || exact.rich.status !== 'available' ||
        exact.rich.revision !== expectedRichRevision ||
        entry.summary.conversationId !== exact.origin.conversationId ||
        (entry.summary.bindingRevision ?? 0) !== exact.origin.bindingRevision ||
        isChatBlocked(exact.origin.conversationId)) return null;
    const row = entry.messages.get(`assistant_message\u0000${messageId}`);
    if (!row || row.kind !== 'assistant_message' || row.source !== 'extension' ||
        !Number.isSafeInteger(row.seq) || row.seq < 1) return null;
    const media = cleanupRichMedia(row);
    const retiredSlots = parsedRetiredRichMediaSlots(row.retiredRichMediaSlots);
    const retiredAssets = row.retiredRichImageAssetIds;
    if (!media || retiredSlots === null || (retiredAssets !== undefined &&
        (!Array.isArray(retiredAssets) || retiredAssets.length > 4096 ||
         retiredAssets.some(id => typeof id !== 'string' ||
           !/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(id)) ||
         new Set(retiredAssets).size !== retiredAssets.length))) return null;
    const matches = media.filter(slot => slot.mediaId === mediaId && slot.nodeId === nodeId);
    if (matches.length !== 1 || !exactRichImageNode(exact.rich, mediaId, nodeId)) return null;
    const slot = matches[0]!;
    // Native metadata can be entered synthetically. It is not proof that the
    // provider's typed image pointer belongs to this specific rendered rich node.
    if (slot.source.kind !== 'page' || slot.source.nodeId !== nodeId || slot.asset ||
        (slot.status !== 'pending' && slot.status !== 'unavailable')) return null;
    const removed = retiredSlots.find(item => item.mediaId === mediaId);
    const requiresRemovalConfirmation = slot.status === 'unavailable' && slot.reason === 'removed';
    if (requiresRemovalConfirmation
      ? !removed || removed.nodeId !== nodeId
      : removed !== undefined) return null;
    return Object.freeze({ sessionId, conversationId: exact.origin.conversationId,
      messageId, providerMessageId: exact.providerMessageId,
      bindingRevision: exact.origin.bindingRevision, documentId: exact.origin.documentId,
      navigationEpoch: exact.origin.navigationEpoch, richRevision: exact.rich.revision,
      recordingRevision, cleanupEpoch,
      presentationSeq: row.seq, mediaId, nodeId, source: 'page' as const,
      status: slot.status, reason: slot.reason ?? null, requiresRemovalConfirmation,
      eligibilityOnly: true as const });
  })).then(async candidate => {
    if (!candidate || !stillReadable() || isChatBlocked(candidate.conversationId)) return null;
    const ownerEpoch = attachmentEpoch;
    // findSessionByConversation may recover/write a cold catalog or cold owner.
    // A passive inquiry instead requires an already indexed, warm unique owner.
    const owner = options.warmOnly === true
      ? readWarmRichRetrySession(sessionId)
      : await findSessionByConversation(candidate.conversationId, { requireUnique: true });
    if (owner?.id !== sessionId || await conversationWasSuperseded(candidate.conversationId) ||
        !stillReadable() || isChatBlocked(candidate.conversationId) || attachmentEpoch !== ownerEpoch ||
        [...open].some(([id, entry]) => id !== sessionId &&
          entry.summary.conversationId === candidate.conversationId)) return null;
    const finalOwners = attachmentCatalog?.current.get(candidate.conversationId);
    if (!finalOwners || finalOwners.size !== 1 || !finalOwners.has(sessionId)) return null;
    const live = open.get(sessionId);
    const latest = live?.messages.get(`assistant_message\u0000${messageId}`);
    if (!live || live.summary.conversationId !== candidate.conversationId ||
        (live.summary.bindingRevision ?? 0) !== candidate.bindingRevision ||
        latest?.kind !== 'assistant_message' || latest.seq !== candidate.presentationSeq ||
        latest.providerMessageId !== candidate.providerMessageId ||
        latest.rich?.revision !== candidate.richRevision ||
        latest.richOrigin?.documentId !== candidate.documentId ||
        latest.richOrigin?.navigationEpoch !== candidate.navigationEpoch ||
        !stillReadable() || isChatBlocked(candidate.conversationId)) return null;
    // Unique-owner/catalog verification awaited independently of the original
    // SHA shard read. An external replacement during that wait must not leave a
    // stale eligibility descriptor that a future user-action owner could mistake
    // for current source proof. Reacquire the session queue and inspect the exact
    // physical assistant AGAIN; this is still read-only, not browser authority.
    return enqueueSessionOperation(live, 'final inert rich media retry source recheck', async () => {
      if (!stillReadable() || isChatBlocked(candidate.conversationId) ||
          attachmentEpoch !== ownerEpoch || sessionAttachmentTransitionPending(sessionId)) return null;
      const verified = await verifiedRichAssistant(live, sessionId, messageId);
      if (!verified || verified.providerMessageId !== candidate.providerMessageId ||
          verified.origin.conversationId !== candidate.conversationId ||
          verified.origin.bindingRevision !== candidate.bindingRevision ||
          verified.origin.documentId !== candidate.documentId ||
          verified.origin.navigationEpoch !== candidate.navigationEpoch ||
          verified.rich.revision !== candidate.richRevision) return null;
      const current = live.messages.get(`assistant_message\u0000${messageId}`);
      const media = current?.kind === 'assistant_message' ? cleanupRichMedia(current) : null;
      const removedSlots = current?.kind === 'assistant_message'
        ? parsedRetiredRichMediaSlots(current.retiredRichMediaSlots) : null;
      const matches = media?.filter(slot => slot.mediaId === mediaId && slot.nodeId === nodeId);
      const slot = matches?.length === 1 ? matches[0] : null;
      const removed = removedSlots?.find(item => item.mediaId === mediaId);
      if (current?.kind !== 'assistant_message' || current.seq !== candidate.presentationSeq ||
          !slot || slot.source.kind !== 'page' || slot.source.nodeId !== nodeId || slot.asset ||
          slot.status !== candidate.status || (slot.reason ?? null) !== candidate.reason ||
          !exactRichImageNode(verified.rich, mediaId, nodeId) || removedSlots === null ||
          (candidate.requiresRemovalConfirmation
            ? !removed || removed.nodeId !== nodeId : removed !== undefined) ||
          live.summary.conversationId !== candidate.conversationId ||
          (live.summary.bindingRevision ?? 0) !== candidate.bindingRevision ||
          attachmentEpoch !== ownerEpoch || !stillReadable() ||
          isChatBlocked(candidate.conversationId)) return null;
      const owners = attachmentCatalog?.current.get(candidate.conversationId);
      return owners?.size === 1 && owners.has(sessionId) &&
        ![...open].some(([otherId, entry]) => otherId !== sessionId &&
          entry.summary.conversationId === candidate.conversationId) ? candidate : null;
    });
  }).catch(() => null);
}

/** @internal A caller's expected fields are comparisons, NOT a Retry Capture claim.
 * This never reads the action ledger, creates a ticket, admits bytes, changes a
 * tombstone or establishes a browser gesture. Only the current physical PAGE
 * source can match; a future owner must independently establish action authority. */
export type InertRichRetrySourceExpectation = Readonly<{
  sessionId: string; conversationId: string; bindingRevision: number;
  messageId: string; providerMessageId: string; richRevision: number;
  presentationSeq: number; mediaId: string; nodeId: string;
  originDocumentId: string; originNavigationEpoch: number;
  recordingRevision: number; recordingGeneration: string; cleanupEpoch: number;
}>;

export function inspectInertRichRetrySource(
  expectation: InertRichRetrySourceExpectation,
  options: Readonly<{ warmOnly?: boolean }> = {}
): Promise<Readonly<{ kind: 'source_matches'; authority: 'none' }> | null> {
  const names = ['sessionId', 'conversationId', 'bindingRevision', 'messageId',
    'providerMessageId', 'richRevision', 'presentationSeq', 'mediaId', 'nodeId',
    'originDocumentId', 'originNavigationEpoch', 'recordingRevision',
    'recordingGeneration', 'cleanupEpoch'];
  const expected = richMediaFields(expectation, names, names);
  const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!expected || typeof expected.sessionId !== 'string' ||
      !/^[0-9a-z-]{8,64}$/i.test(expected.sessionId) ||
      typeof expected.conversationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.conversationId) ||
      !nonnegative(expected.bindingRevision) || !richMessageIdValid(expected.messageId) ||
      typeof expected.providerMessageId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.providerMessageId) ||
      !nonnegative(expected.richRevision) || expected.richRevision === 0 ||
      !nonnegative(expected.presentationSeq) || expected.presentationSeq === 0 ||
      !richMediaOpaque(expected.mediaId) || !richMediaOpaque(expected.nodeId) ||
      expected.mediaId !== `media-${expected.nodeId}` ||
      typeof expected.originDocumentId !== 'string' ||
      !/^[a-z0-9_-]{1,128}$/i.test(expected.originDocumentId) ||
      !nonnegative(expected.originNavigationEpoch) || !nonnegative(expected.recordingRevision) ||
      typeof expected.recordingGeneration !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(expected.recordingGeneration) ||
      !nonnegative(expected.cleanupEpoch)) return Promise.resolve(null);

  // Freeze before any await. The recording token is continuity evidence only:
  // its equality neither authenticates the caller nor permits a browser action.
  const recordingRevision = getRecordingRevision();
  const recordingGeneration = recordingGenerationGrant();
  const cleanupEpoch = assetMutationEpoch;
  const deletionEpoch = sessionDeletionEpoch;
  const ownerEpoch = attachmentEpoch;
  const sessionId = expected.sessionId;
  const conversationId = expected.conversationId;
  const current = (): boolean => recordingGeneration !== null &&
    expected.recordingRevision === recordingRevision &&
    expected.recordingGeneration === recordingGeneration &&
    expected.cleanupEpoch === cleanupEpoch &&
    recordingGenerationGrant() === recordingGeneration &&
    getRecordingRevision() === recordingRevision && recordingWriteAllowed(recordingRevision) &&
    assetMutationEpoch === cleanupEpoch && sessionDeletionEpoch === deletionEpoch &&
    attachmentEpoch === ownerEpoch && !deletingSessions.has(sessionId) &&
    !uncertainCleanupSessions.has(sessionId) && !sessionAttachmentTransitionPending(sessionId) &&
    !isChatBlocked(conversationId);
  if (!current()) return Promise.resolve(null);

  // The existing reader twice inspects the exact SHA-named assistant, validates
  // source floor/media/tombstones and proves the unique current conversation owner
  // across its catalog awaits. Do not return or expose its display descriptor.
  return readCanonicalRichMediaRetryEligibility(sessionId, expected.messageId as string,
    expected.mediaId as string, expected.nodeId as string, expected.richRevision as number, options)
    .then(source => {
      if (!current() || !source || source.eligibilityOnly !== true || source.source !== 'page' ||
          source.requiresRemovalConfirmation ||
          (source.status !== 'pending' && source.status !== 'unavailable') ||
          source.reason === 'removed' || source.sessionId !== sessionId ||
          source.conversationId !== conversationId ||
          source.bindingRevision !== expected.bindingRevision ||
          source.messageId !== expected.messageId ||
          source.providerMessageId !== expected.providerMessageId ||
          source.richRevision !== expected.richRevision ||
          source.presentationSeq !== expected.presentationSeq ||
          source.mediaId !== expected.mediaId || source.nodeId !== expected.nodeId ||
          source.documentId !== expected.originDocumentId ||
          source.navigationEpoch !== expected.originNavigationEpoch ||
          source.recordingRevision !== recordingRevision ||
          source.cleanupEpoch !== cleanupEpoch) return null;
      return Object.freeze({ kind: 'source_matches' as const, authority: 'none' as const });
    }).catch(() => null);
}

/** Historical presentation is not native selection or permission to click. This read-only
 * descriptor is valid solely for the exact CURRENT physical assistant, source and binding;
 * the caller must re-prove them after any await and independently establish human input. */
export type CanonicalRichControlDescriptor = Readonly<{
  sessionId: string;
  conversationId: string;
  messageId: string;
  providerMessageId: string;
  bindingRevision: number;
  documentId: string;
  navigationEpoch: number;
  richRevision: number;
  nodeId: string;
  groupId: string;
  kind: 'select' | 'continue';
  value: string | null;
  expectedSelected: boolean;
  expectedGroupSelection: string | null;
  historicalSelectionOnly: true;
}>;

type SavedRichControl = Extract<RichNode, { kind: 'control' }>;

/** The schema guarantees unique node IDs, not unique native form/group membership. Reject
 * two forms sharing an id, duplicate values, ambiguous selection or mixed control families. */
function describeInertRichControl(
  rich: RichResponse, targetId: string
): Pick<CanonicalRichControlDescriptor,
  'nodeId' | 'groupId' | 'kind' | 'value' | 'expectedSelected' |
  'expectedGroupSelection' | 'historicalSelectionOnly'> | null {
  if (rich.status !== 'available') return null;
  const formGroups = new Map<string, string>();
  const formControls = new Map<string, SavedRichControl[]>();
  const rootControls = new Map<string, Array<{ form: string; control: SavedRichControl }>>();
  let target: SavedRichControl | null = null;
  let targetForm: string | null = null;
  let targetRoot: string | null = null;
  const visit = (nodes: readonly RichNode[], form: string | null, rootGroup: string | null): boolean => {
    for (const node of nodes) {
      if (node.kind === 'group') {
        // Row/grid/column are presentation wrappers, not independently proven native
        // form boundaries. A nested layout inside a card inherits its card's form;
        // distinct sibling cards under a wrapper remain independently scoped.
        const nextForm = node.layout === 'card' || !form ? node.id : form;
        if (!visit(node.children, nextForm, rootGroup ?? node.id)) return false;
        continue;
      }
      if (node.kind !== 'control') continue;
      // Nested controls cannot establish a single original native form.
      if (node.children.some(child => child.kind === 'control' || child.kind === 'group')) return false;
      if (node.id === targetId) {
        target = node;
        targetForm = form;
        targetRoot = rootGroup;
      }
      if (form) {
        const members = formControls.get(form) ?? [];
        members.push(node);
        formControls.set(form, members);
        if (rootGroup) {
          const rootMembers = rootControls.get(rootGroup) ?? [];
          rootMembers.push({ form, control: node });
          rootControls.set(rootGroup, rootMembers);
        }
      }
      if (node.groupId !== null) {
        if (!form || !/^[a-z0-9:._-]{1,190}$/i.test(node.groupId)) return false;
        const priorForm = formGroups.get(node.groupId);
        if (priorForm && priorForm !== form) return false;
        formGroups.set(node.groupId, form);
      }
    }
    return true;
  };
  if (!visit(rich.nodes, null, null) || !target || !targetForm || !targetRoot) return null;
  const selectedTarget = target as SavedRichControl;
  if ((selectedTarget.control !== 'choice' && selectedTarget.control !== 'continue') ||
      selectedTarget.disabled || !selectedTarget.groupId ||
      formGroups.get(selectedTarget.groupId) !== targetForm) return null;
  // Direct controls in a generic wrapper and controls inside one of its child
  // cards have no authenticated distinct form membership. Refuse the mixture
  // instead of silently ignoring a competing outer Continue/default choice.
  const rootMembers = rootControls.get(targetRoot) ?? [];
  if (rootMembers.some(member => member.form !== targetForm &&
      (member.form === targetRoot || targetForm === targetRoot))) return null;
  const siblings = formControls.get(targetForm) ?? [];
  const values = new Set<string>();
  let selected: string | null = null;
  let continues = 0;
  let choices = 0;
  for (const sibling of siblings) {
    // All physical-form members, including ungrouped and differently grouped ones,
    // must belong to this single identifiable choice/Continue family.
    if (sibling.groupId !== selectedTarget.groupId) return null;
    if (sibling.control === 'choice') {
      if (!sibling.value || sibling.value.length > 512 || values.has(sibling.value)) return null;
      choices++;
      values.add(sibling.value);
      if (sibling.selected) {
        if (sibling.disabled || selected !== null) return null;
        selected = sibling.value;
      }
    } else if (sibling.control === 'continue') {
      if (++continues > 1 || sibling.value !== null || sibling.selected) return null;
    } else return null;
  }
  if (!choices || (selectedTarget.control === 'choice' &&
      (selectedTarget.value === null || !values.has(selectedTarget.value))) ||
      (selectedTarget.control === 'continue' && (!continues || selected === null))) return null;
  return { nodeId: selectedTarget.id, groupId: selectedTarget.groupId,
    kind: selectedTarget.control === 'continue' ? 'continue' : 'select',
    value: selectedTarget.value, expectedSelected: selectedTarget.selected,
    expectedGroupSelection: selected, historicalSelectionOnly: true };
}

export function readCanonicalRichControlDescriptor(
  sessionId: string, messageId: string, nodeId: string
): Promise<CanonicalRichControlDescriptor | null> {
  if (!richMessageIdValid(messageId) || !richMessageIdValid(nodeId) ||
      deletingSessions.has(sessionId)) return Promise.resolve(null);
  assertSessionId(sessionId);
  return ensureOpen(sessionId).then(entry => enqueueSessionOperation(entry, 'inert rich control read', async () => {
    const exact = await verifiedRichAssistant(entry, sessionId, messageId);
    if (!exact || entry.summary.conversationId !== exact.origin.conversationId ||
        (entry.summary.bindingRevision ?? 0) !== exact.origin.bindingRevision) return null;
    const control = describeInertRichControl(exact.rich, nodeId);
    if (!control) return null;
    return Object.freeze({ sessionId, conversationId: exact.origin.conversationId, messageId,
      providerMessageId: exact.providerMessageId, bindingRevision: exact.origin.bindingRevision,
      documentId: exact.origin.documentId, navigationEpoch: exact.origin.navigationEpoch,
      richRevision: exact.rich.revision, ...control });
  })).then(async candidate => {
    if (!candidate) return null;
    // The physical shard is verified inside its queue; the unique current owner and
    // superseded lineage are catalog-owned facts. Recheck the live source after those
    // asynchronous reads. This remains a structural snapshot, never action authority.
    const ownerEpoch = attachmentEpoch;
    const owner = await findSessionByConversation(candidate.conversationId, { requireUnique: true });
    if (owner?.id !== sessionId || await conversationWasSuperseded(candidate.conversationId) ||
        deletingSessions.has(sessionId) || sessionAttachmentTransitionPending(sessionId)) return null;
    // A second session can acquire the same conversation while the supersession
    // query awaits. Its first creation is exposed in `open` before its durable
    // attachment publication; published mutations also increment attachmentEpoch.
    // Neither the old owner result nor the target's own unchanged row proves
    // uniqueness across that intervening await.
    if (attachmentEpoch !== ownerEpoch ||
        [...open].some(([id, entry]) => id !== sessionId &&
          entry.summary.conversationId === candidate.conversationId)) return null;
    const finalOwners = attachmentCatalog?.current.get(candidate.conversationId);
    if (!finalOwners || finalOwners.size !== 1 || !finalOwners.has(sessionId)) return null;
    const live = open.get(sessionId);
    const row = live?.messages.get(`assistant_message\u0000${messageId}`);
    if (!live || live.summary.conversationId !== candidate.conversationId ||
        (live.summary.bindingRevision ?? 0) !== candidate.bindingRevision ||
        row?.kind !== 'assistant_message' || row.providerMessageId !== candidate.providerMessageId ||
        row.rich?.revision !== candidate.richRevision ||
        row.richOrigin?.documentId !== candidate.documentId ||
        row.richOrigin?.navigationEpoch !== candidate.navigationEpoch) return null;
    return candidate;
  }).catch(() => null);
}

/**
 * Reads only the newest matching presentation window without materialising the whole JSONL journal.
 *
 * This exists for UI/default-history tails. Full-text search, call expansion and explicit old
 * cursors still use `readEvents()` because they genuinely need older rows. The scan walks the
 * journal backwards and stops once it has enough matching rows (or reaches the bounded byte
 * budget), so `limit: 1` cannot turn into a 40 MB read. Tool status revisions retain their
 * invocation position; they cannot displace newer model work from a limit-one read.
 */
export async function readRecentEvents(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & { maxBytes?: number; before?: number; after?: number; orderByOrigin?: boolean } = {}
): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  return readRecentEventsFromDisk(sessionId, limit, options);
}

/**
 * An absent ID in a recent history window is not evidence that a worker's page tool
 * or lifecycle row is new. Search the exact durable session in fixed-size backwards
 * chunks until this ID is found or the entire journal has been read. Unlike a UI
 * history tail, a damaged row makes negative identity proof unavailable and throws;
 * the browser can retry without getting a false first-sight receipt.
 */
export async function readExactNativeHistoryIdentity(
  sessionId: string,
  kind: 'page_tool' | 'turn_start' | 'turn_end',
  id: string
): Promise<{ original: SessionEvent; latest: SessionEvent } | null> {
  assertSessionId(sessionId);
  if (!id || id.length > 200) throw new Error('Invalid native history identity');
  await flushSession(sessionId);
  // A page-tool label can be revised many times. Its latest text is presentation,
  // while the earliest physical row owns origin, timestamp, turn and agent. Keep
  // just those two rows and scan to the start; later revisions cannot invent the
  // provenance of a pending worker's historical tool.
  let original: SessionEvent | null = null;
  let latest: SessionEvent | null = null;
  const [found] = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: [kind], before: Number.POSITIVE_INFINITY, strictIdentity: true,
    acceptEvent: row => {
      const matching = row.kind === kind &&
        (kind === 'page_tool' ? row.kind === 'page_tool' && row.messageId === id :
          (row.kind === 'turn_start' || row.kind === 'turn_end') && row.turnId === id);
      if (!matching) return false;
      if (kind !== 'page_tool') return true;
      if (!latest) latest = row;
      original = row;
      return false;
    }
  });
  const first = kind === 'page_tool' ? original as SessionEvent | null : found;
  const newest = kind === 'page_tool' ? latest as SessionEvent | null : found;
  if (!first || !newest) return null;
  if (!Number.isSafeInteger(first.seq) || first.seq < 0 ||
      !Number.isSafeInteger(newest.seq) || newest.seq < first.seq ||
      (kind === 'page_tool' &&
        (first.kind !== 'page_tool' || newest.kind !== 'page_tool' ||
          typeof first.label !== 'string' || typeof newest.label !== 'string' ||
          (first.origin !== undefined && first.origin !== first.seq) ||
          (newest.origin !== undefined && newest.origin !== first.seq))))
    throw new Error('Native history identity has invalid original provenance');
  return { original: first, latest: newest };
}

/** The latest authored question. A recovery source excludes its injected corrections,
 * which have no native user bubble and cannot grant another error reload. */
export async function readLatestUserMessage(sessionId: string, _turnId?: string | null): Promise<Extract<SessionEvent, { kind: 'user_message' }> | undefined> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const summary = await readAuthoritativeSummary(sessionId);
  const [message] = await readRecentEventsFromDisk(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true,
    before: Number.POSITIVE_INFINITY, acceptEvent: (event: SessionEvent) => !injectedUserMessage(event, summary?.timelineTurns) });
  return message?.kind === 'user_message' ? message : undefined;
}

/** An injected instruction belongs to its existing generation, even after native reconciliation. */
function isTurnCorrection(event: SessionEvent, turnId?: string | null, turns?: TimelineTurns): boolean {
  return injectedUserMessage(event, turns) && !!turnId && !!event.turnId &&
    responseTurnId(turns, event.turnId) === responseTurnId(turns, turnId);
}

/** Latest lifecycle boundary for one recovery source. Injected same-turn instructions
 * do not replace it; a new question, another turn, or a stop still does. Message revisions
 * retain their authored position so replaying an old question cannot cancel current work. */
export async function readRecoveryBoundary(sessionId: string, turnId?: string | null): Promise<SessionEvent | undefined> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  // Read under this session's existing queue. Another read or metadata flush
  // must not invalidate the boundary and permanently spend a valid silence grant.
  return enqueueSessionOperation(entry, 'recovery boundary read', async () => {
    const [boundary] = await readRecentEventsFromDisk(sessionId, 1, {
      kinds: ['turn_start', 'turn_end', 'user_message'], orderByOrigin: true,
      before: Number.POSITIVE_INFINITY,
      acceptEvent: event => !isTurnCorrection(event, turnId, entry.summary.timelineTurns)
    });
    return boundary;
  });
}

/** Canonical completion evidence shared by activity retirement and input eligibility.
 * No turn is manufactured: an unowned reply must follow the latest recorded question.
 * Committed history and binding changes invalidate the snapshot. Unrelated reads
 * replacing a queue promise do not make a known final into an unfinished response. */
export async function readCompletedFinal(sessionId: string, conversationId: string, turnId?: string | null): Promise<{
  messageId: string; turnId: string | null; completedAt: number; contentSeq: number; text: string;
} | null> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  const revision = entry.nextSeq;
  if (entry.summary.conversationId !== conversationId) return null;
  const [recent, questions] = await Promise.all([
    readRecentEventsFromDisk(sessionId, 256, { kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message', 'tool_call', 'page_tool'] }),
    readRecentEventsFromDisk(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true,
      before: Infinity, acceptEvent: event => !injectedUserMessage(event, entry.summary.timelineTurns) })
  ]);
  if (entry.nextSeq !== revision || entry.summary.conversationId !== conversationId) return null;
  const sameTurn = (left: string | null | undefined, right: string | null | undefined) => !!left && !!right &&
    responseTurnId(entry.summary.timelineTurns, left) === responseTurnId(entry.summary.timelineTurns, right);
  const final = recent.findLast(event => event.kind === 'assistant_message' && event.final === true &&
    (!!event.message.text.trim() || !!event.providerMessageId) && !!event.messageId && (!turnId || event.turnId === turnId ||
      (!!event.providerMessageId && sameTurn(event.turnId, turnId)) ||
      (turnId.startsWith('reply:') && event.messageId === turnId.slice(6))));
  if (!final || final.kind !== 'assistant_message' || !final.messageId) return null;
  const seq = final.finalContentSeq ?? positionOf(final);
  const completedAt = final.finalObservedAt ?? final.time;
  const question = questions[0];
  const correction = (event: SessionEvent) => isTurnCorrection(event, final.turnId, entry.summary.timelineTurns) && positionOf(event) < seq;
  if (question && positionOf(question) >= positionOf(final) && !correction(question)) return null;
  // With no generation identity, require an actual preceding authored boundary.
  if (!final.turnId && (!question || question.time > final.time)) return null;
  if (entry.summary.activeTurnId && !sameTurn(entry.summary.activeTurnId, final.turnId)) return null;
  const boundaries = recent.filter(event => event.kind === 'turn_start' || event.kind === 'turn_end').sort((a, b) => a.seq - b.seq);
  const last = boundaries.at(-1), prior = boundaries.at(-2);
  const nativeReopen = !!final.providerMessageId && last?.kind === 'turn_start' && last.source === 'app' &&
    last.turnId === final.turnId && prior?.kind === 'turn_end' && prior.turnId === final.turnId && prior.outcome === 'completed';
  if (recent.some(event => {
    if (event === final || workSequence(event) <= seq) return false;
    if (event.kind === 'tool_call') {
      if (event.time <= completedAt) return false;
      // A public native final settles its request even when Pro delivers another
      // connector call afterwards. Require proof recorded BEFORE that final; a new
      // request or conflicting generation is fresh work, not a trailing result.
      const owner = event.source === 'mcp' && event.call.attribution === 'request_id'
        ? recordedRequestTurn(entry.summary.requestTurns, event.call.requestId, conversationId) : undefined;
      return !(final.providerMessageId && final.state === 'final' && owner && owner.origin < seq &&
        sameTurn(owner.turnId, final.turnId) && event.call.conversationId === conversationId &&
        (!event.turnId || sameTurn(event.turnId, final.turnId)));
    }
    if (event.kind === 'turn_end') return !sameTurn(event.turnId, final.turnId) || event.outcome !== 'completed';
    if (event.kind === 'turn_start') return !(nativeReopen && event === last);
    if (event.kind === 'user_message') return !correction(event);
    return event.kind === 'assistant_message' || event.kind === 'page_tool';
  })) return null;
  return { messageId: final.messageId, turnId: final.turnId ?? null, completedAt, contentSeq: seq, text: final.message.text };
}

/** Recorded local execution, not a native tool label or a request-id sighting alone. */
export async function turnHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  // Attribution repair appends historical calls, often without a known turn. Such a tail
  // cannot erase earlier exact proof. Filter inside one bounded-buffer reverse scan so a
  // missing proof does not repeatedly rescan the journal for each presentation page.
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    acceptEvent: call => call.kind === 'tool_call' && call.turnId === turnId && call.source === 'mcp' &&
      call.call?.conversationId === conversationId && call.call.attribution === 'request_id'
  });
  return calls.length > 0;
}

/** Late exact attribution can prove chat health without pretending historical work is new. */
export async function conversationHasMcpCallSince(
  sessionId: string, conversationId: string, startedAt: number, turnId: string | null
): Promise<boolean> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    // Repaired calls may lack a local turn id. Exact conversation and original call
    // time still prove attribution; an explicitly different turn does not.
    acceptEvent: event => event.kind === 'tool_call' && event.source === 'mcp' && event.time >= startedAt &&
      (!event.turnId || event.turnId === turnId) && event.call?.conversationId === conversationId &&
      event.call.attribution === 'request_id'
  });
  return calls.length > 0;
}

async function readRecentEventsFromDisk(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & {
    maxBytes?: number; before?: number; after?: number; acceptEvent?: (event: SessionEvent) => boolean;
    orderByOrigin?: boolean; strictIdentity?: boolean
  } = {}
): Promise<SessionEvent[]> {
  const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
  const active = open.get(sessionId);
  const needsMessages =
    !options.kinds || options.kinds.includes('user_message') || options.kinds.includes('assistant_message') ||
    options.kinds.includes('native_image') || options.kinds.includes('tool_call');
  const messages = needsMessages ? active?.messages ?? (await readCanonicalMessages(sessionId)) : new Map<string, CanonicalEvent>();
  const canonicalKeys = new Set(messages.keys());
  // Pre-canonical sessions could append every streaming revision of one stable website
  // message to events.jsonl. This reader builds a *presentation* tail, so those revisions are
  // one logical row here just as a canonical message is one row today. Because the journal is
  // scanned newest-first, the first key seen is the latest revision; duplicates must not spend
  // the row cap or a long old answer can hide every earlier user turn from Goal/history tails.
  const legacyMessageKeys = new Set<string>();
  const rawTail: SessionEvent[] = [];
  const sequence = options.orderByOrigin ? positionOf : workSequence;
  const forward = options.after !== undefined;
  let replaced = 0;
  let reachedStart = false;
  const scanning = () => !reachedStart;
  let damaged = 0;
  // Explicit history navigation may seek beyond the recent-tail budget. It streams backwards
  // in fixed chunks and retains only this page, never materializing the complete journal.
  const readBudget = options.before === undefined && !forward ? Math.max(64 * 1024, Math.min(MAX_RECENT_READ_BYTES, options.maxBytes ?? MAX_RECENT_READ_BYTES)) : Number.POSITIVE_INFINITY;

  const accept = (line: Buffer): void => {
    if (!scanning() || line.length === 0) return;
    if (line.length > MAX_LINE_BYTES) {
      damaged += 1;
      return;
    }
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line.toString('utf8')) as SessionEvent;
    } catch {
      damaged += 1;
      return;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged += 1;
      return;
    }
    // A late label/status revision can have an old work sequence. Filling the
    // row cap with it is not proof that we reached the newest actual work.
    const oldest = !forward && rawTail.length === cap
      ? rawTail.reduce((a, b) => sequence(a) < sequence(b) ? a : b) : undefined;
    if (oldest && parsed.seq < sequence(oldest)) { reachedStart = true; return; }
    // Journal sequence is append ordered. Canonical revisions are joined below;
    // crossing the forward origin boundary retires this backwards scan.
    if (forward && parsed.seq <= options.after!) { reachedStart = true; return; }
    if (options.before !== undefined && sequence(parsed) >= options.before) return;
    if (forward && sequence(parsed) <= options.after!) return;
    if (options.kinds && !options.kinds.includes(parsed.kind)) return;
    if (options.agent && parsed.agent !== options.agent) return;
    if (options.acceptEvent && !options.acceptEvent(parsed)) return;
    if (messageKey(parsed)) {
      const key = messageKey(parsed);
      if (key) {
        if (canonicalKeys.has(key) || legacyMessageKeys.has(key)) return;
        legacyMessageKeys.add(key);
      }
    }
    if (rawTail.length < cap) rawTail.push(parsed);
    else if (forward) rawTail[replaced++ % cap] = parsed;
    else if (oldest && sequence(parsed) > sequence(oldest)) rawTail[rawTail.indexOf(oldest)] = parsed;
  };

  const file = path.join(sessionDir(sessionId), 'events.jsonl');
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    let cursor = (await handle.stat()).size;
    let bytes = 0;
    let carry = Buffer.alloc(0);
    while (cursor > 0 && scanning() && bytes < readBudget) {
      const wanted = Math.min(64 * 1024, cursor, readBudget - bytes);
      if (wanted <= 0) break;
      cursor -= wanted;
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, cursor);
      if (options.strictIdentity && bytesRead !== wanted) {
        throw new Error('Native history identity could not be verified from a short journal read');
      }
      const joined = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      bytes += bytesRead;
      const firstNewline = joined.indexOf(0x0a);
      if (firstNewline < 0) {
        // A corrupt/no-newline tail used to repeatedly copy the complete 8 MiB budget:
        // 64 KiB + 128 KiB + ... . Retain only one maximum event while seeking a boundary.
        if (joined.length > MAX_LINE_BYTES + 1) damaged += 1;
        carry = joined.subarray(0, Math.min(joined.length, MAX_LINE_BYTES + 1));
        continue;
      }
      carry = joined.subarray(0, firstNewline);
      const complete = joined.subarray(firstNewline + 1);
      let endAt = complete.length;
      for (let at = complete.length - 1; at >= 0 && scanning(); at--) {
        if (complete[at] !== 0x0a) continue;
        const line = complete.subarray(at + 1, endAt);
        if (line.length > 0) accept(line);
        endAt = at;
      }
      if (scanning() && endAt > 0) accept(complete.subarray(0, endAt));
    }
    if (cursor === 0 && scanning() && carry.length > 0) accept(carry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Session creation always creates this journal, even before its first row.
    // A missing file in an existing session cannot prove that an ID never existed.
    if (options.strictIdentity) throw new Error('Native history identity journal is missing');
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const candidates: SessionEvent[] = [...rawTail];
  for (const message of messages.values()) {
    if (options.before !== undefined && sequence(message) >= options.before) continue;
    if (forward && sequence(message) <= options.after!) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    if (options.acceptEvent && !options.acceptEvent(message)) continue;
    candidates.push(message);
  }
  candidates.sort((left, right) => sequence(left) - sequence(right));
  const selected = forward ? candidates.slice(0, cap) : candidates.slice(Math.max(0, candidates.length - cap));
  if (options.strictIdentity && damaged > 0) {
    throw new Error('Native history identity could not be verified from a damaged journal');
  }
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable recent event line(s)`);
  const timeline = active?.summary ?? (await readDurableSnapshot(sessionId))?.summary;
  return chronological(projectTimeline(selected, timeline?.timelineTurns, timeline?.requestTurns, messages.values()));
}

/** Browser projection joins committed writes without forcing the debounced metadata to disk.
 * A cold store hydrates one bounded journal tail. Thereafter the existing append/message owners
 * maintain it, including revisions whose origin is older than the browser cursor. */
export async function readActivityEvents(sessionId: string, since: number, limit = 1200): Promise<{
  events: SessionEvent[]; reset: boolean; resumeBoundary: number;
  openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
  resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
}> {
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'activity read', async () => {
    if (!entry.activityHydrated) {
      const recent = await readRecentEventsFromDisk(sessionId, MAX_EVENT_TAIL);
      entry.tail = recent.filter((event) => !(messageKey(event) && entry.messages.has(messageKey(event)!)));
      // Old canonical messages do not prove that intervening journal rows fitted inside
      // the byte budget. Only the retained journal suffix establishes cursor coverage.
      entry.tailFrom = entry.tail.reduce((first, event) => Math.min(first, event.seq), entry.nextSeq);
      entry.activityHydrated = true;
    }
    const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
    const cursor = Number.isFinite(since) ? Math.max(0, since) : 0;
    const candidates = [...entry.tail, ...entry.messages.values()].sort((a, b) => a.seq - b.seq);
    const reset = cursor < entry.tailFrom && !(cursor === 0 && entry.tailFrom === 1);
    const selected = reset || cursor === 0
      ? candidates.slice(-cap)
      : candidates.filter((event) => event.seq >= cursor).slice(0, cap);
    // All canonical messages remain authoritative after tail eviction and message revision.
    let openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    let resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    for (const event of candidates) {
      if (event.kind !== 'user_message') continue;
      const position = event.origin ?? event.seq;
      if (!openingUserMessage || position < (openingUserMessage.origin ?? openingUserMessage.seq)) openingUserMessage = event;
      if (continuationMarkerOf(event.message.text)?.kind === 'RESUME' &&
          (!resumeUserMessage || position > (resumeUserMessage.origin ?? resumeUserMessage.seq))) resumeUserMessage = event;
    }
    const resumeBoundary = resumeUserMessage ? resumeUserMessage.origin ?? resumeUserMessage.seq : 0;
    return { events: chronological(projectTimeline(selected, entry.summary.timelineTurns, entry.summary.requestTurns, entry.messages.values())), reset: reset || (cursor === 0 && candidates.length > cap), resumeBoundary,
      openingUserMessage, resumeUserMessage };
  });
}

/**
 * Reads one exact tool record that the browser's bounded activity projection has already
 * hydrated. This is deliberately not a history lookup: opening a disclosure must never open a
 * session, scan its journal, or resolve an overflow asset independently of `/activity`.
 */
export async function readHydratedActivityCall(
  sessionId: string,
  conversationId: string,
  callId: string,
  detailRevision: number
): Promise<Extract<SessionEvent, { kind: 'tool_call' }> | null> {
  const entry = open.get(sessionId);
  if (!entry || !entry.activityHydrated || entry.summary.conversationId !== conversationId) return null;
  return enqueueSessionOperation(entry, 'activity call detail', async () => {
    // The entry may have been closed/replaced while this read waited behind an accepted write.
    if (open.get(sessionId) !== entry || !entry.activityHydrated || entry.summary.conversationId !== conversationId) return null;
    const exact = (event: SessionEvent | undefined): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
      event?.kind === 'tool_call' &&
      event.seq === detailRevision &&
      event.call.callId === callId &&
      event.call.conversationId === conversationId;
    const project = (event: Extract<SessionEvent, { kind: 'tool_call' }>): Extract<SessionEvent, { kind: 'tool_call' }> =>
      projectTimeline([event], entry.summary.timelineTurns, entry.summary.requestTurns, entry.messages.values())[0] as
        Extract<SessionEvent, { kind: 'tool_call' }>;

    // Canonical background-process revisions supersede every ordinary copy. A stale requested
    // revision therefore fails closed here instead of falling back to the launch in `tail`.
    const canonical = entry.messages.get(`tool_call\u0000${callId}`);
    if (canonical) return exact(canonical) ? project(canonical) : null;

    // `tail` is already the bounded in-memory suffix owned by readActivityEvents(). Its public
    // ordering is chronology/origin based, so choose the greatest canonical revision explicitly.
    const newest = entry.tail.reduce<Extract<SessionEvent, { kind: 'tool_call' }> | null>((held, event) =>
      event.kind === 'tool_call' && event.call.callId === callId && (!held || event.seq > held.seq) ? event : held, null);
    return newest && exact(newest) ? project(newest) : null;
  });
}

/**
 * Atomically keeps only the supplied tool calls in an Unattributed activity session.
 *
 * This is deliberately not a general history editor. 1.8.2 uses it for one deterministic
 * migration: calls whose exact request-id owner is now known are copied to that owner's
 * session, then removed from the legacy Unattributed bucket. Unknown calls remain under the
 * same local session id. Re-sequencing is safe here because this bucket has no ChatGPT
 * conversation, canonical messages, or turn lifecycle: it is only a holding area for calls.
 */
export async function rewriteUnattributedToolCalls(
  sessionId: string,
  calls: readonly Extract<SessionEvent, { kind: 'tool_call' }>[],
  scannedThroughSeq: number,
  deleteEmpty = false
): Promise<{ retained: number; deleted: boolean }> {
  assertSessionId(sessionId);
  const entry = await ensureOpen(sessionId);
  const rewrite = entry.queue.then(async () => {
    if (entry.summary.conversationId !== null || entry.summary.title !== 'Unattributed activity') {
      throw new Error(`Session ${sessionId} is not an Unattributed activity bucket`);
    }

    // `calls` is the repairer's snapshot of rows that were still unattributed. New MCP calls can
    // append to this same holding bucket while the repair is pre-copying assets/destinations. The
    // session queue orders those appends before this rewrite, but blindly writing only the old
    // snapshot would then erase them. Read the now-serialized journal and retain every tool call
    // that appeared after the snapshot's high-water seq. Appends that arrive after this operation
    // has been queued naturally run after the rewrite and receive fresh sequence numbers.
    const concurrentCalls: Extract<SessionEvent, { kind: 'tool_call' }>[] = [];
    try {
      const raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SessionEvent;
          if (event.kind === 'tool_call' && event.seq > scannedThroughSeq) concurrentCalls.push(event);
        } catch {
          // Legacy damaged rows were already excluded by the deterministic repair snapshot. The
          // general reader reports those separately; do not make this narrowly-scoped migration
          // fail after all destination copies succeeded because of an unrelated torn legacy line.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const start: SessionEvent = {
      seq: 1,
      time: entry.summary.startedAt,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: entry.summary.title
    };
    const retainedCalls = [...calls, ...concurrentCalls].sort((left, right) => left.seq - right.seq);
    // Only the recorder can prove this is not its writable bucket: a live call may hold
    // that bucket's id while preparing assets outside this queue. For inactive history,
    // the empty check and deletion share the same queue operation as concurrent-row capture.
    if (deleteEmpty && retainedCalls.length === 0 && entry.queue === settled) {
      if (entry.metaTimer) clearTimeout(entry.metaTimer);
      await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
      if (open.get(sessionId) === entry) open.delete(sessionId);
      invalidateAssetUsage(sessionId);
      publishAttachmentRemoval(sessionId);
      return { retained: 0, deleted: true };
    }
    const kept: SessionEvent[] = [start, ...retainedCalls.map((event, index) => ({ ...event, seq: index + 2 }))];

    const target = path.join(sessionDir(sessionId), 'events.jsonl');
    const tmp = `${target}.repair-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmp, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    await fs.rename(tmp, target);

    const staged: SessionSummary = {
      ...entry.summary,
      updatedAt: entry.summary.startedAt,
      events: 0,
      requestTurns: {},
      userMessages: 0,
      toolCalls: 0,
      lastToolCallAt: null,
      lastAssistantFinalAt: null,
      lastTurnEndAt: null,
      lastFinishReportAt: null,
      processExitNonzero: 0,
      toolRejected: 0,
      toolInternalErrors: 0,
      errors: 0,
      estimatedTokens: 0,
      contextTokens: 0,
      lastHandoffId: null,
      lastHandoffAt: null,
      lastCommittedResumeHandoffId: null,
      lastTurnOutcome: null,
      agents: []
    };
    for (const event of kept) applyToSummary(staged, event);
    const rewrittenHistorySeq = kept.at(-1)?.seq ?? 0;
    await writeSummary(staged, rewrittenHistorySeq);

    Object.assign(entry.summary, staged);
    entry.nextSeq = kept.length + 1;
    entry.historySeq = rewrittenHistorySeq;
    entry.tail = kept.slice(-MAX_EVENT_TAIL);
    entry.tailFrom = entry.tail[0]?.seq ?? entry.nextSeq;
    entry.activityHydrated = true;
    entry.metaDirty = false;
    return { retained: retainedCalls.length, deleted: false };
  });
  const settled = rewrite.then(
    () => undefined,
    (err: Error) => logError(`session unattributed repair failed: ${err.message}`)
  );
  entry.queue = settled;
  return rewrite;
}

function normalizeSummary(id: string, raw: string): MetaCheckpoint | null {
  try {
    const parsed = JSON.parse(raw) as PersistedSummary;
    if (parsed?.id !== id) return null;
    const historySeq =
      Number.isSafeInteger(parsed[META_HISTORY_SEQ]) && (parsed[META_HISTORY_SEQ] as number) >= 0
        ? (parsed[META_HISTORY_SEQ] as number)
        : null;
    const { [META_HISTORY_SEQ]: _historySeq, [META_CANONICAL_PROJECTION]: canonicalProjection, [META_TOKEN_ESTIMATE]: tokenEstimate, ...publicFields } = parsed;
    const publicSummary = publicFields as SessionSummary;
    if (publicSummary.retiredChatAt !== undefined) {
      const retired = publicSummary.retiredChatAt;
      publicSummary.retiredChatAt = retired && typeof retired === 'object' && !Array.isArray(retired)
        ? Object.fromEntries(Object.entries(retired).filter(([chat, at]) =>
          Array.isArray(publicSummary.chatIds) && publicSummary.chatIds.includes(chat) &&
          chat !== publicSummary.conversationId && typeof at === 'number' && Number.isFinite(at) && at >= 0))
        : {};
    }
    if (publicSummary.titleSource !== undefined && !['fallback', 'provider', 'manual'].includes(publicSummary.titleSource)) delete publicSummary.titleSource;
    const selected = publicSummary.selectedModel;
    if (selected !== undefined && (!selected || typeof selected !== 'object' ||
        typeof selected.conversationId !== 'string' || typeof selected.model !== 'string' ||
        !/^[a-zA-Z0-9 ._-]{1,80}$/.test(selected.model) || !Number.isFinite(selected.observedAt))) {
      delete publicSummary.selectedModel;
    }
    const finish = publicSummary.finishTurn;
    if (finish !== undefined && finish !== null && (!finish || typeof finish !== 'object' ||
        typeof finish.turnId !== 'string' || !Number.isFinite(finish.startedAt) ||
        typeof finish.notified !== 'boolean' || typeof finish.released !== 'boolean' ||
        !Number.isSafeInteger(finish.workSeq) || finish.workSeq < 0 || !Number.isSafeInteger(finish.decisionSeq) || finish.decisionSeq < 0 ||
        !(finish.decisionInputRevision === null || (typeof finish.decisionInputRevision === 'string' && /^[a-f0-9]{64}$/.test(finish.decisionInputRevision))) ||
        !(finish.conversationId === null || typeof finish.conversationId === 'string') ||
        !(finish.decisionRevision === null || /^[a-f0-9]{64}$/.test(finish.decisionRevision)))) delete publicSummary.finishTurn;

    // A meta.json written before agents, app-opened chats or the session lineage existed
    // has no such field. A session recorded before the lineage was a single chat by
    // definition, and everything it holds was in that chat's context, so both defaults are
    // the truth rather than a placeholder.
    const outcomeCountersMissing =
      typeof publicSummary.processExitNonzero !== 'number' ||
      typeof publicSummary.toolRejected !== 'number' ||
      typeof publicSummary.toolInternalErrors !== 'number';
    const activityBoundaryMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'lastAssistantFinalAt');
    return {
      historySeq,
      canonicalProjectionCurrent: canonicalProjection === 1,
      tokenEstimateCurrent: tokenEstimate === 1,
      outcomeCountersMissing,
      activityBoundaryMissing,
      summary: {
        ...publicSummary,
        // Keep in-place increments numeric until the forced rebuild supplies the real values.
        processExitNonzero: publicSummary.processExitNonzero ?? 0,
        bindingRevision: Number.isSafeInteger(publicSummary.bindingRevision) && publicSummary.bindingRevision! >= 0
          ? publicSummary.bindingRevision : 0,
        toolRejected: publicSummary.toolRejected ?? 0,
        toolInternalErrors: publicSummary.toolInternalErrors ?? 0,
        // A two-minute display clock is not worth replaying every legacy session during the
        // attachment-catalog scan. The next real tool call sets the exact value immediately.
        lastToolCallAt:
          typeof publicSummary.lastToolCallAt === 'number' && Number.isFinite(publicSummary.lastToolCallAt)
            ? publicSummary.lastToolCallAt
            : null,
        lastAssistantFinalAt:
          typeof publicSummary.lastAssistantFinalAt === 'number' && Number.isFinite(publicSummary.lastAssistantFinalAt)
            ? publicSummary.lastAssistantFinalAt
            : null,
        lastTurnEndAt:
          typeof publicSummary.lastTurnEndAt === 'number' && Number.isFinite(publicSummary.lastTurnEndAt)
            ? publicSummary.lastTurnEndAt
            : null,
        lastFinishReportAt:
          typeof publicSummary.lastFinishReportAt === 'number' && Number.isFinite(publicSummary.lastFinishReportAt)
            ? publicSummary.lastFinishReportAt
            : null,
        agents: Array.isArray(publicSummary.agents) ? publicSummary.agents : [],
        origin: publicSummary.origin ?? null,
        chatIds: Array.isArray(publicSummary.chatIds)
          ? publicSummary.chatIds
          : publicSummary.conversationId
            ? [publicSummary.conversationId]
            : [],
        contextTokens:
          typeof publicSummary.contextTokens === 'number' ? publicSummary.contextTokens : publicSummary.estimatedTokens,
        // Older summaries predate successful-resume provenance. Missing means unknown, never
        // "use lastHandoffId": capture publication happens before the continuation rebind.
        lastCommittedResumeHandoffId:
          typeof publicSummary.lastCommittedResumeHandoffId === 'string' &&
          /^[0-9a-z-]{8,64}$/i.test(publicSummary.lastCommittedResumeHandoffId)
            ? publicSummary.lastCommittedResumeHandoffId
            : null
      }
    };
  } catch {
    return null;
  }
}

async function readMetaCheckpoint(id: string): Promise<MetaCheckpoint | null> {
  const dir = sessionDir(id);
  try {
    const primary = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (primary) return primary;
  } catch {
    // Try the last validated checkpoint below.
  }
  try {
    const backup = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.backup.json'), 'utf8'));
    if (backup) {
      logWarn(`session ${id}: primary meta.json unreadable; using the last validated checkpoint`);
      return backup;
    }
  } catch {
    // No recovery checkpoint.
  }
  logWarn(`session ${id}: no valid metadata projection; refusing to treat it as an empty session`);
  return null;
}

async function readMeta(id: string): Promise<SessionSummary | null> {
  return (await readMetaCheckpoint(id))?.summary ?? null;
}

/**
 * A cold sidebar needs metadata, not every retained message body. A validated modern
 * checkpoint can prove that its projection follows all history writes: the journal and
 * legacy map are files, while canonical shards are replaced by rename, which changes
 * their directory's timestamp. Read the checkpoint timestamp BEFORE its contents so a
 * concurrent atomic metadata replacement can only make this test conservative.
 *
 * Equal clocks, old schemas, unreadable metadata and any newer history keep the existing
 * full recovery path. No guessed summary is allowed to suppress crash reconciliation.
 */
async function readCatalogSummary(id: string): Promise<SessionSummary | null> {
  const dir = sessionDir(id);
  try {
    const metadata = await fs.stat(path.join(dir, 'meta.json'));
    const checkpoint = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (checkpoint && checkpoint.historySeq !== null && checkpoint.canonicalProjectionCurrent && checkpoint.tokenEstimateCurrent &&
        !checkpoint.outcomeCountersMissing && !checkpoint.activityBoundaryMissing && checkpoint.summary.finishTurn !== undefined && !legacyContextTitle(checkpoint.summary)) {
      const mutations = await Promise.all(['events.jsonl', 'messages.json', 'messages'].map(async name => {
        try { return (await fs.stat(path.join(dir, name))).mtimeMs; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      }));
      if (metadata.mtimeMs > 0 && mutations.every(at => at < metadata.mtimeMs)) return checkpoint.summary;
    }
  } catch { /* Existing full reconstruction owns missing/corrupt/uncertain checkpoints. */ }
  return (await readDurableSnapshot(id))?.summary ?? null;
}

function addAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId) ?? new Set<string>();
  ids.add(sessionId);
  map.set(conversationId, ids);
}

function removeAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId);
  if (!ids) return;
  ids.delete(sessionId);
  if (ids.size === 0) map.delete(conversationId);
}

function indexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.set(summary.id, { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
  if (summary.conversationId) addAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) addAttachment(catalog.historical, chatId, summary.id);
}

function unindexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.delete(summary.id);
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  if (summary.conversationId) removeAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) removeAttachment(catalog.historical, chatId, summary.id);
}

function insertSummaryOrder(catalog: AttachmentCatalog, summary: SessionSummary): void {
  let low = 0;
  let high = catalog.orderedIds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const other = catalog.summaries.get(catalog.orderedIds[middle]!);
    if (!other || compareSummariesNewestFirst(summary, other) < 0) high = middle;
    else low = middle + 1;
  }
  catalog.orderedIds.splice(low, 0, summary.id);
}

/** Refreshes only the summary projection; attachment ownership is unchanged. */
function publishCachedSummary(summary: SessionSummary, reorder: boolean): void {
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const clone = { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] };
  catalog.summaries.set(summary.id, clone);
  if (!reorder) return;
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  insertSummaryOrder(catalog, clone);
}

/** Update the derived index only after an attachment mutation is durable. */
function publishAttachmentSummary(summary: SessionSummary): void {
  attachmentEpoch += 1;
  missingCurrentConversations.delete(summary.conversationId ?? '');
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(summary.id);
  if (previous) unindexSummary(catalog, previous);
  indexSummary(catalog, summary);
  insertSummaryOrder(catalog, catalog.summaries.get(summary.id)!);
}

/** Remove one durable session from the derived ownership index. */
function publishAttachmentRemoval(sessionId: string): void {
  attachmentEpoch += 1;
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(sessionId);
  if (previous) unindexSummary(catalog, previous);
}

/** A closing live session must become the durable ordered row before its live overlay vanishes. */
function publishClosedSummary(summary: SessionSummary): void {
  // If the first catalog pass already read this row before close, force that in-flight snapshot
  // to retry. Once a catalog exists, this is just one binary-positioned row update.
  attachmentEpoch += 1;
  publishCachedSummary(summary, true);
}

function newAttachmentCatalog(): AttachmentCatalog {
  return { summaries: new Map(), orderedIds: [], current: new Map(), historical: new Map() };
}

/**
 * Builds the identity catalog from every valid session metadata folder, without the UI's
 * 5,000-session cap. If create/rebind/delete lands while the pass is reading disk, its epoch
 * change invalidates the pass and it is repeated, so a completed catalog is never a snapshot
 * that silently predates a concurrent ownership mutation.
 */
async function ensureAttachmentCatalog(): Promise<AttachmentCatalog> {
  if (attachmentCatalog) return attachmentCatalog;
  if (attachmentCatalogLoading) return attachmentCatalogLoading;
  const loading = (async () => {
    const startedAt = Date.now();
    for (;;) {
      assertReady();
      const epoch = attachmentEpoch;
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch (error) {
        // A fresh install legitimately has no sessions directory yet. Any other failure is not
        // evidence that the durable catalog is empty. Caching EBUSY/EACCES/IO errors here poisons
        // every ownership, retention and latest-handoff lookup for the rest of the process.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
        else throw error;
      }
      const catalog = newAttachmentCatalog();
      const candidates = names.filter((name) => /^[0-9a-z-]{8,64}$/i.test(name));
      for (let offset = 0; offset < candidates.length; offset += ATTACHMENT_CATALOG_READ_CONCURRENCY) {
        const summaries = await Promise.all(
          candidates.slice(offset, offset + ATTACHMENT_CATALOG_READ_CONCURRENCY).map(async (name) => {
            const live = open.get(name);
            return live?.summary ?? await readCatalogSummary(name).catch(() => null);
          })
        );
        for (const summary of summaries) if (summary) indexSummary(catalog, summary);
      }
      catalog.orderedIds = [...catalog.summaries.values()]
        .sort(compareSummariesNewestFirst)
        .map((summary) => summary.id);
      if (attachmentEpoch !== epoch) continue;
      attachmentCatalog = catalog;
      logInfo(`session catalog ready: ${catalog.summaries.size} sessions in ${Date.now() - startedAt} ms`);
      return catalog;
    }
  })();
  attachmentCatalogLoading = loading;
  try {
    return await loading;
  } finally {
    if (attachmentCatalogLoading === loading) attachmentCatalogLoading = null;
  }
}

/**
 * Every readable session, newest first. Live summaries win over what is on disk.
 *
 * Legacy/model-facing bounded list. Do not use this for correctness properties that promise
 * to see every retained session; identity, latest-handoff recovery and retention use the
 * uncapped process catalog instead.
 */
async function readAllSummaries(): Promise<SessionSummary[]> {
  assertReady();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  const candidates = names.filter(name => /^[0-9a-z-]{8,64}$/i.test(name));
  if (candidates.length > MAX_SCANNED_SESSIONS)
    logWarn(`session store: more than ${MAX_SCANNED_SESSIONS} session folders; older ones were not scanned`);
  for (let offset = 0; offset < Math.min(candidates.length, MAX_SCANNED_SESSIONS); offset += ATTACHMENT_CATALOG_READ_CONCURRENCY) {
    const rows = await Promise.all(candidates.slice(offset, Math.min(offset + ATTACHMENT_CATALOG_READ_CONCURRENCY, MAX_SCANNED_SESSIONS))
      .map(async name => open.get(name)?.summary ?? await readMeta(name)));
    for (const summary of rows) if (summary) summaries.push({ ...summary });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Every valid session summary, with no maintenance/UI scan cap.
 *
 * Most callers deliberately stop after 5,000 folders so a pathological history cannot make a
 * routine UI refresh unbounded. `latestHandoff()` is different: its answer is a recovery
 * authority. Missing the newest resumable handoff because `readdir()` happened to return that
 * folder after an arbitrary cap can resume the wrong work. Keep the expensive path explicit
 * and use it only where "every session" is part of the contract.
 */
async function readEverySummary(): Promise<SessionSummary[]> {
  const catalog = await ensureAttachmentCatalog();
  const summaries = new Map<string, SessionSummary>();
  for (const summary of catalog.summaries.values()) summaries.set(summary.id, summary);
  // Live projections are authoritative between debounced meta writes.
  for (const entry of open.values()) summaries.set(entry.summary.id, entry.summary);
  return [...summaries.values()].map((summary) => ({ ...summary })).sort(compareSummariesNewestFirst);
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  nextCursor: SessionListCursor | null;
}

function compareSummariesNewestFirst(left: SessionSummary, right: SessionSummary): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function comesAfterCursor(summary: SessionSummary, cursor: SessionListCursor): boolean {
  return summary.updatedAt < cursor.updatedAt || (summary.updatedAt === cursor.updatedAt && summary.id < cursor.id);
}

/**
 * One bounded UI page from a process-lifetime summary index.
 *
 * The first call pays the one metadata discovery pass that identity already needs. Every hot
 * refresh after that is memory-only in the number of retained summaries plus the tiny live
 * overlay; no coalesced recorder tick rereads thousands of meta.json files. The cursor is the
 * last visible sort key rather than an offset, so a live session moving to the front cannot make
 * history pagination duplicate/skip the boundary it already crossed.
 */
export async function listSessionPage(options: {
  limit?: number;
  cursor?: SessionListCursor;
} = {}): Promise<SessionPage> {
  const catalog = await ensureAttachmentCatalog();
  const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Math.floor(options.limit ?? MAX_LISTED_SESSIONS)));
  const openIds = new Set(open.keys());
  const candidates: SessionSummary[] = [];

  // Open summaries are authoritative between debounced metadata writes. There are normally one
  // or a handful, so overlay them explicitly instead of rebuilding/sorting every retained row.
  for (const entry of open.values()) {
    if (entry.summary.origin?.kind === 'helper') continue;
    if (options.cursor && !comesAfterCursor(entry.summary, options.cursor)) continue;
    candidates.push({ ...entry.summary, chatIds: [...entry.summary.chatIds], agents: [...entry.summary.agents] });
  }

  // The durable order is already maintained incrementally. Collect only one page plus one
  // sentinel; a hot first-page refresh therefore stays O(page + open sessions), even with
  // thousands of retained sessions. Deep pages scan to their cursor only when the user asks.
  let durableEligible = 0;
  let durableHasMore = false;
  for (const id of catalog.orderedIds) {
    if (openIds.has(id)) continue;
    const summary = catalog.summaries.get(id);
    if (!summary || summary.origin?.kind === 'helper' || (options.cursor && !comesAfterCursor(summary, options.cursor))) continue;
    if (durableEligible > limit) {
      durableHasMore = true;
      break;
    }
    candidates.push({ ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
    durableEligible += 1;
  }

  candidates.sort(compareSummariesNewestFirst);
  const sessions = candidates.slice(0, limit);
  const last = sessions.at(-1);
  const hasMore = durableHasMore || candidates.length > sessions.length;
  const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  let total = 0;
  for (const summary of catalog.summaries.values()) {
    if (!openIds.has(summary.id) && summary.origin?.kind !== 'helper') total += 1;
  }
  for (const entry of open.values()) if (entry.summary.origin?.kind !== 'helper') total += 1;
  return { sessions, total, nextCursor };
}

/** Newest first, capped for older internal/UI callers. */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await listSessionPage({ limit: MAX_LISTED_SESSIONS })).sessions;
}

/** Full bounded compatibility/model-facing view. Never use it for retention or identity. */
/** Usage shares the live metadata index; it must not reopen every meta.json per visit. */
export async function listUsageSessions(): Promise<SessionSummary[]> {
  return readEverySummary();
}

export async function listAllSessions(): Promise<SessionSummary[]> {
  return readAllSummaries();
}

/** Uncapped authoritative catalog plus live projections, without reopening every metadata file. */
export async function indexedSessions(): Promise<SessionSummary[]> {
  return readEverySummary();
}

/**
 * Finds the durable session that owns one ChatGPT conversation id.
 *
 * `listSessions()` is intentionally capped for the UI and therefore must never be used as an
 * ownership index: once a chat falls outside the UI's current display cap, doing so silently turns "not in
 * the list" into "never existed" and can fork a second session for the same conversation.
 *
 * Page/browser reopen paths use the default current-only lookup. A proven late MCP request may
 * opt into `includeHistorical` so a conversation that was superseded by Compact & Resume still
 * resolves to the durable session whose `chatIds` lineage contains it. Ambiguity fails closed.
 */
export async function findSessionByConversation(
  conversationId: string,
  options: { includeHistorical?: boolean; requireUnique?: boolean } = {}
): Promise<SessionSummary | null> {
  if (!conversationId) return null;
  if (options.includeHistorical !== true && missingCurrentConversations.has(conversationId)) return null;
  const catalog = await ensureAttachmentCatalog();
  const currentIds = new Set(catalog.current.get(conversationId) ?? []);
  // A create is deliberately visible to this process from the moment its live entry exists.
  // That prevents a concurrent recorder batch from manufacturing a second session while the
  // first session's initial files are still being written. Rebinds never expose B here early:
  // they mutate the live summary only after durable meta says B.
  for (const [id, entry] of open) {
    if (entry.summary.conversationId === conversationId) currentIds.add(id);
  }
  const current = (
    await Promise.all(
      [...currentIds].map((id) => getSession(id).catch(() => null))
    )
  )
    .filter((summary): summary is SessionSummary => summary?.conversationId === conversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (current.length === 1) return current[0] ?? null;
  if (current.length > 1) {
    if (options.requireUnique === true) {
      logWarn(`session store: conversation ${conversationId} is current on ${current.length} sessions; refusing safety-sensitive lookup`);
      return null;
    }
    // Browser/page reopen semantics historically used the newest current session. Keep that
    // deterministic choice rather than manufacturing a third session. Safety-sensitive
    // callers (orphan retirement) opt into requireUnique above.
    return current[0] ?? null;
  }
  if (options.includeHistorical !== true) {
    rememberMissingCurrentConversation(conversationId);
    return null;
  }
  const historicalIds = new Set(catalog.historical.get(conversationId) ?? []);
  for (const [id, entry] of open) {
    if (entry.summary.chatIds.includes(conversationId)) historicalIds.add(id);
  }
  const historical = (
    await Promise.all(
      [...historicalIds].map((id) => getSession(id).catch(() => null))
    )
  )
    .filter((summary): summary is SessionSummary => summary?.chatIds.includes(conversationId) === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (historical.length === 1) return historical[0] ?? null;
  if (historical.length > 1) {
    logWarn(`session store: conversation ${conversationId} appears in ${historical.length} session lineages; refusing to guess`);
  }
  return null;
}

/**
 * Has this ChatGPT conversation already been replaced inside any durable session lineage?
 *
 * This is intentionally independent of current attachment. Opening an old source chat after
 * Compact & Resume may create a new recording epoch for genuinely new user activity there, but
 * it must never restore automation authority that the successful A->B handoff retired. The
 * lineage is the durable fact: if any retained session contains A while being attached to a
 * different conversation, A is historical for browser recovery, Goal and Loop forever.
 */
export async function conversationWasSuperseded(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  const catalog = await ensureAttachmentCatalog();
  const sessionIds = new Set(catalog.historical.get(conversationId) ?? []);
  for (const [id, entry] of open) {
    if (entry.summary.chatIds.includes(conversationId)) sessionIds.add(id);
  }
  for (const id of sessionIds) {
    const summary = open.get(id)?.summary ?? catalog.summaries.get(id) ?? null;
    if (summary?.chatIds.includes(conversationId) && summary.conversationId !== conversationId) return true;
  }
  return false;
}

/**
 * Whether one ChatGPT frontend is still the session's executable attachment.
 *
 * Historical `chatIds` are transcript lineage, not continuing authority. Compact & Resume
 * deliberately keeps A there so old messages remain readable, while `conversationId` moves to
 * B. Every caller that has to decide whether new work from A is still admissible uses this one
 * store-owned verdict rather than reinterpreting lineage for itself.
 */
export async function conversationAttachment(
  conversationId: string,
  sessionId: string | null = null
): Promise<'current' | 'superseded' | 'unknown'> {
  if (!conversationId) return 'unknown';
  if (sessionId) {
    const exact = await getSession(sessionId);
    if (!exact || !exact.chatIds.includes(conversationId)) return 'unknown';
    return exact.conversationId === conversationId ? 'current' : 'superseded';
  }
  const current = await findSessionByConversation(conversationId, { requireUnique: true });
  if (current) return 'current';
  return (await conversationWasSuperseded(conversationId)) ? 'superseded' : 'unknown';
}

/**
 * Filesystem time of the newest durable mutation belonging to a session.
 *
 * Session event timestamps describe when an action happened, not when it finally reached
 * disk. A five-minute MCP call therefore appends today with a `startedAt` from five minutes
 * ago. Stale/orphan cleanup must not look only at that semantic clock and immediately retire
 * work that was just written. The max mtime of the three mutable session projections is the
 * durable inactivity clock it needs.
 */
export async function sessionDurableModifiedAt(id: string): Promise<number | null> {
  assertSessionId(id);
  let newest = 0;
  for (const name of ['events.jsonl', 'messages.json', 'messages', 'meta.json']) {
    try {
      const stat = await fs.stat(path.join(sessionDir(id), name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // A session can legitimately predate messages.json or have no structured events yet.
    }
  }
  return newest > 0 ? newest : null;
}

export async function getSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const summary = await readAuthoritativeSummary(id);
  return summary ? { ...summary } : null;
}

/** Positive absence for retiring an exact delivered receipt, never corrupt metadata. */
export async function sessionDirectoryMissing(id: string): Promise<boolean> {
  assertSessionId(id);
  const dir = sessionDir(id);
  if (open.has(id) || opening.has(id)) return false;
  try {
    await fs.lstat(dir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  // An unavailable history root is not evidence that the user removed this session.
  try {
    return (await fs.stat(root)).isDirectory() && !open.has(id) && !opening.has(id);
  } catch { return false; }
}

/** A plan is one replaceable session document, not another execution queue. */
async function readPlanFile(id: string): Promise<AgentPlan | null> {
  let handle;
  try {
    handle = await fs.open(path.join(sessionDir(id), 'plan.json'), 'r');
    const buffer = Buffer.alloc(MAX_AGENT_PLAN_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_AGENT_PLAN_BYTES) return null;
    const parsed = agentPlanSchema.safeParse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function readSessionPlan(id: string): Promise<AgentPlan | null> {
  assertSessionId(id);
  await open.get(id)?.queue;
  return readPlanFile(id);
}

export async function updateSessionPlan(
  id: string, conversationId: string, input: AgentPlanUpdate, startedAt: number,
  recovery?: { storedAt: number }
): Promise<boolean> {
  const plan = agentPlanSchema.parse({ ...agentPlanUpdateSchema.parse(input), updatedAt: startedAt });
  const bytes = JSON.stringify(plan);
  if (Buffer.byteLength(bytes) > MAX_AGENT_PLAN_BYTES) throw new Error('Plan exceeds its storage budget');
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'plan', async () => {
    // Rebind and plan updates use this same queue. A delayed A call cannot overwrite
    // B's plan after Compact & Resume, even if A was current when the tool started.
    if (entry.summary.conversationId !== conversationId) {
      const retiredAt = entry.summary.retiredChatAt?.[conversationId];
      if (!recovery || !entry.summary.conversationId || !entry.summary.chatIds.includes(conversationId) ||
        typeof retiredAt !== 'number' || !Number.isFinite(recovery.storedAt) || recovery.storedAt < 0 ||
        Math.max(startedAt, recovery.storedAt) >= retiredAt) return false;
    }
    const previous = await readPlanFile(id);
    if (previous && previous.updatedAt > startedAt) return false;
    const target = path.join(sessionDir(id), 'plan.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return true;
  });
}

export async function endSession(id: string, dismissBrowserRecovery = false, expectedConversationId?: string): Promise<void> {
  const entry = dismissBrowserRecovery ? await ensureOpen(id) : open.get(id);
  if (!entry) return;
  const ended = await enqueueSessionOperation(entry, 'end', async () => {
    // A source tab may close while Compact & Resume commits a different frontend.
    if (expectedConversationId !== undefined && entry.summary.conversationId !== expectedConversationId) return false;
    if (entry.metaTimer) {
      clearTimeout(entry.metaTimer);
      entry.metaTimer = null;
    }
    entry.summary.endedAt = Date.now();
    if (dismissBrowserRecovery) entry.summary.browserRecoveryDismissedAt = entry.summary.endedAt;
    await writeMeta(entry);
    publishClosedSummary(entry.summary);
    return true;
  });
  if (ended && open.get(id) === entry) open.delete(id);
}

/**
 * Marks a session live again.
 *
 * Closing a ChatGPT tab ends its session, and reopening the same conversation
 * continues it — deliberately, so a chat is one history rather than a fragment per
 * visit. Without this the reopened session kept the `endedAt` from the close, and
 * everything after it was appended to a session the UI still drew as finished.
 */
export async function reopenSession(id: string, pageObservedAt?: number): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'reopen', async () => {
    const dismissedAt = entry.summary.browserRecoveryDismissedAt;
    const returned = dismissedAt !== undefined && pageObservedAt !== undefined && pageObservedAt > dismissedAt;
    if (entry.summary.endedAt === null && !returned) return;
    if (returned) delete entry.summary.browserRecoveryDismissedAt;
    entry.summary.endedAt = null;
    entry.summary.updatedAt = Date.now();
    await writeMeta(entry);
  });
}

export async function renameSession(id: string, title: string, source: SessionSummary['titleSource'] = 'manual', conversationId?: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'rename', async () => {
    if (source !== 'manual') {
      if (conversationId && entry.summary.conversationId !== conversationId) return;
      if (!automaticTitle(entry.summary, firstTitleMessage(entry.messages.values()))) return;
      if (source === 'fallback' && entry.summary.titleSource === 'provider') return;
    }
    if (entry.summary.title === title.slice(0, 120) && entry.summary.titleSource === source) return;
    entry.summary.title = title.slice(0, 120);
    entry.summary.titleSource = source;
    await writeMeta(entry);
  });
}

/** Persist current provider selection independently of recording/history replay. */
export async function observeSessionModel(
  id: string, conversationId: string, model: string, observedAt: number,
  reasoningEffort?: ReasoningEffort
): Promise<void> {
  if (!/^[a-zA-Z0-9 ._-]{1,80}$/.test(model) || !Number.isFinite(observedAt)) return;
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'model-selection', async () => {
    // Late old-document reports cannot change the replacement's policy. Repeated observations
    // and delayed delivery receipts cannot overwrite a newer provider selection either.
    if (entry.summary.conversationId !== conversationId ||
        observedAt < (entry.summary.selectedModel?.observedAt ?? 0)) return;
    const selectedModel = { conversationId, model, observedAt, ...(reasoningEffort ? { reasoningEffort } : {}) };
    if (JSON.stringify(entry.summary.selectedModel) === JSON.stringify(selectedModel)) return;
    const staged = { ...entry.summary, selectedModel };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/** Bind once before publishing project work; a task never silently changes folders. */
export async function bindSessionProject(id: string, projectId: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error('Invalid project id');
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'project', async () => {
    if (entry.summary.projectId === projectId) return;
    if (entry.summary.projectId) throw new Error('Session already belongs to another project');
    const staged = { ...entry.summary, projectId };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/**
 * Records that this app opened the chat, and names the session accordingly.
 *
 * One write rather than a rename followed by a stamp, because the two are the same
 * fact: the origin is where the name came from, and a session that carried one without
 * the other would either show the bootstrap prompt as its name or claim a role the
 * name contradicts.
 */
export async function setSessionOrigin(id: string, origin: SessionOrigin, title: string): Promise<void> {
  const inheritedProject = origin.fromSessionId ? (await getSession(origin.fromSessionId))?.projectId : undefined;
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'origin write', async () => {
    if (inheritedProject && entry.summary.projectId && entry.summary.projectId !== inheritedProject) throw new Error('Session origin belongs to another project');
    const staged = { ...entry.summary, origin, title: title.slice(0, 120), ...(inheritedProject ? { projectId: inheritedProject } : {}) };
    await writeSummary(staged, entry.historySeq);
    entry.summary = staged;
    publishAttachmentSummary(staged);
  });
}

/**
 * Attaches this durable session to a different ChatGPT conversation.
 *
 * The single canonical session-transfer primitive: Compact & Resume does not create a
 * second session and copy state into it, it moves the one session's frontend from chat A
 * to chat B. Everything the session owns — its recorded history, its title, its origin, its
 * handoffs, and by extension the workspace and swarm binding keyed off it — follows for
 * free, precisely because none of it was ever keyed on the ChatGPT conversation.
 *
 * `contextTokens` is the one figure that resets, and it is not an exception to that rule:
 * it measures what the *attached chat* is carrying, and chat B is carrying only the
 * handoff. `estimatedTokens` keeps counting the session's whole life.
 *
 * Refuses rather than guesses when the session is not attached where the caller thinks it
 * is. That check is what makes the commit safe to retry and impossible to apply twice.
 *
 * ## Commit on success, never before
 *
 * The move is staged on a *clone* and only published into the live summary once the durable
 * write has actually landed. Mutating the live summary first and writing afterwards looked
 * equivalent and was not: a failed `writeMeta` returned false while memory already said
 * chat B, and the next scheduled flush then wrote that state to disk anyway — so a commit
 * that reported failure completed itself a second later. The requirement is absolute in the
 * other direction: a failed A→B commit leaves the session attached to A, in memory and on
 * disk alike. Publishing is a field-by-field copy into the existing object, because callers
 * hold that reference.
 */
export async function rebindSession(
  id: string,
  fromConversationId: string | null,
  toConversationId: string,
  committedResumeHandoffId?: string
): Promise<boolean> {
  if (!toConversationId || fromConversationId === toConversationId) return false;
  if (committedResumeHandoffId !== undefined && !/^[0-9a-z-]{8,64}$/i.test(committedResumeHandoffId)) return false;
  // Capture acquisition may read the old live A after B is physically committed.
  // Refuse it from the request edge until this operation finishes publication,
  // including time spent reconstructing the entry or waiting in its queue.
  pendingAttachmentTransitions.set(id, (pendingAttachmentTransitions.get(id) ?? 0) + 1);
  try {
    // Same rule as createSession: once a mutation may attach B, no pre-existing cached miss for
    // B is authoritative. Clearing it early is safe even if the move later refuses or fails.
    missingCurrentConversations.delete(toConversationId);
    const entry = await ensureOpen(id);
    return await enqueueSessionOperation(entry, 'rebind', async () => {
      if (entry.summary.conversationId !== fromConversationId) return false;
      if (!Number.isSafeInteger(entry.summary.bindingRevision ?? 0) ||
          (entry.summary.bindingRevision ?? 0) >= Number.MAX_SAFE_INTEGER) return false;
      // Browser conversation ids are UUID-like. A handful of store unit tests deliberately
      // use short symbolic ids and reuse them across retained temp sessions; ownership safety
      // applies to the real identity domain rather than manufacturing a test-only collision.
      if (/^[0-9a-f-]{8,64}$/i.test(toConversationId)) {
        // Any existing owner is a collision witness. A unique-only lookup also returns
        // null for duplicate owners and would incorrectly admit a third local session.
        const target = await findSessionByConversation(toConversationId);
        if (target && target.id !== id) {
          logWarn(`session ${id} cannot move to ${toConversationId}: that chat already belongs to ${target.id}`);
          return false;
        }
      }
      const staged: SessionSummary = {
        ...entry.summary,
        conversationId: toConversationId,
        retiredChatAt: fromConversationId ? { ...entry.summary.retiredChatAt, [fromConversationId]: Date.now() } : entry.summary.retiredChatAt,
        bindingRevision: (entry.summary.bindingRevision ?? 0) + 1,
        chatIds: entry.summary.chatIds.includes(toConversationId)
          ? [...entry.summary.chatIds]
          : [...entry.summary.chatIds, toConversationId],
        contextTokens: 0,
        activeTurnId: null,
        finishTurn: null,
        browserRecoveryDismissedAt: undefined,
        ...(committedResumeHandoffId !== undefined
          ? { lastCommittedResumeHandoffId: committedResumeHandoffId }
          : {}),
        updatedAt: Date.now(),
        // A session whose chat was closed during the handover is live again the moment its new
        // chat is attached; leaving `endedAt` set would draw a visibly growing session as over.
        endedAt: null
      };

      try {
        await writeSummary(staged, entry.historySeq);
      } catch (err) {
        logWarn(`session ${id} could not be moved to ${toConversationId}: ${(err as Error).message}`);
        return false;
      }


      // Past this point nothing can fail: the durable record already says chat B.
      Object.assign(entry.summary, staged);
      entry.metaDirty = false;
      missingCurrentConversations.delete(toConversationId);
      publishAttachmentSummary(entry.summary);
      logInfo(`session ${id} moved from ChatGPT conversation ${fromConversationId} to ${toConversationId}`);
      return true;
    });
  } finally {
    // Count overlapping attempts: an earlier completed rebind cannot clear a later
    // queued rebind's fence. Invalid requests never enter this latch.
    const remaining = (pendingAttachmentTransitions.get(id) ?? 1) - 1;
    if (remaining > 0) pendingAttachmentTransitions.set(id, remaining);
    else pendingAttachmentTransitions.delete(id);
  }
}

/**
 * Repairs successful-resume provenance after recovery proves the A→B session move already landed.
 *
 * Normal continuation commit writes this id atomically inside {@link rebindSession}. A crash can
 * leave the continuation WAL in `committing` after that metadata write, and older builds could
 * move the session before this field existed. In either case, the durable continuation's handoff
 * id plus the session already being attached to B authorises this one-field repair. Any other
 * current attachment is refused rather than inferred.
 */
export async function ensureCommittedResumeHandoff(
  id: string,
  conversationId: string,
  handoffId: string
): Promise<boolean> {
  if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(handoffId)) return false;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'committed resume provenance repair', async () => {
    if (entry.summary.conversationId !== conversationId) return false;
    if (entry.summary.lastCommittedResumeHandoffId === handoffId) return true;
    const staged: SessionSummary = {
      ...entry.summary,
      // This is recovery of an already-landed semantic move, not new user/session activity.
      // Preserve the original recency rather than making an app restart reorder old sessions.
      lastCommittedResumeHandoffId: handoffId
    };
    await writeSummary(staged, entry.historySeq);
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    publishCachedSummary(entry.summary, false);
    return true;
  });
}

// ----------------------------------------------------------------- assets

/** A content-derived filename alone proves nothing about its existing bytes. Read the exact
 * regular inode under a bounded handle, then reject replacement or mutation during the read.
 * Missing is a valid result only before opening; a vanished known target is an error. */
async function matchingAssetFile(file: string, expected: Buffer, digest: string): Promise<boolean> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try { before = await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.length)
    throw new Error('Existing session asset has invalid contents');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== expected.length) throw new Error('Existing session asset changed during validation');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(Math.min(64 * 1024, expected.length));
    let position = 0;
    while (position < expected.length) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expected.length - position), position);
      if (!bytesRead || !chunk.subarray(0, bytesRead).equals(expected.subarray(position, position + bytesRead)))
        throw new Error('Existing session asset has invalid contents');
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest('hex') !== digest) throw new Error('Existing session asset has invalid contents');
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev ||
        after.ino !== opened.ino || after.size !== opened.size)
      throw new Error('Existing session asset changed during validation');
    return true;
  } finally { await handle.close(); }
}

/**
 * Stores a binary beside the log and returns a reference.
 *
 * Content-addressed, so a screenshot taken twice costs one file. This is the whole
 * reason the log stays readable: a 300 KB PNG never becomes a 400 KB base64 string
 * inside a line that a summary pass then has to skip over.
 */
export async function writeAsset(
  sessionId: string,
  data: Buffer,
  mimeType: string
): Promise<AssetRef> {
  const revision = getRecordingRevision();
  requireRecording(revision);
  assertSessionId(sessionId);
  if (data.length === 0 || data.length > MAX_ASSET_BYTES) throw new Error('Session asset exceeds the per-asset limit');
  const digest = createHash('sha256').update(data).digest('hex');
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'text/plain'
          ? '.txt'
          : '.bin';
  const id = `${digest.slice(0, 32)}${extension}`;
  // Invocation time, rather than queue execution time, decides which side of an explicit
  // cleanup this write belongs to. A write already admitted when cleanup starts may finish,
  // but its late reference cannot resurrect the retired file.
  const admittedAt = assetMutationEpoch;
  return enqueueAssetOperation(async () => {
    requireRecording(revision);
    const dir = path.join(sessionDir(sessionId), 'assets');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    if (await matchingAssetFile(target, data, digest)) {
      assetWrittenEpoch.set(localAssetKey(sessionId, id), admittedAt);
      return { id, mimeType, bytes: data.length };
    }
    const used = await sessionAssetBytesOnDisk(sessionId);
    const globalUsed = await globalAssetBytesOnDisk();
    if (used + data.length > MAX_SESSION_ASSET_BYTES) throw new Error('Session asset quota exceeded');
    if (globalUsed + data.length > MAX_GLOBAL_ASSET_BYTES) throw new Error('Global session asset quota exceeded');
    // Write outside the hash namespace. A partial EIO leaves only this private staging file;
    // link publishes without replacing a shared hash target, unlike rename on POSIX.
    const staging = path.join(dir, `.${id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(staging, data, { flag: 'wx' });
      if (!await matchingAssetFile(staging, data, digest))
        throw new Error('Staged session asset is unavailable');
      try {
        await fs.link(staging, target);
        sessionAssetUsage.set(sessionId, used + data.length);
        globalAssetUsage = globalUsed + data.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await matchingAssetFile(target, data, digest))
          throw new Error('Existing session asset vanished during publication');
      }
      assetWrittenEpoch.set(localAssetKey(sessionId, id), admittedAt);
      return { id, mimeType, bytes: data.length };
    } finally {
      await fs.rm(staging, { force: true });
    }
  });
}

async function directoryFileBytes(dir: string): Promise<number> {
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isFile()) continue;
      try {
        total += (await fs.stat(path.join(dir, entry.name))).size;
      } catch {
        // A concurrent delete simply removes it from the durable total.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return total;
}

async function sessionAssetBytesOnDisk(sessionId: string): Promise<number> {
  const cached = sessionAssetUsage.get(sessionId);
  if (cached !== undefined) return cached;
  const used = await directoryFileBytes(path.join(sessionDir(sessionId), 'assets'));
  sessionAssetUsage.set(sessionId, used);
  return used;
}

async function globalAssetBytesOnDisk(): Promise<number> {
  if (globalAssetUsage !== null) return globalAssetUsage;
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(root);
    for await (const entry of handle) {
      if (!entry.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(entry.name)) continue;
      total += await sessionAssetBytesOnDisk(entry.name);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  globalAssetUsage = total;
  return total;
}

interface StoredImageFile {
  sessionId: string;
  assetId: string;
  bytes: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface VerifiedAssetsDirectory {
  path: string;
  realPath: string;
}

function imageHeader(header: Buffer): boolean {
  return (
    (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) ||
    (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP')
  );
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function verifiedAssetsDirectory(sessionId: string): Promise<VerifiedAssetsDirectory | null> {
  const expectedSession = sessionDir(sessionId);
  const expectedAssets = path.join(expectedSession, 'assets');
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const rootReal = await fs.realpath(root);
    const sessionStat = await fs.lstat(expectedSession);
    if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) return null;
    const sessionReal = await fs.realpath(expectedSession);
    if (!sameFilesystemPath(path.dirname(sessionReal), rootReal) || path.basename(sessionReal) !== sessionId) return null;
    const assetsStat = await fs.lstat(expectedAssets);
    if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) return null;
    const assetsReal = await fs.realpath(expectedAssets);
    if (!sameFilesystemPath(path.dirname(assetsReal), sessionReal) || path.basename(assetsReal) !== 'assets') return null;
    return { path: expectedAssets, realPath: assetsReal };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface VerifiedAssetFile {
  bytes: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  image: boolean;
}

async function inspectVerifiedAssetFile(directory: VerifiedAssetsDirectory, name: string): Promise<VerifiedAssetFile | null> {
  const target = path.join(directory.path, name);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const real = await fs.realpath(target);
    if (!sameFilesystemPath(path.dirname(real), directory.realPath) || path.basename(real) !== name) return null;
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return null;
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const image = imageHeader(header.subarray(0, bytesRead));
    const after = await fs.lstat(target);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) return null;
    return { bytes: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino, image };
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Exact physical quota inventory. Directory entries, not caller paths, define the scope. */
async function imageStorageInventory(collectImages = true): Promise<{ usedBytes: number; images: StoredImageFile[] }> {
  assertReady();
  let usedBytes = 0;
  const images: StoredImageFile[] = [];
  const usage = new Map<string, number>();
  let sessions: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      sessionAssetUsage.clear();
      globalAssetUsage = 0;
      return { usedBytes: 0, images: [] };
    }
    sessions = await fs.opendir(root);
    for await (const session of sessions) {
      if (!session.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(session.name)) continue;
      const assetsDir = await verifiedAssetsDirectory(session.name);
      if (!assetsDir) continue;
      let entries: Awaited<ReturnType<typeof fs.opendir>> | null = null;
      let sessionBytes = 0;
      try {
        entries = await fs.opendir(assetsDir.path);
        for await (const entry of entries) {
          // Symlinks and other special files neither consume the app's quota nor become cleanup targets.
          if (!entry.isFile() || !/^[0-9a-f]{8,64}\.(?:bin|png|jpg|txt)$/i.test(entry.name)) continue;
          // Usage needs metadata only. Opening every file to classify its contents belongs
          // to confirmed cleanup, not to displaying the quota (including a cold start).
          if (!collectImages) {
            try {
              const stat = await fs.lstat(path.join(assetsDir.path, entry.name));
              if (stat.isFile() && !stat.isSymbolicLink()) sessionBytes += stat.size;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            continue;
          }
          const file = await inspectVerifiedAssetFile(assetsDir, entry.name);
          if (!file) continue;
          sessionBytes += file.bytes;
          if (file.image) {
            const { image: _image, ...stored } = file;
            images.push({ sessionId: session.name, assetId: entry.name, ...stored });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally {
        await entries?.close().catch(() => undefined);
      }
      usage.set(session.name, sessionBytes);
      usedBytes += sessionBytes;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await sessions?.close().catch(() => undefined);
  }
  sessionAssetUsage.clear();
  for (const [sessionId, bytes] of usage) sessionAssetUsage.set(sessionId, bytes);
  globalAssetUsage = usedBytes;
  return { usedBytes, images };
}

function sameStoredImage(file: StoredImageFile, observed: VerifiedAssetFile): boolean {
  return observed.image && observed.dev === file.dev && observed.ino === file.ino && observed.bytes === file.bytes;
}

/**
 * Atomically moves the selected directory entry aside, then verifies the moved object before
 * unlinking it. A path replacement can therefore make cleanup abstain, but cannot make it
 * delete the replacement. The app's asset queue excludes legitimate writers throughout.
 */
async function deleteSelectedImage(file: StoredImageFile): Promise<number> {
  const directory = await verifiedAssetsDirectory(file.sessionId);
  if (!directory) return 0;
  const observed = await inspectVerifiedAssetFile(directory, file.assetId);
  if (!observed || !sameStoredImage(file, observed)) return 0;
  const currentDirectory = await verifiedAssetsDirectory(file.sessionId);
  if (!currentDirectory || !sameFilesystemPath(currentDirectory.realPath, directory.realPath)) return 0;
  const target = path.join(currentDirectory.path, file.assetId);
  const quarantineName = `.cleanup-${process.pid}-${randomUUID()}.tmp`;
  const quarantine = path.join(currentDirectory.path, quarantineName);
  try {
    await fs.rename(target, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  try {
    const movedDirectory = await verifiedAssetsDirectory(file.sessionId);
    if (!movedDirectory || !sameFilesystemPath(movedDirectory.realPath, currentDirectory.realPath)) return 0;
    const moved = await inspectVerifiedAssetFile(movedDirectory, quarantineName);
    if (!moved || !sameStoredImage(file, moved)) return 0;
    await fs.unlink(quarantine);
    return moved.bytes;
  } finally {
    // A replacement is never deleted. Restore the selected directory entry when possible;
    // otherwise leave the quarantined file as forensic evidence outside future inventories.
    try {
      await fs.lstat(quarantine);
      try { await fs.lstat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') await fs.rename(quarantine, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function referencedAssetIds(event: SessionEvent): readonly AssetRef[] {
  if (event.kind === 'native_image') return event.asset ? [event.asset] : [];
  if (event.kind === 'user_message') return event.assets ?? [];
  if (event.kind === 'tool_call') return event.call.assets ?? [];
  if (event.kind === 'assistant_message') return event.richMedia?.flatMap(media => media.asset ? [media.asset] : []) ?? [];
  return [];
}

/** Read-only compatibility with future rich assets, NOT permission to admit them. Every
 * existing slot must be well formed before its references can authorize physical deletion. */
function cleanupRichMedia(event: Extract<SessionEvent, { kind: 'assistant_message' }>): RichMediaState[] | null {
  const removed = parsedRetiredRichMediaSlots(event.retiredRichMediaSlots);
  if (removed === null) return null;
  // A cleanup-created marker may only name bytes also retired on this same
  // canonical assistant. A forged four-field marker must not gain authority by
  // borrowing a plausible UUID and hash without its assistant-wide retirement.
  if (removed.some(slot => slot.retiredAssetId !== undefined &&
      (!Array.isArray(event.retiredRichImageAssetIds) ||
       !event.retiredRichImageAssetIds.includes(slot.retiredAssetId)))) return null;
  if (event.richMedia === undefined) return [];
  const rich = event.rich ? parseRichResponse(event.rich) : null;
  const origin = event.richOrigin ? parseRichOrigin(event.richOrigin) : null;
  if (!rich || rich.status !== 'available' || !event.providerMessageId ||
      rich.providerMessageId !== event.providerMessageId || rich.messageId !== event.messageId ||
      !origin || origin.conversationId !== rich.conversationId) return null;
  const sourceFloor = richSourceVersionFloor(event);
  if (sourceFloor === null) return null;
  try {
    if (!Array.isArray(event.richMedia) || event.richMedia.length > 64 ||
        Reflect.ownKeys(event.richMedia).length !== event.richMedia.length + 1) return null;
    const found = new Set<string>();
    const clean: RichMediaState[] = [];
    for (let index = 0; index < event.richMedia.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(event.richMedia, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      const media = parseDurableRichMedia(descriptor.value);
      if (!media || found.has(media.mediaId) || !exactRichImageNode(rich, media.mediaId, media.nodeId) ||
          (media.pageSource && media.pageSource.slotVersion > event.seq) ||
          (media.pageSource && media.pageSource.slotVersion > sourceFloor) ||
          (media.source.kind === 'native' && media.source.providerMessageId !== event.providerMessageId)) return null;
      const removedNode = removed.find(slot => slot.mediaId === media.mediaId);
      if (removedNode !== undefined && (removedNode.nodeId !== media.nodeId ||
          media.status !== 'unavailable' || media.reason !== 'removed')) return null;
      clean.push(media);
      found.add(media.mediaId);
    }
    return clean;
  } catch { return null; }
}

/** Unlike readEvents, deletion must not interpret a missing owner source, skipped
 * unreadable/oversized canonical shard or malformed legacy snapshot as proof of zero owners.
 * Reads happen INSIDE the session queue, after preceding writers, without reacquiring the
 * outer asset queue. Older sessions missing a source conservatively cannot be cleaned. */
const MAX_CLEANUP_OWNER_SCAN_BYTES = 64 * 1024 * 1024;
const cleanupEventKinds = new Set<SessionEvent['kind']>([
  'session_start', 'user_message', 'assistant_message', 'native_image', 'progress', 'page_tool',
  'turn_start', 'turn_end', 'chat_error', 'tool_call', 'note', 'agent_message', 'handoff'
]);
/** Scan a journal incrementally, checking the same inode and path before and after. */
async function scanImageOwnerJournal(file: string, visit: (event: SessionEvent) => boolean): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CLEANUP_OWNER_SCAN_BYTES) return false;
    const parent = path.dirname(file);
    const parentBefore = await fs.lstat(parent);
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return false;
    const [parentReal, fileReal] = await Promise.all([fs.realpath(parent), fs.realpath(file)]);
    if (!sameFilesystemPath(path.dirname(fileReal), parentReal) || path.basename(fileReal) !== path.basename(file)) return false;
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) return false;
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0), position = 0, lines = 0;
    const accept = (line: Buffer): boolean => {
      if (line.length > MAX_LINE_BYTES || !isUtf8(line)) return false;
      const text = line.toString('utf8');
      if (!text.trim()) return true;
      if (++lines > 100_000) return false;
      try {
        const event: SessionEvent = JSON.parse(text);
        return !!event && Number.isSafeInteger(event.seq) && cleanupEventKinds.has(event.kind) && visit(event);
      } catch { return false; }
    };
    while (position < stat.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (!bytesRead) return false;
      position += bytesRead;
      const joined = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = joined.indexOf(0x0a, start);
        if (newline < 0) break;
        if (!accept(joined.subarray(start, newline))) return false;
        start = newline + 1;
      }
      // The next read reuses `chunk`; retain the trailing bytes independently.
      carry = Buffer.from(joined.subarray(start));
      if (carry.length > MAX_LINE_BYTES) return false;
    }
    if (!accept(carry)) return false;
    const after = await fs.lstat(file), parentAfter = await fs.lstat(parent);
    return after.isFile() && !after.isSymbolicLink() && after.dev === stat.dev && after.ino === stat.ino &&
      after.size === stat.size && parentAfter.isDirectory() && !parentAfter.isSymbolicLink() &&
      parentAfter.dev === parentBefore.dev && parentAfter.ino === parentBefore.ino;
  } catch { return false; }
  finally { await handle?.close().catch(() => undefined); }
}
/** Image membership reads cannot trust a stat-then-readFile path that becomes a symlink or
 * grows after stat. This does not change the existing cleanup transaction's read contract. */
async function readBoundedOwnerSource(
  file: string, before: Awaited<ReturnType<typeof fs.lstat>>
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const parent = path.dirname(file);
    const parentBefore = await fs.lstat(parent);
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return null;
    const [parentReal, fileReal] = await Promise.all([fs.realpath(parent), fs.realpath(file)]);
    if (!sameFilesystemPath(path.dirname(fileReal), parentReal) ||
        path.basename(fileReal) !== path.basename(file)) return null;
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) return null;
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev ||
        after.ino !== stat.ino || after.size !== stat.size) return null;
    const parentAfter = await fs.lstat(parent);
    if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() ||
        parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) return null;
    const raw = bytes.subarray(0, size);
    if (!isUtf8(raw)) return null;
    return raw.toString('utf8');
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}
interface ImageOwnerInventory {
  events: SessionEvent[];
  ambiguousProviders: ReadonlySet<string>;
}

/** Strictly validate image ownership without retaining unrelated journal rows or canonical
 * message bodies. Source bounds are per file, with a cap on canonical directory entries. */
async function imageOwnerInventory(sessionId: string, entry: OpenSession, assetId: string): Promise<ImageOwnerInventory | null> {
  const base = sessionDir(sessionId);
  const canonicalKeys = new Set<string>();
  const targetOwners = new Map<string, CanonicalEvent>();
  const diskOwnersWithAssets = new Set<string>();
  const providerByKey = new Map<string, string>();
  // Bound only references to this exact asset. Unrelated prose never spends this budget.
  const MAX_TARGET_OWNER_BYTES = 8 * 1024 * 1024;
  let targetBytes = 0;
  const journalOwners: SessionEvent[] = [];
  const targetSizes = new Map<string, number>();
  const target = (key: string | null, event: SessionEvent): boolean => {
    if (!referencedAssetIds(event).some(asset => asset.id === assetId)) {
      if (key) { targetBytes -= targetSizes.get(key) ?? 0; targetSizes.delete(key); targetOwners.delete(key); }
      return true;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    const nextBytes = targetBytes - (key ? targetSizes.get(key) ?? 0 : 0) + bytes;
    if (nextBytes > MAX_TARGET_OWNER_BYTES ||
        targetSizes.size + journalOwners.length + (key && targetSizes.has(key) ? 0 : 1) > 512) return false;
    targetBytes = nextBytes;
    if (key) { targetSizes.set(key, bytes); targetOwners.set(key, event as CanonicalEvent); }
    else journalOwners.push(event);
    return true;
  };
  const validReferences = (event: SessionEvent): boolean =>
    (event.kind !== 'assistant_message' || cleanupRichMedia(event) !== null) &&
    referencedAssetIds(event).every(asset => !!asset && typeof asset.id === 'string' &&
      /^[a-f0-9]{8,64}\.(?:bin|png|jpg|txt)$/.test(asset.id));
  const add = (key: string, row: CanonicalEvent): boolean => {
    if (!validReferences(row)) return false;
    canonicalKeys.add(key);
    if (referencedAssetIds(row).length) diskOwnersWithAssets.add(key);
    else diskOwnersWithAssets.delete(key);
    if (row.kind === 'assistant_message' && row.providerMessageId) providerByKey.set(key, row.providerMessageId);
    else providerByKey.delete(key);
    return target(key, row);
  };
  try {
    const legacy = path.join(base, 'messages.json');
    const legacyStat = await fs.lstat(legacy);
    if (!legacyStat.isFile() || legacyStat.isSymbolicLink() ||
        legacyStat.size > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
    const legacyRaw = await readBoundedOwnerSource(legacy, legacyStat);
    if (legacyRaw === null) return null;
    const parsed: unknown = JSON.parse(legacyRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const [key, value] of Object.entries(parsed)) {
      const candidate = value as CanonicalEvent;
      if (!candidate || typeof candidate !== 'object' || !Number.isSafeInteger(candidate.seq) ||
          messageKey(candidate) !== key || !add(key, candidate)) return null;
    }
    const directory = path.join(base, 'messages');
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const listing = await fs.opendir(directory);
    try {
      let entries = 0;
      for await (const item of listing) {
        if (++entries > 8192) return null;
        const name = item.name;
        if (!name.endsWith('.json')) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) return null;
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANONICAL_MESSAGE_BYTES) return null;
        const raw = await readBoundedOwnerSource(file, stat);
        if (raw === null) return null;
        const candidate: CanonicalEvent = JSON.parse(raw);
        const key = messageKey(candidate);
        if (!key || !Number.isSafeInteger(candidate.seq) ||
            `${createHash('sha256').update(key).digest('hex')}.json` !== name || !add(key, candidate)) return null;
      }
    } finally { await listing.close().catch(() => undefined); }
    // Apply shard precedence before checking legacy owners: cleanup may have retired
    // an image in a newer shard while its historical legacy snapshot retains the asset.
    for (const key of diskOwnersWithAssets) if (!entry.messages.has(key)) return null;
    // A cold restore can ignore damaged shards and collapse provider aliases. A cached
    // owner of the requested bytes must equal the exact committed revision on disk.
    for (const [key, current] of entry.messages) {
      if (referencedAssetIds(current).some(asset => asset.id === assetId)) {
        const committed = targetOwners.get(key);
        if (!committed || JSON.stringify(committed) !== JSON.stringify(current)) return null;
      }
      if (!validReferences(current)) return null;
      canonicalKeys.add(key);
      if (current.kind === 'assistant_message' && current.providerMessageId) providerByKey.set(key, current.providerMessageId);
      else providerByKey.delete(key);
      if (!target(key, current)) return null;
    }
    const firstProvider = new Map<string, string>();
    const ambiguousProviders = new Set<string>();
    const recordProvider = (id: string, identity: string): void => {
      const first = firstProvider.get(id);
      if (first !== undefined && first !== identity) ambiguousProviders.add(id);
      else firstProvider.set(id, identity);
    };
    for (const [key, id] of providerByKey) recordProvider(id, key);
    const validJournal = await scanImageOwnerJournal(path.join(base, 'events.jsonl'), row => {
      const key = messageKey(row);
      if (key && canonicalKeys.has(key)) return true;
      if (!validReferences(row)) return false;
      if (row.kind === 'assistant_message' && row.providerMessageId)
        recordProvider(row.providerMessageId, `journal:${row.seq}`);
      return target(null, row);
    });
    if (!validJournal) return null;
    return { events: [...targetOwners.values(), ...journalOwners], ambiguousProviders };
  } catch { return null; }
}

async function cleanupOwnerInventory(
  sessionId: string, entry: OpenSession
): Promise<SessionEvent[] | null> {
  const disk = new Map<string, CanonicalEvent>();
  const base = sessionDir(sessionId);
  try {
    const legacy = path.join(base, 'messages.json');
    try {
      const stat = await fs.lstat(legacy);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
      const raw = await fs.readFile(legacy, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      for (const [key, value] of Object.entries(parsed)) {
        const candidate = value as CanonicalEvent;
        if (!candidate || typeof candidate !== 'object' || !Number.isSafeInteger(candidate.seq) ||
            messageKey(candidate) !== key) return null;
        disk.set(key, candidate);
      }
    } catch { return null; }
    try {
      const directory = path.join(base, 'messages');
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const names = await fs.readdir(directory);
      for (const name of names) {
        if (!name.endsWith('.json')) continue; // Temporary incomplete writes are not published.
        if (!/^[a-f0-9]{64}\.json$/.test(name)) return null;
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CANONICAL_MESSAGE_BYTES) return null;
        const raw = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) return null;
        const candidate: CanonicalEvent = JSON.parse(raw);
        const key = messageKey(candidate);
        if (!key || !Number.isSafeInteger(candidate.seq) ||
            `${createHash('sha256').update(key).digest('hex')}.json` !== name) return null;
        disk.set(key, candidate);
      }
    } catch { return null; }
    // The journal can contain unkeyed references and pre-canonical snapshots. Its latter
    // copies are superseded by a valid authoritative canonical shard of the SAME identity.
    const events: SessionEvent[] = [];
    try {
      const journalFile = path.join(base, 'events.jsonl');
      const stat = await fs.lstat(journalFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
      const journal = await fs.readFile(journalFile, 'utf8');
      if (Buffer.byteLength(journal, 'utf8') > MAX_CLEANUP_OWNER_SCAN_BYTES) return null;
      for (const line of journal.split('\n')) {
        if (!line.trim()) continue;
        const event: SessionEvent = JSON.parse(line);
        if (!event || !Number.isSafeInteger(event.seq) || !cleanupEventKinds.has(event.kind)) return null;
        const key = messageKey(event);
        if (!key || !disk.has(key)) events.push(event);
      }
    } catch { return null; }
    // Read-only per-session recovery may collapse old provider aliases. An unrepresented
    // on-disk owner must veto deletion rather than exposing bytes that cleanup cannot retire.
    for (const [key, candidate] of disk) {
      if (!entry.messages.has(key) && referencedAssetIds(candidate).length) return null;
    }
    for (const [key, current] of entry.messages) disk.set(key, current);
    const all = [...disk.values(), ...events];
    for (const event of all) {
      if (event.kind === 'assistant_message' && cleanupRichMedia(event) === null) return null;
      for (const asset of referencedAssetIds(event)) {
        if (!asset || typeof asset.id !== 'string' || !/^[a-f0-9]{8,64}\.(?:bin|png|jpg|txt)$/.test(asset.id)) return null;
      }
    }
    return all;
  } catch { return null; }
}

function retireImageReferences(event: CanonicalEvent, selected: ReadonlySet<string>): CanonicalEvent | null {
  if (event.kind === 'native_image') {
    if (!event.asset || !selected.has(event.asset.id)) return null;
    const { asset: _asset, ...withoutAsset } = event;
    return { ...withoutAsset, previewStatus: 'unavailable', previewError: 'removed' };
  }
  if (event.kind === 'user_message') {
    const removed = (event.assets ?? []).filter((asset) => selected.has(asset.id));
    if (!removed.length) return null;
    const retiredImageAssetIds = [...new Set([...(event.retiredImageAssetIds ?? []), ...removed.map((asset) => asset.id)])];
    return { ...event, assets: retainedAssets(event.assets, retiredImageAssetIds), retiredImageAssetIds };
  }
  if (event.kind === 'assistant_message') {
    const removed = (event.richMedia ?? []).filter(media => media.asset && selected.has(media.asset.id));
    if (!removed.length) return null;
    const priorRemoved = parsedRetiredRichMediaSlots(event.retiredRichMediaSlots);
    if (!priorRemoved) return null;
    const knownIncarnations = new Set(priorRemoved.flatMap(slot =>
      slot.removalIncarnation ? [slot.removalIncarnation.toLowerCase()] : []));
    const newlyRemoved: RetiredRichMediaSlot[] = [];
    for (const media of removed) {
      // A currently available asset cannot coexist with a removed-slot marker.
      // Do not upgrade legacy two-field markers, or rotate a previous cleanup's
      // incarnation after a partial multi-owner retirement failure.
      if (priorRemoved.some(slot => slot.mediaId === media.mediaId)) return null;
      const removalIncarnation = randomUUID();
      if (!removalIncarnationUUID.test(removalIncarnation) ||
          knownIncarnations.has(removalIncarnation.toLowerCase()) ||
          !retiredRichImageAssetId.test(media.asset!.id)) return null;
      knownIncarnations.add(removalIncarnation.toLowerCase());
      newlyRemoved.push({ mediaId: media.mediaId, nodeId: media.nodeId,
        removalIncarnation, retiredAssetId: media.asset!.id });
    }
    const nextRemoved = mergedRetiredRichMediaSlots(priorRemoved, newlyRemoved);
    if (nextRemoved === null) return null;
    const retiredRichImageAssetIds = mergedRetiredAssetIds(event.retiredRichImageAssetIds,
      removed.map(media => media.asset!.id));
    return { ...event, retiredRichImageAssetIds, retiredRichMediaSlots: nextRemoved,
      richMedia: (event.richMedia ?? []).map(media => {
      if (!media.asset || !selected.has(media.asset.id)) return media;
      const { asset: _asset, previewWidth: _width, previewHeight: _height, ...withoutPreview } = media;
      return { ...withoutPreview, status: 'unavailable' as const, reason: 'removed' as const };
    }) };
  }
  if (event.kind !== 'tool_call') return null;
  const removed = (event.call.assets ?? []).filter((asset) => selected.has(asset.id));
  if (!removed.length) return null;
  const retiredImageAssetIds = [...new Set([...(event.call.retiredImageAssetIds ?? []), ...removed.map((asset) => asset.id)])];
  return { ...event, call: { ...event.call, assets: retainedAssets(event.call.assets, retiredImageAssetIds), retiredImageAssetIds } };
}

/**
 * Retires every durable reference before physical deletion. Canonical shards overlay ordinary
 * journal tool rows, so history remains immutable while future reads cannot claim a removed file
 * is available. Unsupported unkeyed references veto deletion for their exact asset.
 */
async function retireSessionImages(sessionId: string, selected: ReadonlySet<string>): Promise<Set<string>> {
  if (uncertainCleanupSessions.has(sessionId)) throw new Error('Canonical cleanup ownership is uncertain');
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'image storage cleanup', async () => {
    if (uncertainCleanupSessions.has(sessionId)) throw new Error('Canonical cleanup ownership is uncertain');
    const events = await cleanupOwnerInventory(sessionId, entry);
    if (!events) return new Set<string>(); // Unknown owner is never evidence for deletion.
    const safe = new Set(selected);
    const keyed = new Map<string, CanonicalEvent>();
    for (const event of events) {
      const matching = referencedAssetIds(event).filter(asset => selected.has(asset.id));
      if (!matching.length) continue;
      const key = messageKey(event);
      if (!key || !['user_message', 'native_image', 'tool_call', 'assistant_message'].includes(event.kind)) {
        for (const asset of matching) safe.delete(asset.id);
        continue;
      }
      keyed.set(key, event as CanonicalEvent);
    }
    for (const [key, observed] of keyed) {
      const current = entry.messages.get(key) ?? observed;
      const retired = retireImageReferences(current, safe);
      if (!retired) {
        // A damaged or saturated removal fence cannot authorize deletion. Keep
        // the referenced bytes rather than unlinking an asset with a live owner.
        for (const asset of referencedAssetIds(current)) safe.delete(asset.id);
        continue;
      }
      const full = { ...retired, origin: retired.origin ?? retired.seq, seq: entry.nextSeq } as CanonicalEvent;
      try {
        await writeCanonicalMessage(sessionId, key, full);
      } catch (error) {
        // A successful physical rename can lose its ACK. While both queues still
        // own this retirement, reconcile exactly the proposed full shard or
        // unchanged predecessor, never guess based on which syscall threw.
        if (await committedImageOwner(sessionId, full)) {
          entry.messages.set(key, full);
          entry.nextSeq += 1;
          entry.historySeq = full.seq;
          scheduleMeta(entry);
        } else if (!await committedImageOwner(sessionId, current)) {
          // Neither exact disk state can be proven. Guard the common canonical
          // writer, not just enqueueSessionOperation: several callers enqueue
          // directly via entry.queue.then. Next startup reloads from disk.
          uncertainCleanupSessions.add(sessionId);
        }
        // Uncertain cleanup NEVER grants physical byte deletion even if its
        // exact committed metadata was reconciled into RAM.
        throw error;
      }
      entry.messages.set(key, full);
      entry.nextSeq += 1;
      entry.historySeq = full.seq;
    }
    if (keyed.size) scheduleMeta(entry);
    return safe;
  });
}

export function getImageStorage(): Promise<ImageStorageInfo> {
  return enqueueAssetOperation(async () => {
    assertReady();
    // Asset writes and cleanup already maintain this quota authority under the same queue.
    const usedBytes = globalAssetUsage ?? (await imageStorageInventory(false)).usedBytes;
    return { usedBytes, limitBytes: MAX_GLOBAL_ASSET_BYTES };
  });
}

/** Explicit user cleanup. No automatic eviction and no alternate cache can bypass the 2 GiB cap. */
export async function clearImageStorage(mode: ImageStorageClearMode): Promise<ImageStorageClearResult> {
  assertReady();
  // This synchronous edge separates already-admitted writers from writes initiated after the
  // explicit cleanup request, including callers that are still waiting on the asset queue.
  const cleanupEpoch = ++assetMutationEpoch;
  let announceSelection!: (files: StoredImageFile[]) => void;
  let rejectSelection!: (error: unknown) => void;
  let finishRetirement!: (files: Set<string>) => void;
  let rejectRetirement!: (error: unknown) => void;
  const selection = new Promise<StoredImageFile[]>((resolve, reject) => {
    announceSelection = resolve; rejectSelection = reject;
  });
  const retirement = new Promise<Set<string>>((resolve, reject) => {
    finishRetirement = resolve; rejectRetirement = reject;
  });

  // Claim the existing asset queue before inspecting disk. Prior writes finish first; later writes
  // wait until references are retired and selected files are gone.
  const cleanup = enqueueAssetOperation(async () => {
    try {
      const inventory = await imageStorageInventory();
      const ordered = [...inventory.images].sort((left, right) =>
        left.mtimeMs - right.mtimeMs || left.sessionId.localeCompare(right.sessionId) || left.assetId.localeCompare(right.assetId));
      const chosen: StoredImageFile[] = [];
      let chosenBytes = 0;
      for (const file of ordered) {
        if (mode === 'oldest-gib' && chosenBytes >= 1024 * 1024 * 1024) break;
        chosen.push(file);
        chosenBytes += file.bytes;
      }
      for (const file of chosen) removedAssetEpoch.set(localAssetKey(file.sessionId, file.assetId), cleanupEpoch);
      announceSelection(chosen);
      const deletable = await retirement;
      let freedBytes = 0;
      let removedFiles = 0;
      for (const file of chosen) {
        const identity = `${file.sessionId}\u0000${file.assetId}`;
        if (!deletable.has(identity)) continue;
        const removed = await deleteSelectedImage(file);
        if (!removed) continue;
        freedBytes += removed;
        removedFiles += 1;
      }
      sessionAssetUsage.clear();
      globalAssetUsage = null;
      const after = await imageStorageInventory(false);
      return { freedBytes, removedFiles, usedBytes: after.usedBytes, limitBytes: MAX_GLOBAL_ASSET_BYTES };
    } catch (error) {
      rejectSelection(error);
      throw error;
    }
  });

  try {
    const chosen = await selection;
    const bySession = new Map<string, Set<string>>();
    for (const file of chosen) {
      const ids = bySession.get(file.sessionId) ?? new Set<string>();
      ids.add(file.assetId);
      bySession.set(file.sessionId, ids);
    }
    const deletable = new Set<string>();
    for (const [sessionId, ids] of bySession) {
      for (const assetId of await retireSessionImages(sessionId, ids)) deletable.add(`${sessionId}\u0000${assetId}`);
    }
    finishRetirement(deletable);
  } catch (error) {
    rejectRetirement(error);
  }
  return cleanup;
}

function invalidateAssetUsage(sessionId: string): void {
  sessionAssetUsage.delete(sessionId);
  globalAssetUsage = null;
}

const MAX_IMAGE_READ_BYTES = 16 * 1024 * 1024;

/** Read only the exact committed canonical owner. The permissive transcript reader may skip
 * damaged shards and collapse provider aliases; neither behavior confers image permission. */
async function committedImageOwner(sessionId: string, owner: CanonicalEvent): Promise<boolean> {
  const key = messageKey(owner);
  if (!key) return false;
  const base = sessionDir(sessionId);
  const directory = path.join(base, 'messages');
  const name = `${createHash('sha256').update(key).digest('hex')}.json`;
  const file = path.join(directory, name);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const [rootStat, sessionStat, directoryStat] = await Promise.all([
      fs.lstat(root), fs.lstat(base), fs.lstat(directory)
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        !sessionStat.isDirectory() || sessionStat.isSymbolicLink() ||
        !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    const [rootReal, sessionReal, directoryReal] = await Promise.all([
      fs.realpath(root), fs.realpath(base), fs.realpath(directory)
    ]);
    if (!sameFilesystemPath(path.dirname(sessionReal), rootReal) ||
        !sameFilesystemPath(path.dirname(directoryReal), sessionReal)) return false;
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CANONICAL_MESSAGE_BYTES) return false;
    const real = await fs.realpath(file);
    if (!sameFilesystemPath(path.dirname(real), directoryReal) || path.basename(real) !== name) return false;
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
        stat.size !== before.size) return false;
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) return false;
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev ||
        after.ino !== stat.ino || after.size !== stat.size) return false;
    const stored: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    return !!stored && typeof stored === 'object' && messageKey(stored as CanonicalEvent) === key &&
      JSON.stringify(stored) === JSON.stringify(owner);
  } catch { return false; }
  finally { await handle?.close().catch(() => undefined); }
}

/** A future available rich slot may only grant a LOCAL read, never publication or action.
 * All slots on the owner must validate; an ambiguous provider alias vetoes the entire owner. */
async function richImageReference(
  sessionId: string, entry: OpenSession, events: SessionEvent[], assetId: string,
  ambiguousProviders: ReadonlySet<string>
): Promise<{ asset: AssetRef; width: number; height: number } | null> {
  const assistants = events.filter((row): row is Extract<SessionEvent, { kind: 'assistant_message' }> =>
    row.kind === 'assistant_message');
  for (const row of assistants) {
    if (!row.richMedia?.some(media => media.asset?.id === assetId)) continue;
    const key = messageKey(row);
    const cached = key ? entry.messages.get(key) : null;
    if (!cached || cached.kind !== 'assistant_message' || !await committedImageOwner(sessionId, row) ||
        JSON.stringify(cached) !== JSON.stringify(row) || row.source !== 'extension' ||
        !row.messageId || !row.providerMessageId) return null;
    const rich = row.rich ? parseRichResponse(row.rich) : null;
    const origin = row.richOrigin ? parseRichOrigin(row.richOrigin) : null;
    const media = cleanupRichMedia(row);
    if (!rich || rich.status !== 'available' || rich.revision < 1 || !origin || !media ||
        origin.conversationId !== rich.conversationId || rich.conversationId !== origin.conversationId ||
        rich.messageId !== row.messageId || rich.providerMessageId !== row.providerMessageId ||
        origin.bindingRevision > (entry.summary.bindingRevision ?? 0) ||
        !entry.summary.chatIds.includes(origin.conversationId) ||
        (ambiguousProviders.has(row.providerMessageId) ||
          assistants.some(other => other !== row && other.providerMessageId === row.providerMessageId))) return null;
    const retired = row.retiredRichImageAssetIds;
    if (retired !== undefined && (!Array.isArray(retired) || retired.length > 4096 ||
        retired.some(id => typeof id !== 'string' || !/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(id)) ||
        new Set(retired).size !== retired.length || retired.includes(assetId))) return null;
    const matches = media.filter(slot => slot.status === 'available' && slot.asset?.id === assetId);
    if (!matches.length) return null;
    const chosen = matches[0]!;
    // The fixed image getter has only a session and an asset ID. If two slots claim the
    // same bytes with contradictory geometry/metadata, it cannot safely choose one.
    if (matches.some(slot => slot.previewWidth !== chosen.previewWidth ||
        slot.previewHeight !== chosen.previewHeight ||
        JSON.stringify(slot.asset) !== JSON.stringify(chosen.asset))) return null;
    for (const slot of matches) {
      if (!slot.asset || slot.reason !== undefined || !slot.previewWidth || !slot.previewHeight ||
          slot.previewWidth * slot.previewHeight > 2_560_000 ||
          slot.asset.bytes > MAX_ASSET_BYTES) return null;
      const source = slot.source;
      if (source.kind === 'native') {
        const native = events.find((candidate): candidate is NativeImageEvent =>
          candidate.kind === 'native_image' && candidate.messageId === source.providerMessageId &&
          candidate.providerAssetId === source.providerAssetId);
        if (!native || native.previewStatus !== 'available' || native.previewError !== undefined ||
            !native.asset || JSON.stringify(native.asset) !== JSON.stringify(slot.asset) ||
            native.previewWidth !== slot.previewWidth || native.previewHeight !== slot.previewHeight ||
            !await committedImageOwner(sessionId, native)) return null;
      }
    }
    return { asset: chosen.asset!, width: chosen.previewWidth!, height: chosen.previewHeight! };
  }
  return null;
}

/** Same-session, bounded inode-bound image bytes; never follow a renderer-selected path. */
async function verifiedRecordedImageBytes(sessionId: string, asset: AssetRef): Promise<Buffer | null> {
  if (!/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(asset.id) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_IMAGE_READ_BYTES) return null;
  const extension = asset.mimeType === 'image/png' ? '.png' : asset.mimeType === 'image/jpeg' ? '.jpg' : '.bin';
  if (!asset.id.endsWith(extension)) return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const directory = await verifiedAssetsDirectory(sessionId);
    if (!directory) return null;
    const file = path.join(directory.path, asset.id);
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.bytes) return null;
    const real = await fs.realpath(file);
    if (!sameFilesystemPath(path.dirname(real), directory.realPath) || path.basename(real) !== asset.id) return null;
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== asset.bytes) return null;
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) return null;
    const after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino ||
        after.size !== stat.size) return null;
    const idHash = asset.id.slice(0, asset.id.lastIndexOf('.'));
    // writeAsset creates a 128-bit (32-hex) content key. A permissive legacy 8-hex
    // filename is not sufficient image-read authority even if its short prefix matches.
    if (idHash.length < 32 ||
        createHash('sha256').update(data.subarray(0, size)).digest('hex').slice(0, idHash.length) !== idHash) return null;
    return data.subarray(0, size);
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

/** Sole sessions:image data-URL authority. Asset queue MUST precede session queue: cleanup
 * holds the asset queue while waiting for owner retirement, and a reversed wait deadlocks.
 * This read-only seam admits assistant-rich assets only through the exact canonical
 * richImageReference membership proof; never through a caller-supplied media claim. */
export async function readRecordedSessionImage(sessionId: string, assetId: string): Promise<string | null> {
  const requestedAt = assetMutationEpoch;
  const deletionAt = sessionDeletionEpoch;
  if (!/^[0-9a-z-]{8,64}$/i.test(sessionId) ||
      !/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(assetId) || deletingSessions.has(sessionId)) return null;
  try {
    return await enqueueAssetOperation(async () => {
      if (assetMutationEpoch !== requestedAt || deletingSessions.has(sessionId)) return null;
      const entry = await ensureOpen(sessionId);
      return enqueueSessionOperation(entry, 'recorded image read', async () => {
        if (assetMutationEpoch !== requestedAt || deletingSessions.has(sessionId) ||
            sessionDeletionEpoch !== deletionAt) return null;
        if (!await verifiedAssetsDirectory(sessionId)) return null;
        const inventory = await imageOwnerInventory(sessionId, entry, assetId);
        if (!inventory) return null;
        const { events, ambiguousProviders } = inventory;
        const rich = await richImageReference(sessionId, entry, events, assetId, ambiguousProviders);
        // An independent existing user/native/tool owner may share the same content-addressed
        // file. Never turn a malformed rich reference into permission for a different asset.
        const legacy = events.flatMap(row => {
          if (row.kind === 'user_message') return row.retiredImageAssetIds?.includes(assetId) ? [] : row.assets ?? [];
          if (row.kind === 'tool_call') return row.call.retiredImageAssetIds?.includes(assetId) ? [] : row.call.assets ?? [];
          if (row.kind === 'native_image') return row.previewStatus === 'available' &&
            row.previewError !== 'removed' && row.asset ? [row.asset] : [];
          return [];
        }).find(asset => asset.id === assetId && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
        const asset = rich?.asset ?? legacy;
        if (!asset) return null;
        const data = await verifiedRecordedImageBytes(sessionId, asset);
        if (!data) return null;
        try {
          const image = sharp(data, { limitInputPixels: 36_000_000 });
          const metadata = await image.metadata();
          if (!metadata.width || !metadata.height || `image/${metadata.format}` !== asset.mimeType ||
              (rich && (metadata.width !== rich.width || metadata.height !== rich.height))) return null;
          await image.stats(); // Metadata alone accepts truncated/undecodable pixels.
          if (assetMutationEpoch !== requestedAt || deletingSessions.has(sessionId) ||
              sessionDeletionEpoch !== deletionAt) return null;
          return `data:${asset.mimeType};base64,${data.toString('base64')}`;
        } catch { return null; }
      });
    });
  } catch { return null; }
}

export async function readAsset(sessionId: string, assetId: string, maxBytes?: number): Promise<Buffer | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{8,64}\.(png|jpg|txt|bin)$/.test(assetId)) return null;
  try {
    const file = path.join(sessionDir(sessionId), 'assets', assetId);
    if (maxBytes === undefined) return await fs.readFile(file);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;
      // One bounded allocation and the same file handle throughout: an extra byte
      // detects growth after stat instead of letting readFile grow the allocation.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) return buffer.subarray(0, length);
        length += bytesRead;
      }
      return null;
    } finally { await handle.close(); }
  } catch {
    return null;
  }
}

/**
 * Stores text too long to sit inline, and returns the reference to put in the event.
 *
 * Content-addressed like any other asset, so a command run twice with the same enormous
 * output costs one file. Returns null only when the text is beyond even this — at which
 * point the event says so rather than pretending the record is complete.
 */
export async function writeOverflowText(sessionId: string, text: string): Promise<string | null> {
  if (text.length > MAX_OVERFLOW_ASSET_CHARS) return null;
  try {
    const asset = await writeAsset(sessionId, Buffer.from(text, 'utf8'), 'text/plain');
    return asset.id;
  } catch (err) {
    logWarn(`session ${sessionId}: overflow text not stored: ${(err as Error).message}`);
    return null;
  }
}

/** Reads back text spilled by writeOverflowText. */
export async function readOverflowText(sessionId: string, assetId: string): Promise<string | null> {
  const data = await readAsset(sessionId, assetId);
  return data ? data.toString('utf8') : null;
}

// --------------------------------------------------------------- handoffs

export async function saveHandoff(handoff: Handoff): Promise<void> {
  assertSessionId(handoff.sessionId);
  const dir = path.join(sessionDir(handoff.sessionId), 'handoffs');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${handoff.id}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(handoff, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function readHandoff(sessionId: string, handoffId: string): Promise<Handoff | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-z-]{8,64}$/i.test(handoffId)) return null;
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), 'handoffs', `${handoffId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Handoff;
    return typeof parsed?.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The newest handoff across every session — what a fresh chat asks for by default.
 *
 * Deliberately over every session rather than the capped UI list: the point of "the last
 * handoff" is that it is the last one, and "unless you happen to have more than two
 * hundred sessions" is not a property worth shipping.
 */
export async function latestHandoff(): Promise<Handoff | null> {
  const sessions = await readEverySummary();
  let best: Handoff | null = null;
  for (const summary of sessions) {
    if (!summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, summary.lastHandoffId);
    if (handoff && (!best || handoff.createdAt > best.createdAt)) best = handoff;
  }
  return best;
}

// ------------------------------------------------------------------ prune

/**
 * Compatibility seam for older callers. Age-based recording deletion was removed: only the
 * explicit delete-session and confirmed image-storage cleanup paths may remove history now.
 */
export async function pruneSessions(_retainDays: number): Promise<number> {
  return 0;
}

export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id);
  // Synchronous request edge: a read already inside Sharp must not return its bytes after
  // the user requests deletion, even while removal waits for the session queue.
  sessionDeletionEpoch += 1;
  deletingSessions.add(id);
  try {
    const entry = open.get(id);
    if (entry) {
      if (entry.metaTimer) clearTimeout(entry.metaTimer);
      await entry.queue.catch(() => undefined);
      open.delete(id);
    }
    await fs.rm(sessionDir(id), { recursive: true, force: true });
    invalidateAssetUsage(id);
    publishAttachmentRemoval(id);
  } finally {
    deletingSessions.delete(id);
  }
}

/** Test seam: forgets in-memory state without touching the files. */
export function resetSessionStoreForTests(): void {
  for (const entry of open.values()) if (entry.metaTimer) clearTimeout(entry.metaTimer);
  open.clear();
  pendingAttachmentTransitions.clear();
  opening.clear();
  reconciling.clear();
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  assetMutationEpoch = 0;
  assetWrittenEpoch.clear();
  removedAssetEpoch.clear();
  uncertainCleanupSessions.clear();
  sessionDeletionEpoch = 0;
  deletingSessions.clear();
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

/** Test seam: puts the store back to never having been told where to write. */
export function unsetSessionRootForTests(): void {
  root = '';
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  assetMutationEpoch = 0;
  assetWrittenEpoch.clear();
  removedAssetEpoch.clear();
  uncertainCleanupSessions.clear();
  sessionDeletionEpoch = 0;
  deletingSessions.clear();
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}
