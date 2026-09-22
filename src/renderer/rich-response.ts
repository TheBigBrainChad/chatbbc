import { parseRichResponse, type RichNode, type RichResponse } from '../shared/rich-response.js';
import { mountStaticArtifact } from './static-artifact.js';
import type { RichMediaState } from '../shared/session.js';
import { isViewableRichImage, localDataUrl, openRichImageViewer } from './rich-image.js';

export type RichImageContext = {
  sessionId: string;
  media: readonly RichMediaState[];
  current: () => boolean;
  /** A fixed, main-verified manual history opener, not an action/Continue/retry. */
  openOriginal?: () => Promise<boolean>;
};

type ImageRender = RichImageContext & { rich: RichResponse; imageCounts: Map<string, number> };

/**
 * A rich answer can own 64 images. Never decode all resident history rows at once:
 * viewport admission, a four-reader limit, and a measured data-URL residency budget
 * keep image bytes separate from the transcript's text-only budget. An image that is
 * evicted remains available through its explicit, independently checked local viewer.
 */
const MAX_INLINE_READS = 4;
const INLINE_READ_TIMEOUT_MS = 12_000;
const MAX_INLINE_DATA_URL_CHARS = 24 * 1024 * 1024;
// Decoded RGBA surfaces have their own cost, even for highly compressible WebP.
const MAX_INLINE_DECODED_PIXELS = 8_000_000;
type InlinePreview = {
  slot: HTMLElement;
  current: () => boolean;
  read: () => Promise<void>;
  observer: IntersectionObserver | null;
  near: boolean;
  queued: boolean;
  reading: boolean;
  retired: boolean;
  image: HTMLImageElement | null;
  residentChars: number;
  pixelCost: number;
  lastChars: number;
  deferred: boolean;
  failures: number;
};

const inlinePreviews = new Set<InlinePreview>();
const inlineQueue: InlinePreview[] = [];
let inlineReads = 0;
// A timeout retires the UI request, not Electron's already-issued invoke. Never
// replace a hung native IPC with unlimited new physical invokes.
let inlineOutstandingIpc = 0;
let inlineResidentChars = 0;
let inlineResidentPixels = 0;
let inlineRemovalObserver: MutationObserver | null = null;
let deferredInlineScheduled = false;

function retryDeferredInlinePreviews(): void {
  if (deferredInlineScheduled) return;
  deferredInlineScheduled = true;
  void Promise.resolve().then(() => {
    deferredInlineScheduled = false;
    pruneInlinePreviews();
    let freeChars = MAX_INLINE_DATA_URL_CHARS - inlineResidentChars;
    let freePixels = MAX_INLINE_DECODED_PIXELS - inlineResidentPixels;
    // Budget-evicted visible slots receive another chance only when some other
    // preview actually frees capacity, not immediately (which would thrash).
    for (const state of inlinePreviews) {
      if (!state.deferred || !state.near || state.retired || !state.current() ||
          state.queued || state.reading || state.image ||
          state.lastChars > freeChars || state.pixelCost > freePixels) continue;
      state.deferred = false;
      freeChars -= state.lastChars;
      freePixels -= state.pixelCost;
      queueInlinePreview(state);
    }
  });
}

function evictInlinePreview(state: InlinePreview, forBudget = false): void {
  if (!state.image) return;
  state.image.removeAttribute('src');
  state.image.remove();
  state.image = null;
  inlineResidentChars -= state.residentChars;
  inlineResidentPixels -= state.pixelCost;
  state.residentChars = 0;
  state.deferred = forBudget && state.near;
  if (!forBudget) retryDeferredInlinePreviews();
}

function retireInlinePreview(state: InlinePreview): void {
  if (state.retired) return;
  state.retired = true;
  state.observer?.disconnect();
  evictInlinePreview(state);
  inlinePreviews.delete(state);
  const queued = inlineQueue.indexOf(state);
  if (queued !== -1) inlineQueue.splice(queued, 1);
  if (inlinePreviews.size === 0) {
    inlineRemovalObserver?.disconnect();
    inlineRemovalObserver = null;
  }
}

function pruneInlinePreviews(): void {
  for (const state of inlinePreviews) {
    if (!state.current()) retireInlinePreview(state);
  }
}

