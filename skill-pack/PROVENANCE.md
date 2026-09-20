# Skill pack provenance

Vendored from **obra/superpowers** at commit `5bf4e78011075bcfc0dc295f0724994cd123ee71`
(2026-09-18, release v6.4.1). MIT licensed; see `LICENSE` in this directory and
`docs/licenses/superpowers/LICENSE`.

## What was changed

The upstream prose addresses a different agent harness. Every shipped file has been adapted to
ChatBBC's tool surface: skill references use ChatBBC slash commands, `TodoWrite` becomes
`update_plan`, file and shell tools are named as ChatBBC exposes them, and subagent guidance
accounts for ChatBBC's star-topology worker model. `systematic-debugging`,
`subagent-driven-development` and `dispatching-parallel-agents` were partly rewritten rather
than substituted, because their original instructions assume local code subagents that ChatBBC
does not have.

v6.4.1's native `executing-plans` loop is kept: continuous execution, a durable ledger, TDD
per task, and one whole-branch review at the end. Helper scripts under `executing-plans/scripts`
and `subagent-driven-development/scripts` ship as inert resources. ChatBBC never auto-runs them;
the executor invokes them through `exec_command` when Command permission is on.

## What was excluded

Upstream's own test fixtures (`test-pressure-*.md`, `test-academic.md`, `CREATION-LOG.md`) and
harness-specific material that cannot execute here: the brainstorming visual-companion server
and its helper scripts, and `using-superpowers/references/` per-platform harness notes.

`diagnosing-superpowers` is not shipped. It locates another harness's session transcripts,
dispatches analyst subagents against those files, and files upstream GitHub issues. ChatBBC
sessions live under Electron userData and are not that transcript layout; including the skill
would send the model looking for paths and tools that do not exist here.

Scripts and assets remain inert resources and are never executed by ChatBBC itself.

## Refreshing

To move to a newer upstream release, diff against the new tag, re-apply the adaptation, and
update this file's commit and release line. Do not copy files verbatim: the unadapted text
tells the model to call tools that do not exist.
