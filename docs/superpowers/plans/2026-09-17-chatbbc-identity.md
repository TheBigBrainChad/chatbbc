# ChatBBC Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this private fork publicly and ChatGPT-facing **ChatBBC**, with new MCP server names, a hard `userData` cut, and a bridge protocol bump so a leftover CoS companion fails closed.

**Architecture:** Keep one handshake owner in `src/main/version.ts` (`APP_SLUG`, `APP_TITLE`, `BRIDGE_PROTOCOL`). MCP display brand stays `CONNECTOR_BRAND` in `src/main/mcp/surfaces.ts` and must equal `APP_TITLE`. Swap user/model-facing strings and packaging ids. Do not rename `CLF_`, `COS_CONTEXT`, bridge ports, or historical LICENSE/CONTRIBUTORS/CHANGELOG entries.

**Tech Stack:** Electron 44, MV3 companion, Vitest, electron-builder, existing MCP kernel.

**Spec:** `docs/superpowers/specs/2026-09-17-chatbbc-identity-design.md`

## Global Constraints

- Display name is exactly `ChatBBC`. No CoS, BBC, or CBBC nickname.
- `/hello` `app` stamp and extension match string: `chatbbc` (today’s field is the slug `chat-on-steroids`, not the display title).
- MCP `serverName`: `chatbbc-core`, `chatbbc-desktop`, `chatbbc-plugins`.
- Connector titles: `ChatBBC Core`, `ChatBBC Desktop`, `ChatBBC Plugins`.
- `appId`: `com.chatbbc.app`. Executable / DEB / package.json `name`: `chatbbc`. `userData` folder name follows Electron from `name` → `chatbbc`.
- GitHub product URLs: `TheBigBrainChad/chatbbc`. Never `totec448-spec/chat-on-steroids` for homepage, updater, or extension zip.
- `BRIDGE_PROTOCOL` becomes `15`. Duplicate the integer in `extension/background.js` (no bundler).
- Connector **descriptions** keep current capability vocabulary; only the product name inside them changes.
- Leave: LICENSE, CONTRIBUTORS.md, existing CHANGELOG history, `CLF_*`, `COS_CONTEXT`, `scripts/verify-public-history.mjs` maintainer (`totec448-spec` is still the public upstream for that privacy gate), `upstream` git remote.
- Do not run `npm run dist` or publish. Do not redesign UI. Do not invent new “ChatBBC appears N times” tests — retarget existing contract tests.
- Shared tree: never `git reset` / checkout unrelated dirty files. Commit only files this task owns.
- Human must rename the GitHub repo to `TheBigBrainChad/chatbbc` (Settings → Rename). Code can land before that; release URLs 404 until it exists.

### Substitution table (every later task uses this)

| Old | New |
|---|---|
| `Chat On Steroids` | `ChatBBC` |
| `Chat On Steroids Core` | `ChatBBC Core` |
| `Chat On Steroids Desktop` | `ChatBBC Desktop` |
| `Chat On Steroids Plugins` | `ChatBBC Plugins` |
| `chat-on-steroids-core` | `chatbbc-core` |
| `chat-on-steroids-desktop` | `chatbbc-desktop` |
| `chat-on-steroids-plugins` | `chatbbc-plugins` |
| `/hello` `app: 'chat-on-steroids'` | `app: 'chatbbc'` |
| `com.chatonsteroids.app` | `com.chatbbc.app` |
| `com.chatonsteroids.app.desktop` | `com.chatbbc.app.desktop` |
| package/DEB/executable `chat-on-steroids` | `chatbbc` |
| `totec448-spec/chat-on-steroids` product URLs | `TheBigBrainChad/chatbbc` |
| user-facing `CoS` (not `COS_CONTEXT`, not `CLF_`) | `ChatBBC` |
| installer artifacts `Chat-On-Steroids-*` | `ChatBBC-*` |
| localStorage `chat-on-steroids.*` | `chatbbc.*` |

Do **not** replace `Chat On Steroids Backup` with a ChatBBC connector. That string is a **lookalike stranger**. Change it to `ChatBBC Backup` so the prefix test still uses the new brand.

