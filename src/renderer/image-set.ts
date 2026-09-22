import { t, ui } from './i18n.js';
import { localImageDataUrl } from './rich-image.js';

export { imageSetsForTimeline, type ImageSetImage, type ImageSetView } from '../shared/chronology.js';

const MIN_SCALE = 1;
const MAX_SCALE = 3;
const SWIPE_PX = 48;

export interface ImageSetViewerOwner {
  row: HTMLElement;
  sessionId: string;
  current: () => boolean;
}

type SetViewer = {
  owner: ImageSetViewerOwner;
  dialog: HTMLDialogElement | null;
  focusGuard: ((event: FocusEvent) => void) | null;
  index: number;
  scale: number;
  panX: number;
  panY: number;
};
let active: SetViewer | null = null;

function closeViewer(viewer: SetViewer, restoreFocus: boolean): void {
  if (active !== viewer) return;
  active = null;
  if (viewer.focusGuard) {
    document.removeEventListener('focusin', viewer.focusGuard);
    viewer.focusGuard = null;
  }
  const dialog = viewer.dialog;
  const trigger = viewer.owner.row.querySelector<HTMLButtonElement>('.image-set-open');
  if (dialog) {
    if (dialog.open) dialog.close();
    dialog.remove();
  }
  if (restoreFocus && viewer.owner.current() && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

/** Session changes and timeline eviction drop the set viewer without restoring a detached row. */
export function retireImageSetViewer(): void {
  if (active) closeViewer(active, false);
}

export function retireStaleImageSetViewer(): void {
  if (active && (!active.owner.current() || !active.owner.row.isConnected)) closeViewer(active, false);
}

function membersOf(row: HTMLElement): HTMLElement[] {
  const gallery = row.closest<HTMLElement>('.generated-image-gallery');
  const rows = [...(gallery ?? row).querySelectorAll<HTMLElement>(':scope > .ev-native_image, .ev-native_image')];
  const unique = rows.filter((item, index) => rows.indexOf(item) === index);
  return unique.length ? unique : [row];
}

/** Download and save stay visible until custody exists. They must not fetch or start a transfer. */
export function keepImageActionInert(button: HTMLButtonElement): void {
  button.type = 'button';
  button.setAttribute('aria-disabled', 'true');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
  });
}

function button(className: string, label: () => string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  ui(node, 'textContent', label);
  return node;
}

/** Count and set actions for a multi-image card. One image keeps the same row without this bar. */
export function paintImageSetBar(gallery: HTMLElement, count: number): void {
  gallery.querySelector('.image-set-bar')?.remove();
  gallery.classList.toggle('is-single', count < 2);
  gallery.dataset.imageCount = String(count);
  if (count < 2) return;
  const bar = document.createElement('div');
  bar.className = 'image-set-bar';
  const countLabel = document.createElement('p');
  countLabel.className = 'meta';
  ui(countLabel, 'textContent', () => t('{0} images', [count]));
  const downloadAll = button('image-set-download-all', () => t('Download all originals'));
  const saveAll = button('image-set-save-all', () => t('Save all previews'));
  keepImageActionInert(downloadAll);
  keepImageActionInert(saveAll);
  bar.append(countLabel, downloadAll, saveAll);
  gallery.append(bar);
}

/**
 * Local saved-preview viewer for one response-owned set.
 * It never reads a provider URL and never starts a download.
 */
