import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';
import { getSession } from './session/store.js';

/** An app-frame display report. A witness never authorizes browser or native input. */
export type UiSelection = Readonly<{ sessionId: string | null; generation: number }>;
export type UiSelectionReport = Readonly<{ sessionId: string | null; rendererGeneration: number }>;

const reportSchema = z.object({
  sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).nullable(),
  rendererGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();

type WindowRecord = {
  window: BrowserWindow;
  contents: WebContents;
  incarnation: number;
  latestRendererGeneration: number;
  generation: number;
  token: number;
  selected: UiSelection | null;
  pending: boolean;
  pendingSessionId: string | null;
  ready: boolean;
  dispose: () => void;
};

const expectedFile = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;

function isAppFrame(contents: WebContents): boolean {
  if (contents.isDestroyed() || !contents.mainFrame) return false;
  const actual = contents.getURL();
  const expected = process.env.ELECTRON_RENDERER_URL || expectedFile;
  return actual === expected && contents.mainFrame.url === actual;
}

function alive(record: WindowRecord): boolean {
  return !record.window.isDestroyed() && !record.contents.isDestroyed();
}

/** Main-private, process-lifetime ownership scoped to the exact currently installed window. */
export class UiSelectionOwner {
  private current: WindowRecord | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private invalidate(record: WindowRecord): void {
    record.token++;
    record.selected = null;
    record.pending = false;
    record.pendingSessionId = null;
  }

  private track(): WindowRecord | null {
    const window = this.getWindow();
    if (this.current && (this.current.window !== window || !alive(this.current))) {
      this.invalidate(this.current);
      this.current.dispose();
      this.current = null;
    }
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
    if (this.current) return this.current;
    const contents = window.webContents;
    const record: WindowRecord = {
      window, contents, incarnation: 0, latestRendererGeneration: -1, generation: 0,
      token: 0, selected: null, pending: false, pendingSessionId: null, ready: true, dispose: () => {}
    };
    const revoke = (): void => this.invalidate(record);
    const load = (): void => {
      revoke();
      record.ready = false;
      record.incarnation++;
      // Only the actual main-frame reload may reset renderer sequence admission.
      if (contents.isLoadingMainFrame?.() === true) record.latestRendererGeneration = -1;
    };
    const loaded = (): void => { record.ready = true; };
    const crashed = (): void => { revoke(); record.ready = false; };
    const listeners = [
      [contents, 'did-start-loading', load],
      [contents, 'did-finish-load', loaded],
      [contents, 'did-start-navigation', revoke],
      [contents, 'render-process-gone', crashed],
      [contents, 'destroyed', crashed],
      [window, 'hide', revoke],
      [window, 'closed', crashed]
    ] as const;
    for (const [target, name, callback] of listeners) target.on(name as never, callback);
    record.dispose = () => {
      for (const [target, name, callback] of listeners) target.removeListener(name as never, callback);
    };
    this.current = record;
    return record;
  }

  currentFor(sender: WebContents): UiSelection | null {
    const record = this.track();
    if (!record || record.contents !== sender || !record.ready || record.pending ||
        !record.window.isVisible()) return null;
    if (!isAppFrame(record.contents)) { this.invalidate(record); return null; }
    return record.selected;
  }

  invalidateSession(id: string): void {
    const record = this.track();
    if (record && (record.selected?.sessionId === id || record.pendingSessionId === id)) this.invalidate(record);
  }

  async report(event: IpcMainInvokeEvent, payload: unknown): Promise<{ ok: true; data: UiSelection } | { ok: false; error: string }> {
    const fail = (error: string) => ({ ok: false as const, error });
    const record = this.track();
    if (!record || !alive(record) || event?.sender !== record.contents ||
        !event.senderFrame || event.senderFrame !== record.contents.mainFrame ||
        !record.ready || !record.window.isVisible() || !isAppFrame(record.contents)) return fail('ui_selection_sender_unavailable');
    const parsed = reportSchema.safeParse(payload);
    if (!parsed.success) { this.invalidate(record); return fail('invalid_ui_selection'); }
    const request = parsed.data;
    if (request.rendererGeneration <= record.latestRendererGeneration) return fail('stale_ui_selection');

    // This synchronous cut is before getSession, and invalidates even a failed newer lookup.
    this.invalidate(record);
    record.latestRendererGeneration = request.rendererGeneration;
    record.pending = true;
    record.pendingSessionId = request.sessionId;
    const token = record.token, incarnation = record.incarnation;
    let exists = true;
    try { if (request.sessionId) exists = !!await getSession(request.sessionId); }
    catch { exists = false; }
    if (this.track() !== record || !alive(record) || !record.ready || record.incarnation !== incarnation ||
        record.token !== token || !record.pending || !record.window.isVisible() ||
        event.senderFrame !== record.contents.mainFrame || !isAppFrame(record.contents)) return fail('stale_ui_selection');
    if (!exists) { this.invalidate(record); return fail('ui_selection_session_unavailable'); }
    const selected: UiSelection = { sessionId: request.sessionId, generation: ++record.generation };
    record.selected = selected;
    record.pending = false;
    record.pendingSessionId = null;
    return { ok: true, data: selected };
  }
}

let registeredOwner: UiSelectionOwner | null = null;

export function registerUiSelection(getWindow: () => BrowserWindow | null): UiSelectionOwner {
  registeredOwner = new UiSelectionOwner(getWindow);
  return registeredOwner;
}

/** Future main-only consumers must also prove the exact window and session independently. */
export function currentUiSelectionFor(sender: WebContents): UiSelection | null {
  return registeredOwner?.currentFor(sender) ?? null;
}