Keep `TobisComputer` as the pre-split legacy Fiber name.

---

### Task 1: Handshake slug and protocol 15

**Files:**
- Modify: `src/main/version.ts`
- Modify: `src/main/bridge.ts` (`/hello` `app` field)
- Modify: `extension/background.js` (`BRIDGE_PROTOCOL` and `body.app ===` check)
- Test: `test/extension.test.ts`, `test/bridge.test.ts`
- Also retarget hello fixtures that hard-code the slug (same commit, same contract): `test/desktop-input-maintenance.test.ts`, `test/extension.test.ts` (`app === 'chat-on-steroids'` helper and `/hello` mocks)

**Interfaces:**
- Consumes: nothing new
- Produces: `export const APP_SLUG = 'chatbbc'`, `export const APP_TITLE = 'ChatBBC'`, `export const BRIDGE_PROTOCOL = 15` from `src/main/version.ts`. `/hello` body `app` equals `APP_SLUG`. Extension accepts only that slug.

- [ ] **Step 1: Point the protocol pin at 15 (failing)**

In `test/extension.test.ts` change:

```ts
expect(BRIDGE_PROTOCOL).toBe(15);
expect(backgroundSource).toContain('const BRIDGE_PROTOCOL = 15;');
```

In `test/bridge.test.ts` change the `/hello` assertion:

```ts
expect(reply.body.app).toBe('chatbbc');
```

Import `APP_SLUG` once it exists; until then the literal `'chatbbc'` is the contract.

- [ ] **Step 2: Run the two tests and confirm they fail**

Run: `npm test -- --run test/extension.test.ts test/bridge.test.ts`

Expected: FAIL on `BRIDGE_PROTOCOL` still 14 and/or `app` still `chat-on-steroids`.

- [ ] **Step 3: Implement handshake constants**

`src/main/version.ts` — keep `APP_VERSION = '2.1.14'`. Add and bump:

```ts
export const APP_SLUG = 'chatbbc';
export const APP_TITLE = 'ChatBBC';
export const BRIDGE_PROTOCOL = 15;
```

Add a protocol-15 comment: `/hello` `app` renamed from `chat-on-steroids` to `chatbbc`; a 14 companion treats the reply as a foreign app and drops it.

`src/main/bridge.ts` `/hello` payload:

```ts
app: APP_SLUG,
```

(import `APP_SLUG` next to `APP_VERSION` / `BRIDGE_PROTOCOL`).

`extension/background.js`:

```js
const BRIDGE_PROTOCOL = 15;
```

and the hello parse:

```js
return body && body.app === 'chatbbc' ? body : null;
```

- [ ] **Step 4: Retarget hello fixtures**

Replace every test fixture `app: 'chat-on-steroids'` that simulates **this app’s** `/hello` with `app: 'chatbbc'`.

In `test/extension.test.ts` the helper that only injects `bridge` when `data.app === 'chat-on-steroids'` must compare to `'chatbbc'`.

Prefer `APP_SLUG` in files that already import `../src/main/version.js`.

Do not change `scripts/verify-public-history.mjs`.

- [ ] **Step 5: Re-run handshake tests**

Run: `npm test -- --run test/extension.test.ts test/bridge.test.ts test/desktop-input-maintenance.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/version.ts src/main/bridge.ts extension/background.js \
  test/extension.test.ts test/bridge.test.ts test/desktop-input-maintenance.test.ts
git commit -m "Rename bridge hello app to chatbbc and bump protocol 15."
```

---

### Task 2: MCP connector identity

**Files:**
- Modify: `src/main/mcp/surfaces.ts` (`CONNECTOR_BRAND`, three `serverName`s, Plugins description brand)
- Test: `test/mcp.test.ts`, `test/mcp-user-instructions.test.ts`, `test/platform.test.ts`, `test/connection.test.ts`

**Interfaces:**
- Consumes: `APP_TITLE` must equal `CONNECTOR_BRAND`
- Produces: `CONNECTOR_BRAND = 'ChatBBC'`; `serverName` `chatbbc-core|desktop|plugins`; `connectorName` `` `${CONNECTOR_BRAND} Core` `` etc.

