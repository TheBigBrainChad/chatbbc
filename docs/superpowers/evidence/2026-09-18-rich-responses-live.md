# Rich responses and native image feasibility — evidence

**Observation dates:** 2026-09-18 initial probe; 2026-09-19 authorized fixture follow-up. **Task 1 status: PARTIAL LIVE EVIDENCE; BLOCKED for full acceptance.** The initial probe was source-only because both then-available tabs were protected. A later, explicitly released, dedicated test conversation permitted read-only DOM/Fiber inspection of one image-backed choice answer. No account content, real provider conversation/message identifier, media URL, browser screenshot or copied page markup is retained here.

## Baseline and access decision

- Isolated worktree baseline was clean at `1325745c10dafc6e890c9a5a479c004d38220fa2` before evidence edits. Source declarations agree on app/package/extension **2.1.17** and bridge protocol **15** (`package.json:3`, `src/main/version.ts:15,89`, `extension/manifest.json:4`, `extension/background.js:48`). These are source declarations, **not** measurements of an installed app, installed companion or their handshake.
- A read-only `browser_tabs` inventory filtered to the provider showed **two existing tabs, both `protected=true`, `owned=false`, `claimed=false`**. One was selected and the other was not; neither was a proven worker-owned, safe test conversation. No attachment, debugger takeover, DOM evaluation, screenshot, navigation, tab creation or input was attempted. The inventory alone does not establish the installed app/companion version, sign-in status, provider message identity or availability of the four scenario answers.
- The installed app version, companion version, actual protocol negotiation, Recording On/Off setting and local image-storage quota were **not inspected**. No available nonintrusive, verified diagnostic path established those facts. Existing source guards do not prove their current runtime states. At the **earlier Task 1 source snapshot**, declarations were **2.1.17 / protocol 16**; the later Task 15 source increment changes the paired protocol declarations to **17** without a release-version change. Neither source snapshot proves installed payloads or a live handshake.

## Requested live scenario matrix

| Case | Original visible in safe inspected tab? | Exact provider identity and message/root association? | First actual failing pipeline transition | Installed app/companion |
| --- | --- | --- | --- | --- |
| Ordinary single generated image | Not verified; protected tabs were left untouched | Not verified | Unknown | Not verified |
| Gallery or image-only response | Not verified | Not verified | Unknown | Not verified |
| Image-backed choice cards and Continue | **Yes, dedicated synthetic test fixture only**: one assistant row with two image-backed cards and Continue | **DOM/Fiber join observed**; two loaded inline images; control labels/states observed read-only, but capture-time extension authority and accepted native input not proved | Existing Markdown/generated-image scanners exclude this DIL reference-image surface; first *installed* loss stage unknown | Not verified |
| Rich diagram or embedded reference image | Not verified | Not verified | Unknown | Not verified |

No new generation was requested. No screenshots were retained: a full-window capture could disclose unrelated sidebar/account content. The initial protected-tab probe collected no DOM data; the dedicated follow-up collected only the redacted structural observations below. The user's original screenshot failure was not reproduced or diagnosed in the installed app.

## Dedicated owned test fixture — read-only live DOM/Fiber evidence (2026-09-19)

- Scope: the prime created and released **one dedicated test tab**, and explicitly authorized this worker to attach **that tab only**. Attachment succeeded and its current `/c/<uuid>` route matched the intended test conversation. No other tab was attached, navigated or examined, and no control was clicked, form edited, prompt sent, capture bytes persisted or debugger borrowed for an app-owned action. Tab identity and its actual conversation UUID are deliberately omitted.
- Message/root join, observed in MAIN-world read-only evaluation: exactly **two** `[data-message-id]` rows, one assistant row containing this fixture; its ID has a provider UUID shape. Exactly **one** `DilResponseRoot` sits inside that assistant row and outside `.markdown`. Its React Fiber `memoizedProps.messageId` equals the DOM row's raw provider UUID, while `memoizedProps.conversationId` equals the current `/c/` route. An ancestor's `conversation.serverId$()` also equals that route. The enclosing turn's eight-message `turn.messages` array contains **exactly one** message whose `id` equals this assistant DOM UUID; it is public `assistant` / `final` / `finished_successfully`, addressed to `all`, and its `content_type` is `text`. The turn metadata supplies working/exchange identity plus authored time, providing the inputs to the existing `fiber.js:451-459` **composite logical-key candidate** distinct from the raw provider UUID; the actual canonical stored key and collision handling were not observed. This is an actual unique mounted DOM/Fiber join for this fixture, **not** independent evidence for the user's original example or an authenticated capture.
- Layout/media: the unique DIL subtree contains both card controls, Continue and **two** `<img>` descendants, both fully loaded, with natural dimensions **1024×1280** and **1290×860**, respectively. Each image is inside its corresponding Forest/Coast pressable, has nonempty alt text and an HTTPS **cross-origin** source with a query string; neither source is ChatGPT's same-origin `/backend-api/estuary/content` family. Neither matches `[class~="group/imagegen-image"] img`, neither carries `data-clf-fiber-image`, and the turn has **zero** typed `image_asset_pointer` messages. These are observed **embedded remote reference images**, not evidence of generated-image asset tuples. No URL/host, signed parameter, image payload or alt text was retained. Canvas origin cleanliness, pixel capture, local asset storage and local renderer paint remain unknown.
- Native control semantics (no input): Forest and Coast each render one enabled native `button[type=button]` with `data-d-component="pressable"`, native React `onClick` functions and keyboard tab stops. Continue renders one native button. Initial passive observation showed Continue `disabled=true` and `aria-disabled=true`; later passive hydration showed both attributes removed and the button enabled, with no action dispatched by this worker. Read-only DIL Fiber props then exposed parsed `initialState.selected` matching **Forest**, and its card had a thicker computed border than Coast. The cards expose **no** `aria-pressed`, `aria-checked`, `aria-selected` or selected data attribute, and their button class tokens matched; therefore accessibility selection semantics and post-click behavior are **not** proved by markup alone. `widgetViewState` was a JSON empty object and `isActivelyStreaming=false` at inspection. A handler's existence or an enabled Continue is never a successful-action receipt.
- Earliest evidenced *capture design* omission for this fixture: `fiber.js:740-763,875-905` gathers rendered HTML from `.markdown` only, while its generated-image path (`:604-680`) depends on typed sediment pointers plus a same-origin estuary selector. Both selectors miss this observed DIL root and its two remote reference images. The exact row/route/React relation above provides a viable **candidate** for a bounded capture-time semantic-tree join; it must be rechecked atomically with the source image nodes and bound to Chrome's actual document registration/navigation generation plus the selected local session/binding. `data-clf-fiber-turn` exists on its turn but is not browser-issued sender identity; no `data-clf-fiber-message` or image stamp appears in this DIL row. Protocol-16 admission-time `sourceCaptures` cannot retroactively certify an earlier asynchronous DOM/Fiber capture. Task 5's recorder still refuses rich persistence absent that proof. No extension events, bridge write, assets, Recording setting, quota, `sessions:image` IPC, installed UI or screenshot were inspected, so the first **actual installed end-to-end failure** is still unknown.

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

