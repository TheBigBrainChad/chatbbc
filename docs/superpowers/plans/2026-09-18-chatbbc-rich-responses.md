# ChatBBC Rich Responses, Native Interactions and Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use /subagent-driven-development (recommended) or /executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT-generated images and rich answers appear durably in ChatBBC and let a user operate supported mirrored controls through the exact original ChatGPT conversation.

**Architecture:** Keep canonical messages, image assets and browser ownership with their existing owners. Repair native-image discovery first, add a versioned bounded presentation projection on the existing assistant-message shard, then route user clicks through a dedicated durable bridge action and the paired companion, with fresh page verification and observed postconditions. These are three reviewable milestones of one feature: images work independently; rich presentation adds no execution; native interaction requires the first two.

**Tech Stack:** Electron 44, TypeScript 7, Chrome MV3 companion JavaScript (MAIN and isolated worlds), Node HTTP bridge and durable JSON, Sharp 0.35, Zod 4, Vitest 5/jsdom, existing semantic appearance CSS.

**Spec:** `docs/superpowers/specs/2026-09-18-chatbbc-rich-responses-design.md` — read the entire specification and `AGENTS.md` before Task 1.

## Global Constraints

- Linux is the live development and validation target; preserve legacy Windows/macOS source and tests. Preserve Omarchy compatibility, semantic theme tokens and existing CSP/context isolation.
- Checked starting declarations: package/app/extension version `2.1.17`, app slug `chatbbc`, bridge protocol `15`. Re-read them immediately before implementation. A new wire contract must advance the protocol together on both sides and synchronize the release versions in package, lockfile, main and extension; do not choose a release number speculatively in this plan.
- The shared tree may change. Before each edit read `git status --short`, `git diff -- <files>`, and applicable `AGENTS.md`; preserve all other work. If isolation is needed at execution, use `/using-git-worktrees` and do not move or reset somebody else's changes.
- Canonical `assistant_message.messageId` can be a logical `assistant:…` key. The raw provider UUID is distinct, optional drift evidence. Native image identity is the exact provider-message UUID plus asset ID. Neither text equality, current tab, DOM position nor a URL alone authorizes a message/media/control join.
- Recording Off persists no new rich history, media or action state. Explicit removal and the existing 2 GiB global image-asset quota stay authoritative; retain removal tombstones, session deletion and retention behavior.
- New rich-tree ceiling per complete message: 128 KiB serialized, 1,024 nodes, depth 24, 128 controls, 64 media references and 8 KiB per text node; also obey the bridge's 2 MiB request limit and extension journal limits. Exceeding a limit yields an explicit unavailable state, never a silently cropped tree or an unbounded allocation.
- Never evaluate model-authored code, JSX/DIL, event handlers or arbitrary CSS; never persist signed URLs, cookies, credentials or raw provider payloads. Do not add a webview, independent image cache, generic IPC executor, new input queue or second control authority.
- Only an explicit user interaction can reopen one original conversation, and only while it remains the eligible current frontend. A superseded A after Compact & Resume is historical display/manual open only. Loading history/startup is never a tab-opening grant.
- A supported action needs current native element/selection proof. Persist `may-have-dispatched` before granting the click; crash, timeout, late ACK and browser restart cannot cause an automatic replay. Native selection reset requires user reselection before Continue.
- Do not borrow the MCP browser-control debugger, active executor's tab authority, worker revival or Stop/input commands. A real signed-in background click with an observed result is a feasibility gate; synthetic `.click()` alone is not evidence.
- Source, mock tests, build, package, installed app and live provider operation are separate evidence levels. Test using Vitest's isolated bridge ports; do not point fixtures at the installed production bridge.
- Each production task: fail-first regression and neighboring negative case, minimal owner-level fix, focused checks, reviewer gate, scoped commit only when execution is authorized. `npm run verify` and `npm run build` are end-to-end checks after protocol integration.

---

## File/owner map and fixed interfaces

| Owner | Existing files / focused additions | Responsibility |
| --- | --- | --- |
| Native image discovery/capture | `extension/fiber.js`, `extension/content.js` | Discover only typed public images; preserve original provider tuple; capture loaded pixels under current epoch. |
| Image admission/history | `src/main/bridge.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/shared/session.ts` | Validate observations, decode/store previews, anchor native-image events, quota/retirement. |
| Rich-tree contract | **Create** `src/shared/rich-response.ts`, **create** `src/main/session/rich-response.ts` | Versioned schema/types and bounded validation + exact publication helpers. Canonical storage remains `store.ts`. |
| Native rich discovery | `extension/fiber.js`, `extension/chatgpt-dom.js`, `extension/content.js` | Prove logical-message ↔ current raw provider ID ↔ mounted DOM, extract bounded semantic structure and control observations. No invented join. |
| Rich transcript | **Create** `src/renderer/rich-response.ts`, modify `src/renderer/chat.ts`, `src/renderer/styles/transcript.css` | Safe DOM construction, layout, media slots, keyboard/focus and text fallback. Reuse the app's appearance variables. |
| Wire compatibility | `src/main/version.ts`, `extension/background.js`, `src/main/bridge.ts`, `test/extension.test.ts` | Gate the new observation/action shapes on a matching bridge protocol; mixed peers never execute partial actions. |
| Inline assets | `src/main/session/store.ts`, `src/main/session/recorder.ts`, `src/main/session/input-history.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, **create** `src/renderer/rich-image.ts` | Reuse `writeAsset`/`readAsset`, extend existing `sessions:image` asset-membership check, cleanup/tombstones and bounded local viewer. |
| Native action authority | **Create** `src/main/rich-actions.ts`, modify `src/main/bridge.ts`, `extension/background.js`, `extension/content.js`, `extension/chatgpt-dom.js` | One serialized durable action ledger, authenticated claim/open/dispatch/result, exact native operation and ACK custody. |
| Human action interface | `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/rich-response.ts`, `src/renderer/chat.ts` | Named validated `sessions:richAction`, read-only `sessions:richActionStatus`, `sessions:richRetryImage`, `sessions:richOpenOriginal` operations; renderer cannot choose tool/URL/selector. |
| Release/contracts/docs | `src/main/version.ts`, `extension/background.js`, `extension/manifest.json`, `package.json`, `package-lock.json`, `test/extension.test.ts`, `AGENTS.md`, focused worklog | Explicit protocol compatibility and real acceptance evidence. Only bump release version for an authorized release preparation, and keep all declarations synchronized. |

The following interfaces are **proposed contracts**, introduced and tested in the named tasks. Do not treat them as functions that already exist:

```ts
// Task 4: src/shared/rich-response.ts
export const RICH_LIMITS = { bytes: 131_072, nodes: 1024, depth: 24, controls: 128, media: 64, textNode: 8192 } as const;
export type RichNode =
  | { id: string; kind: 'text'; text: string; style: 'body' | 'heading' | 'caption' | 'code' }
  | { id: string; kind: 'group'; layout: 'row' | 'column' | 'grid' | 'card' | 'list' | 'table' | 'diagram'; children: RichNode[] }
  | { id: string; kind: 'image'; mediaId: string; alt: string; width: number | null; height: number | null }
  | { id: string; kind: 'control'; control: 'choice' | 'continue' | 'button' | 'checkbox' | 'radio' | 'select' | 'input' | 'link'; label: string; groupId: string | null; value: string | null; selected: boolean; disabled: boolean; children: RichNode[] };
export type RichResponse = {
  version: 1;
  status: 'available' | 'unavailable';
  reason: 'unsupported' | 'oversized' | 'ambiguous' | null;
  conversationId: string;
  messageId: string; // canonical logical message key
  providerMessageId: string | null; // currently evidenced provider identity, not a shard key
  revision: number;
  accessibleText: string;
  nodes: RichNode[];
};
export function parseRichResponse(input: unknown): RichResponse | null;

// Task 5: src/main/session/rich-response.ts
export type RichObservation = { rich: RichResponse; documentId: string; navigationEpoch: number };
export async function recordRichObservation(conversationId: string, item: RichObservation): Promise<'stored' | 'unchanged' | 'refused'>;

// Task 11: src/main/rich-actions.ts
export type RichActionKind = 'select' | 'continue';
export type RichActionIntent = { sessionId: string; messageId: string; revision: number; nodeId: string; kind: RichActionKind; value: string | null };
export type RichActionResult = { id: string; state: 'pending' | 'observed' | 'unknown' | 'changed' | 'unavailable'; detail: string };
export async function beginRichAction(intent: RichActionIntent): Promise<RichActionResult>;
export async function electRichAction(id: string, exactTab: number | null, documentId: string | null, navigationEpoch: number | null): Promise<boolean>;
export async function armRichAction(id: string, documentId: string, navigationEpoch: number): Promise<boolean>;
export async function finishRichAction(id: string, outcome: 'observed' | 'unknown' | 'changed' | 'unavailable', detail: string): Promise<RichActionResult>;
export async function readRichActionStatus(sessionId: string, id: string): Promise<RichActionResult>;
```

In Task 4, `parseRichResponse` is the sole shared admission vocabulary. On the wire, only the app-derived session/epoch is authoritative: page-supplied `conversationId`, logical ID and document fields must be independently corroborated against the authenticated bridge sender and the recorder's canonical shard. In Task 11, the four action functions own one serialized ledger; authenticated bridge routes may wrap them, but the renderer never calls their internal functions or chooses a Chrome tab. Unknown controls render inert and offer manual-open until a later explicitly evidenced adapter is added. Task 11 adds the durable action-record fields and transition signatures; this small public facade is not a replacement for the typed authenticated bridge messages defined there.

---

### Task 1: Live failure and native-control feasibility report

**Files:**
- Read: `AGENTS.md`, spec, `extension/fiber.js:595-680`, `extension/content.js:3293-3448`, `src/main/session/recorder.ts:1739-1813`, `src/renderer/chat.ts:1267-1314`.
- Create: directory `docs/superpowers/evidence/` and `docs/superpowers/evidence/2026-09-18-rich-responses-live.md` (redacted observations only); this evidence directory does **not** exist at plan-writing time.
- Test: actual signed-in ChatGPT tab, installed ChatBBC and matching companion; no fixture runs against production bridge.

**Interfaces:**
- Consumes: the four user scenarios in spec §§1, 9 and `browser_tabs`/`browser_snapshot`/`browser_evaluate`/`browser_action`/`browser_screenshot` read and input tools under the user's existing browser permissions.
- Produces: redacted evidence for provider output family, exact page-root/message/control join, image-loss stage, installed version/protocol and native accepted-input behavior. This report gates Tasks 2, 6 and 10.

- [ ] **Step 1: Record baseline and source versions.**

```bash
mkdir -p docs/superpowers/evidence
git status --short
git rev-parse HEAD
rg -n 'APP_VERSION|BRIDGE_PROTOCOL|"version"' src/main/version.ts extension/background.js extension/manifest.json package.json
```

Inspect installed app/extension version from their real diagnostics; distinguish package declarations from installed payload. Save only version, protocol and stage outcomes. Avoid copying whole page HTML, account details, request bodies or signed URLs.

- [ ] **Step 2: Reproduce each visible failure in an existing signed-in browser.** Reuse an already-open page. Observe single generation, multi-generation/image-only, selectable-card + Continue, and rich diagram; capture bounded screenshots for visual comparison and compact DOM structure/role/attribute summaries from the exact message root. For each image classify `typed discovery → emitted metadata → DOM join → loaded pixels → bridge → asset → sessions:image → paint`; record the first unsupported transition and Recording Off/quota/version observations.

```text
Case                         Original visible?  Native identity?  First failing stage  Installed versions
Single generated image       record actual      record actual     record actual        record actual
Gallery / image-only         record actual      record actual     record actual        record actual
Choice + Continue            record actual      record actual     record actual        record actual
Diagram / embedded image     record actual      record actual     record actual        record actual
```

- [ ] **Step 3: Prove a real native action in a safe test conversation.** Inspect the exact card's message and accessible control identities, select a test option using supported browser input, verify its native selected state, then activate Continue once and verify the resulting native transition. Exercise background operation without stealing focus or attaching the agent browser-control debugger to a protected executor tab. Stop and record a feasibility blocker if the page cannot prove target identity or accepted input; revise the supported-control adapter contract before writing an executor.

```text
Acceptance: verified conversation + raw provider UUID + unique control + pre-state
           → one user-authorized native input → observed post-state/new turn.
