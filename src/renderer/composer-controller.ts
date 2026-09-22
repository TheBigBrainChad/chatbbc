import { t } from './i18n.js';
import type { InputAttachment, InputImage } from '../shared/input.js';
import type { AgentPlan } from '../shared/agent-plan.js';
import type { RecoveryCountdown } from '../shared/recovery.js';
import { renderAgentPlan } from './agent-plan.js';
import { renderRecoveryCountdowns } from './recovery.js';
import { paintComposerStatusLine } from './composer-status-line.js';

/** Files the existing attachment map already stores. This controller does not keep a copy. */
export type ComposerAttachment = InputImage | InputAttachment;

/** The presentation store's draft key and generation. Not a second draft. */
export interface ComposerDraftOwner {
  key: string;
  generation: number;
}

export interface DraftSnapshot<T extends { name: string } = ComposerAttachment> {
  key: string;
  generation: number;
  text: string;
  attachments: readonly T[];
}

/**
 * What the composer may project. Omitted fields stay with their current painters.
 * Text is applied only when the field is not dirty.
 */
export interface ComposerView {
  text?: string;
  sessionId?: string | null;
  plan?: AgentPlan | null;
  recovery?: readonly RecoveryCountdown[];
  recoveryNow?: number;
}

/** Composer listeners whose behavior stays in chat.ts. Subscription lives here. */
export interface ComposerSurface {
  queueAtFinish(): void;
  chooseDelivery(mode: string): void;
  chooseAutomation(mode: string): void;
  automationChanged(): void | Promise<void>;
  loopDeliveryChanged(): void | Promise<void>;
  objectiveEdited(): void;
  saveObjective(): void | Promise<void>;
  compact(cancel: boolean): void | Promise<void>;
  generateFinishGoal(): void | Promise<void>;
  composerInput(): void;
  composerKeydown(event: KeyboardEvent): void;
  settingsToggled(): void;
  createPlan(): void;
  submit(event: Event): void;
}

export interface ComposerControllerOptions<T extends { name: string } = ComposerAttachment> {
  /** The chat.ts image-draft map. Imports write here or nowhere. */
  imageDrafts: Map<string, T[]>;
  /** Per-draft composer text. The controller reads it and does not copy it. */
  inputDrafts?: { get(key: string): string | undefined };
  /** Plan drafts keyed with the image drafts. Not a second plan store. */
  taskPlans?: { has(key: string): boolean };
  /** Live queue projection. Reading it does not snapshot a second queue. */
  pendingInputs?: () => readonly unknown[];
  stageFiles(files: readonly File[]): Promise<readonly T[] | null>;
  /** Publish an owner the presentation store does not already hold. */
  setDraftOwner?(owner: ComposerDraftOwner): void;
  notify?(message: string): void;
  text?(): string;
  /** Repaint after the shared image-draft map changes. */
  onAttachments?(): void;
  chooseFiles?(): Promise<readonly T[] | null>;
  attachText?(text: string): Promise<T | null>;
  surface?: Partial<ComposerSurface>;
}

export interface ComposerController<T extends { name: string } = ComposerAttachment> {
  update(owner: ComposerDraftOwner, view: ComposerView): void;
  focus(): void;
  replaceDraft(next: DraftSnapshot<T>): void;
  dispose(): void;
  importFiles(files: readonly File[]): Promise<void>;
  currentDraft(): { text: string; attachments: readonly T[] };
  /** Keep already-staged files on the owner captured before the read. */
  acceptAttachments(owner: ComposerDraftOwner, rows: readonly T[] | null | undefined): boolean;
}

const ATTACHMENT_LIMIT = 20;
const ATTACHMENT_BYTES = 512 * 1024 * 1024;

function sameOwner(left: ComposerDraftOwner, right: ComposerDraftOwner): boolean {
  return left.key === right.key && left.generation === right.generation;
}

function composerField(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('chatInput') as HTMLTextAreaElement | null;
}

function listen(signal: AbortSignal, id: string, type: string, listener: EventListener): void {
  document.getElementById(id)?.addEventListener(type, listener, { signal });
}

