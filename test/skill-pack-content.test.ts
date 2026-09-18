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
  // Walk, not readdir: the shipped `scripts/` helpers are exactly the files whose comments
  // carried upstream's harness vocabulary, and a shallow scan would let a re-vendor restore
  // them while every test still passed.
  for (const id of EXPECTED) {
    for await (const file of walk(path.join(pack, id))) {
      const body = await fs.readFile(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${path.relative(pack, file)} matches ${pattern}`).toBe(false);
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

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}
