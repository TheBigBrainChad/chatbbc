import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
interface DomApi {
  richRootFor(messageId: string, providerMessageId: string): Element | null;
  captureRichRoot(root: Element): unknown[] | null;
  resolveRichImage(
    root: Element, rich: unknown, nodeId: string, mediaId: string,
    expectedStamp: string, stillCurrent: () => boolean
  ): { root: Element; image: HTMLImageElement } | null;
  resolveRichNativeImage(
    root: Element, rich: unknown, nodeId: string, mediaId: string,
    expectedStamp: string, scanToken: string,
    turns: Array<{ index: number; conversationId: string; conversationConflict: boolean;
      images: Array<{ messageId: string; assetId: string }> }>,
    originalImage: HTMLImageElement, stillCurrent: () => boolean,
    sourceHandle: object
  ): { root: Element; image: HTMLImageElement; messageId: string; assetId: string } | null;
  beginRichImageSource(
    root: Element, rich: unknown, nodeId: string, mediaId: string,
    expectedStamp: string, stillCurrent: () => boolean
  ): object | null;
  richImageSourceWitness(handle: object): { sourceIncarnation: string; sourceSequence: number } | null;
  richImageSourceStable(handle: object): { sourceIncarnation: string; sourceSequence: number } | null;
  beginPendingRichImageSource(root: Element, rich: unknown, nodeId: string, mediaId: string,
    expectedStamp: string, stillCurrent: () => boolean,
    onRetire?: (reason: string, handle: object) => void,
    onLoad?: (handle: object) => void): object | null;
  richImagePendingWitness(handle: object): { sourceIncarnation: string; sourceSequence: number } | null;
  rebindLoadedRichImageSource(handle: object, root: Element, rich: unknown, nodeId: string,
    mediaId: string, expectedStamp: string, stillCurrent: () => boolean): object | null;
  releaseRichImageSource(handle: object): void;
  insertPrompt(text: string, mode?: boolean | 'append', failure?: (reason: string) => void): boolean;
  enterProject(entry: { id: string; sourceConversationId: string }, current?: () => boolean): Promise<boolean>;
  composerActions(): { host: HTMLElement; before: HTMLElement | null } | null;
  generating(): boolean;
  sendButton(): HTMLButtonElement | null;
  temporaryChatReady(): boolean;
  errors(): Array<{ text: string; recoverable: boolean; blocking?: boolean }>;
  captureComposerDraft(text: string, current?: () => boolean): { current(): boolean; clear(): Promise<boolean>; dispose(): void; attachments(nodes: Element[]): void };
  visibleModelSelection(): { model: string; reasoningEffort?: string } | null;
  hasComposerAttachments(): boolean;
  stopGeneration(current: () => boolean): boolean;
  inspectModelSettings(current?: () => boolean, failure?: (reason: string) => void): Promise<Array<{id: string; label: string; efforts: string[]}> | null>;
  send(options?: { acceptanceTimeoutMs?: number; stillCurrent?: () => boolean; beforeSend?: () => Promise<boolean> }): Promise<boolean>;
  selectModelSettings(model: string | null, effort: string | null, current?: () => boolean): Promise<boolean>;
  uploadImages(images: Array<{ name: string; dataUrl: string }>, current?: () => boolean, draft?: ReturnType<DomApi['captureComposerDraft']>, files?: File[]): Promise<boolean>;
}
let dom: JSDOM;
let document: Document;
let api: DomApi;
let box: HTMLElement;
let button: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<form><div id="prompt-textarea" contenteditable="true">Exact app prompt</div><div data-testid="composer-trailing-actions"><button type="button" aria-haspopup="menu">Medium</button><button type="button" data-testid="send-button">Send</button></div></form>', { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 10, height: 10 }]; } });
  dom.window.eval(source);
  api = (dom.window as unknown as { CLF_DOM: DomApi }).CLF_DOM;
  box = document.getElementById('prompt-textarea')!;
  button = document.querySelector('[data-testid="send-button"]')!;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });

