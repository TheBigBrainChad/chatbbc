# Model-facing tool surface

This is the current public reference for the tool surface. The implementation and tests are
authoritative; `src/main/mcp/surfaces.ts`, `src/main/mcp/tools-core.ts`,
`src/main/mcp/tools-desktop.ts` and `test/mcp.test.ts` should agree with this file.

## Connectors

ChatBBC publishes Core on Windows, macOS and Linux. Windows and macOS additionally publish
the optional Desktop connector. They are separate discovery and permission boundaries and use
separate secret tokenized local paths.

| Connector | Purpose | Possible tools |
| --- | --- | --- |
| **ChatBBC Core** | Approved files, patches, terminal, task plans, workers | `read`, `view_image`, `find`, `apply_patch`, `exec_command`, `write_stdin`, `update_plan`, `agents` |
| **ChatBBC Desktop** | **Windows/macOS:** screen, windows, mouse/keyboard and clipboard | `observe`, `computer` |

The Desktop connector is optional on Windows/macOS. Core is the main connector everywhere.

On a fresh current config, Core permissions are enabled, along with
session recording and multi-agent mode; read-only mode is off. Windows also enables Desktop permissions; macOS starts them off and the user switches them on. Linux masks
Desktop permissions off at runtime while preserving stored choices for a config later reopened on
Windows or macOS. Existing configs keep explicit choices during upgrades; missing legacy permissions are
not silently widened.

With fresh defaults, Core advertises `read`, `view_image`, `apply_patch`, `exec_command`,
`write_stdin`, `update_plan`, and `agents`.
`find` is the search fallback for a snapshot where search is enabled and command execution is
unavailable. Tool exposure is monotonic within a running connector instance, so a permission
changed mid-conversation can leave a previously exposed name listed; its handler still enforces
the current permission.

## Core tools

### `read`

Reads approved paths. It accepts one or more paths, lists a directory one level deep, expands
bounded globs, supports line ranges, and can return supported image content. Path resolution
and result-size limits are enforced by the app: the per-file default payload is 256 KB, which
covers an ordinary source file whole, and the aggregate payload for one call stays bounded at
512 KB. The defaults are set so that batching paths into one call and reading a file whole are
the cheap path, because the round trip costs far more than the bytes.

### `view_image`

The dedicated Codex-compatible image tool. It is a real Core tool, separate from `read`, and
is gated by the read capability. Image transport and decode checks remain bounded.

### `find`

Search fallback used when search is enabled and command execution was unavailable when the
surface snapshot was built. It covers filename/glob and text search without granting a shell.

### `apply_patch`

The text mutation primitive. It uses the V4A patch envelope and preflights a multi-file patch
before writing. Create, edit, move and delete-file permissions are checked independently.
Directory deletion and arbitrary binary writes are deliberately not hidden patch operations.

### `exec_command`

Runs a command in the host's real shell: PowerShell/cmd on Windows and the user's normal POSIX
shell on macOS/Linux. This permission is **not** confined to approved folders. Long-running
commands return an opaque `session_id` that `write_stdin` can continue.

It takes exactly one of `cmd` (a single command) or `cmds` (up to 20 commands run sequentially
in one shell session). A batch shares one process, so variables, environment changes and the
working directory carry across its items; each item gets a labeled output section and its own
exit code, an ordinary non-zero result does not stop the rest, and the call's exit code is the
first non-zero one. Batching exists to spend one connector round trip instead of several on
related checks. The `apply_patch` interception and the benign-non-zero-exit classification
apply to single-command calls only.

### `write_stdin`

Writes to or polls a live command session by `session_id`, with optional yield time and output
budget. A blank `chars` value is a poll rather than a separate process-status tool. An empty
poll returns as soon as the process produces output rather than holding the full yield window;
anything that arrives afterwards stays buffered for the next poll. A non-empty write keeps
Codex's collection-window behaviour so one interactive response is gathered whole.

### `update_plan`

Available while recording is enabled. Replaces the exact caller’s displayed progress plan; it does
not execute queued work. Local history continues recording messages and real tool results for the
app transcript and continuation. There is no model-facing recording search/read tool.

Compact & Resume is app/browser orchestration. There is no model-visible `save_handoff` or
`resume_session` tool.

### `agents`

Available while multi-agent mode is enabled. It has exactly four actions:

- `spawn` creates worker chats from one shared context plus per-worker tasks. Used once per run:
  a run that needs a worker again reuses one it already has. Each worker takes an optional
  `model` slug: the worker's chat opens with `?model=<slug>` in its fresh-chat URL, so a prime
  on a limited model can spawn workers on a cheaper one. Omitted means the account default;
  a slug ChatGPT does not recognise opens with the default too. The model is fixed for the
  life of that conversation, including across sleep/wake reuse. Each worker also takes an
  optional `reasoning_effort`: pro, none, minimal, low, medium, high, xhigh, max or ultra,
  forwarded on the open URL independently of `model` — a level never selects or changes the
  model, and omitting either inherits the default set in app settings, or the account default
  when no setting is chosen. The vocabulary is the one in `shared/session.ts`; `pro` is the
  ChatGPT browser Power tier and is listed here because a worker is a real browser chat.
- `message` sends one message or an all-or-nothing batch. Messaging a sleeping worker is what
  wakes it, in the chat it already has.
- `status` reports the run and workers, including who is asleep and how many worker slots are free.
- `finish` is a worker's handoff to the prime. It reports a result and puts that worker to sleep.

