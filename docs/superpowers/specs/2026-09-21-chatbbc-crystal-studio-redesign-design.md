# ChatBBC Crystal Studio redesign — design

**Date:** 2026-09-21
**Status:** in implementation. Foundation and Workspace are on the branch; Rich Outputs is implemented and source/Electron-verified. Not yet implemented at the release level: Cutover deletion inventory, packaging acceptance and signed-in provider acceptance (see `docs/worklog-2026-09-21-crystal-studio.md`).
**Supersedes:** [`2026-09-18-chatbbc-omarchy-redesign-design.md`](./2026-09-18-chatbbc-omarchy-redesign-design.md)

## 1. Purpose

ChatBBC will present a premium, chat-centric AI project operating system rather than a generic
dark chat client with utilities attached. This redesign replaces the entire presentation shell,
introduces a Crystal glass identity that follows Omarchy immediately, and makes rich ChatGPT
outputs—decisions, rendered artifacts, and generated image sets—first-class parts of the local
workspace.

The redesign is a **new presentation shell over existing authorities**. Durable session identity,
projects, the outbox, browser receipts, history, workers, terminals, permissions, continuation,
Goal/Loop, plugins, and settings remain owned by their existing main/shared modules. The renderer
projects those facts; it does not mirror or reinterpret them.

This design intentionally broadens the previous presentation-only Omarchy redesign. It includes
purpose-specific product behavior for trusted live choices, original-image downloads, and
agent-owned generated-asset retrieval.

## 2. Evidence and constraints

### 2.1 Source evidence

The current renderer is a large static DOM and TypeScript presentation split primarily across
`src/renderer/index.html`, `main.ts`, `chat.ts`, and seven large CSS files. It already has strong
backend contracts but presentation paths are coupled and difficult to reshape as a coherent
workspace.

Current rich-output behavior is narrower than the desired product:

- `src/shared/rich-response.ts` validates a bounded semantic tree with groups, text, images, and
  control shapes.
- `extension/chatgpt-dom.js::captureRichRoot()` rejects scripts, styles, templates, iframes,
  objects, embedded content, canvas, video, and audio. It captures only inert semantics.
- Current captured controls lose actionable grouping/value identity (`groupId` and `value` are
  published as null).
- `src/renderer/rich-response.ts` deliberately renders all captured controls inert.
- Native generated images have exact provider message/asset identities and bounded local WebP
  previews, but `src/renderer/chat.ts::groupImageRows()` groups them only by adjacent rows.
- The gallery is a fixed two-column grid with no set-level selection, keyboard navigation, or
  download actions.
- `src/renderer/rich-image.ts` exposes only a local saved-preview viewer. There is no original
  download transport.

### 2.2 Live evidence boundary

The browser relay service was reachable during brainstorming, but its extension was not connected.
No signed-in ChatGPT DOM was inspected. Current native choice postconditions, artifact structures,
and original-image download controls are therefore **not live-verified**.

Trusted choices and provider-original downloads remain implementation prerequisites, not assumed
selectors. They may be enabled only after signed-in inspection establishes exact native identity,
action, and postcondition behavior.

### 2.3 Product constraints retained

- Linux and Omarchy/Hyprland are the designed experience. Windows and macOS remain legacy paths.
- Context isolation, sandboxing, CSP, the fixed preload allowlist, and filesystem permission rules
  remain intact.
- Local session identity is durable; a ChatGPT conversation is replaceable.
- Unknown identity fails closed for mutation.
- One meaningful fact has one owner.
- A pending or dispatched action is not a confirmed action.
- User corrections, queued work, Goal/Loop, workers, compaction, and recording retain their current
  behavioral contracts unless this specification explicitly changes them.

## 3. Decisions

