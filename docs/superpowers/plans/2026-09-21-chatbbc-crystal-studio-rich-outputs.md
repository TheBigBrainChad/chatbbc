# ChatBBC Crystal Studio Rich Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider choices, rendered artifacts, image sets, human downloads, and permission-checked agent asset retrieval first-class Crystal Studio outputs without weakening exact identity, browser custody, filesystem policy, or truthful receipts.

**Architecture:** Extend existing bounded rich observations and the dormant `rich-actions.ts` ledger; add purpose-specific extension transports for native actions and downloads; project safe artifacts and response-owned image sets through canonical session history; expose one Core `generated_assets` tool whose handles are exact-session capabilities and whose writes use the existing sandbox and atomic filesystem path.

**Tech Stack:** TypeScript, Chromium MV3 JavaScript, Electron fixed IPC, Zod/bounded parsers, Sharp, SHA-256, Vitest/jsdom, real signed-in ChatGPT acceptance.

**Spec:** `docs/superpowers/specs/2026-09-21-chatbbc-crystal-studio-redesign-design.md`

## Global Constraints

- Requires Foundation and Workspace plans plus Gates 1–2.
- Signed-in native mutation is blocked until Task 1 proves current provider structure and postconditions on the real page.
- Preserve canonical message/image identities and the physical rich-action ledger; never infer identity from label, text, position, timing, or the selected app row.
- A trusted app click starts one operation. Opening, election, dispatch, browser acknowledgement, and observed postcondition are separate states.
- Potentially dispatched input is never replayed automatically.
- Static artifacts are scriptless, networkless, form-less, navigationless, sandboxed, and independently sanitized in extension and renderer.
- Provider signed URLs and cookies remain inside the extension document/background boundary and are never stored or sent to main.
- Local saved previews are not original provider assets.
- Human download and agent project save are separate workflows, custody ledgers, permissions, destinations, and receipts.
- Core tool writes recheck live capability, exact caller/session, approved destination, source identity, and concurrent destination revision.
- Respect all `STATIC_ARTIFACT_LIMITS` and `GENERATED_ASSET_LIMITS` from the spec.

## Review Focus

1. Two choices with the same label in different groups must never share an action descriptor — Task 1.
2. Lost native-action acknowledgement after possible dispatch must remain unknown and never dispatch twice — Task 2.
3. Static HTML containing script, event handlers, forms, remote URLs, CSS imports, or navigation must remain inert after both sanitizer layers — Task 3.
4. A download whose MV3 worker suspends after `chrome.downloads.download` must rejoin the same receipt or become unconfirmed, never start another download — Task 6.
5. A generated asset save must fail on changed destination, wrong session handle, unavailable original, oversize transfer, digest mismatch, or root revocation without publishing partial bytes — Task 7.

---

### Task 1: Prove and capture exact native choice identity

**Files:**
- Modify: `extension/chatgpt-dom.js`
- Modify: `extension/fiber.js`
- Modify: `extension/content.js`
- Modify: `src/shared/rich-response.ts`
- Test: `test/rich-response-schema.test.ts`
- Test: `test/rich-response-lifecycle.test.ts`
- Test: `test/content-script.test.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- Extends choice-like nodes with exact bounded `groupId`, `value`, `selected`, and `disabled` fields.
- Produces a physical descriptor joining logical message, raw provider message, document/navigation epoch, native group, control kind, and candidate value.
- Does not expose an executable selector.

- [ ] **Step 1: Inspect the real signed-in page before editing**

On a dedicated signed-in ChatGPT tab, generate current examples of radio, checkbox, select, and
Continue controls. Record only generalized structure: native element role/type, stable provider
message/group/value properties, selected/disabled postcondition, and replacement behavior after a
click. Do not commit authored prompts, account ids, signed URLs, cookies, screenshots, or raw payloads.

If exact group/value/postcondition cannot be proved for a control family, mark that family unsupported
and keep it inert. Do not infer selectors from existing fixtures.

- [ ] **Step 2: Write fail-first duplicate-label and stale-epoch tests**

```ts
it('keeps identical labels distinct by physical group and value', () => {
  const tree = parseRichResponse(observedChoiceFixture);
  const choices = collectChoices(tree);
  expect(choices.map(({ groupId, value }) => `${groupId}:${value}`)).toEqual(['g-a:yes', 'g-b:yes']);
});

