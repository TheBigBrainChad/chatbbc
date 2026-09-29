/**
 * ChatBBC local Linux x64 release: candidate assembly and explicit publication.
 *
 * There is no hosted workflow left to run the release. `npm run release:local` builds one
 * candidate with the owners that already exist (`npm run verify`, `npm run verify:ui`,
 * `npm run dist:linux:x64`, the packaged GUI smoke, the native-source packager) and stages
 * exactly the five files a release carries. `npm run release:publish -- --tag v2.2.1` repeats
 * that same build on this machine and only then uploads a draft release, re-downloads the
 * attached bytes and compares them with the tested ones, and finally undrafts it.
 *
 * Nothing here creates or moves a tag, pushes a branch, or publishes on its own: the tag and
 * the `--publish` flag are both explicit inputs, and a failed upload/readback leaves the
 * draft in place instead of pretending the release shipped.
 *
 * Why the host gate is not imported from `scripts/package.mjs`: that module runs the whole
 * packaging pipeline at import time, so a preflight that must fail before any build cannot
 * share it. This is the same rule, checked here first.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { assertReleaseAbsent } from './check-release-absent.mjs';
import { STAMP_FILE, extensionStamp } from './write-extension-stamp.mjs';

export const REPOSITORY = 'TheBigBrainChad/chatbbc';
export const PRODUCT_NAME = 'ChatBBC';
export const DEFAULT_API = 'https://api.github.com';
export const CANDIDATE_DIRECTORY = path.join('release', 'candidates');
export const RELEASE_DIRECTORY = 'release';
export const APPIMAGE_NAME = 'ChatBBC-Linux-x64.AppImage';
export const EXTENSION_ZIP_NAME = 'ChatBBC-Extension.zip';
export const NATIVE_SOURCES_NAME = 'ChatBBC-Native-Sources.tar.gz';
export const MANIFEST_NAME = 'BUILD-MANIFEST.json';
export const SUMS_NAME = 'SHA256SUMS.txt';

/** The three payloads a release carries, in the order the manifest and checksums list them. */
export const PAYLOAD_NAMES = Object.freeze([APPIMAGE_NAME, EXTENSION_ZIP_NAME, NATIVE_SOURCES_NAME]);
/** Everything the finalized candidate directory holds, including its own evidence. */
export const CANDIDATE_FILES = Object.freeze([...PAYLOAD_NAMES, MANIFEST_NAME, SUMS_NAME]);

/**
 * What the automated pipeline cannot prove, and therefore must never claim. The packaged GUI
 * smoke drives a fresh profile with no credentials, so provider-side connector behaviour and a
 * human session on the real desktop stay manual gates.
 */
export const MANUAL_ACCEPTANCE = Object.freeze([
  'Manual Wayland session on the packaged AppImage: tray and hide/reopen, folder approval, project file read, human terminal, clean exit.',
  'Signed-in ChatGPT provider acceptance with the three ChatBBC connectors created in that account.'
]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_NOTES_TITLE = /^## (.+)$/m;

export function assertSupportedHost({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux' || arch !== 'x64') {
    throw new Error(
      `ChatBBC 2.2.1 ships one artifact for Linux x64; this host is ${platform}-${arch}. ` +
        'Release commands run only on the supported target.'
    );
  }
}

/** A runner is `(command, args, options?) => { status, stdout, stderr, error }`. */
export function createRunner({ cwd, log = (line) => process.stdout.write(`${line}\n`) }) {
  return (command, args = [], options = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: process.env,
      ...options
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (!options.capture) {
      if (stdout.trim()) log(stdout.replace(/\n+$/, ''));
      if (stderr.trim()) process.stderr.write(stderr);
    }
    return { status: result.status ?? -1, stdout, stderr, error: result.error ?? null };
  };
}

export function runChecked(run, label, command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.status === 0) return result;
  const detail = (result.error?.message || result.stderr || result.stdout || '')
    .trim()
    .split('\n')
    .slice(-8)
    .join('\n');
  throw new Error(
    `${label} failed: ${command} ${args.join(' ')} exited ${result.status}${detail ? `\n${detail}` : ''}`
  );
}

