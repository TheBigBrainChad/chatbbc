# Skill pack provenance

Vendored from **obra/superpowers** at commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`
(2026-08-12, release v6.3.0). MIT licensed; see `LICENSE` in this directory and
`docs/licenses/superpowers/LICENSE`.

## What was changed

The upstream prose addresses a different agent harness. Every shipped file has been adapted to
ChatBBC's tool surface: skill references use ChatBBC slash commands, `TodoWrite` becomes
`update_plan`, file and shell tools are named as ChatBBC exposes them, and subagent guidance
accounts for ChatBBC's star-topology worker model. `systematic-debugging`,
`subagent-driven-development` and `dispatching-parallel-agents` were partly rewritten rather
than substituted, because their original instructions assume local code subagents that ChatBBC
does not have.

## What was excluded

Upstream's own test fixtures (`test-pressure-*.md`, `test-academic.md`, `CREATION-LOG.md`) and
harness-specific material that cannot execute here: the brainstorming visual-companion server
and its helper scripts, and every `.sh`/`.js` helper. Scripts and assets remain inert resources
and are never executed by ChatBBC.

## Refreshing

To move to a newer upstream release, diff against the new tag, re-apply the adaptation, and
update this file's commit and release line. Do not copy files verbatim: the unadapted text
tells the model to call tools that do not exist.