it('rejects a descriptor whose native group disappeared after the observation', () => {
  expect(resolveRichControl(staleObservation, currentDom)).toEqual({ kind: 'changed' });
});
```

Cover duplicate labels, reordered options, disabled controls, current selection, replaced message,
route change, navigation epoch change, and unsupported families.

- [ ] **Step 3: Run and observe RED**

Run: `npm test -- --run test/rich-response-schema.test.ts test/rich-response-lifecycle.test.ts test/content-script.test.ts test/extension.test.ts`

Expected: FAIL because physical `groupId`/`value` remain null or unproved.

- [ ] **Step 4: Implement bounded capture from observed provider structure**

Update `chatgpt-dom.js` as the sole DOM-shape authority. `fiber.js` may contribute bounded exact
provider identity but never a selector or permission. `content.js` freezes document/navigation epoch
and exact message identity before and after capture. Reject ambiguous groups and values longer than
the existing 512-character bound.

- [ ] **Step 5: Verify source tests and repeat live observation**

Run:

```bash
npm test -- --run test/rich-response-schema.test.ts test/rich-response-lifecycle.test.ts test/content-script.test.ts test/extension.test.ts
npm run typecheck
```

Reload the changed unpacked extension, reproduce each supported control family, and verify captured
identity and observed selected state. This task does not click from ChatBBC yet.

- [ ] **Step 6: Commit**

```bash
git add extension/chatgpt-dom.js extension/fiber.js extension/content.js src/shared/rich-response.ts test/rich-response-schema.test.ts test/rich-response-lifecycle.test.ts test/content-script.test.ts test/extension.test.ts
git commit -m "feat: capture exact rich choice identity"
```

---

### Task 2: Activate one-shot rich choice actions through existing custody

**Files:**
- Modify: `src/main/rich-actions.ts`
- Modify: `src/main/bridge.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/main/ui-selection.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/rich-response.ts`
- Modify: `extension/background.js`
- Modify: `extension/content.js`
- Modify: `extension/chatgpt-dom.js`
- Test: `test/rich-actions.test.ts`
- Test: `test/rich-response-renderer.test.ts`
- Test: `test/content-script.test.ts`
- Test: `test/extension.test.ts`
- Test: `test/bridge.test.ts`

**Interfaces:**
- Implements current dormant `beginRichAction`, `electRichAction`, `armRichAction`, and `finishRichAction`.
- Adds fixed IPC `sessions:richActionBegin` only; status remains read-only.
- Adds authenticated bridge contracts `richActionOffers`, `/rich-action/claim`, and `/rich-action/result` without adding a fifth durable browser-command kind.

- [ ] **Step 1: Write fail-first transition and race tests**

```ts
it('spends dispatch before browser input and never retries an unknown result', async () => {
  const begun = await beginRichAction(intent);
  await electRichAction(begun.id!, 7, 'doc-a', 3);
  expect(await armRichAction(begun.id!, 'doc-a', 3)).toBe(true);
  await simulateTransportLossAfterInput();
  expect((await readRichActionStatus(intent.sessionId, begun.id!)).state).toBe('unknown');
  expect(await claimAgain(begun.id!)).toBe('refused');
});
```

Also cover selection-generation replacement, stale shard revision, block/delete/rebind, foreign tab,
document/navigation change, disabled control, changed group selection, lost ACK, duplicate result,
restart before dispatch, and restart after dispatch-spent.

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm test -- --run test/rich-actions.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts`

Expected: FAIL because production admission/election/arm/finish return unavailable.

- [ ] **Step 3: Implement trusted app admission and main-owned transition**

`richActionBegin` accepts only session/logical-message/node ids. Main validates the current
main-frame selection witness, rereads the physical canonical assistant shard, derives the exact
stored descriptor, checks current binding/block/policy, and calls `beginRichAction(intent)`.

```ts
beginRichAction(input: {
  sessionId: string; logicalMessageId: string; nodeId: string;
  selectionGeneration: number;
}): Promise<RichActionResult>
```

The renderer never supplies conversation id, provider id, group id, value, document id, or selector.

- [ ] **Step 4: Implement purpose-specific browser handout and postcondition**