function reserveInlinePreview(state: InlinePreview, chars: number): boolean {
  pruneInlinePreviews();
  if (state.retired || chars > MAX_INLINE_DATA_URL_CHARS ||
      state.pixelCost > MAX_INLINE_DECODED_PIXELS) return false;
  // Prefer old images that have left the viewport; if the entire gallery fits on
  // screen, the oldest preview is released rather than exceeding the byte budget.
  while (inlineResidentChars + chars > MAX_INLINE_DATA_URL_CHARS ||
      inlineResidentPixels + state.pixelCost > MAX_INLINE_DECODED_PIXELS) {
    const victim = [...inlinePreviews].find(item => item !== state && item.image && !item.near) ??
      [...inlinePreviews].find(item => item !== state && item.image);
    if (!victim) return false;
    evictInlinePreview(victim, true);
  }
  return true;
}

function pumpInlinePreviews(): void {
  pruneInlinePreviews();
  while (inlineReads < MAX_INLINE_READS && inlineOutstandingIpc < MAX_INLINE_READS && inlineQueue.length) {
    const state = inlineQueue.shift()!;
    state.queued = false;
    if (state.retired || !state.current() || !state.near || state.image || state.reading) continue;
    state.reading = true;
    inlineReads++;
    void state.read().finally(() => {
      state.reading = false;
      inlineReads--;
      pumpInlinePreviews();
    });
  }
}

function queueInlinePreview(state: InlinePreview): void {
  if (state.retired || !state.near || !state.current() || state.image || state.reading ||
      state.queued || state.failures >= 2) return;
  state.queued = true;
  inlineQueue.push(state);
  pumpInlinePreviews();
}

function registerInlinePreview(state: InlinePreview): void {
  pruneInlinePreviews();
  inlinePreviews.add(state);
  if (!inlineRemovalObserver && typeof window.MutationObserver === 'function' && document.body) {
    inlineRemovalObserver = new window.MutationObserver(records => {
      if (records.some(record => record.removedNodes.length > 0)) pruneInlinePreviews();
    });
    inlineRemovalObserver.observe(document.body, { childList: true, subtree: true });
  }
  if (typeof window.IntersectionObserver !== 'function') {
    // jsdom has no viewport; still enforce the same concurrency and residency caps.
    state.near = true;
    queueInlinePreview(state);
    return;
  }
  state.observer = new window.IntersectionObserver(entries => {
    if (state.retired || !state.current()) { retireInlinePreview(state); return; }
    const entry = entries.find(item => item.target === state.slot);
    if (!entry) return;
    state.near = entry.isIntersecting;
    if (state.near) queueInlinePreview(state);
    else evictInlinePreview(state);
  }, { rootMargin: '256px' });
  state.observer.observe(state.slot);
}

/** IPC metadata is still untrusted presentation data: inspect own data descriptors once. */
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length ||
      keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) return null;
  const clean: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    clean[key] = descriptor.value;
  }
  return required.every(key => Object.hasOwn(clean, key)) ? clean : null;
}

const pageSourceToken = /^src_[a-f0-9]{32}_([0-9a-z]{1,11})$/;

/** Validate store-private PAGE custody without exposing it to presentation code. */
function validPageSource(value: unknown, requireWitness = false): boolean {
  const source = fields(value, ['slotVersion'], ['sequence', 'incarnation', 'recordingRevision']);
  if (!source || !Number.isSafeInteger(source.slotVersion) || (source.slotVersion as number) < 1 ||
      (source.slotVersion as number) >= Number.MAX_SAFE_INTEGER ||
      (requireWitness && (!Object.hasOwn(source, 'sequence') ||
        !Object.hasOwn(source, 'incarnation') || !Object.hasOwn(source, 'recordingRevision'))) ||
      (Object.hasOwn(source, 'incarnation') && !Object.hasOwn(source, 'sequence')) ||
      (Object.hasOwn(source, 'incarnation') && !Object.hasOwn(source, 'recordingRevision')) ||
      (Object.hasOwn(source, 'recordingRevision') && (!Number.isSafeInteger(source.recordingRevision) ||
        (source.recordingRevision as number) < 0)) ||
      (Object.hasOwn(source, 'sequence') && (!Number.isSafeInteger(source.sequence) ||
        (source.sequence as number) < 1))) return false;
  if (!Object.hasOwn(source, 'incarnation')) return true;
  if (typeof source.incarnation !== 'string') return false;
  const match = pageSourceToken.exec(source.incarnation);
  return Boolean(match && (source.sequence as number).toString(36) === match[1]);
}

