import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as releaseLocalModule from '../scripts/release-local.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { STAMP_FILE, extensionStamp } from '../scripts/write-extension-stamp.mjs';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

const {
  APPIMAGE_NAME,
  CANDIDATE_FILES,
  EXTENSION_ZIP_NAME,
  MANIFEST_NAME,
  NATIVE_SOURCES_NAME,
  SUMS_NAME,
  assertActionsDisabled,
  assertAppImagePayload,
  assertCleanSource,
  assertGzipPayload,
  assertMatchingProtocols,
  assertMatchingVersions,
  assertNoWorkflowFiles,
  assertSupportedHost,
  assembleCandidate,
  createRunner,
  parseArguments,
  publishRelease,
  readBridgeProtocols,
  readReleaseNotes,
  readRemoteTag,
  readSourceState,
  readUpstreamIdentity,
  readVersionDeclarations,
  runCandidate,
  sha256File,
  verifyCandidateSums,
  verifyCompanionArchive,
  verifyDownloadedAssets,
  writeCandidateSums,
  writeCompanionArchive
} = releaseLocalModule;

interface RunnerResult {
  status: number;
  stdout: string;
  stderr: string;
  error: Error | null;
}
type Runner = (command: string, args?: string[], options?: Record<string, unknown>) => RunnerResult;

const UPSTREAM_REPOSITORY = 'https://github.com/totec448-spec/chat-on-steroids';
const UPSTREAM_COMMIT = 'dee4b5e94b8598d7630e6db62bada9ac6050f457';
const UPSTREAM = { repository: UPSTREAM_REPOSITORY, commit: UPSTREAM_COMMIT, version: '2.1.18' };
const GIT_FLAGS = ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false'];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com'
};
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await makeTempDir(prefix);
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await removeTempDir(temporaryDirectories.pop() as string);
  }
});

function commitAll(root: string, message = 'fixture'): void {
  execFileSync('git', [...GIT_FLAGS, 'add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', [...GIT_FLAGS, 'commit', '-m', message], { cwd: root, env: GIT_ENV, stdio: 'ignore' });
}

function tagHead(root: string, tag: string): void {
  execFileSync('git', [...GIT_FLAGS, 'tag', '-a', tag, '-m', tag], { cwd: root, env: GIT_ENV });
}

function extensionTree(version = '2.2.0', protocol = 18): Record<string, string> {
  const chatgpt = { matches: ['https://chatgpt.com/*'] };
  const manifest = {
    manifest_version: 3,
    name: 'ChatBBC Companion',
    version,
    default_locale: 'en',
    permissions: ['storage'],
    background: { service_worker: 'background.js', type: 'module' },
    content_scripts: [
      { ...chatgpt, js: ['i18n.js', 'chatgpt-dom.js', 'content.js'], css: ['overlay.css'] },
      { ...chatgpt, js: ['fiber.js'], world: 'MAIN' },
      { ...chatgpt, js: ['usage.js'], world: 'MAIN' }
    ],
    icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } }
  };
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'background.js': `const BRIDGE_PROTOCOL = ${protocol};\n`,
    'content.js': 'content\n',
    'chatgpt-dom.js': 'dom\n',
    'fiber.js': 'fiber\n',
    'i18n.js': 'i18n\n',
    'overlay.css': 'body {}\n',
    'popup.css': 'body {}\n',
    'popup.html': '<!doctype html>\n',
    'popup.js': 'popup\n',
    'usage.js': 'usage\n',
    'content.js.map': 'never ships\n',
    'icons/icon16.png': 'i16',
    'icons/icon32.png': 'i32',
    'icons/icon48.png': 'i48',
    'icons/icon128.png': 'i128',
    '_locales/en/messages.json': '{"extension_name":{"message":"ChatBBC Companion"}}\n'
  };
}

