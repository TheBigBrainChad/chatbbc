# Scoped Re-Review Prompt Template

Use this template when spawning a re-review after a fix round. The
re-reviewer verifies the findings were addressed and checks the fix diff for
new breakage. It is not a fresh review — the full review already happened.

**Purpose:** Verify each finding from the previous review was addressed, and
that the fix itself broke nothing.

**Keep this `task` body under 4,000 characters** — ChatBBC's hard cap per worker
task (`MAX_TASK_CHARS`, `src/main/agents.ts`). This body fits today; a re-vendor
must not push it over, and a long `[FINDINGS]` list counts toward the limit.

```
agents action=spawn
  context: "<shared repo, conventions, edit limits, validation>"
  workers:
    - label: "Re-review Task N fix round R"
      task: |
        You are re-reviewing one task's fix round. A previous review produced
        findings; an implementer has attempted to fix them. Your job is to
        verdict each finding and inspect the fix diff — nothing else.

        ## The Task

        Read the task brief: [BRIEF_FILE]

        ## The Findings Under Verification

        [FINDINGS]

        ## The Fix

        Read the implementer's report (fix reports are appended at the end):
        [REPORT_FILE]

        **Fix base:** [FIX_BASE_SHA] (the head the previous review saw)
        **Head:** [HEAD_SHA]
        **Diff file:** [DIFF_FILE]

        Read the diff file once — it contains the fix commits, a stat summary,
        and the fix diff with surrounding context. Do not re-run git commands.
        If the diff file is missing, fetch the diff yourself:
        `git diff --stat [FIX_BASE_SHA]..[HEAD_SHA]` and
        `git diff [FIX_BASE_SHA]..[HEAD_SHA]`.

        Your review is read-only on this checkout. Do not mutate the working
        tree, the index, HEAD, or branch state in any way.

        ## You Cannot Spawn Workers

        ChatBBC workers cannot create workers — the `agents` tool is a star,
        and you are a spoke. Do all of this review yourself, and never look
        for a way to delegate part of it. The prime already owns every review
        seat this work gets, so a second opinion you arrange for yourself
        duplicates one of them at full cost and its verdict counts for
        nothing. If the diff feels too large for one pass, review it in
        passes yourself and say so in your report.

        ## Scope

        Your scope is the findings list and the fix diff. Verdict every finding.
        Inspect the fix diff for new problems the fix itself introduced. Do NOT
        re-review code the fix did not touch: if you notice an issue entirely
        outside the fix diff, report it under Out-of-Scope Observations — it
        does not block this task and does not extend the loop. A broad
        whole-branch review happens after all tasks are complete.

        ## Tests

        The implementer re-ran the tests covering the amended code and appended
        the results to the report file. Treat the report as unverified claims:
        confirm the fix report names the covering tests and shows their output,
        and verify the claims against the diff. Do not re-run the suite to
        confirm their report. Run a test only when reading the code raises a
        specific doubt that no existing run answers — and then a focused test,
        never a package-wide suite.

        ## Output Format

        Your final message is the report itself: begin directly with the first
        finding's verdict. Every line is a verdict, a finding with file:line,
        or a check you ran — no preamble, no process narration.

        ### Finding Verdicts

        For each finding in The Findings Under Verification, in order:
        - **[finding one-liner]** — ADDRESSED | NOT ADDRESSED, with file:line
          evidence. "Attempted" is not addressed: the specific defect must no
          longer exist.

        ### New Breakage in the Fix Diff

        Anything the fix itself broke or introduced, with severity
        (Critical/Important/Minor) and file:line. "None" if clean.

        ### Out-of-Scope Observations

        Issues you noticed entirely outside the fix diff. Non-blocking; the
        prime ledgers these for the final review. "None" if none.

        ### Verdict

        **Fix round:** [All findings addressed, no new Critical/Important
        breakage | Findings remain open] — list the open ones.
```

**Placeholders:**
- Worker model — omit `model` and `reasoning_effort` unless the user asked
  for an override; scoped re-reviews of small fix diffs need no special tier
- `[BRIEF_FILE]` — the task brief file (same file the implementer worked from)
- `[FINDINGS]` — the Critical/Important findings and spec gaps from the
  previous review, copied verbatim, one per bullet
- `[REPORT_FILE]` — the implementer's report file (fix reports appended)
- `[FIX_BASE_SHA]` — the head the previous review saw
- `[HEAD_SHA]` — current commit
- `[DIFF_FILE]` — the path `scripts/review-package PLAN_FILE FIX_BASE HEAD` printed

**Re-reviewer returns:** per-finding verdicts (ADDRESSED / NOT ADDRESSED),
new breakage in the fix diff, out-of-scope observations, and a round verdict.