describe('exact rich PAGE image element resolution', () => {
  const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const providerMessageId = '11111111-2222-4333-8444-555555555555';
  const messageId = 'thought:synthetic-exchange:synthetic-turn';
  const stamp = `scan-one:0:${encodeURIComponent(messageId)}:${providerMessageId}`;
  function fixture() {
    dom.reconfigure({ url: `https://chatgpt.com/c/${conversationId}` });
    const turn = document.createElement('section');
    turn.dataset.testid = 'conversation-turn-0';
    turn.setAttribute('data-clf-fiber-turn', 'scan-one:0');
    const row = document.createElement('div');
    row.setAttribute('data-message-author-role', 'assistant');
    row.setAttribute('data-message-id', providerMessageId);
    const root = document.createElement('div');
    root.setAttribute('data-clf-fiber-rich', stamp);
    const surface = document.createElement('div');
    surface.className = 'puik-root not-prose not-markdown';
    const cards = ['Forest', 'Coast'].map(alt => {
      const card = document.createElement('button');
      card.setAttribute('aria-label', alt);
      const image = document.createElement('img');
      image.alt = alt;
      card.append(image); surface.append(card);
      return image;
    });
    root.append(surface); row.append(root); turn.append(row); document.body.append(turn);
    const nodes = api.captureRichRoot(root);
    expect(nodes).not.toBeNull();
    return { turn, row, root, cards, rich: {
      version: 1, status: 'available', reason: null, conversationId, messageId,
      providerMessageId, revision: 1, accessibleText: 'Forest Coast', nodes
    } };
  }
  const forestId = 'n-0-0-0';
  const forestMediaId = 'media-n-0-0-0';
  const resolveForest = (sample: ReturnType<typeof fixture>, current = () => true) =>
    api.resolveRichImage(sample.root, sample.rich, forestId, forestMediaId, stamp, current);

  it('returns only the exact transient image and root from the already captured semantic path', () => {
    const sample = fixture();
    expect(api.richRootFor(messageId, providerMessageId)).toBe(sample.root);
    const result = resolveForest(sample);
    expect(result).toEqual({ root: sample.root, image: sample.cards[0] });
    expect(Object.keys(result!)).toEqual(['root', 'image']);
    expect(api.resolveRichImage(sample.root, sample.rich, 'n-0-1-0', 'media-n-0-1-0', stamp, () => true))
      .toEqual({ root: sample.root, image: sample.cards[1] });
  });

  it('refuses a wrong path, media identity, missing node or duplicated rich slot', () => {
    const sample = fixture();
    expect(api.resolveRichImage(sample.root, sample.rich, 'n-0-1-0', forestMediaId, stamp, () => true)).toBeNull();
    expect(api.resolveRichImage(sample.root, sample.rich, forestId, 'media-n-0-1-0', stamp, () => true)).toBeNull();
    expect(api.resolveRichImage(sample.root, sample.rich, 'n-0-9-0', 'media-n-0-9-0', stamp, () => true)).toBeNull();
    const duplicate = { ...sample.rich, nodes: [...sample.rich.nodes!, ...sample.rich.nodes!] };
    expect(api.resolveRichImage(sample.root, duplicate, forestId, forestMediaId, stamp, () => true)).toBeNull();
    sample.cards[0]!.remove();
    expect(resolveForest(sample)).toBeNull();
  });

  it('rejects oversize and aggregate-frontier rich arrays before reading their entries', () => {
    const sample = fixture();
    let topLevelReads = 0;
    const oversized = Array.from({ length: 2049 }, () => sample.rich.nodes![0]);
    Object.defineProperty(oversized, '0', { get() { topLevelReads++; return sample.rich.nodes![0]; } });
    expect(api.resolveRichImage(sample.root, { ...sample.rich, nodes: oversized }, forestId, forestMediaId, stamp, () => true)).toBeNull();
    expect(topLevelReads).toBe(0);

    let childReads = 0;
    const children = Array.from({ length: 1000 }, () => sample.rich.nodes![0]);
    Object.defineProperty(children, '0', { get() { childReads++; return sample.rich.nodes![0]; } });
    const wide = Array.from({ length: 100 }, () => sample.rich.nodes![0]);
    wide[99] = { id: 'wide-frontier', kind: 'group', layout: 'column', children };
    expect(api.resolveRichImage(sample.root, { ...sample.rich, nodes: wide }, forestId, forestMediaId, stamp, () => true)).toBeNull();
    expect(childReads).toBe(0);

    const sparse = new Array(2);
    sparse[0] = sample.rich.nodes![0];
    expect(api.resolveRichImage(sample.root, { ...sample.rich, nodes: sparse }, forestId, forestMediaId, stamp, () => true)).toBeNull();
  });

  it('refuses hidden, shifted or duplicate DOM images rather than reusing an old image path', () => {
    const sample = fixture();
    sample.cards[0]!.setAttribute('aria-hidden', 'true');
    expect(resolveForest(sample)).toBeNull();
    sample.cards[0]!.removeAttribute('aria-hidden');
    sample.cards[0]!.before(document.createElement('span'));
    expect(resolveForest(sample)).toBeNull();
    sample.cards[0]!.previousElementSibling!.remove();
    sample.cards[0]!.after(sample.cards[0]!.cloneNode(true));
    expect(resolveForest(sample)).toBeNull();
  });

  it('refuses a changed stamp, turn, assistant row, or disconnected original root', () => {
    const sample = fixture();
    sample.root.setAttribute('data-clf-fiber-rich', `old:${stamp}`);
    expect(resolveForest(sample)).toBeNull();
    sample.root.setAttribute('data-clf-fiber-rich', stamp);
    sample.turn.setAttribute('data-clf-fiber-turn', 'scan-two:0');
    expect(resolveForest(sample)).toBeNull();
    sample.turn.setAttribute('data-clf-fiber-turn', 'scan-one:0');
    const duplicateRow = sample.row.cloneNode(true) as HTMLElement;
    sample.turn.append(duplicateRow);
    expect(resolveForest(sample)).toBeNull();
    duplicateRow.remove();
    sample.root.remove();
    expect(resolveForest(sample)).toBeNull();
  });

  it('refuses a same-ID assistant row remounted during the synchronous image walk', () => {
    const sample = fixture();
    const originalStyle = dom.window.getComputedStyle.bind(dom.window);
    let remounted = false;
    dom.window.getComputedStyle = (element: Element) => {
      if (!remounted) {
        remounted = true;
        const replacement = sample.row.cloneNode(false) as HTMLElement;
        sample.row.after(replacement);
        replacement.append(sample.root);
        sample.row.remove();
      }
      return originalStyle(element);
    };
    expect(resolveForest(sample)).toBeNull();
    expect(remounted).toBe(true);
  });

  it('requires the caller-owned original document/SPA/recording witness after A→B→A', () => {
    const sample = fixture();
    let currentEpoch = 1;
    const originalEpoch = currentEpoch;
    const current = () => currentEpoch === originalEpoch;
    expect(resolveForest(sample, current)?.image).toBe(sample.cards[0]);
    currentEpoch++;
    dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    expect(resolveForest(sample, current)).toBeNull();
    dom.reconfigure({ url: `https://chatgpt.com/c/${conversationId}` });
    expect(resolveForest(sample, current)).toBeNull();
    expect(resolveForest(sample, () => false)).toBeNull();
  });

  // Source identity is NOT a URL comparison: a synchronous A→B→A cycle before a
  // MutationObserver callback must retire the original handle through takeRecords().
  function loadedForest() {
    const sample = fixture();
    const image = sample.cards[0]!;
    image.src = 'https://images.example.test/forest.webp';
    Object.defineProperty(image, 'currentSrc', { configurable: true, get: () => image.src });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 80 },
      complete: { configurable: true, value: true }
    });
    // The image geometry is part of the previously validated semantic tree.
    sample.rich.nodes = api.captureRichRoot(sample.root);
    return sample;
  }
  const beginForest = (sample: ReturnType<typeof loadedForest>, current = () => true) =>
    api.beginRichImageSource(sample.root, sample.rich, forestId, forestMediaId, stamp, current);

  it('issues a bounded opaque stable witness with no URL or DOM reference and retires it on release', () => {
    const sample = loadedForest();
    const handle = beginForest(sample);
    expect(handle).not.toBeNull();
    const first = api.richImageSourceWitness(handle!);
    expect(first).toMatchObject({ sourceIncarnation: expect.stringMatching(/^src_[a-f0-9]{32}_[a-z0-9]{1,11}$/), sourceSequence: expect.any(Number) });
    expect(first!.sourceIncarnation.length).toBeLessThanOrEqual(64);
    expect(api.richImageSourceWitness(handle!)).toEqual(first);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(JSON.stringify(first)).not.toContain('images.example.test');
    expect(api.richImageSourceWitness({})).toBeNull();
    api.releaseRichImageSource(handle!);
    expect(api.richImageSourceWitness(handle!)).toBeNull();
    const next = beginForest(sample);
    expect(api.richImageSourceWitness(next!)!.sourceSequence).toBeGreaterThan(first!.sourceSequence);
    expect(api.richImageSourceWitness(next!)!.sourceIncarnation).not.toBe(first!.sourceIncarnation);
  });

  it('rejects synchronous src A→B→A before observer delivery and never revalidates the old token', () => {
    const sample = loadedForest();
    const handle = beginForest(sample)!;
    const old = api.richImageSourceWitness(handle)!;
    sample.cards[0]!.src = 'https://images.example.test/coast.webp';
    sample.cards[0]!.src = 'https://images.example.test/forest.webp';
    expect(api.richImageSourceWitness(handle)).toBeNull();
    expect(api.richImageSourceWitness(handle)).toBeNull();
    const next = beginForest(sample)!;
    expect(api.richImageSourceWitness(next)!.sourceSequence).toBeGreaterThan(old.sourceSequence);
    expect(api.richImageSourceWitness(next)!.sourceIncarnation).not.toBe(old.sourceIncarnation);
  });

  it('witnesses an incomplete exact IMG without pixels and reuses its incarnation after a separately stamped load', () => {
    const sample = loadedForest();
    const first = beginForest(sample)!;
    const old = api.richImageSourceWitness(first)!;
    const selectedBeforeReload = sample.cards[0]!.src;
    let currentSelection = selectedBeforeReload;
    Object.defineProperty(sample.cards[0], 'currentSrc', { configurable: true, get: () => currentSelection });
    sample.cards[0]!.src = 'https://images.example.test/second.webp';
    Object.defineProperty(sample.cards[0], 'complete', { configurable: true, value: false });
    expect(api.richImageSourceWitness(first)).toBeNull();
    const pending = api.beginPendingRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, stamp, () => true)!;
    const source = api.richImagePendingWitness(pending)!;
    expect(source.sourceSequence).toBeGreaterThan(old.sourceSequence);
    expect(JSON.stringify(source)).not.toContain('images.example.test');
    expect(api.richImageSourceWitness(pending)).toBeNull();
    sample.cards[0]!.dispatchEvent(new dom.window.Event('error'));
    expect(api.richImagePendingWitness(pending)).toEqual(source);
    Object.defineProperty(sample.cards[0], 'complete', { configurable: true, value: true });
    currentSelection = sample.cards[0]!.src;
    sample.turn.setAttribute('data-clf-fiber-turn', 'scan-two:0');
    const nextStamp = stamp.replace('scan-one', 'scan-two');
    sample.root.setAttribute('data-clf-fiber-rich', nextStamp);
    sample.rich.nodes = api.captureRichRoot(sample.root);
    expect(api.rebindLoadedRichImageSource(pending, sample.root, sample.rich, forestId,
      forestMediaId, nextStamp, () => true)).toBe(pending);
    expect(api.richImageSourceWitness(pending)).toEqual(source);
  });

  it('rejects an incomplete B witness after synchronous B→A→B, route loss, or changed image path', () => {
    const sample = loadedForest();
    const image = sample.cards[0]!;
    const first = image.src;
    image.src = 'https://images.example.test/second.webp';
    Object.defineProperty(image, 'complete', { configurable: true, value: false });
    const pending = api.beginPendingRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, stamp, () => true)!;
    image.src = first;
    image.src = 'https://images.example.test/second.webp';
    expect(api.richImagePendingWitness(pending)).toBeNull();
    const current = api.beginPendingRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, stamp, () => true)!;
    sample.cards[0]!.before(document.createElement('span'));
    expect(api.richImagePendingWitness(current)).toBeNull();
    sample.cards[0]!.previousElementSibling!.remove();
    let live = true;
    const routed = api.beginPendingRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, stamp, () => live)!;
    live = false;
    expect(api.richImagePendingWitness(routed)).toBeNull();
  });

  it('preserves a physical source through text-only rich restamps and retires synchronous A→B→A afterward', () => {
    const sample = loadedForest();
    const handle = beginForest(sample)!;
    const original = api.richImageSourceStable(handle)!;
    sample.cards[1]!.parentElement!.setAttribute('aria-label', 'Coast revised');
    const nextStamp = stamp.replace('scan-one', 'scan-two');
    sample.turn.setAttribute('data-clf-fiber-turn', 'scan-two:0');
    sample.root.setAttribute('data-clf-fiber-rich', nextStamp);
    sample.rich.nodes = api.captureRichRoot(sample.root);
    expect(api.richImageSourceStable(handle)).toEqual(original);
    // The old per-scan task remains stale even though the private physical source survives.
    expect(api.richImageSourceWitness(handle)).toBeNull();
    const current = api.beginRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, nextStamp, () => true)!;
    expect(api.richImageSourceStable(current)).not.toBeNull();
    sample.cards[0]!.src = 'https://images.example.test/second.webp';
    sample.cards[0]!.src = 'https://images.example.test/forest.webp';
    expect(api.richImageSourceStable(current)).toBeNull();
    const renewed = api.beginRichImageSource(sample.root, sample.rich, forestId,
      forestMediaId, nextStamp, () => true)!;
    expect(api.richImageSourceWitness(renewed)!.sourceSequence).toBeGreaterThan(original.sourceSequence);
  });

  it.each(['srcset', 'sizes', 'load', 'error'])('retires a witnessed source after %s even when the URL/dimensions agree', change => {
    const sample = loadedForest();
    const handle = beginForest(sample)!;
    expect(api.richImageSourceWitness(handle)).not.toBeNull();
    if (change === 'srcset' || change === 'sizes') {
      sample.cards[0]!.setAttribute(change, 'https://images.example.test/other.webp 2x');
      sample.cards[0]!.removeAttribute(change);
    } else sample.cards[0]!.dispatchEvent(new dom.window.Event(change));
    expect(api.richImageSourceWitness(handle)).toBeNull();
  });

  it('refuses responsive/picture, unloaded, missing currentSrc and a source change seen before returning to A', () => {
    const sample = loadedForest();
    const image = sample.cards[0]!;
    const originalSrc = image.src;
    image.setAttribute('srcset', `${originalSrc} 1x`);
    expect(beginForest(sample)).toBeNull();
    image.removeAttribute('srcset');
    const picture = document.createElement('picture');
    image.before(picture); picture.append(image);
    expect(beginForest(sample)).toBeNull();
    picture.before(image); picture.remove();
    Object.defineProperty(image, 'complete', { configurable: true, value: false });
    expect(beginForest(sample)).toBeNull();
    Object.defineProperty(image, 'complete', { configurable: true, value: true });
    let current = originalSrc;
    Object.defineProperty(image, 'currentSrc', { configurable: true, get: () => current });
    const handle = beginForest(sample)!;
    current = 'https://images.example.test/coast.webp';
    expect(api.richImageSourceWitness(handle)).toBeNull();
    current = originalSrc;
    expect(api.richImageSourceWitness(handle)).toBeNull();
    Object.defineProperty(image, 'currentSrc', { configurable: true, value: '' });
    expect(beginForest(sample)).toBeNull();
  });

  it('rejects synchronous IMG/root replacement and stale row even when identical IDs and URL reappear', () => {
    const sample = loadedForest();
    const old = beginForest(sample)!;
    const first = api.richImageSourceWitness(old)!;
    const replacement = sample.cards[0]!.cloneNode(true) as HTMLImageElement;
    sample.cards[0]!.replaceWith(replacement);
    replacement.replaceWith(sample.cards[0]!);
    expect(api.richImageSourceWitness(old)).toBeNull();
    const next = beginForest(sample)!;
    expect(api.richImageSourceWitness(next)!.sourceIncarnation).not.toBe(first.sourceIncarnation);
    const root = sample.root;
    const rootClone = root.cloneNode(true) as HTMLElement;
    root.replaceWith(rootClone); rootClone.replaceWith(root);
    expect(api.richImageSourceWitness(next)).toBeNull();
    const third = beginForest(sample)!;
    sample.row.remove(); sample.turn.append(sample.row);
    expect(api.richImageSourceWitness(third)).toBeNull();
  });

  it('refuses excess handles without evicting an already watched available source', () => {
    const sample = loadedForest();
    const surface = sample.root.querySelector('.puik-root')!;
    for (let index = 2; index < 42; index++) {
      const card = document.createElement('button');
      card.setAttribute('aria-label', `Picture ${index}`);
      const image = document.createElement('img');
      image.src = `https://images.example.test/picture-${index}.webp`;
      Object.defineProperties(image, {
        currentSrc: { configurable: true, get: () => image.src },
        naturalWidth: { configurable: true, value: 100 },
        naturalHeight: { configurable: true, value: 80 },
        complete: { configurable: true, value: true }
      });
      card.append(image); surface.append(card);
    }
    sample.rich.nodes = api.captureRichRoot(sample.root);
    const first = beginForest(sample)!;
    const sequence = api.richImageSourceWitness(first)!.sourceSequence;
    for (let index = 2; index < 42; index++) {
      const id = `n-0-${index}-0`;
      const handle = api.beginRichImageSource(sample.root, sample.rich, id, `media-${id}`, stamp, () => true);
      expect(handle).not.toBeNull();
    }
    // All 64 exact image slots fit; distinct short-lived scan leases still
    // obey the same document-wide cap instead of silently growing observers.
    for (let index = 0; index < 23; index++) {
      sample.rich = { ...sample.rich };
      expect(beginForest(sample)).not.toBeNull();
    }
    sample.rich = { ...sample.rich };
    expect(beginForest(sample)).toBeNull();
    expect(api.richImageSourceStable(first)).not.toBeNull();
    api.releaseRichImageSource(first);
    expect(api.richImageSourceWitness(beginForest(sample)!)!.sourceSequence).toBeGreaterThan(sequence);
  });
});