Main publishes exact offers. Background scans/elects the existing original conversation tab, claims
once, asks content to re-resolve the exact physical descriptor, persists dispatch-spent, then content
uses one trusted native click/input primitive. Content immediately reobserves the same group and
reports only `observed`, `changed`, `unavailable`, or `unknown`. No text-prompt substitute exists.

- [ ] **Step 5: Wire renderer controls and truthful states**

Buttons remain disabled until exact eligibility. Direct trusted clicks call the fixed IPC once.
Paint Pending, Confirmed, Changed, Unavailable, or Unconfirmed from ledger status. Do not optimistically
change recorded historical selected state.

- [ ] **Step 6: Verify source and live native postconditions**

Run:

```bash
npm test -- --run test/rich-actions.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts
npm run typecheck
```

In the reloaded signed-in extension, trigger each supported control from ChatBBC, observe the native
control change and canonical rich revision, then test navigation-before-click and close-after-click.
Any family lacking exact native postcondition remains inert.

- [ ] **Step 7: Commit**

```bash
git add src/main/rich-actions.ts src/main/bridge.ts src/main/ipc.ts src/main/ui-selection.ts src/preload/index.ts src/renderer/rich-response.ts extension/background.js extension/content.js extension/chatgpt-dom.js test/rich-actions.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts test/extension.test.ts test/bridge.test.ts
git commit -m "feat: enable exact rich choice actions"
```

---

### Task 3: Add bounded semantic and static rendered artifacts

**Files:**
- Create: `src/shared/static-artifact.ts`
- Modify: `src/shared/rich-response.ts`
- Modify: `extension/chatgpt-dom.js`
- Modify: `extension/content.js`
- Create: `src/renderer/static-artifact.ts`
- Modify: `src/renderer/rich-response.ts`
- Modify: `src/renderer/styles/transcript.css`
- Test: `test/rich-response-schema.test.ts`
- Test: `test/rich-response-renderer.test.ts`
- Create: `test/static-artifact.test.ts`
- Test: `test/content-script.test.ts`

**Interfaces:**
- Produces `STATIC_ARTIFACT_LIMITS` exactly as specified.
- Extends rich nodes with `artifact` mode `semantic` or `static` and bounded `title`, `html`, and local-media references.
- Produces `sanitizeStaticArtifact(document, input): SanitizedArtifact` and `artifactSrcdoc(artifact)`.

- [ ] **Step 1: Write fail-first malicious and limit tests**

```ts
it.each([
  '<script>alert(1)</script>', '<img src=https://remote/x>', '<form action=/x><button>go</button></form>',
  '<div onclick=steal()>x</div>', '<style>@import url(https://remote/x)</style>', '<a href=https://remote>x</a>'
])('makes static artifact content inert: %s', html => {
  const safe = sanitizeStaticArtifact(document, { html, media: [] });
  expect(safe.html).not.toMatch(/script|onclick|https:|<form|@import|href=/i);
});
```

Test 131072 bytes, 1024 nodes, depth 24, 65536 text, 65536 CSS, four local images, two-second deadline,
SVG/external URL/CSS url rejection, malformed markup, duplicate media, and unknown nodes.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/static-artifact.test.ts test/rich-response-schema.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts`

- [ ] **Step 3: Implement shared limits and extension allowlist**

Extension capture walks the exact owned artifact root, permits static layout/text/table/code plus a
narrow CSS property allowlist, replaces exact owned images with local media ids, and emits no URLs,
forms, inputs, scripts, handlers, embeds, canvas, audio, or video. Unknown/oversized artifacts become
an explicit unavailable node.

- [ ] **Step 4: Independently sanitize and sandbox in renderer**

Renderer reparses, reconstructs allowed nodes/properties, and creates:

```html
<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="<!doctype html><meta http-equiv='Content-Security-Policy' content=&quot;default-src 'none'; img-src data:; style-src 'unsafe-inline'&quot;>…"></iframe>
```

No `allow-scripts`, `allow-forms`, `allow-popups`, `allow-same-origin`, links, or remote images. Semantic
artifacts continue through the existing typed rich renderer.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- --run test/static-artifact.test.ts test/rich-response-schema.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/static-artifact.ts src/shared/rich-response.ts extension/chatgpt-dom.js extension/content.js src/renderer/static-artifact.ts src/renderer/rich-response.ts src/renderer/styles/transcript.css test/static-artifact.test.ts test/rich-response-schema.test.ts test/rich-response-renderer.test.ts test/content-script.test.ts
git commit -m "feat: render bounded static artifacts safely"
```