/** Tracked, staged and untracked-but-not-ignored state, plus the commit it was read at. */
export function readSourceState(run) {
  const head = runChecked(run, 'git rev-parse HEAD', 'git', ['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`git rev-parse HEAD returned ${JSON.stringify(head)} instead of a commit.`);
  }
  const porcelain = runChecked(run, 'git status --porcelain', 'git', [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]).stdout;
  const changes = porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  return { head, changes };
}

/** A candidate must describe the exact tree it was built from, so a dirty tree is a hard stop. */
export function assertCleanSource(state) {
  if (state.changes.length === 0) return;
  const listed = state.changes
    .slice(0, 10)
    .map((entry) => `  ${entry.code} ${entry.path}`)
    .join('\n');
  const rest = state.changes.length > 10 ? `\n  ...and ${state.changes.length - 10} more` : '';
  throw new Error(
    `release:local builds from a clean tree; commit or stash these ${state.changes.length} path(s) first:\n${listed}${rest}`
  );
}

/**
 * Hosted workflows are not part of this product, and re-landing one would silently re-enable
 * hosted CI on the next push. Tracked files and uncommitted ones both count.
 */
export function assertNoWorkflowFiles({ run, changes = [] }) {
  const tracked = runChecked(run, 'git ls-files .github/workflows', 'git', [
    'ls-files',
    '--',
    '.github/workflows'
  ])
    .stdout.split('\n')
    .filter(Boolean);
  const present = [...new Set([...tracked, ...changes.map((entry) => entry.path)])].filter((file) =>
    file.startsWith('.github/workflows/')
  );
  if (present.length > 0) {
    throw new Error(
      `Hosted workflows are not part of this product: ${present.sort().join(', ')}. ` +
        'Translate the gates into local scripts instead of landing them.'
    );
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing ${label} at ${file}.`);
    throw new Error(`Could not read ${label} at ${file}: ${error.message}`);
  }
}

/** The five declarations a release version must agree on. */
export function readVersionDeclarations({ root = repositoryRoot } = {}) {
  const pkg = readJson(path.join(root, 'package.json'), 'package.json');
  const lock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  const manifest = readJson(path.join(root, 'extension', 'manifest.json'), 'extension manifest');
  const versionSource = fs.readFileSync(path.join(root, 'src', 'main', 'version.ts'), 'utf8');
  const appVersion = /APP_VERSION\s*=\s*'([^']+)'/.exec(versionSource)?.[1];
  return {
    version: pkg.version,
    declarations: [
      { source: 'package.json', version: pkg.version },
      { source: 'package-lock.json', version: lock.version },
      { source: 'package-lock.json packages[""]', version: lock.packages?.['']?.version },
      { source: 'extension/manifest.json', version: manifest.version },
      { source: 'src/main/version.ts APP_VERSION', version: appVersion }
    ]
  };
}

export function assertMatchingVersions({ version, declarations }) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json has no version to release.');
  }
  const missing = declarations.filter((entry) => typeof entry.version !== 'string' || entry.version === '');
  if (missing.length > 0) {
    throw new Error(`Release version is missing in ${missing.map((entry) => entry.source).join(', ')}.`);
  }
  const disagreeing = declarations.filter((entry) => entry.version !== version);
  if (disagreeing.length > 0) {
    const listed = declarations.map((entry) => `${entry.source}=${entry.version}`).join(', ');
    throw new Error(`Release versions disagree: ${listed}. All five declarations must be ${version}.`);
  }
}

/** The app and the companion must still speak the same bridge protocol. */
export function readBridgeProtocols({ root = repositoryRoot } = {}) {
  return ['src/main/version.ts', 'extension/background.js'].map((relative) => {
    const text = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
    const match = /BRIDGE_PROTOCOL\s*=\s*(\d+)/.exec(text);
    return { source: relative, protocol: match ? Number(match[1]) : null };
  });
}

export function assertMatchingProtocols(protocols) {
  const values = new Set(protocols.map((entry) => entry.protocol));
  const listed = protocols.map((entry) => `${entry.source}=${entry.protocol}`).join(', ');
  if (values.size !== 1 || values.has(null) || !Number.isInteger([...values][0]) || [...values][0] < 1) {
    throw new Error(`Bridge protocol declarations must agree on one positive integer: ${listed}.`);
  }
  return [...values][0];
}

/** Release notes are written and reviewed by hand; the tag names the file and the file names the version. */
export function readReleaseNotes({ root = repositoryRoot, version, tag = `v${version}` } = {}) {
  const relative = path.posix.join('docs', 'release-notes', `${tag}.md`);
  const file = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(file)) throw new Error(`Missing reviewed release notes at ${relative}.`);
  const body = fs.readFileSync(file, 'utf8');
  if (body.trim().length === 0) throw new Error(`${relative} is empty.`);
  const title = REQUIRED_NOTES_TITLE.exec(body)?.[1]?.trim();
  if (!title) {
    throw new Error(`${relative} has no "## " title line; the published release title is read from it.`);
  }
  if (!body.includes(version)) {
    throw new Error(`${relative} never names version ${version}; it looks like notes for a different release.`);
  }
  return { relative, file, title };
}

/** The port map is the recorded origin of this product; a candidate that cannot name it is unverifiable. */
export function readUpstreamIdentity({ root = repositoryRoot } = {}) {
  const map = readJson(path.join(root, 'docs', 'upstream-map.json'), 'docs/upstream-map.json');
  const repository = map?.upstream?.repository;
  const commit = map?.upstream?.commit;
  if (typeof repository !== 'string' || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('docs/upstream-map.json has no valid upstream.repository.');
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('docs/upstream-map.json has no valid upstream.commit.');
  }
  return { repository, commit, version: map.upstream.version ?? null };
}

export function readElectronVersion({ root = repositoryRoot } = {}) {
  const electron = readJson(path.join(root, 'node_modules', 'electron', 'package.json'), 'the Electron runtime');
  if (typeof electron.version !== 'string' || electron.version.length === 0) {
    throw new Error('node_modules/electron does not declare a version.');
  }
  return electron.version;
}

/* ------------------------------------------------------------------ companion archive */

/** Every file the browser loads from the companion, minus source maps, in one fixed order. */
export function listExtensionFiles(directory) {
  const found = [];
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(current, entry.name), name);
      else if (entry.isFile() && !/\.map$/.test(name)) found.push(name);
    }
  };
  visit(directory);
  return found;
}

/** Files the manifest itself points at; a companion missing one of them is broken on load. */
export function manifestReferencedFiles(manifest) {
  const files = new Set(['manifest.json']);
  const background = manifest?.background?.service_worker;
  if (typeof background === 'string') files.add(background);
  for (const script of manifest?.content_scripts ?? []) {
    for (const key of ['js', 'css']) {
      for (const item of script?.[key] ?? []) if (typeof item === 'string') files.add(item);
    }
  }
  for (const value of Object.values(manifest?.icons ?? {})) {
    if (typeof value === 'string') files.add(value);
  }
  const action = manifest?.action ?? {};
  if (typeof action.default_popup === 'string') files.add(action.default_popup);
  for (const value of Object.values(action.default_icon ?? {})) {
    if (typeof value === 'string') files.add(value);
  }
  if (typeof manifest?.default_locale === 'string') {
    files.add(`_locales/${manifest.default_locale}/messages.json`);
  }
  return [...files];
}

function decode(entries, name) {
  const bytes = entries[name];
  if (!bytes) throw new Error(`Companion archive is missing ${name}.`);
  return new TextDecoder().decode(bytes);
}

export function readZipEntries(buffer) {
  return unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

/**
 * Unpacks what it just wrote: the archive must contain every shipped file, nothing else, no
 * source maps, a LICENSE, the build stamp of those exact bytes, and version/protocol that
 * match the app it pairs with.
 */
export function verifyCompanionArchive({ archive, directory, version, protocol }) {
  const entries = readZipEntries(archive);
  const names = Object.keys(entries).filter((name) => !name.endsWith('/'));
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Companion archive entry ${name} escapes the archive root.`);
    }
  }
  const maps = names.filter((name) => /\.map$/.test(name));
  if (maps.length > 0) throw new Error(`Companion archive must not carry source maps: ${maps.join(', ')}.`);
  if (!names.includes('LICENSE')) throw new Error('Companion archive is missing the MIT LICENSE.');

  const expected = listExtensionFiles(directory);
  const shipped = new Set(names.filter((name) => name !== 'LICENSE'));
  const missing = expected.filter((name) => !shipped.has(name));
  const extra = [...shipped].filter((name) => !expected.includes(name));
  if (missing.length > 0) throw new Error(`Companion archive is missing ${missing.join(', ')}.`);
  if (extra.length > 0) throw new Error(`Companion archive carries files that are not in the companion: ${extra.join(', ')}.`);

  const manifest = JSON.parse(decode(entries, 'manifest.json'));
  if (manifest.version !== version) {
    throw new Error(`Companion manifest version ${manifest.version} does not match app ${version}.`);
  }
  const archiveProtocol = Number(/BRIDGE_PROTOCOL\s*=\s*(\d+)/.exec(decode(entries, 'background.js'))?.[1]);
  if (archiveProtocol !== protocol) {
    throw new Error(`Companion bridge protocol ${archiveProtocol} does not match app protocol ${protocol}.`);
  }
  for (const name of manifestReferencedFiles(manifest)) {
    if (!shipped.has(name)) throw new Error(`Companion archive is missing manifest-referenced ${name}.`);
  }

  const stamp = decode(entries, STAMP_FILE).trim();
  const computed = extensionStamp(directory);
  if (stamp !== computed) {
    throw new Error(
      `Companion build stamp ${stamp} does not describe the shipped files (${computed}); regenerate it before archiving.`
    );
  }
  return { names, stamp };
}