describe('inert generated-native tuple association to the same rich IMG', () => {
  const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const providerMessageId = '11111111-2222-4333-8444-555555555555';
  const messageId = 'thought:synthetic-exchange:synthetic-turn';
  const nativeMessageId = '99999999-2222-4333-8444-555555555555';
  const assetId = 'file_abcdefghijk123';
  const richStamp = `scan-one:0:${encodeURIComponent(messageId)}:${providerMessageId}`;
  const imageStamp = `scan-one:0:${nativeMessageId}:${assetId}`;
  const imageUrl = `https://chatgpt.com/backend-api/estuary/content?id=${assetId}`;

  function fixture() {
    dom.reconfigure({ url: `https://chatgpt.com/c/${conversationId}` });
    const turn = document.createElement('section');
    turn.dataset.testid = 'conversation-turn-0';
    turn.setAttribute('data-clf-fiber-turn', 'scan-one:0');
    const row = document.createElement('div');
    row.setAttribute('data-message-author-role', 'assistant');
    row.setAttribute('data-message-id', providerMessageId);
    const root = document.createElement('div');
    root.setAttribute('data-clf-fiber-rich', richStamp);
    const surface = document.createElement('div');
    surface.className = 'puik-root not-prose not-markdown';
    const first = document.createElement('img'); first.alt = 'Generated forest';
    first.src = imageUrl; first.setAttribute('data-clf-fiber-image', imageStamp);
    Object.defineProperties(first, {
      currentSrc: { configurable: true, get: () => first.src },
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 80 },
      complete: { configurable: true, value: true }
    });
    // Exactly the generated-image IMG selector used by fiber.js; the stamp
    // is a fixture for its independently typed output, not URL inference here.
    const generated = document.createElement('div');
    generated.className = 'group/imagegen-image';
    generated.append(first);
    const sibling = document.createElement('img'); sibling.alt = 'Ordinary sibling'; sibling.src = imageUrl;
    surface.append(generated, sibling); root.append(surface); row.append(root); turn.append(row);
    document.body.append(turn);
    const nodes = api.captureRichRoot(root);
    expect(nodes).not.toBeNull();
    const rich = { version: 1, status: 'available', reason: null, conversationId, messageId,
      providerMessageId, revision: 1, accessibleText: 'Generated forest', nodes };
    const turns = [{ index: 0, conversationId, conversationConflict: false,
      images: [{ messageId: nativeMessageId, assetId }] }];
    // The source lease precedes any tested mutation; creating a new lease at
    // association time would erase an earlier same-object detach/reinsert.
    const sourceHandle = api.beginRichImageSource(root, rich, 'n-0-0-0',
      'media-n-0-0-0', richStamp, () => true);
    expect(sourceHandle).not.toBeNull();
    const resolve = (current = () => true, token = 'scan-one') => api.resolveRichNativeImage(
      root, rich, 'n-0-0-0', 'media-n-0-0-0', richStamp, token, turns, first, current, sourceHandle!);
    return { turn, row, root, first, sibling, rich, turns, sourceHandle: sourceHandle!, resolve };
  }

  it('associates only the physically identical rich IMG carrying a fresh, unique Fiber-typed tuple stamp', () => {
    const sample = fixture();
    expect(sample.root.querySelector('[class~="group/imagegen-image"] img')).toBe(sample.first);
    expect(sample.resolve()).toEqual({ root: sample.root, image: sample.first,
      messageId: nativeMessageId, assetId });
    expect(sample.resolve()?.image).not.toBe(sample.sibling);
    expect(Object.keys(sample.resolve()!)).toEqual(['root', 'image', 'messageId', 'assetId']);
  });

  it('refuses an unstamped rich IMG despite an identically sourced and correctly stamped foreign sibling', () => {
    const sample = fixture();
    sample.first.removeAttribute('data-clf-fiber-image');
    sample.sibling.setAttribute('data-clf-fiber-image', imageStamp);
    expect(sample.resolve()).toBeNull();
  });

  it('refuses a copied valid image stamp on an ordinary rich IMG lacking Fiber generated-image provenance', () => {
    const sample = fixture();
    // Styling alone changes nothing in the semantic tree or IMG/tuple/stamp/URL:
    // the old helper incorrectly accepted this forged stamped ordinary image.
    const generated = sample.first.parentElement!;
    generated.className = 'ordinary-rich-picture';
    expect(api.resolveRichImage(sample.root, sample.rich, 'n-0-0-0',
      'media-n-0-0-0', richStamp, () => true)?.image).toBe(sample.first);
    expect(sample.resolve()).toBeNull();
  });

  it('refuses synchronous same-IMG detach→reattach despite identical stamp, URL and current semantic tree', () => {
    const sample = fixture();
    const generated = sample.first.parentElement!;
    sample.first.remove();
    generated.append(sample.first);
    expect(api.resolveRichImage(sample.root, sample.rich, 'n-0-0-0',
      'media-n-0-0-0', richStamp, () => true)?.image).toBe(sample.first);
    expect(sample.resolve()).toBeNull();
    expect(api.richImageSourceStable(sample.sourceHandle)).toBeNull();
  });

  it('refuses duplicate typed asset owners, including a second turn, without guessing from matching URLs', () => {
    const sample = fixture();
    sample.turns[0]!.images.push({ messageId: nativeMessageId, assetId });
    expect(sample.resolve()).toBeNull();
    sample.turns[0]!.images.pop();
    sample.turns.push({ index: 1, conversationId, conversationConflict: false,
      images: [{ messageId: '88888888-2222-4333-8444-555555555555', assetId }] });
    expect(sample.resolve()).toBeNull();
  });

  it('rejects custom typed-frame iterators and accessor entries without executing caller code', () => {
    const iterated = fixture();
    let imageIteratorCalls = 0;
    Object.defineProperty(iterated.turns[0]!.images, Symbol.iterator, {
      value: function* () {
        imageIteratorCalls++;
        yield { messageId: nativeMessageId, assetId };
      }
    });
    expect(iterated.resolve()).toBeNull();
    expect(imageIteratorCalls).toBe(0);
    api.releaseRichImageSource(iterated.sourceHandle);
    iterated.turn.remove();

    const getter = fixture();
    let entryReads = 0;
    Object.defineProperty(getter.turns[0]!.images, '0', {
      configurable: true, enumerable: true,
      get() { entryReads++; return { messageId: nativeMessageId, assetId }; }
    });
    expect(getter.resolve()).toBeNull();
    expect(entryReads).toBe(0);
    api.releaseRichImageSource(getter.sourceHandle);
    getter.turn.remove();

    const turnIterator = fixture();
    let turnIteratorCalls = 0;
    Object.defineProperty(turnIterator.turns, Symbol.iterator, {
      value: function* () { turnIteratorCalls++; yield turnIterator.turns[0]!; }
    });
    expect(turnIterator.resolve()).toBeNull();
    expect(turnIteratorCalls).toBe(0);
  });

  it('refuses old currentSrc pixels when the same physical IMG has begun loading a new src', () => {
    const sample = fixture();
    const previous = sample.first.src;
    Object.defineProperty(sample.first, 'currentSrc', { configurable: true, value: previous });
    sample.first.src = 'https://chatgpt.com/backend-api/estuary/content?id=file_other123456';
    expect(sample.resolve()).toBeNull();
  });

  it('refuses stale scan/turn stamp, wrong source URL, foreign route and changed ownership callback', () => {
    const sample = fixture();
    expect(sample.resolve(() => true, 'scan-two')).toBeNull();
    sample.first.setAttribute('data-clf-fiber-image', imageStamp.replace('scan-one:', 'scan-two:'));
    expect(sample.resolve()).toBeNull();
    sample.first.setAttribute('data-clf-fiber-image', imageStamp);
    sample.first.src = 'https://chatgpt.com/backend-api/estuary/content?id=file_different123';
    expect(sample.resolve()).toBeNull();
    sample.first.src = `https://foreign.example/backend-api/estuary/content?id=${assetId}`;
    expect(sample.resolve()).toBeNull();
    sample.first.src = imageUrl;
    dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    expect(sample.resolve()).toBeNull();
    dom.reconfigure({ url: `https://chatgpt.com/c/${conversationId}` });
    expect(sample.resolve(() => false)).toBeNull();
  });

  it('refuses a rich IMG remounted after its semantic path was recorded', () => {
    const sample = fixture();
    const replacement = sample.first.cloneNode(true) as HTMLImageElement;
    sample.first.replaceWith(replacement);
    expect(sample.resolve()).toBeNull();
  });
});