- [ ] **Step 1: Fail the surface contract tests**

`test/mcp.test.ts`:

```ts
expect(surface.serverName, surface.id).toMatch(/^chatbbc-/);
expect(surface.connectorName, surface.id).toContain('ChatBBC');
```

and initialize:

```ts
expect(reply.body.result.serverInfo.name).toBe('chatbbc-core');
```

`test/mcp-user-instructions.test.ts` and `test/platform.test.ts`: replace expected `Chat On Steroids` with `ChatBBC` in instruction assertions (keep capability sentences).

`test/connection.test.ts` publication fake:

```ts
observe(`ChatBBC ${surface}`, '1', 'instructions', [])
```

- [ ] **Step 2: Run MCP identity tests (expect FAIL)**

Run: `npm test -- --run test/mcp.test.ts test/mcp-user-instructions.test.ts test/platform.test.ts test/connection.test.ts`

Expected: FAIL on old `chat-on-steroids-*` / `Chat On Steroids` names.

- [ ] **Step 3: Change surfaces**

```ts
export const CONNECTOR_BRAND = 'ChatBBC';
```

Set `serverName` to `chatbbc-core`, `chatbbc-desktop`, `chatbbc-plugins`.

Keep `connectorName: \`${CONNECTOR_BRAND} Core\`` (and Desktop/Plugins).

Plugins `description` currently contains `Chat On Steroids Settings` → `ChatBBC Settings`. Do not rewrite the rest of Core/Desktop vocabulary.

Add a one-line test in `test/mcp.test.ts` (same suite, not a new counting test):

```ts
import { APP_TITLE } from '../src/main/version.js';
expect(CONNECTOR_BRAND).toBe(APP_TITLE);
```

- [ ] **Step 4: Re-run MCP tests**

Run: `npm test -- --run test/mcp.test.ts test/mcp-user-instructions.test.ts test/platform.test.ts test/connection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/surfaces.ts test/mcp.test.ts test/mcp-user-instructions.test.ts \
  test/platform.test.ts test/connection.test.ts
git commit -m "Rename MCP servers to chatbbc-core/desktop/plugins."
```

---

### Task 3: Extension Fiber / plugin-refresh ChatGPT names

**Files:**
- Modify: `extension/fiber.js` (`OUR_APPS`)
- Modify: `extension/manifest.json` `name` / `description`
- Test: `test/fiber.test.ts`, `test/content-script.test.ts` (connector `app` / path fixtures), `test/plugin-refresh-dom.test.ts`, `test/plugin-refresh.test.ts`, `test/plugin-refresh-workflow.test.ts`, `test/input-delivery-integration.test.ts` (publishPluginSurface connector names)

**Interfaces:**
- Consumes: connector titles from Task 2 (`ChatBBC Core`, `ChatBBC Desktop`, `ChatBBC Plugins`)
- Produces: Fiber `ourApp()` true only for those titles plus legacy `TobisComputer`

- [ ] **Step 1: Fail Fiber exact-name tests**

`test/fiber.test.ts`:

```ts
const APP = 'ChatBBC Core';
const DESKTOP_APP = 'ChatBBC Desktop';
```

Keep lookalike as a **non-owned** name:

```ts
{ app: 'ChatBBC Backup' }
```

`test/plugin-refresh*.ts` and `publishPluginSurface(..., 'Chat On Steroids Core', ...)` → `'ChatBBC Core'` (and Plugins). Content-script fixtures that use `app: 'Chat On Steroids Core'` and paths `/Chat On Steroids Core/read_file` → ChatBBC equivalents.

- [ ] **Step 2: Run Fiber/refresh tests (expect FAIL)**

Run: `npm test -- --run test/fiber.test.ts test/plugin-refresh.test.ts test/plugin-refresh-dom.test.ts test/plugin-refresh-workflow.test.ts`

Expected: FAIL until `OUR_APPS` and live `CONNECTOR_BRAND` match.

- [ ] **Step 3: Implement Fiber and manifest**

`extension/fiber.js`:

```js
const OUR_APPS = ['ChatBBC Core', 'ChatBBC Desktop', 'TobisComputer'];
```

`extension/manifest.json`:

```json
"name": "ChatBBC companion",
"description": "Connects ChatGPT to ChatBBC and controls browser tabs in the background with DOM, screenshots and developer tools."
```

Leave `version` equal to `APP_VERSION`.

- [ ] **Step 4: Re-run**

Run: `npm test -- --run test/fiber.test.ts test/plugin-refresh.test.ts test/plugin-refresh-dom.test.ts test/plugin-refresh-workflow.test.ts test/content-script.test.ts test/input-delivery-integration.test.ts`

Expected: PASS (content-script/input-delivery after fixture rename). If a leftover CoS connector string fails, fix the fixture, not production logic.

- [ ] **Step 5: Commit**

```bash
git add extension/fiber.js extension/manifest.json test/fiber.test.ts \
  test/plugin-refresh.test.ts test/plugin-refresh-dom.test.ts test/plugin-refresh-workflow.test.ts \
  test/content-script.test.ts test/input-delivery-integration.test.ts
git commit -m "Recognize ChatBBC connector titles in Fiber and refresh."
```

---

### Task 4: Packaging, appId, empty userData

**Files:**
- Modify: `package.json` (`name`, `author`, `homepage`, `desktopName`)
- Modify: `electron-builder.yml` (`appId`, `productName`, nsis shortcut/uninstall/artifact, mac artifact + Screen Recording description, linux `executableName`, `maintainer`, `artifactName`)
- Modify: `.github/workflows/release.yml` and `publish.yml` strings that pin `Chat On Steroids.app`, `chat-on-steroids` DEB, desktop `Name=` / `Icon=`, `/usr/bin/chat-on-steroids`, candidate artifact name
- Test: `test/packaging.test.ts`, `test/macos-adhoc-seal.test.ts`

**Interfaces:**
- Consumes: `APP_TITLE` / `APP_SLUG` from Task 1
- Produces: installed identity `com.chatbbc.app`, binary `chatbbc`, productName `ChatBBC`. Electron `userData` is the new `chatbbc` directory (no migration code).

- [ ] **Step 1: Fail packaging contract tests**

`test/packaging.test.ts` expected values become:

```ts
expect(pkg.desktopName).toBe('com.chatbbc.app.desktop');
expect(pkg.homepage).toBe('https://github.com/TheBigBrainChad/chatbbc');
expect(builder.linux.maintainer).toMatch(/^ChatBBC <[^>]+@users\.noreply\.github\.com>$/);
```

Replace workflow assertions:

- `Name=ChatBBC`
- `Icon=chatbbc`
- `Package` / `/usr/bin/chatbbc`
- `ChatBBC.app` in macOS smoke paths
- candidate name may stay `chatbbc-candidate-${{ github.run_id }}` (slug, not CoS)

`test/macos-adhoc-seal.test.ts`:

```ts
packager: { appInfo: { productFilename: 'ChatBBC' } }
stderr: ... 'Identifier=com.chatbbc.app\n' ...
```

Helper path using `Chat On Steroids Helper (GPU)` → `ChatBBC Helper (GPU)` only in that otool fixture.

- [ ] **Step 2: Run packaging tests (expect FAIL)**

Run: `npm test -- --run test/packaging.test.ts test/macos-adhoc-seal.test.ts`

Expected: FAIL on old ids.

- [ ] **Step 3: Apply packaging files**

`package.json`:

```json
"name": "chatbbc",
"author": "ChatBBC",
"homepage": "https://github.com/TheBigBrainChad/chatbbc",
"desktopName": "com.chatbbc.app.desktop"
```

Keep `"description"` factual; it may mention ChatGPT MCP. Do not keep “Chat On Steroids” there.

`electron-builder.yml`:

```yaml
appId: com.chatbbc.app
productName: ChatBBC
```