The required **native action sequence was not executed**: the dedicated test conversation now proves one exact mounted response-to-Fiber join and bounded read-only button/pre-state observations, but this assignment explicitly prohibited activating Forest, Coast or Continue through generic browser debugging. It does **not** prove capture-time extension ownership/epoch, an app-owned action path, an accepted user selection, a Continue invocation or any native postcondition/new turn. A preexisting Forest state and a passive disabled-to-enabled transition are **not** post-click evidence. The companion's ability to accept authorized background input for these controls remains **unknown**. No synthetic event, text-prompt substitute, selector guessed from a screenshot or borrowed browser-control attachment is accepted as evidence.

Before enabling an action adapter, obtain an unprotected, explicitly safe test conversation under its legitimate browser owner. Inspect its exact provider-message-to-root join and unique accessible controls, demonstrate one supported native selection with observed group state, then one Continue with native postcondition/new turn. Verify background behavior without focus theft or an executor debugger lease. If any identity/state/postcondition is missing, leave the corresponding control inert with an original-page fallback; do not infer that input succeeded or retry an ambiguous Continue. The approved design's durable one-shot action cut remains a separate prerequisite.

## Fixture handoff and gates

The dedicated fixture now supports a **structural, synthetic-only fixture**: one `/c/<fixture-uuid>` route; one raw UUID-shaped assistant DOM row with a distinct **candidate** composite canonical logical key; matching DIL `conversationId`/`messageId` and matching turn-model assistant id; one semantic root outside Markdown; two `pressable` buttons each owning a loaded external reference-image slot, plus one Continue button; passive selection/disabled-state hydration. Fixture tests must use invented IDs and benign dummy local image handles, not copied provider payloads, URL selectors or real account data. The image-pointer family in the source trace belongs to a **different** generated-output case and must not be assigned to these references. No source/test fixture was added in this documentation-only work. User prompts, private account fields, cookies, signed links, image bytes and full HTML were not retained.

Tasks 2/3 must still establish the *actual* earliest generated-image loss transition: this observed reference-image family must not be mistaken for a generated image. Task 6 can use the **live fixture's unique mounted DIL/DOM/Fiber relation** as a narrowly scoped input, but cannot admit or persist rich/media without atomic capture-time route, sender/document/SPA, session/binding and revision evidence. Tasks 11/12 may reason about inert contracts only; no real action may be armed or native selection/Continue support claimed until separately authorized native accepted-input proof exists. Task 16 must separately verify matching **installed** versions and repeat all four original scenarios in the updated installed app and provider page. No tests, build, packaging, installed-runtime checks or native input were run for this documentation-only follow-up; documentation/privacy/diff checks are recorded in the internal task report.

## Task 16 continuation — evidence boundaries (2026-09-19)

The later **source** declares app/package/manifest version **2.1.17** and paired main/extension
protocol **17**. Protocol 17 introduces authenticated recording-generation issuance before page
observation and positional generation preservation through journal batches; the source change does
not update an installed extension or prove that its actual running bridge negotiated protocol 17.
Task 11's independently accepted process-memory UI-selection witness is only an inert display
eligibility guard. Task 13's narrowed named status IPC is a read-only ledger lookup, not a native
control adapter, successful input receipt or verified original-page opener. Rich preview pixels
are labelled **saved previews** and may be smaller than provider originals.

The new source fixtures use invented provider IDs and synthetic local pixels; they must not be
mistaken for the external reference pictures inspected in the original fixture, or for a real
generated-image asset pointer. Some source verification and review work remains in progress at
the time of this entry. The following statuses are deliberately conservative and must be updated
only from actually observed checks or an authorized installed/native run.