---

### Task 4: Add focused artifact and decision presentation

**Files:**
- Create: `src/renderer/rich-focus-stage.ts`
- Modify: `src/renderer/rich-response.ts`
- Modify: `src/renderer/output-inspector.ts`
- Modify: `src/renderer/conversation-stage.ts`
- Modify: `src/renderer/work-panel.ts`
- Modify: `src/renderer/styles/transcript.css`
- Modify: `src/renderer/styles/panels.css`
- Test: `test/rich-response-renderer.test.ts`
- Test: `test/renderer-timeline.test.ts`
- Test: `test/renderer-work-panel.test.ts`

**Interfaces:**
- Produces `RichFocusTarget { sessionId; logicalMessageId; nodeId; revision; origin }`.
- Produces `openRichFocus(target)`, `closeRichFocus()`, and exact-origin focus return.

- [ ] **Step 1: Add fail-first focus ownership tests**

Test open/close, keyboard focus, stale revision, session switch, off-page origin, unavailable media,
workbench overlay interaction, and an action result arriving while focused.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/rich-response-renderer.test.ts test/renderer-timeline.test.ts test/renderer-work-panel.test.ts`

- [ ] **Step 3: Implement focus projection**

Large artifacts/decisions open in the conversation stage or inspector tenant without moving canonical
rows. Reread the exact loaded rich node before rendering; changed revisions close or visibly refresh.
Close returns to the original timeline origin if still resident, otherwise to the message group.

- [ ] **Step 4: Complete accessible interaction design**

Use ordinary buttons/fieldset/legend/labels, explicit pending/confirmed text, no color-only status,
Escape focus return, no nested vertical prose scrollers, and reduced-motion transitions.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run test/rich-response-renderer.test.ts test/renderer-timeline.test.ts test/renderer-work-panel.test.ts && npm run typecheck`

```bash
git add src/renderer/rich-focus-stage.ts src/renderer/rich-response.ts src/renderer/output-inspector.ts src/renderer/conversation-stage.ts src/renderer/work-panel.ts src/renderer/styles/transcript.css src/renderer/styles/panels.css test/rich-response-renderer.test.ts test/renderer-timeline.test.ts test/renderer-work-panel.test.ts
git commit -m "feat: add focused rich output presentation"
```

---

### Task 5: Make response-owned image sets and galleries canonical

**Files:**
- Modify: `src/shared/session.ts`
- Modify: `src/shared/chronology.ts`
- Modify: `src/main/session/store.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/image-set.ts`
- Modify: `src/renderer/rich-image.ts`
- Modify: `src/renderer/timeline-view.ts`
- Modify: `src/renderer/styles/transcript.css`
- Test: `test/image-recording.test.ts`
- Test: `test/image-storage.test.ts`
- Test: `test/rich-image.test.ts`
- Test: `test/renderer-timeline.test.ts`

**Interfaces:**
- Produces `ImageSetView { responseId; images; completeness; origin }` from canonical response ownership, not adjacency.
- Consumes existing `(providerMessageId, providerAssetId)` native-image identity and saved-preview reader.
- Produces exact current-session image metadata for later download/list operations.

- [ ] **Step 1: Write fail-first grouping tests**

```ts
it('groups images by canonical response across intervening metadata revisions', () => {
  const sets = imageSetsForTimeline([imageA, activityRevision, imageB]);
  expect(sets).toHaveLength(1);
  expect(sets[0].images.map(x => x.providerAssetId)).toEqual(['asset-a', 'asset-b']);
});

it('does not merge adjacent images from different responses', () => {
  expect(imageSetsForTimeline([imageA, foreignImage]).map(x => x.images.length)).toEqual([1, 1]);
});
```

