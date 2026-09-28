import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-ignore Guard scripts are intentionally plain ESM JavaScript.
import { CATEGORIES, RETAINED_REASON_CODES, parseNameStatus, retainedIdentifierErrors, validateMap, validateOwnership } from '../scripts/verify-upstream-map.mjs';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

interface MapEntryFixture {
  id: string;
  category: string;
  paths: string[];
  upstreamAnchors: string[];
  decision: string;
  portRule: string;
  checks: string[];
}

interface RetainedFixture {
  path: string;
  literal: string;
  reason: string;
}

interface MapDocumentFixture {
  schemaVersion: number;
  upstream: { repository: string; commit: string; version: string };
  downstream: { repository: string; version: string };
  changes: MapEntryFixture[];
  retainedIdentifiers: RetainedFixture[];
}

let root: string;
let upstreamSha: string;

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/verify-upstream-map.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/** Commits the upstream tree and returns its SHA; every later write is a downstream change. */
async function commitUpstream(files: Record<string, string>): Promise<string> {
  await writeTree(root, files);
  git('add', '-A');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'upstream');
  return git('rev-parse', 'HEAD').trim();
}

function entry(id: string, category: string, paths: string[], upstreamAnchors: string[] = []): MapEntryFixture {
  return {
    id,
    category,
    paths,
    upstreamAnchors,
    decision: 'fixture decision',
    portRule: 'fixture port rule',
    checks: ['npm run verify:upstream-map']
  };
}

function mapDocument(changes: MapEntryFixture[], retainedIdentifiers: RetainedFixture[] = []): MapDocumentFixture {
  return {
    schemaVersion: 1,
    upstream: { repository: 'https://example.invalid/upstream', commit: upstreamSha, version: '1.0.0' },
    downstream: { repository: 'https://example.invalid/downstream', version: '2.0.0' },
    changes,
    retainedIdentifiers
  };
}

async function writeMap(map: MapDocumentFixture): Promise<void> {
  await writeTree(root, { 'docs/upstream-map.json': `${JSON.stringify(map, null, 2)}\n` });
}

const UPSTREAM_FILES = {
  LICENSE: 'MIT fixture\n',
  'docs/setup.md': 'upstream setup\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'src/main/version.ts': "export const APP_VERSION = '1.0.0';\n"
};

/** Downstream additions the guards themselves bring: they are unmapped until the map says otherwise. */
const ADDED_PATHS = [
  'docs/UPSTREAM.md',
  'docs/upstream-map.json',
  'scripts/verify-rebrand.mjs',
  'scripts/verify-upstream-map.mjs'
];

/** The downstream side of the fixture: delete the workflow, modify setup, add the map and guards. */
const DOWNSTREAM_PATHS = [
  '.github/workflows/ci.yml',
  'docs/setup.md',
  ...ADDED_PATHS
];

async function applyDownstream(): Promise<void> {
  await fs.rm(path.join(root, '.github/workflows/ci.yml'));
  await writeTree(root, {
    'docs/setup.md': 'ChatBBC setup\n',
    'docs/UPSTREAM.md': '# Porting upstream\n'
  });
  for (const script of ['scripts/verify-rebrand.mjs', 'scripts/verify-upstream-map.mjs']) {
    await fs.copyFile(new URL(`../${script}`, import.meta.url), path.join(root, script));
  }
}

beforeEach(async () => {
  root = await makeTempDir('upstream-map-');
  git('init', '--quiet');
  upstreamSha = await commitUpstream(UPSTREAM_FILES);
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
});

afterEach(async () => { await removeTempDir(root); });