/**
 * Composer, outbox, plan, and recovery presentation beside the mounted conversation stage.
 *
 * The stage stays the transcript owner. This controller is its sibling: it binds the composer
 * already in the page and never mounts a second one. Draft identity is the owner last handed
 * to update or replaceDraft, which chat.ts keeps equal to the presentation store. Attachments
 * stay in the caller's image-draft map.
 */
export function createComposerController<T extends { name: string } = ComposerAttachment>(
  options: ComposerControllerOptions<T>
): ComposerController<T> {
  // JSDOM and the page do not share one AbortSignal realm. Use the document's own controller.
  const HostAbort = typeof document !== 'undefined' ? document.defaultView?.AbortController : undefined;
  const abort = new (HostAbort ?? AbortController)();
  let disposed = false;
  let owner: ComposerDraftOwner = { key: 'new', generation: 0 };
  let viewText = '';
  const { signal } = abort;

  const adopt = (captured: ComposerDraftOwner, rows: readonly T[] | null | undefined): boolean => {
    if (disposed || !rows?.length) return false;
    if (!sameOwner(captured, owner)) {
      options.notify?.(t('Files were not added because the draft changed.'));
      return false;
    }
    const existing = options.imageDrafts.get(captured.key) ?? [];
    const combined = [...existing, ...rows];
    const bytes = combined.reduce((sum, file) => sum + ('size' in file ? Number(file.size) || 0 : 0), 0);
    if (combined.length > ATTACHMENT_LIMIT || bytes > ATTACHMENT_BYTES) {
      options.notify?.(t('Attach up to 20 files and 512 MB per message'));
      return false;
    }
    // A new array: sendComposer snapshots the previous one and compares identity.
    options.imageDrafts.set(captured.key, combined);
    options.onAttachments?.();
    return true;
  };

  const controller: ComposerController<T> = {
    update(next, view) {
      if (disposed) return;
      owner = { key: next.key, generation: next.generation };
      options.setDraftOwner?.(owner);
      if (view.text !== undefined) {
        const input = composerField();
        const dirty = !!input && document.activeElement === input && input.value !== view.text;
        if (!dirty) {
          viewText = view.text;
          if (input) input.value = view.text;
        }
      }
      if (typeof document === 'undefined') return;
      if ('plan' in view && document.getElementById('agentPlan')) {
        renderAgentPlan(document.getElementById('agentPlan')!, view.sessionId ?? null, view.plan ?? null);
        if (document.getElementById('composerStatusLine')) paintComposerStatusLine();
      }
      if (view.recovery && document.getElementById('recoveryStatus')) {
        renderRecoveryCountdowns(document.getElementById('recoveryStatus')!, view.recovery, view.recoveryNow);
        if (document.getElementById('composerStatusLine')) paintComposerStatusLine();
      }
    },
    focus() {
      composerField()?.focus();
    },
    replaceDraft(next) {
      if (disposed) return;
      owner = { key: next.key, generation: next.generation };
      options.setDraftOwner?.(owner);
      viewText = next.text;
      const input = composerField();
      if (input) input.value = next.text;
      options.imageDrafts.set(next.key, [...next.attachments]);
      options.onAttachments?.();
    },
    dispose() {
      disposed = true;
      abort.abort();
    },
    async importFiles(files) {
      if (disposed || !files.length) return;
      const captured = { key: owner.key, generation: owner.generation };
      if (files.length + (options.imageDrafts.get(captured.key)?.length ?? 0) > ATTACHMENT_LIMIT) {
        options.notify?.(t('Attach up to 20 files per message'));
        return;
      }
      let rows: readonly T[] | null;
      try { rows = await options.stageFiles(files); }
      catch { return; }
      adopt(captured, rows);
    },
    currentDraft() {
      return {
        text: options.text?.() ?? options.inputDrafts?.get(owner.key) ?? viewText,
        attachments: options.imageDrafts.get(owner.key) ?? []
      };
    },
    acceptAttachments: adopt
  };

  if (typeof document !== 'undefined') bindComposerSurface(signal, controller, options, () => ({ key: owner.key, generation: owner.generation }));
  return controller;
}

