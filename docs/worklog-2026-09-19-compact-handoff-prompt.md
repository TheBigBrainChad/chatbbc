# Compact handoff prompt — 2026-09-19

The Compact & Resume prompt explicitly required a 10,000–30,000-token “lossless operational compression,” treated roughly 6,000 tokens as normally too short, and asked the model to use its answer budget aggressively. This made the handoff generation itself large and unreliable. The replacement-message transport is bounded separately, so maximizing the brief added risk without adding durable state ownership.

`src/main/session/handoff-prompt.ts` now requests a compact 1,500–3,000-token operational handoff with a hard 4,000-token maximum. It retains the final user requirements, evidence boundary, exact continuation-critical identifiers, dirty-tree/process/delegation hazards, unresolved failure chains and ordered next actions. It removes duplicated chronology and raw transcripts. When Superpowers is active, the brief names the exact skill/workflow, spec, plan, worktree and `.superpowers/sdd/.../progress.md` paths plus the current task/fix round; the replacement reads those durable artifacts and verifies the ledger/git history instead of receiving copied plans and specs.

Capture floors, legacy storage limits and wire safety bounds are unchanged. Their comments, the extension text-retention comment and `AGENTS.md` §15 now distinguish the compact semantic budget from backward-compatible transport/history capacity. `test/session.test.ts` covers the bounded prompt, final-requirement and evidence contracts, Superpowers artifact references, and removal of the old 10,000–30,000-token target.

Verification:
- TDD red: the new prompt contract failed because the generated prompt was 5,952 characters and still carried the old budget.
- Focused contract test passed after the change: 1 passed, 159 skipped.
- `test/session.test.ts` + `test/resume.test.ts`: 182 passed.
- `test/mcp-shutdown.test.ts`: 6 passed.
- `npm run verify`: privacy, notices, typecheck, Electron resolution and 5,126 tests passed; the command stopped on the existing unrelated `test/tunnel.test.ts` executable-hint expectation (`locateBinary('tunnel-client', blocked)` returned the bundled fallback instead of `null`). This subsystem was not edited. The separately excluded shutdown suite then passed as recorded above.
- Read-only code review found no Critical or Important issues. Its one Minor test-coverage request was applied, and two stale comments it identified were updated.

The changed source was not installed into the running app and no signed-in ChatGPT Compact & Resume flow was exercised. Live provider behavior therefore remains unverified.
