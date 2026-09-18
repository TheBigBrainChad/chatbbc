# ChatBBC Skill Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Jesse Vincent's 14 `obra/superpowers` skills as a bundled, app-owned pack in ChatBBC, with per-skill enable/implicit control, a Settings library page, and prose adapted to ChatBBC's real tool surface.

**Architecture:** A tracked top-level `skill-pack/` directory ships as an extraResource and is mirrored (with provenance tracking) into the existing managed skill library at `<userData>/skills/<id>/`. A new `state/skills.json` owner records what the app seeded, what the user toggled, and what the user removed. The existing catalog, `/` completion, chips and prompt fitter carry the content unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Electron main + renderer, Node `fs.promises`, Vitest, `electron-builder`, `js-yaml`/`smol-toml` (already present via `skill-metadata.ts`).

**Spec:** `docs/superpowers/specs/2026-09-18-chatbbc-skill-pack-design.md`

## Global Constraints

- **Product name is exactly `ChatBBC`.** No `CoS`, `BBC`, `CBBC`. Historical `CHANGELOG.md` entries and `LICENSE` stay untouched.
- **Do not regenerate `THIRD-PARTY-NOTICES.txt` by hand.** It is produced by `node scripts/generate-third-party-notices.mjs`; edit the generator and run it.
- **Never add `Co-Authored-By` or "Generated with" lines to commits.** Attribution for the vendored MIT content lives in `docs/licenses/superpowers/LICENSE` and `skill-pack/PROVENANCE.md`, not in git trailers.
- **Run `npm run verify:privacy` before every commit.**
- **Never pass `--no-verify`.**
- **Internal prefixes stay:** `CLF_*`, `COS_CONTEXT`, bridge ports 8765–8769, session dir shape.
- **Platform focus is Linux.** Add no Windows/macOS-only code path. Do not delete existing platform tests or native projects.
- **Existing limits are load-bearing:** `MAX_SKILL_BYTES = 128_000`, `MAX_SKILL_CHARS = 96_000`, `MAX_SKILLS = 64`, `SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/`, `MAX_LIBRARY_ENTRIES = 256`.
- **`resources/` is gitignored build staging.** The pack must live at a tracked top-level path.
- **Electron fixtures on this machine require:** `--ozone-platform=x11 --disable-gpu --in-process-gpu`.
- **Backwards compatibility:** an absent `state/skills.json` must behave exactly like today — every skill enabled, discovery unchanged.

---

### Task 1: Vendor and adapt the skill pack

This task has no runtime code. Its deliverable is a tracked content directory whose every file passes an automated content test. The adaptation is mechanical except for two skills, which are rewritten below in full.