| Area | Decision |
|---|---|
| Product identity | Chat-centric AI project operating system |
| Visual direction | Crystal Studio: luminous layered glass, soft geometry, restrained bloom |
| Layout | Adaptive Studio with global rail, chat navigator, central conversation stage, contextual workbench |
| Center of gravity | Conversation and composer remain permanently primary |
| Omarchy relationship | ChatBBC owns geometry/depth; Omarchy supplies live palette, mode, and font identity |
| Theme synchronization | Immediate, versioned, coalesced theme-file observation |
| Translucency | Real transparent Electron window with scoped Hyprland blur when available |
| Fallback | In-app atmospheric Crystal backing with identical hierarchy and geometry |
| Renderer migration | Framework-free TypeScript components; clean vertical-slice cutover |
| Rich decisions | First-class decision panels; live actions require exact trusted native postconditions |
| Rendered artifacts | Safe semantic/static rendering; no provider script or arbitrary remote content execution |
| Generated images | Explicit response-owned image sets, not adjacency-based rows |
| Human original download | Direct action to the OS Downloads folder |
| Agent asset placement | Separate permission-checked Core operation targeting an approved project path |

## 4. Product shell

### 4.1 Global rail

The rail is the stable global frame. **Chats** is first and selected by default. Secondary
destinations are **Files**, **Agents**, **Usage**, and **Settings**. Global connection, recording,
update, and account/browser status appear at the bottom.

The rail changes the visible workspace projection only. It never changes the owning local session,
project, outbox row, worker family, terminal principal, or browser document.

Generated assets are not a competing top-level universe. They are discovered from their owning
chat/project and are surfaced through filtered views inside Chats and Files.

### 4.2 Chat navigator

The navigator is dominated by projects and their chat threads:

- project groups with project-scoped New Chat;
- unfiled chats as a distinct group;
- worker children scoped to their exact prime family/incarnation;
- unread, queue, Goal/Loop, recovery, and active-work indicators;
- search that prioritizes chat titles and authored task text, then project files/assets;
- existing reordering, grouping, expansion, and pagination behavior retained.

A project grouping remains presentation plus durable association, never filesystem permission.
Broken explicit project bindings remain errors rather than inferred workspaces.

### 4.3 Conversation stage

The transcript and composer are permanently central. The stage contains:

- the durable session timeline and frontend/compaction lineage;
- assistant/user messages;
- local tool activity;
- queue, plan, recovery, Goal/Loop, worker, and continuation projections;
- rich decisions, artifacts, and image sets at their exact chronological origin;
- a focus mode that enlarges one selected rich output while retaining its transcript anchor and
  a direct return path.

Focus mode does not create a new local session, move the composer, or re-own the rich output.
The composer stays bound to the active session through every focused view.

### 4.4 Context workbench

One right-side slot hosts Files/editor, Agent detail, terminal, output inspector, plan, and session
metadata. It opens because the user selected a chat-owned object or explicit header control.

The workbench may widen into a split view but never becomes a second navigator or state owner.
Unsaved editor drafts, project generations, terminal custody, and async selection fences retain
their current exact identities.

### 4.5 Responsive priority

At reduced width, collapse in this order:

1. context workbench to an on-demand overlay;
2. chat navigator to a drawer;
3. global rail to a compact/bottom form.

The transcript and composer always keep priority. Panel widths and disclosure states are renderer
preferences only.

## 5. Crystal visual system

### 5.1 Identity

Crystal Studio uses translucent layered surfaces, soft geometry, restrained bloom, and precise
text hierarchy.

- The transcript is the calmest and most readable plane.
- Navigator and workbench use stronger glass depth to distinguish structure.
- Composer, menus, dialogs, and inspectors float above those planes.
- Bloom is reserved for selection, trusted success, active work, and the Omarchy accent.
- Code, terminal output, dense tables, and long prose use more opaque surfaces.
- Glass is never the only status signal.

### 5.2 Semantic tokens

Omarchy colors are transformed into ChatBBC-owned semantic tokens rather than copied directly:

- `canvas`, `canvas-atmosphere`;
- `glass-low`, `glass-medium`, `glass-high`, `glass-readable`;
- `ink`, `ink-muted`, `ink-on-accent`;
- `accent`, `accent-readable`, `accent-glow`;
- `positive`, `warning`, `danger`, `info`;
- `hairline`, `shadow`, `scrim`;
- geometry, spacing, typography, and motion scales.

Feature CSS must not introduce unowned palette literals. Token derivation corrects contrast even
when the selected Omarchy theme is low-contrast.

### 5.3 Omarchy theme owner

`src/main/omarchy-theme.ts` remains the sole desktop-theme reader and gains immediate observation.
It watches `~/.local/state/omarchy/current/theme/colors.toml`, `theme.name`, and the resolved
terminal-font materialization through one bounded owner. Events are coalesced; each publication
reads and validates one complete snapshot.