Cover replay/revision, image-only final, removed preview, quota failure, cleanup tombstone, pagination,
and A → B → A hydration.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/image-recording.test.ts test/image-storage.test.ts test/rich-image.test.ts test/renderer-timeline.test.ts`

- [ ] **Step 3: Add response ownership projection**

Store keeps existing physical rows; shared chronology derives stable response ownership from exact
assistant/native message identity. IPC returns bounded metadata only. Remove renderer adjacency grouping
from `chat.ts`/timeline after all callers use `imageSetsForTimeline`.

- [ ] **Step 4: Implement gallery and viewer**

Render one set card with count, per-image saved-preview status, and actions. Viewer supports previous/
next, bounded zoom/pan, keyboard, metadata, open workbench, and retained geometry. It never fetches a
provider URL or calls download implicitly.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- --run test/image-recording.test.ts test/image-storage.test.ts test/rich-image.test.ts test/renderer-timeline.test.ts && npm run typecheck`

```bash
git add src/shared/session.ts src/shared/chronology.ts src/main/session/store.ts src/main/ipc.ts src/preload/index.ts src/renderer/image-set.ts src/renderer/rich-image.ts src/renderer/timeline-view.ts src/renderer/styles/transcript.css test/image-recording.test.ts test/image-storage.test.ts test/rich-image.test.ts test/renderer-timeline.test.ts
git commit -m "feat: add response-owned image galleries"
```

---

### Task 6: Add human original downloads with extension custody

**Files:**
- Create: `src/shared/generated-assets.ts`
- Create: `src/main/generated-asset-downloads.ts`
- Modify: `src/main/bridge.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/image-set.ts`
- Modify: `src/renderer/rich-image.ts`
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Modify: `extension/content.js`
- Modify: `extension/chatgpt-dom.js`
- Create: `test/generated-asset-downloads.test.ts`
- Test: `test/bridge.test.ts`
- Test: `test/extension.test.ts`
- Test: `test/content-script.test.ts`
- Test: `test/preload-images.test.ts`

**Interfaces:**
- Produces `GeneratedAssetDownloadState = requested | started | complete | failed | unconfirmed`.
- Adds fixed IPC `sessions:downloadGeneratedAssets({ sessionId, logicalMessageId, assetIds })`.
- Adds purpose-specific authenticated bridge offer/claim/result; signed URL stays extension-only.
- Adds MV3 `downloads` permission and batch max 20.

- [ ] **Step 1: Write fail-first custody and privacy tests**

```ts
it('does not expose or persist the signed provider URL', async () => {
  await completeDownloadWithExtensionUrl('https://signed.example/secret?token=x');
  expect(JSON.stringify(mainSnapshot())).not.toContain('signed.example');
  expect(JSON.stringify(bridgeBodies())).not.toContain('token=x');
});

it('does not restart after worker suspension following download admission', async () => {
  const first = await claimAndStart(download);
  suspendWorker(); restoreWorker();
  expect(await nextOffer(download.id)).toBeNull();
  expect(await restoredState(download.id)).toMatchObject({ state: 'started' });
});
```

