# Rich responses and native image feasibility — evidence

**Observation date:** 2026-09-18. **Task 1 status: BLOCKED for live acceptance.** This document separates observed local source behavior, a read-only browser-tab inventory, and tests that could not safely be performed. It records no account content, provider conversation identifier, media URL, browser screenshot or copied page markup.

## Baseline and access decision

- Isolated worktree baseline was clean at `1325745c10dafc6e890c9a5a479c004d38220fa2` before evidence edits. Source declarations agree on app/package/extension **2.1.17** and bridge protocol **15** (`package.json:3`, `src/main/version.ts:15,89`, `extension/manifest.json:4`, `extension/background.js:48`). These are source declarations, **not** measurements of an installed app, installed companion or their handshake.
- A read-only `browser_tabs` inventory filtered to the provider showed **two existing tabs, both `protected=true`, `owned=false`, `claimed=false`**. One was selected and the other was not; neither was a proven worker-owned, safe test conversation. No attachment, debugger takeover, DOM evaluation, screenshot, navigation, tab creation or input was attempted. The inventory alone does not establish the installed app/companion version, sign-in status, provider message identity or availability of the four scenario answers.
- The installed app version, companion version, actual protocol negotiation, Recording On/Off setting and local image-storage quota were **not inspected**. No available nonintrusive, verified diagnostic path established those facts. Existing source guards do not prove their current runtime states.

## Requested live scenario matrix

| Case | Original visible in safe inspected tab? | Exact provider identity and message/root association? | First actual failing pipeline transition | Installed app/companion |
| --- | --- | --- | --- | --- |
| Ordinary single generated image | Not verified; protected tabs were left untouched | Not verified | Unknown | Not verified |
| Gallery or image-only response | Not verified | Not verified | Unknown | Not verified |
| Image-backed choice cards and Continue | Not verified | Not verified; no unique native control or group state | Unknown | Not verified |
| Rich diagram or embedded reference image | Not verified | Not verified | Unknown | Not verified |

No new generation was requested and no screenshots or live DOM summaries were captured. The user's previously reported failures motivated this task but are not newly reproduced or independently diagnosed here.

## Existing source pipeline, with evidence levels

The following is a **source-only trace**, not an observed path for any one of the four cases. A local source branch must not be reported as the user's first failing transition.

| Transition | Source evidence and conditions | Task 1 live verdict |
| --- | --- | --- |
| Typed discovery | `extension/fiber.js:604-642` accepts public tool/assistant messages addressed to `all` with `multimodal_text` parts containing an `image_asset_pointer` and a sediment file ID; role/channel, provider UUID, asset ID and part order are bounded. Other unobserved public media families are not established as supported. | Whether the current provider output matches this shape is unknown. |
| Descriptor emission and DOM association | `extension/fiber.js:644-680,1367-1413` looks under the exact turn's generated-image presentation selector, matches a same-origin estuary content path plus asset ID, requires unique typed ownership and stamps matching nodes. `extension/content.js:3295-3325` requires current scan/turn stamps, connected node and same source ID. | Whether the user's native image reaches/stays joined at this transition is unknown. |
| Loaded pixels and encode | `extension/content.js:3354-3423` checks loaded dimensions, source/preview pixel budgets, route/epoch and source stability; it makes one WebP encode at quality 0.8 and reports an encoded preview over 384,000 bytes as unavailable. It cannot capture a tainted source through this method. The capture queue permits two active tasks (`:3425-3448`). | Oversize, missing node, not-loaded and tainted paths are **possible**, none observed in the reported case. |
| Metadata/bridge admission | `extension/content.js:4063-4104` emits metadata before capture and requires `finished_successfully` for pixel capture. `src/main/bridge.ts:958-973,1090-1156` admits `native_image` with a provider UUID/file ID and validates role, channel, status, preview size and geometry; incomplete provider status cannot admit pixels. | No actual observation, bridge receipt or refusal inspected. |
| Canonical event and asset | `src/main/session/recorder.ts:1739-1813` writes an exact native-image metadata row, validates and fully decodes WebP before storage, then publishes available asset or an unavailable reason. `:2020` gates new observations when recording is off; `src/main/session/store.ts:274-275` keys rows by provider message UUID and asset ID. | No actual canonical row, quota usage, stored bytes or Recording setting inspected. |
| Local image retrieval and paint | `src/main/ipc.ts:899-902` calls `recordedInputImage`, whose membership check includes canonical native images (`src/main/session/input-history.ts:55-73`). `src/renderer/chat.ts:1273-1313` reserves a preview frame, requests the asset and fences late paint by selection generation. | No installed renderer or screenshot observed; retrieval or paint failure remains possible and unproven. |

Independent source findings for the rich answer: `extension/fiber.js:740-905` captures `.markdown` HTML, with raw text and distinct canonical logical versus raw provider message identifiers; direct stamps are restricted to exact anchors, while text/ordinal HTML fallbacks are only presentation. `src/main/session/recorder.ts:1981-2000` persists assistant text/optional HTML and a separate native-image event. `src/renderer/chat.ts:842-850,965-1028,1267-1271` renders assistant text via Markdown and drops input, buttons, forms, SVG and other active elements from captured HTML. There is no observed exact association of the example's non-Markdown cards/diagram to a canonical message here. Source inspection explains why raw component text is plausible as a fallback but **does not prove** the reported example's exact missing boundary.

## Native-control feasibility and admission gate

The required safe test sequence was **not executed**: no proven test conversation; no observed raw provider message UUID, exact response root, unique choice/group/Continue semantic identities or pre-state. Therefore there was no authorized card-selection input, no selected-state observation, no Continue invocation and no resulting native transition to verify. The companion's ability to accept background input for these controls is **unknown**. No synthetic event, text-prompt substitute, selector guessed from a screenshot or borrowed browser-control attachment is accepted as evidence.

Before enabling an action adapter, obtain an unprotected, explicitly safe test conversation under its legitimate browser owner. Inspect its exact provider-message-to-root join and unique accessible controls, demonstrate one supported native selection with observed group state, then one Continue with native postcondition/new turn. Verify background behavior without focus theft or an executor debugger lease. If any identity/state/postcondition is missing, leave the corresponding control inert with an original-page fallback; do not infer that input succeeded or retry an ambiguous Continue. The approved design's durable one-shot action cut remains a separate prerequisite.

## Fixture handoff and gates

Only the existing source contract can currently inform generic fixtures: public output role/channel, typed asset-pointer family, distinct logical and provider message IDs, exact image tuple, and an assistant-message source/HTML fallback. **No new provider-shaped fixture or native control selector is derived from this attempt.** No fixture was created, because no safe live payload or DOM shape was observed. User prompts, private account fields, cookies, signed links, image bytes and full HTML were neither accessed nor saved.

Tasks 2/3 must establish the *actual* earliest image-loss transition before changing discovery or encode/bridge/storage/paint behavior. Task 6 has no demonstrated native message-to-rich-root association. Tasks 11/12 may reason about inert, bounded ownership contracts but must not arm a real action or claim native selection/Continue support until this live gate is satisfied. Task 16 must separately verify matching **installed** versions and repeat all cases against the updated installed app and provider page. No tests, build, package or installed-runtime checks were run for this documentation-only blocked probe.