Every snapshot has a monotonically increasing generation. A stale read cannot overwrite a newer
snapshot. Transient rename gaps or malformed files retain the last valid snapshot and publish one
bounded diagnostic. A fresh install with no readable Omarchy theme uses the built-in Crystal
palette. Manual refresh remains available.

Renderer theme changes update tokens without replacing the document, losing focus, changing the
selected chat, or discarding dirty settings fields.

### 5.4 Native translucency

On Linux the BrowserWindow uses a transparent-capable configuration and the existing stable
`com.chatbbc.app` desktop/window identity that Hyprland can target. When the compositor has blur
enabled and a scoped rule applies, the real desktop is visible and blurred behind ChatBBC.

ChatBBC does not silently edit `~/.config/hypr` or Omarchy system files. Settings reports whether
native transparency is active and provides exact opt-in instructions for a ChatBBC-scoped blur
rule.

Startup, reload, unsupported GPUs/compositors, capture, and failure states retain a readable backing
before transparent content is exposed. A black, fully transparent, or unreadable window is never an
acceptable fallback.

### 5.5 Progressive fallback

If real compositor blur is unavailable, ChatBBC uses an atmospheric in-window background derived
from the same Omarchy palette. Geometry, spacing, hierarchy, and component identity remain the same.
The UI must not claim native blur when only the fallback is active.

### 5.6 Motion

Motion communicates opening/closing, ownership transitions, progress, and completion. Static glass
uses no animation loop. Reduced motion removes travel, parallax, bloom animation, and large
transitions while preserving immediate state changes and visible focus.

## 6. Conversation presentation

### 6.1 Message language

- Assistant prose uses a spacious, mostly borderless reading surface.
- User messages use compact accent-tinted glass cards.
- Tool activity uses one chronological activity rail with expandable exact details.
- Queue entries, plans, recovery, Goal/Loop, continuation, and worker messages use dedicated
  semantic cards instead of generic chat bubbles.
- Streaming updates replace content inside the owning row without unstable geometry.
- Keyed rows retain open disclosures, loaded images, and viewport anchors across revisions.

### 6.2 Durable lineage

The transcript continues to visualize the durable local session across replaceable ChatGPT
frontends. Compaction boundaries and frontend segments remain visible without turning the source
and destination into separate local chats.

## 7. Rich decisions

### 7.1 Presentation

A choice response is rendered as a decision panel containing:

- prompt/title and optional explanatory text;
- image/text option cards;
- selected, disabled, pending, confirmed, failed, and historical states;
- keyboard navigation and explicit focus;
- one Submit/Continue action only when the provider interaction requires it.

Historical controls remain inert and say `Selected when recorded`. Missing or ambiguous live
controls offer **Open original in ChatGPT**.

### 7.2 Trusted live action

Live decisions require a purpose-specific protocol; the existing generic rich-action foundations
must not be armed by presentation evidence alone.

1. A direct trusted click in the selected ChatBBC window creates an intent naming the exact local
   session, logical/provider message, rich revision, document id, navigation epoch, control group,
   option value, and action kind.
2. Main rechecks the current selection witness and durable message owner, then durably records the
   pending physical action before dispatch.
3. The extension resolves one exact original native control in the same document/revision.
4. It rechecks visibility, enabled state, message ownership, option group/value, and navigation
   immediately before one native input action.
5. It observes the purpose-specific native postcondition: selected option state and, where required,
   the exact Continue/submission transition.
6. A bounded receipt returns through the existing bridge custody model.
7. ChatBBC publishes confirmed success only after that postcondition. Unknown outcome remains
   unconfirmed and is never automatically replayed.

The protocol exposes no generic selector, script, URL, or arbitrary click surface. Exact native
selectors and postconditions must be established from signed-in live inspection before this path is
enabled.

## 8. Rendered artifacts

### 8.1 Modes

An artifact card has three truthful modes:

1. **Semantic projection:** bounded headings, prose, code, cards, rows/columns/grids, lists, tables,
   diagrams, controls, and saved images reconstructed from the validated rich schema.