Cover batch max, duplicate click, changed asset, missing original, navigation, foreign session, download
start error, completion error, cancelled download, unknown acknowledgement, and browser restart.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/generated-asset-downloads.test.ts test/bridge.test.ts test/extension.test.ts test/content-script.test.ts test/preload-images.test.ts`

- [ ] **Step 3: Implement main intent and fixed IPC**

Main rereads the selected physical image rows and creates one bounded batch record. It publishes only
opaque asset identity, requested filename, exact conversation/message/document requirements, and
receipt state. Main never receives a URL.

- [ ] **Step 4: Implement extension-only URL resolution and `chrome.downloads` custody**

Background claims once, asks the exact content document for the current owned asset URL, and calls
`chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })`. Persist
command id ↔ browser download id before acknowledging started. Rejoin `downloads.onChanged` after MV3
suspension. Never log/store/send the URL. Sequentially admit up to 20 assets.

- [ ] **Step 5: Wire truthful UI**

Viewer/set actions are “Download original” and “Download all”. Paint requested, started, complete,
failed, or unconfirmed. A complete browser receipt means downloaded to the browser's configured
Downloads location; it does not mean the app read the file.

- [ ] **Step 6: Verify source tests and a real browser download**

Run:

```bash
npm test -- --run test/generated-asset-downloads.test.ts test/bridge.test.ts test/extension.test.ts test/content-script.test.ts test/preload-images.test.ts
npm run typecheck
```

Reload the extension, download one and a set, verify native Downloads completion and exact UI receipt,
then test closing/navigating the source immediately after click. Do not commit downloaded content.

- [ ] **Step 7: Commit**

```bash
git add src/shared/generated-assets.ts src/main/generated-asset-downloads.ts src/main/bridge.ts src/main/ipc.ts src/preload/index.ts src/renderer/image-set.ts src/renderer/rich-image.ts extension/manifest.json extension/background.js extension/content.js extension/chatgpt-dom.js test/generated-asset-downloads.test.ts test/bridge.test.ts test/extension.test.ts test/content-script.test.ts test/preload-images.test.ts
git commit -m "feat: download generated originals through Chrome"
```

---

### Task 7: Add permission-checked Core generated asset retrieval

**Files:**
- Modify: `src/shared/generated-assets.ts`
- Create: `src/main/generated-assets.ts`
- Modify: `src/main/mcp/tool-declarations.ts`
- Modify: `src/main/mcp/tools-core.ts`
- Modify: `src/main/mcp/kernel.ts`
- Modify: `src/main/bridge.ts`
- Modify: `src/main/sandbox.ts`
- Modify: `src/main/fsops.ts`
- Modify: `extension/background.js`
- Modify: `extension/content.js`
- Modify: `extension/chatgpt-dom.js`
- Create: `test/generated-assets.test.ts`
- Test: `test/mcp-tool-declarations.test.ts`
- Test: `test/mcp.test.ts`
- Test: `test/sandbox.test.ts`
- Test: `test/bridge.test.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- Adds Core tool `generated_assets`:
  - `list {}` → at most 64 exact-session opaque handles and metadata.
  - `save { handle, path, source: 'original' | 'preview' }` → atomic approved-path result.
- Exposes `GENERATED_ASSET_LIMITS`: 64 MiB compressed, 40M decoded pixels, 512 KiB chunks, two concurrent transfers, 120 seconds, batch 20/512 MiB.
- Original transfer is chunked extension → authenticated bridge → main temp file with SHA-256; preview reads existing saved local asset.

- [ ] **Step 1: Write fail-first declaration, ownership, and write tests**

```ts
it('does not accept another session opaque handle', async () => {
  const { handle } = await listAs(sessionA).then(rows => rows[0]);
  expect(await saveAs(sessionB, { handle, path: '/approved/out.png', source: 'original' }))
    .toMatchObject({ outcome: 'tool_rejected' });
});

it('does not replace a destination changed after preflight', async () => {
  pauseAfterDestinationRevisionCheck();
  const save = saveAsset(request);
  await externalWrite(destination, newerBytes);
  resumeTransfer();
  await expect(save).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
  expect(await readFile(destination)).toEqual(newerBytes);
});
```

