# ChatBBC Omarchy redesign — design

**Date:** 2026-09-18
**Status:** superseded on 2026-09-21 by
[`2026-09-21-chatbbc-crystal-studio-redesign-design.md`](./2026-09-21-chatbbc-crystal-studio-redesign-design.md)
**Historical scope:** presentation-only Omarchy alignment. The replacement design intentionally
broadens the product and rich-output behavior.

## 1. Problem

ChatBBC presents itself as a generic dark chat app: near-black `#181818` page, `#262725` cards,
light-blue `#b0cbed` accent, system sans throughout, and generous radii (`6/10/14/18/24px` + pill).
This desktop is Omarchy on Hyprland with the **Osaka Jade** theme, `decoration:rounding = 0`,
Iosevka Nerd Font Mono at size 8 in the terminal, and a shell bar at base-size 11.

Nothing about the app belongs to the machine it runs on. This design makes the app take the
desktop's palette and idiom — square corners, hairline structure, monospace chrome — and fixes
the shell's real defects: a fragmented six-tab settings nav, five heterogeneous rows stacked above
the composer, and an unlabelled icon cluster in the composer toolbar.

## 2. Decisions taken in brainstorming

| # | Section | Decision |
|---|---|---|
| 1 | Transcript | Message cards (prototype B). Real conversation gets cards; generated work gets control rows, not cards |
| 2 | Composer | One expandable status line replaces the five dock rows |
| 3 | Sidebar | Nav + session list + one dense footer row; Settings reuses the sidebar slot |
| 4 | Settings | Destinations become Workspace · Automation · Appearance · Usage · Activity |
| 5 | Theme | `Theme = Light \| Dark \| Follow desktop`, explicit toggle; manual colors apply in Light/Dark only |
| 5b | Font | Read the desktop's terminal font; fall back through a mono chain |
| 6 | Motion | Functional motion only; icon sprite redrawn as one uniform stroke set |
| 7 | Work panel | Tabbed right panel: Files · Sub-agents · Terminal |
| 8 | Transcript content | Every content family has its own accent, glyph and edge; one shared geometry |
| 9 | Full pages | Neutral pages; identity comes from the cards' category colours, not a page colour |
| — | Identity | Session spine (§4.1) and delivery-stage messages (§4.2) are the product-derived elements; §2.1 records what is ordinary practice |

Scope was explicitly set to **skin + layout, every feature kept**. No feature is removed, merged or
re-routed; only where things sit and how they are drawn changes.

## 2.1 Design identity — what is ours, and what is merely competent

Research into other agent-harness UIs informed this design only at the level of *ordinary good
practice*. Nothing in it is copied as a look, and no choice below is justified by "another app does
it". The distinction matters, so it is written down:

**Ours — exists because of this product's own durable model:**

| Element | Why it can only be this product |
|---|---|
| The session spine (§4.1) | This app separates a durable local session from a replaceable ChatGPT chat. The spine is that separation made visible. |
| Frontend segments (`frontend 1 · chat A`) | Only an app with Compact & Resume has numbered frontends inside one conversation. |
| Delivery-stage messages (§4.2) | Seven recorded outbox states, four of which the product insists are different facts. |
| Generated-control rows (§4.1) | The model distinguishes authored from generated text (`authoredSource`, `finishOwner`); the UI refuses to blur it. |
| Worker identity (`worker-2` scoped to its prime) | Several independent prime families can each own a `worker-1`; the UI must name the family, not just the slot. |
| Category identity per content family (§4.7) | 14 recorded event kinds with real differences (tool outcome, attribution, evidence level) rather than one generic "message". |
| Follow-desktop theming (§5) | Derived from this machine's own Omarchy theme files. |

**Ordinary practice — would be proposed for any dense desktop app:**

Square corners because the desktop is square; monospace chrome for a developer tool; hairlines
instead of card borders; labelled controls instead of bare icons; one status line instead of five
stacked rows; a tabbed side panel; reduced radius on hover/active fills; a mono fallback chain;
respecting `prefers-reduced-motion`. None of these is an identity, and none is claimed as one.

**Deliberately rejected from the research.** Three patterns were considered and dropped because they
conflict with this product's own contracts rather than because they are ugly:

1. **Computed `--contrast-*` overlay tokens.** This repo already has a per-theme `contrast` integer
   doing that job; two overlapping mechanisms would give one fact two owners (`AGENTS.md` §4).
