# Skill pack — end-to-end verification

**Date:** 2026-09-18
**Branch:** `skill-pack` (all seven plan tasks integrated at `2744d89`)
**Plan:** `docs/superpowers/plans/2026-09-18-chatbbc-skill-pack.md`
**Spec:** `docs/superpowers/specs/2026-09-18-chatbbc-skill-pack-design.md`

This record satisfies Task 7 Step 6, which was deferred to whole-branch verification
(Ruling R10) because the UI needed for the disable/enable observations did not exist
until Task 6 landed.

## What was verified, and how

Every observation below was produced by launching a real build on this machine with an
isolated profile (`HOME`/`XDG_*` pointed at a scratch directory), not by unit test. The
Electron fixtures required `--ozone-platform=x11 --disable-gpu --in-process-gpu`.

### 1. Fourteen skills seed on first launch

Development build, fresh profile:

```
$ ls $XDG_CONFIG_HOME/chatbbc/skills | wc -l
14
```

The catalog is exactly the curated set — `brainstorming`, `dispatching-parallel-agents`,
`executing-plans`, `finishing-a-development-branch`, `receiving-code-review`,
`requesting-code-review`, `subagent-driven-development`, `systematic-debugging`,
`test-driven-development`, `using-git-worktrees`, `using-superpowers`,
`verification-before-completion`, `writing-plans`, `writing-skills`.

State file written as expected: `version 1 | seeded 14 | enabled 0 | removed 0`.

### 2. Seeded content is the ADAPTED text, not upstream's

`subagent-driven-development/SKILL.md` in the managed library contains 4 occurrences of
ChatBBC-specific vocabulary (`ChatBBC`, `agents action=spawn`, `update_plan`), and a scan of
all 14 seeded skills finds **0** files containing upstream harness vocabulary
(`superpowers:`, `TodoWrite`, `Claude Code`).

### 3. Provenance digests match the pack exactly

Recomputing the directory digest of each `skill-pack/<id>` and comparing against the recorded
`state.skills.json` `seeded` map:

```
provenance matches pack: 14/14
```

This is the mechanism the refresh logic depends on: a matching digest is what permits an
unmodified copy to be refreshed, and a mismatch is what preserves a user's edit.

### 4. A user edit survives a relaunch; an unedited skill is still refreshed

Appended a marker to `writing-plans/SKILL.md`, relaunched, and re-checked:

```
edit preserved?                      1   (marker still present)
brainstorming still matches pack:    true  (unedited skill refreshed correctly)
writing-plans digest retained:       true  (provenance kept, so the edit stays preserved)
```

The pack is therefore upgradeable without destroying work the user did to a bundled skill.

### 5. The packaged build seeds from the shipped resource

This is the path that neither the Task 3 review nor the plan could verify, because it depends
on `electron-builder`'s `extraResources` entry and `process.resourcesPath` — and on AppImage
that path is a temporary mount, which is precisely why the design mirrors the pack into
userData rather than reading it in place.

Built with `npm run dist:dir:linux:x64`, then:

```
$ ls release/linux-unpacked/resources/skill-pack | wc -l
16                        # 14 skills + LICENSE + PROVENANCE.md
```

Launched the packaged binary **from an unrelated working directory** (`cwd=/tmp`), so no
checkout-relative discovery could contribute:

```
$ cd /tmp && .../release/linux-unpacked/chatbbc --ozone-platform=x11 ...
skills seeded from cwd=/tmp: 14
provenance entries:          14
```

Fourteen directories and fourteen provenance entries, resolved from the packaged resource.

### 6. No errors, and no JavaScript exception

The packaged run reported `exit=124` (the timeout killed a healthy running app) with
**0** matches for `javascript error` / `uncaught` in its log.

## A defect this verification caught, and its resolution

The first packaged run failed with:

```
A JavaScript error occurred in the main process
Error: Cannot find module '@modelcontextprotocol/core/internal'
```

This was **not** a product defect. The worktree had `node_modules` symlinked to the main
checkout, and `electron-builder`'s dependency scan does not follow that symlink, so the
packaged `app.asar` was missing the MCP SDK's subpath exports. Confirmed by comparison: the
main checkout (a real `node_modules`) packaged the same 22 `@modelcontextprotocol/core`
entries and launched cleanly.

Resolution: replaced the symlink with a real `npm ci` in the worktree, rebuilt, and re-ran
observation 5 — which then passed. Recorded here because a symlinked `node_modules` is a
convenient way to set up a parallel worktree and it silently produces a broken package; the
failure looks like an application bug and is not one.

A second, unrelated shortfall: `node_modules/electron/dist` was absent because this
environment blocks Electron's postinstall script, so two `LICENSE`/`LICENSES.chromium.html`
copies could not be staged into the package. That affects only those two license files and
not the application bundle; `verify:notices` passes independently on the real dependency tree.

## Automated verification on the same commit

```
npm run typecheck                                   clean (exit 0)
npx vitest run --exclude test/mcp-shutdown.test.ts  216 files, 5123 passed, 0 failed
npx vitest run test/mcp-shutdown.test.ts            6 passed
npm run verify:privacy                              passed (224 commits, 13 tags)
npm run verify:notices                              passed (155 packages, 7 catalog entries)
```

Pre-feature baseline on `main` (`ac5311e`) for comparison: **210 files / 5065 passed, 0 failed**.
The feature adds 6 test files and 58 tests, with no regressions.

## Not verified here

- **Implicit invocation end-to-end.** The catalog text and the per-skill flag are covered by
  unit tests, but whether a given ChatGPT client surfaces the Core connector's `initialize`
  instructions to the model is the client's decision. The feature is opening-scoped by
  design (see the spec's §4.4 limitation); confirming model behaviour would require a live
  signed-in conversation.
- **Windows and macOS packaging.** Out of scope by the repository's platform rule; the
  `skill-pack` resource entry is platform-independent and the Linux path is proven above.