2. **Static visual projection:** complete fenced HTML from the canonical assistant message is
   sanitized and rendered inertly, or exact pixels already admitted by the rich-media owner are
   displayed as a saved raster preview. The renderer never invents markup from an incomplete
   component tree and this mode grants no new page-capture authority.
3. **Unavailable:** accessible text/source with **Open original in ChatGPT**.

### 8.2 Static HTML safety

Static HTML previews run in a sandboxed, scriptless iframe with a restrictive CSP:

- no scripts, forms, navigation, popups, remote fetches, plugins, or top-frame access;
- no provider callbacks or live credentials;
- only one complete fenced HTML document of at most 131,072 UTF-8 bytes, 1,024 admitted nodes,
  depth 24, 65,536 text characters, and 65,536 CSS characters;
- only bounded sanitized markup, inline styles, and up to four locally owned data/blob images under
  the existing rich-image byte and decoded-pixel limits;
- external URLs displayed as text unless separately admitted by the existing validated link route;
- a two-second renderer admission/paint deadline; and
- complete rejection on malformed, oversized, timed-out, or unsupported content rather than
  partial execution.

A provider-authored application requiring JavaScript remains unavailable locally and opens only in
its exact original ChatGPT conversation.

### 8.3 Focus stage

Expanding an artifact opens a chat-owned focus stage with Preview, Structure/Source, and metadata
inspector tabs. Closing restores focus and scroll to the exact transcript row. It does not create a
new history row or modify the native provider artifact.

## 9. Generated image sets

### 9.1 Ownership

Native images are grouped by explicit canonical response identity: durable local session, provider
message, provider asset, turn, document/binding provenance, and canonical chronology. DOM adjacency
is not grouping authority.

The store exposes a response-level projection while retaining each physical image row and asset
identity for chronology, cleanup, and failure accounting.

### 9.2 Gallery behavior

One image uses the same component without unnecessary gallery chrome. Multiple images use:

- hero image plus thumbnails;
- stable `current / total` position;
- arrow-key, thumbnail, and trackpad/swipe navigation;
- retained slots for missing/pending/removed images;
- dimensions, preview/original availability, and storage state;
- per-image Open, Download original, and Save preview actions;
- set-level Download all originals and Save all previews actions.

Gallery changes must not hydrate every full preview. Existing viewport admission and decoded-memory
bounds remain authoritative.

## 10. Human image downloads

### 10.1 Original

**Download original** is a direct trusted user action. It targets the OS Downloads folder through
Chromium's download mechanism and requires the exact live provider asset.

The extension uses a transient signed asset URL only inside the browser process after validating
its exact ChatGPT origin, expected estuary path, asset id, document, message, and current ownership.
The signed URL is never sent to main, recorded, logged, or persisted. The extension adds the
`downloads` permission solely for this purpose-specific path.

Download states are `requested`, `started`, `complete`, `failed`, or `unconfirmed`. A dispatched
request without a receipt is not retried automatically. The UI shows the filename and outcome but
never claims the OS opened or the user inspected it.

### 10.2 Preview

**Save preview** writes the locally recorded bounded WebP through an explicit Save As flow and labels
it `preview`. It never uses an original filename or claims original quality.

### 10.3 Batch

Batch original download is bounded to at most 20 selected assets from the exact image set and
dispatches one independently receipted asset at a time. Larger sets require an explicit bounded
selection. Partial success remains visible per asset. Cancel stops new dispatch but does not undo a
download Chromium already accepted.

## 11. Agent-owned generated assets

### 11.1 Tool surface

Core gains one narrowly scoped `generated_assets` operation when recording/browser integration and
filesystem policy make it eligible:

- `list`: returns at most 64 opaque handles and bounded metadata for generated images owned by the
  caller's exact durable session; it is not a general history lookup.
- `save`: accepts one opaque handle, an approved destination path, and `source: original | preview`
  (default `original`).

The model chooses the destination. A project association supplies convenient cwd only; sandbox and
live write permission still authorize the path.

### 11.2 Original retrieval

For `source: original`, main obtains a one-use browser transfer claim bound to the exact session,
conversation, document/navigation epoch, canonical provider message, provider asset, and local file
operation. The extension revalidates the live asset and streams bounded bytes to main without
publishing the signed URL.

Main validates the declared/decoded image type and shared generated-asset limits, stages bytes beside
the destination, revalidates target access and destination revision, flushes, then atomically
renames. A concurrent external edit is not overwritten. The original bytes are preserved after
validation.