`nsis.shortcutName` / `uninstallDisplayName`: `ChatBBC`  
`nsis.artifactName`: `ChatBBC-Setup-${arch}.${ext}`  
`mac.artifactName`: `ChatBBC-macOS-${arch}.${ext}`  
`linux.executableName`: `chatbbc`  
`linux.maintainer`: `ChatBBC <TheBigBrainChad@users.noreply.github.com>`  
`linux.artifactName`: `ChatBBC-Linux-${env.COS_PACKAGE_ARCH}.${ext}`  
macOS `NSScreenCaptureUsageDescription`: ChatBBC captures… (same sentence, new brand)

Update `.github/workflows/release.yml` / `publish.yml` in lockstep with `test/packaging.test.ts` (DEB field, desktop file, xvfb binary, macOS `.app` name, artifact names). Leave `verify-public-history` as the totec448-spec public-repo gate.

No code copies CoS `userData`. `app.getPath('userData')` after the `name` change is a new empty directory.

- [ ] **Step 4: Re-run packaging tests**

Run: `npm test -- --run test/packaging.test.ts test/macos-adhoc-seal.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json electron-builder.yml .github/workflows/release.yml \
  .github/workflows/publish.yml test/packaging.test.ts test/macos-adhoc-seal.test.ts
git commit -m "Switch appId, package, and installers to ChatBBC."
```

---

### Task 5: GitHub / updater / Goal client title

**Files:**
- Modify: `src/main/version.ts` `extensionDownloadUrl`
- Modify: `src/main/update.ts` `REPO`
- Modify: `src/main/goal.ts` (`HTTP-Referer`, `X-Title`)
- Test: `test/ipc.test.ts`, `test/update.test.ts`

**Interfaces:**
- Consumes: repo `TheBigBrainChad/chatbbc`
- Produces: updater and extension zip URLs on that repo; Goal OpenRouter headers titled ChatBBC

- [ ] **Step 1: Fail URL tests**

`test/ipc.test.ts` already calls `extensionDownloadUrl('1.8.8')` via `shell.openExternal`. After `version.ts` changes, that assertion keeps passing if it only checks the function return. Add/keep:

```ts
expect(extensionDownloadUrl('1.8.8')).toBe(
  'https://github.com/TheBigBrainChad/chatbbc/releases/download/v1.8.8/ChatBBC-Extension.zip'
);
expect(vi.mocked(shell.openExternal).mock.calls[0]?.[0]).not.toContain('/releases/latest/');
```

`test/update.test.ts` fixture:

```ts
github({ checksums: `${sha256('x')}  ChatBBC-Extension.zip\n` });
```

Do **not** edit `test/public-history-privacy.test.ts`.

- [ ] **Step 2: Run URL tests (expect FAIL until Step 3)**

Run: `npm test -- --run test/ipc.test.ts test/update.test.ts`

Expected: FAIL on old zip host or filename.

- [ ] **Step 3: Implement URLs**

```ts
// version.ts
export function extensionDownloadUrl(version = APP_VERSION): string {
  return `https://github.com/TheBigBrainChad/chatbbc/releases/download/v${encodeURIComponent(version)}/ChatBBC-Extension.zip`;
}

// update.ts
const REPO = 'TheBigBrainChad/chatbbc';

// goal.ts
'HTTP-Referer': 'https://github.com/TheBigBrainChad/chatbbc',
'X-Title': 'ChatBBC'
```

Private repo: updater may 404 without a token. That is acceptable. It must not call `totec448-spec`.

- [ ] **Step 4: Re-run**

Run the same test files as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/version.ts src/main/update.ts src/main/goal.ts
git commit -m "Point updater and extension zip at TheBigBrainChad/chatbbc."
```

---

### Task 6: Model-facing runtime strings

**Files:**
- Modify: `src/main/mcp/instructions.ts`, `src/main/mcp/coding-instructions.ts`, `src/main/mcp/kernel.ts` (`FEATURE_DISABLED` text)
- Modify: `src/main/mcp/tools-core.ts`, `src/main/mcp/tools-desktop-macos.ts` (and any sibling tool file whose refusal text names the product)
- Modify: `src/main/agents.ts` (WorkerIdentityLost / multi-agent off / worker bootstrap parenthetical)
- Modify: `src/main/index.ts` (window `title`, tray tooltip)
- Modify: other `src/main/**` user/model-visible “Chat On Steroids” / “CoS” (exec reserved-env message may keep `CLF_` and say ChatBBC)
- Test: existing instruction/agent tests already updated in Task 2; add no new suite. Re-run `test/mcp-user-instructions.test.ts` after instruction edits.