/** Refuse the entire adjunct if any entry is malformed; a partial array cannot grant a viewer. */
function validatedMedia(value: unknown): RichMediaState[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 64 || Reflect.ownKeys(value).length !== length.value + 1) return null;
    const result: RichMediaState[] = [];
    const opaque = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9:_-]{1,190}$/i.test(id);
    for (let index = 0; index < length.value; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item?.enumerable || !('value' in item)) return null;
      const media = fields(item.value, ['mediaId', 'nodeId', 'source', 'status'],
        ['reason', 'previewWidth', 'previewHeight', 'asset', 'pageSource']);
      if (!media || !opaque(media.mediaId) || !opaque(media.nodeId)) return null;
      const source = fields(media.source, ['kind'], ['nodeId', 'providerMessageId', 'providerAssetId']);
      if (!source) return null;
      let cleanSource: RichMediaState['source'];
      if (source.kind === 'page' && Object.keys(source).length === 2 && opaque(source.nodeId)) {
        cleanSource = { kind: 'page', nodeId: source.nodeId };
      } else if (source.kind === 'native' && Object.keys(source).length === 3 &&
          typeof source.providerMessageId === 'string' && /^[a-z0-9-]{8,100}$/i.test(source.providerMessageId) &&
          opaque(source.providerAssetId)) {
        cleanSource = { kind: 'native', providerMessageId: source.providerMessageId, providerAssetId: source.providerAssetId };
      } else return null;
      if (Object.hasOwn(media, 'pageSource') &&
          (cleanSource.kind !== 'page' || !validPageSource(media.pageSource, media.status === 'available'))) return null;

      const clean: RichMediaState = { mediaId: media.mediaId, nodeId: media.nodeId,
        source: cleanSource, status: media.status as RichMediaState['status'] };
      if (media.status === 'available') {
        if (Object.hasOwn(media, 'reason')) return null;
        const asset = fields(media.asset, ['id', 'mimeType', 'bytes'], ['width', 'height']);
        if (!asset) return null;
        clean.previewWidth = media.previewWidth as number;
        clean.previewHeight = media.previewHeight as number;
        clean.asset = { id: asset.id as string, mimeType: asset.mimeType as string, bytes: asset.bytes as number,
          ...(Object.hasOwn(asset, 'width') ? { width: asset.width as number } : {}),
          ...(Object.hasOwn(asset, 'height') ? { height: asset.height as number } : {}) };
        if (!isViewableRichImage(clean)) return null;
      } else if (media.status === 'pending' || media.status === 'unavailable') {
        if (Object.hasOwn(media, 'asset') || Object.hasOwn(media, 'previewWidth') || Object.hasOwn(media, 'previewHeight')) return null;
        if (media.status === 'pending' ? Object.hasOwn(media, 'reason') && media.reason !== 'not_loaded' :
          !['not_loaded', 'unsupported', 'ambiguous', 'tainted', 'oversized', 'invalid', 'quota', 'removed'].includes(media.reason as string)) return null;
        if (Object.hasOwn(media, 'reason')) clean.reason = media.reason as RichMediaState['reason'];
      } else return null;
      result.push(clean);
    }
    return result;
  } catch { return null; }
}

function countImages(nodes: RichNode[], counts = new Map<string, number>()): Map<string, number> {
  for (const node of nodes) {
    if (node.kind === 'image') counts.set(node.mediaId, (counts.get(node.mediaId) ?? 0) + 1);
    else if (node.kind === 'group' || node.kind === 'control') countImages(node.children, counts);
  }
  return counts;
}

function imageLabel(media: RichMediaState | undefined): string {
  if (media?.status === 'pending') return 'Image preview is loading';
  switch (media?.reason) {
    case 'not_loaded': return 'Image preview is loading';
    case 'unsupported': return 'Image preview unavailable — unsupported source';
    case 'ambiguous': return 'Image preview unavailable — ambiguous source';
    case 'tainted': return 'Image preview unavailable — tainted pixels';
    case 'oversized': return 'Image preview unavailable — image exceeds the recording limit';
    case 'invalid': return 'Image preview unavailable — invalid pixels';
    case 'quota': return 'Image preview unavailable — recording storage is full';
    case 'removed': return 'Image removed from local storage';
    default: return 'Image preview unavailable';
  }
}