| Acceptance level | Current evidence | Status |
| --- | --- | --- |
| Source regressions | The **earlier** FIX4-plus-Task16 16-path run passed **14 files, 1,753/1,753 tests**, then an initial full `npm run verify` failed **199 tests / 12 files** and had one unhandled rejection. Subsequent protocol-17 fixture repairs were followed by a later recorded `npm run verify` **exit 0**: 223 main suites passed / 13 skipped, **5,400 tests passed / 136 skipped**, plus **6/6 shutdown tests**. This later full pass supersedes the earlier failure as the most recent completed repository-wide run, but predates the Goal corrections and new capture work. After the three initial Goal repairs, 669/669 focused tests passed. The subsequent store-queue CAS implementer reports a genuine physical RED then GREEN and **886/886 tests across seven adjacent suites**, typecheck/privacy/diff passing, now documented with the actual commands, results and limits in the ignored `task-16-goal-store-cas-fix-report.md`. Independent source review found no Important (`task-16-goal-store-cas-review.md`), did not rerun tests and noted two nonblocking fixture-precision gaps. None of these runs is verification of the pending provenance source or final integrated design. | PRIOR FULL SOURCE PASS; LATEST SCOPED GOAL PASS REPORTED; FINAL RERUN OPEN |
| Typecheck, privacy and notices | The completed post-fixture-repair full `npm run verify` passed its typecheck, privacy and notices prerequisites (the earlier privacy run counted 267 commits/14 tags; notices listed 155 production packages, seven catalog entries and 730 pinned entries). The later Goal CAS implementer also reports typecheck, privacy and scoped diff check exit 0; the independent reviewer separately checked the scoped diff. Rerun after further source changes and distinguish report from independent execution. | INTERIM PASS; FINAL GATE OPEN |
| Build | `npm run build` exited **0** on FIX4 `6fd47d3` plus the earlier Task16 worktree, with Vite chunking warnings. Only source bundles were built, not a distribution or installed app. This build predates the later Goal/capture changes and must be rerun. | PRIOR SOURCE BUILD PASS; FINAL GATE OPEN |
| Package | No separately authorized candidate package or inspected hashes. | NOT VERIFIED |
| Installed ChatBBC and extension | Running versions, handshake, screenshots and behavior were not observed together. | NOT VERIFIED |
| Signed-in original native controls | Read-only button/state observation only; no authorized actual selection, Continue dispatch or postcondition. | NOT VERIFIED |
| Real generated single/gallery/image-only results | A disposable image-generation request was submitted, but completed image, canonical provider tuple, bytes, admission and ChatBBC paint were not observed. | NOT VERIFIED |

**Later source check, 2026-09-19 (supersedes the full-test count in the historical matrix row above):**
`npm run verify` completed with exit 0 on the integrated stage-(a)/(b)/(c+) source and atomic
pending page-image seeding: **223 main suites passed / 13 skipped, 5,455 tests passed / 136
skipped**, plus **6/6 shutdown tests**. Its typecheck, privacy and notices prerequisites passed.
The subsequent independent source audit identified two concrete custody/storage defects and
generated-image encoding/queue defects. The malformed persisted-rich predecessor was reproduced
RED and repaired: **47/47** adjacent storage tests, typecheck and diff check passed afterward.
The rich queue and generated-image encoding corrections were independently implemented with
genuine RED cases and **670/670 content-script tests**, then typecheck and diff check passed.
A separate removed PAGE image-slot resurrection was reproduced RED on a real A→B→A rebind;
the subsequent durable logical-slot tombstone/cleanup repair passed **76/76 tests across five
storage/retention suites**, typecheck and diff check. These scoped runs validate their own source
boundaries, not an updated signed-in provider image or native interaction. The **5,455-test full
run predates all those audit repairs**. Final full verification and source build remain OPEN.
These are source checks only: no package, matching installed extension, provider-origin pixels,
actual native input or installed UI was exercised or promoted to PASS.

The scenario matrix below is an acceptance ledger, **not** a claim that a synthetic case was
reproduced in the user's installed environment. Source status identifies only the current kind
of evidence; no row may inherit an installed/native PASS from another row.

| Scenario | Source-level evidence / limitation | Installed or original-page status |
| --- | --- | --- |
| Image-backed choice cards and Continue | Two distinct locally generated WebPs are keyed to their corresponding inert card slots through a mocked named reader; the mock alone does not prove session ownership. A later source-level private page-pixel publisher and canonical assistant-asset membership reader now exist, but their latest integrated changes still await full verification. Native control binding remains absent. | NOT VERIFIED; original fixture observed read-only only. |
| Wide diagram and table | DOM fixture contains 12 diagram nodes and 24 table cells, with contained focusable regions; jsdom does not measure physical scroll or clipping. | NOT VERIFIED. |
| Single generated image, gallery, image-only final | Synthetic Sharp WebP bytes survive local session reload and an image-only timeline row receives an `img` data URL; none came from a verified original generation. | NOT VERIFIED. |
| Progressive hydration, pending, unavailable, unsupported, unknown component | The earlier focused suite passed 1,753 tests across 14 files. A later full source verify passed after fixture repair, but it predates subsequent Goal/capture changes; source coverage is not installed paint. | NOT VERIFIED. |
| Selection reset/reselection and historical A→B→A | Source selection witness and stale-reader guard have focused coverage, not a native original-control postcondition. | NOT VERIFIED. |
| Closed-tab one-time reopening and app restart | Source authority/retention tests exist; neither an installed tab-reopening action nor restart of the updated app was witnessed. | NOT VERIFIED. |
| Image viewer, retry, removal and cleanup | Local viewer and storage/tombstone fixtures exercise source behavior; opening the original or a new capture retry is unsupported where proof is absent. | NOT VERIFIED. |
| Recording Off and failed transition | Physical-file/HTTP regressions cover generation, post-loop/suffix and assistant-final/page-tool/native-image committed-prefix boundaries, including superseded image ownership. FIX4 passed six-file adjacent 705/705 and scoped review; later full source verification passed after legacy fixture repairs. The additional Goal CAS source review approved the in-queue rebind guard, and its implementer reports seven suites 886/886; post-capture full verification and installed operation remain separate gates. | NOT VERIFIED. |
| Wrong-account and blocked-chat cases | Source identity/ownership rejection guards exist; no installed wrong-account action was attempted. | NOT VERIFIED. |
| Long scroll, responsive panel, zoom | Source DOM preserves rows/anchors and wide-region containment; pixel geometry/scrollWidth needs a real layout engine. | NOT VERIFIED. |
| Keyboard, focus, RTL, reduced motion, Light/Dark/Omarchy | Semantic and CSS source checks are not equivalent to installed accessibility or appearance measurements. | NOT VERIFIED. |