/** 64-bit little-endian ELF header padded past the "did it actually build" floor. */
function elfX64(machine = 0x3e): Buffer {
  const buffer = Buffer.alloc(2 * 1024 * 1024);
  buffer.write('\u007fELF', 'binary');
  buffer[4] = 2;
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

interface Project {
  root: string;
  version: string;
  protocol: number;
  head: string;
  extensionDir: string;
  releaseDir: string;
}

async function createProject(version = '2.2.0', protocol = 18): Promise<Project> {
  const root = await temporaryDirectory('chatbbc-release-');
  const files: Record<string, string> = {
    '.gitignore': 'release/\nextension/build-stamp.txt\n',
    LICENSE: 'MIT License\n\nCopyright (c) 2026 TheBigBrainChad\n',
    'package.json': `${JSON.stringify({ name: 'chatbbc', version, private: true }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(
      { name: 'chatbbc', version, packages: { '': { name: 'chatbbc', version } } },
      null,
      2
    )}\n`,
    'src/main/version.ts': `export const APP_VERSION = '${version}';\nexport const BRIDGE_PROTOCOL = ${protocol};\n`,
    'docs/upstream-map.json': `${JSON.stringify(
      { schemaVersion: 1, upstream: UPSTREAM, downstream: { repository: 'https://github.com/TheBigBrainChad/chatbbc', version } },
      null,
      2
    )}\n`,
    [`docs/release-notes/v${version}.md`]: `## ${version} ChatBBC local release\n\nThis release ships ${version} for Linux x64.\n`,
    'node_modules/electron/package.json': '{"name":"electron","version":"44.3.0"}\n'
  };
  for (const [name, content] of Object.entries(extensionTree(version, protocol))) {
    files[`extension/${name}`] = content;
  }
  await writeTree(root, files);
  const extensionDir = path.join(root, 'extension');
  fs.writeFileSync(path.join(extensionDir, STAMP_FILE), `${extensionStamp(extensionDir)}\n`);
  execFileSync('git', [...GIT_FLAGS, 'init'], { cwd: root, stdio: 'ignore' });
  commitAll(root);
  const releaseDir = path.join(root, 'release');
  await fsp.mkdir(releaseDir, { recursive: true });
  const head = execFileSync('git', [...GIT_FLAGS, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, version, protocol, head, extensionDir, releaseDir };
}

interface Payloads {
  appImage: Buffer;
  extension: Buffer;
  nativeSources: Buffer;
}

async function buildPayloads(project: Project, machine = 0x3e): Promise<Payloads> {
  const scratch = await temporaryDirectory('chatbbc-payload-');
  const archive = path.join(scratch, EXTENSION_ZIP_NAME);
  await writeCompanionArchive({ root: project.root, directory: project.extensionDir, outFile: archive });
  return {
    appImage: elfX64(machine),
    extension: fs.readFileSync(archive),
    nativeSources: zlib.gzipSync(Buffer.from('native sources\n'))
  };
}

function seedRelease(project: Project, payloads: Payloads): void {
  fs.writeFileSync(path.join(project.releaseDir, APPIMAGE_NAME), payloads.appImage);
  fs.writeFileSync(path.join(project.releaseDir, EXTENSION_ZIP_NAME), payloads.extension);
  fs.writeFileSync(path.join(project.releaseDir, NATIVE_SOURCES_NAME), payloads.nativeSources);
}

interface ScriptedRunner {
  root: string;
  payloads?: Payloads;
  downloadTamper?: (name: string, bytes: Buffer) => Buffer;
  originUrl?: string;
}

/** Real git, scripted npm/node/gh: the pipeline's ordering and the publication handshake. */
function scriptedRunner(options: ScriptedRunner): { run: Runner; commands: string[] } {
  const commands: string[] = [];
  const real = createRunner({ cwd: options.root, log: () => {} }) as Runner;
  const run: Runner = (command, args = [], spawnOptions = {}) => {
    if (command === 'git' && args.join(' ') === 'remote get-url origin') {
      return { status: 0, stdout: `${options.originUrl ?? 'https://github.com/TheBigBrainChad/chatbbc.git'}\n`, stderr: '', error: null };
    }
    if (command === 'git') return real(command, args, { ...spawnOptions, capture: true });
    const line = [command, ...args].join(' ');
    commands.push(line);
    const writePayload = (name: string, bytes: Buffer) => {
      fs.mkdirSync(path.join(options.root, 'release'), { recursive: true });
      fs.writeFileSync(path.join(options.root, 'release', name), bytes);
    };
    if (options.payloads) {
      if (line === 'npm run dist:linux:x64') writePayload(APPIMAGE_NAME, options.payloads.appImage);
      if (line === 'node scripts/release-local.mjs --companion-archive') {
        writePayload(EXTENSION_ZIP_NAME, options.payloads.extension);
      }
      if (line === 'node scripts/package-native-sources.mjs') {
        writePayload(NATIVE_SOURCES_NAME, options.payloads.nativeSources);
      }
    }
    if (line === 'gh auth token') return { status: 0, stdout: 'fixture-token\n', stderr: '', error: null };
    if (line.startsWith('gh release download')) {
      const target = args[args.indexOf('--dir') + 1];
      if (!target) throw new Error('scripted gh download needs a --dir');
      const candidates = fs
        .readdirSync(path.join(options.root, 'release', 'candidates'))
        .filter((name) => !name.startsWith('.'));
      const candidateDirectory = path.join(options.root, 'release', 'candidates', candidates[0] as string);
      for (const name of CANDIDATE_FILES) {
        const bytes = fs.readFileSync(path.join(candidateDirectory, name));
        fs.writeFileSync(path.join(target, name), options.downloadTamper?.(name, bytes) ?? bytes);
      }
    }
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  return { run, commands };
}

interface GithubState {
  actionsEnabled?: boolean | null;
  releaseStatus?: number;
}

function githubFetch(state: GithubState = {}) {
  const fetchImpl = async (url: string) => {
    if (url.includes('/actions/permissions')) {
      if (state.actionsEnabled === null) {
        return { ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ enabled: state.actionsEnabled ?? false }) };
    }
    const status = state.releaseStatus ?? 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status === 404 ? '' : 'release lookup failed'),
      json: async () => ({})
    };
  };
  return { fetchImpl };
}

interface CandidateManifest {
  schemaVersion: number;
  version: string;
  tag: string;
  bridgeProtocol: number;
  buildUuid: string;
  builtAt: string;
  target: { platform: string; arch: string };
  runtime: { node: string; electron: string };
  source: { headSha: string; upstreamRepository: string; upstreamCommit: string; upstreamVersion: string | null };
  artifacts: { name: string; bytes: number; sha256: string }[];
  checks: { id: string; command: string; status: string }[];
  manualAcceptance: { claimed: boolean; pending: string[] };
}

function readCandidateManifest(directory: string): CandidateManifest {
  return JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_NAME), 'utf8')) as CandidateManifest;
}

function assembleArguments(project: Project, buildUuid: string, checks: CandidateManifest['checks'] = []) {
  return {
    root: project.root,
    version: project.version,
    headSha: project.head,
    upstream: UPSTREAM,
    protocol: project.protocol,
    electron: '44.3.0',
    buildUuid,
    builtAt: '2026-09-28T00:00:00.000Z',
    checks
  };
}