If the live provider asset is unavailable, the operation fails explicitly. It does not silently
substitute the preview.

For `source: preview`, the existing exact local asset reader supplies the bounded recorded WebP.
The result names it as a preview.

### 11.3 Custody and replay

Each save operation has one claim and one recorded outcome. Ambiguous browser transfer or write
publication is never automatically replayed. Handles grant no browser action or filesystem access
outside the exact tool call. Human Downloads do not widen model permissions, and model save
permission does not authorize a human download.

`GENERATED_ASSET_LIMITS` in shared code is the single bound owner: 64 MiB compressed bytes and
40 million decoded pixels per original, 512 KiB bridge chunks, two concurrent original transfers,
120 seconds per transfer, 20 assets and 512 MiB aggregate bytes per batch. The extension, bridge,
main decoder, Core schema, and renderer batch admission enforce the same values. MIME admission is
limited to formats already accepted by ChatBBC image validation; adding another format requires
updating every participant and its decoding proof together.

## 12. Renderer architecture

### 12.1 Technology

Keep TypeScript and the current Electron/Vite toolchain. Do not add React, Vue, or another runtime UI
framework solely for this redesign.

Feature components use explicit lifecycle functions:

- `mount(host, dependencies)`;
- `update(validatedViewModel)`;
- `dispose()`.

Feature controllers own async requests, generations, cancellation, and receipts. Components own DOM
and transient presentation state only.

### 12.2 Layers

1. **App shell:** rail, navigator, conversation stage, workbench, responsive layout.
2. **Presentation store:** immutable versioned projections of validated IPC state.
3. **Feature controllers:** named owners for chat/history, composer/outbox, files, agents, terminal,
   settings/setup/plugins/usage, and rich outputs.
4. **View components:** keyed DOM reconciliation and local interaction state.
5. **Design system:** semantic tokens, typography, geometry, depth, focus, motion, and shared
   primitives.

There is no generic event bus. Cross-feature updates use typed store actions or named controller
methods.

### 12.3 Data flow

```text
main/shared authoritative owner
        -> validated IPC snapshot/delta
renderer presentation store
        -> bounded selector
feature view model
        -> component DOM

trusted user action
        -> feature controller + exact owner/generation
        -> fixed preload IPC
main/extension authority
        -> durable result or explicit uncertainty
        -> presentation update
```

Optimistic UI may display `pending`, never `succeeded`. Renderer storage must not become a second
session, queue, project, worker, terminal, or browser-action ledger.

## 13. Failure behavior

- Invalid/unavailable Omarchy input retains the last valid snapshot or built-in Crystal default.
- Missing compositor blur uses the atmospheric fallback without a layout change.
- Theme changes preserve focus, selection, drafts, scroll, dialog ownership, and dirty settings.
- Rich capture failure produces a complete accessible fallback, not a partial component.
- Choice uncertainty remains unconfirmed and is not retried.
- Missing original images retain truthful preview/unavailable state.
- Batch operations expose each asset's result.
- Old async renderer replies are rejected by component instance, selection generation, and domain
  owner.
- Renderer reload paints readable backing before transparent glass.
- Every error names the next possible action without claiming login, connection, or permission
  failure unless evidenced.

## 14. Accessibility and internationalization

- Full keyboard traversal for rail, navigator, transcript controls, workbench, dialogs, galleries,
  and decision cards.
- Deterministic focus return after drawers, viewers, focused artifacts, and dialogs close.
- Focus indicators do not depend on color or glow.
- Screen-reader labels distinguish original, preview, pending, unavailable, and historical states.
- Minimum target sizes remain usable at enlarged zoom.
- Authored prose retains automatic text direction; shell/code remain LTR with logical edges.
- Reduced motion removes nonessential transitions.
- Glass contrast is evaluated after compositing against the worst permitted background.
- Existing English, Spanish, Simplified Chinese, and Traditional Chinese localization mechanisms
  remain; new user-facing strings receive translations in the same change.

## 15. Performance