Refusal: missing join, disabled control, wrong chat, duplicate label, reset choice or unknown post-state.
```

- [ ] **Step 4: Capture minimal non-sensitive fixture descriptions and verify the report.** Convert only public role/channel/type/identity shape (replace IDs with fixture UUIDs and remove query strings/secrets) into later test fixtures. Review the report for credentials, personal prompts, signed URLs and unsupported assertions.

```bash
git diff --check
rg -n 'access_token|authorization:|sig=|Bearer |cookie:' docs/superpowers/evidence/2026-09-18-rich-responses-live.md
```

Expected: `git diff --check` succeeds; the second command finds no sensitive values (exit 1). The report states exactly which behaviors were demonstrated and which remain unverified.

- [ ] **Step 5: Review and commit this evidence only if the execution session authorizes commits.**

```bash
git add docs/superpowers/evidence/2026-09-18-rich-responses-live.md
git commit -m "test: document rich response live compatibility evidence"
```

**Gate:** Tasks 2/3 follow the observed first missing image boundary; Tasks 6/12 cannot claim native selection/Continue supported without Step 3. Do not insert speculative selectors or synthesize a provider image ID to bypass this gate.

### Task 2: Repair typed native-image discovery and explicit unsupported states

**Files:**
- Modify: `extension/fiber.js:595-680`, `extension/content.js:3144-3200,4050-4105`, `src/main/bridge.ts:958-973,1048-1157`, `src/main/session/recorder.ts:1650-1711` only if the confirmed first wrong stage requires them.
- Test: `test/fiber.test.ts`, `test/content-script.test.ts`, `test/bridge.test.ts`.

**Interfaces:**
- Consumes: Task 1's sanitized observed family; current `turn.images` descriptor `{ messageId, assetId, providerRole, providerChannel, providerStatus, order, partOrder }` and `native_image` observation.
- Produces: correct exact-identity descriptor for each evidenced public family; for exact-owned unrecognized public media, a bounded `assistant_message.richMediaUnavailable?: 'unsupported'` presentation attribute (introduced on `ChatObservation` and the assistant event in this task), with no invented `native_image` tuple.

- [ ] **Step 1: Write the fail-first fixture using the actual observed public type and its known negative.** Keep `scan()`'s real Fiber runner and `replyFiber()` content harness. The explicit baseline case below must remain valid; add Task 1's *different* real shape beside it, with sanitized literal data and no fetch URL.

```ts
it('retains the exact typed public image tuple and excludes a user upload', async () => {
  const publicMessage = {
    id: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
    author: { role: 'tool' }, recipient: 'all', channel: 'final',
    status: 'finished_successfully',
    content: { content_type: 'multimodal_text', parts: [
      { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_000000005f2c823085a542762d1de785', width: 1024, height: 1024 }
    ] }
  };
  const result = await scan([], [{ id: 'image-turn', messages: [publicMessage] }]);
  expect(result.turns[0]!.images).toMatchObject([{ messageId: publicMessage.id,
    assetId: 'file_000000005f2c823085a542762d1de785' }]);
  const upload = await scan([], [{ id: 'upload-turn', messages: [{ ...publicMessage, author: { role: 'user' } }] }]);
  expect(upload.turns[0]?.images ?? []).toEqual([]);
});
```

- [ ] **Step 2: Run the focused RED suite and record which new assertion fails.**

```bash
npm test -- --run test/fiber.test.ts test/content-script.test.ts
```

Expected: the added actual-shape regression fails for missing public-image discovery/association, or proves this boundary already works and directs the repair to Task 3. Do not edit a working recognizer to make an artificial red test.

- [ ] **Step 3: Repair the earliest proven owner and represent unsupported output truthfully.** Retain provider UUID plus typed file ID, original part ordering and role/channel/status restrictions. Only admit the family actually observed in Task 1; when a verified assistant DOM root has public image pixels but no safe provider tuple, mark its canonical assistant row `richMediaUnavailable: 'unsupported'`, not a fake native-image event. Ensure `recordChatObservations` preserves that attribute through ordinary revisions and ignores it for Goal/turn activity.

```ts
// Contract applied at the existing bridge/recorder owner, not via raw HTML.
type UnsupportedMediaObservation = {
  kind: 'assistant_message';
  messageId: string; // canonical logical id
  richMediaUnavailable: 'unsupported';
};
// The parser may attach this only to an existing exact-owned public message.
```

- [ ] **Step 4: Run positive and negative boundary suites.**

```bash
npm test -- --run test/fiber.test.ts test/content-script.test.ts test/bridge.test.ts
```

Expected: evidenced family yields correct native tuple or explicit exact-owned unsupported state; uploads/private channels/wrong message and unsigned URLs produce neither false media nor activity. Add a regression on whichever missing branch Task 1 established.

- [ ] **Step 5: Review and commit the scoped fix.**

```bash
git diff --check
git add extension/fiber.js extension/content.js src/main/bridge.ts src/main/session/recorder.ts src/shared/session.ts test/fiber.test.ts test/content-script.test.ts test/bridge.test.ts
git diff --cached --stat
git commit -m "fix: recognize observed public image output without guessing identity"
```

Stage only files actually changed; leave other files untouched. An unchanged discovery owner needs no empty commit.

### Task 3: Make existing generated-image previews reliably appear

**Files:**
- Modify: `extension/content.js:3293-3448`, `src/main/bridge.ts:1100-1154`, `src/main/session/recorder.ts:1739-1813`, `src/main/session/store.ts:1302-1398`, `src/renderer/chat.ts:1267-1314` only at the Task 1 failure boundary.
- Test: `test/content-script.test.ts`, `test/bridge.test.ts`, `test/image-storage.test.ts`, `test/renderer-timeline.test.ts`.

**Interfaces:**
- Consumes: exact `native_image` metadata from Task 2 and existing `providerStatus: 'finished_successfully'` capture gate.
- Produces: one metadata row per `(provider message UUID, provider asset ID)` enriched with `previewStatus`, `previewWidth`, `previewHeight` and `asset`, using existing `sessions:image` IPC; no new cache.

- [ ] **Step 1: Write a regression at the actual failing stage.** Extend the real content harness with a loaded exact-stamped image that initially encodes to more than 384,000 WebP bytes, then produces a compliant smaller preview only after a bounded, lower-resolution encode; also test an unowned clone cannot be captured. If Task 1 instead finds a bridge/storage/renderer failure, place the equivalent fail-first regression in its existing nearest suite and retain the no-duplicate/wrong-owner negative.

```ts
// Existing content harness shape: exact stamp, exact estuary file ID and final status.
expect(emitted(live.sent, 'native_image').filter(row => row.event.previewStatus === 'available'))
  .toHaveLength(1);
expect(emitted(live.sent, 'native_image').some(row => JSON.stringify(row).includes('sig=')))
  .toBe(false);
```

- [ ] **Step 2: Establish RED from the installed failure's matching fixture.**

```bash
npm test -- --run test/content-script.test.ts test/bridge.test.ts test/renderer-timeline.test.ts
```

Expected: one new test proves the missing pixels/status/paint while the existing gallery, final-status and stale-epoch tests continue to pass.

- [ ] **Step 3: Implement only the diagnosed repair.** For an encode-size failure, try at most three sequential `canvas.toBlob('image/webp', quality)` encodes at scale/quality `(1600,0.8)`, `(1200,0.7)`, `(800,0.6)`, each constrained by the current 30-million source pixels, 2,560,000 preview pixels and 384,000 encoded bytes. Use the first compliant fully loaded image, persist its *actual* geometry, revalidate ownership after each await and report `oversized` if all fail. If source evidence instead identifies a missing typed join, bridge rejection or bad renderer hydration, correct that owner and do not add adaptive encoding without an observed need.

```js
const attempts = [[1600, 0.8], [1200, 0.7], [800, 0.6]];
// All attempt results must pass the existing exact-source/epoch checks before publication.
// Publish only one 'available' event, and preserve the original image source dimensions.
```

- [ ] **Step 4: Prove single/gallery/image-only, quota, removal, restart and render behavior.**

```bash
npm test -- --run test/content-script.test.ts test/bridge.test.ts test/image-storage.test.ts test/renderer-timeline.test.ts
```

Expected: no duplicate gallery copies, no private URL in observations, no pixel storage before native completion, removed assets stay removed, image-only final remains visible, stale A→B→A captures lose the race.

- [ ] **Step 5: Review/commit and repeat actual image generation with updated companion/app.**

```bash
git diff --check
git add extension/content.js src/main/bridge.ts src/main/session/recorder.ts src/main/session/store.ts src/renderer/chat.ts test/content-script.test.ts test/bridge.test.ts test/image-storage.test.ts test/renderer-timeline.test.ts
git diff --cached --stat
git commit -m "fix: retain and display exact generated image previews"
```

Stage only changed files. Reviewer must see one real updated-app single image and one gallery/image-only result before declaring Milestone A complete; distinguish installed evidence from mock tests.

### Task 4: Define and bound the complete rich response format

**Files:**
- Create: `src/shared/rich-response.ts`.
- Test: **Create** `test/rich-response-schema.test.ts`.

**Interfaces:**
- Consumes: the Task 1 verified semantic subset, existing `AssetRef` identity and the exact proposed `RichNode`, `RichResponse`, `RICH_LIMITS` contracts in the file map.
- Produces: `parseRichResponse(input: unknown): RichResponse | null`; `null` means malformed/untrusted, while an exact-owned oversized tree becomes an explicit `status: 'unavailable', reason: 'oversized'` projection at the recorder after trusted message identity is established. The parser never turns invalid identity into a fabricated message.

- [ ] **Step 1: Write the schema's RED tests.** Make the minimal good tree pass and hostile inputs fail, including a foreign URL masquerading as a media ID, an extra source field, 1,025 nodes, depth 25, 129 controls, 65 media references, text over 8,192 characters, 128 KiB serialized and a cycle. Never `JSON.stringify` a cyclic input before the walk rejects it.

```ts
import { expect, it } from 'vitest';
import { parseRichResponse, RICH_LIMITS } from '../src/shared/rich-response.js';

const good = {
  version: 1, status: 'available', reason: null,
  conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: 'assistant:working:exchange:1789552000000',
  providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
  revision: 1, accessibleText: 'Choose one',
  nodes: [{ id: 'n0', kind: 'text', style: 'body', text: 'Choose one' }]
};
it('accepts a small semantic tree and rejects executable/remote content', () => {
  expect(parseRichResponse(good)).toEqual(good);
  expect(parseRichResponse({ ...good, nodes: [{ ...good.nodes[0], onclick: 'run()' }] })).toBeNull();
  expect(parseRichResponse({ ...good, nodes: [{ id: 'x', kind: 'image',
    mediaId: 'https://example.test/secret', alt: '', width: 12, height: 12 }] })).toBeNull();
  expect(RICH_LIMITS.bytes).toBe(131072);
});
```

- [ ] **Step 2: Verify the test fails before implementing the new contract.**

```bash
npm test -- --run test/rich-response-schema.test.ts
```

Expected: the missing schema module/function is RED; no existing suite must be modified to fake a rich response.

- [ ] **Step 3: Write the type union and a single complete validator.** Export the interface block from the file map verbatim. Use `typeof`, `Array.isArray`, own enumerable keys and a `WeakSet` for cycle detection; bound serialized UTF-8 bytes using `TextEncoder` (also available in Electron's sandboxed renderer) only after a size/depth/count-safe structural traversal. Require integer nonnegative revision and finite bounded geometry, unique node IDs, opaque `mediaId` matching `/^[a-z0-9:_-]{1,190}$/i`, no arbitrary properties, and zero nodes for unavailable state. An unknown node/control kind fails closed; limit failures may be translated to unavailable only after exact message identity is corroborated by Task 5.

```ts
export const RICH_LIMITS = { bytes: 131_072, nodes: 1024, depth: 24,
  controls: 128, media: 64, textNode: 8192 } as const;
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;
const exact = (o: Obj, names: readonly string[]): boolean =>
  Reflect.ownKeys(o).length === names.length &&
  Reflect.ownKeys(o).every(k => typeof k === 'string' && names.includes(k) &&
    Object.getOwnPropertyDescriptor(o, k)?.get === undefined &&
    Object.getOwnPropertyDescriptor(o, k)?.set === undefined);
const opaque = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9:_-]{1,190}$/i.test(v);
const geometry = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 100_000);