describe('release preflight gates', () => {
  it('refuses hosts and targets other than Linux x64', () => {
    expect(() => assertSupportedHost({ platform: 'darwin', arch: 'x64' })).toThrow(/Linux x64/);
    expect(() => assertSupportedHost({ platform: 'linux', arch: 'arm64' })).toThrow(/Linux x64/);
    expect(() => assertSupportedHost({ platform: 'linux', arch: 'x64' })).not.toThrow();
  });

  it('requires five agreeing version declarations', async () => {
    const root = await temporaryDirectory('chatbbc-versions-');
    await writeTree(root, {
      'package.json': '{"version":"2.2.0"}\n',
      'package-lock.json': '{"version":"2.2.0","packages":{"":{"version":"2.2.0"}}}\n',
      'extension/manifest.json': '{"version":"2.2.0"}\n',
      'src/main/version.ts': "export const APP_VERSION = '2.2.0';\n"
    });
    const { version, declarations } = readVersionDeclarations({ root });
    expect(version).toBe('2.2.0');
    expect(declarations).toHaveLength(5);
    expect(() => assertMatchingVersions({ version, declarations })).not.toThrow();

    await fsp.writeFile(path.join(root, 'extension', 'manifest.json'), '{"version":"2.2.1"}\n');
    expect(() => assertMatchingVersions(readVersionDeclarations({ root }))).toThrow(/extension\/manifest\.json=2\.2\.1/);

    await fsp.writeFile(path.join(root, 'src', 'main', 'version.ts'), 'export const BRIDGE_PROTOCOL = 18;\n');
    expect(() => assertMatchingVersions(readVersionDeclarations({ root }))).toThrow(
      /src\/main\/version\.ts APP_VERSION/
    );
  });

  it('requires the app and the companion to agree on the bridge protocol', async () => {
    const root = await temporaryDirectory('chatbbc-protocol-');
    await writeTree(root, {
      'src/main/version.ts': 'export const BRIDGE_PROTOCOL = 18;\n',
      'extension/background.js': 'const BRIDGE_PROTOCOL = 18;\n'
    });
    expect(assertMatchingProtocols(readBridgeProtocols({ root }))).toBe(18);

    await fsp.writeFile(path.join(root, 'extension', 'background.js'), 'const BRIDGE_PROTOCOL = 17;\n');
    expect(() => assertMatchingProtocols(readBridgeProtocols({ root }))).toThrow(/background\.js=17/);

    await fsp.writeFile(path.join(root, 'extension', 'background.js'), 'const nothing = 1;\n');
    expect(() => assertMatchingProtocols(readBridgeProtocols({ root }))).toThrow(/one positive integer/);
  });

  it('requires reviewed release notes that name the version being released', async () => {
    const root = await temporaryDirectory('chatbbc-notes-');
    const notes = path.join(root, 'docs', 'release-notes', 'v2.2.0.md');
    await writeTree(root, { 'docs/release-notes/v2.2.0.md': '## 2.2.0 ChatBBC\n\nShips 2.2.0.\n' });
    expect(readReleaseNotes({ root, version: '2.2.0' }).title).toBe('2.2.0 ChatBBC');
    expect(() => readReleaseNotes({ root, version: '2.2.1' })).toThrow(/Missing reviewed release notes/);

    await fsp.writeFile(notes, '   \n');
    expect(() => readReleaseNotes({ root, version: '2.2.0' })).toThrow(/is empty/);

    await fsp.writeFile(notes, '2.2.0 without a title\n');
    expect(() => readReleaseNotes({ root, version: '2.2.0' })).toThrow(/no "## " title line/);

    await fsp.writeFile(notes, '## 2.1.18 reused\n\nOld notes.\n');
    expect(() => readReleaseNotes({ root, version: '2.2.0' })).toThrow(/never names version 2\.2\.0/);
  });

  it('requires a port map that names a real upstream commit', async () => {
    const root = await temporaryDirectory('chatbbc-upstream-');
    await writeTree(root, { 'docs/upstream-map.json': `${JSON.stringify({ upstream: UPSTREAM })}\n` });
    expect(readUpstreamIdentity({ root }).commit).toBe(UPSTREAM_COMMIT);

    await fsp.writeFile(path.join(root, 'docs', 'upstream-map.json'), '{"upstream":{"repository":"x","commit":"main"}}\n');
    expect(() => readUpstreamIdentity({ root })).toThrow(/upstream\.repository/);
    await fsp.writeFile(
      path.join(root, 'docs', 'upstream-map.json'),
      `{"upstream":{"repository":"${UPSTREAM_REPOSITORY}","commit":"main"}}\n`
    );
    expect(() => readUpstreamIdentity({ root })).toThrow(/upstream\.commit/);
  });

  it('refuses a dirty tree and any hosted workflow file', async () => {
    const root = await temporaryDirectory('chatbbc-clean-');
    await writeTree(root, { 'README.md': 'clean\n' });
    execFileSync('git', [...GIT_FLAGS, 'init'], { cwd: root, stdio: 'ignore' });
    commitAll(root);
    const runner = createRunner({ cwd: root, log: () => {} }) as Runner;
    expect(() => assertCleanSource(readSourceState(runner))).not.toThrow();

    await fsp.writeFile(path.join(root, 'README.md'), 'dirty\n');
    expect(() => assertCleanSource(readSourceState(runner))).toThrow(/clean tree/);

    await writeTree(root, { '.github/workflows/ci.yml': 'name: ci\n' });
    expect(() => assertNoWorkflowFiles({ run: runner, changes: readSourceState(runner).changes })).toThrow(
      /\.github\/workflows\/ci\.yml/
    );

    await fsp.rm(path.join(root, '.github'), { recursive: true, force: true });
    await fsp.writeFile(path.join(root, 'README.md'), 'clean\n');
    await writeTree(root, { '.github/workflows/release.yml': 'name: release\n' });
    commitAll(root, 'a landed workflow');
    const tracked = readSourceState(runner);
    expect(() => assertCleanSource(tracked)).not.toThrow();
    expect(() => assertNoWorkflowFiles({ run: runner, changes: tracked.changes })).toThrow(
      /\.github\/workflows\/release\.yml/
    );
  });
});