export async function writeCompanionArchive({ root = repositoryRoot, directory, outFile }) {
  const manifest = readJson(path.join(directory, 'manifest.json'), 'companion manifest');
  const { version } = readVersionDeclarations({ root });
  const protocol = assertMatchingProtocols(readBridgeProtocols({ root }));
  const payload = {};
  for (const name of listExtensionFiles(directory)) {
    payload[name] = new Uint8Array(await fsp.readFile(path.join(directory, ...name.split('/'))));
  }
  payload.LICENSE = new Uint8Array(await fsp.readFile(path.join(root, 'LICENSE')));
  const archive = zipSync(payload, { level: 6 });
  await fsp.writeFile(outFile, archive);
  const verified = verifyCompanionArchive({ archive, directory, version, protocol });
  return { manifest, version, protocol, entries: verified.names, stamp: verified.stamp };
}

/* ------------------------------------------------------------------ payload evidence */

/** Refuse a non-ELF or non-x86-64 AppImage before it can enter a candidate named for Linux x64. */
export function assertAppImagePayload(file) {
  const stat = fs.statSync(file);
  if (stat.size < 1024 * 1024) {
    throw new Error(`${path.basename(file)} is only ${stat.size} bytes; the packaged AppImage did not build.`);
  }
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(64);
  try {
    fs.readSync(descriptor, header, 0, 64, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString('binary', 0, 4) !== '\x7fELF') {
    throw new Error(`${path.basename(file)} is not an ELF binary.`);
  }
  if (header[4] !== 2 || header[5] !== 1) {
    throw new Error(`${path.basename(file)} is not a 64-bit little-endian ELF; refusing a non-x64 payload.`);
  }
  const machine = header.readUInt16LE(18);
  if (machine !== 0x3e) {
    throw new Error(`${path.basename(file)} has ELF machine 0x${machine.toString(16)}, not x86-64 (0x3e).`);
  }
  return { bytes: stat.size };
}

export function assertGzipPayload(file) {
  const stat = fs.statSync(file);
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(2);
  try {
    fs.readSync(descriptor, header, 0, 2, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header[0] !== 0x1f || header[1] !== 0x8b) {
    throw new Error(`${path.basename(file)} is not a gzip archive.`);
  }
  return { bytes: stat.size };
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** `sha256sum` format, so the file a user checks by hand is the file we checked. */
export async function writeCandidateSums({ directory, names }) {
  const lines = [];
  for (const name of names) {
    lines.push(`${await sha256File(path.join(directory, name))}  ${name}`);
  }
  await fsp.writeFile(path.join(directory, SUMS_NAME), `${lines.join('\n')}\n`);
  return lines;
}

/** Recompute every recorded digest from the staged bytes; evidence that does not read back is not evidence. */
export async function verifyCandidateSums({ directory, names }) {
  const text = await fsp.readFile(path.join(directory, SUMS_NAME), 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  const recorded = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`${SUMS_NAME} line is malformed: ${line}`);
    const [, expected, name] = match;
    if (name.includes('/') || name.includes('..')) {
      throw new Error(`${SUMS_NAME} names ${name}, which is not a candidate file.`);
    }
    if (!(await pathExists(path.join(directory, name)))) {
      throw new Error(`${SUMS_NAME} names ${name}, which is not in the candidate.`);
    }
    const actual = await sha256File(path.join(directory, name));
    if (actual !== expected) {
      throw new Error(`Candidate ${name} does not match its recorded SHA-256; the bytes changed after they were hashed.`);
    }
    recorded.add(name);
  }
  const unrecorded = names.filter((name) => !recorded.has(name));
  if (unrecorded.length > 0) throw new Error(`${SUMS_NAME} does not record ${unrecorded.join(', ')}.`);
  return lines;
}

export function buildCandidateManifest({
  version,
  tag,
  headSha,
  upstream,
  protocol,
  buildUuid,
  builtAt,
  electron,
  node = process.version,
  checks,
  artifacts
}) {
  return {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    repository: REPOSITORY,
    version,
    tag,
    target: { platform: 'linux', arch: 'x64' },
    runtime: { node, electron },
    bridgeProtocol: protocol,
    source: { headSha, upstreamRepository: upstream.repository, upstreamCommit: upstream.commit, upstreamVersion: upstream.version },
    buildUuid,
    builtAt,
    artifacts,
    checks,
    manualAcceptance: { claimed: false, pending: [...MANUAL_ACCEPTANCE] }
  };
}

/* ------------------------------------------------------------------ candidate assembly */

/**
 * Copies the three payloads into a fresh staging directory, records their digests and the
 * completed gates beside them, reads the evidence back, and only then gives the directory its
 * final name. A failure leaves the staging directory in place as unverified work.
 */
export async function assembleCandidate({
  root = repositoryRoot,
  version,
  tag = `v${version}`,
  headSha,
  upstream,
  protocol,
  electron,
  buildUuid,
  builtAt,
  checks
}) {
  const candidatesRoot = path.join(root, CANDIDATE_DIRECTORY);
  await fsp.mkdir(candidatesRoot, { recursive: true });
  const finalName = `v${version}-${headSha.slice(0, 12)}-${buildUuid}`;
  const finalPath = path.join(candidatesRoot, finalName);
  if (await pathExists(finalPath)) {
    throw new Error(`Candidate ${path.join(CANDIDATE_DIRECTORY, finalName)} already exists; refusing to replace earlier evidence.`);
  }
  const stagingPath = path.join(candidatesRoot, `.staging-${buildUuid}`);
  if (await pathExists(stagingPath)) {
    throw new Error(`Staging directory ${path.join(CANDIDATE_DIRECTORY, `.staging-${buildUuid}`)} already exists.`);
  }
  await fsp.mkdir(stagingPath);

  for (const name of PAYLOAD_NAMES) {
    const source = path.join(root, RELEASE_DIRECTORY, name);
    if (!(await pathExists(source))) {
      throw new Error(`Missing release/${name}; the build that produces it did not complete.`);
    }
    await fsp.copyFile(source, path.join(stagingPath, name));
  }
  assertAppImagePayload(path.join(stagingPath, APPIMAGE_NAME));
  assertGzipPayload(path.join(stagingPath, NATIVE_SOURCES_NAME));
  verifyCompanionArchive({
    archive: await fsp.readFile(path.join(stagingPath, EXTENSION_ZIP_NAME)),
    directory: path.join(root, 'extension'),
    version,
    protocol
  });

  const artifacts = [];
  for (const name of PAYLOAD_NAMES) {
    artifacts.push({
      name,
      bytes: (await fsp.stat(path.join(stagingPath, name))).size,
      sha256: await sha256File(path.join(stagingPath, name))
    });
  }
  const manifest = buildCandidateManifest({
    version,
    tag,
    headSha,
    upstream,
    protocol,
    buildUuid,
    builtAt,
    electron,
    checks,
    artifacts
  });
  await fsp.writeFile(path.join(stagingPath, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeCandidateSums({ directory: stagingPath, names: [...PAYLOAD_NAMES, MANIFEST_NAME] });
  await verifyCandidateSums({ directory: stagingPath, names: [...PAYLOAD_NAMES, MANIFEST_NAME] });

  const staged = (await fsp.readdir(stagingPath)).sort();
  if (staged.join('\n') !== [...CANDIDATE_FILES].sort().join('\n')) {
    throw new Error(
      `Candidate staging holds ${staged.join(', ')}; a candidate carries exactly ${CANDIDATE_FILES.join(', ')}.`
    );
  }
  await fsp.rename(stagingPath, finalPath);
  return { name: finalName, path: finalPath, directory: path.relative(root, finalPath), files: [...CANDIDATE_FILES], manifest };
}

/* ------------------------------------------------------------------ candidate pipeline */

/**
 * Preflight, regenerate, verify, build, smoke, archive, and stage one candidate from HEAD.
 * Every step is an existing owner; this function only orders them and records what ran.
 */
export async function runCandidate({
  root = repositoryRoot,
  run = createRunner({ cwd: root }),
  log = (line) => process.stdout.write(`${line}\n`),
  host = { platform: process.platform, arch: process.arch },
  buildUuid = randomUUID(),
  builtAt = new Date().toISOString()
} = {}) {
  assertSupportedHost(host);
  const source = readSourceState(run);
  assertCleanSource(source);
  assertNoWorkflowFiles({ run, changes: source.changes });
  const { version, declarations } = readVersionDeclarations({ root });
  assertMatchingVersions({ version, declarations });
  const protocol = assertMatchingProtocols(readBridgeProtocols({ root }));
  const notes = readReleaseNotes({ root, version });
  const upstream = readUpstreamIdentity({ root });
  const electron = readElectronVersion({ root });

  const checks = [];
  const step = (id, command, args) => {
    log(`release:local [${id}] ${command} ${args.join(' ')}`);
    runChecked(run, id, command, args);
    checks.push({ id, command: [command, ...args].join(' '), status: 'passed' });
  };

  // The stamp and the icons ship inside the artifact, so a stale generated file would ship a
  // companion the app cannot identify. Regenerate, then demand the tree is still clean.
  step('regenerate-extension-stamp', 'node', ['scripts/write-extension-stamp.mjs']);
  step('regenerate-icons', 'node', ['scripts/make-icon.mjs']);
  const afterGeneration = readSourceState(run);
  if (afterGeneration.changes.length > 0) {
    throw new Error(
      `Regenerating the extension stamp and icons changed tracked files: ${afterGeneration.changes
        .map((entry) => entry.path)
        .join(', ')}. Review and commit them, then build the candidate.`
    );
  }
  if (afterGeneration.head !== source.head) {
    throw new Error(`HEAD moved from ${source.head} to ${afterGeneration.head} during the build; rerun at one commit.`);
  }

  step('verify', 'npm', ['run', 'verify']);
  // The UI fixtures load built renderer output, so the packaged build has to exist before them.
  // Running it here also materializes the AppImage the packaged smoke drives, which means both
  // GUI gates exercise the same build that ships instead of an earlier one.
  step('dist-linux-x64', 'npm', ['run', 'dist:linux:x64']);
  step('verify-ui', 'npm', ['run', 'verify:ui']);
  step('packaged-gui-smoke', 'node', ['scripts/verify-chatbbc-package.mjs']);
  step('companion-archive', 'node', ['scripts/release-local.mjs', '--companion-archive']);
  step('native-sources', 'node', ['scripts/package-native-sources.mjs']);

  // The manifest names HEAD, so the tree those steps ran against must still be HEAD's tree.
  const settled = readSourceState(run);
  if (settled.head !== source.head || settled.changes.length > 0) {
    throw new Error(
      `The build left the tree at ${settled.head} with ${settled.changes.length} changed path(s); ` +
        `the candidate would not describe ${source.head}.`
    );
  }
  checks.push({ id: 'source-still-clean', command: 'git status --porcelain', status: 'passed' });

  const candidate = await assembleCandidate({
    root,
    version,
    tag: `v${version}`,
    headSha: source.head,
    upstream,
    protocol,
    electron,
    buildUuid,
    builtAt,
    checks
  });
  log(`release:local verified candidate ${candidate.directory} (${notes.title})`);
  return candidate;
}

/* ------------------------------------------------------------------ publication */

export function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'chatbbc-release-preflight'
  };
}

/** Actions must stay disabled; an API error is never read as "disabled". */
export async function assertActionsDisabled({ repository, token, fetchImpl = fetch, apiBase = DEFAULT_API }) {
  if (!repository || !repository.includes('/')) throw new Error('Repository is missing or invalid');
  if (!token) throw new Error('A GitHub token is required to check repository Actions permissions');
  const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/repos/${repository}/actions/permissions`, {
    headers: githubHeaders(token)
  });
  if (!response.ok) {
    const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(
      `Could not read Actions permissions for ${repository} (HTTP ${response.status}${body ? `: ${body}` : ''}); refusing to publish while that is unknown.`
    );
  }
  const body = await response.json();
  if (body?.enabled !== false) {
    throw new Error(`Repository Actions are enabled (enabled=${JSON.stringify(body?.enabled)}); disable them before publishing.`);
  }
  return body;
}

/** Token lives in memory only: environment first, then the gh credential store. */
export async function resolveGithubToken({ run, env = process.env }) {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const result = run('gh', ['auth', 'token'], { capture: true });
  const token = (result.stdout ?? '').trim();
  if (result.status !== 0 || token.length === 0) {
    throw new Error('No GitHub token available: set GH_TOKEN or GITHUB_TOKEN, or authenticate gh.');
  }
  return token;
}

export function readLocalTag({ run, tag, head }) {
  const result = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { capture: true });
  if (result.status !== 0) {
    throw new Error(
      `Local tag ${tag} does not exist. Create it at ${head} yourself; release:publish never creates or moves a tag.`
    );
  }
  const sha = result.stdout.trim();
  if (sha !== head) {
    throw new Error(`Local tag ${tag} points at ${sha}, not HEAD ${head}.`);
  }
  return sha;
}

/** Reads the remote tag without touching it; an unreachable remote is an error, not an absence. */
export function readRemoteTag({ run, tag, remote = 'origin' }) {
  const result = run('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    capture: true
  });
  if (result.status !== 0) {
    throw new Error(`Could not read ${remote} tag ${tag}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const rows = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ?? null;
  const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? null;
  return { sha: peeled ?? direct, annotated: Boolean(peeled) };
}

export function assertRemoteTagConsistent({ tag, head, remote }) {
  if (remote.sha && remote.sha !== head) {
    throw new Error(`Remote tag ${tag} points at ${remote.sha}, not local HEAD ${head}; refusing to move a published tag.`);
  }
  return remote.sha === head;
}

/** Refuse a tag push to a remote other than the repository whose Actions/release state was checked. */
export function assertPublicationRemote(run) {
  const url = runChecked(run, 'git remote get-url origin', 'git', ['remote', 'get-url', 'origin'], { capture: true }).stdout.trim();
  const allowed = new Set([
    `https://github.com/${REPOSITORY}`,
    `https://github.com/${REPOSITORY}.git`,
    `git@github.com:${REPOSITORY}`,
    `git@github.com:${REPOSITORY}.git`,
    `ssh://git@github.com/${REPOSITORY}`,
    `ssh://git@github.com/${REPOSITORY}.git`
  ]);
  if (!allowed.has(url)) throw new Error(`origin does not name the checked ${REPOSITORY} repository; refusing publication.`);
}

/** Pushes only the explicitly named tag, and only when the remote does not already carry it. */
export function publishTagIfAbsent({ run, tag, head, remote = 'origin' }) {
  const current = readRemoteTag({ run, tag, remote });
  if (assertRemoteTagConsistent({ tag, head, remote: current })) return false;
  runChecked(run, `git push ${remote} ${tag}`, 'git', ['push', remote, `refs/tags/${tag}`]);
  const after = readRemoteTag({ run, tag, remote });
  if (after.sha !== head) {
    throw new Error(`Pushing ${tag} left ${remote} at ${after.sha ?? '<absent>'}; expected ${head}.`);
  }
  return true;
}

/** The published bytes must be the tested bytes, and the release must carry nothing else. */
export async function verifyDownloadedAssets({ localDirectory, downloadDirectory, names = CANDIDATE_FILES }) {
  const downloaded = (await fsp.readdir(downloadDirectory)).sort();
  const missing = names.filter((name) => !downloaded.includes(name));
  if (missing.length > 0) throw new Error(`Release download is missing ${missing.join(', ')}.`);
  const extra = downloaded.filter((name) => !names.includes(name));
  if (extra.length > 0) throw new Error(`Release carries unexpected asset(s): ${extra.join(', ')}.`);
  for (const name of names) {
    const expected = await sha256File(path.join(localDirectory, name));
    const actual = await sha256File(path.join(downloadDirectory, name));
    if (actual !== expected) {
      throw new Error(
        `Downloaded ${name} is ${actual}, not the tested ${expected}; the release carries different bytes.`
      );
    }
  }
  return downloaded;
}

/**
 * Explicit, later action: rebuild the candidate on this machine, upload it as a draft,
 * re-download and compare it, and only then undraft. A failure after upload leaves a draft.
 */
export async function publishRelease({
  root = repositoryRoot,
  run = createRunner({ cwd: root }),
  log = (line) => process.stdout.write(`${line}\n`),
  tag,
  fetchImpl = fetch,
  apiBase = DEFAULT_API,
  host = { platform: process.platform, arch: process.arch },
  buildUuid = randomUUID(),
  builtAt = new Date().toISOString()
} = {}) {
  assertSupportedHost(host);
  if (!tag) {
    throw new Error('release:publish needs an explicit tag: npm run release:publish -- --tag v2.2.1');
  }
  const source = readSourceState(run);
  assertCleanSource(source);
  assertNoWorkflowFiles({ run, changes: source.changes });
  const { version, declarations } = readVersionDeclarations({ root });
  assertMatchingVersions({ version, declarations });
  if (tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match app version ${version}; refusing to publish a mislabelled release.`);
  }
  const notes = readReleaseNotes({ root, version, tag });
  const upstream = readUpstreamIdentity({ root });
  assertMatchingProtocols(readBridgeProtocols({ root }));
  readLocalTag({ run, tag, head: source.head });
  assertPublicationRemote(run);
  const token = await resolveGithubToken({ run });
  await assertActionsDisabled({ repository: REPOSITORY, token, fetchImpl, apiBase });
  publishTagIfAbsent({ run, tag, head: source.head, remote: 'origin' });
  await assertReleaseAbsent({ repository: REPOSITORY, tag, token, fetchImpl, apiBase });

  const checks = [];
  const step = (id, command, args) => {
    log(`release:publish [${id}] ${command} ${args.join(' ')}`);
    runChecked(run, id, command, args);
    checks.push({ id, command: [command, ...args].join(' '), status: 'passed' });
  };
  step('verify-tunnel-current', 'npm', ['run', 'verify:tunnel-current']);

  const candidate = await runCandidate({ root, run, log, host, buildUuid, builtAt });

  step('verify-tunnel-current-pre-upload', 'npm', ['run', 'verify:tunnel-current']);
  await assertReleaseAbsent({ repository: REPOSITORY, tag, token, fetchImpl, apiBase });

  const payloads = CANDIDATE_FILES.map((name) => path.join(candidate.path, name));
  runChecked(run, 'gh release create', 'gh', [
    'release',
    'create',
    tag,
    '--verify-tag',
    '--draft',
    '--title',
    notes.title,
    '--notes-file',
    notes.file,
    '--repo',
    REPOSITORY,
    ...payloads
  ]);
  log(`release:publish uploaded draft ${tag} with ${candidate.files.length} file(s)`);

  const downloadDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatbbc-release-'));
  try {
    runChecked(run, 'gh release download', 'gh', ['release', 'download', tag, '--dir', downloadDirectory, '--repo', REPOSITORY]);
    await verifyDownloadedAssets({ localDirectory: candidate.path, downloadDirectory });
    runChecked(run, 'gh release edit', 'gh', ['release', 'edit', tag, '--draft=false', '--repo', REPOSITORY]);
  } finally {
    await fsp.rm(downloadDirectory, { recursive: true, force: true });
  }
  log(`release:publish published ${tag} from ${candidate.directory}`);
  return {
    tag,
    repository: REPOSITORY,
    repositoryUrl: upstream.repository,
    candidate,
    checks: [...candidate.manifest.checks, ...checks]
  };
}

/* ------------------------------------------------------------------ command line */

export function parseArguments(argv) {
  const known = new Set(['--publish', '--companion-archive', '--tag']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}.`);
    if (!known.has(arg)) throw new Error(`Unknown option ${arg}.`);
    if (arg === '--tag') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--tag needs a value, for example --tag v2.2.1.');
    }
  }
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const tagIndex = argv.indexOf('--tag');
  return {
    publish: flags.has('--publish'),
    companionArchive: flags.has('--companion-archive'),
    tag: tagIndex >= 0 ? argv[tagIndex + 1] : undefined
  };
}