function user(text: string) {
  const section = document.createElement('section');
  section.setAttribute('data-testid', 'conversation-turn-1');
  section.setAttribute('data-turn', 'user');
  section.setAttribute('data-turn-id', 'turn-one');
  const message = document.createElement('div');
  message.setAttribute('data-message-id', 'message-one');
  message.setAttribute('data-message-author-role', 'user');
  message.textContent = text;
  section.append(message); document.body.append(section);
}

describe('one native HTML edit for prepared text', () => {
  beforeEach(() => {
    document.execCommand = (command, _ui, value) => {
      const selection = document.getSelection();
      if (command !== 'insertHTML' || document.activeElement !== box || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const template = document.createElement('template');
      template.innerHTML = value || '';
      range.insertNode(template.content);
      return true;
    };
  });
  it('hands a 96000-character multiline frame to the editor once without native per-line editing', () => {
    const value = ('Literal <abc> & "quoted" instructions.\n\n').repeat(2600).slice(0, 96000);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    const events = vi.spyOn(document, 'dispatchEvent');
    const pasted = vi.fn(); box.addEventListener('paste', pasted);
    expect(api.insertPrompt(value, true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, expect.any(String));
    expect(events).not.toHaveBeenCalled();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.querySelectorAll('p')).toHaveLength(0);
    expect(box.querySelector('abc')).toBeNull();
    expect(box.innerHTML.replaceAll('<br>', '\n')).toContain('&lt;abc&gt;');
    expect(box.textContent!.replace(/\s/g, '')).toBe(value.replace(/\s/g, ''));
  });
  it('preserves an existing draft when native editing refuses it without falling back', () => {
    const nativeEdit = vi.fn(() => false); document.execCommand = nativeEdit;
    expect(api.insertPrompt('replacement', true)).toBe(false);
    expect(box.textContent).toBe('Exact app prompt');
    expect(nativeEdit).toHaveBeenCalledOnce();
  });
  it.each(['replace', 'append', 'empty'] as const)('uses the browser range for one %s edit even when a cold custom paste handler drops text', mode => {
    const original = mode === 'empty' ? '' : 'Original draft';
    box.textContent = original;
    const pasted = vi.fn((event: Event) => event.preventDefault());
    box.addEventListener('paste', pasted);
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('Replacement', mode === 'append' ? 'append' : true)).toBe(true);
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(pasted).not.toHaveBeenCalled();
    expect(box.textContent).toBe(mode === 'append' ? original + 'Replacement' : 'Replacement');
  });
  it('does not edit a host replaced while it takes focus', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    box.focus = () => box.replaceWith(box.cloneNode(true));
    expect(api.insertPrompt('Replacement', true)).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
    expect(document.getElementById('prompt-textarea')!.textContent).toBe('Exact app prompt');
  });
  it.each(['refused', 'modified', 'replaced', 'exception'])('reports only bounded predicate metadata for %s insertion', kind => {
    const secret = 'PRIVATE authored prompt';
    document.execCommand = () => {
      if (kind === 'refused') return false;
      if (kind === 'modified') box.textContent = 'Other text';
      if (kind === 'replaced') box.replaceWith(box.cloneNode(true));
      if (kind === 'exception') throw new Error(secret);
      return true;
    };
    const failure = vi.fn();
    expect(api.insertPrompt(secret, true, failure)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
    const reason = failure.mock.calls[0]![0];
    expect(reason).toBe({ refused: 'native_edit_rejected', modified: 'text_mismatch', replaced: 'editor_replaced', exception: 'insertion_exception' }[kind]);
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain('Other text');
  });
  it('restores an originally empty draft through one native inline edit', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('', true)).toBe(true);
    expect(box.textContent).toBe('');
    expect(nativeEdit).toHaveBeenCalledOnce();
    expect(nativeEdit).toHaveBeenCalledWith('insertHTML', false, '<br>');
  });
  it('refuses another draft before native editing', () => {
    const nativeEdit = vi.spyOn(document, 'execCommand');
    expect(api.insertPrompt('replacement')).toBe(false);
    expect(nativeEdit).not.toHaveBeenCalled();
  });
  it('retains the exact editor lease through paragraph normalization but rejects changed content and remounts', () => {
    box.textContent = 'First line\nSecond line';
    const draft = api.captureComposerDraft(box.textContent);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    expect(draft.current()).toBe(true);
    box.lastElementChild!.textContent = 'Different line';
    expect(draft.current()).toBe(false);
    box.innerHTML = '<p>First line</p><p>Second line</p>';
    box.replaceWith(box.cloneNode(true));
    expect(draft.current()).toBe(false);
    draft.dispose();
  });
});