Workers sleep rather than end. A worker that has reported keeps its ChatGPT conversation and
stays reusable; its worker slot is free while it sleeps, so the limit counts only workers that
are actually working. Waking one needs a free slot, reopens or refocuses that worker's own chat,
and types the prime's message into it as an ordinary user message. A worker becomes permanently
finished only when its chat reaches the context ceiling (400,000 tokens by the app's own session
accounting); crossing it never interrupts work in flight, it only makes the next stop the last one.
Workers never run Compact & Resume, automatically or manually: their conversation is their durable
agent identity, so the 400,000-token boundary changes only later revive eligibility and never opens
a replacement worker chat.

There is no model-supplied agent credential or `agent_key`. Worker/prime identity is bound to
the ChatGPT conversation using extension evidence; control calls fail closed when that identity
cannot be proven.

### `generated_assets`

Lists and saves images that ChatGPT generated in this exact local session. It is a Core tool,
visible only when a reading capability and Create are enabled; Read-only mode hides it.

- `action: "list"` returns at most 64 opaque handles with suggested filename, MIME, dimensions and
  whether a saved local preview exists. One handle is issued per canonical asset, so a response with
  several generated images returns several handles. Provider asset ids and signed URLs are never
  published.
- `action: "save"` takes `handle`, `path` and `source` (`preview` or `original`) and creates a
  new file at an approved path. It never replaces an existing file. `preview` reads the
  already-saved local preview. `original` asks the companion for the provider asset.

The human gallery's **Save preview** button is not a Core tool call. It opens a native Save As
dialog for one recorded preview or a folder picker for several, converts the local copy to
WebP and creates new files without replacing existing ones. It does not use an approved root
or fetch a provider original. **Download original** uses Chrome Downloads instead. Sets over
20 images require an explicit selection of at most 20; cancellations and partial failures
remain visible without claiming those files were saved.

A handle is a capability over one local session: a handle issued to session A is refused for
session B, and it expires. Results are one of:

| Outcome | Meaning |
| --- | --- |
| saved | The staged bytes were published to a new approved path without replacing an existing file. |
| `asset_handle_refused` | The handle belongs to another session, or is unknown. |
| `asset_handle_expired` | The session binding changed, or the handle aged out. |
| `preview_unavailable` | No saved local preview exists for that asset. |
| `original_unavailable` | The provider original could not be proven available; a preview is never substituted. |
| `asset_oversize` | Compressed size, decoded pixels, chunk size or total transfer exceeded `GENERATED_ASSET_LIMITS`. |
| `DESTINATION_CHANGED` | Another writer created or changed the destination during this operation; its bytes were left untouched. |
| `destination_exists` | The destination already exists; choose a new name. |
| `destination_unsupported` | The approved filesystem cannot safely publish a new file without replacement (for example, exFAT without hard links); no partial destination is created. Use a writable hard-link-capable root. |
| `write_disabled` | Read-only mode or Create permission is off. |
| `path_refused` | The path is outside the approved roots or resolves through a link. |

`GENERATED_ASSET_LIMITS` bounds the list, compressed bytes (64 MiB), decoded pixels (40 million),
chunk size (512 KiB), concurrent transfers (two) and transfer time (120 seconds).

## Desktop tools

This section exists on Windows and macOS. Linux does not advertise or execute these schemas.

### `observe`

Reads desktop state without moving focus: screenshots, windows and snapshot-scoped UI-control
information. Window capture tries a direct background path first and labels a visible-screen
fallback when the pixels may be occluded. Screen access is independent from mouse/keyboard
control.

### `computer`

Executes a bounded batch of desktop actions. The current action set is:
`click_ref`, `set_value`, `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
`focus`, `wait`, `read_clipboard`, and `write_clipboard`.

Recent screenshot frames are retained independently; a coordinate action names its frame and
the helper revalidates target-window geometry immediately before physical input. Semantic refs
address cached UI Automation or AXUIElement objects from one bounded snapshot and fail stale rather
than rescanning by a reusable native identity. Batches report completed-step and route evidence, including
the exact failing index on partial failure. An optional compact `verify` postcondition can wait
for a foreground window, window open/close, or UI control appearance/disappearance and capture
the resulting state in the same tool call.

Each step is checked against the current screen/control/clipboard permissions. Read-only mode
can keep observation available while disabling state-changing desktop actions.

## Permission and discovery invariants

- A tool call is checked against current permissions even if its schema was exposed earlier.
- Core and Desktop do not forward or alias each other's tools.
- A connector token for one surface does not authorize the other surface.
- Read-only mode removes effective file-write, command, control and clipboard-write permissions
  without pretending the underlying configuration was changed.
- Approved filesystem roots do not sandbox command execution or desktop control.
- Tool results and validation errors are bounded; large structured or binary payloads must not
  grow without an explicit cap.

## Compatibility notes

Older conversations can retain a cached MCP schema after an upgrade. Refresh/review the app in
ChatGPT, or recreate it if your workspace requires that, then start a new conversation when the
connector's exposed tool shape changes. The current extension pairs automatically with the local
bridge; there is no pairing code to enter.

## Tests that protect the surface

`test/mcp.test.ts` checks exact surface membership, cross-surface rejection, discovery-size
budgets, permission gating, retired names and schema shape. Native image parity has additional
coverage in `test/codex-view-image-parity.test.ts`.

When changing the public tool surface, update the implementation, the surface declarations,
the tests and this document together. Do not add a permanently exposed tool for a workflow
that can be expressed safely through the existing primitives.
