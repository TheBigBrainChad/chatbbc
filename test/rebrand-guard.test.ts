import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-ignore Guard scripts are intentionally plain ESM JavaScript.
import { findBrandMatches, IDENTITY_CHECKS } from '../scripts/verify-rebrand.mjs';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

let root: string;

function run(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/verify-rebrand.mjs'], {
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

const IDENTITY_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'chatbbc',
    version: '2.2.0',
    author: 'TheBigBrainChad',
    homepage: 'https://github.com/TheBigBrainChad/chatbbc',
    desktopName: 'com.chatbbc.app.desktop'
  }),
  'src/main/version.ts': [
    "export const APP_VERSION = '2.2.0';",
    "export const APP_TITLE = 'ChatBBC';",
    "export const APP_SLUG = 'chatbbc';",
    'export function extensionDownloadUrl(version = APP_VERSION): string {',
    '  return `https://github.com/TheBigBrainChad/chatbbc/releases/download/v${encodeURIComponent(version)}/ChatBBC-Extension.zip`;',
    '}',
    'export const BRIDGE_PROTOCOL = 18;',
    ''
  ].join('\n'),
  'extension/manifest.json': JSON.stringify({ manifest_version: 3, name: '__MSG_extension_name__', version: '2.2.0', default_locale: 'en' }),
  'extension/_locales/en/messages.json': JSON.stringify({ extension_name: { message: 'ChatBBC Companion' } }),
  'src/main/mcp/surfaces.ts': [
    "export const CONNECTOR_BRAND = 'ChatBBC';",
    "const core = { serverName: 'chatbbc-core', connectorName: `${CONNECTOR_BRAND} Core` };",
    "const desktop = { serverName: 'chatbbc-desktop' };",
    "const plugins = { serverName: 'chatbbc-plugins' };",
    ''
  ].join('\n'),
  'extension/background.js': [
    'const BRIDGE_PROTOCOL = 18;',
    "function accept(body) { return body && body.app === 'chatbbc' ? body : null; }",
    ''
  ].join('\n'),
  'electron-builder.yml': [
    'appId: com.chatbbc.app',
    'productName: ChatBBC',
    'linux:',
    '  target:',
    '    - AppImage',
    '  executableName: chatbbc',
    '  artifactName: ChatBBC-Linux-x64.AppImage',
    ''
  ].join('\n')
};

async function writeMap(retainedIdentifiers: { path: string; literal: string; reason: string }[]): Promise<void> {
  await writeTree(root, {
    'docs/upstream-map.json': `${JSON.stringify({
      schemaVersion: 1,
      upstream: { repository: 'https://example.invalid/upstream', commit: '0'.repeat(40), version: '1.0.0' },
      downstream: { repository: 'https://example.invalid/downstream', version: '2.0.0' },
      changes: [],
      retainedIdentifiers
    }, null, 2)}\n`
  });
}

async function commitBaseline(): Promise<void> {
  await writeTree(root, IDENTITY_FILES);
  await writeMap([]);
  git('add', '-A');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-m', 'baseline');
  for (const script of ['scripts/verify-rebrand.mjs', 'scripts/verify-upstream-map.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, script)), { recursive: true });
    await fs.copyFile(new URL(`../${script}`, import.meta.url), path.join(root, script));
  }
}

const RETAINED_REASON = 'historical-report: the incident report names the build that was affected';

beforeEach(async () => {
  root = await makeTempDir('rebrand-');
  git('init', '--quiet');
  await commitBaseline();
});

afterEach(async () => { await removeTempDir(root); });

describe('findBrandMatches', () => {
  it('matches every predecessor spelling and standalone CoS/COS tokens', () => {
    const text = [
      'Chat On Steroids',
      'chat-on-steroids.sidebar-order',
      'ChatOnSteroids',
      'chatonsteroids',
      'the CoS Pet contract',
      'COS build',
      'TobisComputer'
    ].join('\n');
    const literals = findBrandMatches(text).map((match: { literal: string }) => match.literal);
    expect(literals).toEqual([
      'Chat On Steroids', 'chat-on-steroids', 'ChatOnSteroids', 'chatonsteroids', 'CoS', 'COS', 'TobisComputer'
    ]);
  });

  it('leaves internal identifiers and unrelated words alone', () => {
    const text = [
      'COS_CONTEXT',
      'CLF_HANDOFF',
      'cos-context',
      'scope.CosI18n',
      'a cosmos of cost and cosy words',
      'ChatBBC'
    ].join('\n');
    expect(findBrandMatches(text)).toEqual([]);
  });

  it('reports a line number and the literal as it appears', () => {
    const matches = findBrandMatches('first\nsecond Chat On Steroids line\n');
    expect(matches).toEqual([{ literal: 'Chat On Steroids', line: 2 }]);
  });
});

describe('identity declarations', () => {
  it('covers the live product values that a rebrand cannot silently miss', () => {
    expect(IDENTITY_CHECKS.map((check: { id: string }) => check.id).sort()).toEqual([
      'app-slug-protocol', 'connector-titles', 'desktop-identity', 'extension-identity', 'package-identity'
    ]);
  });
});

describe('verify-rebrand command', () => {
  it('passes on the rebranded tree and reports the scanned file count', async () => {
    const result = run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/scanned \d+ files/);
  });

  it('fails when a source file keeps a predecessor name with no retainedIdentifiers entry', async () => {
    await writeTree(root, { 'src/main/legacy.ts': "export const NAME = 'Chat On Steroids';\n" });
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/src\/main\/legacy\.ts:1/);
    expect(result.stderr).toMatch(/Chat On Steroids/);
    expect(result.stderr).toMatch(/no retainedIdentifiers entry/);
  });

  it('accepts a residual match that the map excuses with a precise reason', async () => {
    await writeTree(root, { 'src/main/legacy.ts': "export const NAME = 'Chat On Steroids';\n" });
    await writeMap([{ path: 'src/main/legacy.ts', literal: 'Chat On Steroids', reason: RETAINED_REASON }]);
    const result = run();
    expect(result.status).toBe(0);
  });

  it('rejects an exception whose literal no longer occurs and one with no reason code', async () => {
    await writeMap([{ path: 'src/main/version.ts', literal: 'Chat On Steroids', reason: RETAINED_REASON }]);
    expect(run().stderr).toMatch(/no longer present/);
    await writeTree(root, { 'src/main/legacy.ts': "export const NAME = 'Chat On Steroids';\n" });
    await writeMap([{ path: 'src/main/legacy.ts', literal: 'Chat On Steroids', reason: 'just because' }]);
    expect(run().stderr).toMatch(/reason must start with/);
  });

  it('fails when a workflow file is tracked', async () => {
    await writeTree(root, { '.github/workflows/ci.yml': 'name: ci\n' });
    git('add', '-A');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\.github\/workflows\/ci\.yml/);
  });

  it('fails when a live identity declaration still names another product', async () => {
    await writeTree(root, {
      'package.json': JSON.stringify({ name: 'chat-on-steroids', version: '2.2.0', desktopName: 'com.chatbbc.app.desktop' })
    });
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/package\.json name/);
  });

  it('fails when the extension or bridge identity drifts from the app', async () => {
    await writeTree(root, {
      'extension/manifest.json': JSON.stringify({ version: '2.1.18' }),
      'extension/_locales/en/messages.json': JSON.stringify({ extension_name: { message: 'Companion' } })
    });
    const result = run();
    expect(result.stderr).toMatch(/extension\/manifest\.json version/);
    expect(result.stderr).toMatch(/extension_name/);
  });
});
