---
name: using-superpowers
description: Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions
---

<WORKER-STOP>
If you are a worker spawned for a specific task, ignore this skill.
</WORKER-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action** — including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to use it.

**Before entering plan mode:** if you haven't already brainstormed, invoke the brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, put one step per item in `update_plan`.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills carry it out. Brainstorming and systematic-debugging are the most common process skills, but the rule holds for any of them.

- "Let's build X" → /brainstorming first, then implementation skills.
- "Fix this bug" → /systematic-debugging first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |

## ChatBBC Adaptation

This skill library runs inside ChatBBC. Upstream wording that addresses other harnesses has
been translated to ChatBBC's surface:

- Naming another skill: write its ChatBBC command, for example `/brainstorming` rather than a
  namespaced reference. Commands are selected from the composer's `/` menu and appear as
  removable chips.
- Planning: `update_plan`, which displays a progress plan. It does not execute work.
- Subagents: the `agents` tool. Note that ChatBBC workers are separate browser ChatGPT
  conversations in a star topology — they report to their prime and **cannot** create their
  own workers. Do not assume the parallel-fan-out shapes described for local code subagents.
- Files: `read` reads and `apply_patch` writes. Commands and search: `exec_command`,
  `write_stdin` and `find`.
- Permission is enforced by ChatBBC, not by prose. A capability the user has not granted is
  refused by the app; do not attempt to work around it.

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