**Files:**
- Create: `skill-pack/<id>/SKILL.md` and listed companion files (see manifest)
- Create: `skill-pack/LICENSE`
- Create: `skill-pack/PROVENANCE.md`
- Create: `docs/licenses/superpowers/LICENSE`
- Test: `test/skill-pack-content.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the on-disk pack consumed by Task 3. Every skill id is a valid `SKILL_ID_PATTERN` match. The pack root is `skill-pack/`; each skill is `skill-pack/<id>/` containing a `SKILL.md`.

- [ ] **Step 1: Fetch the pinned upstream tree**

```bash
cd /tmp && rm -rf sp-vendor && mkdir sp-vendor && cd sp-vendor
curl -sfL https://github.com/obra/superpowers/archive/b36e0829c6d0140e93cfef2ca599b1b07d4a7797.tar.gz -o sp.tgz
tar xzf sp.tgz
ls superpowers-b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills
```

Expected: 16 skill directories. All 51 files in this tree are byte-identical to the currently installed copies in `~/.agents/skills`, so either source may be used — the pinned commit is authoritative.

- [ ] **Step 2: Copy the manifest, nothing else**

From the unpacked tree's `skills/`, copy into the repo's `skill-pack/`:

| Skill id | Copy these | Exclude |
|---|---|---|
| `using-superpowers` | `SKILL.md` | `references/` |
| `brainstorming` | `SKILL.md`, `spec-document-reviewer-prompt.md` | `visual-companion.md`, `scripts/` |
| `writing-plans` | `SKILL.md`, `plan-document-reviewer-prompt.md` | — |
| `executing-plans` | `SKILL.md` | — |
| `subagent-driven-development` | `SKILL.md`, `implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`, `scripts/sdd-workspace`, `scripts/task-brief`, `scripts/review-package` | — |
| `test-driven-development` | `SKILL.md`, `writing-good-tests.md` | — |
| `systematic-debugging` | `SKILL.md`, `condition-based-waiting.md`, `condition-based-waiting-example.ts`, `defense-in-depth.md`, `root-cause-tracing.md` | `CREATION-LOG.md`, `test-*.md`, `find-polluter.sh` |
| `using-git-worktrees` | `SKILL.md` | — |
| `dispatching-parallel-agents` | `SKILL.md` | — |
| `requesting-code-review` | `SKILL.md`, `code-reviewer.md` | — |
| `receiving-code-review` | `SKILL.md` | — |
| `verification-before-completion` | `SKILL.md` | — |
| `finishing-a-development-branch` | `SKILL.md` | — |
| `writing-skills` | `SKILL.md`, `persuasion-principles.md`, `testing-skills-with-subagents.md` | `anthropic-best-practices.md`, `examples/`, `graphviz-conventions.dot`, `render-graphs.js` |

Excluded files are either upstream's own test fixtures (`test-pressure-*.md`, `test-academic.md`, `CREATION-LOG.md`) or material that cannot execute in ChatBBC — chiefly the brainstorming visual-companion server (`scripts/server.cjs`, `start-server.sh`, `stop-server.sh`, `helper.js`, `frame-template.html`) and `systematic-debugging/find-polluter.sh`.

**Three `subagent-driven-development` scripts are included**, because its kept prose calls them by name (`sdd-workspace`, `task-brief`, `review-package`). They are portable POSIX bash that run through `exec_command`, and they produce the plan-scoped briefs and review packages the workflow depends on. Excluding them would leave live instructions pointing at absent files. `using-superpowers/references/` is excluded because the Platform Adaptation section that referenced it is replaced wholesale in Step 4 — but two other files still link into it, so the guard test in Step 5 checks every relative reference resolves.

Two skills named in the upstream README — `find-skills` and `computer-use` — are out of scope entirely.

- [ ] **Step 3: Apply the mechanical adaptation**

Substitution alone cannot finish this job, but it removes the bulk of it. Create
`scripts/adapt-skill-pack.mjs` — it is a **one-time migration tool**, kept in the repo so the
transformation is reviewable and re-runnable on a future upstream release:

```js
// scripts/adapt-skill-pack.mjs
/**
 * One-time adaptation of the vendored obra/superpowers pack to ChatBBC's tool surface.
 *
 * Two things must NOT be touched. The `.superpowers/` directory name is the SDD workspace path
 * (`.superpowers/sdd/<plan>/`), not a namespace reference — rewriting it would break the layout
 * subagent-driven-development describes. And `obra/superpowers` is a repository URL.
 *
 * This runs once; the result is committed. Re-run it after re-vendoring a newer upstream tag,
 * then review the diff by hand, because blanket substitution produces awkward prose.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const pack = path.resolve(process.argv[2] ?? 'skill-pack');
const SKILLS = ['brainstorming', 'dispatching-parallel-agents', 'executing-plans',
  'finishing-a-development-branch', 'receiving-code-review', 'requesting-code-review',
  'subagent-driven-development', 'systematic-debugging', 'test-driven-development',
  'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills'];

// Order matters: the namespace rule must run before the bare-word rule, or `superpowers:x`
// becomes `the skill library:x`.
const RULES = [
  [/superpowers:([a-z0-9-]+)/g, '/$1'],
  [/\bSuperpowers\b/g, 'the skill library'],
  [/\bTodoWrite\b/g, 'update_plan'],
  [/\bClaude Code\b/g, 'ChatBBC'],
  [/\bClaude\b/g, 'ChatGPT'],
  [/\bAnthropic\b/g, 'the model provider'],
  [/`Bash`/g, '`exec_command`'],
  [/`Read`/g, '`read`'],
  [/`Write`/g, '`apply_patch`'],
  [/`Edit`/g, '`apply_patch`'],
  [/`Grep`|`Glob`/g, '`find`'],
  [/\bthe Task tool\b|\bTask tool\b/g, 'the `agents` tool']
];

// Preserve these spans by masking them before substitution and restoring afterwards.
const PROTECTED = [/obra\/superpowers/g, /\.superpowers\//g, /docs\/superpowers\//g];

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

let changed = 0;
for (const id of SKILLS) {
  for await (const file of walk(path.join(pack, id))) {
    const original = await fs.readFile(file, 'utf8');
    const mask = [];
    let text = original.replace(new RegExp(PROTECTED.map(r => r.source).join('|'), 'g'),
      match => `\u0000${mask.push(match) - 1}\u0000`);
    for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
    text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => mask[Number(index)]);
    if (text !== original) { await fs.writeFile(file, text, 'utf8'); changed++; }
  }
}
console.log(`adapted ${changed} files in ${pack}`);
```

Run it:

```bash
node scripts/adapt-skill-pack.mjs
npx vitest run test/skill-pack-content.test.ts
```

Expected: a non-zero file count, then the foreign-vocabulary test still failing on any prose
the rules could not fix. Now re-read every file and repair the awkward sentences by hand —
`ChatBBC Code`, `the skill library:brainstorming` if a rule was missed, and any instruction
that still assumes a local code subagent. This hand pass is the part that cannot be automated;
budget real time for it.

- [ ] **Step 4: Rewrite the three skills that need real surgery**

These cannot be fixed by substitution. Replace the named sections with the text below.

**(a) `using-superpowers/SKILL.md`** — replace the entire `## Platform Adaptation` section (the list of Codex/Pi/Antigravity/Hermes reference files) with:

```markdown
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
```

**(b) `brainstorming/SKILL.md`** — delete the `## Visual Companion` section and the offer step, and delete step 2 ("Offer the visual companion just-in-time") from the Architectural checklist. Replace with:

```markdown
## Visuals

This pack ships no visual companion server. When a question would be clearer shown than
described, say so and use the browser and Desktop tools the user has enabled, or ask the user
to describe what they see. Do not promise a mockup surface that is not available.
```

Also change the checklist's Architectural item 2 to a no-op by renumbering, and remove the sentence in `Process Flow` that references the companion if present.

**(c) `systematic-debugging/SKILL.md`** — where it instructs running `find-polluter.sh`, replace with an instruction to bisect with `exec_command` and `cmds`, since the helper script is not shipped.

**(d) `subagent-driven-development/SKILL.md`** — replace its opening architecture section with:

```markdown
# Subagent-Driven Development

Dispatch independent units of work to separate agents, review each result before accepting it,
and keep the integration thread with you.

## How agents work in ChatBBC

The `agents` tool manages **worker conversations**, which are separate ChatGPT chats driven by
a browser tab. Understand three constraints before using them:

1. **Star topology.** A worker reports to the prime that spawned it. Workers cannot spawn
   workers. All fan-out is one level deep.
2. **Browser-bound.** Each worker needs an attached ChatGPT page. Spawning is not instant, and
   a worker can be asleep, detached or terminated.
3. **At-least-once messaging.** Reports and messages carry durable identities, so a retry does
   not duplicate work, but you must match a report to the assignment it answers.

Use `agents action=spawn` with a bounded objective, then `agents action=message` to send
follow-up work to an existing sleeping worker rather than spawning a replacement. `agents
action=finish` stores a report and parks the worker for reuse.

## Reviewing a worker's result

Before accepting a report, verify it against the repository rather than trusting the summary.
A report is a claim; the diff, the test output and the file contents are the evidence. If the
report claims a test passes, run it.
```

Keep the rest of the file's review discipline, translating its reviewer-step language to the `agents` tool.

**(e) `dispatching-parallel-agents/SKILL.md`** — replace its task-independence section with the star-topology constraint from (d), and state plainly that ChatBBC's practical parallelism is bounded by the user's configured worker cap (default 2 per prime family, hard max 8).

**(f) Repair the two dangling reference links.** The manifest excludes `using-superpowers/references/`, but two shipped files link into it. The guard test in Step 5 fails until both are fixed.

`executing-plans/SKILL.md` line 14 — replace the whole note with:

```markdown
**Note:** This workflow works much better with access to subagents. If they are available, use
`/subagent-driven-development` instead of this skill.
```

`writing-skills/SKILL.md` line 12 — replace the parenthetical about runtime directories with:

```markdown
**Personal skills live in ChatBBC's managed library at `<userData>/skills/<id>/SKILL.md`**, which
is also reachable as `/skills/<id>/SKILL.md`. Project skills are discovered from `.agents/skills`
and `.codex/skills` inside an approved root. See the Skills section in Settings for what is
installed and enabled.
```

- [ ] **Step 5: Write the content test**

```ts
// test/skill-pack-content.test.ts
import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SKILL_BYTES, MAX_SKILL_CHARS, SKILL_ID_PATTERN } from '../src/shared/skills.js';

const pack = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill-pack');

const EXPECTED = [
  'brainstorming', 'dispatching-parallel-agents', 'executing-plans',
  'finishing-a-development-branch', 'receiving-code-review', 'requesting-code-review',
  'subagent-driven-development', 'systematic-debugging', 'test-driven-development',
  'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills'
];

it('ships exactly the curated fourteen skills with valid ids', async () => {
  const entries = (await fs.readdir(pack, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  expect(entries).toEqual(EXPECTED);
  for (const id of entries) expect(SKILL_ID_PATTERN.test(id), id).toBe(true);
});

it('every SKILL.md has frontmatter, fits the admission limits, and is plain UTF-8', async () => {
  for (const id of EXPECTED) {
    const body = await fs.readFile(path.join(pack, id, 'SKILL.md'), 'utf8');
    expect(body.startsWith('---\n'), `${id} frontmatter`).toBe(true);
    expect(/^---\r?\n[\s\S]*?\r?\n---/m.test(body), `${id} frontmatter block`).toBe(true);
    expect(Buffer.byteLength(body, 'utf8'), `${id} bytes`).toBeLessThanOrEqual(MAX_SKILL_BYTES);
    expect(body.length, `${id} chars`).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(body), `${id} control chars`).toBe(false);
  }
});

it('carries no foreign harness vocabulary', async () => {
  const forbidden = [/\bsuperpowers:/, /\bClaude\b/, /\bTodoWrite\b/, /\bAnthropic\b/, /\bTask tool\b/];
  for (const id of EXPECTED) {
    const files = await fs.readdir(path.join(pack, id), { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const body = await fs.readFile(path.join(pack, id, entry.name), 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${id}/${entry.name} matches ${pattern}`).toBe(false);
      }
    }
  }
});

it('ships the upstream MIT licence verbatim', async () => {
  const licence = await fs.readFile(path.join(pack, 'LICENSE'), 'utf8');
  expect(licence).toContain('MIT License');
  expect(licence).toContain('Copyright (c) 2025 Jesse Vincent');
  expect(licence).toContain('WITHOUT WARRANTY OF ANY KIND');
});

it('every relative reference inside a shipped file resolves to a shipped file', async () => {
  // A skill that tells the model to open a file we did not ship is worse than one that omits the
  // step: the instruction looks authoritative and then cannot be followed. The manifest excludes
  // most of upstream's harness-specific material, so this check is the thing that keeps the
  // exclusions honest.
  const missing: string[] = [];
  for (const id of EXPECTED) {
    for await (const file of walk(path.join(pack, id))) {
      const body = await fs.readFile(file, 'utf8');
      // Relative markdown links and `backticked` sibling paths.
      const candidates = [
        ...[...body.matchAll(/\]\((\.{1,2}\/[^)\s#]+)/g)].map(match => match[1]!),
        ...[...body.matchAll(/`((?:\.{1,2}\/)?(?:references|scripts|examples)\/[A-Za-z0-9._/-]+)`/g)].map(match => match[1]!)
      ];
      for (const reference of candidates) {
        const resolved = path.resolve(path.dirname(file), reference);
        try { await fs.stat(resolved); }
        catch { missing.push(`${path.relative(pack, file)} -> ${reference}`); }
      }
    }
  }
  expect(missing).toEqual([]);
});
```

with this helper above the tests:

```ts
async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}
```

- [ ] **Step 6: Add the licence and provenance files**

```bash
curl -sfL https://raw.githubusercontent.com/obra/superpowers/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/LICENSE -o skill-pack/LICENSE
mkdir -p docs/licenses/superpowers
cp skill-pack/LICENSE docs/licenses/superpowers/LICENSE
```

Write `skill-pack/PROVENANCE.md`:

```markdown
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
```

- [ ] **Step 7: Run the content test**

Run: `npx vitest run test/skill-pack-content.test.ts`
Expected: 4 passed. If the foreign-vocabulary test fails, it names the exact file — fix that prose by hand rather than loosening the pattern.

- [ ] **Step 8: Commit**

```bash
git add skill-pack test/skill-pack-content.test.ts docs/licenses/superpowers
npm run verify:privacy
git commit -m "feat: vendor the superpowers skill pack, adapted to ChatBBC tools"
```

---

### Task 2: Own the durable skill state and policy resolution

**Files:**
- Create: `src/main/skill-state.ts`
- Test: `test/skill-state.test.ts`

**Interfaces:**
- Consumes: `readDurable`, `writeDurableNow` from `src/main/durable.ts`.
- Produces:
  - `interface SkillState { version: 1; seeded: Record<string, string>; enabled: Record<string, boolean>; implicit: Record<string, boolean>; removed: string[] }`
  - `interface SkillPolicy { enabled: boolean; implicit: boolean }`
  - `emptySkillState(): SkillState`
  - `sanitizeSkillState(raw: unknown): SkillState`
  - `currentSkillState(): SkillState`
  - `restoreSkillState(): Promise<void>`
  - `mutateSkillState(change: (state: SkillState) => SkillState): Promise<SkillState>`
  - `resolveSkillPolicy(id: string, declaration: boolean, external: boolean | undefined, state: SkillState): SkillPolicy`
  - `setSkillStateForTests(state: SkillState): void`

- [ ] **Step 1: Write the failing test**

```ts
// test/skill-state.test.ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  currentSkillState, emptySkillState, mutateSkillState, resolveSkillPolicy,
  restoreSkillState, sanitizeSkillState, setSkillStateForTests
} from '../src/main/skill-state.js';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillstate-');
  initDurableStore(root);
  setSkillStateForTests(emptySkillState());
});
afterEach(async () => { resetDurableForTests(); await removeTempDir(root); });

it('treats a missing state file as inherit-everything', async () => {
  await restoreSkillState();
  expect(currentSkillState()).toEqual(emptySkillState());
  expect(resolveSkillPolicy('brainstorming', true, undefined, currentSkillState()))
    .toEqual({ enabled: true, implicit: true });
});

it('refuses a malformed state file instead of trusting it', () => {
  const state = sanitizeSkillState({
    version: 99,
    seeded: { good: 'a'.repeat(64), bad: 5 },
    enabled: { good: 'yes', other: false },
    implicit: { other: true },
    removed: ['gone', 7, 'gone']
  });
  expect(state.seeded).toEqual({ good: 'a'.repeat(64) });
  expect(state.enabled).toEqual({ other: false });
  expect(state.implicit).toEqual({ other: true });
  expect(state.removed).toEqual(['gone']);
});

it('lets an explicit app choice beat an external rule, which beats the default', () => {
  const state = { ...emptySkillState(), enabled: { a: true, b: false } };
  // Explicit app on, even though an external rule and declaration say off.
  expect(resolveSkillPolicy('a', false, false, state).enabled).toBe(true);
  // Explicit app off, even though an external rule says on.
  expect(resolveSkillPolicy('b', true, true, state).enabled).toBe(false);
  // No app choice: the external rule decides.
  expect(resolveSkillPolicy('c', true, false, state).enabled).toBe(false);
  expect(resolveSkillPolicy('c', true, true, state).enabled).toBe(true);
  // No app choice and no rule: default on.
  expect(resolveSkillPolicy('d', true, undefined, state).enabled).toBe(true);
});

it('resolves implicit invocation from the app choice, then the skill declaration', () => {
  const state = { ...emptySkillState(), implicit: { a: false, b: true } };
  expect(resolveSkillPolicy('a', true, undefined, state).implicit).toBe(false);
  expect(resolveSkillPolicy('b', false, undefined, state).implicit).toBe(true);
  expect(resolveSkillPolicy('c', false, undefined, state).implicit).toBe(false);
  expect(resolveSkillPolicy('c', true, undefined, state).implicit).toBe(true);
});

it('defaults implicit invocation off for packed skills that declare nothing', () => {
  // The caller passes the declaration; a pack skill with no agents/openai.yaml passes false.
  expect(resolveSkillPolicy('x', false, undefined, emptySkillState()).implicit).toBe(false);
});

it('serializes mutations and publishes only after the durable write', async () => {
  await mutateSkillState(state => ({ ...state, enabled: { ...state.enabled, a: false } }));
  await mutateSkillState(state => ({ ...state, implicit: { ...state.implicit, a: true } }));
  const stored = await readDurable<{ enabled: Record<string, boolean>; implicit: Record<string, boolean> }>('skills');
  expect(stored?.enabled).toEqual({ a: false });
  expect(stored?.implicit).toEqual({ a: true });
  expect(currentSkillState().enabled).toEqual({ a: false });
});

it('drops a mutation that returns an invalid state rather than writing it', async () => {
  await expect(mutateSkillState(() => ({ version: 3 } as never))).rejects.toThrow(/state/i);
  expect(await readDurable('skills')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/skill-state.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/skill-state.js"`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * The app's own record of the bundled Skill pack and the user's choices about it.
 *
 * Two things must not diverge, so they share one serialized owner: provenance (which files
 * this app wrote, so an upgrade can refresh them without destroying a user's edit) and
 * tombstones (which skills the user deleted, so a seed never resurrects them).
 *
 * Enablement deliberately does not live in `config.json`. The renderer's settings save is a
 * field-wise `{base, patch}` merge, which is correct for scalar fields and wrong for a map:
 * toggling one skill would rewrite the whole map from a stale base and clobber a concurrent
 * toggle of another skill.
 */