**Interfaces:**
- Consumes: `CONNECTOR_BRAND` / `APP_TITLE`
- Produces: every model-visible refusal/instruction names ChatBBC

- [ ] **Step 1: List remaining main-process product strings**

From repo root, search `src/main` for `Chat On Steroids` and user-facing `CoS`. Skip comments that are history-only if they do not ship to the model. Window title and tray are in scope.

- [ ] **Step 2: Apply substitution table to those production strings**

Prefer `APP_TITLE` or `CONNECTOR_BRAND` in new/edited TypeScript rather than a third literal. `coding-instructions.ts` first sentence:

```ts
You are a coding agent working with the user through ChatBBC.
```

Do not rename `COS_CONTEXT`.

- [ ] **Step 3: Run instruction and nearby tests**

Run: `npm test -- --run test/mcp-user-instructions.test.ts test/platform.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main
git commit -m "Say ChatBBC in MCP instructions and tool refusals."
```

(Only stage main-process files this task changed; do not sweep unrelated dirty files.)

---

### Task 7: Desktop UI, popup, i18n

**Files:**
- Modify: `src/renderer/index.html` (title, sidebar brand, header, plugins copy, setup, login label)
- Modify: `src/renderer/locales/es.json`, `zh-CN.json`, `zh-TW.json` (English **keys** and translated **values** that contain the old brand or user-facing CoS)
- Modify: `extension/popup.html`, `extension/popup.js`
- Modify: renderer localStorage keys: `src/renderer/file-panel.ts`, `sidebar-order.ts`, `sidebar-resize.ts`, `work-panel-resize.ts`
- Modify: `src/renderer/plugins.ts` toast/copy if literals live there
- Test: `test/plugins-ui.test.ts`, `test/renderer-file-panel.test.ts`, plus any renderer test that expects `Chat On Steroids` or `chat-on-steroids.` keys

**Interfaces:**
- Consumes: `APP_TITLE`
- Produces: visible chrome and i18n keys say ChatBBC; new-profile localStorage keys `chatbbc.*`

- [ ] **Step 1: Fail UI tests**

`test/plugins-ui.test.ts`: `ChatBBC Plugins` in toast/guide.

`test/renderer-file-panel.test.ts`:

```ts
expect(dom.window.localStorage.getItem('chatbbc.file-preview-height'))
```

Replace remaining UI-test CoS strings via the substitution table.

- [ ] **Step 2: Run UI tests (expect FAIL)**

Run: `npm test -- --run test/plugins-ui.test.ts test/renderer-file-panel.test.ts`

Expected: FAIL on old labels/keys.

- [ ] **Step 3: Apply UI copy**

`index.html` `<title>`, `.sidebar-brand strong`, header `.title` → `ChatBBC`.

Replace user-facing CoS in plugin legal/setup/login strings with ChatBBC.

Locales: i18n keys **are** the English source. Rename keys that start with or contain `Chat On Steroids` / `CoS` and update values. Do not leave a key `Chat On Steroids` mapping to `ChatBBC` — the English key must match the DOM text.

Popup title/h1: `ChatBBC`. Error copy: “Open ChatBBC for setup instructions.”

```ts
const PREVIEW_HEIGHT_KEY = 'chatbbc.file-preview-height';
const STORAGE_KEY = 'chatbbc.sidebar-order';
const key = 'chatbbc.sidebar-width';
const STORAGE_KEY = 'chatbbc.work-panel-width';
```

- [ ] **Step 4: Re-run UI tests**

Run: `npm test -- --run test/plugins-ui.test.ts test/renderer-file-panel.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/locales src/renderer/file-panel.ts \
  src/renderer/sidebar-order.ts src/renderer/sidebar-resize.ts \
  src/renderer/work-panel-resize.ts src/renderer/plugins.ts \
  extension/popup.html extension/popup.js test/plugins-ui.test.ts test/renderer-file-panel.test.ts
git commit -m "Relabel the workspace UI and companion popup as ChatBBC."
```