export function parseRichResponse(input: unknown): RichResponse | null {
  const root = object(input);
  if (!root || !exact(root, ['version','status','reason','conversationId','messageId',
    'providerMessageId','revision','accessibleText','nodes']) || root.version !== 1 ||
    !['available','unavailable'].includes(root.status as string) ||
    !Number.isSafeInteger(root.revision) || (root.revision as number) < 0 ||
    typeof root.conversationId !== 'string' ||
    !/^[a-z0-9-]{8,64}$/i.test(root.conversationId) ||
    typeof root.messageId !== 'string' || root.messageId.length > 256 ||
    root.messageId.length === 0 ||
    (root.providerMessageId !== null &&
      (typeof root.providerMessageId !== 'string' ||
       !/^[a-z0-9-]{8,100}$/i.test(root.providerMessageId))) ||
    !Array.isArray(root.nodes) || root.nodes.length > RICH_LIMITS.nodes) return null;
  if (root.status === 'available' ? root.reason !== null :
      !['unsupported','oversized','ambiguous'].includes(root.reason as string)) return null;
  if (root.status === 'unavailable' && root.nodes.length !== 0) return null;
  const encoder = new TextEncoder();
  let utf8 = 0, count = 0, controls = 0, media = 0;
  const seen = new WeakSet<object>(), ids = new Set<string>();
  const string = (v: unknown, limit = RICH_LIMITS.textNode): v is string => {
    if (typeof v !== 'string' || v.length > limit) return false;
    utf8 += encoder.encode(v).length;
    return utf8 <= RICH_LIMITS.bytes;
  };
  if (!string(root.accessibleText, RICH_LIMITS.bytes) ||
      !string(root.conversationId, 64) || !string(root.messageId, 256) ||
      (root.providerMessageId !== null && !string(root.providerMessageId, 100))) return null;
  const node = (value: unknown, depth: number): RichNode | null => {
    const o = object(value);
    if (!o || seen.has(o) || depth > RICH_LIMITS.depth ||
        ++count > RICH_LIMITS.nodes || !opaque(o.id) || ids.has(o.id) ||
        !string(o.id, 190)) return null;
    seen.add(o); ids.add(o.id);
    if (o.kind === 'text') {
      if (!exact(o, ['id','kind','text','style']) || !string(o.text) ||
          !['body','heading','caption','code'].includes(o.style as string)) return null;
      return { id: o.id, kind: 'text', text: o.text, style: o.style as Extract<RichNode,{kind:'text'}>['style'] };
    }
    if (o.kind === 'image') {
      if (!exact(o, ['id','kind','mediaId','alt','width','height']) ||
          !opaque(o.mediaId) || !string(o.mediaId,190) || !string(o.alt) ||
          !geometry(o.width) || !geometry(o.height) || ++media > RICH_LIMITS.media) return null;
      return { id: o.id, kind: 'image', mediaId: o.mediaId, alt: o.alt,
        width: o.width, height: o.height };
    }
    if (o.kind !== 'group' && o.kind !== 'control') return null;
    const group = o.kind === 'group';
    if (!exact(o, group ? ['id','kind','layout','children'] :
      ['id','kind','control','label','groupId','value','selected','disabled','children']) ||
      !Array.isArray(o.children) || o.children.length > RICH_LIMITS.nodes) return null;
    if (group) {
      if (!['row','column','grid','card','list','table','diagram'].includes(o.layout as string)) return null;
    } else if (++controls > RICH_LIMITS.controls ||
      !['choice','continue','button','checkbox','radio','select','input','link'].includes(o.control as string) ||
      !string(o.label) || (o.groupId !== null && (!opaque(o.groupId) || !string(o.groupId,190))) ||
      (o.value !== null && !string(o.value)) ||
      typeof o.selected !== 'boolean' || typeof o.disabled !== 'boolean') return null;
    const children: RichNode[] = [];
    for (const child of o.children) {
      const parsed = node(child, depth + 1);
      if (!parsed) return null;
      children.push(parsed);
    }
    if (group) return { id: o.id, kind: 'group',
      layout: o.layout as Extract<RichNode,{kind:'group'}>['layout'], children };
    return { id: o.id, kind: 'control',
      control: o.control as Extract<RichNode,{kind:'control'}>['control'], label: o.label as string,
      groupId: o.groupId as string | null, value: o.value as string | null,
      selected: o.selected as boolean, disabled: o.disabled as boolean, children };
  };
  const nodes: RichNode[] = [];
  for (const value of root.nodes) {
    const parsed = node(value, 1);
    if (!parsed) return null;
    nodes.push(parsed);
  }
  const result: RichResponse = { version: 1, status: root.status as RichResponse['status'],
    reason: root.reason as RichResponse['reason'], conversationId: root.conversationId,
    messageId: root.messageId, providerMessageId: root.providerMessageId as string | null,
    revision: root.revision as number, accessibleText: root.accessibleText, nodes };
  return encoder.encode(JSON.stringify(result)).length <= RICH_LIMITS.bytes ? result : null;
}
```

- [ ] **Step 4: Run complete boundary tests and a typecheck.**

```bash
npm test -- --run test/rich-response-schema.test.ts
npm run typecheck
```

Expected: all positive/negative budget cases pass; TypeScript accepts the exported types without weakening existing session events.

- [ ] **Step 5: Review and commit this independently testable contract.**

```bash
git diff --check
git add src/shared/rich-response.ts test/rich-response-schema.test.ts
git commit -m "feat: define bounded rich response schema"
```

### Task 5: Persist rich revisions on the existing canonical assistant shard

**Files:**
- Modify: `src/shared/session.ts:308-339` (assistant event plus optional session binding revision), `src/main/session/store.ts:272-278,293-326,1103-1299,2743-2802`, `src/main/session/recorder.ts:1650-1711,1955-2007,2100-2207`, `src/main/bridge.ts:1048-1166,2160-2252`.
- Create: `src/main/session/rich-response.ts`.
- Test: **Create** `test/rich-response-store.test.ts`; extend `test/session.test.ts`, `test/bridge.test.ts`.

**Interfaces:**
- Consumes: Task 4's `RichResponse`, `parseRichResponse`, existing `upsertMessageEvent(sessionId,event,options)` and `conversationAttachment(conversationId,sessionId)`.
- Produces: `recordRichObservation(conversationId,item): Promise<'stored'|'unchanged'|'refused'>` from the file map and a store-owned `upsertRichMessage(sessionId:string,messageId:string,rich:RichResponse,origin:RichOrigin): Promise<'stored'|'unchanged'|'refused'>`, where `RichOrigin = { conversationId:string; bindingRevision:number; documentId:string; navigationEpoch:number }`. Add `rich?: RichResponse`, `richOrigin?: RichOrigin`, `richMediaUnavailable?: 'unsupported'`, `retiredRichImageAssetIds?: string[]` to the assistant event. Add `bindingRevision?: number` to `SessionSummary`, initialize it to `0` and increment atomically inside `rebindSession`'s existing durable metadata commit; a missing legacy field reads as `0`.

- [ ] **Step 1: Write RED tests for one canonical message and a stale snapshot.** Insert the raw assistant event, enrich it with a valid tree, reload, then rebind A→B→A and try to publish a stale A document. Assert the original `origin`, `contentSeq`, `finalContentSeq`, Goal and turn facts are unchanged; no separate transcript row is created. Test an unsolicited rich event with no canonical assistant row and a provider UUID that belongs to another message is refused.

```ts
const raw = await upsertMessageEvent(session.id, {
  kind: 'assistant_message', source: 'extension', time: 100,
  messageId: 'logical-a', message: { text: 'Choose', chars: 6, truncated: false },
  providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
  state: 'final', final: true
});
const outcome = await upsertRichMessage(session.id, 'logical-a', validRich, {
  conversationId: conversationA, bindingRevision: 0,
  documentId: 'document-a', navigationEpoch: 1
});
expect(outcome).toBe('stored');
const canonical = (await readEvents(session.id)).find(row => row.kind === 'assistant_message');
expect(canonical?.origin).toBe(raw.event.origin);
expect(canonical?.contentSeq).toBe(raw.event.contentSeq);
```

- [ ] **Step 2: Run RED against canonical owner and bridge test fixtures.**

```bash
npm test -- --run test/rich-response-store.test.ts test/session.test.ts test/bridge.test.ts
```

Expected: missing rich upsert/binding revision is RED; existing canonical message tests remain readable.

- [ ] **Step 3: Add one serialized, durable rich update in `store.ts`.** `upsertRichMessage` finds the existing assistant shard by its *logical* `messageId`, checks independently corroborated provider UUID and origin, accepts monotonically newer same-owner structure, and writes the full message to the existing canonical shard before publishing. The store, rather than extension input, assigns `rich.revision = previous.rich.revision + 1` only when content/state actually changes. Require `origin.bindingRevision` to equal the current session's durable revision for live publication; historical superseded content is permitted only through the recorder's existing history-specific read-only placement and cannot yield action authority. On a conflicting provider/owner/epoch or stale duplicate return `refused`/`unchanged` without touching completion or text stamps.

```ts
export type RichOrigin = { conversationId: string; bindingRevision: number;
  documentId: string; navigationEpoch: number };
export async function upsertRichMessage(sessionId: string, messageId: string,
  rich: RichResponse, origin: RichOrigin): Promise<'stored' | 'unchanged' | 'refused'>;
// The existing per-session entry.queue owns write ordering and writeCanonicalMessage publication.
```

Implement `recordRichObservation` as a narrow adapter inside the recorder's existing observation pass. Require Recording On, resolve the exact conversation/session and existing canonical shard, use trusted bridge/registered-document evidence to corroborate document/epoch, call the store's upsert and report only the store verdict. Extend `parseObservations` field-wise rather than copying arbitrary rich objects. The bridge may carry exact document provenance added by the paired background sender, but a provider DOM field alone is not authorization. If current bridge transport cannot substantiate a document, reject the rich snapshot until Task 6 adds a proven association; never invent an epoch.

- [ ] **Step 4: Test write failure, compaction, Recording Off and restart.**

```bash
npm test -- --run test/rich-response-schema.test.ts test/rich-response-store.test.ts test/session.test.ts test/bridge.test.ts
```

Expected: A→B→A stale write cannot overwrite the newer A; failed durable write leaves old shard; Recording Off creates no rich record; stale provider UUID cannot retarget a shard; rich-only revisions do not advance work/Goal.

- [ ] **Step 5: Review and commit the persistence boundary.**

```bash
git diff --check
git add src/shared/session.ts src/main/session/store.ts src/main/session/recorder.ts src/main/session/rich-response.ts src/main/bridge.ts test/rich-response-store.test.ts test/session.test.ts test/bridge.test.ts
git commit -m "feat: persist rich projections on exact assistant messages"
```

### Task 6: Capture verified rich DOM roots, layout and control state

**Files:**
- Modify: `extension/fiber.js:740-905` and scan result assembly, `extension/chatgpt-dom.js` native message helpers, `extension/content.js:3144-3200,4050-4212`, `src/main/bridge.ts` bounded observation admission.
- Test: `test/fiber.test.ts`, `test/content-script.test.ts`, `test/extension.test.ts`, `test/bridge.test.ts`.

**Interfaces:**
- Consumes: Task 1 exact join proof, Task 4 `RichNode` vocabulary/limits and Task 5 `recordRichObservation` owner. The MAIN-world Fiber reader emits **only** allowlisted `(logical messageId, raw provider ID, exact root association)` evidence, not React props, callbacks or user/tool payloads.
- Produces: bounded version-1 `rich` observations attached to an existing assistant message; media slots carry only opaque message/node-scoped `mediaId` until Task 9 admits bytes. `CLF_DOM` gains `richRootFor(logicalMessageId, providerMessageId): Element | null` and `captureRichRoot(root: Element): RichResponse['nodes'] | null` with uniquely proven ownership.

- [ ] **Step 1: Add a fail-first rich-card fixture and wrong-owner twin.** Extend the real Fiber `scan` fixture with an **exactly joined** rich root outside `.markdown` (using Task 1's observed binding), two choice cards with visible text and image slots, a Continue button, and a second assistant message with an identically labelled Continue. Assert only the correct root is stamped/serialized. Also add an ordinary fenced code example containing literal `<text>`; it must remain authored code.

```ts
expect(turns[0]!.messages[0]!.messageId).toBe('assistant:working:exchange:1789552000000');
expect(turns[0]!.messages[0]!.rawMessageId).toBe('3150f756-bf2d-45fa-ac0f-45010b2239fb');
expect(turns[0]!.messages[0]!.rich?.nodes.some(node => node.kind === 'control')).toBe(true);
expect(turns[1]!.messages[0]!.rich).toBeUndefined();
```

- [ ] **Step 2: Run the RED extension boundaries.**

```bash
npm test -- --run test/fiber.test.ts test/content-script.test.ts test/extension.test.ts
```

Expected: rich non-Markdown UI does not yet appear; matched `.markdown` messages and tools continue to pass.

- [ ] **Step 3: Implement a bounded DOM→semantic adapter.** Use Task 1's *verified* page-provided message-to-root association and `fiber.js`'s direct identity stamps. Accept a root only when it is uniquely owned by the exact logical message and current raw provider ID; no positional, text or `only candidate` fallback for action anchors. Traverse actual DOM after hydration with a `WeakSet`, count/depth/text limits and allowlisted computed semantics (`display:grid/flex` mapped to `group`, heading/body/code, image slots, accessible role/label, checked/disabled and parent group). Do not serialize `innerHTML`, style strings, `href` as action URL, callbacks or React state. Unknown static visual becomes `unsupported` or Task 9's separately live-proven bounded visual capture; unknown controls remain inert.

```js
// This is the only allowed output family from the adapter, never executable markup.
const choice = { id: 'choice-b', kind: 'control', control: 'choice', label: 'B',
  groupId: 'answer-choice', value: 'B', selected: false, disabled: false, children: [] };
