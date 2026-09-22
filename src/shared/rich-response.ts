/** A bounded presentation projection. Message ownership is corroborated by the recorder. */
export const RICH_LIMITS = {
  bytes: 131_072, nodes: 1024, depth: 24, controls: 128, media: 64, textNode: 8192
} as const;

export type RichNode =
  | { id: string; kind: 'text'; text: string; style: 'body' | 'heading' | 'caption' | 'code' }
  | { id: string; kind: 'group'; layout: 'row' | 'column' | 'grid' | 'card' | 'list' | 'table' | 'diagram'; children: RichNode[] }
  | { id: string; kind: 'image'; mediaId: string; alt: string; width: number | null; height: number | null }
  | { id: string; kind: 'control'; control: 'choice' | 'continue' | 'button' | 'checkbox' | 'radio' | 'select' | 'input' | 'link'; label: string; groupId: string | null; value: string | null; selected: boolean; disabled: boolean; children: RichNode[] }
  | { id: string; kind: 'artifact'; mode: 'semantic' | 'static'; title: string; html: string | null; media: string[] };

export type RichResponse = {
  version: 1;
  status: 'available' | 'unavailable';
  reason: 'unsupported' | 'oversized' | 'ambiguous' | null;
  conversationId: string;
  messageId: string; // canonical logical message key
  providerMessageId: string | null; // currently evidenced provider identity, not a shard key
  revision: number;
  accessibleText: string;
  nodes: RichNode[];
};

type Obj = Record<string, unknown>;

const object = (value: unknown): Obj | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : null;

// Snapshot each own data descriptor once. A Proxy's ordinary property get may disagree with
// its descriptor or change between reads, so only this detached snapshot is ever inspected.
const snapshot = (value: Obj, names?: readonly string[]): Obj | null => {
  const keys = Reflect.ownKeys(value);
  if (keys.length > 9 || (names && keys.length !== names.length)) return null;
  const fields = Object.create(null) as Obj;
  for (const key of keys) {
    if (typeof key !== 'string' || (names && !names.includes(key))) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    fields[key] = descriptor.value;
  }
  return fields;
};

// Admit only a dense JSON-style array. Reading indexed descriptors avoids invoking untrusted
// getters, custom iterators and inherited values; the exact key count excludes extra data.
const arrayElements = (value: unknown): unknown[] | null => {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.enumerable ||
    lengthDescriptor.configurable || !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 || lengthDescriptor.value > RICH_LIMITS.nodes) return null;
  const length: number = lengthDescriptor.value;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const elements: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    elements.push(descriptor.value);
  }
  return elements;
};

const opaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9:_-]{1,190}$/i.test(value);

const geometry = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000);

/**
 * Strictly validate and copy untrusted presentation data, without retaining provider URLs,
 * arbitrary fields, callbacks or references to the original objects. A caller must separately
 * establish exact message ownership before recording or acting on the result.
 */
