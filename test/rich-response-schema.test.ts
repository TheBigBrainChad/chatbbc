import { expect, it, vi } from 'vitest';
import { parseRichResponse, RICH_LIMITS } from '../src/shared/rich-response.js';

const good = {
  version: 1,
  status: 'available',
  reason: null,
  conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: 'assistant:working:exchange:1789552000000',
  providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
  revision: 1,
  accessibleText: 'Choose one',
  nodes: [{ id: 'n0', kind: 'text', style: 'body', text: 'Choose one' }]
} as const;

const text = (id: string, value = '') => ({ id, kind: 'text', style: 'body', text: value });
const image = (id: string) => ({ id, kind: 'image', mediaId: `asset:${id}`, alt: '', width: 12, height: 12 });
const control = (id: string) => ({
  id, kind: 'control', control: 'choice', label: 'Choose', groupId: 'choices', value: id,
  selected: false, disabled: false, children: []
});
const withNodes = (nodes: unknown[]) => ({ ...good, nodes });

it('accepts a complete small semantic response and exposes the agreed limits', () => {
  expect(parseRichResponse(good)).toEqual(good);
  expect(RICH_LIMITS).toEqual({ bytes: 131_072, nodes: 1024, depth: 24, controls: 128, media: 64, textNode: 8192 });
});

it('accepts all supported nodes, layouts, controls, safe geometry and null optional fields', () => {
  const nodes = [{
    id: 'root', kind: 'group', layout: 'grid', children: [
      { id: 'title', kind: 'text', style: 'heading', text: 'Choose one' },
      { id: 'card', kind: 'group', layout: 'card', children: [image('illustration'), control('choice')] },
      { ...image('unknown-dimensions'), width: null, height: null },
      { ...control('continue'), control: 'continue', groupId: null, value: null, children: [text('hint', 'Continue')] }
    ]
  }];
  const input = { ...good, providerMessageId: null, nodes };
  expect(parseRichResponse(input)).toEqual(input);
});

it('accepts an unavailable projection only with an explicit reason and no nodes', () => {
  for (const reason of ['unsupported', 'oversized', 'ambiguous']) {
    const input = { ...good, status: 'unavailable', reason, nodes: [] };
    expect(parseRichResponse(input)).toEqual(input);
    expect(parseRichResponse({ ...input, nodes: [text('leaked')] })).toBeNull();
  }
  expect(parseRichResponse({ ...good, status: 'available', reason: 'oversized' })).toBeNull();
  expect(parseRichResponse({ ...good, status: 'unavailable', reason: null, nodes: [] })).toBeNull();
});

it('rejects executable fields and foreign sources even when the rest of the node is valid', () => {
  expect(parseRichResponse(withNodes([{ ...text('x'), onclick: 'run()' }]))).toBeNull();
  expect(parseRichResponse(withNodes([{ ...image('x'), mediaId: 'https://example.test/secret' }]))).toBeNull();
  expect(parseRichResponse(withNodes([{ ...image('x'), src: 'https://example.test/secret' }]))).toBeNull();
  expect(parseRichResponse(withNodes([{ ...control('x'), action: 'eval()' }]))).toBeNull();
  expect(parseRichResponse({ ...good, source: 'untrusted' })).toBeNull();
});

it('requires exact own data fields and rejects getters, symbols and missing fields', () => {
  const accessor = { ...good, nodes: [text('x')] };
  Object.defineProperty(accessor.nodes[0], 'text', { get: () => 'injected', enumerable: true });
  expect(parseRichResponse(accessor)).toBeNull();
  const symbol = { ...good, [Symbol('invisible')]: 'javascript' };
  expect(parseRichResponse(symbol)).toBeNull();
  const { revision: _revision, ...missingRevision } = good;
  expect(parseRichResponse(missingRevision)).toBeNull();
  expect(parseRichResponse(Object.create(null))).toBeNull();
});

it('rejects indexed array accessors without calling them at the root or under groups and controls', () => {
  let calls = 0;
  for (const wrap of [
    (nodes: unknown[]) => withNodes(nodes),
    (nodes: unknown[]) => withNodes([{ id: 'group', kind: 'group', layout: 'row', children: nodes }]),
    (nodes: unknown[]) => withNodes([{ ...control('parent'), children: nodes }])
  ]) {
    const nodes: unknown[] = [text('actual')];
    Object.defineProperty(nodes, '0', { enumerable: true, configurable: true, get: () => {
      calls++;
      return text('forged');
    } });
    expect(parseRichResponse(wrap(nodes))).toBeNull();
  }
  expect(calls).toBe(0);
});

