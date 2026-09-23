# ChatBBC Crystal Studio Redesign Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan suite task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shipped ChatBBC renderer with one chat-centric Crystal Studio shell, immediate Omarchy identity, safe rich outputs, and truthful generated-asset workflows.

**Architecture:** Preserve every existing main/shared authority and replace presentation through dependency-ordered vertical slices. The program is split into four independently reviewable implementation plans; each produces working software and removes the presentation path it replaces.

**Tech Stack:** Electron 44, TypeScript 7, electron-vite/Vite, vanilla DOM/CSS, Chromium MV3 JavaScript, Zod, Sharp, Vitest/jsdom, real Electron verification scripts.

**Spec:** `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

## Global Constraints

- Linux/Omarchy/Hyprland is the implementation and live-validation target; preserve legacy Windows/macOS source and tests.
- No React, Vue, Preact, Lit, webview, generic IPC executor, second durable ledger, second asset cache, or permanent classic UI.
- The transcript and composer remain primary at every supported width.
- Main/shared owners remain authoritative for sessions, projects, inputs, workers, terminals, browser custody, permissions, continuation, Goal/Loop, plugins, and settings.
- Unknown or stale identity fails closed for mutation; pending/dispatched never paints as confirmed.
- Never execute provider JavaScript, event handlers, remote content, or arbitrary selectors.
- Never persist or publish signed provider URLs, cookies, credentials, or raw provider payloads.
- Preserve existing history/text/image/queue/IPC bounds; generated originals use `GENERATED_ASSET_LIMITS` from the spec.
- Every user-visible string goes through the existing i18n owner and all current locale catalogs.
- Each task starts with `git status --short` and `git diff -- <owned files>`; never reset, clean, checkout, or broadly reformat the shared tree.
- Each task runs only its nearest checks; `npm run verify` and build/package checks run once in the final plan.
- Provider-facing mutation stays unavailable until signed-in live inspection proves the exact native action and postcondition.

## Review Focus

1. **Theme rename/write burst:** transient missing Omarchy files retain the last valid generation and repaint once after the complete snapshot — Foundation Tasks 1–2.
2. **A → B → A renderer ownership:** a late history, file, rich, image, or action reply cannot paint into the later A selection — Workspace Tasks 2–5 and Rich Tasks 1–7.
3. **Transparent-window failure:** startup/reload/compositor failure always shows a readable backing without a black or click-through window — Foundation Task 3 and Cutover Task 2.
4. **Lost browser/download acknowledgement:** an accepted rich action or download remains unknown/unconfirmed and never dispatches twice — Rich Tasks 2, 5, and 6.
5. **Concurrent project asset write:** agent retrieval never overwrites a destination changed after validation and never substitutes a preview for an unavailable original — Rich Task 7.

---

## Plan Suite and Order

1. [`2026-09-21-chatbbc-crystal-studio-foundation.md`](./2026-09-21-chatbbc-crystal-studio-foundation.md)
   - Crystal semantic tokens and contrast
   - immediate Omarchy watcher/generation
   - transparent BrowserWindow plus atmospheric fallback
   - framework-free presentation store and Adaptive Studio shell

2. [`2026-09-21-chatbbc-crystal-studio-workspace.md`](./2026-09-21-chatbbc-crystal-studio-workspace.md)
   - global rail and chat navigator
   - conversation stage, paged transcript, composer, queue, plans, recovery
   - contextual workbench for Files, Agents, Terminal, and inspectors
   - Settings, Setup, Plugins, Usage, dialogs, and responsive behavior

3. [`2026-09-21-chatbbc-crystal-studio-rich-outputs.md`](./2026-09-21-chatbbc-crystal-studio-rich-outputs.md)
   - exact live choice identity and durable action custody
   - safe semantic/static artifact projection and focus stage
   - response-owned image sets and galleries
   - human original downloads to Downloads
   - permission-checked agent `generated_assets` retrieval

4. [`2026-09-21-chatbbc-crystal-studio-cutover.md`](./2026-09-21-chatbbc-crystal-studio-cutover.md)
   - remove old renderer paths and temporary gates
   - accessibility/performance/locale acceptance
   - real Electron, Omarchy, signed-in provider, full verify, build, and contract/worklog updates

## Program Gates

- [ ] **Gate 1: Approve Foundation evidence**

  Require focused tests, real Electron fallback proof, and reviewed interfaces before Workspace begins.

- [ ] **Gate 2: Approve Workspace evidence**

  Require complete ordinary user flow—open/select/send/queue/history/files/agents/terminal/settings—inside the new shell before Rich Outputs changes its components.

- [ ] **Gate 3: Approve Rich Outputs evidence**

  Require source-safe behavior plus signed-in evidence for every enabled native mutation. Unsupported live families remain inert rather than inferred.

- [ ] **Gate 4: Complete Cutover**

  Require one renderer path, no temporary gate, whole-branch review, and evidence at each claimed level.

## Execution Rule

Use one implementation branch/worktree for the entire suite. Commit at every task boundary. Plans are sequential because they intentionally share shell, renderer state, transcript, extension, bridge, and IPC interfaces; do not run overlapping implementers on the same plan phase.