// Preserve node ids through a stable exact-root re-observation, not by screen coordinates.
```

Keep the capture output under the 128 KiB rich-tree budget and extension journal byte cap. Send structure revisions only when the verified root changes; a changed selection/HTML is presentation, not a model work tick. A stale document, wrong provider ID, ambiguous root or deleted node yields an explicit unavailable view and cannot mint a new message. A closed document's last verified selection is historical display only and not an executable selection lease. Task 9, **not** Task 8, owns optional media pixel capture and any independently live-proven bounded visual fallback.

- [ ] **Step 4: Run the joined transport and hostile-root tests.**

```bash
npm test -- --run test/fiber.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts test/rich-response-schema.test.ts
```

Expected: direct rich root captured; identical labels in another answer, transient React replacement, stale A→B→A and malformed/oversized trees are refused. Existing ordinary Markdown/code remains ordinary text.

- [ ] **Step 5: Review and commit the capture adapter.**

```bash
git diff --check
git add extension/fiber.js extension/chatgpt-dom.js extension/content.js src/main/bridge.ts test/fiber.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts
git commit -m "feat: capture exactly owned rich answer structures"
```

**Gate:** If Task 1 found no exact native message/root relation, stop this task at the explicit unsupported representation and revise the design before claiming functional choice mirroring.

### Task 7: Render semantic answers responsively and accessibly

**Files:**
- Create: `src/renderer/rich-response.ts`.
- Modify: `src/renderer/chat.ts:938-1050,1267-1272`, `src/renderer/styles/transcript.css`, `src/renderer/appearance.ts` only if an existing theme projection cannot express a required semantic token.
- Test: **Create** `test/rich-response-renderer.test.ts`; extend `test/renderer-timeline.test.ts`.

**Interfaces:**
- Consumes: Task 4 `RichResponse` parser/tree; Task 5 optional assistant `rich`/`richMediaUnavailable`; existing `renderedMarkdown(source,capture)` and selection-generation/viewport mechanisms.
- Produces: `renderRichResponse(rich: RichResponse, fallback: string): HTMLElement`, a safe local DOM tree; media nodes initially render named loading/unavailable slots until Task 9 supplies image bytes. Controls are disabled/inert until Tasks 11–13 supply current authority.

- [ ] **Step 1: Write RED renderer tests for both supplied examples and a code negative.** Create a valid choice/card tree and a wide diagram/table tree; assert card count, proper accessible roles, no literal markup from authored component source, contained horizontal scroll and that no button invokes browser action before an action interface exists. An authored code block `<text>` must continue to be displayed as code. Test a deliberately unavailable rich tree renders a friendly fallback with an explicit expandable raw-source control.

```ts
const view = renderRichResponse(richFixture, '<text>source</text>');
expect(view.querySelectorAll('.rich-card')).toHaveLength(2);
expect(view.querySelector('[data-rich-control="continue"]')?.getAttribute('aria-disabled')).toBe('true');
expect(view.textContent).not.toContain('<text>source</text>');
expect(view.querySelector('.rich-layout')).not.toBeNull();
```

- [ ] **Step 2: Run RED renderer tests.**

```bash
npm test -- --run test/rich-response-renderer.test.ts test/renderer-timeline.test.ts
```

Expected: missing renderer function/cards produce RED; current normal prose/table tests remain passing.

- [ ] **Step 3: Implement `renderRichResponse` using `document.createElement` and `textContent`.** Parse the stored representation again before rendering; reject invalid structures and render unavailable fallbacks. Translate group `layout` into a fixed CSS class, never arbitrary tag names/attributes. Reserve image aspect ratio from validated geometry; add explicit focusable region and keyboard-friendly disabled controls. Integrate by changing only the assistant branch of `eventRow`; do not reinterpret source strings as live components.

```ts
case 'assistant_message': {
  const box = el('div', 'said');
  box.append(el('b', '', () => event.final ? 'ChatGPT' : t('ChatGPT (partial)')));
  box.append(event.rich ? renderRichResponse(event.rich, event.message.text)
    : renderedMarkdown(event.message.text, event.renderedHtml));
  return box;
}
```

Add `.rich-layout { min-width:0; max-width:100%; overflow-wrap:anywhere }`, grid tracks using `minmax(0,1fr)`, and contained scroll on `.rich-table`/`.rich-diagram` using existing theme variables. The fallback for a genuinely rich but unavailable snapshot shows “Rich content unavailable — open original in ChatGPT” and only reveals component source on deliberate expansion. Use a verified rich/unavailable flag, never a regex over ordinary code examples.

- [ ] **Step 4: Run renderer/history/layout checks.**

```bash
npm test -- --run test/rich-response-renderer.test.ts test/renderer-timeline.test.ts
npm run typecheck
```

Expected: no chat-wide horizontal overflow under resize/zoom, chronological origins unchanged, old records without `rich` still readable, no remote images/scripts/forms admitted, focus/RTL/reduced motion and Omarchy tokens preserved. Use a real Electron layout probe at final integration, since jsdom cannot verify geometry.

- [ ] **Step 5: Review and commit static rich presentation.**

```bash
git diff --check
git add src/renderer/rich-response.ts src/renderer/chat.ts src/renderer/styles/transcript.css src/renderer/appearance.ts test/rich-response-renderer.test.ts test/renderer-timeline.test.ts
git commit -m "feat: render rich ChatGPT layouts safely in transcript"
```

Stage only changed files. Milestone B requires repeating both original visual examples in the updated app; static rich display is independently useful even while controls remain inert.

### Task 8: Coordinate the new bridge wire contract and refuse mixed-version peers

**Files:**
- Modify: `src/main/version.ts`, `extension/background.js`, `src/main/bridge.ts`, `extension/content.js`, `test/extension.test.ts`, `test/bridge.test.ts`.
- Test: `test/extension.test.ts`, `test/bridge.test.ts`, `test/content-script.test.ts`.

**Interfaces:**
- Consumes: existing `BRIDGE_PROTOCOL = 15`, `compatible` handshake, `parseObservations(input: unknown): ChatObservation[]` and the Task 4 parser. The actual executable action endpoints and their payload schemas are owned by Tasks 11–12, not a generic bridge operation.
- Produces: paired **protocol 16** declarations and a field-wise `assistant_message.rich` projection with `parseRichResponse` applied before recorder/store admission. Task 9 adds the separately bounded `rich_media` observation under this same protocol and Task 11 adds the fixed action routes; neither may run with mismatched peers. If baseline is no longer protocol 15 at execution, choose its next protocol number in both places and update the same test; never silently reuse an existing number for a changed contract. App/extension package versions remain unchanged until the authorized release-preparation step in Task 16.

- [ ] **Step 1: Write RED compatibility/validation tests.** Add one old-peer test to `test/extension.test.ts` and one injected-rich-body test to `test/bridge.test.ts` using the existing VM/bridge harness. Verify that an old companion's compatibility handshake fails (action offers do not exist until Task 11), unknown `rich` keys and executable fields do not cross `parseObservations`, and a valid Task 4 tree remains attached to the existing logical message. Do not open an action endpoint yet.

```ts
const rich = { version: 1, status: 'available', reason: null,
  conversationId: conversationA, messageId: 'logical-a', providerMessageId: providerA,
  revision: 1, accessibleText: 'Choose', nodes: [{ id: 'text-a', kind: 'text', style: 'body', text: 'Choose' }] };
expect(parseRichResponse({ ...rich, script: 'alert(1)' })).toBeNull();
// In the existing extension VM handshake fixture, feed bridge: 15 to a protocol-16 client.
expect(extensionStatus.portCompatible).toBe(false);
// In the authenticated /events fixture, no second assistant event may be minted by rich data.
expect(canonicalAssistantRows).toHaveLength(1);
```

- [ ] **Step 2: Run the focused RED contract tests.**

```bash
npm test -- --run test/extension.test.ts test/bridge.test.ts test/content-script.test.ts
```

Expected: the newly added assertion expecting 16 or strict rich admission is RED, while old test fixtures still show the existing protocol-15 behavior. Keep test bridge ports isolated by the existing Vitest config.

- [ ] **Step 3: Change both protocol declarations and the exact parser together.** Change `BRIDGE_PROTOCOL` from `15` to `16` in `src/main/version.ts` and `extension/background.js`; update the protocol assertion hardcoded in `test/extension.test.ts`. Keep `parseObservations`' 200-item limit and the 2 MiB HTTP body ceiling; reconstruct only allowed rich/media properties instead of passing arbitrary page objects. Reject rich actions on protocol mismatch through the existing `extensionProtocol`/compatibility check, including a stale extension that can still post ordinary observations. Do not bump the npm/manifest release version as a side effect of this contract task.

```ts
// Bridge's existing observation switch, after its exact assistant-message case:
if (kind === 'assistant_message' && item['rich'] !== undefined) {
  const rich = parseRichResponse(item['rich']);
  if (rich) observation.rich = rich;
}
// Task 9 separately adds 'rich_media' to OBSERVATION_KINDS only alongside its
// exact field-wise parser and authenticated document evidence.
// Never pass through item['rich'] or item['rich_media'] as unknown objects.
```

The fragment is a parser insertion, not an instruction to let malformed input impersonate an exact-owned message: the recorder must establish that owner before attaching `richMediaUnavailable`. Extend `ChatObservation` with only the named optional fields, and preserve all legacy observation semantics.

- [ ] **Step 4: Prove matching/mismatching peers and bounded admission.**

```bash
npm test -- --run test/extension.test.ts test/bridge.test.ts test/content-script.test.ts test/rich-response-schema.test.ts
npm run typecheck
```

Expected: protocol 16 peers exchange existing observations; protocol 15 peers cannot use new shapes or actions; over-limit and foreign rich payloads do not create canonical rows, image bytes or action authority.

- [ ] **Step 5: Review and commit the paired contract.**

```bash
git diff --check
git add src/main/version.ts extension/background.js src/main/bridge.ts extension/content.js test/extension.test.ts test/bridge.test.ts test/content-script.test.ts
git diff --cached --stat
git commit -m "feat: gate rich response wire contract on paired protocol"
```

Stage only changed files; any final release-number synchronization belongs to Task 16.

### Task 9: Capture and admit embedded media on the canonical assistant message

**Files:**
- Modify: `src/shared/session.ts`, `extension/content.js`, `src/main/bridge.ts`, `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/main/session/input-history.ts`, `src/renderer/rich-response.ts`.
- Test: **Create** `test/rich-media.test.ts`; extend `test/content-script.test.ts`, `test/bridge.test.ts`, `test/image-recording.test.ts`, `test/preload-images.test.ts`.

**Interfaces:**
- Consumes: Task 4 `RichNode` image slots, Task 5 exact shard and `RichOrigin`, Task 6 exact native root, existing `native_image` provider tuple, `recordNativeImage`'s preview gates and `writeAsset(sessionId, data, mimeType): Promise<AssetRef>`.
- Produces: `RichMediaState`, `RichMediaObservation` and `upsertRichMedia(sessionId: string, messageId: string, media: RichMediaState, origin: RichOrigin, expectedRichRevision: number): Promise<'stored'|'unchanged'|'refused'>`. `assistant_message.richMedia?: RichMediaState[]` is a bounded adjunct on **that same shard**, never a separate event row. `rich_media` is an observation kind, **not** a `SessionEvent` kind. New media updates leave `contentSeq`, `finalContentSeq`, work and chronology unchanged. Extend `recordedInputImage(sessionId,assetId)` in `src/main/session/input-history.ts` to include only assets referenced by a validated canonical assistant `richMedia` record; this existing function is the actual `sessions:image` membership gate and currently enumerates user/native/tool references only.

```ts
export type RichMediaState = {
  mediaId: string; nodeId: string;
  source: { kind: 'native'; providerMessageId: string; providerAssetId: string }
        | { kind: 'page'; nodeId: string };
  status: 'pending' | 'available' | 'unavailable';
  reason?: 'not_loaded' | 'unsupported' | 'ambiguous' | 'tainted' | 'oversized' | 'invalid' | 'quota' | 'removed';
  previewWidth?: number; previewHeight?: number; asset?: AssetRef;
};
export type RichMediaObservation = {
  conversationId: string; messageId: string; providerMessageId: string;
  documentId: string; navigationEpoch: number; bindingRevision: number;
  mediaId: string; nodeId: string; richRevision: number; source: RichMediaState['source'];
  status: RichMediaState['status']; previewDataUrl?: string;
  previewWidth?: number; previewHeight?: number;
  reason?: RichMediaState['reason'];
};
export async function upsertRichMedia(sessionId: string, messageId: string,
  media: RichMediaState, origin: RichOrigin,
  expectedRichRevision: number): Promise<'stored' | 'unchanged' | 'refused'>;
```

`RichMediaObservation` is an untrusted wire shape: `conversationId`, binding revision and document ID from its payload are hints only; the bridge/recorder derives authoritative identity from its authenticated source, registered document and store attachment before upsert. A `page` identity is exactly the `(canonical messageId,nodeId,mediaId)` relation, not a URL or DOM position. `native` shares the existing exact provider tuple and existing local asset reference **only after** the corresponding native-image event is available and in the same session.

- [ ] **Step 1: Write RED tests for a reference image and one generated-image reuse.** In `test/rich-media.test.ts`, start from an existing assistant shard with `rich.nodes` containing image `mediaId: 'card-image-b'`/`id: 'image-node-b'`; persist pending metadata, then a validated local WebP preview, then read that same assistant row. Add a second test with a generated native image whose exact tuple is already available; rich association must reuse its `asset.id`. Add negatives for different message, duplicate same media ID, stale epoch, opaque URL as media ID and Recording Off.

```ts
expect(row.kind).toBe('assistant_message');
expect(row.richMedia?.find(m => m.mediaId === 'card-image-b')).toMatchObject({
  nodeId: 'image-node-b', status: 'available', asset: { mimeType: 'image/webp' }
});
expect(events.filter(e => e.kind === 'native_image')).toHaveLength(0); // page-only image
expect(sharedRichMedia.asset?.id).toBe(existingNativeImage.asset?.id); // exact native tuple
expect(await upsertRichMedia(otherSession, 'logical-a', media, originA, validRich.revision)).toBe('refused');
```

Use the existing `test/content-script.test.ts` canvas/loaded-image fixture and `test/image-recording.test.ts` Sharp/asset fixtures; populate these values through those harnesses, not with a new mock storage implementation.

- [ ] **Step 2: Run RED media boundary suites.**

```bash
npm test -- --run test/rich-media.test.ts test/content-script.test.ts test/image-recording.test.ts
```

Expected: missing `rich_media` schema/upsert or missing exact image-slot capture fails; existing standalone `native_image` tests still pass.

- [ ] **Step 3: Implement metadata-first, bounded capture and serialized asset admission.** `content.js` emits one pending `rich_media` for each exact media slot (up to 64), captures only a fully decoded image in Task 6's current document, rechecks logical/root/provider/node/epoch after every await, and uses Task 3's existing bounded WebP preview routine. If canvas is tainted, record `tainted`, never fetch the image URL using main-process authority. Do not add the screenshot crop until a separate real-page test demonstrates exact visible bounds, unobscured viewport, existing permission and no debugger contention; an unavailable reason is safer than an unproven fallback. Split preview observations into batches that fit the 2 MiB request and 4 MiB extension journal without dropping metadata.

```ts
// Recorder: after Recording On and authenticated exact-origin checks, not before them.
if (observation.status === 'pending') return upsertRichMedia(sessionId, messageId, pending, origin, observation.richRevision);
if (observation.source.kind === 'native') {
  const match = await findExactNativeImage(sessionId, observation.source);
  if (!match?.asset) return upsertRichMedia(sessionId, messageId, pending, origin, observation.richRevision);
  return upsertRichMedia(sessionId, messageId, { ...pending, status: 'available', asset: match.asset }, origin, observation.richRevision);
}
const preview = await validateImagePreview(observation.previewDataUrl,
  observation.previewWidth, observation.previewHeight); // factor recordNativeImage