**Rich embedded-image gate:** The earlier placeholder-only observation predates the later
source implementation. Current `recordBridgeVerifiedPixel` can take a private page-pixel ticket,
commit a verified pending source, fully decode/hash-check a bounded WebP, write its asset and
atomically publish `available` on the original canonical assistant shard. The fixed
`sessions:image` reader checks the exact assistant-rich membership, asset bytes and cleanup
epochs, rather than trusting a caller-supplied media record. Focused source tests have exercised
local Sharp bytes and an actual temporary session/asset, **not** a real provider-generated
Forest/Coast picture, installed extension or actual raster paint. The newest concurrent
source-retirement, bridge-stop and worker-activation corrections remain under integration review
and the corrected full suite has not passed yet. The first choice-card fixture's mocked reader
still does not independently prove ownership; it is not end-to-end evidence. Original
image-backed card acceptance remains BLOCKED / NOT VERIFIED until provider-derived trusted
pixels, matched installed peers and actual inline paint are observed. Wide table/diagram DOM
structure and CSS containment do not prove actual
`scrollWidth` or responsive visual geometry without a real layout engine. A jsdom `<img>` with a
valid locally generated WebP proves insertion of a valid data URL, not hardware/browser raster
paint. No native interaction can be inferred from any of these presentation checks.

No currently safe, explicitly owned browser tab or installed-and-paired test environment has been
established for further native acceptance. Protected tabs remain out of bounds; an unprotected
but unowned tab is not authority. Do not substitute synthetic DOM events, a prompt submission,
an extension acknowledgment or a source build for a native operation and its postcondition.

## Task16 source checkpoint — 2026-09-20, after descriptor custody repair

The historical matrix above predates this checkpoint. Three independently identified read-only
descriptor defects were reproduced RED in `test/rich-response-store.test.ts`: ignored ungrouped or
different-group controls in one stored form, symlinked `messages/` ancestry with identical bytes,
and distinct physical assistant shards with the same provider identity even after alias folding.
The subsequent source repair checks all controls in the target form and performs a bounded,
fail-closed physical provider/ancestry/legacy custody scan. The three regressions passed **3/3**;
additional positive separate-form and unrelated-provider fixtures and negative corrupt/legacy
custody cases brought the complete rich-store, inert-action, final-identity and input-delivery
suites to **292/292 PASS**. These tests verify stored descriptors, **not** a live native form.