import { readDurable, writeDurableNow } from './durable.js';
import { logWarn } from './logger.js';

export interface SkillState {
  version: 1;
  /** Skill id -> sha256 of the directory contents this app last wrote. */
  seeded: Record<string, string>;
  /** User enablement. Absent means inherit. */
  enabled: Record<string, boolean>;
  /** User implicit-invocation choice. Absent means inherit. */
  implicit: Record<string, boolean>;
  /** Bundled ids the user removed. Never re-seeded. */
  removed: string[];
}

export interface SkillPolicy {
  enabled: boolean;
  implicit: boolean;
}

export const SKILL_STATE = 'skills';
const MAX_IDS = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function emptySkillState(): SkillState {
  return { version: 1, seeded: {}, enabled: {}, implicit: {}, removed: [] };
}

function booleanMap(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (ID.test(key) && typeof entry === 'boolean' && Object.keys(result).length < MAX_IDS) result[key] = entry;
  }
  return result;
}

/** Malformed input is discarded field by field. A bad file must not widen authority. */
export function sanitizeSkillState(raw: unknown): SkillState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptySkillState();
  const source = raw as Record<string, unknown>;
  const state = emptySkillState();
  if (source.version !== 1) return state;
  if (source.seeded !== null && typeof source.seeded === 'object' && !Array.isArray(source.seeded)) {
    for (const [key, entry] of Object.entries(source.seeded as Record<string, unknown>)) {
      if (ID.test(key) && typeof entry === 'string' && DIGEST.test(entry) && Object.keys(state.seeded).length < MAX_IDS) {
        state.seeded[key] = entry;
      }
    }
  }
  state.enabled = booleanMap(source.enabled);
  state.implicit = booleanMap(source.implicit);
  if (Array.isArray(source.removed)) {
    for (const entry of source.removed) {
      if (typeof entry === 'string' && ID.test(entry) && !state.removed.includes(entry) && state.removed.length < MAX_IDS) {
        state.removed.push(entry);
      }
    }
  }
  return state;
}

let cache: SkillState = emptySkillState();
let operations: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = operations.then(work, work);
  operations = run.then(() => undefined, () => undefined);
  return run;
}

export function currentSkillState(): SkillState {
  return cache;
}

export function setSkillStateForTests(state: SkillState): void {
  cache = state;
}

export async function restoreSkillState(): Promise<void> {
  const stored = await readDurable<unknown>(SKILL_STATE);
  cache = sanitizeSkillState(stored);
}

/**
 * Applies one change and returns the published state. Serialized, so two toggles cannot
 * interleave a read and a write. The durable write happens before the cache advances.
 */
export function mutateSkillState(change: (state: SkillState) => SkillState): Promise<SkillState> {
  return serial(async () => {
    const next = sanitizeSkillState(change(cache));
    if (next.version !== 1) throw new Error('Refusing to store an invalid Skill state');
    await writeDurableNow(SKILL_STATE, next);
    cache = next;
    return next;
  });
}

/**
 * One decision point for whether a skill is used and whether the model may select it itself.
 *
 * Enablement: app choice, then an external discovery rule, then on. A skill's own metadata has
 * no enablement concept, so it contributes no layer here.
 * Implicit: app choice, then the skill's own `allow_implicit_invocation` declaration.
 */
export function resolveSkillPolicy(
  id: string,
  declaration: boolean,
  external: boolean | undefined,
  state: SkillState
): SkillPolicy {
  const chosen = state.enabled[id];
  const enabled = chosen !== undefined ? chosen : external !== undefined ? external : true;
  const chosenImplicit = state.implicit[id];
  return { enabled, implicit: chosenImplicit !== undefined ? chosenImplicit : declaration };
}