const asset = await writeAsset(sessionId, preview.bytes, 'image/webp');
return upsertRichMedia(sessionId, messageId,
  { ...pending, status: 'available', asset, previewWidth: preview.width,
    previewHeight: preview.height }, origin, observation.richRevision);
```

The two named extraction helpers are introduced here in `recorder.ts`: `findExactNativeImage` reads canonical native events by both provider IDs, and `validateImagePreview` factors the existing Sharp/data-URL admission into one helper used by native and rich images. Define a local `type NativeImageEvent = Extract<SessionEvent, {kind:'native_image'}>` (the store's similarly named alias is private). Their signatures are `(sessionId: string, source: Extract<RichMediaState['source'], {kind:'native'}>): Promise<NativeImageEvent | null>` and `(dataUrl: string | undefined, width: number | undefined, height: number | undefined): Promise<{bytes:Buffer;width:number;height:number}>`; the latter retains the existing 512,100-character, 384,000-byte, 2,560,000-pixel and 1600-per-side checks and verifies the **reported** geometry matches fully decoded pixels. A failed validation becomes an explicit unavailable reason, never a throw that loses the whole assistant row. Before and after `writeAsset`, re-read current owner, binding, expected rich revision, tombstones and cleanup epoch in the store's per-session serial queue; failed stale publication must not create a visible asset reference. Extend `recordedInputImage`'s existing `readEvents(...,{kinds:[...]})` to include `assistant_message`, and admit only a live `richMedia[].asset` matching `assetId`, with no retired ID; retain its Sharp decode and MIME check and never accept a renderer-supplied path as membership.

- [ ] **Step 4: GREEN owner/transport tests.**

```bash
npm test -- --run test/rich-media.test.ts test/content-script.test.ts test/bridge.test.ts test/image-recording.test.ts test/image-storage.test.ts test/preload-images.test.ts
npm run typecheck
```

Expected: metadata precedes pixels; an exact page image gets an on-message preview; a shared generated asset has one stored asset ID and no extra timeline row; tainted/late/wrong-owner/quota output reports a truthful reason; image-only native outputs remain unchanged.

- [ ] **Step 5: Review and commit inline admission.**

```bash
git diff --check
git add src/shared/session.ts extension/content.js src/main/bridge.ts src/main/session/recorder.ts src/main/session/store.ts src/main/session/input-history.ts src/renderer/rich-response.ts test/rich-media.test.ts test/content-script.test.ts test/bridge.test.ts test/image-recording.test.ts test/preload-images.test.ts
git diff --cached --stat
git commit -m "feat: retain exact embedded media on rich assistant messages"
```

No second binary store, image-only timeline row, page URL persistence or automatic full-resolution download is permitted.

### Task 10: Retire all shared rich-image references without resurrection

**Files:**
- Modify: `src/main/session/store.ts:3138-3279`, `src/shared/session.ts`, `src/main/session/recorder.ts` if an admitted capture can bypass tombstones.
- Test: `test/image-storage.test.ts`, `test/session-retention.test.ts`; extend `test/rich-media.test.ts`.

**Interfaces:**
- Consumes: Task 9 `assistant_message.richMedia`, existing `referencedAssetIds`, `retireImageReferences`, `retireSessionImages` and `clearImageStorage` under the current asset queue.
- Produces: assistant-side `retiredRichImageAssetIds: string[]` tombstones and a complete cross-event reference inventory. Existing `sessions:clearImageStorage` is still the sole deletion route. Task 9's `upsertRichMedia` must refuse any `asset.id` matching the assistant tombstone or asset cleanup generation.

- [ ] **Step 1: Write fail-first two-owner cleanup/restart races.** In the real `test/image-storage.test.ts` temporary session store, create two image nodes and one native image sharing asset A, plus an unrelated asset B. Clear image storage, restart/reopen the store, replay the old rich preview and native preview, and assert A is still removed, B follows the selected cleanup mode and both rich nodes report `removed`. Cover a failed canonical shard write: physical A must not be deleted until *all* references are durably retired.

```ts
expect(after.richMedia?.filter(m => m.asset?.id === removedId)).toHaveLength(0);
expect(after.richMedia?.filter(m => m.reason === 'removed')).toHaveLength(2);
expect(after.retiredRichImageAssetIds).toContain(removedId);
expect(afterNative.previewStatus).toBe('unavailable');
expect(afterNative.previewError).toBe('removed');
expect(await upsertRichMedia(sessionId, messageId, oldAvailable, oldOrigin, oldRichRevision)).toBe('refused');
```

- [ ] **Step 2: Run RED retention tests.**

```bash
npm test -- --run test/image-storage.test.ts test/session-retention.test.ts test/rich-media.test.ts
```

Expected: the newly added assistant inventory/retirement case fails with a leftover reference or resurrection; existing user/tool/native cleanup cases remain green.

- [ ] **Step 3: Extend the existing asset retirement transaction, not a new collector.** Add assistant assets to `referencedAssetIds`. In `retireImageReferences`, rewrite every matching rich media state to `{status:'unavailable', reason:'removed'}` without `asset`, and append the selected IDs to `retiredRichImageAssetIds`. Add `'assistant_message'` to `retireSessionImages`'s supported keyed event kinds and keep all references in the same pre-delete durable pass. `upsertRichMedia` must check both the assistant tombstone and `removedAssetEpoch` after awaiting the asset queue, before canonical publication. An explicit user-selected Retry in Task 14 uses a new narrow override recorded under the same store queue; ordinary re-observation cannot clear tombstones.

```ts
if (event.kind === 'assistant_message') {
  const removed = (event.richMedia ?? []).filter(m => m.asset && selected.has(m.asset.id));
  if (!removed.length) return null;
  const retiredRichImageAssetIds = [...new Set([
    ...(event.retiredRichImageAssetIds ?? []), ...removed.map(m => m.asset!.id)
  ])];
  return { ...event, retiredRichImageAssetIds,
    richMedia: (event.richMedia ?? []).map(m =>
      m.asset && selected.has(m.asset.id)
        ? { ...m, status: 'unavailable' as const, reason: 'removed' as const, asset: undefined }
        : m) };
}
```

Keep the existing `clearImageStorage` ordering: select under asset queue → persist all event tombstones → remove physical bytes. A failed write prevents deletion; duplicate references from native and rich must not cause double frees.

- [ ] **Step 4: Prove GREEN cleanup and session deletion.**

```bash
npm test -- --run test/image-storage.test.ts test/session-retention.test.ts test/rich-media.test.ts test/session.test.ts
npm run typecheck
```

Expected: all shared references are retired before deleting a file, restart/reobserve does not refill it, session deletion/retention removes rich and native assets under existing policy, metadata/alt/layout survive without pixels.

- [ ] **Step 5: Review and commit cleanup.**

```bash
git diff --check
git add src/main/session/store.ts src/shared/session.ts src/main/session/recorder.ts test/image-storage.test.ts test/session-retention.test.ts test/rich-media.test.ts
git diff --cached --stat
git commit -m "fix: retire shared rich media through existing image storage"
```

### Task 11: Implement durable, exclusive native-action custody in the main bridge

**Files:**
- Create: `src/main/rich-actions.ts`, `test/rich-actions.test.ts`.
- Modify: `src/main/bridge.ts`, `src/main/session/store.ts` only for an exact canonical-message read helper, `src/main/session/recorder.ts` only for a current-binding lookup.
- Test: `test/rich-actions.test.ts`, `test/bridge.test.ts`.

**Interfaces:**
- Consumes: Task 5 `bindingRevision`, `rich`, `richOrigin`, Task 6 native-control descriptors, `activeSessionId`, `getSession`, `conversationAttachment`, `conversationWasSuperseded`, blocked chat checks, `readEvents` and `writeDurableNow` from `src/main/durable.ts`.
- Produces: the file-map's `beginRichAction`, `electRichAction`, `armRichAction` and `finishRichAction` with the corrected finish signature below; the bridge's paired, authenticated **fixed** operations `POST /rich-actions/claim`, `/rich-actions/open`, `/rich-actions/elect`, `/rich-actions/arm`, `/rich-actions/result`. Add `readRichActionStatus(sessionId:string,id:string):Promise<RichActionResult>` as a **read-only** local status method for Task 13; reading status never grants browser opening, dispatch, replay or synthetic success. Every bridge route is tied to the existing companion token, protocol 16, stored action ID and trusted registered sender/epoch. No page-supplied session or tab identity is authority.

```ts
export type RichActionPhase = 'intent' | 'opening_spent' | 'elected' | 'may_have_dispatched'
  | 'observed' | 'unknown' | 'changed' | 'unavailable' | 'retired';
export type RichActionRecord = {
  id: string; phase: RichActionPhase; createdAt: number;
  claimOwner: string | null; // server-derived fingerprint of authenticated pairing, never raw bearer
  sessionId: string; conversationId: string; bindingRevision: number;
  messageId: string; providerMessageId: string; revision: number;
  nodeId: string; kind: 'select' | 'continue'; value: string | null;
  expectedSelected: boolean; expectedGroupSelection: string | null;
  tabId: number | null; documentId: string | null; navigationEpoch: number | null;
  openingSpent: boolean; resultDetail: string | null;
};
export async function beginRichAction(intent: RichActionIntent): Promise<RichActionResult>;
export async function electRichAction(id: string, exactTab: number | null,
  documentId: string | null, navigationEpoch: number | null): Promise<boolean>;
export async function armRichAction(id: string, documentId: string,
  navigationEpoch: number): Promise<boolean>;
export async function finishRichAction(id: string,
  outcome: 'observed' | 'unknown' | 'changed' | 'unavailable',
  detail: string): Promise<RichActionResult>;
export async function readRichActionStatus(sessionId: string,
  id: string): Promise<RichActionResult>;
