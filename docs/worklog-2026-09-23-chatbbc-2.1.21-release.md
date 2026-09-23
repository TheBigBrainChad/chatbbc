# ChatBBC 2.1.21 corrective release, 2026-09-23

## Scope and root cause

The canonical assistant text of the reported answer contains `U+E200 genui U+E202 {"app_block":…} U+E201`; its captured HTML has `[data-app-block-preview]` around a sandboxed provider iframe, but no `rich` revision. `chat.ts::renderedMarkdown()` handled citation and URL references, not `genui`, and therefore printed the component source. The renderer now classifies that exact reference family outside Markdown code and uses the existing inert unavailable presentation. The canonical message and bridge protocol 17 remain unchanged. This correction follows the already published 2.1.20 Crystal Studio release.

## Response-family catalog and decisions

| Family | Evidence | ChatBBC action / next gate |
|---|---|---|
| `app_block` | Observed in recorded text and `[data-app-block-preview]` native iframe; [OpenAI's inline visualizations reference](https://github.com/openai/role-specific-plugins/blob/main/plugins/data-analytics/skills/visualize-data/references/native-inline-visualizations.md) documents its HTML fragment form. | Closed-source unavailable card now. A real mirrored choice requires a trusted gesture and exact provider postcondition, not HTML reinterpretation. |
| `charts_widget_v2` | Same OpenAI reference documents bar/line/pie/scatter specs under `genui`. | Same safe fallback now. A future static chart needs a bounded validated spec and a real native visual comparison. |
| `ask_user_input`, `async_image_group`, learning flashcards/quizzes, pronunciation | Documented in mirrored [ask-user-input](https://codex-tool-reference.simonw.chatgpt.site/skills/answers-ask-user-input), [images](https://codex-tool-reference.simonw.chatgpt.site/skills/answers-images), and [learning](https://codex-tool-reference.simonw.chatgpt.site/skills/answers-learning) skill snapshots, not observed in this app. | Unknown-key `genui` fallback now; prioritize exact live shape/custody evidence before a specific renderer. |
| Cite/filecite/url references | Existing ChatBBC tokenizer and captured citation ranges. | Keep existing link/label handling, not the widget fallback. |
| Entity/product/image-group references outside `genui` | Secondary [content-reference analysis](https://think.resoneo.com/chatgpt/); not reproduced for this task. | Research exact native semantics before claiming support. No broad private-use-token stripping. |
| MCP Apps widgets | [OpenAI's UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui) defines server-provided iframe resources and a JSON-RPC bridge, distinct from inline model-authored `genui`. | No shared renderer or bridge inferred from the similar appearance. |

The reported app-block bundle includes `title`, `entrypoint`, `bundle_version` and `variant`, while the public OpenAI reference only specifies `content`; these extra fields are observed, not a validated schema. The provider's Continue submission path remains unverified. A static lookalike control would imply an interaction ChatBBC cannot prove.

## Verification

- On the 2.1.20 baseline, `npm test -- --run test/renderer-html.test.ts` failed for a recorded-shape widget and a streaming/unknown widget before the fix, then passed 21/21 after the first renderer change.
- After integrating the already published 2.1.20 branch, the same two tests failed before the port and passed with the current renderer. A separate HTML-expansion budget regression failed before its fallback fix and passed 22/22 afterward.
- `npm test -- --run test/renderer-html.test.ts test/rich-response-renderer.test.ts` passed 51/51 before the additional budget regression; `npm run typecheck` passed on that revision.
- Chromium/Vite temporary fixture of the production renderer showed the card between the authored paragraphs, a closed source disclosure, and no live button/iframe/script; clicking disclosure exposed the exact marker, without running the embedded script. The fixture and server were removed. It is not signed-in ChatGPT or installed-app evidence.
- Review-driven regressions exposed four neighboring failures: expanded HTML hid prose, dense references allocated a card per marker before budget checking, a blank line leaked the latter half of JSON, and the second disclosure lost open/focus state on revision. Each failed before its corresponding correction. `renderer-html` now passes 24/24; focused timeline disclosure test passes 1/1.
- `npm run typecheck` passed and `npm run build` produced main, preload and renderer bundles; Vite reported only existing mixed static/dynamic import warnings.
- A fresh Chromium/Vite fixture on the final renderer showed the closed card between “Before the picker” and “After the picker.” Opening it exposed the exact marker, with zero live buttons/iframes/scripts and `globalThis.pwned` still false. The temporary fixture and server were removed.
- The nearest renderer/rich/timeline suites passed 267/267 after the final change. The first full `npm run verify` stopped at notices because this workstation lacked the locked `@janhapke/sharp-electron` package (`npm ls` confirmed it). After `npm ci`, `npm run verify` passed privacy, notices, native-source checks, typecheck, Electron resolution, 6,120 tests (136 skipped), and the separate shutdown suite's six tests.
- `npm run dist:dir:linux:x64` assembled the Linux x64 unpacked runtime; `node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64` verified 2.1.21, Electron 44.3.0, Sharp/vips decode, PTY and tree-sitter. Packaging regenerated an x64-only local notice inventory; the tracked cross-architecture notice file was restored unchanged.
- A read-only relay attempt targeting a signed-in ChatGPT tab timed out; there was no real provider-page or installed-GUI interaction test. Source, Chromium fixture, tests, build and unpacked payload are separate evidence levels. Tag-scoped publication remains pending.
