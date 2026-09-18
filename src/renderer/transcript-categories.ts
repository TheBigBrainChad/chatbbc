import type { SessionEventKind } from '../shared/session.js';

/** One identity per content family. Geometry is shared; accent, glyph and edge are not. */
export const CONTENT_CATEGORIES = [
  'authored', 'prose', 'code', 'diff', 'image', 'tool', 'error',
  'recovery', 'worker', 'handoff', 'plan', 'note'
] as const;
export type ContentCategory = typeof CONTENT_CATEGORIES[number];

const BY_KIND: Record<SessionEventKind, ContentCategory> = {
  user_message: 'authored',
  assistant_message: 'prose',
  tool_call: 'tool',
  page_tool: 'tool',
  native_image: 'image',
  agent_message: 'worker',
  progress: 'recovery',
  chat_error: 'error',
  note: 'note',
  handoff: 'handoff',
  session_start: 'note',
  turn_start: 'note',
  turn_end: 'note'
};

export function categoryFor(kind: SessionEventKind): ContentCategory {
  return BY_KIND[kind] ?? 'note';
}

/** The class a row carries. One class per category, so CSS owns the identity. */
export function categoryClass(category: ContentCategory): string {
  return `cat-${category}`;
}