describe('native Project entry readiness', () => {
  const entry = { id: 'g-p-11111111222233334444555555555555', sourceConversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const projectUrl = `https://chatgpt.com/g/${entry.id}-example/project`;
  function sourceLink() {
    dom.reconfigure({ url: `https://chatgpt.com/c/${entry.sourceConversationId}` });
    const header = document.createElement('header');
    header.innerHTML = `<a href="${projectUrl}"><span data-testid="project-folder-icon"></span>Project</a>`;
    document.body.prepend(header);
    return header.querySelector('a')!;
  }

  it('waits for the mounted source editor before spending its one native click', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry);
    // The native header can mount before its source chat. A premature click can be
    // swallowed while the provider is hydrating, leaving the one-click attempt spent.
    await Promise.resolve();
    expect(clicks).not.toHaveBeenCalled();
    link.addEventListener('click', () => {
      dom.reconfigure({ url: projectUrl });
      box.replaceWith(box.cloneNode(true));
    });
    document.querySelector('form')!.prepend(box);
    expect(await entered).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('gives the native transition its own deadline after source loading', async () => {
    const link = sourceLink();
    box.textContent = '';
    box.remove();
    let clicks = 0;
    link.addEventListener('click', event => {
      event.preventDefault(); clicks++;
      dom.window.setTimeout(() => {
        dom.reconfigure({ url: projectUrl });
        box.replaceWith(box.cloneNode(true));
      }, 2_000);
    });
    const entered = api.enterProject(entry);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(clicks).toBe(0);
    document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await entered).toBe(true);
    expect(clicks).toBe(1);
  });

  it.each(['missing', 'draft', 'cancelled', 'foreign-route'])('never clicks an unready or retired source: %s', async reason => {
    const link = sourceLink();
    box.textContent = reason === 'draft' ? 'Keep my draft' : '';
    box.remove();
    let current = true;
    const clicks = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicks);
    const entered = api.enterProject(entry, () => current);
    if (reason === 'cancelled') current = false;
    if (reason === 'foreign-route') dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-1111-4222-8333-444444444444' });
    if (reason !== 'missing') document.querySelector('form')!.prepend(box);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await entered).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    if (reason === 'draft') expect(box.textContent).toBe('Keep my draft');
  });
});