export async function openImageSetViewer(owner: ImageSetViewerOwner): Promise<void> {
  if (active || !owner.current() || !owner.row.isConnected) return;
  const rows = membersOf(owner.row);
  const start = Math.max(0, rows.indexOf(owner.row));
  const viewer: SetViewer = {
    owner, dialog: null, focusGuard: null, index: start, scale: MIN_SCALE, panX: 0, panY: 0
  };
  active = viewer;

  const dialog = document.createElement('dialog');
  dialog.className = 'image-set-viewer';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  ui(dialog, 'aria-label', () => t('Image set'));
  const position = document.createElement('p');
  position.className = 'image-set-position';
  const stage = document.createElement('div');
  stage.className = 'image-set-stage';
  const picture = document.createElement('img');
  picture.alt = t('ChatGPT generated image');
  const metadata = document.createElement('p');
  metadata.className = 'image-set-metadata';
  metadata.hidden = true;
  const thumbs = document.createElement('div');
  thumbs.className = 'image-set-thumbs';
  const thumbButtons = rows.map((row, index) => {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'image-set-thumb';
    ui(thumb, 'aria-label', () => t('{0} / {1}', [index + 1, rows.length]));
    const resident = row.querySelector('img')?.getAttribute('src');
    if (resident && localImageDataUrl(resident)) {
      const preview = document.createElement('img');
      preview.alt = '';
      preview.src = resident;
      thumb.append(preview);
    } else thumb.textContent = String(index + 1);
    thumb.addEventListener('click', () => {
      if (!owner.current()) { closeViewer(viewer, false); return; }
      viewer.index = index;
      viewer.scale = MIN_SCALE;
      viewer.panX = 0;
      viewer.panY = 0;
      void show();
    });
    return thumb;
  });
  thumbs.append(...thumbButtons);
  const previous = button('image-set-previous', () => t('Previous'));
  const next = button('image-set-next', () => t('Next'));
  const zoomIn = button('image-set-zoom-in', () => t('Zoom in'));
  const zoomOut = button('image-set-zoom-out', () => t('Zoom out'));
  const details = button('image-set-metadata-toggle', () => t('Metadata'));
  const workbench = button('image-set-workbench', () => t('Open workbench'));
  const download = button('image-set-download', () => t('Download original'));
  const save = button('image-set-save', () => t('Save preview'));
  const close = button('image-set-close', () => t('Close'));
  keepImageActionInert(download);
  keepImageActionInert(save);
  stage.append(picture);
  dialog.append(position, stage, thumbs, metadata, previous, next, zoomIn, zoomOut, details, workbench, download, save, close);
  viewer.dialog = dialog;

  const applyTransform = (): void => {
    picture.style.transform = `translate(${viewer.panX}px, ${viewer.panY}px) scale(${viewer.scale})`;
  };
  const clampPan = (): void => {
    const limit = (viewer.scale - 1) * 160;
    viewer.panX = Math.max(-limit, Math.min(limit, viewer.panX));
    viewer.panY = Math.max(-limit, Math.min(limit, viewer.panY));
  };
  let shown = 0;
  const show = async (): Promise<void> => {
    const token = ++shown;
    if (active !== viewer) return;
    const row = rows[viewer.index];
    if (!row || !owner.current()) { closeViewer(viewer, false); return; }
    position.textContent = t('{0} / {1}', [viewer.index + 1, rows.length]);
    previous.disabled = viewer.index === 0;
    next.disabled = viewer.index === rows.length - 1;
    thumbButtons.forEach((thumb, index) => {
      thumb.setAttribute('aria-pressed', index === viewer.index ? 'true' : 'false');
    });
    const width = Number(row.dataset.imageWidth) || 1;
    const height = Number(row.dataset.imageHeight) || 1;
    dialog.style.setProperty('--image-set-width', `${Math.max(1, width)}px`);
    dialog.style.setProperty('--image-set-height', `${Math.max(1, height)}px`);
    stage.style.aspectRatio = `${Math.max(1, width)} / ${Math.max(1, height)}`;
    const status = row.dataset.imageStatus || 'pending';
    const error = row.dataset.imageError || '';
    const availability = status === 'pending' ? t('Image preview is loading')
      : error === 'removed' ? t('Image removed from local storage')
      : error === 'quota' ? t('Image preview unavailable — recording storage is full')
      : error === 'oversized' ? t('Image preview unavailable — image exceeds the recording limit')
      : status === 'unavailable' ? t('Image preview unavailable')
      : t('ChatGPT generated image');
    metadata.textContent = `${width} × ${height} · ${availability}`;
    const resident = row.querySelector('img')?.getAttribute('src');
    const previewId = row.dataset.imagePreview ?? '';
    if (resident && localImageDataUrl(resident)) picture.src = resident;
    else if (previewId && status === 'available') {
      let data: unknown = null;
      try {
        const reply = await window.api.getSessionImage(owner.sessionId, previewId);
        data = reply.ok ? reply.data : null;
      } catch { data = null; }
      if (token !== shown || active !== viewer) return;
      if (!owner.current()) { closeViewer(viewer, false); return; }
      if (localImageDataUrl(data)) picture.src = data;
      else picture.removeAttribute('src');
    } else picture.removeAttribute('src');
    applyTransform();
  };
  const move = (step: number): void => {
    if (!owner.current()) { closeViewer(viewer, false); return; }
    const nextIndex = viewer.index + step;
    if (nextIndex < 0 || nextIndex >= rows.length) return;
    viewer.index = nextIndex;
    viewer.scale = MIN_SCALE;
    viewer.panX = 0;
    viewer.panY = 0;
    void show();
  };
  const zoom = (step: number): void => {
    if (!owner.current()) { closeViewer(viewer, false); return; }
    viewer.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, viewer.scale + step));
    clampPan();
    applyTransform();
  };
  const focusables = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];

  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  zoomIn.addEventListener('click', () => zoom(0.5));
  zoomOut.addEventListener('click', () => zoom(-0.5));
  details.addEventListener('click', () => { metadata.hidden = !metadata.hidden; });
  workbench.addEventListener('click', () => {
    owner.row.ownerDocument.getElementById('workPanelTab-files')?.click();
  });
  close.addEventListener('click', () => closeViewer(viewer, true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeViewer(viewer, true); });
  dialog.addEventListener('close', () => closeViewer(viewer, true));
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      const target = items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]!;
      target.focus();
      return;
    }
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.5); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoom(-0.5); }
  });
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let dragX = 0;
  let dragY = 0;
  stage.addEventListener('pointerdown', event => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    dragX = 0;
    dragY = 0;
    stage.setPointerCapture?.(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    dragX += dx;
    dragY += dy;
    if (viewer.scale === MIN_SCALE) return;
    viewer.panX += dx;
    viewer.panY += dy;
    clampPan();
    applyTransform();
  });
  stage.addEventListener('pointerup', () => {
    dragging = false;
    if (viewer.scale === MIN_SCALE && Math.abs(dragX) >= SWIPE_PX && Math.abs(dragX) > Math.abs(dragY)) {
      move(dragX < 0 ? 1 : -1);
    }
    dragX = 0;
    dragY = 0;
  });
  stage.addEventListener('pointercancel', () => { dragging = false; dragX = 0; dragY = 0; });

  document.body.append(dialog);
  viewer.focusGuard = event => {
    if (active !== viewer || !dialog.open || dialog.contains(event.target as Node)) return;
    if (!owner.current() || !owner.row.isConnected) { closeViewer(viewer, false); return; }
    close.focus({ preventScroll: true });
  };
  document.addEventListener('focusin', viewer.focusGuard);
  try {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.open = true;
  } catch {
    if (active === viewer) closeViewer(viewer, false);
    return;
  }
  if (active !== viewer || !dialog.isConnected) return;
  close.focus();
  await show();
}