- No permanent animation loop for static glass.
- No full transcript repaint for theme, status, or one revised message.
- Keyed rows and image slots remain mounted when identity is unchanged.
- Images hydrate on viewport admission and release decoded memory offscreen.
- Panel resizing and disclosure changes do not change transcript prose width unexpectedly.
- Theme events coalesce into one validated publication.
- Existing history, text, image, queue, and IPC budgets remain in force.
- New rich downloads/transfers receive shared bounds for items, bytes, pixels, chunks, concurrency,
  and wall time.

## 16. Migration and cutover

Implementation follows dependency order while each completed slice replaces its predecessor:

1. Crystal tokens, transparent-window/fallback behavior, immediate Omarchy owner, and app shell.
2. Chat navigator, selection, paged transcript, scroll preservation, composer, queue, plan, and
   recovery.
3. Workbench: Files/editor, terminal, agents, output inspector, and session metadata.
4. Settings, Setup, Plugins, Usage, appearance, dialogs, and notifications.
5. Decisions, artifacts, image sets, downloads, and agent asset retrieval.
6. Remove old DOM, paint paths, CSS, obsolete preferences, aliases, and obsolete tests.

Development may use a developer-only gate for incomplete slices. The shipped product has one shell
and one presentation path; there is no permanent classic mode or duplicated renderer authority.

The previous Omarchy redesign document is superseded rather than partially combined. Its durable
session-lineage insights may be reused where consistent, but its square/hairline presentation,
presentation-only scope, manual theme refresh, and in-window-only translucency are obsolete.

## 17. Verification

### 17.1 Contract and unit

- Omarchy snapshot parsing, watch coalescing, generation ordering, and fallback.
- Semantic token derivation and composited contrast.
- Presentation-store selectors and async generation fences.
- Rich schema/static sanitizer rejection cases.
- Decision intent/action/receipt transitions.
- Image-set grouping by canonical response identity.
- Human download and agent transfer custody, bounds, permissions, and no-replay behavior.

### 17.2 Renderer DOM

- Keyboard/focus behavior and focus return.
- Responsive collapse order.
- Retained drafts, disclosure, image slots, and timeline rows.
- Long-history paging and live updates.
- Single/multi-image gallery behavior and partial batch results.
- Locale changes without authored-content mutation.

### 17.3 Real Electron

- Transparent-window startup and fallback.
- Immediate Omarchy switching while editing and while dialogs are open.
- Zoom, narrow/wide layout, panel resizing, terminal, project editor, and long-history scrolling.
- Reduced motion and high-contrast themes.

### 17.4 Real Hyprland/Omarchy

Verify native transparency and scoped blur with compositor blur enabled and disabled. Confirm the
app does not mutate user compositor configuration and that fallback mode remains readable.

### 17.5 Signed-in ChatGPT

Before enabling mutations, inspect and reproduce:

- option/radio/checkbox grouping and exact selection/Continue postconditions;
- semantic and unsupported rendered artifacts;
- single, gallery, and image-only generated responses;
- provider original URLs/actions and Chromium download receipts;
- navigation, reload, stale-document, duplicate-node, and partial-download cases.

Then repeat the live flow with the changed extension and installed/development app as appropriate.
Source tests alone do not prove these provider-facing behaviors.

### 17.6 Build/package

Run the nearest renderer/main/extension suites and `npm run verify` for production changes. Run
build/package checks where transparent BrowserWindow options, extension permissions, or packaged
resources differ from development.

## 18. Acceptance criteria

The redesign is complete only when:

- the shipped app has one chat-centric Crystal shell with no user-facing old UI;
- Omarchy palette/mode/font changes update an open window without manual refresh;
- native transparency/blur and atmospheric fallback are both truthful and readable;
- every existing user workflow remains reachable with its exact ownership semantics;
- transcript/composer remain primary at every supported width;
- decisions, artifacts, and image sets render as first-class chronological content;
- trusted live choices either confirm an exact native postcondition or remain visibly unconfirmed;
- human original downloads land through Chromium's Downloads path with per-asset receipts;
- preview saves are explicitly labelled previews;
- agents can list/save exact generated assets only to permission-checked approved paths;
- stale owners, navigation, ambiguity, revocation, and concurrent edits fail closed;
- accessibility, performance, real Electron, real Omarchy, and signed-in ChatGPT evidence match the
  claimed level;
- old presentation code, conflicting specifications, obsolete preferences, and temporary migration
  gates are removed or explicitly retired.