/** Canonical source is retained, but component syntax is never executed to recreate a UI. */
function renderUnavailableRichResponse(source: string, accessibleText = '', context?: RichImageContext): HTMLElement {
  const box = document.createElement('div');
  box.className = 'msg rich-response rich-unavailable';
  box.setAttribute('dir', 'auto');
  const explanation = document.createElement('p');
  explanation.className = 'rich-unavailable-label';
  explanation.textContent = 'Rich content unavailable — open original in ChatGPT';
  const disclosure = document.createElement('details');
  disclosure.className = 'rich-source';
  disclosure.dataset.richNodeId = 'unavailable-source';
  const summary = document.createElement('summary');
  summary.textContent = 'Show original response source';
  const raw = document.createElement('pre');
  raw.setAttribute('dir', 'auto');
  raw.textContent = source;
  disclosure.append(summary, raw);
  box.append(explanation);
  if (accessibleText.trim()) {
    const visible = document.createElement('p');
    visible.className = 'rich-accessible-summary';
    visible.setAttribute('dir', 'auto');
    visible.textContent = accessibleText;
    box.append(visible);
  }
  box.append(disclosure);
  appendManualOriginal(box, context);
  return box;
}

/** Only the app-owned direct button's actual trusted click may request history navigation. */
function appendManualOriginal(box: HTMLElement, context?: RichImageContext): void {
  if (!context?.openOriginal) return;
  const button = document.createElement('button');
  button.className = 'rich-open-original';
  button.type = 'button';
  button.textContent = 'Open original in ChatGPT';
  const feedback = document.createElement('span');
  feedback.className = 'rich-original-feedback';
  feedback.setAttribute('role', 'status');
  button.addEventListener('click', event => {
    if (!event.isTrusted || !context.current() || !button.isConnected || button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    // A renderer-supplied conversation id, synthetic click, history load or timed
    // hydration can never reach this fixed callback. Main derives the URL from disk.
    void (async () => {
      let opened = false;
      try { opened = await context.openOriginal!(); } catch { /* No claimed browser open. */ }
      if (!context.current() || !button.isConnected) return;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      feedback.textContent = opened ? 'Original chat opened in your browser' :
        'Original chat could not be opened';
    })();
  });
  box.append(button, feedback);
}

/** Presentation only: a visually recognizable control is NOT native-action authority. */
function renderControl(node: Extract<RichNode, { kind: 'control' }>, images?: ImageRender): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'rich-control';
  wrapper.dataset.richNodeId = node.id;
  wrapper.tabIndex = 0;
  wrapper.setAttribute('aria-disabled', 'true');

  if (node.control === 'choice' || node.control === 'radio' || node.control === 'checkbox') {
    wrapper.classList.add('rich-selectable');
    wrapper.setAttribute('role', node.control === 'checkbox' ? 'checkbox' : 'radio');
    wrapper.setAttribute('aria-checked', String(node.selected));
    if (node.selected) wrapper.classList.add('is-selected');
    wrapper.dataset.richControl = node.id;
    const label = document.createElement('span');
    label.textContent = node.label;
    wrapper.append(label);
    if (node.selected) {
      const state = document.createElement('small');
      state.className = 'rich-control-state';
      state.textContent = 'Selected when recorded';
      wrapper.append(state);
    }
  } else {
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-label', `${node.label} — unavailable in this recording`);
    if (node.control === 'continue' || node.control === 'button') {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = true;
      button.tabIndex = -1;
      button.setAttribute('aria-disabled', 'true');
      button.dataset.richControl = node.id;
      button.textContent = node.label;
      wrapper.append(button);
    } else if (node.control === 'input') {
      const label = document.createElement('label');
      label.textContent = node.label;
      const input = document.createElement('input');
      input.disabled = true;
      input.tabIndex = -1;
      input.setAttribute('aria-disabled', 'true');
      input.dataset.richControl = node.id;
      input.value = node.value ?? '';
      label.append(input);
      wrapper.append(label);
    } else if (node.control === 'select') {
      const label = document.createElement('label');
      label.textContent = node.label;
      const select = document.createElement('select');
      select.disabled = true;
      select.tabIndex = -1;
      select.setAttribute('aria-disabled', 'true');
      select.dataset.richControl = node.id;
      // No options are invented: this schema describes the selected value, not the option list.
      const value = document.createElement('option');
      value.textContent = node.value ?? 'Unavailable';
      select.append(value);
      label.append(select);
      wrapper.append(label);
    } else {
      // A recorded link has no verified destination. Never create an <a> or href.
      const label = document.createElement('span');
      label.dataset.richControl = node.id;
      label.textContent = node.label;
      wrapper.append(label);
    }
  }
  for (const child of node.children) wrapper.append(renderNode(child, images));
  return wrapper;
}