Fresh `npm run verify` on this updated dirty worktree exited **0**: 223 main test files passed,
13 skipped; **5,600 tests passed and 136 skipped**; separately isolated shutdown **6/6 PASS**.
The same command's privacy, notices, TypeScript and Electron module checks passed. `npm run
build` exited **0** and produced only source bundles; `git diff --check` exited **0**.
Source logs: `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-post-descriptor-full-verify.log`
and `2026-09-20-post-descriptor-source-build.log`; focused log
`2026-09-20-descriptor-adjacent-verify.log`. App and companion declarations remain 2.1.17,
paired protocol 17; HEAD remains 6fd47d3, with no commit, package or installation.

**Acceptance remains NOT VERIFIED for packaged/installed app, paired extension runtime,
original signed-in native selection/Continue and postconditions, real generated-image
single/gallery/image-only provider pixels and actual installed raster/geometry/accessibility.**
The source's `beginRichAction`, `electRichAction`, `armRichAction` and `finishRichAction` remain
non-arming. No safe owned original-page test fixture or authorization to package/install was
established by this source-only checkpoint; no browser tab was manipulated.

## Task16 source checkpoint — 2026-09-20, nested form and physical ownership follow-up

An independent post-repair read-only reviewer found three additional Important descriptor
counterexamples: a nested row was incorrectly treated as a distinct form from its enclosing
card, a duplicate provider alias in the legacy map could be inserted during an awaited shard
scan, and a second session could acquire the same conversation between awaited catalog reads.
The first two now have actual source-level fail-first regressions: **2/2 RED before repair**, then
**2/2 GREEN**. The store now retains same-card control membership across presentation wrappers,
keeps sibling cards independently scoped, verifies legacy file existence/identity and session
parent metadata at the end of the bounded physical scan, and synchronously checks attachment
epoch, provisional owners, catalog cardinality and the exact live source after catalog awaits.
The owner-epoch correction has independent source review but **no dedicated observed RED test**.
Independent report: ignored `task-16-post-descriptor-fix-review.md`, scoped **SPEC PASS / QUALITY
APPROVED**; the reviewer did not independently execute tests.

Updated focused/adjacent source results: rich-store 27/27, exact recorder-final identity 50/50,
input-delivery integration 203/203 and the prior inert rich-action 14/14, total **294/294 PASS**.
Two additional synthetic-ledger tests cover settled-disk cold restoration of five v1 phases
and a real rename followed by a lost checkpoint acknowledgment; `test/rich-actions.test.ts`
subsequently passed **16/16**. They leave production begin/elect/arm/finish disabled and do not
prove a human click, native selection or original-page postcondition. New full isolated
`npm run verify` exited **0**: **223 main files passed / 13 skipped; 5,604 tests passed / 136
skipped**, with **6/6 separate shutdown tests PASS**. Privacy, notices, typecheck and Electron
resolution prerequisites passed; `npm run build` source-only exited **0** and `git diff --check`
passed. Logs in the ignored SDD folder: `2026-09-20-nested-legacy-red.log`,
`2026-09-20-nested-legacy-green.log`, `2026-09-20-post-descriptor-second-adjacent.log`,
`2026-09-20-inert-cold-crash-tests.log`, `2026-09-20-post-nested-full-verify.log`,
`2026-09-20-post-nested-source-build.log`. HEAD remains `6fd47d3`,
app/package/extension 2.1.17, paired protocol 17; no commit, package, installation,
browser input, release, merge or push.

The only browser inventory attempt for this follow-up returned `tunnel_client_not_seen` from
the disconnected companion; no tab was attached or manipulated. Independently, a source-level
feasibility review found that the current DIL pressable capture stores generic `button` with
null group/value, while the strict inert descriptor accepts only an exact unambiguous
choice/Continue group, and Electron pre-input events provide no independent hardware-origin
witness. This is a **source feasibility observation**, not a signed-in accepted-input test.
**Still NOT VERIFIED:** real provider-generated single/gallery/image-only output through a
matched installed app+extension, actual image paint and accessibility/geometry, and exact
native choice/Continue clicks and observed postconditions. Retry capture and the production
native-action transaction remain unimplemented; package/install were not authorized.

## Task16 source-only final follow-up — 2026-09-20

This checkpoint supersedes the earlier test totals, **not** the unverified installed/live
acceptance verdict. An existing, physically persisted and claimed pre-dispatch action can now
be invalidated through a main-private, non-arming reconciler, producing only a durable
changed/unavailable receipt. An attempted Recording Off that has not committed **does not**
irreversibly retire the action; the final physical ledger comparison follows the last awaited
source check. A rejected action checkpoint cannot later replay its own durable retry; an
ambiguous successful rename remains quarantined. Three final reviewer regressions passed,
the final rich-action suite passed **28/28**, and an independent static reviewer approved the
two scoped repairs. This is not a cross-process filesystem CAS, a trusted gesture, native
control input or observed provider postcondition. Production action entrypoints remain
unavailable; no native-action IPC/HTTP route was added.

The new read-only rich-media retry eligibility descriptor verifies the exact current stored
PAGE image node/source/revision/Recording/cleanup state and indicates when an explicit removal
confirmation would be required. It issues **no** retry ticket, browser action or asset. Its
five neighboring source/storage suites passed **111/111**. The current rich-page image node
has no independently attested relationship to the separately observed typed native generated
asset tuple; native-to-rich asset reuse is therefore **BLOCKED**, not guessed from matching
message IDs or synthetic metadata. A separate native preview renderer fix validates the
fixed local image-reader data URL against bounded syntax and the expected MIME, refusing
remote URLs and malformed/mismatched data. The three new cases were observed **RED before the
fix and GREEN afterward**. The pre-final durable/action/renderer owned suites passed **219/219**.

Latest full `npm run verify` with the isolated workspace TMPDIR exited **0**: 223 main test
files passed/13 skipped, **5,627 tests passed/136 skipped**, separate shutdown **6/6 PASS**;
privacy/notices/typecheck/Electron module checks passed. Latest `npm run build` exited **0**,
producing **source bundles only**. Logs:
`.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-post-inert-reconcile-full-verify.log`
and `2026-09-20-post-inert-reconcile-source-build.log`. HEAD `6fd47d3`, existing dirty work,
app/package/extension 2.1.17 and paired protocol17 remain unchanged; no commit, package,
install, version change, push, merge, release or browser-tab input occurred. The companion
inventory reported `tunnel_client_not_seen`; no owned signed-in native test was performed.

**Original acceptance remains NOT VERIFIED:** real provider-generated single/gallery/image-only
pixels and actual installed paint; exact native image-to-embedded-slot reuse; native
choice/Continue accepted input and resulting postconditions; explicit one-shot recapture;
installed app/extension pairing and real responsive/accessibility checks. Source fixtures and
build artifacts must not be presented as evidence that these real workflows succeeded.

### 2026-09-20 — saved-preview focus source check (not installed/live acceptance)

Task14 saved-preview dialog now explicitly declares `aria-modal=true`, keeps Tab and Shift+Tab on its sole actionable Close button, redirects outside focus while current and releases its document listener after close or retirement. New jsdom regression was first **RED (1 failed/11 passed)**, then viewer+renderer tests **32/32 PASS** and TypeScript/diff check passed. Isolated full source verify **EXIT0** (223 main files passed/13 skipped, **5,628 tests passed/136 skipped**, separate shutdown 6/6, privacy/notices/typecheck/Electron check passed); source-only build **EXIT0**. Logs: `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-post-viewer-focus-full-verify.log` and `2026-09-20-post-viewer-focus-source-build.log`. No actual Electron modal focus, real image raster or accessibility behavior was observed.

Browser companion inventory remains `tunnel_client_not_seen`; no current owned fixture was available for native/provider tests. Matching app/extension package and install were not authorized or attempted. All earlier native original-choice/Continue, one-shot Retry Capture, provider single/gallery/image-only pixel capture and actual installed rendering, native-asset-to-exact-rich-node association, and Task16 live acceptance cells remain **NOT VERIFIED**. No commit, package, installation, version/protocol change, push, merge or release.

### 2026-09-20 — subsequent source-only custody checks (interim; not live acceptance)

A deterministic Task14 preview-viewer focus reentrancy regression was RED then GREEN after guard-before-focus registration and lifecycle cleanup; 33/33 viewer+renderer tests and TypeScript passed, and independent source re-review approved the narrow fix. A physical canonical-shard swap during Task14 read-only PAGE retry owner lookup was RED then GREEN after a second strict source read; 96/96 adjacent source tests passed. These checks create no Retry Capture action, native control permission, asset publication or installed Electron focus proof.

A separate inert same-IMG/typed-native-image association candidate remains **UNAPPROVED for independent ownership or publication** after independent review found copyable stamp, same-object remount and bounded traversal defects. The scoped source fix and stable-tree verify remain open at this entry. The inspected Forest/Coast reference pictures were cross-origin and had **no** typed generated-image tuple: never reinterpret them as native generated images. Browser companion inventory returned `tunnel_client_not_seen`; no authorized owned current test tab, native selection/Continue postcondition, genuine generated-image pixels/installed paint, matched package/install or live accessibility run occurred. Earlier source full-verify results must not be promoted to these cells.

### 2026-09-20 — final stable-source checkpoint (still no installed/native acceptance)

After two source-only Task14 race/focus fixes and an inert Task9 native image↔rich-node candidate, reviewer-identified source flaws in the candidate (fake-stamped ordinary IMG, same-IMG remove→reinsert, unbounded custom iterators) were fixed with selector, preexisting private source-lifetime handle and own-data bounded traversal. Focused owned candidate suite **112/112 PASS**, independent reviewer found those three source issues resolved **only for the inert candidate**. The page-supplied Fiber frame/current scan is not independently authenticated; no native generated-asset reuse, rich media publication, image bytes or action grants result from this helper.

The first stable integrated run reported **one failure** in a PAGE A→B→A rescan status sequence with one extra pending; 5,638 passed/136 skipped. Focused scenario **2/2 PASS**, adjacent content+DOM **805/805 PASS**. No root cause was independently established. An unchanged-tree complete rerun `npm run verify` **EXIT0**, 223 main test files passed/13 skipped, **5,639 tests passed/136 skipped**, separate shutdown **6/6 PASS**, privacy/notices/typecheck/Electron module resolution passed. Source-only `npm run build` **EXIT0**, diff check exit0. Authoritative logs `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-final-stable-full-verify.log` and `2026-09-20-final-source-build.log`, with the original failed `2026-09-20-post-source-association-final-full-verify.log` retained. HEAD `6fd47d3`, source `2.1.17`/protocol17, all 45 dirty tracked paths preserved. No package/install/commit/version/release/push/merge/browser input.

**Not verified / incomplete:** installed matched app+extension; real generated single/gallery/image-only provider tuple→bytes→installed raster; independently attested typed native asset association to one embedded rich slot; original choice selection and Continue native postconditions; production one-shot Retry Capture; live responsive/accessibility, Recording Off and crash/restart acceptance for those still-missing action/retry workflows. The companion returned `tunnel_client_not_seen`, no current user-authorized owned disposable native test fixture is available, and explicit matched package/install approval has not been given. Neither unit tests nor this build can fill those cells.

### 2026-09-20 — authorized Linux candidate packaging; packaged native-runtime acceptance FAILED

The user subsequently explicitly authorized packaging/installation and completion work; this supersedes the earlier **permission** limitation above, not the native action/source-proof requirements. The existing running ChatBBC AppImage and its `~/.config/chatbbc` data were left untouched. The browser companion inventory again returned `tunnel_client_not_seen` for this session, so no browser tab, live page, native control or real generated image was observed.

`env -u APPIMAGE TMPDIR=<isolated project temp> npm run dist:linux:x64` **EXIT0**, generating `release/ChatBBC-Linux-x64.AppImage` and `.deb` without publishing. The DEB control metadata reports `chatbbc`, version **2.1.17**, architecture **amd64**; unpacked extension version is **2.1.17**, paired extension/main source protocol is **17**. SHA-256: AppImage `4a3dfcd1e0de8e7d2e0cae21c1e6eb196eb4d850b768d5153e6020cba416534e`; DEB `d771470138aa8c52c597e127de479765b08554032d1c4a350f07eab36cf117fd`. Packaging log: `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-authorized-linux-package.log`. A package command exiting zero and source declarations are **not installed evidence**.

The repository's mandatory `scripts/smoke-packaged-runtime.mjs --platform linux --arch x64` **EXIT1** on the resulting `release/linux-unpacked` payload, with no process stdout/stderr at the failure. Isolated probes established bundled Electron 44.3.0 can load packaged `sharp@0.35.4`, `node-pty`, tree-sitter and tree-sitter-bash; packaged pty spawn and tree parse succeed, and host Node successfully creates a 2×2 PNG via Sharp. **But the packaged Electron's `sharp({create:...}).png().toBuffer()` consistently terminates in SIGSEGV.** This persists with inherited AppImage `LD_LIBRARY_PATH` removed and with `UV_THREADPOOL_SIZE=1`. GDB's offending `libuv-worker` stack: null address → system `g_object_unref` → packaged `sharp-linux-x64-0.35.4.node` → `sharp::OpenInput`. Exact diagnostic logs `2026-09-20-{packaged-runtime-smoke,packaged-runtime-smoke-clean-loader,packaged-runtime-single-thread-diagnostic,sharp-electron-gdb}.log`. This is a **real packaged native-runtime failure**, not the browser's original image-loss stage or an installed-app acceptance result. It is consistent with documented Electron/Linux vs bundled Sharp/GLib symbol collisions, but no production repair has been implemented or claimed.

**Packaging artifact generation: PASS. Packaged native runtime: FAIL. Installation and live acceptance: NOT STARTED.** Do not replace/restart the actively running AppImage with this known-crashing candidate or mark it ready. Correct the native Sharp/Electron packaging conflict with a reviewed, reproducible platform-compatible change and repeat the same native smoke plus complete verification before any in-place installation. Still missing separately: independently proven native choice/Continue, one-shot Retry Capture, real generated-image pixels/installed paint, authenticated native asset-to-rich-slot association and live UI/Recording Off/restart matrix. HEAD `6fd47d3`; version/protocol unchanged; no commit, installed replacement, push, merge or release.

### 2026-09-20 — subsequent Sharp repair, fresh rebuilt candidate and exact evidence limits

The previous packaged SIGSEGV above describes the **older** package, not the current candidate. In the existing shared dirty worktree at HEAD `6fd47d3`, `src/main/sharp.ts` selects the separately pinned Electron-compatible backend only inside Linux x64 Electron, while host Node and other targets retain upstream Sharp; target-specific packaging excludes competing stock native Sharp/libvips on x64. Prior independent source review recorded a remaining source-release Important: the exact vetted `docs/licenses/native/pinned/gvdb-53daeeb4.tar.gz` is **untracked**. Local bytes are 24,716 with SHA256 `069a00aa1fc893f18423602f4e095583be5a220429f6e8a58d70511490b4b019`. The existing 731-entry, approximately 662 MB corresponding-source archive includes `archives/gvdb-53daeeb4.tar.gz` and `SOURCE-BUILD.md`, and documented executable archive-only patch reconstruction passed its focused packaging test earlier. A future clean Git checkout/release still lacks that fallback until the file is deliberately included in its source commit and clean-checkout CI is demonstrated; local artifacts do **not** close this release gate.

Current-tree verification completed **EXIT0**: 225 main test files passed/13 skipped, **5,648 tests passed/136 skipped**, separate shutdown **6/6 PASS**, with the script's privacy, notices, TypeScript and Electron checks. `npm run build` then completed **EXIT0**, and newly authorized `npm run dist:linux:x64` generated fresh AppImage and DEB **EXIT0**. The mandatory exact `release/linux-unpacked` native smoke completed **EXIT0 with no `LD_PRELOAD` or inherited AppImage loader variables**: Electron 44.3.0, Sharp 0.35.4/VIPS 8.18.6, PNG creation and decode, WebP, node-pty and tree-sitter. This is a real **packaged native-runtime PASS**, not an installed GUI or browser-image paint. Logs and `.exit` markers: `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-current-tree-final-verify.log`, `2026-09-20-current-tree-post-sharp-source-build.log`, `2026-09-20-post-sharp-final-linux-x64-package.log`, and `2026-09-20-post-sharp-final-packaged-runtime-smoke.log`. Preserve earlier failed/hung logs as separate evidence.

SHA256 of this rebuilt AppImage: `0ddc8e7ee80fe170dcf38697852f49df514d5c802e2d4f8b577721096c59b684`; rebuilt DEB: `964dceb531650d92b632078fa4167e83f5cdeef2c99a47f1992a198fe42cd0cb`; corresponding-source archive: `64e3e385ebf9f346da89c73d4cefe346bfb52de95fc2793bf6969812dfa7de64`. The DEB's `ar`/`control.tar.xz` inspection reported package `chatbbc`, version `2.1.17`, architecture `amd64`; unpacked companion manifest declares `2.1.17` and bundled background protocol `17`. The host has no `dpkg-deb`, `Xvfb` or `xvfb-run`; therefore no actual Debian installation or isolated headless GUI run is claimed here. The original AppImage PIDs `3010742` and `3010773` were still present at the post-package identity observation; neither was intentionally replaced/restarted. A separate read-only preflight `task-16-disposable-install-safe-preflight.md` requires a scratch **copy** of the candidate (its updater can overwrite the executing `APPIMAGE` path), private HOME/XDG directories and an owned process group/cgroup; local port-zero isolation precludes pairing because the companion scans fixed ports. A real installed DEB and matched signed-in companion require a disposable VM/network/browser profile with independently observed identity, not the user's existing host installation or profile.

Browser companion inventory again returned `tunnel_client_not_seen`, so **installed GUI, paired extension, real provider-generated single/gallery/image-only pixels and paint, native choice/Continue postconditions, actionable one-shot Retry Capture, live accessibility and full Recording-Off/crash matrix all remain NOT VERIFIED**. Successful source verification, fresh package generation and native smoke do not upgrade those cells. No version bump, Git commit/push/merge/release or replacement of the live app occurred at this checkpoint. Further Task14 source edits, if made after these artifacts, require a separate final rebuild/verify before representing the packages as that later tree.

### 2026-09-20 — isolated actual DEB installation and GUI startup, without browser pairing

The preceding NOT VERIFIED installed-GUI cell was advanced by a later **separate, disposable Ubuntu 24.04 Docker container** (independent network namespace/package database, `release` bind-mounted read-only, `--rm --init`, no host home/browser mount). The first constrained package attempt failed at apt's privilege separation because container capabilities were insufficient; retry with explicit SETUID/SETGID/CHOWN/DAC_OVERRIDE/FOWNER reached installation but its evidence script accidentally used unescaped shell variables in a dpkg-query format and exited 1 before collecting GUI proof. Corrected script installed the exact existing x64 DEB (`dpkg-query`: `install ok installed`, `2.1.17`, package-owned `/opt/ChatBBC/chatbbc` and `/usr/bin/chatbbc` alternative); checked all three desktop-file integration markers. With only the DEB's declared dependencies plus Xvfb/DBus/CA test utilities, GUI launch **failed** with the ELF loader's `libasound.so.2` missing, identifying a real minimal-install dependency gap. Logs: `2026-09-20-isolated-deb-installed-gui.log`, `2026-09-20-isolated-deb-installed-gui-retry.log`, `2026-09-20-isolated-deb-installed-gui-corrected.log`, all with preserved `.exit` markers.

A subsequent clean disposable Ubuntu 24.04 container explicitly installed additional `libasound2t64` and `libgbm1` (the first is the observed missing library; the second supplies an Electron runtime dependency) alongside the same DEB. The package ownership, version and desktop assertions passed, `ldd` reported no missing direct shared libraries, and a nonroot isolated HOME + XDG profile with `CLF_BRIDGE_PORTS=0`, private D-Bus and Xvfb ran the installed `/usr/bin/chatbbc --no-sandbox` for the deliberate 12-second timeout (exit 124). Actual log markers **`[info] app started`, `[info] renderer state ready`, `[info] window loaded`** were present; no matching renderer/window error appeared. The hostless container emitted nonfatal missing-system-D-Bus errors. The script's final `ISOLATED_INSTALLED_DEB_GUI=PASS` and container command **EXIT0** are recorded at `.superpowers/sdd/2026-09-18-chatbbc-rich-responses/2026-09-20-isolated-deb-installed-gui-runtime-deps.log{,.exit}`. The container was removed and no named test container remained; candidate artifact hashes stayed unchanged, and the original app's PIDs/start times remained unchanged at the postflight observation. This is an **actual isolated installed DEB + renderer startup PASS conditional on extra dependencies**, not a correct minimal dependency declaration, a same-host install, signed-in browser test, or proof of image raster/native control postconditions. The test used `--no-sandbox` only in the uncredentialed disposable container; no signed-in assurance is claimed. The missing DEB dependency is being corrected test-first and requires a new package and clean minimal-install verification to close.

### 2026-09-20 — Task14 Cut2B final source verification; native evidence unchanged

Cut2A removal-provenance source repairs passed independent review and the earlier complete verification (5,663 main passed/136 skipped; shutdown 6/6). Cut2B's exact physical PAGE and Recording-generation comparison is informational only; its own missing-API RED, implementer 63/63 focused GREEN/typecheck and independent **SPEC PASS / QUALITY APPROVED** are in ignored `task-14-cut2b-source-readiness-report.md` and `task-14-cut2b-source-final-independent-review.md`. Prime's *later* final `2026-09-20-cut2b-final-full-verify.log{,.exit}` records full `npm run verify` **EXIT0**, **5,665 main tests passed/136 skipped** and isolated shutdown **6/6**; privacy/notices/typecheck/Electron gates passed. Neither source match nor test results authenticate a Retry gesture, prove a Chrome receipt, recapture bytes or remove a tombstone. The next Cut3A is excluded from this verification. Earlier repaired Sharp packaged smoke and isolated DEB GUI startup remain their distinct prior-tree evidence; updated package, minimal declared dependencies, genuine paired signed-in generated media, native choice/Continue and Retry Capture, accessibility and restart/off postconditions remain **OPEN/NOT VERIFIED**. Current local GVDB fallback bytes match the pinned 24,716-byte SHA256 but remain untracked, preventing clean-checkout source archive reproduction until deliberately included and tested. Existing active AppImage and userData remain undisturbed; no new installed/native test or publish was conducted for Cut2B.

### 2026-09-21 — final stable source/package/install checkpoint; provider acceptance still blocked

The final stable dirty tree passed `npm run verify` **EXIT0**: 226 main test files passed / 13 skipped, **5,680 tests passed / 136 skipped**, followed by isolated shutdown **6/6 PASS**. The same gate passed privacy (267 commits / 14 tags), notices (157 production packages / seven catalog entries / 731 pinned native sources), TypeScript and Electron module resolution. `npm run build` completed **EXIT0** with only the existing Vite dynamic/static import chunking warnings. `git diff --check` completed **EXIT0**.

`env -u APPIMAGE npm run dist:linux:x64` then completed **EXIT0** on that same source, without publishing or replacing the host's live application. `scripts/smoke-packaged-runtime.mjs --platform linux --arch x64` completed **EXIT0**, observing Electron 44.3.0, Sharp 0.35.4 / libvips 8.18.6 PNG creation and decode, WebP, PTY and tree-sitter. Final artifact SHA-256 values: AppImage `1407a4584f043b2f7aed828c1f42d998a94584ecbcb2323941c332766d66b4dd`; DEB `2be9f447879bd343b9157e2b80716f0e84fb3e7ca5a0112ed2214df13c08c83f`.

The DEB dependency order was corrected to `libasound2t64 | libasound2` so Ubuntu 24.04 does not satisfy Electron's ALSA dependency with the ABI-incompatible `liboss4-salsa-asound2` virtual provider. A fresh disposable Ubuntu 24.04 install of the final DEB selected `libasound2t64` and `libgbm1`. Its installed GUI remained alive until the intentional timeout (124); isolated application logs recorded `app started`, `renderer state ready` and `window loaded`, with no renderer/window-load error. This proves package installation and basic GUI startup only; it is not evidence for a signed-in provider flow, companion pairing or image raster.

Task 2's final source matrix passed **1,378/1,378** with TypeScript, and an independent re-review found no source findings. The final repairs require complete available PAGE custody in the renderer and retain structural capture-ticket authority through the last awaited canonical predecessor check immediately before rename. These are fixture/source guarantees; an already-admitted atomic rename cannot be revoked after it starts.

The browser relay still could not acquire a signed-in provider tab. An independent OS-level Orca inventory reached a Linux computer-use runtime but returned no targetable app window. Therefore real provider-generated single/gallery/image-only pixels, matched app/companion handshake, original choice/Continue accepted input and postconditions, one-shot Retry Capture, native rich-asset association, responsive raster/accessibility and the action/retry Recording-Off/restart matrix remain **BLOCKED / NOT VERIFIED**. Production action entrypoints intentionally remain non-arming; no extension action protocol or writable action IPC was fabricated from fixture labels. No commit, push, merge, release, host-app replacement or live user-data mutation occurred.

### 2026-09-21 — PAGE queue recapture and pending-lease release (source only)

Post-PR independent review found two PAGE-pixel custody defects in the landed `rich-responses` tree. Source repairs and focused regressions are recorded in the SDD progress ledger. This does **not** change any live cell: signed-in companion/provider pixels, native choice/Continue, one-shot Retry Capture, and installed raster/accessibility remain **NOT VERIFIED**. Production action APIs remain non-arming. No fixture is treated as live.

### 2026-09-21 — overflow requeue without durable gate; deferred-only lease release (source only)

PagePixelRepairReview P1 follow-up. Source repairs and focused regressions are in the SDD progress ledger. Live companion/provider pixels, native choice/Continue, Retry Capture, and installed raster/accessibility remain **NOT VERIFIED**. Production action APIs remain non-arming.

### 2026-09-21 — post-repair verify and source build (not live)

Independent `PagePixelRepairReview2`: overall_correctness **correct**, confidence 0.88.

`TMPDIR=.../tmp-verify-20260921-pagepixel env -u APPIMAGE npm run verify` EXIT0:
- privacy 268 commits / 14 tags
- notices 157 packages / 7 catalog / 731 pinned
- typecheck then Electron `require('electron')` then vitest
- **226 passed / 13 skipped** files; **5,684 passed / 136 skipped** tests
- isolated shutdown **6/6**

`env -u APPIMAGE npm run build` EXIT0: main 1.66s, preload 15ms, renderer 3.48s (Vite dynamic/static chunking warnings only). Linux AppImage/DEB were **not** rebuilt; hashes `1407a458…` / `2be9f447…` still describe `57c6b18`. Live companion/provider cells remain **NOT VERIFIED**. Production action APIs remain non-arming.