export async function buildCompanionArchiveCommand({ root = repositoryRoot } = {}) {
  assertSupportedHost();
  const directory = path.join(root, 'extension');
  const outFile = path.join(root, RELEASE_DIRECTORY, EXTENSION_ZIP_NAME);
  // The stamp the app compares against ships inside the archive, and it is written by the build
  // rather than committed. Regenerate it here so this command is correct on its own, not only
  // when an earlier pipeline step happened to run first.
  runChecked(createRunner({ cwd: root }), 'extension stamp', process.execPath, [
    'scripts/write-extension-stamp.mjs'
  ]);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const result = await writeCompanionArchive({ root, directory, outFile });
  process.stdout.write(
    `${EXTENSION_ZIP_NAME}: ${result.entries.length} file(s), manifest ${result.manifest.version}, protocol ${result.protocol}, stamp ${result.stamp}\n`
  );
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArguments(argv);
  if (options.companionArchive) {
    await buildCompanionArchiveCommand();
    return;
  }
  if (options.publish) {
    const result = await publishRelease({ tag: options.tag });
    process.stdout.write(`published ${result.tag} from ${result.candidate.directory}\n`);
    return;
  }
  if (options.tag) {
    throw new Error('--tag only applies to release:publish; use npm run release:publish -- --tag v2.2.1');
  }
  const candidate = await runCandidate();
  process.stdout.write(`verified candidate ${candidate.directory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