```

`RichActionIntent.sessionId` is merely a renderer request: before creating a record, derive the trusted current selection from `activeSessionId()` and the main window selection, compare it to the requested session, reread the canonical row and require Recording On, current attachment/binding, nonblocked/nonsuperseded conversation, exact node/revision/kind/value and an observed selected-group state for Continue. A historical snapshot does not prove the current native state; Task 12 checks it again. Only one pending action per `(sessionId,messageId,groupId)`; reject a second rapid click until the first settles. `RichActionRecord` contains no DOM selector, model callback, URL, token or raw page markup.

**Fixed bridge request/response contract (all five routes require `authorised(req)` and `protocolCompatible(req)`):**

| Route | Bounded JSON body | Success response and state gate |
| --- | --- | --- |
| `POST /rich-actions/claim` | `{}` | `{action: RichActionOffer\|null}`; atomically assign `claimOwner` from the authenticated pairing to one *already durably accepted* intent before returning only its exact provider conversation/message/node descriptor. Repeated claim by the same owner returns the same **unarmed** offer; no other owner may claim it. |
| `POST /rich-actions/open` | `{id:string}` | `{allow:boolean,conversationId:string}` only on the first persisted `openingSpent` transition for an exact claimed record; never grants a second tab creation after uncertain query/create. If an eligible existing tab was elected, opening is not needed. |
| `POST /rich-actions/elect` | `{id:string,tabId:number,documentId:string,navigationEpoch:number}` | `{elected:boolean}` after verifying claim owner, current session binding and the companion's Chrome-sender-backed registered document; persist before acknowledging election. No page or renderer can supply an authoritative tab ID. |
| `POST /rich-actions/arm` | `{id:string,documentId:string,navigationEpoch:number}` | `{grant:RichActionOffer\|null}` only after one successful durable `may_have_dispatched` write and a fresh exact election. A repeated request after grant returns `null`, not a second grant. |
| `POST /rich-actions/result` | `{id:string,conversationId:string,messageId:string,documentId:string,navigationEpoch:number,outcome:'observed'\|'unknown'\|'changed'\|'unavailable',detail:string}` | `{receipt:RichActionResult}` only when exact owner/generation matches; commit result and retirement in one durable snapshot. Identical duplicates receive the stored receipt, conflicting duplicates/foreign owners are rejected. |

`RichActionOffer` is defined here as `Pick<RichActionRecord,'id'|'conversationId'|'messageId'|'providerMessageId'|'revision'|'nodeId'|'kind'|'value'|'expectedSelected'|'expectedGroupSelection'|'documentId'|'navigationEpoch'>`. Its initial unarmed form has nullable document/epoch; `arm` returns a fully elected one. HTTP bodies are reconstructed field by field under the existing 2 MiB cap with ID/string lengths from Task 4 and integer tab/epoch checks; no caller-controlled URL, CSS selector, JS, generic operation or app session principal is accepted. The `claimOwner` is a server-calculated opaque fingerprint of the existing random pairing credential, persisted without the bearer and rechecked against the current authenticated peer on every route; re-pairing invalidates pending old-peer claims. The extension proves document identity using Chrome `MessageSender` and its existing registered-document lease, while the bridge checks that current companion-registered evidence against the action. A page-provided document field alone cannot elect or arm.

- [ ] **Step 1: Write fail-first action-ledger tests including the irreversible cut.** Use the bridge's existing temporary durable-storage and paired-companion harness. Start a verified choice intent and inspect disk transitions `intent → opening_spent → elected → may_have_dispatched → observed/unknown → retired`. Inject a process restart after each durable write, a rejected write before arming, a delayed/lost result, concurrent double-clicks and an A→B→A rebind. Verify `armRichAction` cannot return true before **awaited** `writeDurableNow('rich-actions', snapshot)` has succeeded.

```ts
const first = await beginRichAction(validChoiceIntent);
expect(first.state).toBe('pending');
expect(await beginRichAction(validChoiceIntent)).toMatchObject({ state: 'unavailable' });
expect(await armRichAction(first.id, 'doc-a', 1)).toBe(false); // no election
expect(await electRichAction(first.id, tabA, 'doc-a', 1)).toBe(true);
await blockNextDurableWrite();
expect(await armRichAction(first.id, 'doc-a', 1)).toBe(false); // NO grant
await restoreAfterCrash();
expect(await armRichAction(first.id, 'doc-a', 1)).toBe(false); // ambiguous old attempt
```

Test fixture helpers `blockNextDurableWrite` and `restoreAfterCrash` are added in `test/rich-actions.test.ts` using the established bridge/durable module mocks; they are test-only and never exported by production code. Include a negative where a stale result carries the right UUID but wrong conversation/document/generation; it cannot retire the current action.

- [ ] **Step 2: Run RED owner and bridge tests.**

```bash
npm test -- --run test/rich-actions.test.ts test/bridge.test.ts
```

Expected: missing ledger and routes fail; the new no-grant-after-failed-checkpoint assertion is RED until durability is implemented.

- [ ] **Step 3: Implement one serialized durable ledger and explicit states.** Use a dedicated key `rich-actions` with versioned snapshot `{version:1, actions:RichActionRecord[], receipts:RichActionResult[]}` and a single serialized promise queue, analogous to bridge commands but never sharing their state/lease. Reject new actions if the bounded ledger is full; never prune unresolved, armed or unacknowledged records to make room. A restart restores pre-dispatch records only for read-only reconciliation and marks any `may_have_dispatched` action `unknown` unless its exact persisted receipt proves the outcome. The `open` endpoint persists `openingSpent:true` **before** any extension tab-create grant. A Chrome tab-query failure consumes the current attempt as unknown; another query/timer cannot create a second opening. `elect` binds one registered tab/document/epoch and refuses a different election, including after refresh. `arm` synchronously persists `may_have_dispatched` before returning the one-action click grant. `result` and receipt retirement are one durable transition; an identical duplicate result returns the persisted receipt, a conflicting or foreign result is refused.

```ts
async function armRichAction(id: string, documentId: string, navigationEpoch: number): Promise<boolean> {
  return enqueueRichTransition(async () => {
    const action = requireElectedCurrentAction(id, documentId, navigationEpoch);
    if (!action) return false;
    await writeDurableNow('rich-actions', snapshotWith(action, { phase: 'may_have_dispatched' }));
    return true; // only after the durable write; never from a finally branch
  });
}
```

The three named private helpers are implemented in this file: `enqueueRichTransition` serializes all actions as `(<T>(work:()=>Promise<T>)=>Promise<T>)`; `requireElectedCurrentAction` resolves and rereads an exact recorded action and current session/document; `snapshotWith` returns a copied version-1 ledger reflecting one transition, without mutating in-memory state until its disk write succeeds. The bridge route must also verify its authenticated extension generation and current page lease; no `tabId` or `documentId` argument from the renderer enters `elect`/`arm`. Integrate restore in the bridge's existing restore lifecycle, without a new timer or second HTTP listener.

- [ ] **Step 4: GREEN and adversarial lifecycle checks.**

```bash
npm test -- --run test/rich-actions.test.ts test/bridge.test.ts test/session.test.ts
npm run typecheck
```

Expected: no click grant before the durable cut; no repeated grant after restore or lost ACK; wrong account/session/conversation/action/document/revision or blocked/Recording Off gets no action; A→B→A cannot revive A. A previously issued irreversible grant remains unknown until its observed exact postcondition is committed.

- [ ] **Step 5: Review and commit durable ownership.**

```bash
git diff --check
git add src/main/rich-actions.ts src/main/bridge.ts src/main/session/store.ts src/main/session/recorder.ts test/rich-actions.test.ts test/bridge.test.ts
git diff --cached --stat
git commit -m "feat: persist one-shot native rich control action authority"
```

**Gate:** Task 12 must not introduce a click path until the pre-dispatch crash test proves the durable cut. If Task 1 could not verify a safe live native input, land only this inert ledger and leave action routes non-arming pending a revised, reviewed control adapter.

### Task 12: Execute exactly one verified original-page control through the companion

**Files:**
- Modify: `extension/background.js`, `extension/content.js`, `extension/chatgpt-dom.js`, `src/main/bridge.ts` only for exact action payload parsing.
- Test: **Create** `test/rich-action-extension.test.ts`; extend `test/extension.test.ts`, `test/content-script.test.ts`, `test/browser-control-extension.test.ts`.

**Interfaces:**
- Consumes: Task 1 proven native selection/Continue input mechanism, Task 6 `richRootFor`/`captureRichRoot`, Task 11 `/rich-actions/{claim,open,elect,arm,result}` and `RichActionRecord` identity. Extension source identity comes from Chrome `MessageSender.tab.id`, `MessageSender.documentId` and the existing `authorizeDocument`/registered-document owner; never from a page body.
- Produces: a narrow background-owned `RichActionOffer` and a single-use `clf-rich-invoke` content message. The offer/dispatch body is limited to `{id,conversationId,messageId,providerMessageId,revision,nodeId,kind,value,expectedSelected,expectedGroupSelection,documentId,navigationEpoch}`; `kind` permits only `'select'|'continue'`. Companion results are `{id,conversationId,messageId,documentId,navigationEpoch,outcome,detail,observedSelected,observedGroupSelection}` and are accepted only against the stored action. Add **no** generic browser command and **no** manifest permissions.

- [ ] **Step 1: Write RED exact-selection and closed-tab VM tests.** Start with a DOM fixture reproducing Task 1's verified native card structure: two different messages each have an identical Continue label; choice B belongs only to message A. Exercise selection A/B, Continue, disabled Continue, remounted options with a changed group, a stale message ID, duplicate B controls, and a closed original tab. Assert no wrong control receives any event, the active tab is not focused and the action is not recorded observed until its native selected value/new-turn effect is detected.

```ts
expect(nativeChoiceB.checked).toBe(true);        // after observed select, not local optimism
expect(otherMessageContinueClicks).toBe(0);     // same label, wrong exact owner
expect(originalContinueClicks).toBe(1);         // one authorized submission
expect(createdTabs).toHaveLength(1);            // explicitly closed target, one opening
expect(createdTabs[0]?.active).toBe(false);     // no focus theft
expect(await attemptWithResetSelection()).toBe('changed'); // zero Continue clicks
```

Use the real VM test's mocked `chrome.tabs`/`chrome.storage` and the current `replyFiber`/DOM harness. Add a negative proving a browser-control debugger owner already holding a protected tab remains untouched: no `chrome.debugger.attach`, stolen lease or simulated coordinates.

- [ ] **Step 2: Run RED native-action suites.**

```bash
npm test -- --run test/rich-action-extension.test.ts test/extension.test.ts test/content-script.test.ts test/browser-control-extension.test.ts
```

Expected: no existing action route handles the new action; the new exact control/at-most-once tests fail before implementation.

- [ ] **Step 3: Implement narrow open/elect/arm/execute/result custody.** The companion polls/claims only already accepted user intents; it may query ChatGPT tabs but may open **only after** the authenticated `/rich-actions/open` response proves main persisted `openingSpent`. Record an extension-side one-shot `{actionId,openingSpent,clickSpent,outcome}` in the existing `chrome.storage.local` custody before `chrome.tabs.create` or `chrome.tabs.sendMessage`; an ambiguous query or lost tab-create response yields unknown, never another create attempt. Use existing `createChatTab(url,true,false)` with the stored conversation URL constructed solely from the main-owned valid conversation ID. Do not activate or move another user's tab. If more than one equally eligible tab/document exists, return ambiguous rather than arbitrary election. Verify Chrome's current settled URL, registered conversation/document/epoch, tab protection, and latest sender lease before `/elect` and after every await.

```js
// background.js: the only click handout, after server-side durable may-have-dispatched.
const grant = await claimExactArm(action.id, source.documentId, source.navigationEpoch);
if (!grant.ok || grant.id !== action.id || spent[action.id]?.clickSpent) return;
spent[action.id] = { ...spent[action.id], clickSpent: true };
await persistLive(); // durable extension custody before sendMessage
await chrome.tabs.sendMessage(source.tab, { type: 'clf-rich-invoke', action: grant },
  { documentId: source.documentId });
```

`claimExactArm` is the new background helper that POSTs `/rich-actions/arm` with the exact record ID and authenticated current source; `spent` is an extension-owned bounded, persistently restored action map in the existing live-state snapshot; `persistLive` is the existing background persistence helper. Its pending entries cannot be evicted to free space while unknown or waiting for app receipt. Once armed, even a lost sendMessage response cannot cause a second invocation. Never allow an extension message from an unregistered/retired document to adopt a grant.

`content.js` receives `clf-rich-invoke` only from its own background, confirms its current `conversationId`, document/navigation epoch, unique exact `richRootFor`, raw provider identity, node revision/role/group/value and live `disabled`/selected state; it refuses changed/missing/ambiguous controls. For Continue, compare the **entire native group selection** with the last verified intended group value in the action record; if React reset or remounted it, return `changed` with no click and require user reselection. Invoke the Task 1-evidenced native input **once** and observe the actual postcondition as `chatgpt-dom.js::send` already does for text, without treating `.click()` or a local event dispatch as acceptance. For Continue, identify the native new turn/result via the existing recorder; do not synthesize a user-message observation. Other controls, including unverified links/text fields, remain inert with manual-open.

- [ ] **Step 4: Prove exactly-once behavior through MV3 suspension and lost results.**

```bash
npm test -- --run test/rich-action-extension.test.ts test/extension.test.ts test/content-script.test.ts test/browser-control-extension.test.ts test/rich-actions.test.ts
```

Expected: click count ≤1 for every ID after restart, duplicate poll, delayed result or duplicated `sendMessage`; app ack retires the extension receipt only when the same durable server result is confirmed. Wrong tab, stale document, A→B→A, native selection reset and protected executor yield zero clicks. Background-operation test demonstrates no focus theft.

- [ ] **Step 5: Review and commit the companion actuator.**

```bash
git diff --check
git add extension/background.js extension/content.js extension/chatgpt-dom.js src/main/bridge.ts test/rich-action-extension.test.ts test/extension.test.ts test/content-script.test.ts test/browser-control-extension.test.ts
git diff --cached --stat
git commit -m "feat: forward exact rich control actions to verified native UI"
```

**Live gate:** Before reporting this task green beyond mocks, repeat one real signed-in choice and one real Continue on an app-owned safe test chat and observe native results. If background input fails or needs the protected debugger, leave the affected controls disabled, record the blocker and revise the approved design with evidence before expanding authority.

### Task 13: Wire fixed IPC, preload and accessible control feedback

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/rich-response.ts`, `src/renderer/chat.ts`, `src/renderer/styles/transcript.css`.
- Test: **Create** `test/rich-action-ipc.test.ts`; extend `test/ipc.test.ts`, `test/renderer-timeline.test.ts`, `test/preload-images.test.ts` for the new fixed methods.

**Interfaces:**
- Consumes: `beginRichAction(intent: RichActionIntent): Promise<RichActionResult>` (Task 11), verified Task 12 postconditions and the Task 7 `renderRichResponse` DOM result. The main process independently obtains the selected session; the renderer's `selectionGeneration` is a display-staleness fence, not an authority token.
- Produces: fixed IPC channels `sessions:richAction`, read-only `sessions:richActionStatus` and `sessions:richOpenOriginal`; fixed preload functions `richAction(intent: RichActionIntent): Promise<Reply<RichActionResult>>`, `richActionStatus(sessionId:string,actionId:string):Promise<Reply<RichActionResult>>` and `openRichOriginal(sessionId: string, messageId: string): Promise<Reply<boolean>>`. `richActionStatus` delegates only to Task 11's `readRichActionStatus` after validating IDs and stored owner; it never claims, opens or dispatches. `openRichOriginal` reads the exact canonical assistant event's `richOrigin.conversationId` from history, checks membership in `summary.chatIds`, derives a validated `chatUrl` and calls existing `openInPreferredBrowser` **only on explicit user press**. A superseded chat may be manually opened but gains no action authority. `richAction` performs no native work in the IPC handler: it delegates exact main policy/ledger ownership to `beginRichAction`.