it('rejects extra array keys, URLs, symbols and overridden iterators at every tree level', () => {
  for (const wrap of [
    (nodes: unknown[]) => withNodes(nodes),
    (nodes: unknown[]) => withNodes([{ id: 'group', kind: 'group', layout: 'column', children: nodes }]),
    (nodes: unknown[]) => withNodes([{ ...control('parent'), children: nodes }])
  ]) {
    const source = [text('actual')];
    Object.defineProperty(source, 'source', { value: 'https://example.test/signed', enumerable: false });
    expect(parseRichResponse(wrap(source))).toBeNull();

    const symbol = [text('actual')];
    Object.defineProperty(symbol, Symbol('hidden'), { value: 'javascript' });
    expect(parseRichResponse(wrap(symbol))).toBeNull();

    const forged = [{ ...text('unsafe'), onclick: 'run()' }];
    Object.defineProperty(forged, Symbol.iterator, { value: function* () { yield text('forged'); } });
    expect(parseRichResponse(wrap(forged))).toBeNull();
  }
});

it('rejects sparse arrays including inherited index values at the root and nested levels', () => {
  for (const wrap of [
    (nodes: unknown[]) => withNodes(nodes),
    (nodes: unknown[]) => withNodes([{ id: 'group', kind: 'group', layout: 'row', children: nodes }]),
    (nodes: unknown[]) => withNodes([{ ...control('parent'), children: nodes }])
  ]) {
    const sparse = new Array<unknown>(1);
    expect(parseRichResponse(wrap(sparse))).toBeNull();
    const inherited = Object.create(Array.prototype) as unknown[];
    inherited[0] = text('inherited');
    Object.setPrototypeOf(sparse, inherited);
    expect(parseRichResponse(wrap(sparse))).toBeNull();
  }
});

it('reads indexed array data descriptors without trusting proxy get traps or inherited iterators', () => {
  for (const wrap of [
    (nodes: unknown[]) => withNodes(nodes),
    (nodes: unknown[]) => withNodes([{ id: 'group', kind: 'group', layout: 'row', children: nodes }]),
    (nodes: unknown[]) => withNodes([{ ...control('parent'), children: nodes }])
  ]) {
    const data = [text('actual')];
    const nodes = new Proxy(data, {
      get(target, key, receiver) {
        if (key === 'length' || key === '0' || key === Symbol.iterator) throw new Error('untrusted array read');
        return Reflect.get(target, key, receiver);
      }
    });
    expect(parseRichResponse(wrap(nodes))).not.toBeNull();
  }
});

it('rejects invalid canonical identities, revisions, root versions and unknown status', () => {
  for (const input of [
    { ...good, version: 2 }, { ...good, status: 'loading' },
    { ...good, conversationId: 'http://wrong' }, { ...good, conversationId: '' },
    { ...good, messageId: '' }, { ...good, messageId: 'x'.repeat(257) },
    { ...good, providerMessageId: 'https://example.test/image' },
    { ...good, revision: -1 }, { ...good, revision: 1.5 },
    { ...good, revision: Number.MAX_SAFE_INTEGER + 1 }
  ]) expect(parseRichResponse(input)).toBeNull();
});

it('accepts exactly 1,024 nodes and refuses node 1,025', () => {
  const nodes = Array.from({ length: 1024 }, (_, i) => text(`n${i}`));
  expect(parseRichResponse(withNodes(nodes))?.nodes).toHaveLength(1024);
  expect(parseRichResponse(withNodes([...nodes, text('overflow')]))).toBeNull();
});

it('accepts depth 24 and refuses depth 25', () => {
  let node: unknown = text('leaf');
  for (let depth = 23; depth >= 1; depth--) node = { id: `level${depth}`, kind: 'group', layout: 'column', children: [node] };
  expect(parseRichResponse(withNodes([node]))).not.toBeNull();
  expect(parseRichResponse(withNodes([{ id: 'outer', kind: 'group', layout: 'column', children: [node] }]))).toBeNull();
});