describe('parseNameStatus', () => {
  it('splits NUL-separated name-status records into added, modified and deleted sets', () => {
    const parsed = parseNameStatus('M\0docs/a.md\0A\0docs/b.md\0D\0.github/workflows/ci.yml\0');
    expect([...parsed.modified]).toEqual(['docs/a.md']);
    expect([...parsed.added]).toEqual(['docs/b.md']);
    expect([...parsed.deleted]).toEqual(['.github/workflows/ci.yml']);
  });

  it('treats a type change or rename record as a modification of every named path', () => {
    const parsed = parseNameStatus('T\0a.txt\0R100\0old.txt\0new.txt\0');
    expect([...parsed.modified].sort()).toEqual(['a.txt', 'new.txt', 'old.txt']);
    expect(parsed.added.size).toBe(0);
    expect(parsed.deleted.size).toBe(0);
  });
});

describe('validateMap', () => {
  it('accepts a well-formed document', () => {
    expect(validateMap(mapDocument([entry('a-b', 'identity', ['docs/setup.md'])], [
      { path: 'LICENSE', literal: 'legal text', reason: 'license: upstream MIT body is preserved' }
    ]))).toEqual([]);
  });

  it('names every malformed field instead of trusting the document', () => {
    const broken = mapDocument([entry('Bad Id', 'nonsense', ['/abs', ''], ['nope'])]);
    broken.schemaVersion = 2;
    broken.upstream.commit = 'not-a-sha';
    const first = broken.changes[0];
    if (first === undefined) throw new Error('fixture entry missing');
    first.decision = '';
    const errors = validateMap(broken).join('\n');
    expect(errors).toMatch(/schemaVersion/);
    expect(errors).toMatch(/upstream\.commit/);
    expect(errors).toMatch(/category/);
    expect(errors).toMatch(/decision/);
    expect(errors).toMatch(/paths\[0\]/);
    expect(errors).toMatch(/paths\[1\]/);
    expect(errors).toMatch(/Bad Id/);
  });

  it('rejects duplicate entry ids', () => {
    const shared = entry('shared', 'identity', ['docs/setup.md']);
    const errors = validateMap(mapDocument([shared, { ...shared, paths: ['docs/setup.md'] }])).join('\n');
    expect(errors).toMatch(/duplicate entry id "shared"/);
  });

  it('exposes the closed category vocabulary', () => {
    expect([...CATEGORIES].sort()).toEqual([
      'assets', 'documentation', 'identity', 'linux-release', 'local-automation', 'omarchy', 'prompts', 'verification'
    ]);
  });
});

describe('validateOwnership', () => {
  const changed = { added: new Set(['a.ts']), modified: new Set(['b.ts']), deleted: new Set(['c.yml']) };

  it('requires exactly one owner for every changed path', () => {
    const errors = validateOwnership(mapDocument([
      entry('one', 'identity', ['a.ts', 'b.ts']),
      entry('two', 'identity', ['a.ts']),
      entry('three', 'identity', ['unrelated.md'])
    ]), changed).join('\n');
    expect(errors).toMatch(/"a\.ts" is listed by entries "one" and "two"/);
    expect(errors).toMatch(/"c\.yml" \(deleted\) has no map entry/);
    expect(errors).toMatch(/"unrelated\.md" is not changed against upstream/);
  });

  it('accepts a map that covers the change set exactly once', () => {
    const errors = validateOwnership(mapDocument([
      entry('one', 'identity', ['a.ts', 'b.ts']),
      entry('two', 'local-automation', ['c.yml'], ['c.yml'])
    ]), changed);
    expect(errors).toEqual([]);
  });
});

describe('retainedIdentifierErrors', () => {
  it('accepts only reason codes from the retained vocabulary', () => {
    expect(retainedIdentifierErrors([
      { path: 'LICENSE', literal: 'Chat On Steroids', reason: 'license: upstream MIT copyright line' }
    ], () => 'text with Chat On Steroids inside')).toEqual([]);
    const errors = retainedIdentifierErrors([
      { path: 'LICENSE', literal: 'Chat On Steroids', reason: 'because it is old' }
    ], () => 'text with Chat On Steroids inside').join('\n');
    expect(errors).toMatch(/reason/);
    expect(RETAINED_REASON_CODES).toContain('internal-identifier');
  });

  it('rejects an exception whose literal is no longer in the file', () => {
    const errors = retainedIdentifierErrors([
      { path: 'LICENSE', literal: 'Chat On Steroids', reason: 'license: upstream MIT copyright line' }
    ], () => 'clean text').join('\n');
    expect(errors).toMatch(/no longer present/);
  });
});