Cover missing exact attribution, capability/read-only revocation, traversal/symlink escape, missing
project, expired handle, original unavailable, preview requested but not saved, MIME mismatch, oversize
compressed/decoded/chunk/batch, timeout, digest mismatch, partial bridge loss, concurrent transfer cap,
and shutdown.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/generated-assets.test.ts test/mcp-tool-declarations.test.ts test/mcp.test.ts test/sandbox.test.ts test/bridge.test.ts test/extension.test.ts`

- [ ] **Step 3: Implement exact-session list and opaque handles**

`generated-assets.ts` lists only canonical native/rich image rows in the caller's durable local session.
Handles are process-scoped authenticated capabilities over session/message/provider-asset/revision and
never expose ids or URLs. List reports MIME, dimensions, suggested filename, preview availability, and
whether the current browser document can prove original availability.

- [ ] **Step 4: Implement preview save through current storage owners**

Resolve `path` through the exact project/workspace and existing sandbox. Read saved preview via the
session image owner. Stage beside destination, fsync, revalidate current root and destination revision,
then rename. Refuse source substitution.

- [ ] **Step 5: Implement original streaming without a permanent cache**

Main creates one transfer claim for the handle. Background/content resolve the exact currently owned
asset, stream maximum 512 KiB chunks, and report expected total/MIME/SHA-256 without exposing URL.
Main enforces all limits while writing a temporary file, fully decodes supported images with Sharp to
validate dimensions/pixels, rechecks destination/root/session after every await boundary, then publishes
atomically. Remove temporary bytes on every failure/shutdown.

- [ ] **Step 6: Verify source tests and a real project save**

Run:

```bash
npm test -- --run test/generated-assets.test.ts test/mcp-tool-declarations.test.ts test/mcp.test.ts test/sandbox.test.ts test/bridge.test.ts test/extension.test.ts
npm run typecheck
```

In a dedicated approved project, invoke list/save for original and preview, verify bytes/dimensions,
then revoke the root mid-transfer and modify the destination mid-transfer. Remove the throwaway output.

- [ ] **Step 7: Commit**

```bash
git add src/shared/generated-assets.ts src/main/generated-assets.ts src/main/mcp/tool-declarations.ts src/main/mcp/tools-core.ts src/main/mcp/kernel.ts src/main/bridge.ts src/main/sandbox.ts src/main/fsops.ts extension/background.js extension/content.js extension/chatgpt-dom.js test/generated-assets.test.ts test/mcp-tool-declarations.test.ts test/mcp.test.ts test/sandbox.test.ts test/bridge.test.ts test/extension.test.ts
git commit -m "feat: save generated assets through Core"
```

---

### Task 8: Complete rich-output lifecycle and integrated proof

**Files:**
- Modify: `src/main/session/store.ts`
- Modify: `src/main/shutdown.ts`
- Modify: `src/main/redaction.ts`
- Modify: `src/renderer/i18n.ts`
- Modify: `src/renderer/locales/es.json`
- Modify: `src/renderer/locales/zh-CN.json`
- Modify: `src/renderer/locales/zh-TW.json`
- Modify: `src/renderer/styles/transcript.css`
- Test: `test/rich-response-store.test.ts`
- Test: `test/rich-response-lifecycle.test.ts`
- Test: `test/image-storage.test.ts`
- Test: `test/generated-assets.test.ts`
- Create: `scripts/verify-crystal-rich-outputs.cjs`

**Interfaces:**
- Consumes Tasks 1–7.
- Produces bounded shutdown/cleanup/redaction and a complete source-level plus signed-in acceptance record.

- [ ] **Step 1: Add fail-first restart, cleanup, and redaction tests**

Test pending/dispatch-spent rich actions, pending downloads, active transfers, image cleanup tombstones,
session deletion, Recording Off, signed URL-shaped strings, bridge shutdown, and locale coverage.

- [ ] **Step 2: Run and observe RED**

Run: `npm test -- --run test/rich-response-store.test.ts test/rich-response-lifecycle.test.ts test/image-storage.test.ts test/generated-assets.test.ts`

- [ ] **Step 3: Implement lifecycle completion**

Shutdown stops new intent/transfer admission, drains accepted durable writes within the existing bound,
marks unresolved dispatched actions/downloads unconfirmed, removes temporary transfer files, and leaves
canonical history/previews under their existing cleanup owners. Redaction rejects credential-shaped
metadata without rewriting opaque image bytes.

- [ ] **Step 4: Add integrated Electron verification**

The script exercises saved-preview galleries, static artifact sandbox, focus stage, inert unsupported
controls, and source-level status projection. It must not pretend to prove signed-in provider mutation.

- [ ] **Step 5: Run source and signed-in acceptance**

```bash
npm test -- --run test/rich-response-store.test.ts test/rich-response-lifecycle.test.ts test/image-storage.test.ts test/generated-assets.test.ts
node scripts/verify-crystal-rich-outputs.cjs
npm run typecheck
```

Then perform one live supported choice, one static artifact, one single-image download, one multi-image
download, one agent original save, one preview save, and each required negative race. Record source,
tests, Electron, and signed-in evidence separately.

- [ ] **Step 6: Commit**

```bash
git add src/main/session/store.ts src/main/shutdown.ts src/main/redaction.ts src/renderer/i18n.ts src/renderer/locales src/renderer/styles/transcript.css test/rich-response-store.test.ts test/rich-response-lifecycle.test.ts test/image-storage.test.ts test/generated-assets.test.ts scripts/verify-crystal-rich-outputs.cjs
git commit -m "feat: complete Crystal rich output lifecycle"
```
