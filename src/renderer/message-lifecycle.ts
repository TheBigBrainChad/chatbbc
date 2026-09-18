import { t } from './i18n.js';

/** The visible claim a message makes about where it has got to. */
export interface MessageStage { label: string; tone: 'queued' | 'scheduled' | 'composer' | 'turn' | 'sent' | 'failed'; detail: string }

/**
 * Project the outbox row onto what the user is told.
 *
 * `InputRow.state` is `queued | browser | tool | sent | cancelled | failed | decision`.
 * These are different facts and must not be merged: a message in the outbox, a message
 * inserted into the ChatGPT composer, one ChatGPT has accepted, and one an active turn
 * is holding are four different states with four different consequences for the user.
 */
export function lifecycleOf(entry: {
  state?: string; error?: string; dueAt?: number; delivery?: string;
  deliveredAt?: number; offeredAt?: number;
}): MessageStage {
  const { state } = entry;
  if (state === 'failed') return { label: t("NOT SENT"), detail: entry.error ?? t("Delivery was not confirmed"), tone: 'failed' };
  if (state === 'cancelled') return { label: t("WITHDRAWN"), detail: entry.error ?? t("No longer queued"), tone: 'failed' };
  if (state === 'sent') return { label: t("SENT"), detail: t("ChatGPT accepted it"), tone: 'sent' };
  if (state === 'tool') return { label: t("SENT TO TURN"), detail: t("Awaiting receipt from the active turn"), tone: 'turn' };
  if (state === 'browser') return { label: t("IN COMPOSER"), detail: t("In the ChatGPT composer · not sent"), tone: 'composer' };
  if (state === 'decision') return { label: t("PREPARING FOLLOW-UP"), detail: t("Producing the next instruction"), tone: 'queued' };
  if (entry.dueAt !== undefined && entry.dueAt > Date.now()) {
    return { label: t("SCHEDULED — after turn ends"), detail: t("Waiting for a verified completion"), tone: 'scheduled' };
  }
  if (entry.delivery === 'tool') return { label: t("WAITING FOR A TOOL CALL"), detail: t("Delivered with the next tool result"), tone: 'queued' };
  return { label: t("QUEUED"), detail: t("In the outbox · not yet in ChatGPT"), tone: 'queued' };
}