export function logSkillStateProblem(message: string): void {
  logWarn(`Skill pack: ${message}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/skill-state.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/skill-state.ts test/skill-state.test.ts
npm run verify:privacy
git commit -m "feat: own the durable Skill pack state and policy resolution"
```

---

### Task 3: Mirror the bundled pack into the managed library

**Files:**
- Create: `src/main/skill-pack.ts`
- Modify: `src/main/index.ts` (after `initDurableStore(userData)`, near line 324)
- Test: `test/skill-pack.test.ts`

**Interfaces:**
- Consumes: `SkillState`, `sanitizeSkillState` from Task 2; `readSkillTextSnapshot` from `src/main/skills.ts`.
- Produces:
  - `interface PackEntry { id: string; source: string; digest: string }`
  - `interface PackSyncResult { added: string[]; refreshed: string[]; preserved: string[]; skipped: string[]; errors: string[] }`
  - `bundledSkillPackRoot(): string | null`
  - `directoryDigest(directory: string): Promise<string>`
  - `readPackEntries(packRoot: string): Promise<{ entries: PackEntry[]; errors: string[] }>`
  - `syncSkillPack(options: { managedRoot: string; packRoot: string; state: SkillState }): Promise<{ result: PackSyncResult; seeded: Record<string, string> }>`

- [ ] **Step 1: Write the failing test**

```ts
// test/skill-pack.test.ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { emptySkillState } from '../src/main/skill-state.js';
import { directoryDigest, readPackEntries, syncSkillPack } from '../src/main/skill-pack.js';

let root: string, pack: string, managed: string;
const skill = (name: string, body = 'Body.') => `---\nname: ${name}\ndescription: A test skill for ${name}.\n---\n${body}`;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
const exists = async (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);

beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillpack-');
  pack = path.join(root, 'pack'); managed = path.join(root, 'managed');
  await write(path.join(pack, 'alpha', 'SKILL.md'), skill('Alpha'));
  await write(path.join(pack, 'beta', 'SKILL.md'), skill('Beta'));
  await write(path.join(pack, 'beta', 'reference.md'), 'Supporting bytes.');
  await fs.mkdir(managed, { recursive: true });
});
afterEach(async () => { await removeTempDir(root); });

it('seeds every packed skill into an empty library', async () => {
  const { result, seeded } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  expect(result.added.sort()).toEqual(['alpha', 'beta']);
  expect(result.errors).toEqual([]);
  expect(await fs.readFile(path.join(managed, 'alpha', 'SKILL.md'), 'utf8')).toBe(skill('Alpha'));
  expect(await fs.readFile(path.join(managed, 'beta', 'reference.md'), 'utf8')).toBe('Supporting bytes.');
  expect(Object.keys(seeded).sort()).toEqual(['alpha', 'beta']);
});

it('is a no-op when the managed copy still matches what we wrote', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  const second = await syncSkillPack({
    managedRoot: managed, packRoot: pack,
    state: { ...emptySkillState(), seeded: first.seeded }
  });
  expect(second.result.added).toEqual([]);
  expect(second.result.preserved).toEqual([]);
  expect(second.result.refreshed.sort()).toEqual(['alpha', 'beta']);
});

it('preserves a skill the user edited instead of overwriting it', async () => {
  const first = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  await write(path.join(managed, 'alpha', 'SKILL.md'), skill('Alpha', 'My own edit.'));
  const edited = await directoryDigest(path.join(managed, 'alpha'));
  const second = await syncSkillPack({
    managedRoot: managed, packRoot: pack,
    state: { ...emptySkillState(), seeded: first.seeded }
  });
  expect(second.result.preserved).toContain('alpha');
  expect(await fs.readFile(path.join(managed, 'alpha', 'SKILL.md'), 'utf8')).toBe(skill('Alpha', 'My own edit.'));
  // The stale provenance hash is retained, so the edit keeps being preserved next launch.
  expect(second.seeded.alpha).toBe(first.seeded.alpha);
  expect(edited).not.toBe(first.seeded.alpha);
});

it('never resurrects a skill the user removed', async () => {
  const { seeded } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  await fs.rm(path.join(managed, 'alpha'), { recursive: true });
  const { result, seeded: next } = await syncSkillPack({
    managedRoot: managed, packRoot: pack,
    state: { ...emptySkillState(), seeded, removed: ['alpha'] }
  });
  expect(result.skipped).toContain('alpha');
  expect(await exists(path.join(managed, 'alpha'))).toBe(false);
  expect(next.alpha).toBeUndefined();
  expect(result.refreshed).toContain('beta');
});

it('re-seeds a removed-then-reinstalled skill only once its tombstone is cleared', async () => {
  const { seeded } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  await fs.rm(path.join(managed, 'alpha'), { recursive: true });
  await syncSkillPack({ managedRoot: managed, packRoot: pack, state: { ...emptySkillState(), seeded, removed: ['alpha'] } });
  const cleared = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: { ...emptySkillState(), seeded } });
  expect(cleared.result.added).toContain('alpha');
  expect(await exists(path.join(managed, 'alpha', 'SKILL.md'))).toBe(true);
});

it('refuses a packed skill whose file is invalid and keeps the library intact', async () => {
  await fs.writeFile(path.join(pack, 'broken', 'SKILL.md').replace('/broken/', '/broken/'), '', 'utf8').catch(() => undefined);
  await write(path.join(pack, 'broken', 'SKILL.md'), '');
  const { result } = await syncSkillPack({ managedRoot: managed, packRoot: pack, state: emptySkillState() });
  expect(result.errors.join(' ')).toMatch(/broken/);
  expect(result.added.sort()).toEqual(['alpha', 'beta']);
  expect(await exists(path.join(managed, 'broken'))).toBe(false);
});

it('ignores pack entries whose names are not valid skill ids', async () => {
  await write(path.join(pack, 'Not An Id', 'SKILL.md'), skill('Bad'));
  const { entries } = await readPackEntries(pack);
  expect(entries.map(entry => entry.id).sort()).toEqual(['alpha', 'beta']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/skill-pack.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/skill-pack.js"`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Mirrors the bundled Skill pack into the managed library Chrome-free, on disk.
 *
 * The pack ships as a packaged resource, but the library must live at a stable path: on an
 * AppImage `process.resourcesPath` is a temporary mount that disappears when the app exits,
 * so `/skills/<id>/SKILL.md` could not be read on the next launch. Copying once at startup
 * gives discovery, `/` completion and `read` one ordinary directory to work with.
 *
 * Refresh is provenance-driven rather than unconditional. A skill the user has edited is
 * theirs; overwriting it on every launch would silently destroy work. The recorded digest
 * says what this app last wrote, so an unchanged file can be refreshed and a changed one
 * cannot.
 *
 * A crash mid-refresh is self-healing: the next launch sees the directory present but not
 * matching provenance, which is indistinguishable from a user edit, so the content is
 * preserved rather than half-replaced. Copying is therefore a plain write, not a transaction.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { app } from 'electron';
import { SKILL_ID_PATTERN } from '../shared/skills.js';
import { readSkillTextSnapshot } from './skills.js';
import type { SkillState } from './skill-state.js';

export const SKILL_PACK_DIR = 'skill-pack';
const SKILL_FILENAME = 'SKILL.md';
const MAX_PACK_ENTRIES = 256;

export interface PackEntry {
  id: string;
  source: string;
  digest: string;
}

export interface PackSyncResult {
  added: string[];
  refreshed: string[];
  preserved: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Where the pack ships, or null when it is not present in this build.
 *
 * Each candidate is checked for existence rather than assumed: a dev run may have the pack in
 * the checkout but not beside Electron's own resources, and a packaged run has the opposite.
 * Returning an unverified path would make the first candidate silently win and the pack look
 * empty instead of absent.
 */
export function bundledSkillPackRoot(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, SKILL_PACK_DIR)]
    : [path.join(app.getAppPath(), SKILL_PACK_DIR), path.join(process.cwd(), SKILL_PACK_DIR)];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * One digest over the whole skill directory. Hashing every file, not just SKILL.md, means an
 * edit to a companion file is preserved too — the user's intent is "I changed this skill".
 */
export async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (dir: string, relativeDir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported skill entry: ${relative}`);
      }
    }
  };
  await visit(directory, '');
  return hash.digest('hex');
}

/** Validates each candidate before it can become part of the library. */
export async function readPackEntries(packRoot: string): Promise<{ entries: PackEntry[]; errors: string[] }> {
  const entries: PackEntry[] = [];
  const errors: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(packRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (error) {
    return { entries, errors: [`pack unreadable: ${(error as Error).message}`] };
  }
  for (const id of names) {
    if (!SKILL_ID_PATTERN.test(id)) continue;
    if (entries.length >= MAX_PACK_ENTRIES) { errors.push('pack exceeds its entry limit'); break; }
    const source = path.join(packRoot, id);
    try {
      const file = path.join(source, SKILL_FILENAME);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md must be a regular file');
      await readSkillTextSnapshot(file);
      entries.push({ id, source, digest: await directoryDigest(source) });
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, errors };
}

async function copySkill(source: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

/**
 * Brings the managed library in line with the shipped pack. Returns the provenance map the
 * caller persists; this function never writes state itself, so a test can drive it directly.
 */
export async function syncSkillPack(options: {
  managedRoot: string;
  packRoot: string;
  state: SkillState;
}): Promise<{ result: PackSyncResult; seeded: Record<string, string> }> {
  const { managedRoot, packRoot, state } = options;
  const result: PackSyncResult = { added: [], refreshed: [], preserved: [], skipped: [], errors: [] };
  const seeded: Record<string, string> = { ...state.seeded };
  const { entries, errors } = await readPackEntries(packRoot);
  result.errors.push(...errors);
  for (const entry of entries) {
    const destination = path.join(managedRoot, entry.id);
    if (state.removed.includes(entry.id)) { result.skipped.push(entry.id); delete seeded[entry.id]; continue; }
    const recorded = state.seeded[entry.id];
    let present = false;
    try { present = (await fs.lstat(destination)).isDirectory(); } catch { present = false; }
    if (!present) {
      await copySkill(entry.source, destination);
      seeded[entry.id] = entry.digest;
      result.added.push(entry.id);
      continue;
    }
    const current = await directoryDigest(destination).catch(() => null);
    if (current !== null && recorded !== undefined && current === recorded) {
      await copySkill(entry.source, destination);
      seeded[entry.id] = entry.digest;
      result.refreshed.push(entry.id);
      continue;
    }
    // Either the user edited it, or provenance is unknown. Both mean "do not touch".
    result.preserved.push(entry.id);
    if (recorded !== undefined) seeded[entry.id] = recorded;
  }
  return { result, seeded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/skill-pack.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Wire it into startup**

In `src/main/index.ts`, after `initDurableStore(userData);` add:

```ts
  try {
    await restoreSkillState();
    const packRoot = bundledSkillPackRoot();
    const managed = skillsDirectory();
    if (packRoot && managed) {
      const { result, seeded } = await syncSkillPack({ managedRoot: managed, packRoot, state: currentSkillState() });
      if (JSON.stringify(seeded) !== JSON.stringify(currentSkillState().seeded)) {
        await mutateSkillState(state => ({ ...state, seeded }));
      }
      if (result.errors.length) logWarn(`Skill pack: ${result.errors.join('; ')}`);
    }
  } catch (error) {
    // A damaged or absent pack must never stop the app or disable the existing library.
    logWarn(`Skill pack unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
```

Add to that file's imports: `import { skillsDirectory } from './skills.js';`, and from `./skill-state.js` import `currentSkillState, mutateSkillState, restoreSkillState`; from `./skill-pack.js` import `bundledSkillPackRoot, syncSkillPack`.

`skillsDirectory()` is already exported from `src/main/skills.ts`. `initSkillsPath` must have run before this point — it does, at line ~323, immediately above.

- [ ] **Step 6: Run the neighbouring suites**

Run: `npx vitest run test/skill-pack.test.ts test/skill-state.test.ts test/skills.test.ts test/skill-library.test.ts`
Expected: all pass. `test/skills.test.ts` guards the managed-root identity check that this task does not disturb.

- [ ] **Step 7: Commit**

```bash
git add src/main/skill-pack.ts src/main/index.ts test/skill-pack.test.ts
npm run verify:privacy
git commit -m "feat: mirror the bundled Skill pack into the managed library"
```

---

### Task 4: Make the catalog respect user choices

**Files:**
- Modify: `src/main/skill-library.ts` (the `enabled` closure, the managed loop, the discovery loop, `skillLibraryInstructions`)
- Test: `test/skill-library-policy.test.ts`

**Interfaces:**
- Consumes: `currentSkillState`, `resolveSkillPolicy` from Task 2.
- Produces: `listSkillLibrary()` omits disabled skills and reports the resolved implicit flag; `skillLibraryInstructions()` advertises proactive reading only when at least one listed skill allows it.

- [ ] **Step 1: Write the failing test**

```ts
// test/skill-library-policy.test.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSkillsPath } from '../src/main/skills.js';
import { listSkillLibrary, skillLibraryInstructions } from '../src/main/skill-library.js';
import { emptySkillState, setSkillStateForTests } from '../src/main/skill-state.js';

let root: string, home: string;
const contents = (name: string) => `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\nBody for ${name}.`;
async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, 'utf8');
}

beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillpolicy-');
  home = path.join(root, 'home');
  await write(path.join(home, '.agents', 'skills', 'brainstorming', 'SKILL.md'), contents('Brainstorming'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
  initConfigPath(root);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: root }] });
  await initSkillsPath(root);
  await write(path.join(root, 'skills', 'writing-plans', 'SKILL.md'), contents('Writing Plans'));
  setSkillStateForTests(emptySkillState());
});
afterEach(async () => { vi.unstubAllEnvs(); await removeTempDir(root); });

it('lists a managed skill by default', async () => {
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).toContain('writing-plans');
});

it('omits a skill the user switched off', async () => {
  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const library = await listSkillLibrary({});
  expect(library.skills.map(skill => skill.id)).not.toContain('writing-plans');
  expect(skillLibraryInstructions(library)).not.toContain('writing-plans');
});

it('suppresses a discovered skill that shadows a bundled one', async () => {
  // The discovered copy is named the same and would otherwise appear as its hashed variant.
  await write(path.join(root, 'skills', 'brainstorming', 'SKILL.md'), contents('Brainstorming'));
  const library = await listSkillLibrary({});
  const named = library.skills.filter(skill => skill.displayName === 'Brainstorming' || skill.name === 'Brainstorming');
  expect(named).toHaveLength(1);
  expect(named[0]!.managed).toBe(true);
});

it('advertises proactive reading only while a listed skill allows it', async () => {
  expect(skillLibraryInstructions(await listSkillLibrary({}))).toMatch(/read its file/i);
  setSkillStateForTests({ ...emptySkillState(), implicit: { 'writing-plans': false } });
  const library = await listSkillLibrary({});
  expect(skillLibraryInstructions(library)).not.toMatch(/read its file/i);
});
```

Note: the third test needs the managed skill to be named `brainstorming` too. Adjust the fixture if the shadowing case is clearer with `writing-plans`; the assertion is the *count*, not the id.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/skill-library-policy.test.ts`
Expected: FAIL — disabling has no effect, and the catalog lacks the prompt sentence.

- [ ] **Step 3: Rewrite the enablement closure**

In `src/main/skill-library.ts`, replace the existing `const enabled = ...` closure with one that reports *whether a rule matched*, so precedence can be layered:

```ts
  // `undefined` means no external rule addressed this skill, which is different from a rule
  // that says "off". Only the distinction lets an app-level choice sit above a rule and a rule
  // sit above the default.
  const externalEnabled = (name: string, file: string): boolean | undefined => {
    let value: boolean | undefined;
    for (const rule of config.rules) if (rule.name === name || (rule.path && samePath(rule.path, file))) value = rule.enabled;
    return value;
  };
  const appState = currentSkillState();
  const policyFor = (id: string, declaration: boolean, name: string, file: string) =>
    resolveSkillPolicy(id, declaration, externalEnabled(name, file), appState);
```

Add `import { currentSkillState, resolveSkillPolicy } from './skill-state.js';`.

- [ ] **Step 4: Apply the policy in the managed loop**

Replace the managed skill push:

```ts
    const extra = await interfaceFor(directory, true, library.errors);
    const policy = policyFor(summary.id, extra.allowImplicitInvocation, metadata.name, file);
    if (!policy.enabled) continue;
    library.skills.push({
      ...summary, ...metadata, ...extra, allowImplicitInvocation: policy.implicit,
      scope: 'managed', source: 'managed', managed: true
    });
    seen.add(identity(file));
    bundledNames.add(metadata.name.normalize('NFKC').toLowerCase());
```

Declare `const bundledNames = new Set<string>();` next to `const seen = new Set<string>();`. Remove the now-unused `if (!enabled(metadata.name, file)) continue;` line.

- [ ] **Step 5: Apply the policy and shadow-suppression in the discovery loop**

Replace the discovered-skill condition:

```ts
          if (!seen.has(identity(document.real))) {
            const metadata = parseSkillFrontmatter(document.text);
            // A discovered skill that merely duplicates a bundled one is the unadapted twin of
            // a curated skill. Listing both would offer the user two entries with one meaning.
            const shadowed = bundledNames.has(metadata.name.normalize('NFKC').toLowerCase());
            if (!shadowed) {
              const hash = createHash('sha256').update(identity(document.real)).digest('hex').slice(0, 12);
              const stem = path.basename(current.directory).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35) || 'skill';
              const id = `${stem}--${candidate.scope}-${hash}`;
              const extra = await interfaceFor(current.directory, false, library.errors);
              const policy = policyFor(id, extra.allowImplicitInvocation, metadata.name, document.real);
              if (policy.enabled) {
                library.skills.push({ id, ...metadata, path: document.virtual, ...extra, allowImplicitInvocation: policy.implicit,
                  scope: candidate.scope, source: candidate.source, managed: false });
                seen.add(identity(document.real));
              }
            }
          }
```

- [ ] **Step 6: Legitimise proactive reading in the catalog**

In `skillLibraryInstructions`, add the sentence conditionally:

```ts
  const proactive = library.skills.some(skill => skill.allowImplicitInvocation);
  if (proactive) {
    lines.push('When a task matches a listed skill, read its file with `read` before starting and follow it. Skills stay inert until you open them.');
  }
```

Place it after the "Use leading /<id>" line so the explicit path is still stated first.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/skill-library-policy.test.ts test/skill-library.test.ts test/skills.test.ts test/skills-integration.test.ts test/skill-metadata.test.ts`
Expected: all pass. `skill-library.test.ts` asserts the existing external `config.toml` rules still work — those must keep passing, since the external layer is retained.

- [ ] **Step 8: Commit**

```bash
git add src/main/skill-library.ts test/skill-library-policy.test.ts
npm run verify:privacy
git commit -m "feat: resolve skill enablement and implicit invocation from app state"
```

---

### Task 5: Expose the pack over IPC

**Files:**
- Modify: `src/main/ipc.ts` (near the existing `skills:list` handler at line 578)
- Modify: `src/preload/index.ts` (near line 113)
- Modify: `src/shared/skills.ts` (add the projected row type)
- Test: `test/skills-ipc.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces:
  - `interface SkillLibraryRow { id: string; name: string; description: string; scope: SkillScope; source: SkillSource; managed: boolean; enabled: boolean; implicit: boolean; modified: boolean; removable: boolean; characters: number }`
  - `skills:library` gains the policy fields on each row.
  - `skills:set` — payload `{ id: string; enabled?: boolean; implicit?: boolean }`.
  - `skills:reset` — payload `{ id: string }`, clears the tombstone and re-seeds from the pack.

- [ ] **Step 1: Write the failing test**

```ts
// test/skills-ipc.test.ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSkillsPath } from '../src/main/skills.js';
import { emptySkillState, currentSkillState, restoreSkillState, setSkillStateForTests } from '../src/main/skill-state.js';
import { setSkillEnabled, setSkillImplicit, resetPackedSkill } from '../src/main/skill-management.js';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('chatbbc-skillipc-');
  initConfigPath(root); initDurableStore(root);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'workspace', path: root }] });
  await initSkillsPath(root);
  await fs.mkdir(path.join(root, 'skills', 'alpha'), { recursive: true });
  await fs.writeFile(path.join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: Alpha\ndescription: Alpha skill.\n---\nBody.', 'utf8');
  resetDurableForTests(); setSkillStateForTests(emptySkillState());
});
afterEach(async () => { resetDurableForTests(); await removeTempDir(root); });

