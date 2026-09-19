import type { InputEntry } from './input.js';
import { browserInputModel } from '../../shared/input.js';
import { getSession, isRecordingDisabledError, observeSessionModel, readRecordedSessionImage, upsertMessageEvent, writeAsset } from './store.js';
import { validateInputImages } from './input-images.js';
import { positionOf } from '../../shared/chronology.js';
import { getConfig, getRecordingRevision } from '../config.js';

/** Project a tool handout or proven delivery into history, never the enqueue intent. */
export async function recordDeliveredInput(entry: Readonly<InputEntry>, anchorCommitted?: (seq: number) => void): Promise<boolean> {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  const offered = entry.state === 'tool' && !!entry.owner && Number.isFinite(entry.offeredAt);
  const confirmed = ['sent', 'cancelled'].includes(entry.state) && !!entry.messageId && Number.isFinite(entry.deliveredAt);
  if ((!offered && !confirmed) || !sessionId || entry.purpose === 'decision') return false;
  // This is an already-proven delivery receipt. Suppressing its optional history is
  // successful publication to the outbox: retrying after On would backfill Off prose.
  if (!getConfig().sessions.record) return true;
  const revision = getRecordingRevision();
  const stillRecording = () => getConfig().sessions.record && getRecordingRevision() === revision;
  const messageId = offered ? `input:${entry.id}` : entry.messageId!;
  const time = offered || (messageId.startsWith('input:') && Number.isFinite(entry.offeredAt))
    ? entry.offeredAt! : entry.deliveredAt!;
  const session = await getSession(sessionId);
  if (!stillRecording()) return true;
  if (!session) return false;
  const images = [...entry.images ?? [], ...entry.toolImages ?? []];
  const text = entry.deliveryText ?? entry.text;
  // Only an explicit native picker request proves model selection. Finish tasks
  // inherit the page model, so their old queued settings cannot become evidence.
  const selection = browserInputModel(entry);
  if (!messageId.startsWith('input:') && selection.model && entry.conversationId) {
    await observeSessionModel(sessionId, entry.conversationId, selection.model, entry.deliveredAt!, selection.reasoningEffort ?? undefined);
  }
  if (!stillRecording()) return true;
  const message = {
    time, source: 'app' as const, kind: 'user_message' as const,
    // Browser delivery uses its exact native key, so a later page echo updates this row.
    // Tool delivery has no native user row and keeps the stable input id as its key.
    messageId, inputId: entry.id, inputDelivery: offered ? 'offered' as const : 'confirmed' as const, authoredText: entry.text,
    ...(messageId.startsWith('input:') && entry.toolTurnId ? { turnId: entry.toolTurnId } : {}),
    ...(entry.attachments?.length && entry.transportIntent !== 'tool' ? { attachments: entry.attachments } : {}),
    // Injection does not change the running model. Only the native send path verifies
    // picker selection before delivery; a later sparse browser echo keeps this evidence.
    ...(!messageId.startsWith('input:') && selection.model
      ? { model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      : {}),
    message: { text, chars: text.length, truncated: false }
  };
  // Delivery and its chronology do not depend on optional preview storage. This
  // stable row survives a quota failure; retry only enriches the same origin.
  let committed: Awaited<ReturnType<typeof upsertMessageEvent>>;
  try {
    committed = await upsertMessageEvent(sessionId, message);
  } catch (error) {
    if (isRecordingDisabledError(error)) return true;
    throw error;
  }
  anchorCommitted?.(positionOf(committed.event));
  if (images.length && stillRecording()) {
    try {
      await validateInputImages(images);
      if (!stillRecording()) return true;
      const assets = [];
      for (const image of images) {
        if (!stillRecording()) return true;
        assets.push(await writeAsset(sessionId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/webp'));
      }
      if (!stillRecording()) return true;
      await upsertMessageEvent(sessionId, { ...message, assets });
    } catch (error) {
      if (isRecordingDisabledError(error)) return true;
      throw error;
    }
  }
  return true;
}

/** Existing fixed sessions:image route; the store owns serialized membership and pixel custody. */
export async function recordedInputImage(sessionId: string, assetId: string): Promise<string | null> {
  return readRecordedSessionImage(sessionId, assetId);
}