describe('companion archive', () => {
  it('ships every companion file, the LICENSE and the reviewed stamp, and no source maps', async () => {
    const project = await createProject();
    const outFile = path.join(await temporaryDirectory('chatbbc-archive-'), EXTENSION_ZIP_NAME);
    const result = await writeCompanionArchive({ root: project.root, directory: project.extensionDir, outFile });

    const names = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(outFile))));
    expect(names).toContain('manifest.json');
    expect(names).toContain('LICENSE');
    expect(names).toContain('_locales/en/messages.json');
    expect(names).toContain(STAMP_FILE);
    expect(names).not.toContain('content.js.map');
    expect(result.protocol).toBe(project.protocol);
    expect(result.stamp).toBe(fs.readFileSync(path.join(project.extensionDir, STAMP_FILE), 'utf8').trim());
  });

  it('detects a missing file, a source map, a foreign protocol, a version drift, a stray entry and a stale stamp', async () => {
    const project = await createProject();
    const scratch = await temporaryDirectory('chatbbc-archive-');
    const good = path.join(scratch, 'good.zip');
    await writeCompanionArchive({ root: project.root, directory: project.extensionDir, outFile: good });
    const goodBytes = fs.readFileSync(good);
    const verifyBytes = (bytes: Buffer) =>
      verifyCompanionArchive({
        archive: bytes,
        directory: project.extensionDir,
        version: project.version,
        protocol: project.protocol
      });
    const rebuilt = (mutate: (entries: Record<string, Uint8Array>) => void) => {
      const entries = unzipSync(new Uint8Array(goodBytes));
      mutate(entries);
      return Buffer.from(zipSync(entries, { level: 6 }));
    };

    expect(() => verifyBytes(goodBytes)).not.toThrow();
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          delete entries['popup.js'];
        })
      )
    ).toThrow(/missing popup\.js/);
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          entries['stray.map'] = new TextEncoder().encode('x');
        })
      )
    ).toThrow(/must not carry source maps/);
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          entries['background.js'] = new TextEncoder().encode('const BRIDGE_PROTOCOL = 17;\n');
        })
      )
    ).toThrow(/bridge protocol 17 does not match app protocol 18/);
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
          manifest.version = '2.2.1';
          entries['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
        })
      )
    ).toThrow(/manifest version 2\.2\.1 does not match app 2\.2\.0/);
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          delete entries['LICENSE'];
        })
      )
    ).toThrow(/missing the MIT LICENSE/);
    expect(() =>
      verifyBytes(
        rebuilt((entries) => {
          entries['extra.js'] = new TextEncoder().encode('x');
        })
      )
    ).toThrow(/carries files that are not in the companion/);

    await fsp.writeFile(path.join(project.extensionDir, 'content.js'), 'content changed after archiving\n');
    expect(() => verifyBytes(goodBytes)).toThrow(/does not describe the shipped files/);
  });
});