describe('verify-upstream-map command', () => {
  it('reports the exact fetch command when the pinned upstream commit is absent', async () => {
    await applyDownstream();
    const map = mapDocument([entry('all', 'documentation', DOWNSTREAM_PATHS)]);
    map.upstream.commit = '0123456789012345678901234567890123456789';
    await writeMap(map);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git fetch --no-tags https://example.invalid/upstream 0123456789012345678901234567890123456789');
  });

  it('passes when every added, modified and deleted path is mapped exactly once', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('workflow-removal', 'local-automation', ['.github/workflows/ci.yml']),
      entry('identity-docs', 'identity', ['docs/setup.md']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json']),
      entry('guard-scripts', 'verification', ['scripts/verify-rebrand.mjs', 'scripts/verify-upstream-map.mjs'], ['src/main/version.ts'])
    ]));
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/maps 6 changed paths/);
  });

  it('fails on an unmapped deleted workflow and names the path and status', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('identity-docs', 'identity', ['docs/setup.md']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json'])
    ]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/"\.github\/workflows\/ci\.yml" \(deleted\) has no map entry/);
  });

  it('fails when an upstream anchor does not exist in the pinned tree', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('workflow-removal', 'local-automation', ['.github/workflows/ci.yml']),
      entry('identity-docs', 'identity', ['docs/setup.md'], ['docs/not-upstream.md']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json'])
    ]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/anchors on "docs\/not-upstream\.md"/);
  });

  it('fails on a mapped path that is unchanged from upstream', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('workflow-removal', 'local-automation', ['.github/workflows/ci.yml']),
      entry('identity-docs', 'identity', ['docs/setup.md', 'LICENSE']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json'])
    ]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/"LICENSE" is not changed against upstream/);
  });

  it('fails when two entries claim the same changed path', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('workflow-removal', 'local-automation', ['.github/workflows/ci.yml']),
      entry('identity-docs', 'identity', ['docs/setup.md']),
      entry('identity-docs-again', 'identity', ['docs/setup.md']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json'])
    ]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/listed by entries "identity-docs" and "identity-docs-again"/);
  });

  it('fails on a malformed document and on unparseable JSON', async () => {
    await applyDownstream();
    await writeMap(mapDocument([entry('porting-map', 'unknown-category', ['docs/upstream-map.json'])]));
    expect(run().stderr).toMatch(/category/);
    await writeTree(root, { 'docs/upstream-map.json': '{ not json' });
    expect(run().stderr).toMatch(/not valid JSON/);
  });

  it('rejects a retained identifier whose literal no longer exists', async () => {
    await applyDownstream();
    await writeMap(mapDocument([
      entry('workflow-removal', 'local-automation', ['.github/workflows/ci.yml']),
      entry('identity-docs', 'identity', ['docs/setup.md']),
      entry('porting-map', 'documentation', ['docs/UPSTREAM.md', 'docs/upstream-map.json'])
    ], [{ path: 'LICENSE', literal: 'Chat On Steroids', reason: 'license: upstream copyright line' }]));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/LICENSE/);
    expect(result.stderr).toMatch(/no longer present/);
  });

  it('emits paste-ready draft entries for unmapped paths with --emit-draft', async () => {
    await applyDownstream();
    await writeMap(mapDocument([]));
    const result = run('--emit-draft');
    expect(result.status).not.toBe(0);
    const draft: { unmapped: { category: string; paths: string[]; decision: string }[] } = JSON.parse(result.stdout);
    const paths = draft.unmapped.flatMap(group => group.paths);
    expect(paths.sort()).toEqual([...DOWNSTREAM_PATHS].sort());
    for (const group of draft.unmapped) {
      expect(CATEGORIES).toContain(group.category);
      expect(group.decision).toBe('');
    }
  });
});