export function parseRichResponse(input: unknown): RichResponse | null {
  try {
    const sourceRoot = object(input);
    if (!sourceRoot) return null;
    const root = snapshot(sourceRoot, [
      'version', 'status', 'reason', 'conversationId', 'messageId', 'providerMessageId',
      'revision', 'accessibleText', 'nodes'
    ]);
    if (!root || root.version !== 1 || (root.status !== 'available' && root.status !== 'unavailable') ||
      typeof root.revision !== 'number' || !Number.isSafeInteger(root.revision) || root.revision < 0 ||
      typeof root.conversationId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(root.conversationId) ||
      typeof root.messageId !== 'string' || root.messageId.length === 0 || root.messageId.length > 256 ||
      (root.providerMessageId !== null &&
        (typeof root.providerMessageId !== 'string' || !/^[a-z0-9-]{8,100}$/i.test(root.providerMessageId)))) return null;

    const rootNodes = arrayElements(root.nodes);
    if (!rootNodes) return null;

    if (root.status === 'available' ? root.reason !== null :
      root.reason !== 'unsupported' && root.reason !== 'oversized' && root.reason !== 'ambiguous') return null;
    if (root.status === 'unavailable' && rootNodes.length !== 0) return null;

    const encoder = new TextEncoder();
    let utf8 = 0;
    let count = 0;
    let controls = 0;
    let media = 0;
    const seen = new WeakSet<object>([sourceRoot]);
    const ids = new Set<string>();

    const string = (value: unknown, limit: number = RICH_LIMITS.textNode): value is string => {
      // UTF-16 length is a cheap lower bound on UTF-8 length, and rejects huge strings
      // before allocating any encoded buffer. Multibyte values still need byte validation.
      if (typeof value !== 'string' || value.length > limit) return false;
      const bytes = encoder.encode(value).length;
      if (bytes > limit) return false;
      utf8 += bytes;
      return utf8 <= RICH_LIMITS.bytes;
    };

    if (!string(root.accessibleText, RICH_LIMITS.bytes) ||
      !string(root.conversationId, 64) || !string(root.messageId, 256) ||
      (root.providerMessageId !== null && !string(root.providerMessageId, 100))) return null;

    const node = (value: unknown, depth: number): RichNode | null => {
      const item = object(value);
      if (!item || seen.has(item) || depth > RICH_LIMITS.depth || ++count > RICH_LIMITS.nodes) return null;

      const fields = snapshot(item);
      if (!fields) return null;
      const kind = fields.kind;
      const names = kind === 'text' ? ['id', 'kind', 'text', 'style'] :
        kind === 'image' ? ['id', 'kind', 'mediaId', 'alt', 'width', 'height'] :
          kind === 'group' ? ['id', 'kind', 'layout', 'children'] :
            kind === 'artifact' ? ['id', 'kind', 'mode', 'title', 'html', 'media'] :
            kind === 'control' ? [
              'id', 'kind', 'control', 'label', 'groupId', 'value', 'selected', 'disabled', 'children'
            ] : null;
      if (!names || Object.keys(fields).length !== names.length ||
        !names.every(name => Object.hasOwn(fields, name)) ||
        !opaque(fields.id) || ids.has(fields.id) || !string(fields.id, 190)) return null;
      seen.add(item);
      ids.add(fields.id);

      if (kind === 'text') {
        if (!string(fields.text) || !['body', 'heading', 'caption', 'code'].includes(fields.style as string)) return null;
        return { id: fields.id, kind: 'text', text: fields.text, style: fields.style as Extract<RichNode, { kind: 'text' }>['style'] };
      }

      if (kind === 'image') {
        if (!opaque(fields.mediaId) || !string(fields.mediaId, 190) || !string(fields.alt) ||
          !geometry(fields.width) || !geometry(fields.height) || ++media > RICH_LIMITS.media) return null;
        return { id: fields.id, kind: 'image', mediaId: fields.mediaId, alt: fields.alt,
          width: fields.width, height: fields.height };
      }

      if (kind === 'artifact') {
        const mediaIds = arrayElements(fields.media);
        if (!mediaIds || mediaIds.length > 4 || !string(fields.title, 200) ||
          (fields.mode !== 'static' && fields.mode !== 'semantic')) return null;
        const media: string[] = [];
        const seenMedia = new Set<string>();
        for (const mediaId of mediaIds) {
          if (!opaque(mediaId) || seenMedia.has(mediaId) || !string(mediaId, 190)) return null;
          seenMedia.add(mediaId);
          media.push(mediaId);
        }
        if (fields.mode === 'semantic') {
          if (fields.html !== null || media.length !== 0) return null;
          return { id: fields.id, kind: 'artifact', mode: 'semantic', title: fields.title, html: null, media };
        }
        if (!string(fields.html, 131_072) || /<script|onclick|https:|<form|@import|\bhref=/i.test(fields.html)) return null;
        return { id: fields.id, kind: 'artifact', mode: 'static', title: fields.title, html: fields.html, media };
      }

      const sourceChildren = arrayElements(fields.children);
      if (!sourceChildren) return null;
      if (kind === 'group') {
        if (!['row', 'column', 'grid', 'card', 'list', 'table', 'diagram'].includes(fields.layout as string)) return null;
      } else if (++controls > RICH_LIMITS.controls ||
        !['choice', 'continue', 'button', 'checkbox', 'radio', 'select', 'input', 'link'].includes(fields.control as string) ||
        !string(fields.label) || (fields.groupId !== null && (!opaque(fields.groupId) || !string(fields.groupId, 190))) ||
        (fields.value !== null && !string(fields.value)) ||
        typeof fields.selected !== 'boolean' || typeof fields.disabled !== 'boolean') return null;

      const children: RichNode[] = [];
      for (let index = 0; index < sourceChildren.length; index++) {
        const parsed = node(sourceChildren[index], depth + 1);
        if (!parsed) return null;
        children.push(parsed);
      }

      if (kind === 'group') return {
        id: fields.id, kind: 'group', layout: fields.layout as Extract<RichNode, { kind: 'group' }>['layout'], children
      };
      return {
        id: fields.id, kind: 'control', control: fields.control as Extract<RichNode, { kind: 'control' }>['control'],
        label: fields.label as string, groupId: fields.groupId as string | null,
        value: fields.value as string | null, selected: fields.selected as boolean,
        disabled: fields.disabled as boolean, children
      };
    };

    const nodes: RichNode[] = [];
    for (let index = 0; index < rootNodes.length; index++) {
      const parsed = node(rootNodes[index], 1);
      if (!parsed) return null;
      nodes.push(parsed);
    }
    const result: RichResponse = {
      version: 1, status: root.status, reason: root.reason as RichResponse['reason'],
      conversationId: root.conversationId, messageId: root.messageId,
      providerMessageId: root.providerMessageId as string | null,
      revision: root.revision, accessibleText: root.accessibleText as string, nodes
    };
    return encoder.encode(JSON.stringify(result)).length <= RICH_LIMITS.bytes ? result : null;
  } catch {
    // Proxy traps, cyclic arrays and other hostile non-JSON values are invalid observations.
    return null;
  }
}

export type RichChoiceIdentity = {
  control: Extract<RichNode, { kind: 'control' }>['control'];
  groupId: string | null;
  value: string | null;
  label: string;
  selected: boolean;
  disabled: boolean;
};

/** Stored choice fields from a validated tree. This does not read the live page. */
export function collectChoices(tree: RichResponse): RichChoiceIdentity[] {
  const found: RichChoiceIdentity[] = [];
  const visit = (nodes: RichNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'control') found.push({
        control: node.control, groupId: node.groupId, value: node.value, label: node.label,
        selected: node.selected, disabled: node.disabled
      });
      if (node.kind === 'group' || node.kind === 'control') visit(node.children);
    }
  };
  visit(tree.nodes);
  return found;
}
