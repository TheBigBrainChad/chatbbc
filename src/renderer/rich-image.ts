import type { RichMediaState } from '../shared/session.js';

/** The existing sessions:image reader fully decodes bytes and checks recorded asset membership. */
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 64 + Math.ceil(MAX_PREVIEW_BYTES / 3) * 4;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function isViewableRichImage(media: RichMediaState): boolean {
  const asset = media.asset;
  const width = media.previewWidth, height = media.previewHeight;
  return media.status === 'available' && media.reason === undefined && !!asset &&
    /^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/.test(asset.id) && IMAGE_MIMES.has(asset.mimeType) &&
    Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= MAX_PREVIEW_BYTES &&
    Number.isSafeInteger(width) && width! > 0 && width! <= 1600 &&
    Number.isSafeInteger(height) && height! > 0 && height! <= 1600 && width! * height! <= 2_560_000 &&
    (asset.width === undefined || asset.width === width) &&
    (asset.height === undefined || asset.height === height);
}

export type RichImageViewerOwner = {
  trigger: HTMLButtonElement;
  /** Exact selected session, canonical row and rich revision must still own this click. */
  current: () => boolean;
  unavailable: () => void;
};

type Viewer = { owner: RichImageViewerOwner; dialog: HTMLDialogElement | null };
let active: Viewer | null = null;

function closeViewer(viewer: Viewer, restoreFocus: boolean): void {
  if (active !== viewer) return;
  active = null;
  const dialog = viewer.dialog;
  if (dialog) {
    if (dialog.open) dialog.close();
    dialog.remove();
  }
  if (restoreFocus && viewer.owner.current() && viewer.owner.trigger.isConnected) {
    viewer.owner.trigger.focus({ preventScroll: true });
  }
}

/** Retire an in-flight read or visible dialog when selection, revision or cleanup changes. */
export function retireRichImageViewer(): void {
  if (active) closeViewer(active, false);
}

/** A revision to another assistant row cannot retire this viewer's unrelated image. */
export function retireRichImageViewerWithin(row: HTMLElement): void {
  if (active && row.contains(active.owner.trigger)) closeViewer(active, false);
}

/** A timeline eviction or changed owner detaches its trigger without retaining the modal. */
export function retireStaleRichImageViewer(): void {
  if (active && (!active.owner.current() || !active.owner.trigger.isConnected)) closeViewer(active, false);
}

function localDataUrl(value: unknown, mimeType: string): value is string {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_LENGTH) return false;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return !!match && match[1] === mimeType && match[2]!.length % 4 === 0;
}

/**
 * Viewer only: it never opens ChatGPT, fetches a URL, retries capture or grants browser input.
 * Assistant-rich membership is not enabled yet; a synthetic available record alone cannot
 * make an assistant-only asset readable through the fixed main-process getter.
 */
export async function openRichImageViewer(
  sessionId: string, media: RichMediaState, alt: string, owner: RichImageViewerOwner
): Promise<void> {
  if (active || !isViewableRichImage(media) || !owner.current() || !owner.trigger.isConnected) return;
  const assetId = media.asset!.id;
  const mimeType = media.asset!.mimeType;
  const width = media.previewWidth!, height = media.previewHeight!;
  const viewer: Viewer = { owner, dialog: null };
  active = viewer;
  let data: unknown;
  try {
    const reply = await window.api.getSessionImage(sessionId, assetId);
    data = reply.ok ? reply.data : null;
  } catch { data = null; }
  if (active !== viewer) return;
  if (!owner.current() || !owner.trigger.isConnected) { closeViewer(viewer, false); return; }
  if (!localDataUrl(data, mimeType)) {
    closeViewer(viewer, false);
    owner.unavailable();
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'rich-image-viewer';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Saved preview');
  dialog.style.setProperty('--rich-preview-width', `${width}px`);
  dialog.style.setProperty('--rich-preview-height', `${height}px`);
  const title = document.createElement('h2');
  title.textContent = 'Saved preview';
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Close';
  const picture = document.createElement('img');
  picture.src = data;
  picture.alt = alt;
  const caption = document.createElement('p');
  caption.textContent = `Saved preview · ${width} × ${height} px`;
  dialog.append(title, close, picture, caption);
  close.addEventListener('click', () => closeViewer(viewer, true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(viewer, true); });
  dialog.addEventListener('click', event => { if (event.target === dialog) closeViewer(viewer, true); });
  dialog.addEventListener('close', () => closeViewer(viewer, true));
  viewer.dialog = dialog;
  document.body.append(dialog);
  try {
    dialog.showModal();
    close.focus({ preventScroll: true });
  } catch {
    closeViewer(viewer, false);
    if (owner.current() && owner.trigger.isConnected) owner.unavailable();
  }
}
