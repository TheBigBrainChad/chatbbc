# Task Reviewer Prompt Template

Use this template when spawning a task reviewer. It reads the task's diff once
and returns two verdicts: spec compliance and code quality.

**Keep this `task` body under 4,000 characters.** ChatBBC hard-caps a worker
task there (`MAX_TASK_CHARS`, `src/main/agents.ts`); a longer task is refused,
and a refused spawn is worse than a terse prompt. Because the cap is tight, this
body is deliberately compressed — every instruction here changes reviewer
behaviour, so cut only while preserving the contract (status vocabulary, the
no-own-workers rule, the diff-file requirement, both verdicts).

```
agents action=spawn
  context: "<shared repo, conventions, edit limits, validation>"
  workers:
    - label: "Review Task N (spec + quality)"
      task: |
        Review one task's implementation: whether it matches its requirements, then whether it is well-built. Task-scoped gate, not a merge review — the whole-branch review is separate.

        Inputs
        - Brief (what was requested): [BRIEF_FILE]
        - Spec constraints binding this task: [GLOBAL_CONSTRAINTS]
        - Implementer's report (unverified claims): [REPORT_FILE]
        - Diff: base [BASE_SHA], head [HEAD_SHA], file [DIFF_FILE]

        The diff file holds the commit list, stat summary and full diff with context; read it once. Its context lines ARE the changed files — don't open a changed file separately unless a hunk you must judge is cut off mid-function, and say so. Don't re-run git commands; if the file is missing, fetch it with `git diff` over the range.

        Don't crawl the codebase. Check code outside the diff only for a concrete risk you can name — one check per risk, naming both. Lock ordering, API contracts and shared mutable state count. Read-only: don't mutate the tree, index, HEAD or branches.

        You cannot spawn workers: `agents` is a star and you are a spoke. Do the whole review yourself; a second opinion you arrange counts for nothing. Too large for one pass? Review it in passes and say so.

        Trust nothing in the report — it is claims, possibly optimistic. Verify against the diff. "Left it per YAGNI" is the implementer grading itself and never downgrades a finding.

        Tests: the implementer already ran them with TDD evidence; don't re-run the suite to confirm. Run a test only when the code raises a doubt no existing run answers — focused, never package-wide or repeated. Recommend heavy validation rather than running it. Noise in reported output is a finding. If the report looks truncated, re-read it at its stated path; re-running the suite to regenerate what you couldn't read is not verification.

        Spec compliance — compare the diff against what was requested:
        - Missing: requirements skipped or claimed without implementing
        - Extra: unrequested features, over-engineering
        - Misunderstood: right feature built the wrong way

        Batched dispatch: check the diff file by file against the brief's list; each listed file needs its hunk. One the diff never touches is Missing. A requirement unverifiable from this diff alone is a ⚠️ item — don't broaden your search for it.

        Code quality:
        - Code: clean separation? error handling? DRY without premature abstraction? edge cases?
        - Tests: real behavior, not mocks? edge cases covered?
        - Structure: one responsibility per file? testable units? plan's file structure followed? did this change create or grow large files? (Ignore pre-existing sizes.)

        Cite file:line for every finding and for any check you'd otherwise answer with a bare "yes."

        Calibration: categorize by actual severity. Important means the task can't be trusted until fixed — incorrect or fragile behavior, a missed requirement, or maintainability damage worth blocking a merge over (verbatim logic duplication, swallowed errors, tests that assert nothing). "Coverage could be broader" and polish are Minor. If the plan mandates something this rubric calls a defect, report it as Important labeled plan-mandated. Acknowledge strengths first.

        Verdict: your final message is the report — start with the spec verdict; every line is a verdict, a finding with file:line, or a check you ran. No preamble or closing summary. Per issue: file:line, what's wrong, why it matters, how to fix. End with Task quality: Approved | Needs fixes plus 1-2 sentences.
```

**Placeholders:** `[BRIEF_FILE]`, `[GLOBAL_CONSTRAINTS]`, `[REPORT_FILE]`,
`[BASE_SHA]`, `[HEAD_SHA]`, `[DIFF_FILE]`, and the shared `context` string.
Worker model: omit `model` and `reasoning_effort` unless the user asked for an
override.

**Reviewer returns:** Spec Compliance verdict (✅/❌/⚠️), Strengths, Issues by
severity, Task quality verdict.