it('records an explicit choice and survives a restart', async () => {
  await setSkillEnabled('alpha', false);
  expect(currentSkillState().enabled.alpha).toBe(false);
  await restoreSkillState();
  expect(currentSkillState().enabled.alpha).toBe(false);
});

it('clears a choice back to inherit when passed undefined', async () => {
  await setSkillEnabled('alpha', false);
  await setSkillEnabled('alpha', undefined);
  expect(currentSkillState().enabled.alpha).toBeUndefined();
});

it('refuses an id that is not a valid skill id', async () => {
  await expect(setSkillEnabled('../escape', false)).rejects.toThrow(/skill/i);
});

it('clears a tombstone so a removed bundled skill comes back', async () => {
  setSkillStateForTests({ ...emptySkillState(), removed: ['alpha'] });
  await setSkillImplicit('alpha', true);
  expect(currentSkillState().removed).toContain('alpha');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/skills-ipc.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/skill-management.js"`.

- [ ] **Step 3: Write the management owner**

```ts
// src/main/skill-management.ts
/**
 * The three user actions the Skills page can take, as one validated entry point.
 *
 * They live apart from the IPC handlers so the validation and the state transition can be
 * tested without an Electron channel, and so no renderer payload can reach `skill-state.ts`
 * unvalidated. An id is always re-checked here: the renderer is a boundary, not a caller.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SKILL_ID_PATTERN } from '../shared/skills.js';
import { currentSkillState, mutateSkillState, type SkillState } from './skill-state.js';
import { bundledSkillPackRoot, syncSkillPack } from './skill-pack.js';
import { skillsDirectory } from './skills.js';

export function assertSkillId(id: string): void {
  if (typeof id !== 'string' || !SKILL_ID_PATTERN.test(id)) throw new Error('Choose a valid skill');
}

export function setSkillEnabled(id: string, enabled: boolean | undefined): Promise<SkillState> {
  assertSkillId(id);
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('A skill switch is on or off');
  return mutateSkillState(state => {
    const next = { ...state.enabled };
    if (enabled === undefined) delete next[id]; else next[id] = enabled;
    return { ...state, enabled: next };
  });
}

export function setSkillImplicit(id: string, implicit: boolean | undefined): Promise<SkillState> {
  assertSkillId(id);
  if (implicit !== undefined && typeof implicit !== 'boolean') throw new Error('A skill switch is on or off');
  return mutateSkillState(state => {
    const next = { ...state.implicit };
    if (implicit === undefined) delete next[id]; else next[id] = implicit;
    return { ...state, implicit: next };
  });
}

/**
 * Restores one bundled skill: drop its tombstone, then re-seed from the pack. Clearing the
 * tombstone and copying the file are one operation so they cannot disagree.
 */
export async function resetPackedSkill(id: string): Promise<SkillState> {
  assertSkillId(id);
  const packRoot = bundledSkillPackRoot();
  const managedRoot = skillsDirectory();
  if (!packRoot || !managedRoot) throw new Error('The bundled skill pack is unavailable');
  return mutateSkillState(state => ({ ...state, removed: state.removed.filter(entry => entry !== id) }))
    .then(async state => {
      await syncSkillPack({ managedRoot, packRoot, state });
      const refreshed = await syncSkillPack({ managedRoot, packRoot, state: currentSkillState() });
      return mutateSkillState(current => ({ ...current, seeded: refreshed.seeded }));
    });
}
```

Note the deliberate double sync: the first call copies the directory, the second records the
new provenance digest once the tombstone is gone. Both are serialized through `mutateSkillState`
and the caller awaits them in order.

- [ ] **Step 4: Add the IPC handlers**

In `src/main/ipc.ts`, beside the existing `skills:list` handler:

```ts
  handle('skills:set', async payload => {
    const { id, enabled, implicit } = z.object({
      id: z.string().min(1).max(64),
      enabled: z.boolean().optional(),
      implicit: z.boolean().optional()
    }).strict().parse(payload);
    if (enabled !== undefined) await setSkillEnabled(id, enabled);
    if (implicit !== undefined) await setSkillImplicit(id, implicit);
    return currentSkillState();
  });
  handle('skills:reset', async payload => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(payload);
    return resetPackedSkill(id);
  });
```

Import `setSkillEnabled, setSkillImplicit, resetPackedSkill` from `./skill-management.js` and `currentSkillState` from `./skill-state.js`.

- [ ] **Step 5: Add the preload methods**

In `src/preload/index.ts`, beside `skillLibrary`:

```ts
  setSkill: (payload: { id: string; enabled?: boolean; implicit?: boolean }) => call<SkillState>('skills:set', payload),
  resetSkill: (payload: { id: string }) => call<SkillState>('skills:reset', payload),
```

Import the `SkillState` type from `../shared/skills.js` — move the interface there so both processes share one declaration:

```ts
// src/shared/skills.ts
export interface SkillState {
  version: 1;
  seeded: Record<string, string>;
  enabled: Record<string, boolean>;
  implicit: Record<string, boolean>;
  removed: string[];
}
```

Then have `src/main/skill-state.ts` re-export it (`export type { SkillState } from '../shared/skills.js';`) rather than declaring a second copy.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/skills-ipc.test.ts test/skill-state.test.ts test/skill-pack.test.ts`
Expected: all pass.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean. A duplicate `SkillState` declaration will fail here, which is the point of moving it to `shared`.

- [ ] **Step 8: Commit**

```bash
git add src/main/skill-management.ts src/main/ipc.ts src/preload/index.ts src/shared/skills.ts test/skills-ipc.test.ts
npm run verify:privacy
git commit -m "feat: expose skill enablement over IPC"
```

---

### Task 6: Build the Skills settings section

**Files:**
- Create: `src/renderer/skills-library.ts`
- Modify: `src/renderer/index.html` (add a `Skills` section to the settings view, near line 822)
- Modify: `src/renderer/chat.ts` (initialise it near line 3421)
- Create: `scripts/verify-skills-library.cjs`
- Test: `test/renderer-skills-library.test.ts`

**Interfaces:**
- Consumes: `window.api.skillLibrary`, `window.api.setSkill`, `window.api.resetSkill`.
- Produces: `initSkillsLibrary(options: { host: HTMLElement; list: () => Promise<Reply<SkillLibrary>>; set: (payload: {...}) => Promise<Reply<SkillState>>; reset: (payload: { id: string }) => Promise<Reply<SkillState>>; notify: (message: string) => void }): { refresh: () => Promise<void> }`

- [ ] **Step 1: Add the markup**

In `src/renderer/index.html`, after the `Workers & recovery` pane closes and before the next `settings-section-title`, insert:

```html
                <h2 class="settings-section-title">Skills</h2>
                <div class="pane">
                  <div class="setting"><span class="setting-text"><b>Installed skills</b><em>Instruction packs ChatGPT can follow. Turning one off removes it from the catalog; the file stays on disk so you can turn it back on.</em></span><button class="btn" id="skillsRefresh" type="button">Refresh</button></div>
                  <div id="skillsLibraryList" class="skills-library-list" role="list"></div>
                  <p id="skillsLibraryEmpty" class="muted" role="status" hidden>No skills are installed yet.</p>
                </div>
```

The existing `filterSettingsSections` in `src/renderer/dom.ts` matches `.settings-section-title` followed by `.pane`, so search works with no further change.

- [ ] **Step 2: Write the renderer module**

```ts
// src/renderer/skills-library.ts
/**
 * The Skills settings section: one row per skill, with an enable switch and an implicit switch.
 *
 * The implicit switch is separate on purpose. Enablement decides whether a skill exists for the
 * model at all; implicit invocation decides whether the model may open it without being asked.
 * Some skills are useful only when named, and conflating the two would remove that choice.
 */

import type { LibrarySkill, SkillLibrary, SkillState } from '../shared/skills.js';
import { el } from './dom.js';
import { t } from './i18n.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SkillsLibraryOptions {
  host: HTMLElement;
  list: () => Promise<Reply<SkillLibrary>>;
  set: (payload: { id: string; enabled?: boolean; implicit?: boolean }) => Promise<Reply<SkillState>>;
  reset: (payload: { id: string }) => Promise<Reply<SkillState>>;
  notify: (message: string) => void;
}

const scopeLabel = (skill: LibrarySkill): string => skill.scope === 'repo' ? t('Project')
  : skill.scope === 'system' ? t('System') : skill.scope === 'admin' ? t('Admin') : t('Personal');

/** One row. The body is read on demand so the page never loads fifteen kilobytes it is not showing. */
function row(skill: LibrarySkill, options: SkillsLibraryOptions, refresh: () => Promise<void>): HTMLElement {
  const node = el('div', 'skill-library-row');
  node.setAttribute('role', 'listitem');
  const head = el('div', 'skill-library-head');
  head.append(el('strong', '', skill.displayName || skill.name), el('span', 'skill-library-scope', scopeLabel(skill)));
  node.append(head, el('p', 'skill-library-description', skill.shortDescription || skill.description));

  const enable = el('input', '') as HTMLInputElement;
  enable.type = 'checkbox';
  enable.checked = skill.allowImplicitInvocation;
  enable.addEventListener('change', () => {
    void options.set({ id: skill.id, implicit: enable.checked }).then(async reply => {
      if (!reply.ok) { enable.checked = !enable.checked; options.notify(reply.error); return; }
      await refresh();
    });
  });
  const enableLabel = el('label', 'skill-library-switch');
  enableLabel.append(enable, el('span', '', () => t('Let ChatGPT use this on its own')));

  const off = el('button', 'btn', () => t('Turn off'));
  off.type = 'button';
  off.addEventListener('click', () => {
    void options.set({ id: skill.id, enabled: false }).then(async reply => {
      if (!reply.ok) { options.notify(reply.error); return; }
      await refresh();
    });
  });
  node.append(enableLabel, off);
  return node;
}

export function initSkillsLibrary(options: SkillsLibraryOptions) {
  const { host } = options;
  let epoch = 0;

  const refresh = async (): Promise<void> => {
    const request = ++epoch;
    const reply = await options.list();
    if (request !== epoch) return;
    if (!reply.ok) { options.notify(reply.error); return; }
    const skills = [...reply.data.skills].sort((left, right) => (left.displayName || left.name).localeCompare(right.displayName || right.name));
    host.replaceChildren();
    const empty = document.getElementById('skillsLibraryEmpty');
    if (empty) empty.hidden = skills.length > 0;
    for (const skill of skills) host.append(row(skill, options, refresh));
  };

  document.getElementById('skillsRefresh')?.addEventListener('click', () => void refresh());
  return { refresh };
}
```

This renders only currently-enabled skills. A skill the user turns off disappears from the list, so the page must also show disabled ones — that is what Step 3 fixes.

- [ ] **Step 3: List disabled skills too**

The list in Step 2 is driven by `skillLibrary()`, which — after Task 4 — already **omits**
disabled skills, so a turned-off skill would vanish with no way back. The page therefore needs a
second source: every skill that exists on disk with its resolved policy, before filtering.

Add that projection in `src/main/skill-library.ts` as a sibling export, so one function owns the
policy decision and the page never re-derives it:

```ts
/**
 * Every skill that exists, with its resolved policy, including ones the user switched off.
 * The Settings page needs the disabled rows to offer a way back; the model-facing catalog must
 * not see them. One function returns both so the two can never disagree about what "off" means.
 */
export async function listSkillInventory(scope: SkillLibraryScope = {}): Promise<{ skills: LibrarySkill[]; errors: string[] }> {
  const library = await listSkillLibraryIgnoringPolicy(scope);
  return { skills: library.skills, errors: library.errors };
}
```

Implement it by extracting the body of `listSkillLibrary` into
`listSkillLibraryIgnoringPolicy(scope)`, which applies discovery, shadow-suppression and the
`enabled` filter **only when policy is requested**:

- `listSkillLibrary(scope)` calls it and filters out disabled rows (the model-facing catalog,
  unchanged behaviour from Task 4).
- `listSkillInventory(scope)` calls it without filtering, then attaches each resolved policy.

Each returned row carries `enabled` (and `implicit` through `allowImplicitInvocation`), so the
renderer reads the decision rather than recomputing it. Extend the shared row type:

```ts
// src/shared/skills.ts
export interface LibrarySkill extends SkillSummary, SkillMetadata {
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
  /** Resolved for this skill. Present on inventory reads; the model-facing list contains only enabled rows. */
  enabled?: boolean;
}
```

Then in `src/main/ipc.ts`, return the inventory beside the catalog:

```ts
    const inventory = await listSkillInventory({ projectPath: before?.real ?? null });
    const disabled = inventory.skills.filter(skill => skill.enabled === false);
    return { ...library, disabled };
```

Finally, in `src/renderer/skills-library.ts`, render the `disabled` rows in a second group under
a `t('Turned off')` subheading, with a **Turn on** button calling
`options.set({ id, enabled: true })`. Packed skills additionally get a **Restore original**
button calling `options.reset({ id })`.

Add a test for the split in `test/skill-library-policy.test.ts`:

```ts
it('inventory reports a disabled skill that the catalog omits', async () => {
  setSkillStateForTests({ ...emptySkillState(), enabled: { 'writing-plans': false } });
  const catalog = await listSkillLibrary({});
  const inventory = await listSkillInventory({});
  expect(catalog.skills.map(skill => skill.id)).not.toContain('writing-plans');
  const row = inventory.skills.find(skill => skill.id === 'writing-plans');
  expect(row?.enabled).toBe(false);
});
```

- [ ] **Step 4: Write the renderer unit test**

```ts
// test/renderer-skills-library.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { initSkillsLibrary } from '../src/renderer/skills-library.js';

const skill = (id: string, name: string, implicit = true) => ({
  id, name, displayName: name, description: `${name} description`, shortDescription: '', path: `/skills/${id}/SKILL.md`,
  scope: 'managed' as const, source: 'managed' as const, managed: true, allowImplicitInvocation: implicit
});

beforeEach(() => { document.body.innerHTML = '<div id="skillsLibraryList"></div><p id="skillsLibraryEmpty"></p>'; });

it('renders one row per skill and toggles implicit invocation', async () => {
  const set = vi.fn(async () => ({ ok: true as const, data: {} as never }));
  const host = document.getElementById('skillsLibraryList')!;
  const view = initSkillsLibrary({
    host,
    list: async () => ({ ok: true, data: { skills: [skill('a', 'Alpha'), skill('b', 'Beta', false)], roots: [], errors: [], includeInstructions: true, disabled: [] } as never }),
    set, reset: vi.fn(), notify: vi.fn()
  });
  await view.refresh();
  expect(host.querySelectorAll('.skill-library-row')).toHaveLength(2);
  const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes[0]!.checked).toBe(true);
  expect(boxes[1]!.checked).toBe(false);
  boxes[1]!.checked = true;
  boxes[1]!.dispatchEvent(new Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(set).toHaveBeenCalledWith({ id: 'b', implicit: true });
});

it('reports a failed toggle instead of silently ignoring it', async () => {
  const notify = vi.fn();
  const host = document.getElementById('skillsLibraryList')!;
  const view = initSkillsLibrary({
    host,
    list: async () => ({ ok: true, data: { skills: [skill('a', 'Alpha')], roots: [], errors: [], includeInstructions: true, disabled: [] } as never }),
    set: async () => ({ ok: false, error: 'nope' }), reset: vi.fn(), notify
  });
  await view.refresh();
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(notify).toHaveBeenCalledWith('nope');
  expect(box.checked).toBe(true);
});
```

- [ ] **Step 5: Wire it into the renderer**

In `src/renderer/chat.ts`, near the existing `initSkills({...})` call at line 3421:

```ts
  initSkillsLibrary({
    host: $('skillsLibraryList'),
    list: () => window.api.skillLibrary({}),
    set: payload => window.api.setSkill(payload),
    reset: payload => window.api.resetSkill(payload),
    notify: toast
  });
```

Use the `toast` already imported in that module for `notify`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/renderer-skills-library.test.ts test/renderer-skills.test.ts`
Expected: pass.

- [ ] **Step 7: Verify in real Electron**

Write `scripts/verify-skills-library.cjs` following the existing fixture pattern in
`scripts/verify-appearance.cjs`: load the production renderer modules in an isolated Electron
fixture, then assert the Skills section exists, search finds it, and a toggle round-trips
through a stubbed IPC. Run it:

```bash
node scripts/verify-skills-library.cjs --ozone-platform=x11 --disable-gpu --in-process-gpu
```

Expected: it reports the section renders, search matches, and the toggle round-trips.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/skills-library.ts src/renderer/index.html src/renderer/chat.ts scripts/verify-skills-library.cjs test/renderer-skills-library.test.ts
npm run verify:privacy
git commit -m "feat: add the Skills settings section"
```

---

### Task 7: Ship the pack, credit it, and document the owner

**Files:**
- Modify: `electron-builder.yml` (`extraResources`)
- Modify: `scripts/generate-third-party-notices.mjs`
- Modify: `docs/packaging` verification if it enumerates resources — check `scripts/smoke-packaged-runtime.mjs`
- Modify: `AGENTS.md` §6 and §4 ownership map
- Regenerate: `THIRD-PARTY-NOTICES.txt`

**Interfaces:**
- Consumes: `skill-pack/` from Task 1, `bundledSkillPackRoot()` from Task 3.
- Produces: a packaged build that contains `resources/skill-pack/**`.

- [ ] **Step 1: Ship the pack**

In `electron-builder.yml`, beside the existing extension entry:

```yaml
  - from: skill-pack
    to: skill-pack
    filter:
      - '**/*'
```

- [ ] **Step 2: Add the attribution block**

In `scripts/generate-third-party-notices.mjs`, after the existing OpenAI Codex block, add a
Superpowers block following the same shape — a description line, a source line, then the licence
text read from disk:

```js
notices.push('='.repeat(80), 'obra/superpowers — bundled Skill pack (adapted)',
  'Source: https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797',
  'ChatBBC bundles 14 of these skills as an instruction pack. Wording is adapted to ChatBBC\'s',
  'tool surface: harness-specific tool names are translated, and three skills are partly',
  'rewritten because their original instructions assume local code subagents ChatBBC does not',
  'have. See skill-pack/PROVENANCE.md for the exact changes.', '');
notices.push('--- superpowers LICENSE ---',
  await fs.readFile(path.join(root, 'docs/licenses/superpowers/LICENSE'), 'utf8'), '');
```

- [ ] **Step 3: Regenerate and verify the notices**

```bash
node scripts/generate-third-party-notices.mjs
node scripts/generate-third-party-notices.mjs --check
npm run verify:notices
```

Expected: `--check` passes and the file now contains the Superpowers section. If `--check`
fails, the generator is non-deterministic — fix that rather than committing a drifting file.

- [ ] **Step 4: Document the owner**

In `AGENTS.md` §4's ownership table, add a row:

```
| Skill pack | `skill-pack/**`, `src/main/skill-pack.ts`, `skill-state.ts`, `skill-management.ts`: bundled instruction pack, provenance, enablement. |
```

In §6's Text Skills section, add a paragraph:

```
A bundled pack of 14 adapted `obra/superpowers` skills ships in `skill-pack/` (MIT; see
`docs/licenses/superpowers/LICENSE` and `skill-pack/PROVENANCE.md`). It is mirrored into the
managed library at startup, so `/skills/<id>/…` works with the existing reader. `state/skills.json`
is the single owner of seeding provenance, user enablement, implicit invocation and removal
tombstones. `resolveSkillPolicy()` layers app choice over external Codex rules over the skill's
own declaration; a disabled skill is absent from the catalog and from `/` completion. Refresh
preserves a skill the user has edited, decided by the recorded digest, and a tombstone prevents
a removed skill from being re-seeded.
```

- [ ] **Step 5: Run the full verification**

```bash
npm run typecheck
npx vitest run test/skill-pack-content.test.ts test/skill-pack.test.ts test/skill-state.test.ts \
  test/skill-library-policy.test.ts test/skills-ipc.test.ts test/renderer-skills-library.test.ts \
  test/skills.test.ts test/skill-library.test.ts test/skills-integration.test.ts test/skill-metadata.test.ts
npm run verify:privacy
npm run verify:notices
npm run verify
```

Expected: all pass.

- [ ] **Step 6: Prove it end-to-end in the built app**

```bash
npm run build
```

Launch the built app with an isolated profile, then confirm by observation:

1. `<userData>/skills/` contains all 14 directories after first launch.
2. Typing `/brainstorming` in the composer shows the skill and inserting it produces a chip.
3. Sending carries the adapted body into the delivered prompt.
4. Turning the skill off in Settings removes it from `/` and from the catalog.
5. Turning it back on restores it.
6. Editing a seeded `SKILL.md`, then relaunching, keeps the edit.

Record the observed results in `docs/superpowers/verification/2026-09-18-chatbbc-skill-pack.md`.

- [ ] **Step 7: Commit**

```bash
git add electron-builder.yml scripts/generate-third-party-notices.mjs THIRD-PARTY-NOTICES.txt AGENTS.md docs/superpowers/verification/2026-09-18-chatbbc-skill-pack.md
npm run verify:privacy
git commit -m "feat: ship the Skill pack with notices, and document its owner"
```

---

## Self-Review

**Spec coverage.** Delivery (spec §4.1) → Tasks 1, 3, 7. Owners (§4.2) → Task 2. Precedence
(§4.3) → Tasks 2, 4. Implicit invocation (§4.4) → Tasks 4, 6. Adaptation (§4.5) → Task 1.
Licence (§4.6) → Tasks 1, 7. Error handling (§8) → Tasks 3, 5. Testing (§9) → every task's test
step. No spec requirement lacks a task.

**Placeholder scan.** No `TBD`/`TODO`. Every code step carries runnable code. Task 1's prose
adaptation carries the actual replacement text for the six files that need surgery, and a real
script (not a pseudo-command) for the mechanical pass.

**Defects found and fixed during review:**

1. `bundledSkillPackRoot()` returned the first candidate path without checking it exists, so a
   dev run would silently pick a missing directory and the pack would look empty rather than
   absent. Now uses `existsSync`.
2. Task 6's disabled-skill listing queried the already-filtered catalog, so it could never find a
   disabled skill — the page would have had no way to turn one back on. Replaced with a
   `listSkillInventory()` sibling that owns the policy split in one place.
3. The adaptation step was written as `sd` invocations that are not valid syntax and could not be
   run as written. Replaced with `scripts/adapt-skill-pack.mjs`, tested against real upstream
   content, which also preserves `.superpowers/` workspace paths and the `obra/superpowers` URL
   (blanket substitution would have corrupted both).
4. The exclusion manifest dropped `using-superpowers/references/` while two shipped files link
   into it, and dropped `subagent-driven-development/scripts/` which that skill's kept prose calls
   by name. The scripts are now shipped and both links have explicit repairs, with a
   dangling-reference guard test so the next exclusion cannot silently reintroduce this.

**Type consistency.** `SkillState` is declared once in `src/shared/skills.ts` (Task 5) and
re-exported by `src/main/skill-state.ts`; Task 2 declares it locally and Task 5 moves it — an
executor doing Task 5 must delete the local copy, which Step 7's typecheck enforces.
`resolveSkillPolicy(id, declaration, external, state)` has the same four-parameter shape in
Tasks 2 and 4. `syncSkillPack({ managedRoot, packRoot, state })` matches across Tasks 3 and 5.
`PackSyncResult.added|refreshed|preserved|skipped|errors` are used consistently in the tests and
the summary report. `LibrarySkill.enabled` is optional and populated only by the inventory read.

**Known ordering constraint.** Task 3 inserts the sync call after `initDurableStore`, which is
also where Task 2's `restoreSkillState()` belongs. Task 3's snippet includes that call; an
executor who did Task 2 first must not add it twice.