describe('payload evidence', () => {
  it('accepts a Linux x64 AppImage and rejects anything else before it can be named x64', async () => {
    const directory = await temporaryDirectory('chatbbc-payloads-');
    const good = path.join(directory, APPIMAGE_NAME);
    fs.writeFileSync(good, elfX64());
    expect(assertAppImagePayload(good).bytes).toBeGreaterThan(1024 * 1024);

    const arm64 = path.join(directory, 'arm64.AppImage');
    fs.writeFileSync(arm64, elfX64(0xb7));
    expect(() => assertAppImagePayload(arm64)).toThrow(/not x86-64/);

    const fake = path.join(directory, 'fake.AppImage');
    fs.writeFileSync(fake, Buffer.alloc(2 * 1024 * 1024, 0x41));
    expect(() => assertAppImagePayload(fake)).toThrow(/not an ELF binary/);

    const stub = path.join(directory, 'stub.AppImage');
    fs.writeFileSync(stub, elfX64().subarray(0, 4096));
    expect(() => assertAppImagePayload(stub)).toThrow(/did not build/);
  });

  it('requires a gzip native-source archive', async () => {
    const directory = await temporaryDirectory('chatbbc-native-');
    const good = path.join(directory, NATIVE_SOURCES_NAME);
    fs.writeFileSync(good, zlib.gzipSync(Buffer.from('sources')));
    expect(assertGzipPayload(good).bytes).toBeGreaterThan(0);
    const plain = path.join(directory, 'plain.tar.gz');
    fs.writeFileSync(plain, Buffer.from('not gzip'));
    expect(() => assertGzipPayload(plain)).toThrow(/not a gzip archive/);
  });

  it('records digests that must read back, and refuses a payload that changed after hashing', async () => {
    const directory = await temporaryDirectory('chatbbc-sums-');
    const names = ['a.bin', 'b.bin'];
    for (const name of names) fs.writeFileSync(path.join(directory, name), `${name}\n`);
    await writeCandidateSums({ directory, names });
    await expect(verifyCandidateSums({ directory, names })).resolves.toHaveLength(2);

    fs.writeFileSync(path.join(directory, 'a.bin'), 'tampered\n');
    await expect(verifyCandidateSums({ directory, names })).rejects.toThrow(/does not match its recorded SHA-256/);

    fs.writeFileSync(path.join(directory, 'a.bin'), 'a.bin\n');
    await writeCandidateSums({ directory, names: ['a.bin'] });
    await expect(verifyCandidateSums({ directory, names })).rejects.toThrow(/does not record b\.bin/);
  });

  it('compares a re-downloaded release against the tested candidate', async () => {
    const local = await temporaryDirectory('chatbbc-local-');
    const remote = await temporaryDirectory('chatbbc-remote-');
    const names = ['one.bin', 'two.bin'];
    for (const name of names) {
      fs.writeFileSync(path.join(local, name), `${name}-tested\n`);
      fs.writeFileSync(path.join(remote, name), `${name}-tested\n`);
    }
    await expect(verifyDownloadedAssets({ localDirectory: local, downloadDirectory: remote, names })).resolves.toEqual(names);

    fs.writeFileSync(path.join(remote, 'two.bin'), 'different\n');
    await expect(verifyDownloadedAssets({ localDirectory: local, downloadDirectory: remote, names })).rejects.toThrow(
      /not the tested/
    );
    fs.writeFileSync(path.join(remote, 'two.bin'), 'two.bin-tested\n');

    fs.rmSync(path.join(remote, 'one.bin'));
    await expect(verifyDownloadedAssets({ localDirectory: local, downloadDirectory: remote, names })).rejects.toThrow(
      /missing one\.bin/
    );
    fs.writeFileSync(path.join(remote, 'one.bin'), 'one.bin-tested\n');
    fs.writeFileSync(path.join(remote, 'extra.bin'), 'extra\n');
    await expect(verifyDownloadedAssets({ localDirectory: local, downloadDirectory: remote, names })).rejects.toThrow(
      /unexpected asset/
    );
  });
});