```ts
// Proposed shared typed renderer binding, defined in src/renderer/rich-response.ts.
export type RichControlContext = {
  sessionId: string; messageId: string; revision: number; selectionGeneration: number;
};
export function bindRichActionControls(view: HTMLElement, context: RichControlContext,
  perform: (intent: RichActionIntent) => Promise<RichActionResult>,
  readStatus: (sessionId: string, actionId: string) => Promise<RichActionResult>,
  currentSelectionGeneration: () => number): void;
```

- [ ] **Step 1: Write fail-first IPC and UI tests.** In `test/rich-action-ipc.test.ts` register existing IPC handlers, pass a valid logical message/node intent and require the ledger's real verdict. Reject malformed UUIDs, node IDs over 190 chars, stale revision, unselected session, Recording Off, a model-authored or blocked conversation and an unknown channel. Check that read-only status cannot mutate ledger phase or produce a browser offer; foreign session/action IDs cannot read receipts. In the renderer's jsdom harness, programmatic `click()` and synthetic Enter/Space must be rejected because `isTrusted` is false. Use the extracted app-owned gesture callback to test permitted UI logic with a test-owned trusted-gesture flag, then verify one selection and Continue request produce no text/composer send, and a delayed result after changing selected chat cannot paint the old card. The true browser trusted-event path is an explicit Task 16 Electron/live assertion, not something jsdom can simulate.

```ts
const invalid = await handlers.get('sessions:richAction')!(null, {
  sessionId: 'not-current', messageId: 'logical-a', revision: 1,
  nodeId: 'choice-b', kind: 'select', value: 'B'
});
expect(invalid.ok).toBe(false);
expect(nativeActionOffers).toHaveLength(0); // local test recorder for action offers
expect(sendComposerMessage).not.toHaveBeenCalled(); // spy on existing composer send path
expect(oldCard.getAttribute('aria-busy')).not.toBe('true'); // after selection changed
expect(await readRichActionStatus(otherSession, firstActionId)).toMatchObject({ state: 'unavailable' });
expect(browserOpensAfterStatusRead).toBe(0); // counter on existing browser-open fixture
```

- [ ] **Step 2: Run RED interface tests.**

```bash
npm test -- --run test/rich-action-ipc.test.ts test/ipc.test.ts test/renderer-timeline.test.ts
```

Expected: named handler/preload or event binding is missing, while existing `sessions:openChat`, safe-link and ordinary message tests still pass.

- [ ] **Step 3: Add only named input-validated channels and deterministic UI state.** `ipc.ts` uses Zod's exact object schema for `{sessionId,messageId,revision,nodeId,kind,value}` and separate `{sessionId,actionId}` for the status route: all bounded, `kind` enum choice/Continue, and no caller URL, document, selector, script or tab. It rechecks current selection/policy inside `beginRichAction`, not only the IPC validator. The preload exports only these fixed wrappers, never `ipcRenderer` or a configurable channel. `bindRichActionControls` finds only nodes created from `parseRichResponse` with semantic `'choice'|'continue'`, registers click/Enter/Space on these app-owned elements, and requires a trusted user event (`event.isTrusted`) rather than firing from rendering/hydration. A click marks the local control `aria-busy` and provisional intent only; **selected** presentation changes only when a subsequent exact native rich revision or observed action receipt confirms it. Disable simultaneous group actions, show `changed`, `unknown` or `unavailable` distinctly, and on native reset label the historical selection stale and require a new user selection before Continue.

```ts
// UI callback; selectionGeneration is rechecked both before and after await.
const shown = context.selectionGeneration;
const result = await perform({ sessionId: context.sessionId, messageId: context.messageId,
  revision: context.revision, nodeId, kind, value });
if (shown !== currentSelectionGeneration()) return; // never paint result in another chat
showRichActionResult(view, nodeId, result);         // pending is provisional, never success
if (result.state === 'pending') {
  // Bounded read-only status observations. This never reissues perform or browser work.
  for (let check = 0; check < 12; check++) {
    await waitForStatusInterval(500); // private helper: cancellable on selection/unmount
    if (shown !== currentSelectionGeneration() || !view.isConnected) return;
    const current = await readStatus(context.sessionId, result.id);
    if (shown !== currentSelectionGeneration() || !view.isConnected) return;
    showRichActionResult(view, nodeId, current);
    if (current.state !== 'pending') return;
  }
  showRichActionPendingUnconfirmed(view, nodeId); // no assumed outcome; manual original remains available
}
```

`readStatus` is the binder's **fourth** argument and `currentSelectionGeneration(): number` is its fifth, supplied as a scoped `chat.ts` callback rather than a global. `waitForStatusInterval(ms:number):Promise<void>` is a renderer-local cancellable delay cleaned up on row unmount/selection change; it performs **no browser action**, and the 12 × 500 ms cap only bounds UI status refresh, not the underlying native action. `showRichActionResult(view:HTMLElement,nodeId:string,result:RichActionResult):void` and `showRichActionPendingUnconfirmed(view:HTMLElement,nodeId:string):void` are private helpers that change status text/busy state only. A later exact rich revision or deliberate fresh status read may reconcile a still-pending display without resubmitting the original action. Use the transcript's semantic colors, focus style and reduced-motion rules; keep keyboard focus on a remounted card through stable semantic node ID when possible. Unsupported controls use a disabled description plus explicit Open Original, not a dummy working button.

- [ ] **Step 4: GREEN IPC, preload and UI tests.**

```bash
npm test -- --run test/rich-action-ipc.test.ts test/ipc.test.ts test/renderer-timeline.test.ts test/preload-images.test.ts test/rich-response-renderer.test.ts
npm run typecheck
```

Expected: synthetic events are inert; the verified real Electron gesture path begins only one action; read-only status polling neither opens nor executes; pending/unknown cannot spoof success or update another selected conversation. Open-original reads the stored originating conversation even for an old A, with manual-open only. Raw source or remote content cannot invoke fixed IPC.

- [ ] **Step 5: Review and commit the typed human interface.**

```bash
git diff --check
git add src/main/ipc.ts src/preload/index.ts src/renderer/rich-response.ts src/renderer/chat.ts src/renderer/styles/transcript.css test/rich-action-ipc.test.ts test/ipc.test.ts test/renderer-timeline.test.ts test/preload-images.test.ts
git diff --cached --stat
git commit -m "feat: expose safe rich control interactions in ChatBBC"
```

### Task 14: Add bounded local image viewing and explicit exact-image capture retry

**Files:**
- Create: `src/renderer/rich-image.ts`, `test/rich-image.test.ts`.
- Modify: `src/renderer/chat.ts`, `src/renderer/rich-response.ts`, `src/renderer/styles/transcript.css`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/rich-actions.ts`, `src/main/bridge.ts`, `extension/background.js`, `extension/content.js`, `src/main/session/store.ts` only for explicit tombstone override.
- Test: `test/image-storage-ui.test.ts`, `test/preload-images.test.ts`, `test/rich-media.test.ts`, `test/rich-actions.test.ts`, `test/rich-image.test.ts`.

**Interfaces:**
- Consumes: `getSessionImage(id,assetId)` and stored `RichMediaState` (Task 9), tombstones (Task 10), authenticated open/elect custody (Tasks 11–12).
- Produces: `openRichImageViewer(sessionId:string, media:RichMediaState, alt:string):Promise<void>` in `rich-image.ts`; fixed `sessions:richRetryImage` and preload `retryRichImage(sessionId:string,messageId:string,mediaId:string,revision:number,confirmRemoved:boolean):Promise<Reply<RichActionResult>>`. Main derives the exact originating conversation/node from the stored event, never from a passed URL. `requestRichImageRetry` in `rich-actions.ts` stores a bounded `retry_capture` intent under **the same** action ledger, with one optional opening and one **read-only** re-observation grant, but never a native control click or provider regeneration.

- [ ] **Step 1: Write RED viewer, retry and deleted-image tests.** Verify a local data-URL image opens in a dialog labelled “Saved preview” with alt text, a close button, Escape/backdrop handling and focus return; its displayed pixel dimensions never claim original-resolution bytes. Missing/quota/tainted/oversized shows its actual reason and does not load a remote URL. An explicit Retry on one exact media ID authorizes at most one re-observation and one opening, never a new ChatGPT generation or a prompt send. A `removed` item requires the user's explicit `confirmRemoved` choice; automatic history load/re-observe has no such authority.

```ts
expect(viewer.getAttribute('role')).toBe('dialog');
expect(viewer.textContent).toContain('Saved preview');
expect(remoteImageRequests).toHaveLength(0);
expect(retryOffers).toHaveLength(1);
expect(nativeGenerationClicks).toBe(0);
expect(await retryAfterAmbiguousOpen()).toMatchObject({ state: 'unknown' });
expect(await retryRemovedWithoutConfirmation()).toMatchObject({ state: 'unavailable' });
```

- [ ] **Step 2: Run RED viewer/recovery suites.**

```bash
npm test -- --run test/rich-image.test.ts test/image-storage-ui.test.ts test/preload-images.test.ts test/rich-media.test.ts
```

Expected: new fixed viewer/retry is absent, while current standalone generated-image zoom/gallery and cleanup remain functional.

- [ ] **Step 3: Implement local-only viewing and one-shot recapture.** The viewer obtains bytes only through `getSessionImage(sessionId,asset.id)`; show `previewWidth × previewHeight` accurately, trap/release focus, close on Escape, and revoke any temporary object URL on close/selection change. `ipc.ts` validates exact bounded IDs, revision and confirmation; main rereads current canonical rich node, current binding, Recording On and nonblocked chat, and issues one ledger-owned retry descriptor. The companion reuses its Task 12 safe background tab-opening custody but invokes only a `clf-rich-recapture` request for the exact node and original document, never `clf-rich-invoke` or the original Generate/Continue button. `content.js` re-verifies current image ownership and loaded pixels; any ambiguous/tainted source is unavailable. Unknown/lost request becomes unconfirmed and cannot automatically retry.

```ts
export type RichRetryIntent = { sessionId: string; messageId: string;
  revision: number; mediaId: string; confirmRemoved: boolean };
export async function requestRichImageRetry(intent: RichRetryIntent): Promise<RichActionResult>;
export type RichRetryRecord = Omit<RichActionRecord, 'kind' | 'nodeId' | 'value'> & {
  kind: 'retry_capture'; mediaId: string; confirmRemoved: boolean;
};
// The Task 11 version-1 ledger's actions collection becomes
// Array<RichActionRecord | RichRetryRecord>; this separately discriminated
// retry grants read-only capture, never permission to invoke a provider control.
```

For `removed` media, attach a one-use, persisted retry authorization to the exact `(session,message,mediaId,asset cleanup generation)` in the existing ledger. Extend Task 9's `upsertRichMedia` with a sixth, optional `recaptureGrantId?: string`, leaving `expectedRichRevision` fifth. The store accepts it only after the main-owned grant is redeemed and the same cleanup generation is still valid; it may replace that **one media node's** removed marker after successful new bytes commit, without reactivating other nodes or the generated image's tombstone. If the new bytes are identical/content-address to an old deleted file, `writeAsset` still enforces quota and the grant's exact epoch. A result that arrives after a second cleanup cannot republish the asset. The previously removed marker stays until successful recapture.

- [ ] **Step 4: GREEN viewer, privacy and recovery races.**

```bash
npm test -- --run test/rich-image.test.ts test/image-storage-ui.test.ts test/preload-images.test.ts test/rich-media.test.ts test/rich-actions.test.ts test/extension.test.ts
npm run typecheck
```

Expected: historical available preview enlarges from local bytes without external fetch, closed tab needs a single explicit reopening, deleted media stays deleted without confirmed Retry, and loss/late ACK/changed conversation never regenerates or cross-attaches pixels.

- [ ] **Step 5: Review and commit image recovery.**

```bash
git diff --check
git add src/renderer/rich-image.ts src/renderer/chat.ts src/renderer/rich-response.ts src/renderer/styles/transcript.css src/main/ipc.ts src/preload/index.ts src/main/rich-actions.ts src/main/bridge.ts extension/background.js extension/content.js src/main/session/store.ts test/rich-image.test.ts test/image-storage-ui.test.ts test/preload-images.test.ts test/rich-media.test.ts test/rich-actions.test.ts test/extension.test.ts
git diff --cached --stat
git commit -m "feat: view local rich previews and explicitly recapture exact media"
```

### Task 15: Harden Recording Off, history, compaction and crash recovery end to end

**Files:**
- Modify: `src/main/session/recorder.ts`, `src/main/session/store.ts`, `src/main/rich-actions.ts`, `src/main/bridge.ts`, `extension/background.js`, `src/renderer/chat.ts`, `src/renderer/rich-response.ts` only where the new integration tests expose a broken owner.
- Test: **Create** `test/rich-response-lifecycle.test.ts`; extend `test/session-retention.test.ts`, `test/bridge.test.ts`, `test/renderer-timeline.test.ts`, `test/rich-actions.test.ts`.

**Interfaces:**
- Consumes: complete Task 5/9 canonical event, shared cleanup, Task 11/14 single action ledger, existing history pagination `readRecentEvents` and `conversationAttachment`, renderer `selectionGeneration`.
- Produces: historical rich rows surviving restart and paging, with no live control authority on superseded A; lifecycle recovery reports `unknown` or re-observed results, never a repeated native grant. Recording Off rejects rich/media/action durable writes, does not create a transient duplicate cache and retains the existing recording-disabled presentation/manual-original path.

- [ ] **Step 1: Write fail-first integrated lifecycle matrix.** Populate a realistic A session containing text + rich cards + generated shared asset + standalone image; rebind to B, navigate back to A, close/reopen original tab and restart the app/extension. Assert A's origin, layout/alt/local preview and immutable revisions remain readable across pagination but old A has no actionable handle; B remains current. Inject crashes at each action phase (intent, opening, election, before/after durable arm, dispatch, result, receipt) and intentionally deliver stale ACKs after A→B→A. Repeat with `sessions.record=false` from the very beginning; no new rich/media/action record may be written.

```ts
expect(historicalA.richOrigin?.conversationId).toBe(conversationA);
expect(historicalA.richMedia?.[0]?.asset?.id).toBe(savedAssetId);
expect(await attemptActionOnSupersededA()).toMatchObject({ state: 'unavailable' });
expect(clickCountAfterRestart).toBe(clickCountBeforeRestart); // no auto repeat
expect(recordingOffRichRows).toHaveLength(0);
expect(recordingOffActionRecords).toHaveLength(0);
```

- [ ] **Step 2: Run RED integrated tests.**

```bash
npm test -- --run test/rich-response-lifecycle.test.ts test/session-retention.test.ts test/bridge.test.ts test/renderer-timeline.test.ts test/rich-actions.test.ts
```

Expected: at least one newly introduced negative proves the current integration lacks the required fencing/recovery; do not introduce an artificial failing assertion if all requirements already pass.

- [ ] **Step 3: Fix only failing lifecycle boundaries.** At every recorder/bridge entry use `recordingEnabled()` *before* serializing rich/media or allocating action state; recheck it under the durable write queue to close in-flight Off transitions. A tab/document re-registration invalidates all live handles; durable display metadata survives, but only a new explicit click may initiate fresh verification. Restore `may_have_dispatched` as unknown/read-only reconciliation; never poll for replay. Maintain exact originating `richOrigin` under `rebindSession`, let historical manual-open use it without transferring command authority, and fence renderer async preview/action callbacks against selection generation and event revision. Preserve the old HTML/Markdown/text path when the new optional fields are absent.

```ts
// Same policy at both admission and eventual commit, using existing config authority.
if (!recordingEnabled()) return 'refused';
if (await conversationAttachment(origin.conversationId, sessionId) !== 'current')
  return 'refused'; // no newly actionable publication from superseded frontend