2. **A narrow centred transcript column.** A tool call, a patch, a diff and a worker report all need
   width here; a 48rem column would force permanent horizontal scrolling on the content that matters.
3. **Assistant messages with no author label at all.** Acceptable in a single-author chat app;
   wrong here, where generated instructions and worker reports share the same stream as the user.

## 3. Design tokens

### 3.1 Geometry — square

`decoration:rounding = 0` is the desktop's corner language, so the app adopts it.

```css
--r-xs: 0; --r-sm: 0; --r-md: 0; --r-lg: 0; --r-xl: 0; --r-pill: 0;
```

Every existing consumer of these tokens becomes square without a second rule. Switch tracks and
knobs are square too — a pill switch beside square panels is the one shape that would read as a
leftover. The radius token *names* stay, so `styles.css` keeps one geometry vocabulary and a
future theme can raise them.

Where a radius carried meaning (the composer's floating card), the shape is replaced by a hairline
border and a flat fill rather than a rounded rect.

### 3.2 Structure — hairline, not card

Today structure is carried by bordered cards (`1px solid var(--line)` + `--card` fill) on a
near-black ground. The new structure is **tonal bands separated by hairlines**:

- Section separation: `border-top: 1px solid var(--line)` on the following row, never a wrapper box.
- Group separation: one flat surface, rows divided by hairlines — expressed as this repo's own
  `.stack > * + *` rule so the idiom has one definition.
- Hover/selected state: a fill change (`--hover`, and the theme's `selection` for selected),
  never a border colour change.

`--lift` (the card drop shadow) goes to `none` in both themes. The desktop's own surfaces have no
shadows; the app keeps at most a single soft shadow on genuinely floating surfaces (dialogs,
popovers).

Translucency is unchanged and is not a new risk: the existing sidebar treatment is a tinted
gradient composed *inside* the window (`mixColor(sidebar, background, .13)` plus an in-window
`backdrop-filter`), not a see-through native window, so there is no GPU/compositor dependency to
fall back from. Dialogs and popovers keep their existing opaque fills.

### 3.3 Typography — mono chrome, sans prose

Two type roles, both explicit tokens:

```css
--ui-font:      /* prose — unchanged existing setting (system | sans | serif | mono) */
--ui-font-mono: /* chrome — resolved mono chain (see §6) */
```

- **Mono (`--ui-font-mono`)**: navigation, labels, buttons, status, counts, timers, file paths,
  tool names, diffs, code, metadata, everything in the sidebar and settings.
- **Sans (`--ui-font`)**: authored and assistant prose only, in the transcript.

Base scale is unchanged, and that is deliberate. `--text-scale` is `fontSize / 14`
(`src/renderer/appearance.ts:24`) and **241 rules** in `styles.css` are written as
`calc(Npx * var(--text-scale))`. Changing the default `fontSize` would move all 241 at once, so the
default stays **14** and density is instead authored where it belongs — in the chrome rules:

```css
/* chrome: dense by default, still honours the user's text-size preference */
.nav a, .card .hd, .trow { font-size: calc(11px * var(--text-scale, 1)); }
```

`fontSize` keeps one owner (the user's text-size preference, 12–18, validated as today) and the
design's own density is a stylesheet decision. A user who picks 18 gets 14px chrome and 18px prose;
the default gives 11px chrome and 14px prose.

`FONT_FAMILIES.mono` currently reads `'"Cascadia Mono", Consolas, monospace'` — a Windows-first
chain. It is replaced by the mono chain in §6.

### 3.4 Palette — semantic roles, one source

`shared/appearance.ts::paletteTokens()` stays **the single projection** from a palette to CSS
tokens; every surface keeps reading named tokens, never raw hex. Two changes:

1. Status colours stop being hardcoded. `paletteTokens` gains an optional
   `status?: { green, red }` argument; when a followed theme supplies its own `green`/`red`
   (Osaka Jade: `#549e6a`, `#FF5345`), those are used instead of `#258552`/`#d44545`. Default
   behaviour with no argument is byte-identical to today.
2. Sidebar derivation is unchanged (`mixColor(sidebar, background, .13)` when translucent).

`--contrast-*`: not adopted. This repo already has a per-theme `contrast` integer doing that job, and
adding a second overlapping mechanism would give one fact two owners (see §2.1). The existing
`contrast` control is kept as the owner and the follow-mode palette supplies a sensible value (§5).

## 4. Layout

### 4.1 The transcript is a durable local session, not a chat log

Before any card: the transcript's identity is **not** the ChatGPT conversation. In this product a
*local session* is durable, and the ChatGPT chat it currently runs in is replaceable — Compact &
Resume moves the same session from frontend A to frontend B while the session id, project, history,
queue, worker family and terminal custody all stay (`AGENTS.md` §§1, 15).

The current UI shows that as a `resumed` badge on a session row; inside the transcript the boundary
between two frontends is invisible. The redesign makes the **spine** visible: the transcript is a
continuous column belonging to the session, and each frontend it has run in is a labelled segment of
that column.

```
╔ SESSION b7f2 · chatbbc · 4 hours ═══════════════════════════╗
║                                                            ║
║   ▏ frontend 1 · chat A · gpt-5.6 sol                      ║
║   │                                                        ║
║   │   ┌ YOU ──────── collapse the settings nav ┐           ║
║   │   ┌ CHATBBC ─── Six destinations become… ┐             ║
║   │                                                        ║
║   ╞═ ⇄ COMPACT & RESUME · 14:52 · brief 4.1k ══════════════╡
║   ▏   summary · capture · elect · commit · publish         ║
║   │                                                        ║
║   ▏ frontend 2 · chat B · gpt-5.6 sol                      ║
║   │   ┌ CHATBBC ─── Resuming the same session… ┐           ║
║   │                                                        ║
╚════════════════════════════════════════════════════════════╝
```

- The spine is one vertical hairline down the left of the transcript, in the session's accent.
- A **frontend segment header** opens each run: `frontend N · chat A|B · model`. `N` is derived from
  the recorded handoff lineage (the same lineage the `resumed` badge already uses, `chat.ts:351`),
  not from a new counter.
- The handoff row sits **on** the spine, so a compaction reads as a joint in one continuous thing
  rather than a new conversation that happens to follow another.
- The queued input, project and worker family visually belong to the session — they are drawn
  inside the spine, above the frontend they target.
- The spine is presentation only. It reads `handoff`/`resume` events and session metadata that already
  exist; it decides nothing and grants nothing.

This is the single element of the redesign that could not be lifted onto another chat app: it exists
because this product separates the durable session from the disposable frontend.

**Real conversation → cards.** Inside a frontend segment, one card per authored user message and per
assistant response:

```
┌ YOU · 14:31 ─────────────────────────── gpt-5.6 sol · high ┐
│ collapse the settings nav                                  │
└────────────────────────────────────────────────────────────┘
┌ CHATBBC · 14:31 · 36s ───────────────────────── 1.2k tokens ┐
│ Six destinations become three. …                            │
└────────────────────────────────────────────────────────────┘
```

- User card: jade left edge (`border-left: 2px solid var(--accent)`), header label `YOU`.
- Assistant card: hairline border, header label `CHATBBC`, header carries time and tokens.
- Prose inside a card uses `--ui-font`; headers use `--ui-font-mono`.
- Cards share one max-width column, and the composer aligns to that same column.
- Interim assistant prose keeps its existing distinct streaming presentation; it is not promoted to
  a final card until the turn's canonical final arrives (unchanged behaviour, restyled).

**Generated work → control rows, not cards.** The data model already separates authored from
generated text (`authoredSource`, `finishOwner`, agent reports); the UI must not flatten that into
"looks like the user". Rows:

```
  ⇢ LOOP        keep going: verify the suite
  ⇢ CHECKPOINT  2 of 5 · run the suite
  ⇢ WORKER      worker-2 · 3 files changed
  ⇢ SYSTEM      identity recovered for this request
```

- `⇢` glyph + a label naming the real origin (`LOOP`, `GOAL`, `CHECKPOINT`, `WORKER <name>`,
  `SYSTEM`), then the text.
- A control row is not a card: no card fill, no card border, indented, mono throughout.
- Which label applies is derived from data already recorded — `authoredSource: none` on a generated
  opening, `finishOwner` on an automatic message, the agent broker's report identity. No new
  tracking, no inference from text.

Mapping of existing render kinds, so nothing is lost: local tool calls keep their own row style
(dense single line, expandable); native ChatGPT tool/progress rows stay native; app error and
recovery notices become `SYSTEM` control rows; worker reports become `WORKER` control rows.

### 4.2 The message as a lifecycle object (Composer, outbox, status)

This product's central claim is that **a message's delivery state is a fact with stages**, not a
boolean. `src/main/session/input.ts` records seven real states:

```
state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision'])
```

and the renderer currently flattens almost all of them into a bare `i-clock` icon with the real
wording hidden in a `title` tooltip (`chat.ts:3328-3342`):

```js
entry.state === 'browser' ? t("Delivery confirmation pending")
: entry.state === 'tool'  ? t("Sent to the active turn · awaiting receipt")
: entry.delivery === 'tool' ? t("Waiting for the next tool call") : t("Queued")
```

**The redesign promotes the delivery stage to a first-class visual.** An authored message is not a
bubble that appears and disappears; it is an object that travels, and its travel is legible:

```
 ╭ QUEUED     ──────────────────────────────────────────────╮
 │ in the outbox · not yet in ChatGPT                       │
 ╰──────────────────────────────────────────────────────────╯
 ╭ SCHEDULED  ── after turn ends · 14:52 ────────────────────╮
 │ in the outbox · waiting for a verified completion         │
 ╰──────────────────────────────────────────────────────────╯
 ╭ IN COMPOSER ── unelected tab 8765 ────────────────────────╮
 │ inserted into the ChatGPT composer · not sent             │
 ╰──────────────────────────────────────────────────────────╮
 ╭ SENT       ── receipt 14:31:08 ───────────────────────────╮
 │ ChatGPT accepted it · message id 0f3c…                    │
 ╰──────────────────────────────────────────────────────────╯
 ╭ NOT SENT   ── browser did not pick it up in 60s ──────────╮
 │ still yours to retry or withdraw                          │
 ╰──────────────────────────────────────────────────────────╯
```

Rules:

- The state label is **text, always visible** — never a tooltip-only icon. The existing strings are
  the source; they are promoted from `title` to label.
- The four distinguishable facts from `AGENTS.md` §11 are never merged: *queued*, *put into the
  composer*, *ChatGPT accepted it*, and *sent-to-the-turn awaiting receipt* each get their own label.
- A stage **advances in place**: the same object changes label and edge as it moves, so the
  transcript shows one message with a history rather than three lookalike rows.
- `cancelled` and `failed` are terminal and visually distinct (red edge, `NOT SENT`); they stay
  yours to retry or withdraw, and the retry affordance is the existing one.
- No new state, no new timer, no new owner: this is a projection of `InputRow.state` plus the
  existing `error`, `dueAt`, `deliveredAt`/`offeredAt` and receipt fields.

The **composer** itself follows from that: it authors the object, so it is visually the *head* of
the outbox rather than a detached card.

`#composerDock` currently stacks five heterogeneous blocks: `agentPlan`, `recoveryStatus`,
`taskPlanPreview`, `finishQueue`, `activeGoalRow`. They are replaced by **one status line** directly
above the composer:

```
▸ loop · plan 4/9 · queue 1 · settling 0:42
```

- Segments appear only when that fact is live; an idle chat shows no status line at all.
- Each segment projects the same data the current block renders — the mode from the Goal switch,
  `plan 4/9` from `plan.json`, `queue N` from the outbox, `settling 0:42` from the existing
  recovery/listening deadline. No new timer, no new owner.
- Clicking the line expands it in place to the current blocks' content. Expansion is presentation;
  the underlying rows keep their existing behaviour and identities.
- The countdown segments keep the existing read-only contract: a countdown grants no authority.

The composer's own surface is square, hairline-bounded and flat. The toolbar's icon cluster is
regrouped and **labelled** — the previous version left five unlabelled glyphs in a row, which is the
worst part of the current UI:

```
┌──────────────────────────────────────────────────────────┐
│ Reply to ChatBBC…                                        │
├──────────────────────────────────────────────────────────┤
│ ＋ Attach   │   ◆ Ordinary ▾   gpt-5.6 sol ▾   high ▾   ↑  │
└──────────────────────────────────────────────────────────┘
```

- `＋` becomes an explicit `Attach` control (it already opens `#attachmentMenu`).
- The mode control (currently a radio group behind `#composerSettings`) becomes a visible labelled
  mode control: `Ordinary` / `Goal` / `Loop`.
- The context meter (`#contextMeter`) is **a feature, not clutter**: it becomes a labelled segment of
  the status region — `context 41.2k` — keeping its honest "estimated" wording.
- The pet sprite gets a label or moves into the `＋` menu; it keeps its existing launcher visibility
  preference (`cos.ui.turTurPet.v1`).
- The model and reasoning pickers keep their existing menus and are surfaced as labelled selects.
- Send becomes a square accent button.

### 4.3 Sidebar (`index.html`, `main.ts`, `sidebar-resize.ts`, `sidebar-order.ts`)

Sidebar holds, top to bottom: brand + product mark, the five destinations, a hairline, the session
list (Projects / Chats, unchanged behaviour and ordering), a hairline, one dense footer row with
connection status and Settings.

`New chat` and `Plugins` move into the session-list header area rather than occupying their own
full-width buttons.

Settings reuses the sidebar slot: selecting a destination replaces the session list with the
settings nav and a `← Back to chat` row, and the *body* renders the destination page. Same slot,
same width, same primitives — not a second screen with its own nav.

### 4.4 Settings pages

Destinations and their contents:

| Destination | Contents |
|---|---|
| Workspace | approved folders, connector, tunnel, health, plugins, the Setup wizard entry |
| Automation | continuation sources, ChatGPT models, Goal/Loop, workers, finish behaviour |
| Appearance | theme (Light / Dark / Follow desktop), colors, font, language, setup profiles |
| Usage | usage charts, image storage |
| Activity | worker/agent activity feed |

Nothing is removed: `Setup` stops being a nav peer and is reached as a card inside Workspace, which
preserves the existing six-step wizard and its `setupBadge` as an indicator on Workspace.
`renderer/setup-guide.ts` and its screenshots are unchanged.

Each page uses the dense row idiom: grouped flat surfaces, rows divided by hairlines, control in a
reserved right column so controls do not jitter row to row.

### 4.5 Motion and icons

Motion is functional only: the existing live-tool shimmer while a tool runs, a short (~120ms) fade
for newly appended transcript rows, and hover/active fills. No decorative animation, no gradient
sweeps, no parallax. Every animation stays behind the existing reduced-motion guard.

The icon sprite is redrawn as one uniform set: 1.5px stroke on the existing 24 grid, at 16/18/20px
tiers, all `currentColor`, replacing today's mixed weights. Icon *ids* are unchanged, so no
consumer changes.

### 4.6 Work panel — Files · Sub-agents · Terminal

Files and Sub-agents currently share one resizable right slot (`work-panel-resize.ts`), and the
human terminal is a separate bottom drawer (`workspace-terminal.ts`, up to eight tabs).

They become **one tabbed right panel** with a dense mono tab strip:

```
│ prose column                 │ Files │ Sub-agents │ Terminal │
│                              │───────────────────────────────│
│                              │ ▾ src/                        │
│                              │   main/                       │
```

- One geometry, three tenants. Selecting a tab keeps the others' state; the panel remembers the
  active tab.
- The tab strip is one row of mono labels with a fill on the active tab — the same selected-state
  fill the sidebar uses, not an underline.
- Resizing keeps the existing `work-panel-resize.ts` behaviour (host width minus 360px for chat,
  no fixed maximum).
- **The terminal tab needs room.** A terminal in a 400px panel is ~50 columns, which is not a usable
  build-output width. The terminal tab therefore widens the panel to its existing maximum when
  selected, and the existing per-tab PTY behaviour, the 256 KiB output pause, the 5,000-line
  scrollback and the eight-tab limit are all unchanged.
- Panel hiding, Escape, watcher retirement and unsaved-draft retention keep their existing owners.
  Nothing about `file-panel.ts`'s 500-entry directory reads, 128 watches, or its 8 unsaved drafts
  changes.

### 4.7 Transcript content categories

The transcript carries 24 recorded `kind`s. Rather than one generic block, **each content family
has its own identity** — its own accent colour, glyph and edge treatment — while sharing one
geometry contract.

Shared geometry (non-negotiable, so the transcript stays scannable):

- every category is left-aligned to the same column, with or without the card indent;
- one 1px hairline (`var(--line)` family) as the outer edge;
- one header height and one header type size (`calc(10.5px * var(--text-scale))`);
- accent colour appears only on the **left rail, the glyph, the header label and the metadata** —
  never as a large fill, so a busy transcript does not become a patchwork.

| Category | Accent | Glyph | Distinctive treatment |
|---|---|---|---|
| Authored | jade | — | 2px jade left rail, `YOU` label |
| Assistant prose | neutral | — | plain hairline card, `CHATBBC` label, sans prose |
| Code | cyan | `◆` | line-number gutter, language tag, copy action |
| Diff | green/red | `±` | `+`/`−` gutter columns, hunk header, `+n −n` summary |
| Image | neutral | `▣` | framed preview, caption strip with dimensions and size |
| Tool call | green status | `●` | dense one-line row, timing and exit as columns |
| Error | red | `!` | red left rail, action row (`Show diff`, `Retry`) |
| Recovery | amber | `◔` | live countdown in tabular numerals |
| Generated control row | per origin | `⇢` | tag column (`LOOP` / `GOAL` / `CHECKPOINT` / `WORKER n` / `SYSTEM`) |
| Compaction & handoff | ice blue | `⇄` | five-step phase strip (`summary · capture · elect · commit · publish`) |
| Agent plan | jade | `▤` | numbered steps, done steps struck through, current step on the selected fill |
| Note | faint | — | no edge, centred rule, muted |

Category colours come from the followed palette's own roles (§3.4) so they remain meaningful under
any Omarchy theme; a theme that supplies `cyan`, `magenta` and `amber` gets those, and the built-in
default theme supplies its existing equivalents.

The mapping is a single lookup in the renderer, not a chain of conditionals. Two distinct
vocabularies feed the transcript and must not be conflated — the same word means different things
in each:

**Recorded `SessionEvent` kinds — 13** (`src/shared/session.ts`, the `SessionEvent` union):
`session_start`, `user_message`, `assistant_message`, `tool_call`, `page_tool`, `native_image`,
`agent_message`, `progress`, `chat_error`, `note`, `handoff`, `turn_start`, `turn_end`.

**`SessionOrigin` kinds — 4, not events** (`session.ts:460`): `'resume' | 'worker' | 'helper' |
'desktop'`, with `fromSessionId`, `agentId` and `task`. These attach to a *session*, not a row.

**The collision to avoid:** `resume` is **only** a `SessionOrigin` kind; it is not a `SessionEvent`.
The session spine (§4.1) reads `SessionOrigin` lineage plus the `handoff` **event**, which carries
`handoffId`, `chars` and `reason`. Getting this backwards would put the spine on the wrong owner.

Category mapping for the 13 recorded kinds, so every one is covered:

| Kind | Category |
|---|---|
| `user_message` | authored |
| `assistant_message` | assistant prose |
| `tool_call`, `page_tool` | tool row |
| `native_image` | image |
| `chat_error` | error |
| `progress` | recovery |
| `note` | note |
| `handoff` | compaction & handoff (also draws the spine joint) |
| `agent_message` | worker control row |
| `session_start`, `turn_start`, `turn_end` | structural — no row unless the existing renderer already shows one |

`test/renderer-timeline.test.ts` and `test/renderer-agent-plan.test.ts` cover the existing transcript
rendering; they are extended, not replaced, to assert the category mapping.

### 4.8 Full pages

Pages stay **neutral**: they carry no page-level accent colour. Differentiation comes from the
category identity of the cards inside them (§4.7), so no new colour vocabulary is introduced.

Each page keeps the shared block geometry; only the card accents vary. The constraint from §4.7
applies — accent on edge, glyph, label and metadata only, never a large fill, so a dense page like
Plugins does not read as a patchwork.

Existing page behaviour is unchanged: plugin install/enable/disable state, the usage charts and
their local-estimate wording, the activity feed, the Workspace health checks and root management,
and the six-step Setup wizard with its screenshots.

## 5. Theme engine

### 5.1 Source of truth

Omarchy materialises the active theme at a stable path, written by Omarchy's own
`omarchy-theme-set`:

```
~/.local/state/omarchy/current/theme/colors.toml     # palette (mode, accent, background, …, green, red)
~/.local/state/omarchy/current/theme.name            # e.g. "osaka-jade"
~/.local/state/omarchy/current/theme/alacritty.toml  # terminal font, when the theme ships one
```

These are the only files read. Nothing in `~/.config/omarchy/` is written, and
`/usr/share/omarchy/` is never touched.

### 5.2 New owner

`src/main/omarchy-theme.ts` — one new module, one responsibility: read and parse that directory.

```ts
export interface OmarchyTheme {
  name: string;                  // from theme.name
  mode: 'light' | 'dark';        // from colors.toml `mode`
  background: string; accent: string; sidebar: string;
  green: string; red: string;
  fontFamily: string | null;     // from the theme's alacritty.toml, else null
}
export function readOmarchyTheme(): OmarchyTheme | null;
```

- Returns `null` for any failure: no Omarchy, missing file, unreadable, unparseable, or a colour
  that is not `#rrggbb`. **Never throws.** A null result falls back to the built-in palette.
- Bounded: reads at most 64 KiB per file; a flat `key = "#hex"` scan, not a full TOML parse, so a
  format change degrades to "missing key" instead of a thrown parse error.
- `sidebar` is the theme's `lighter_background` when present, else
  `mixColor(background, accent, .12)` using the existing helper — the same derivation the app
  already uses for tinted sidebars.
- `contrast` is chosen from the background's luminance via the existing `readableInk`/`contrastRatio`
  helpers: a dark ground gets 60, a light ground 45 — today's defaults — so followed themes keep the
  legibility the manual palettes have.

### 5.3 Configuration

`ui.appearance` gains one field:

```ts
followDesktop: boolean   // default false
```

Validated by `appearance-schema.ts` like every other appearance field. Malformed or absent reads as
`false`, which is the existing behaviour — no user is switched into follow mode by a parse failure.

**Manual palettes are never overwritten.** Follow mode is resolved at load time: main computes the
Omarchy palette and publishes it as the *effective* palette for the theme matching `mode`, while the
user's saved `light`/`dark` palettes stay untouched in `config.json`. Turning follow off restores the
saved colours exactly.

Because `ui.theme` remains `'light' | 'dark'` as the effective theme, every existing consumer is
unchanged — `applyAppearance`, `titleBarOverlayForTheme` and `windowBackgroundForTheme` need no
edit. In follow mode the effective theme is the Omarchy theme's `mode`, so a light Omarchy theme
produces a light ChatBBC without a second code path.

No filesystem watcher. Changes to the desktop theme are picked up at startup, on save, and via an
explicit **Refresh from desktop** control on the Appearance page. An explicit toggle that silently
repaints is worse than one that waits to be asked.

## 6. Font resolution

`--ui-font-mono` resolves through a documented chain, first match wins:

1. `fontFamily` from the followed Omarchy theme (§5.2), quoted.
2. `Iosevka Nerd Font Mono` — this machine's terminal font.
3. `JetBrains Mono Nerd Font`, then `JetBrains Mono`.
4. `"Cascadia Mono", Consolas` — the existing chain.
5. `ui-monospace`, then `monospace`.

Resolution happens in the renderer against the measured availability of the first candidates, so a
machine without Iosevka gets a real mono rather than a proportional substitution. A proportional
fallback would silently break every alignment in the new dense layout, which is why `ui-monospace`
is last and `monospace` is the final backstop.

`--ui-font` (prose) keeps the existing `APPEARANCE_FONTS` setting and the existing picker.

## 7. What does not change

- **Features and behaviour.** No tool, surface, capability, queue rule, recovery rule, worker
  lifecycle or IPC contract changes. This is presentation.
- **`ui.theme`, `ui.appearance.{light,dark,font,fontSize,translucentSidebar}`** — same shapes, same
  validation, plus the one new boolean.
- **Internal prefixes** (`CLF_*`, `COS_CONTEXT`, bridge ports 8765–8769) and the session directory
  shape.
- **Icon ids**, element ids and class names that existing scripts and modules depend on. New markup
  is added and restyled in place; ids are not renamed.
- **Localisation.** The five destination names, control-row labels and composer labels are new
  user-visible strings and go through `i18n.ts` with `locales/es.json` and `locales/zh-CN.json`
  entries, following the existing `WeakMap`-bound node approach.
- **The pet.** Its gesture, animation and preference are untouched beyond the composer launcher
  moving into the `＋` menu.

## 8. Verification

This is a renderer/shell change, so the proof is visual plus the repo's existing Electron fixtures.

**Must pass unchanged**, because they encode contracts this design keeps:
`verify-appearance.cjs`, `verify-chat-width.cjs`, `verify-composer-layout.cjs`,
`verify-dropdown-layout.cjs`, `verify-settings-focus.cjs`, `verify-sidebar-setup.cjs`,
`verify-connection-compact.cjs`, `verify-connection-layer.cjs`, `verify-renderer-label-memory.cjs`,
`verify-history-scroll.cjs`, `verify-chat-opening-scroll.cjs`, `verify-chat-switch.cjs`,
`verify-composer-context.cjs`, `verify-setup-guide.cjs`, `verify-disconnect-ui.cjs`,
`verify-goal-status-layout.cjs`, `verify-plan-collapse.cjs`, `verify-pr-workspace.cjs`,
`verify-workspace-terminal.cjs`, `verify-pet-electron.cjs`.

No `verify-*.cjs` script asserts a radius, so `rounding = 0` and the hairline idiom do not require
retargeting any of them. `verify-appearance.cjs` does assert type, and both assertions keep passing:
`:130` expects the body font family to follow the *prose* picker to serif, and `:132`/`:146` expect
the text size to follow the picker and reset to 14. This design leaves the prose font picker, the
text-size control and their defaults untouched (§3.3) and adds a separate `--ui-font-mono` for
chrome, so no existing type assertion moves. The assertions that will need attention are
`test/renderer-layout.test.ts` and `test/appearance.test.ts` if the mono chrome changes measured
widths; they are retargeted to the new contract, not deleted, and any script that fails **only** on
a deliberate colour or geometry change is updated rather than silenced.

**New evidence:**
- Screenshots of every destination and the transcript at 1600×900 and a narrow width, from the real
  build with the Osaka Jade palette — the artifacts that decided this design, regenerated as
  acceptance evidence. The session spine, a frontend segment boundary and a mid-flight message must
  all be visible in at least one of them.
- **Delivery-stage projection (§4.2):** a renderer test that each of the seven `InputRow.state` values
  plus the scheduled and tool-delivery cases produces its own visible label — and specifically that
  `browser` and `tool` are never rendered as the same fact. This is the test that would catch the
  flattening this redesign exists to fix.
- **Session spine (§4.1):** a renderer test that a recorded `handoff`/`resume` pair produces one
  frontend boundary with correctly numbered segments, and that a session with no handoff renders no
  spine — so the spine cannot appear where the product has no lineage to show.
- A renderer test that `followDesktop: false`, a missing field and malformed input each yield exactly
  today's tokens, so the default path cannot regress.
- A main-process test for `readOmarchyTheme()` covering: valid theme, missing directory, unreadable
  file, unparseable content, malformed colour, oversized file — each returning `null`, none throwing.
- A test that turning follow off restores the saved manual palette byte-for-byte.

Deliberately not verified here: `npm run dist`, installed payload, and live ChatGPT behaviour. The
redesign does not touch those layers.

## 9. Risks

| Risk | Mitigation |
|---|---|
| The dense mono layout is harder to read than expected | Chrome is authored at 11px and still scales with the user's text-size preference, not fixed at the terminal's 8; prose keeps sans. `verify-appearance.cjs` already renders the real renderer at four width/zoom combinations. |
| `rounding = 0` looks unfinished on controls | Hover/active fills and hairline borders carry affordance; this is the desktop's own idiom. |
| Control rows are mistaken for cards | Different component, different shape, `⇢` glyph, no fill, no border. |
| Cards become heavy in long transcripts | Only real conversation gets a card; tool calls stay single lines; generated work is rows. |
| Follow mode reads a file that changes shape | §5.2 returns `null` on anything unexpected and falls back; the app never fails to start over a theme file. |
| Existing verify scripts or tests assert the old look | §8 names which ones keep passing unchanged and which two test files may need retargeting; nothing is removed to make a change land. |
| The mono chrome changes measured widths and breaks a layout assertion | The width and overflow fixtures in §8 are run before and after the type change; a failure there is a real regression to fix, not an assertion to relax. |

## 10. Prototypes

`outputs/redesign-baseline/prototypes/` — all rendered in real Chromium with the Osaka Jade palette,
Iosevka NF Mono and 0px corners:

- `A.html` / `A.png` — left rail + one-line tool rows
- `B.html` / `B.png` — bordered message cards **(approved turn shape)**
- `C.html` / `C.png` — prose column + metadata gutter
- `categories.html` / `categories.png` — **the 12 transcript content categories with their colours,
  glyphs and edge treatments** (§4.7)
- `identity.html` / `identity.png` — **the session spine and the message lifecycle** (§4.1, §4.2),
  the two product-derived elements

A and C are retained as the rejected alternatives and as the source of the tool-row and control-row
idioms that B's implementation keeps. The `outputs/` directory is gitignored, so these are working
artifacts, not committed source.
