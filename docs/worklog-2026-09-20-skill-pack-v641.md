# Skill pack v6.4.1 refresh — 2026-09-20

Pinned the bundled `obra/superpowers` pack from v6.3.0 (`b36e0829`) to release
v6.4.1 (`5bf4e78011075bcfc0dc295f0724994cd123ee71`, 2026-09-18). Still fourteen
skills. Not installed, not packaged, not a live ChatGPT skill-invocation check.

## What landed

- `executing-plans` is now the native/inline loop: continuous execution, durable
  SDD ledger, TDD per task, one whole-branch review at the end. Helper scripts
  `task-start` and `task-done` ship under `executing-plans/scripts/`.
- SDD workspace collision markers, review-package range guards, writing-plans
  Review Focus, brainstorming shared-understanding/approval gates, and the
  reviewer “spec is a vision document” block came along from the release.
- ChatBBC boundaries kept: slash commands, `update_plan`, `read`/`apply_patch`/
  `exec_command`, star-topology workers, no `using-superpowers/references/`, no
  visual companion server.
- `diagnosing-superpowers` is excluded and named in `PROVENANCE.md` and
  `AGENTS.md` §6. It hunts another harness’s session transcripts.

## Checks

- TDD: `pins the reviewed upstream release…` failed on v6.3.0 provenance, then
  passed after the cutover (`test/skill-pack-content.test.ts` +
  `test/skill-pack.test.ts`: 16 passed).
- Pressure, five smol runs of the six-task inline scenario:
  - without the skill: in-session todos, mixed review timing, some
    “should I continue?” only on blockers.
  - with v6.4.1 `executing-plans`: ledger + `update_plan`, no between-task
    check-ins, TDD completion contract, one end-of-branch review.
- Helper smoke in a throwaway git repo: `sdd-workspace`, `task-start`,
  `task-done` (fail does not ledger; pass does), `review-package`.

No `npm run verify`, no package, no install.