it('accepts 128 controls and 64 media slots, refusing one additional reference of each', () => {
  const choices = Array.from({ length: 128 }, (_, i) => control(`c${i}`));
  const media = Array.from({ length: 64 }, (_, i) => image(`i${i}`));
  expect(parseRichResponse(withNodes(choices))).not.toBeNull();
  expect(parseRichResponse(withNodes([...choices, control('extra')]))).toBeNull();
  expect(parseRichResponse(withNodes(media))).not.toBeNull();
  expect(parseRichResponse(withNodes([...media, image('extra')]))).toBeNull();
});

it('enforces 8 KiB per text node in UTF-8 bytes, including multibyte and surrogate-pair text', () => {
  expect(parseRichResponse(withNodes([text('x', 'a'.repeat(8192))]))).not.toBeNull();
  expect(parseRichResponse(withNodes([text('x', 'a'.repeat(8193))]))).toBeNull();
  expect(parseRichResponse(withNodes([text('x', 'é'.repeat(4096))]))).not.toBeNull();
  expect(parseRichResponse(withNodes([text('x', 'é'.repeat(4097))]))).toBeNull();
  expect(parseRichResponse(withNodes([text('x', '😀'.repeat(2048))]))).not.toBeNull();
  expect(parseRichResponse(withNodes([text('x', '😀'.repeat(2049))]))).toBeNull();
});

it('bounds the full serialized message including structural JSON overhead', () => {
  const nearLimit = Array.from({ length: 16 }, (_, i) => text(`n${i}`, 'a'.repeat(8000)));
  const beyondLimit = Array.from({ length: 16 }, (_, i) => text(`n${i}`, 'a'.repeat(8180)));
  expect(parseRichResponse(withNodes(nearLimit))).not.toBeNull();
  expect(parseRichResponse(withNodes(beyondLimit))).toBeNull();
});

it('rejects enormous strings by length before trying to encode them', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(parseRichResponse({ ...good, accessibleText: 'x'.repeat(1_000_000) })).toBeNull();
    expect(parseRichResponse(withNodes([text('x', '🚫'.repeat(100_000))]))).toBeNull();
    expect(encode.mock.calls.every(([value]) => typeof value === 'string' && value.length <= RICH_LIMITS.textNode)).toBe(true);
  } finally {
    encode.mockRestore();
  }
});

it('rejects cycles and reused object references before serialization', () => {
  const cyclic: { id: string; kind: string; layout: string; children: unknown[] } = {
    id: 'cycle', kind: 'group', layout: 'row', children: []
  };
  cyclic.children.push(cyclic);
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    expect(parseRichResponse(withNodes([cyclic]))).toBeNull();
    expect(parseRichResponse(withNodes([cyclic, cyclic]))).toBeNull();
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it('rejects duplicate node IDs, unsupported variants and malformed control values', () => {
  for (const nodes of [
    [text('same'), image('same')],
    [{ ...text('x'), style: 'script' }],
    [{ id: 'x', kind: 'script', code: 'run()' }],
    [{ id: 'x', kind: 'group', layout: 'iframe', children: [] }],
    [{ ...control('x'), control: 'execute' }],
    [{ ...control('x'), selected: 'true' }],
    [{ ...control('x'), groupId: 'https://example.test' }],
    [{ ...control('x'), value: 'x'.repeat(8193) }],
    [{ ...image('x'), mediaId: 'a'.repeat(191) }]
  ]) expect(parseRichResponse(withNodes(nodes))).toBeNull();
});

it('accepts bounded integer image dimensions or null and refuses unsafe geometry', () => {
  expect(parseRichResponse(withNodes([{ ...image('x'), width: 100_000, height: 1 }]))).not.toBeNull();
  for (const width of [0, -1, 1.2, Infinity, NaN, 100_001, Number.MAX_SAFE_INTEGER + 1, '12']) {
    expect(parseRichResponse(withNodes([{ ...image('x'), width }]))).toBeNull();
  }
});

it('returns null for malformed root types and rejects cycles without throwing', () => {
  for (const input of [null, false, 1, 'text', [], [good]]) {
    expect(parseRichResponse(input)).toBeNull();
  }
  const root = { ...good } as Record<string, unknown>;
  root.nodes = [root];
  expect(parseRichResponse(root)).toBeNull();
});
