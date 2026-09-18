import type { RichOrigin } from '../../shared/session.js';

export type { RichOrigin };

/** Snapshot metadata safely; this still does NOT authenticate Chrome sender provenance. */
export function parseRichOrigin(value: unknown): RichOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const fields = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(fields);
    if (keys.length !== 4 || keys.some(key => typeof key !== 'string' ||
      !['conversationId', 'bindingRevision', 'documentId', 'navigationEpoch'].includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(fields, key);
      if (typeof key !== 'string' || !field || !field.enumerable || !('value' in field)) return null;
      snapshot[key] = field.value;
    }
    if (!(typeof snapshot.conversationId === 'string' && /^[a-z0-9-]{8,64}$/i.test(snapshot.conversationId) &&
      Number.isSafeInteger(snapshot.bindingRevision) && (snapshot.bindingRevision as number) >= 0 &&
      typeof snapshot.documentId === 'string' && /^[a-z0-9_-]{1,200}$/i.test(snapshot.documentId) &&
      Number.isSafeInteger(snapshot.navigationEpoch) && (snapshot.navigationEpoch as number) >= 0)) return null;
    return { conversationId: snapshot.conversationId, bindingRevision: snapshot.bindingRevision as number,
      documentId: snapshot.documentId, navigationEpoch: snapshot.navigationEpoch as number };
  } catch {
    return null;
  }
}