describe('one native Send and bounded acceptance observation', () => {
  it.each([false, true])('retires only the unchanged accepted composer text (new draft: %s)', async edited => {
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user('Exact app prompt');
      if (edited) box.textContent = 'My next unsent draft';
    });
    expect(await api.send()).toBe(true);
    expect(box.textContent).toBe(edited ? 'My next unsent draft' : '');
  });
  it('recognizes the live Stop answering composer-submit control without treating Start Voice as Stop', () => {
    button.dataset.testid = 'composer-submit-button'; button.setAttribute('aria-label', 'Stop answering');
    const clicked = vi.fn(); button.addEventListener('click', clicked);
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Start Voice');
    expect(api.stopGeneration(() => true)).toBe(false);
  });
  it.each(['Remove file:', 'Remove file 1:'])('recognizes %s attachment-only drafts before helper cleanup', (label) => {
    box.textContent = '';
    expect(api.hasComposerAttachments()).toBe(false);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', `${label} user.webp`);
    document.querySelector('form')!.append(tile);
    expect(api.hasComposerAttachments()).toBe(true);
    tile.remove();
    const upload = document.createElement('span'); upload.setAttribute('data-inline-file-uploading', '');
    document.querySelector('form')!.append(upload);
    expect(api.hasComposerAttachments()).toBe(true);
  });
  it('stops only a visible enabled native control while exact ownership remains current', () => {
    button.dataset.testid = 'stop-button';
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    expect(api.stopGeneration(() => false)).toBe(false);
    button.disabled = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.disabled = false; button.hidden = true;
    expect(api.stopGeneration(() => true)).toBe(false);
    button.hidden = false;
    let checks = 0;
    expect(api.stopGeneration(() => ++checks === 1)).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(api.stopGeneration(() => true)).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
  it('accepts a composer clear after the old 3-second deadline without sending twice', async () => {
    const clicks = vi.fn(() => dom.window.setTimeout(() => { box.textContent = ''; }, 3200));
    button.addEventListener('click', clicks);
    const result = api.send();
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(3100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('times out once after 30 seconds and never clicks a Send that stays disabled', async () => {
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ acceptanceTimeoutMs: Infinity });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
    button.disabled = true;
    const disabled = api.send();
    await vi.advanceTimersByTimeAsync(30000);
    expect(await disabled).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('allows fresh conversation assignment only with a new exact user message', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(true);
  });

  it('does not accept navigation to an unrelated conversation with an empty composer', async () => {
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
      box.textContent = ''; user('An unrelated user message');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('fails closed when target ownership is revoked before late acceptance', async () => {
    let current = true;
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result = api.send({ stillCurrent: () => current });
    current = false; box.textContent = '';
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('does not retarget an existing conversation even when the new page contains matching text', async () => {
    dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    button.addEventListener('click', () => {
      dom.reconfigure({ url: 'https://chatgpt.com/c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
      user('Exact app prompt');
    });
    expect(await api.send()).toBe(false);
  });

  it('does not confuse missing word boundaries with exact submitted text', async () => {
    box.textContent = 'a b';
    button.addEventListener('click', () => user('ab'));
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });

  it('preserves adjacent rich-editor paragraphs when matching the submitted message', async () => {
    box.innerHTML = '<p>first line</p><p>second line</p>';
    button.addEventListener('click', () => user('first line\nsecond line'));
    expect(await api.send()).toBe(true);
  });

  it('does not mistake a remounted historical message for the newly submitted prompt', async () => {
    user('Exact app prompt');
    button.addEventListener('click', () => {
      document.querySelector('section')!.remove();
      user('Exact app prompt');
    });
    const result = api.send({ acceptanceTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(false);
  });
});

describe('composer-owned controls and Send readiness', () => {
  it.each(['allowed', 'revoked', 'replaced', 'deadline'])('authorizes only a ready Send and rechecks after authorization (%s)', async state => {
    button.disabled = true;
    let release!: (allowed: boolean) => void;
    const authorize = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const clicks = vi.fn(() => { box.textContent = ''; });
    button.addEventListener('click', clicks);
    const sending = api.send({ beforeSend: authorize, acceptanceTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(authorize).not.toHaveBeenCalled();
    button.disabled = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    button.setAttribute('aria-label', 'Send prompt');
    if (state === 'replaced') button.replaceWith(button.cloneNode(true));
    if (state === 'deadline') await vi.advanceTimersByTimeAsync(2000);
    release(state !== 'revoked');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sending).toBe(state === 'allowed');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveBeenCalledTimes(state === 'allowed' ? 1 : 0);
  });

  it.each(['disabled', 'aria-disabled', 'unmounted'])('waits for the same draft and its %s Send control without synthetic Enter', async state => {
    const trailing = button.parentElement!;
    if (state === 'disabled') button.disabled = true;
    if (state === 'aria-disabled') button.setAttribute('aria-disabled', 'true');
    if (state === 'unmounted') button.remove();
    const clicks = vi.fn(() => { box.textContent = ''; });
    const keys = vi.fn();
    button.addEventListener('click', clicks); box.addEventListener('keydown', keys);
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    button.disabled = false; button.removeAttribute('aria-disabled'); trailing.append(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['draft', 'editor', 'route', 'authority', 'other-generation'])('revokes a waiting Send when its %s changes', async reason => {
    button.remove();
    const keys = vi.fn(); box.addEventListener('keydown', keys);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    let current = true;
    const result = api.send({ acceptanceTimeoutMs: 2000, stillCurrent: () => current });
    await vi.advanceTimersByTimeAsync(50);
    if (reason === 'draft') box.textContent = 'A newer user draft';
    if (reason === 'editor') box.replaceWith(box.cloneNode(true));
    if (reason === 'route') dom.reconfigure({ url: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    if (reason === 'authority') current = false;
    if (reason === 'other-generation') {
      const stop = document.createElement('button'); stop.dataset.testid = 'stop-button';
      document.querySelector('form')!.append(stop);
    }
    document.querySelector('form')!.append(button);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'inert', 'transcript', 'other-form'])('does not let a %s Stop control block this composer', async place => {
    const stale = document.createElement('button'); stale.dataset.testid = 'stop-button';
    const host = document.createElement(place === 'other-form' ? 'form' : 'section');
    if (place === 'hidden') host.hidden = true;
    if (place === 'inert') host.setAttribute('inert', '');
    if (place === 'transcript') host.dataset.testid = 'conversation-turn-100';
    host.append(stale);
    if (place === 'hidden' || place === 'inert') document.querySelector('form')!.prepend(host);
    else document.body.prepend(host);
    expect(api.generating()).toBe(false);
    button.addEventListener('click', () => { box.textContent = ''; });
    expect(await api.send()).toBe(true);
  });

  it('uses only the visible Send in the current form and never a quoted or hidden control', async () => {
    const stale = button.cloneNode(true) as HTMLButtonElement;
    stale.hidden = true; button.parentElement!.prepend(stale);
    const quote = document.createElement('section'); quote.dataset.testid = 'conversation-turn-100';
    const quotedSend = button.cloneNode(true); quote.append(quotedSend); document.body.prepend(quote);
    const wrong = vi.fn(); stale.addEventListener('click', wrong); quotedSend.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBe(button);
    expect(await api.send()).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });

  it('does not guess between two visible Send controls while the composer is remounting', async () => {
    const duplicate = button.cloneNode(true) as HTMLButtonElement;
    button.parentElement!.append(duplicate);
    const wrong = vi.fn(); duplicate.addEventListener('click', wrong);
    const clicks = vi.fn(() => { box.textContent = ''; }); button.addEventListener('click', clicks);
    expect(api.sendButton()).toBeNull();
    const result = api.send({ acceptanceTimeoutMs: 2000 });
    expect(clicks).not.toHaveBeenCalled();
    duplicate.remove(); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(wrong).not.toHaveBeenCalled();
  });
});

function upload() {
  const input = document.createElement('input');
  input.id = 'upload-photos'; input.type = 'file'; input.accept = 'image/*';
  Object.defineProperty(input, 'files', { writable: true, value: [] });
  document.querySelector('form')!.append(input);
  class Transfer {
    files: File[] = [];
    items = { add: (file: File) => { this.files.push(file); } };
  }
  Object.defineProperty(dom.window, 'DataTransfer', { value: Transfer });
  return input;
}
describe('native image readiness', () => {
  it.each(['rename', 'replacement', 'extra file', 'cancel'])('retains exact image upload nodes across %s while processing', async change => {
    const input = upload();
    const tile = document.createElement('button');
    tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    let current = true;
    input.addEventListener('change', () => {
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current);
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'rename') tile.setAttribute('aria-label', 'Remove file 1: app(1).webp');
    if (change === 'replacement') tile.replaceWith(tile.cloneNode(true));
    if (change === 'extra file') tile.after(tile.cloneNode(true));
    if (change === 'cancel') current = false;
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await uploaded).toBe(change === 'rename');
  });
  it('waits for ARIA-only Send readiness after an attachment tile appears', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      const tile = document.createElement('button');
      tile.setAttribute('aria-label', 'Remove file 1: app.webp');
      document.querySelector('form')!.append(tile);
      button.setAttribute('aria-disabled', 'true');
    });
    const uploaded = api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let ready = false; void uploaded.then(value => { ready = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
    expect(ready).toBe(false);
    button.setAttribute('aria-disabled', 'false');
    await vi.advanceTimersByTimeAsync(0);
    expect(await uploaded).toBe(true);
  });
  it('uploads original Markdown bytes and recognizes localized native file actions without duplicate tiles', async () => {
    const input = upload(); input.id = 'upload-files'; input.accept = '';
    const draft = api.captureComposerDraft('Exact app prompt');
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    input.addEventListener('change', () => {
      const tile = document.createElement('div'); tile.setAttribute('role', 'group'); tile.setAttribute('aria-label', 'Notes.md');
      tile.innerHTML = '<div data-default-action="true"><button aria-label="Notes.md"></button></div><button aria-label="删除文件 1: Notes.md"></button>';
      tile.lastElementChild!.addEventListener('click', () => tile.remove());
      document.querySelector('form')!.append(tile);
    });
    const file = new dom.window.File(['# exact markdown'], 'Notes.md', { type: 'text/markdown' });
    expect(await api.uploadImages([], () => true, draft, [file])).toBe(true);
    expect(input.files?.[0]).toBe(file);
    expect(api.hasComposerAttachments()).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(api.hasComposerAttachments()).toBe(false); draft.dispose();
  });
  it('withdraws only the exact prepared app text and ready attachment nodes before Send', async () => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    const draft = api.captureComposerDraft('Exact app prompt');
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    tile.addEventListener('click', () => tile.remove());
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => true, draft)).toBe(true);
    expect(await draft.clear()).toBe(true);
    expect(tile.isConnected).toBe(false); expect(box.textContent).toBe(''); draft.dispose();
  });
  it.each(['edited text', 'extra attachment', 'replacement attachment', 'navigation'])('preserves the entire draft after %s breaks exact ownership', async reason => {
    const input = upload();
    document.execCommand = command => { if (command === 'delete') box.replaceChildren(); return true; };
    let current = true;
    const draft = api.captureComposerDraft('Exact app prompt', () => current);
    const tile = document.createElement('button'); tile.type = 'button'; tile.setAttribute('aria-label', 'Remove file 1: app.webp');
    const removed = vi.fn(); tile.addEventListener('click', removed);
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }], () => current, draft)).toBe(true);
    if (reason === 'edited text') box.textContent += ' user change';
    if (reason === 'extra attachment') tile.after(tile.cloneNode(true));
    if (reason === 'replacement attachment') tile.replaceWith(tile.cloneNode(true));
    if (reason === 'navigation') current = false;
    expect(await draft.clear()).toBe(false);
    expect(removed).not.toHaveBeenCalled(); expect(box.textContent).not.toBe(''); draft.dispose();
  });
  it.each(['Remove file:', 'Remove file 1:'])('waits for matching %s attachment and upload completion before Send', async (label) => {
    const input = upload();
    const tile = document.createElement('button'); tile.type = 'button';
    tile.setAttribute('aria-label', `${label} example.webp`); tile.setAttribute('aria-busy', 'true');
    input.addEventListener('change', () => document.querySelector('form')!.append(tile));
    const result = api.uploadImages([{ name: 'example.webp', dataUrl: 'data:image/webp;base64,YQ==' }]);
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.removeAttribute('aria-busy');
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });

  it('rejects invalid attachments before changing the native file input', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    expect(await api.uploadImages([{ name: 'bad.webp', dataUrl: 'data:image/png;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not add app images to an existing attachment-only draft', async () => {
    const input = upload(); const changed = vi.fn(); input.addEventListener('change', changed);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: personal.webp');
    document.querySelector('form')!.append(tile);
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(tile.isConnected).toBe(true);
  });

  it('refuses extra attachments added while the requested upload is completing', async () => {
    const input = upload();
    input.addEventListener('change', () => {
      for (const name of ['app.webp', 'personal.webp']) {
        const tile = document.createElement('button'); tile.setAttribute('aria-label', `Remove file: ${name}`);
        document.querySelector('form')!.append(tile);
      }
    });
    expect(await api.uploadImages([{ name: 'app.webp', dataUrl: 'data:image/webp;base64,YQ==' }])).toBe(false);
    expect(document.querySelectorAll('[aria-label^="Remove file:"]')).toHaveLength(2);
  });

  it('requires distinct new tiles with exact filenames rather than substring matches', async () => {
    const input = upload();
    const form = document.querySelector('form')!;
    const old = document.createElement('button'); old.setAttribute('aria-label', 'Other action'); form.append(old);
    const tile = document.createElement('button'); tile.setAttribute('aria-label', 'Remove file: data.webp');
    input.addEventListener('change', () => form.append(tile));
    const result = api.uploadImages(Array.from({ length: 2 }, () => ({ name: 'a.webp', dataUrl: 'data:image/webp;base64,YQ==' })));
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    tile.setAttribute('aria-label', 'Remove file: a.webp');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const second = document.createElement('button'); second.setAttribute('aria-label', 'Remove file: a.webp'); form.append(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
  });
});


describe('provider limit notice', () => {
  it('records and acknowledges the exact Korean access notice once without accepting other dialogs', () => {
    const notice = document.createElement('div'); notice.setAttribute('role', 'dialog');
    notice.innerHTML = '<h2>요청이 너무 많습니다</h2><p>요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.</p><button>알겠습니다</button>';
    document.body.append(notice);
    const click = vi.fn(); notice.querySelector('button')!.addEventListener('click', click);
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false })]);
    expect(click).toHaveBeenCalledTimes(1);
    api.errors(); expect(click).toHaveBeenCalledTimes(1);
    const unrelated = notice.cloneNode(true) as HTMLElement;
    unrelated.querySelector('h2')!.textContent = 'Permission required';
    const accept = vi.fn(); unrelated.querySelector('button')!.addEventListener('click', accept);
    document.body.append(unrelated); api.errors(); expect(accept).not.toHaveBeenCalled();
    const hidden = notice.cloneNode(true) as HTMLElement; hidden.setAttribute('aria-hidden', 'true');
    hidden.querySelector('button')!.addEventListener('click', accept); document.body.append(hidden);
    api.errors(); expect(accept).not.toHaveBeenCalled();
  });
  it('recognizes only the visible provider access-limit dialog as a blocking nontransport error', () => {
    const notice = document.createElement('div');
    notice.innerHTML = '<h2>Too many requests</h2><p>We have temporarily limited access to conversations to protect your data. Please wait a few minutes.</p>';
    document.body.append(notice);
    expect(api.errors()).toEqual([]);
    notice.setAttribute('role', 'dialog');
    expect(api.errors()).toEqual([expect.objectContaining({ blocking: true, recoverable: false, text: expect.stringContaining('Too many requests') })]);
    notice.querySelector('p')!.setAttribute('role', 'alert');
    expect(api.errors()).toHaveLength(1);
    notice.setAttribute('aria-hidden', 'true'); expect(api.errors()).toEqual([]);
    notice.querySelector('p')!.removeAttribute('role');
    notice.removeAttribute('aria-hidden'); notice.querySelector('p')!.textContent = 'An article about rate limits';
    expect(api.errors()).toEqual([]);
  });
});

describe('rendered temporary-chat state independent of language', () => {
  function toggle(label: string, checked: boolean) {
    const control = document.createElement('button');
    control.setAttribute('aria-label', label);
    control.innerHTML = `<svg style="opacity:${checked ? 0 : 1}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp"></use></svg><svg aria-hidden="true" style="opacity:${checked ? 1 : 0}"><use href="/cdn/assets/sprites-shell-anyhash.svg#chat-temp-checked"></use></svg>`;
    document.body.append(control);
    return control;
  }
  it.each(['Temporären Chat ausschalten', '一時チャットをオフにする', 'Turn off temporary chat', ''])('reads the checked glyph with arbitrary label %s', label => {
    toggle(label, true);
    expect(api.temporaryChatReady()).toBe(true);
  });
  it('does not mistake a hidden checked glyph, English wording or URL intent for active mode', () => {
    dom.reconfigure({ url: 'https://chatgpt.com/?temporary-chat=true' });
    toggle('Turn off temporary chat', false);
    expect(api.temporaryChatReady()).toBe(false);
  });
  it('rejects a hidden toolbar or a glyph quoted in assistant content', () => {
    const control = toggle('arbitrary', true);
    control.hidden = true;
    expect(api.temporaryChatReady()).toBe(false);
    control.hidden = false;
    const authored = document.createElement('div'); authored.setAttribute('data-message-author-role', 'assistant');
    document.body.append(authored); authored.append(control);
    expect(api.temporaryChatReady()).toBe(false);
  });
});


describe('locale-independent provider composer evidence', () => {
  it.each([['ja', '送信', '回答を停止'], ['ar', 'إرسال', 'إيقاف الإجابة']])('uses provider Send and Stop identities in %s', (language, sendLabel, stopLabel) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.setAttribute('aria-label', sendLabel);
    button.textContent = sendLabel;
    expect(api.sendButton()).toBe(button);
    expect(api.generating()).toBe(false);
    button.dataset.testid = 'stop-button';
    button.id = 'composer-submit-button';
    button.setAttribute('aria-label', stopLabel);
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(true);
    expect(api.stopGeneration(() => true)).toBe(true);
  });

  it.each([['ja', '音声入力'], ['ar', 'إملاء']])('anchors to the provider microphone glyph in %s', (language, label) => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    button.removeAttribute('data-testid'); button.setAttribute('aria-label', label);
    button.id = 'composer-submit-button';
    button.innerHTML = '<svg><use href="#microphone-regular-24"></use></svg>';
    const trailing = button.parentElement!;
    // The observed grid area survives even when no test id names its action row.
    trailing.removeAttribute('data-testid'); trailing.className = '[grid-area:trailing]';
    expect(api.composerActions()).toEqual({ host: trailing, before: button });
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
    expect(api.stopGeneration(() => true)).toBe(false);
  });

  it('does not anchor to a microphone glyph in prose or an unrelated composer control', () => {
    button.parentElement!.removeAttribute('data-testid');
    button.removeAttribute('data-testid'); button.removeAttribute('aria-label');
    button.innerHTML = '<svg><use href="#microphone-regular-24"></use></svg>';
    const quote = document.createElement('section'); quote.setAttribute('data-testid', 'conversation-turn-1');
    quote.innerHTML = '<button><svg><use href="#microphone-regular-24"></use></svg></button>';
    document.body.prepend(quote);
    expect(api.composerActions()).toBeNull();
    expect(api.sendButton()).toBeNull();
    expect(api.generating()).toBe(false);
  });

  it.each(['画像.webp', 'صورة.webp'])('recognizes the provider attachment group independently of translated removal labels (%s)', name => {
    const group = document.createElement('div'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
    group.innerHTML = '<div data-default-action="true"><button type="button">開く</button></div><button aria-label="削除" type="button">×</button>';
    document.querySelector('form')!.append(group);
    expect(api.hasComposerAttachments()).toBe(true);
    group.querySelector('[data-default-action]')!.removeAttribute('data-default-action');
    expect(api.hasComposerAttachments()).toBe(false);
    group.firstElementChild!.setAttribute('data-default-action', 'true');
    group.append(group.lastElementChild!.cloneNode(true));
    expect(api.hasComposerAttachments()).toBe(false);
  });
});