if (origin.bindingRevision !== currentSummary.bindingRevision) return 'refused';
```

That guard applies to **new live publication**, not to reading stored historical A; no migration may rewrite historical `richOrigin` to B. Do not schedule reopen from history hydration, tab close, app startup or timer.

- [ ] **Step 4: Prove GREEN full lifecycle and privacy checks.**

```bash
npm test -- --run test/rich-response-lifecycle.test.ts test/session-retention.test.ts test/bridge.test.ts test/renderer-timeline.test.ts test/rich-actions.test.ts test/image-storage.test.ts
npm run verify:privacy
npm run typecheck
```

Expected: every crash boundary produces zero duplicate clicks, no historical frontend action, no silent media resurrection, no Recording Off persistence, no leaked URLs or secret-bearing diagnostics; unchanged legacy transcript and browser-control behavior stays passing.

- [ ] **Step 5: Review and commit the specific fixes and regression.**

```bash
git diff --check
git add src/main/session/recorder.ts src/main/session/store.ts src/main/rich-actions.ts src/main/bridge.ts extension/background.js src/renderer/chat.ts src/renderer/rich-response.ts test/rich-response-lifecycle.test.ts test/session-retention.test.ts test/bridge.test.ts test/renderer-timeline.test.ts test/rich-actions.test.ts
git diff --cached --stat
git commit -m "test: fence rich response recording and action lifecycle"
```

Stage only changed owners. If the initial matrix is already green, keep its independently valuable regression and omit source edits from this commit.

### Task 16: Integrated Linux, Omarchy, installed-app and live acceptance

**Files:**
- Modify: `AGENTS.md` only in its relevant browser/session/recording section, `docs/superpowers/evidence/2026-09-18-rich-responses-live.md` (Task 1 evidence, append new observed outcomes), `src/main/version.ts`, `extension/background.js`, `extension/manifest.json`, `package.json`, `package-lock.json` **only if explicitly authorized to prepare a release**.
- Test: `test/extension.test.ts`, `test/renderer-timeline.test.ts`, `test/image-storage.test.ts`, `test/rich-response-lifecycle.test.ts`, `test/rich-action-extension.test.ts`, `test/rich-image.test.ts` plus the repository's full verification scripts.

**Interfaces:**
- Consumes: all Tasks 1–15 and the approved spec §§1–10; Task 8 coordinated protocol and Task 12 live native-operation proof.
- Produces: a redacted reproducible acceptance matrix separating **source tests**, **build**, **packaged candidate**, **actually installed application/companion**, and **actual signed-in ChatGPT**. A locally checked version declaration is not evidence of the running binary or extension. This task does not deploy, install, package or publish without separate authorization under `AGENTS.md`.

- [ ] **Step 1: Add a fail-first integration acceptance test and an accurate user guide.** Extend `test/rich-response-lifecycle.test.ts` with two screenshot-equivalent fixtures: image-backed choice/Continue and wide diagram/table. Add single, gallery and image-only generated-image cases, available/pending/unsupported inline images and unknown component code negative. Document only shipped behavior and limitation: local images are saved previews, not necessarily originals; unsupported controls/open-original and uncertain results remain honest.

```ts
expect(renderedChoice.querySelectorAll('.rich-card')).toHaveLength(2);
expect(renderedChoice.querySelectorAll('img')).toHaveLength(2);
expect(renderedDiagram.querySelector('.rich-diagram')).not.toBeNull();
expect((await readEvents(sessionId)).filter(row => row.kind === 'native_image'
  && row.messageId === galleryProviderMessageId)).toHaveLength(2);
expect((await readEvents(sessionId)).some(row => row.kind === 'native_image'
  && row.messageId === imageOnlyProviderMessageId && row.previewStatus === 'available')).toBe(true);
expect(unsupportedControl.getAttribute('aria-disabled')).toBe('true');
```

The `sessionId`, provider-message IDs and DOM elements in this assertion are constructed by the new `test/rich-response-lifecycle.test.ts` fixture using the existing temp store and jsdom transcript harness; its image-only case must also assert the final native-image row is visibly painted, not merely present in storage.

- [ ] **Step 2: Run the new integration test RED and record any unmet acceptance case.**

```bash
npm test -- --run test/rich-response-lifecycle.test.ts test/rich-action-extension.test.ts test/rich-image.test.ts
```

Expected: a genuinely missing acceptance path is RED; if all already work, retain the regression and record GREEN without manufacturing a failure. Repair only the originating owner in its previous task before proceeding; do not hide a missing native capability behind a mock.

- [ ] **Step 3: Verify source/release consistency and document behavior.** Update `AGENTS.md` with the exact protocol-16 rich observations/one-shot action invariants, image ownership, Recording Off and native feasibility gate, preserving existing project guidance. Read the four version declarations and `test/extension.test.ts`; keep existing release `2.1.17` declarations unchanged unless the user separately authorizes release preparation. If a release is authorized, use the release procedure to choose its next actual version and update `package.json`, lockfile, app version and extension manifest atomically, checking package/manifest/protocol assertions; never silently ship a source-only extension with an incompatible installed app.

```bash
rg -n 'APP_VERSION|BRIDGE_PROTOCOL|"version"' src/main/version.ts extension/background.js extension/manifest.json package.json package-lock.json
npm test -- --run test/extension.test.ts
git diff --check
```

Expected: same declared release version throughout, protocol 16 on both paired sides (or same next number if baseline changed), no accidental broad permissions and no broken compatibility test.

- [ ] **Step 4: Run source verification, then only authorized package/install validation.**

```bash
npm run typecheck
npm test -- --run test/fiber.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts test/rich-response-schema.test.ts test/rich-response-store.test.ts test/rich-media.test.ts test/rich-actions.test.ts test/rich-action-extension.test.ts test/rich-action-ipc.test.ts test/rich-image.test.ts test/rich-response-lifecycle.test.ts test/image-storage.test.ts test/image-storage-ui.test.ts test/session-retention.test.ts test/renderer-timeline.test.ts
npm run verify:privacy
npm run verify:notices
npm run verify
npm run build
```

Expected: all focused tests, full verification and build pass, separately recorded. **When authorized** to package, use the project's Linux build (`npm run dist:linux:x64`), inspect artifact version/hash, install in the supported test environment and confirm app/extension versions/protocol from running diagnostics before live reproduction. A build or package alone cannot satisfy live acceptance.

- [ ] **Step 5: Run exact live acceptance matrix and document evidence.** Repeat the user's two original examples in a signed-in ChatGPT tab and the matching installed Linux ChatBBC/companion: image-backed cards and Continue, wide diagram, ordinary single image, multiple images and an image-only final. Exercise progressive hydration, closed-tab one-time reopening, native selection reset (must require reselection), A→B→A history/read-only A, restart, image viewer/retry/removal/cleanup, Recording Off, wrong-account/blocked chat, long-scroll and responsive panel/zoom, keyboard/focus/RTL/reduced motion and Light/Dark/Omarchy appearance. Record timestamp, environment/version/protocol, screenshots with secrets redacted, each observed outcome and each unsupported case in the existing Task 1 evidence file. Observe native selection and resulting turn, not just extension ACK or a synthetic click.

```text
Evidence row: scenario | source test | build | package | installed app+extension | native page observed | result/blocker
Pass requires: both example answers + single/gallery/image-only generated images visibly correct,
                one exact B choice + one original Continue observed, no duplicated submission,
                durable history and media across restart, Recording Off retains nothing new.
Any unverified installed/native cell remains NOT VERIFIED, never PASS.
```

If native targeting or canvas/screenshot capture cannot be proven, name the specific unavailable control/media family, leave its unsafe path disabled and revise the design rather than claiming completion. Windows/macOS are legacy compile/regression targets, not live release gates.

- [ ] **Step 6: Review the finished work and commit only if authorized.**

```bash
git status --short
git diff --check
git diff --stat
git add AGENTS.md docs/superpowers/evidence/2026-09-18-rich-responses-live.md test/rich-response-lifecycle.test.ts
git diff --cached --stat
git commit -m "docs: record rich response and native image acceptance evidence"
```

Stage only truly modified files and review the index first. Any release-version changes require a **separate**, explicitly authorized release-preparation commit; do not commit/package/install/publish just because this documentation plan exists.

---

## Dependency and reviewer gates

Tasks 1–3 deliver independently useful ordinary generated-image reliability; no rich or action code is a precondition for displaying a normal generated image. Tasks 4–7 deliver safe persistent rich text/layout with inert controls. Task 8 coordinates new wire compatibility; Tasks 9–10 add same-owner embedded assets and correct deletion before action/UI rollout. Task 11's durable-cut proof and Task 1's **real** safe background input proof both gate Task 12. Task 13 enables the exact supported control set; Task 14 adds only explicit media capture recovery; Task 15 verifies all history/crash/privacy intersections. Task 16 alone evaluates the complete live feature. Each task receives its own test cycle and reviewer approval before dependent tasks begin; avoid parallel edits to `bridge.ts`, `content.js`, `store.ts` or the shared action ledger. At most two direct workers run at once and none delegates further.

## Specification coverage ledger

| Design requirement | Execution task(s) | Acceptance evidence |
| --- | --- | --- |
| §§1–3: supplied examples, ordinary images, exact observed missing boundary, alternatives | 1–3, 6–7, 16 | Live signed-in failure trace then repeated installed-app cases; no webview or text-answer substitution. |
| §4: canonical logical/provider separation, exact origin, size/privacy bounds, no derived activity | 4–6, 8–11, 15 | Schema/bridge/store tests, stale A→B→A, Recording Off, no source execution. |
| §5: non-Markdown capture, hydration, code distinction, safe responsive/Omarchy rendering | 1, 6–7, 15–16 | Exact-root DOM and source-code negatives, layout/keyboard/zoom and installed visual comparison. |
| §6.1: public typed standalone single/gallery/image-only, pending and errors | 1–3, 16 | Real provider family fixture, capture pipeline tests and updated installed app. |
| §6.2: exact embedded and shared images, no unsafe URL/fetch/crop | 6, 9–10, 16 | Inline asset and dedupe tests; verified screenshot path only if live feasible. |
| §6.3: local viewer, one explicit retry, quota, tombstone/retention | 9–10, 14–16 | Shared-ref cleanup/restart races and viewer/retry interaction tests. |
| §7.1: exact semantic controls; unsupported kinds inert | 1, 4, 6–7, 12–13 | Unique role/group, disabled/changed cases, native selected state and keyboard tests. |
| §§7.2–7.3: durable before click, exact ownership/opening, unknown/no replay and supersession | 1, 5, 11–15 | Crash matrix, duplicate/late ACK, reset choice and old-A rejection in native app. |
| §8: coordinated owners, named IPC and bridge protocol | 4–15 | Typecheck, protocol-mismatch, preload/IPC allowlist and owner tests. |
| §§9–10: six acceptance increments and truthful completion | 1–16 | Task 16's separately labelled source/build/package/installed/native matrix. |

**Stop conditions:** A task with an unproven provider shape, missing exact message/root join or unproved safe native control cannot invent selectors, keys, synthetic accepted state or broader browser authority to pass a test. Preserve its documented unsupported state, report the narrow blocker and revise the reviewed design before extending the supported subset. No mocked-only result can be reported as native or installed-app acceptance.