function bindComposerSurface<T extends { name: string }>(
  signal: AbortSignal,
  controller: ComposerController<T>,
  options: ComposerControllerOptions<T>,
  draftOwner: () => ComposerDraftOwner
): void {
  const surface = options.surface ?? {};
  listen(signal, 'queueAtFinish', 'click', () => { surface.queueAtFinish?.(); });
  listen(signal, 'sendOptions', 'click', event => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-delivery]');
    if (!button || document.getElementById('sendOptions')?.hidden) return;
    surface.chooseDelivery?.(button.dataset.delivery ?? '');
  });
  listen(signal, 'automationSwitch', 'click', event => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-mode]');
    if (!button?.dataset.mode || button.disabled) return;
    surface.chooseAutomation?.(button.dataset.mode);
  });
  listen(signal, 'chatAutomation', 'change', () => { void surface.automationChanged?.(); });
  listen(signal, 'loopDelivery', 'change', () => { void surface.loopDeliveryChanged?.(); });
  listen(signal, 'sessionObjective', 'input', () => { surface.objectiveEdited?.(); });
  listen(signal, 'sessionObjectiveMode', 'change', () => { surface.objectiveEdited?.(); });
  listen(signal, 'saveSessionObjective', 'click', () => { void surface.saveObjective?.(); });
  listen(signal, 'compactSession', 'click', () => { void surface.compact?.(false); });
  listen(signal, 'cancelCompaction', 'click', () => { void surface.compact?.(true); });
  listen(signal, 'attachImages', 'click', () => {
    if (!options.chooseFiles) return;
    const captured = draftOwner();
    void options.chooseFiles().then(rows => { controller.acceptAttachments(captured, rows); });
  });
  listen(signal, 'generateFinishGoal', 'click', () => { void surface.generateFinishGoal?.(); });
  const composer = document.getElementById('composer');
  composer?.addEventListener('dragover', event => {
    const drag = event as DragEvent;
    if (!drag.dataTransfer?.types.some(type => type === 'text/plain') || drag.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    drag.dataTransfer.dropEffect = 'copy';
  }, { signal });
  composer?.addEventListener('drop', event => {
    const drag = event as DragEvent;
    if (!drag.dataTransfer?.types.some(type => type === 'text/plain') || drag.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const text = drag.dataTransfer.getData('text/plain');
    if (!text || !options.attachText) return;
    const captured = draftOwner();
    void options.attachText(text).then(file => { if (file) controller.acceptAttachments(captured, [file]); });
  }, { signal });
  composer?.addEventListener('submit', event => { surface.submit?.(event); }, { signal });
  window.addEventListener('paste', event => {
    const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return;
    event.preventDefault();
    void controller.importFiles(files);
  }, { signal });
  window.addEventListener('dragover', event => {
    const drag = event as DragEvent;
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !drag.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'copy';
  }, { signal });
  window.addEventListener('drop', event => {
    const drag = event as DragEvent;
    if ((event.target as Element | null)?.closest?.('#foldersCard') || !drag.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    const files = Array.from(drag.dataTransfer?.files ?? []);
    if (!files.length) return;
    void controller.importFiles(files);
  }, { signal });
  const menus = () => [...document.querySelectorAll<HTMLDetailsElement>('.composer-menu, .session-controls')];
  document.addEventListener('click', event => {
    for (const menu of menus()) {
      const target = event.target as HTMLElement | null;
      if (!menu.contains(event.target as Node) || (target?.closest('button') && !target.closest('[data-keep-menu]'))) menu.open = false;
    }
  }, { signal });
  document.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') for (const menu of menus()) menu.open = false;
  }, { signal });
  listen(signal, 'chatInput', 'input', () => { surface.composerInput?.(); });
  listen(signal, 'chatInput', 'keydown', event => { surface.composerKeydown?.(event as KeyboardEvent); });
  listen(signal, 'composerSettings', 'toggle', () => { surface.settingsToggled?.(); });
  listen(signal, 'createPlan', 'click', () => { surface.createPlan?.(); });
}