describe('candidate assembly', () => {
  it('stages exactly the five candidate files beside a verified manifest, and never adopts leftovers', async () => {
    const project = await createProject();
    const payloads = await buildPayloads(project);
    seedRelease(project, payloads);
    fs.writeFileSync(path.join(project.releaseDir, 'ChatBBC-Linux-arm64.AppImage'), elfX64(0xb7));
    fs.writeFileSync(path.join(project.releaseDir, SUMS_NAME), 'stale sums from an earlier release\n');

    const checks = [{ id: 'verify', command: 'npm run verify', status: 'passed' }];
    const candidate = await assembleCandidate(assembleArguments(project, 'fixture-uuid', checks));

    expect(path.basename(candidate.path)).toBe(`v${project.version}-${project.head.slice(0, 12)}-fixture-uuid`);
    expect(fs.readdirSync(candidate.path).sort()).toEqual([...CANDIDATE_FILES].sort());
    const manifest = readCandidateManifest(candidate.path);
    expect(manifest.version).toBe(project.version);
    expect(manifest.tag).toBe(`v${project.version}`);
    expect(manifest.source.headSha).toBe(project.head);
    expect(manifest.source.upstreamCommit).toBe(UPSTREAM_COMMIT);
    expect(manifest.target).toEqual({ platform: 'linux', arch: 'x64' });
    expect(manifest.runtime).toEqual({ node: process.version, electron: '44.3.0' });
    expect(manifest.bridgeProtocol).toBe(project.protocol);
    expect(manifest.buildUuid).toBe('fixture-uuid');
    expect(manifest.builtAt).toBe('2026-09-28T00:00:00.000Z');
    expect(manifest.checks).toEqual(checks);
    expect(manifest.manualAcceptance.claimed).toBe(false);
    expect(manifest.manualAcceptance.pending.length).toBeGreaterThan(0);
    expect(manifest.artifacts.map((entry) => entry.name)).toEqual([APPIMAGE_NAME, EXTENSION_ZIP_NAME, NATIVE_SOURCES_NAME]);
    for (const artifact of manifest.artifacts) {
      expect(artifact.sha256).toBe(await sha256File(path.join(candidate.path, artifact.name)));
      expect(artifact.bytes).toBe(fs.statSync(path.join(candidate.path, artifact.name)).size);
    }
    const sums = fs.readFileSync(path.join(candidate.path, SUMS_NAME), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(4);
    expect(sums.join('\n')).not.toContain('arm64');

    // A rerun at the same commit under the same UUID is a second attempt at the same evidence.
    const before = await sha256File(path.join(candidate.path, APPIMAGE_NAME));
    await expect(assembleCandidate(assembleArguments(project, 'fixture-uuid', checks))).rejects.toThrow(/already exists/);
    expect(await sha256File(path.join(candidate.path, APPIMAGE_NAME))).toBe(before);
  });

  it('fails on a missing or non-x64 payload instead of staging a wrong candidate', async () => {
    const project = await createProject();
    await expect(assembleCandidate(assembleArguments(project, 'missing'))).rejects.toThrow(
      /Missing release\/ChatBBC-Linux-x64\.AppImage/
    );

    seedRelease(project, await buildPayloads(project, 0xb7));
    await expect(assembleCandidate(assembleArguments(project, 'arm'))).rejects.toThrow(/not x86-64/);
    expect(fs.readdirSync(path.join(project.root, 'release', 'candidates'))).toContain('.staging-arm');
  });
});

describe('candidate pipeline', () => {
  it('refuses an unsupported host before running any step', async () => {
    const project = await createProject();
    const { run, commands } = scriptedRunner({ root: project.root });
    await expect(
      runCandidate({ root: project.root, run, log: () => {}, host: { platform: 'win32', arch: 'x64' } })
    ).rejects.toThrow(/Linux x64/);
    expect(commands).toEqual([]);
  });

  it('stops on a dirty tree, a landed workflow or a disagreeing version before building', async () => {
    const project = await createProject();
    await fsp.writeFile(path.join(project.root, 'package.json'), '{"name":"chatbbc","version":"2.2.0","private":false}\n');
    const dirty = scriptedRunner({ root: project.root });
    await expect(runCandidate({ root: project.root, run: dirty.run, log: () => {} })).rejects.toThrow(/clean tree/);
    expect(dirty.commands).toEqual([]);

    await fsp.writeFile(path.join(project.root, 'package.json'), '{"name":"chatbbc","version":"2.2.1","private":true}\n');
    commitAll(project.root, 'version drift');
    const drifted = scriptedRunner({ root: project.root });
    await expect(runCandidate({ root: project.root, run: drifted.run, log: () => {} })).rejects.toThrow(
      /versions disagree/
    );
    expect(drifted.commands).toEqual([]);

    await fsp.writeFile(path.join(project.root, 'package.json'), '{"name":"chatbbc","version":"2.2.0","private":true}\n');
    await writeTree(project.root, { '.github/workflows/ci.yml': 'name: ci\n' });
    commitAll(project.root, 'workflow landed');
    const workflow = scriptedRunner({ root: project.root });
    await expect(runCandidate({ root: project.root, run: workflow.run, log: () => {} })).rejects.toThrow(
      /\.github\/workflows\/ci\.yml/
    );

    await fsp.rm(path.join(project.root, '.github'), { recursive: true, force: true });
    await fsp.rm(path.join(project.root, 'docs', 'release-notes', 'v2.2.0.md'));
    commitAll(project.root, 'drop notes');
    const notes = scriptedRunner({ root: project.root });
    await expect(runCandidate({ root: project.root, run: notes.run, log: () => {} })).rejects.toThrow(
      /Missing reviewed release notes/
    );
  });

  it('runs the documented owners in order and finalizes one candidate', async () => {
    const project = await createProject();
    const { run, commands } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project) });

    const candidate = await runCandidate({
      root: project.root,
      run,
      log: () => {},
      buildUuid: 'pipeline-uuid',
      builtAt: '2026-09-28T00:00:00.000Z'
    });

    expect(commands).toEqual([
      'node scripts/write-extension-stamp.mjs',
      'node scripts/make-icon.mjs',
      'npm run verify',
      'npm run dist:linux:x64',
      'npm run verify:ui',
      'node scripts/verify-chatbbc-package.mjs',
      'node scripts/release-local.mjs --companion-archive',
      'node scripts/package-native-sources.mjs'
    ]);
    expect(commands.some((line) => line.startsWith('git push') || line.startsWith('gh '))).toBe(false);
    expect(fs.readdirSync(candidate.path).sort()).toEqual([...CANDIDATE_FILES].sort());
    const manifest = readCandidateManifest(candidate.path);
    expect(manifest.buildUuid).toBe('pipeline-uuid');
    expect(manifest.source.headSha).toBe(project.head);
    expect(manifest.checks.map((entry) => entry.id)).toEqual([
      'regenerate-extension-stamp',
      'regenerate-icons',
      'verify',
      'dist-linux-x64',
      'verify-ui',
      'packaged-gui-smoke',
      'companion-archive',
      'native-sources',
      'source-still-clean'
    ]);
    expect(manifest.checks.every((entry) => entry.status === 'passed')).toBe(true);
  });

  it('refuses a candidate whose build dirtied the tree it names', async () => {
    const project = await createProject();
    const { run } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project) });
    const dirtying: Runner = (command, args = [], spawnOptions = {}) => {
      if (command === 'npm' && args.join(' ') === 'run verify:ui') {
        fs.writeFileSync(path.join(project.root, 'src', 'main', 'version.ts'), '// rewritten during the UI run\n');
      }
      return run(command, args, spawnOptions);
    };
    await expect(runCandidate({ root: project.root, run: dirtying, log: () => {} })).rejects.toThrow(
      /would not describe/
    );
    expect(fs.existsSync(path.join(project.root, 'release', 'candidates'))).toBe(false);
  });

  it('fails when regenerating the stamp or icons changes a tracked file', async () => {
    const project = await createProject();
    const { run, commands } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project) });
    const drifting: Runner = (command, args = [], spawnOptions = {}) => {
      if (command === 'node' && args[0] === 'scripts/make-icon.mjs') {
        fs.writeFileSync(path.join(project.extensionDir, 'icons', 'icon16.png'), 'regenerated differently');
      }
      return run(command, args, spawnOptions);
    };
    await expect(runCandidate({ root: project.root, run: drifting, log: () => {} })).rejects.toThrow(
      /icons changed tracked files: extension\/icons\/icon16\.png/
    );
    expect(commands).toContain('node scripts/make-icon.mjs');
    expect(commands).not.toContain('npm run verify');
  });
});