---

### Task 8: Product docs and AGENTS.md brand

**Files:**
- Modify: `README.md`, `docs/setup.md`, `SECURITY.md`, `CONTRIBUTING.md` **product** sentences
- Modify: `AGENTS.md` product name / connector table / userData paths / app id (keep owner map and behavior)
- Modify: `CHANGELOG.md` — **prepend** a ChatBBC identity note only; do not rewrite old CoS entries
- Leave: `LICENSE`, `CONTRIBUTORS.md`, `docs/superpowers/specs/2026-09-17-chatbbc-identity-design.md`

**Interfaces:**
- Consumes: identity table from the spec
- Produces: docs a new contributor would follow for ChatBBC setup

- [ ] **Step 1: Update AGENTS.md identity rows**

In `AGENTS.md` replace the product title, Core/Desktop/Plugins `serverName`s, `com.chatonsteroids.app`, and userData paths (`chatbbc`). Do not flatten the owner map into a rewrite of feature logic.

- [ ] **Step 2: Update README/setup/SECURITY/CONTRIBUTING**

Substitution table on product sentences. README download badges currently point at `totec448-spec` releases — remove or retarget to `TheBigBrainChad/chatbbc` (private: say the app ships the extension; do not advertise public CoS installers).

- [ ] **Step 3: Prepend CHANGELOG note**

Short unreleased/fork note: renamed to ChatBBC; new `appId` / empty `userData`; recreate ChatGPT connectors; reload companion; protocol 15.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md docs/setup.md SECURITY.md CONTRIBUTING.md CHANGELOG.md
git commit -m "Document ChatBBC identity in product docs."
```

---

### Task 9: Residual sweep and verification

**Files:** any remaining **shipped** `Chat On Steroids` / user-facing `CoS` / `chat-on-steroids-core` under `src/`, `extension/`, `test/` (except lookalike `ChatBBC Backup`, `TobisComputer`, privacy-gate tests, LICENSE, CONTRIBUTORS, historical CHANGELOG).

**Interfaces:** none new.

- [ ] **Step 1: Search leftovers**

Search:

- `Chat On Steroids`
- `chat-on-steroids-core`
- `com.chatonsteroids`
- `app: 'chat-on-steroids'`
- `CONNECTOR_BRAND = 'Chat On Steroids'`

Allowed leftovers: LICENSE, CONTRIBUTORS.md, old CHANGELOG entries, `test/public-history-privacy.test.ts`, `scripts/verify-public-history.mjs`, this plan/spec, comments citing the historical rename.

- [ ] **Step 2: Fix stragglers with the substitution table**

Same rules as Tasks 6–7. No new tests whose only assertion is string presence.

- [ ] **Step 3: Run targeted then verify**

Run: `npm test -- --run test/mcp.test.ts test/bridge.test.ts test/extension.test.ts test/packaging.test.ts test/fiber.test.ts`

Then: `npm run typecheck`

If those pass: `npm test -- --run` is allowed; do not start `npm run dist`.

Expected: typecheck clean; targeted tests PASS.

- [ ] **Step 4: Commit if anything remains**

```bash
git add <only files from this sweep>
git commit -m "Clear remaining ChatBBC identity leftovers."
```

Skip the commit if the search is already clean.

---

## Spec coverage

| Spec section | Task |
|---|---|
| §1 identity table | 1–5, 7 |
| §2 ChatGPT connectors, descriptions, recreate apps | 2, 3, 8 |
| §2 instructions / tool errors | 6 |
| §3 hard cut userData, protocol bump, extension, no CoS URLs | 1, 4, 5 |
| §4 rewrite vs leave | 8, 9 (leave LICENSE/CONTRIBUTORS/privacy gate) |
| §5 out of scope | no UI/icon/internal-prefix tasks |
| §6 risks (protocol 7 class, both apps on 8765) | 1 + docs note in 8 |
| §7 acceptance | 9 verification |

Human GitHub rename is outside git and is called out in Global Constraints.