/** The schema carries row groups, not arbitrary HTML tables or unverified heading cells. */
function renderTableRow(node: RichNode, images?: ImageRender): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rich-table-row';
  row.setAttribute('role', 'row');
  if (node.kind === 'group' && node.layout === 'row') row.dataset.richNodeId = node.id;
  const cells = node.kind === 'group' && node.layout === 'row' ? node.children : [node];
  for (const entry of cells) {
    const cell = document.createElement('div');
    cell.className = 'rich-table-cell';
    cell.setAttribute('role', 'cell');
    cell.append(renderNode(entry, images));
    row.append(cell);
  }
  return row;
}

function renderNode(node: RichNode, images?: ImageRender): HTMLElement {
  if (node.kind === 'text') {
    const tag = node.style === 'heading' ? 'h3' : node.style === 'code' ? 'pre' : 'p';
    const element = document.createElement(tag);
    element.className = `rich-${node.style}`;
    element.dataset.richNodeId = node.id;
    if (node.style === 'code') {
      element.setAttribute('dir', 'ltr');
      const code = document.createElement('code');
      code.textContent = node.text;
      element.append(code);
    } else {
      element.setAttribute('dir', 'auto');
      element.textContent = node.text;
    }
    return element;
  }
  if (node.kind === 'image') {
    const slot = document.createElement('div');
    slot.className = 'rich-image-slot';
    slot.dataset.richNodeId = node.id;
    if (node.width !== null && node.height !== null) slot.style.aspectRatio = `${node.width} / ${node.height}`;
    const candidates = images?.media.filter(media => media.mediaId === node.mediaId) ?? [];
    const media = candidates.length === 1 && images?.imageCounts.get(node.mediaId) === 1 &&
      candidates[0]!.nodeId === node.id &&
      (candidates[0]!.source.kind === 'page' && candidates[0]!.source.nodeId === node.id ||
        candidates[0]!.source.kind === 'native' &&
        candidates[0]!.source.providerMessageId === images.rich.providerMessageId && !!images.rich.providerMessageId)
      ? candidates[0] : undefined;
    const labelText = media && isViewableRichImage(media) ? 'Saved preview' : imageLabel(media);
    const label = document.createElement('span');
    label.textContent = node.alt ? `${node.alt} — ${labelText}` : labelText;
    slot.append(label);
    if (media && images && isViewableRichImage(media)) {
      slot.setAttribute('role', 'group');
      slot.setAttribute('aria-label', node.alt || 'Saved image preview');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'View saved preview';
      slot.append(button);
      const current = () => images.current() && slot.isConnected && button.isConnected;
      let inlineState: InlinePreview | null = null;
      // The fixed main-process reader checks asset membership and decodes the saved preview.
      // Never use authored URLs; offscreen images do not consume preview memory, and an
      // obsolete selection cannot paint on a later A→B→A visit.
      void (async () => {
        await Promise.resolve(); // The caller attaches the freshly rendered row synchronously.
        if (!current()) return;
        const state: InlinePreview = {
          slot, current, observer: null, near: false, queued: false, reading: false,
          retired: false, image: null, residentChars: 0,
          pixelCost: media.previewWidth! * media.previewHeight!, lastChars: 0,
          deferred: false, failures: 0,
          read: async () => {
            let data: unknown = null;
            let readerUnavailable = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            try {
              const source = window.api.getSessionImage(images.sessionId, media.asset!.id);
              inlineOutstandingIpc++;
              // Observe *physical* completion separately from the UI deadline. The
              // timed-out invoke cannot be canceled by Promise.race; only its actual
              // settle frees backend capacity. Both paths are observed, no late paint.
              void source.then(() => {
                inlineOutstandingIpc--;
                pumpInlinePreviews();
              }, () => {
                inlineOutstandingIpc--;
                pumpInlinePreviews();
              });
              // Even a disconnected owner must eventually release the shared reader slot.
              // A late IPC reply after this deadline is discarded by Promise.race and
              // must never hydrate another message or gain retry/capture authority.
              const reply = await Promise.race([
                source,
                new Promise<null>(resolve => {
                  timeout = setTimeout(() => resolve(null), INLINE_READ_TIMEOUT_MS);
                })
              ]);
              if (reply?.ok) data = reply.data;
              else readerUnavailable = true;
            } catch { readerUnavailable = true; }
            finally { if (timeout !== null) clearTimeout(timeout); }
            if (state.retired || !state.near || !current()) return;
            if (readerUnavailable || data === null) {
              // A transport error or a temporarily missing local reader is not proof
              // the recorded asset was deleted. Keep the explicit viewer, allow one
              // more viewport re-entry, and never infer new capture authority.
              state.failures++;
              label.textContent = node.alt ? `${node.alt} — Saved preview could not load inline` :
                'Saved preview could not load inline';
              return;
            }
            if (!localDataUrl(data, media.asset!.mimeType)) {
              label.textContent = node.alt ? `${node.alt} — Image preview unavailable` : 'Image preview unavailable';
              button.remove();
              slot.setAttribute('role', 'img');
              slot.setAttribute('aria-label', label.textContent);
              retireInlinePreview(state);
              return;
            }
            if (!reserveInlinePreview(state, data.length)) return;
            const preview = document.createElement('img');
            preview.src = data;
            preview.alt = node.alt;
            label.textContent = node.alt ? `${node.alt} — Saved preview` : 'Saved preview';
            state.image = preview;
            state.residentChars = data.length;
            state.lastChars = data.length;
            state.deferred = false;
            inlineResidentChars += data.length;
            inlineResidentPixels += state.pixelCost;
            slot.insertBefore(preview, button);
          }
        };
        inlineState = state;
        registerInlinePreview(state);
      })();
      button.addEventListener('click', () => void openRichImageViewer(images.sessionId, media, node.alt, {
        trigger: button, current,
        unavailable: () => {
          if (!current()) return;
          // A failed explicit local read must retire any previously hydrated pixels
          // synchronously, even if MutationObserver is unavailable in an embedder.
          if (inlineState) retireInlinePreview(inlineState);
          label.textContent = node.alt ? `${node.alt} — Image preview unavailable` : 'Image preview unavailable';
          button.remove();
          slot.setAttribute('role', 'img');
          slot.setAttribute('aria-label', label.textContent);
        }
      }));
    } else {
      slot.setAttribute('role', 'img');
      slot.setAttribute('aria-label', label.textContent);
    }
    return slot;
  }
  if (node.kind === 'control') return renderControl(node, images);
  if (node.kind === 'artifact') {
    const card = document.createElement('article');
    card.className = 'rich-artifact';
    card.dataset.richNodeId = node.id;
    const title = document.createElement('h3');
    title.textContent = node.title;
    card.append(title);
    if (node.mode === 'static' && node.html) {
      const frameHost = document.createElement('div');
      mountStaticArtifact(frameHost, { html: node.html });
      card.append(frameHost);
    }
    return card;
  }

  const tag = node.layout === 'card' ? 'article' : node.layout === 'list' ? 'ul' : 'div';
  const group = document.createElement(tag);
  group.className = `rich-layout rich-${node.layout}`;
  group.dataset.richNodeId = node.id;
  if (node.layout === 'table' || node.layout === 'diagram') {
    group.tabIndex = 0;
    group.setAttribute('role', 'region');
    group.setAttribute('aria-label', node.layout === 'table' ? 'Rich table, scroll horizontally for more' : 'Rich diagram, scroll horizontally for more');
  }
  if (node.layout === 'table') {
    const table = document.createElement('div');
    table.className = 'rich-table-content';
    table.setAttribute('role', 'table');
    for (const child of node.children) table.append(renderTableRow(child, images));
    group.append(table);
    return group;
  }
  for (const child of node.children) {
    if (node.layout === 'list') {
      const item = document.createElement('li');
      item.append(renderNode(child, images));
      group.append(item);
    } else group.append(renderNode(child, images));
  }
  return group;
}

/** Strictly reparse the entire stored tree; malformed/partial data gets only source fallback. */
export function renderRichResponse(rich: RichResponse, fallback: string, media?: RichImageContext): HTMLElement {
  const clean = parseRichResponse(rich);
  if (!clean || clean.status !== 'available' || clean.nodes.length === 0)
    return renderUnavailableRichResponse(fallback, clean?.status === 'unavailable' ? clean.accessibleText : '', media);
  const box = document.createElement('div');
  box.className = 'msg rich-response';
  box.setAttribute('dir', 'auto');
  const safeMedia = media ? validatedMedia(media.media) : null;
  const images = media && safeMedia
    ? { sessionId: media.sessionId, current: media.current, media: safeMedia, rich: clean,
      imageCounts: countImages(clean.nodes) } : undefined;
  for (const node of clean.nodes) box.append(renderNode(node, images));
  appendManualOriginal(box, media);
  return box;
}
