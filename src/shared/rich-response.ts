/** A bounded presentation projection. Message ownership is corroborated by the recorder. */
export const RICH_LIMITS = {
  bytes: 131_072, nodes: 1024, depth: 24, controls: 128, media: 64, textNode: 8192
} as const;

export type RichNode =
  | { id: string; kind: 'text'; text: string; style: 'body' | 'heading' | 'caption' | 'code' }
  | { id: string; kind: 'group'; layout: 'row' | 'column' | 'grid' | 'card' | 'list' | 'table' | 'diagram'; children: RichNode[] }
  | { id: string; kind: 'image'; mediaId: string; alt: string; width: number | null; height: number | null }
  | { id: string; kind: 'control'; control: 'choice' | 'continue' | 'button' | 'checkbox' | 'radio' | 'select' | 'input' | 'link'; label: string; groupId: string | null; value: string | null; selected: boolean; disabled: boolean; children: RichNode[] };

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

// Reject accessors and hidden or unknown properties instead of executing model-supplied fields.
const exact = (value: Obj, names: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => {
    if (typeof key !== 'string' || !names.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
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
    const root = object(input);
    if (!root || !exact(root, [
      'version', 'status', 'reason', 'conversationId', 'messageId', 'providerMessageId',
      'revision', 'accessibleText', 'nodes'
    ]) || root.version !== 1 || (root.status !== 'available' && root.status !== 'unavailable') ||
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
    const seen = new WeakSet<object>([root]);
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

      // Check the discriminator's descriptor before reading it; no getter may classify a node.
      const kind = Object.getOwnPropertyDescriptor(item, 'kind');
      if (!kind || !kind.enumerable || !('value' in kind)) return null;
      const names = kind.value === 'text' ? ['id', 'kind', 'text', 'style'] :
        kind.value === 'image' ? ['id', 'kind', 'mediaId', 'alt', 'width', 'height'] :
          kind.value === 'group' ? ['id', 'kind', 'layout', 'children'] :
            kind.value === 'control' ? [
              'id', 'kind', 'control', 'label', 'groupId', 'value', 'selected', 'disabled', 'children'
            ] : null;
      if (!names || !exact(item, names) || !opaque(item.id) || ids.has(item.id) || !string(item.id, 190)) return null;
      seen.add(item);
      ids.add(item.id);

      if (kind.value === 'text') {
        if (!string(item.text) || !['body', 'heading', 'caption', 'code'].includes(item.style as string)) return null;
        return { id: item.id, kind: 'text', text: item.text, style: item.style as Extract<RichNode, { kind: 'text' }>['style'] };
      }

      if (kind.value === 'image') {
        if (!opaque(item.mediaId) || !string(item.mediaId, 190) || !string(item.alt) ||
          !geometry(item.width) || !geometry(item.height) || ++media > RICH_LIMITS.media) return null;
        return { id: item.id, kind: 'image', mediaId: item.mediaId, alt: item.alt,
          width: item.width, height: item.height };
      }

      const sourceChildren = arrayElements(item.children);
      if (!sourceChildren) return null;
      if (kind.value === 'group') {
        if (!['row', 'column', 'grid', 'card', 'list', 'table', 'diagram'].includes(item.layout as string)) return null;
      } else if (++controls > RICH_LIMITS.controls ||
        !['choice', 'continue', 'button', 'checkbox', 'radio', 'select', 'input', 'link'].includes(item.control as string) ||
        !string(item.label) || (item.groupId !== null && (!opaque(item.groupId) || !string(item.groupId, 190))) ||
        (item.value !== null && !string(item.value)) ||
        typeof item.selected !== 'boolean' || typeof item.disabled !== 'boolean') return null;

      const children: RichNode[] = [];
      for (let index = 0; index < sourceChildren.length; index++) {
        const parsed = node(sourceChildren[index], depth + 1);
        if (!parsed) return null;
        children.push(parsed);
      }

      if (kind.value === 'group') return {
        id: item.id, kind: 'group', layout: item.layout as Extract<RichNode, { kind: 'group' }>['layout'], children
      };
      return {
        id: item.id, kind: 'control', control: item.control as Extract<RichNode, { kind: 'control' }>['control'],
        label: item.label as string, groupId: item.groupId as string | null,
        value: item.value as string | null, selected: item.selected as boolean,
        disabled: item.disabled as boolean, children
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