describe('explicit publication', () => {
  it('needs an explicit tag that matches the version and a clean tree', async () => {
    const project = await createProject();
    const { run, commands } = scriptedRunner({ root: project.root });
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: undefined })).rejects.toThrow(
      /--tag v2\.2\.0/
    );
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.1' })).rejects.toThrow(
      /does not match app version/
    );
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0' })).rejects.toThrow(
      /never creates or moves a tag/
    );

    tagHead(project.root, 'v2.2.0');
    await fsp.writeFile(path.join(project.root, 'README.md'), 'dirty\n');
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0' })).rejects.toThrow(/clean tree/);
    await fsp.rm(path.join(project.root, 'README.md'));

    await fsp.writeFile(path.join(project.root, 'untracked.txt'), 'x\n');
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0' })).rejects.toThrow(/clean tree/);
    await fsp.rm(path.join(project.root, 'untracked.txt'));
    expect(commands.filter((line) => line.startsWith('gh release'))).toEqual([]);
  });

  it('refuses a local tag that points somewhere other than HEAD', async () => {
    const project = await createProject();
    tagHead(project.root, 'v2.2.0');
    await fsp.writeFile(path.join(project.root, 'later.txt'), 'later\n');
    commitAll(project.root, 'later commit');
    const moved = execFileSync('git', [...GIT_FLAGS, 'rev-parse', 'HEAD'], {
      cwd: project.root,
      encoding: 'utf8'
    }).trim();
    const { run, commands } = scriptedRunner({ root: project.root });
    await expect(publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0' })).rejects.toThrow(
      new RegExp(`points at .*not HEAD ${moved}`)
    );
    expect(commands).toEqual([]);
  });

  it('does not publish while repository Actions are enabled or their state is unknown', async () => {
    const project = await createProject();
    tagHead(project.root, 'v2.2.0');
    const payloads = await buildPayloads(project);
    const enabled = scriptedRunner({ root: project.root, payloads });
    await expect(
      publishRelease({
        root: project.root,
        run: enabled.run,
        log: () => {},
        tag: 'v2.2.0',
        fetchImpl: githubFetch({ actionsEnabled: true }).fetchImpl
      })
    ).rejects.toThrow(/Actions are enabled/);

    const unknown = scriptedRunner({ root: project.root, payloads });
    await expect(
      publishRelease({
        root: project.root,
        run: unknown.run,
        log: () => {},
        tag: 'v2.2.0',
        fetchImpl: githubFetch({ actionsEnabled: null }).fetchImpl
      })
    ).rejects.toThrow(/HTTP 403/);
    expect(enabled.commands.concat(unknown.commands).filter((line) => line.startsWith('gh release create'))).toEqual([]);
  });

  it('refuses publication when origin names a different repository than the preflight target', async () => {
    const project = await createProject();
    const remote = await temporaryDirectory('chatbbc-foreign-');
    execFileSync('git', [...GIT_FLAGS, 'init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', [...GIT_FLAGS, 'remote', 'add', 'origin', remote], { cwd: project.root });
    tagHead(project.root, 'v2.2.0');
    const { run, commands } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project), originUrl: remote });
    await expect(
      publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0', fetchImpl: githubFetch().fetchImpl })
    ).rejects.toThrow(/origin.*repository/);
    expect(commands).not.toContain('npm run verify:tunnel-current');
    expect(readRemoteTag({ run, tag: 'v2.2.0' }).sha).toBeNull();
  });

  it('validates the Actions probe and treats a release API failure as unknown, not absent', async () => {
    await expect(
      assertActionsDisabled({ repository: 'a/b', token: 't', fetchImpl: githubFetch().fetchImpl })
    ).resolves.toEqual({ enabled: false });
    await expect(
      assertActionsDisabled({ repository: 'a/b', token: '', fetchImpl: githubFetch().fetchImpl })
    ).rejects.toThrow(/token is required/);
    await expect(
      assertActionsDisabled({ repository: '', token: 't', fetchImpl: githubFetch().fetchImpl })
    ).rejects.toThrow(/missing or invalid/);
    await expect(
      assertActionsDisabled({ repository: 'a/b', token: 't', fetchImpl: githubFetch({ actionsEnabled: null }).fetchImpl })
    ).rejects.toThrow(/HTTP 403/);
  });

  it('refuses an existing release and never treats an API failure as absence', async () => {
    const project = await createProject();
    const remote = await temporaryDirectory('chatbbc-remote-');
    execFileSync('git', [...GIT_FLAGS, 'init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', [...GIT_FLAGS, 'remote', 'add', 'origin', remote], { cwd: project.root });
    tagHead(project.root, 'v2.2.0');

    for (const status of [200, 401, 500]) {
      const { run, commands } = scriptedRunner({ root: project.root });
      await expect(
        publishRelease({
          root: project.root,
          run,
          log: () => {},
          tag: 'v2.2.0',
          fetchImpl: githubFetch({ releaseStatus: status }).fetchImpl
        })
      ).rejects.toThrow(status === 200 ? /already exists/ : new RegExp(`HTTP ${status}`));
      expect(commands.some((line) => line.startsWith('gh release create'))).toBe(false);
      expect(commands).not.toContain('npm run verify:tunnel-current');
    }
  });

  it('refuses to move a remote tag that names another commit, and never forces one', async () => {
    const project = await createProject();
    const remote = await temporaryDirectory('chatbbc-remote-');
    execFileSync('git', [...GIT_FLAGS, 'init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', [...GIT_FLAGS, 'remote', 'add', 'origin', remote], { cwd: project.root });
    tagHead(project.root, 'v2.2.0');
    execFileSync('git', [...GIT_FLAGS, 'push', 'origin', 'refs/tags/v2.2.0'], { cwd: project.root, stdio: 'ignore' });
    const reader = createRunner({ cwd: project.root, log: () => {} }) as Runner;
    const published = readRemoteTag({ run: reader, tag: 'v2.2.0' });

    await fsp.writeFile(path.join(project.root, 'later.txt'), 'later\n');
    commitAll(project.root, 'later');
    execFileSync('git', [...GIT_FLAGS, 'tag', '-f', '-a', 'v2.2.0', '-m', 'moved'], { cwd: project.root, env: GIT_ENV });
    const { run } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project) });
    await expect(
      publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0', fetchImpl: githubFetch().fetchImpl })
    ).rejects.toThrow(/Remote tag v2\.2\.0 points at/);
    expect(readRemoteTag({ run: reader, tag: 'v2.2.0' }).sha).toBe(published.sha);
  });

  it('builds, pushes the absent tag, uploads a draft, re-downloads the same bytes, then undrafts', async () => {
    const project = await createProject();
    const remote = await temporaryDirectory('chatbbc-remote-');
    execFileSync('git', [...GIT_FLAGS, 'init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', [...GIT_FLAGS, 'remote', 'add', 'origin', remote], { cwd: project.root });
    tagHead(project.root, 'v2.2.0');
    const { run, commands } = scriptedRunner({ root: project.root, payloads: await buildPayloads(project) });

    const result = await publishRelease({
      root: project.root,
      run,
      log: () => {},
      tag: 'v2.2.0',
      fetchImpl: githubFetch().fetchImpl,
      buildUuid: 'publish-uuid',
      builtAt: '2026-09-28T00:00:00.000Z'
    });

    const candidateDirectory = path.join(
      project.root,
      'release',
      'candidates',
      `v2.2.0-${project.head.slice(0, 12)}-publish-uuid`
    );
    expect(result.candidate.path).toBe(candidateDirectory);
    expect(result.candidate.manifest.buildUuid).toBe('publish-uuid');
    const created = commands.find((line) => line.startsWith('gh release create'));
    expect(created).toBeDefined();
    expect(created).toContain('--draft');
    expect(created).toContain('--verify-tag');
    expect(created).toContain('--repo TheBigBrainChad/chatbbc');
    for (const name of CANDIDATE_FILES) expect(created).toContain(path.join(candidateDirectory, name));
    const download = commands.findIndex((line) => line.startsWith('gh release download v2.2.0 --dir '));
    expect(download).toBeGreaterThan(-1);
    expect(commands[commands.length - 1]).toBe('gh release edit v2.2.0 --draft=false --repo TheBigBrainChad/chatbbc');
    expect(download).toBeLessThan(commands.length - 1);
    expect(commands.filter((line) => line.startsWith('npm run verify:tunnel-current'))).toHaveLength(2);
    expect(commands.indexOf('npm run verify:tunnel-current')).toBeLessThan(
      commands.findIndex((line) => line.startsWith('gh release create'))
    );
    const reader = createRunner({ cwd: project.root, log: () => {} }) as Runner;
    expect(readRemoteTag({ run: reader, tag: 'v2.2.0' }).sha).toBe(project.head);
  });

  it('leaves the draft in place when the uploaded bytes are not the tested bytes', async () => {
    const project = await createProject();
    const remote = await temporaryDirectory('chatbbc-remote-');
    execFileSync('git', [...GIT_FLAGS, 'init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', [...GIT_FLAGS, 'remote', 'add', 'origin', remote], { cwd: project.root });
    tagHead(project.root, 'v2.2.0');
    const { run, commands } = scriptedRunner({
      root: project.root,
      payloads: await buildPayloads(project),
      downloadTamper: (name, bytes) =>
        name === APPIMAGE_NAME ? Buffer.concat([bytes, Buffer.from('tampered')]) : bytes
    });

    await expect(
      publishRelease({ root: project.root, run, log: () => {}, tag: 'v2.2.0', fetchImpl: githubFetch().fetchImpl })
    ).rejects.toThrow(/not the tested/);
    expect(commands.some((line) => line.startsWith('gh release create'))).toBe(true);
    expect(commands).not.toContain('gh release edit v2.2.0 --draft=false');
  });
});

describe('command line', () => {
  it('rejects unknown or misplaced options', () => {
    expect(parseArguments(['--publish', '--tag', 'v2.2.0'])).toEqual({
      publish: true,
      companionArchive: false,
      tag: 'v2.2.0'
    });
    expect(parseArguments(['--companion-archive'])).toEqual({ publish: false, companionArchive: true, tag: undefined });
    expect(() => parseArguments(['--tags', 'v2.2.0'])).toThrow(/Unknown option/);
    expect(() => parseArguments(['--tag'])).toThrow(/needs a value/);
    expect(() => parseArguments(['v2.2.0'])).toThrow(/Unexpected argument/);
  });

  it('refuses --tag without --publish before touching the tree', () => {
    const script = path.join(process.cwd(), 'scripts', 'release-local.mjs');
    const result = spawnSync(process.execPath, [script, '--tag', 'v2.2.0'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--tag only applies to release:publish');
  });
});
