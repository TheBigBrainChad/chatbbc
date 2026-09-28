/**
 * Whether a newer ChatBBC has been published, and the file that becomes it.
 *
 * This is the whole updater: one pass, run at startup and repeated on a slow timer, that asks
 * GitHub for the latest release, stages the AppImage this installation can actually apply, and
 * replaces the running AppImage on quit. There is no renderer-side download state and no
 * `electron-updater`; the release pipeline publishes the artifact named below.
 *
 * Three rules shape everything here:
 *
 * - **Nothing may wedge startup.** Every failure ends as `stage: 'failed'` plus a log line. The
 *   app is fully usable at the old version, which is why no caller ever awaits this.
 * - **One pass at a time.** Checking and downloading are one operation, deduplicated by one
 *   promise, so a second call while a download is running joins it rather than starting a
 *   second download of the same file. That is what makes the repeat timer free: a pass that
 *   finds the release it already staged stops at the release call.
 * - **The user says when.** A staged update is applied during the ordinary quit sequence, and
 *   `markInstallOnQuit` is called by the Install button before it starts that quit. Nothing here quits or
 *   interrupts anything on its own.
 * - **A staged artifact outlives the process that fetched it.** It is kept under the version it
 *   belongs to, so the next start recognises the file it already has and reverifies it rather
 *   than downloading the same AppImage again.
 *
 * **What updates itself:** a Linux x64 AppImage. A packaged Linux x64 installation
 * without `APPIMAGE` receives the exact AppImage download link for manual replacement.
 * Other platforms and architectures have no supported release artifact.
 *
 * What this module does **not** own: the version of the browser extension. The bridge already
 * learns that from the authenticated `x-extension-version` header of a paired extension, and
 * `bridgeStatus()` reports it. A second source for the same fact would be a second thing to be
 * wrong.
 */

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION } from './version.js';
import { isNewer, type UpdateStatus } from '../shared/types.js';

const REPO = 'TheBigBrainChad/chatbbc';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * How often the check repeats while the app is open.
 *
 * This app lives in the tray and is routinely left running for days, so "once per start" was in
 * practice "never" for exactly the installations nobody is about to restart to collect a fix.
 * Six hours is slow enough to be invisible, and costs one request whenever there is nothing new.
 */
const RECHECK_MS = 6 * 60 * 60_000;

/**
 * The artifact this exact installation can apply to itself, or null for one that cannot.
 *
 * Other platforms and architectures have no published artifact. A packaged Linux x64
 * run without `APPIMAGE` can download the AppImage manually but cannot update itself.
 * `APPIMAGE` is set by the AppImage runtime to the running file's path.
 *
 * An unpackaged run — `electron-vite dev`, or a maintainer's working tree — is not an
 * installation. Its version is whatever the source says, so it reads as out of date the moment a
 * release ships, and staging for it would let quitting a dev session replace a real AppImage.
 * It is told what is published and replaces nothing.
 */
export function stagedArtifact(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appImage: string | undefined = process.env.APPIMAGE,
  packaged: boolean = app.isPackaged
): { name: string; target: string } | null {
  if (!packaged || platform !== 'linux' || arch !== 'x64' || !appImage) return null;
  return { name: 'ChatBBC-Linux-x64.AppImage', target: appImage };
}

/**
 * A packaged Linux x64 installation outside an AppImage can download the exact
 * supported AppImage; every unsupported target falls back to the release page.
 */
export function manualDownloadName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appImage: string | undefined = process.env.APPIMAGE,
  packaged: boolean = app.isPackaged
): string | null {
  return packaged && platform === 'linux' && arch === 'x64' && !appImage
    ? 'ChatBBC-Linux-x64.AppImage' : null;
}

/** Where "Get update" sends this installation: its exact file for `version`, else the page. */
export function manualDownloadUrl(version: string | null, name: string | null = manualDownloadName()): string {
  const page = `https://github.com/${REPO}/releases/latest`;
  return version && /^\d+\.\d+\.\d+$/.test(version) && name ? `https://github.com/${REPO}/releases/download/v${version}/${name}` : page;
}

/** `v2.0.3` -> `2.0.3`, and anything that is not a release tag -> null. */
export function releaseVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const version = tag.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

const CLEAR: UpdateStatus = { current: APP_VERSION, latest: null, stage: 'idle', error: null, checkedAt: null };
let status: UpdateStatus = CLEAR;

let staged: { version: string; file: string; target: string; digest: string } | null = null;
let pass: Promise<void> | null = null;
/** Set by `markInstallOnQuit`: the user pressed Install, so bring the app back afterwards. */
let runAfterInstall = false;
const listeners = new Set<() => void>();

export function onUpdateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateStatus(): UpdateStatus {
  return { ...status };
}

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  for (const listener of listeners) listener();
}

/**
 * Runs the check at startup, and keeps running it for as long as the app is open.
 *
 * The timer is unreferenced: it is a background courtesy, never a reason for the process to stay
 * alive, and the shutdown sequence does not have to know it exists.
 */
export function startUpdateChecks(): void {
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), RECHECK_MS).unref();
}

/**
 * Looks for a newer release and, if this installation can apply one, stages it.
 *
 * Concurrent callers get the pass that is already running, so a second call does not
 * download the same AppImage twice.
 */
export function checkForUpdates(): Promise<void> {
  if (pass) return pass;
  const run = runPass()
    .catch((err: Error) => {
      set({ stage: 'failed', error: err.message });
      logWarn(`update check failed: ${err.message}`);
    })
    .finally(() => {
      if (pass === run) pass = null;
    });
  pass = run;
  return run;
}

async function runPass(): Promise<void> {
  set({ stage: 'checking', error: null });
  const release = { version: await latestVersion() };
  // GitHub answered. From here the UI can tell "current" from "not asked yet", whatever the
  // rest of this pass does with the answer.
  set({ checkedAt: Date.now() });
  // A newly published selection retires the previous executable authority before any file replacement.
  if (staged?.version !== release.version || !isNewer(release.version, APP_VERSION)) staged = null;
  if (!isNewer(release.version, APP_VERSION)) {
    // Up to date, or ahead of the published release on a development build. Both mean nothing
    // to offer, and `latest` stays null so nothing in the UI claims otherwise.
    set({ latest: null, stage: 'idle' });
    return;
  }
  logInfo(`update: ${release.version} is available; this app is ${APP_VERSION}`);
  const artifact = stagedArtifact();
  // `latest` and what is being done about it are set in one go. Published separately, the
  // renderer would paint one frame of "a new version exists, and this install updates by
  // hand" for every install, including the ones about to download it themselves.
  if (!artifact) {
    set({ latest: release.version, stage: 'idle' });
    return;
  }
  if (staged?.version === release.version) {
    set({ latest: release.version, stage: 'ready' });
    return;
  }
  // The release's checksums authorize both adopting a previous download and fetching a new
  // one. Neither path may hand over an unverified file.
  const expected = (await releaseDigests(release.version)).get(artifact.name);
  if (!expected) throw new Error(`release ${release.version} publishes no ${artifact.name}`);
  const carried = await adopt(release.version, artifact.name, expected);
  if (carried) {
    staged = { version: release.version, file: carried, target: artifact.target, digest: expected };
    set({ latest: release.version, stage: 'ready' });
    logInfo(`update: ${release.version} was already downloaded and is ready to install`);
    return;
  }
  set({ latest: release.version, stage: 'downloading' });
  const file = await download(release.version, artifact.name, expected);
  staged = { version: release.version, file, target: artifact.target, digest: expected };
  set({ stage: 'ready' });
  logInfo(`update: ${release.version} is downloaded and ready to install`);
}

/** Where one release's artifact is kept. Versioned, so no build is ever taken for another. */
function stagingDir(version: string): string {
  return path.join(app.getPath('userData'), 'updates', version);
}

/** The SHA-256 of a file already on disk. */
async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The artifact a previous run of this app already fetched and proved, or null for anything else.
 *
 * Staging is per version, so this is a question the file system alone can answer and there is no
 * second record of it to fall out of step. The digest is checked again, against the release's
 * own published sums rather than anything this app wrote beside the file: a staged update can
 * sit here for days before anyone quits.
 *
 * Reusing it is not an optimisation. This app lives in the tray and is closed to it, so an
 * update staged on Monday is applied whenever the user next really quits — and without this,
 * every start in between refetched the same hundred megabytes to arrive at the same file.
 */
async function adopt(version: string, name: string, expected: string): Promise<string | null> {
  const file = path.join(stagingDir(version), name);
  if (!existsSync(file)) return null;
  try {
    if ((await fileDigest(file)) !== expected) throw new Error('it is not the published file');
    return file;
  } catch (err) {
    logWarn(`update: the staged ${version} download cannot be reused (${(err as Error).message}); fetching it again`);
    return null;
  }
}

/** The one fact the release API is asked for: which version is newest. */
async function latestVersion(): Promise<string> {
  const response = await get(LATEST_RELEASE_API, CHECK_TIMEOUT_MS, {
    accept: 'application/vnd.github+json'
  });
  const body = (await response.json()) as { tag_name?: unknown };
  const version = releaseVersion(body.tag_name);
  if (!version) throw new Error('the latest release has no usable version tag');
  return version;
}

/**
 * The SHA-256 of every artifact in a release, from the `SHA256SUMS.txt` published
 * beside them by the local release pipeline.
 *
 * This doubles as the manifest of what a release contains: a name that is not in here is not
 * something to download, and a file whose digest is not in here is not something to run.
 */
async function releaseDigests(version: string): Promise<Map<string, string>> {
  const response = await get(assetUrl(version, 'SHA256SUMS.txt'), CHECK_TIMEOUT_MS);
  const digests = new Map<string, string>();
  for (const line of (await response.text()).split('\n')) {
    // `sha256sum` writes "<64 hex>  <name>", with a binary/text marker on the second space.
    const match = /^([0-9a-f]{64})\s+[*\s]?(\S+)\s*$/.exec(line.trim());
    if (match) digests.set(match[2]!, match[1]!);
  }
  return digests;
}

/** The url of one release asset. Built here, never taken from a response body. */
function assetUrl(version: string, name: string): string {
  return `https://github.com/${REPO}/releases/download/v${encodeURIComponent(version)}/${name}`;
}

async function get(url: string, timeout: number, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    headers: { 'user-agent': `chatbbc/${APP_VERSION}`, ...headers }
  });
  if (!response.ok) throw new Error(`${new URL(url).pathname.split('/').pop()} answered ${response.status}`);
  return response;
}

/**
 * Fetches one release artifact into this app's own data directory, and proves it is that file.
 *
 * Every url here is built from the tag and the file name rather than read out of a response
 * body, for the same reason `extensionDownloadUrl` does it: the app decides what it downloads,
 * and no field in a reply can point it somewhere else.
 *
 * The artifact is then checked against the release's own published SHA-256, hashed as it
 * arrives so nothing is read twice. A length check would only catch a truncated download; this
 * file becomes the running application on quit, so the release digest is required. Anything
 * that does not match is deleted and staged as nothing.
 *
 * `.part` until it has passed: the rename is what publishes it, so an interrupted or wrong
 * download cannot replace the running AppImage.
 */
async function download(version: string, name: string, expected: string): Promise<string> {
  const dir = stagingDir(version);
  // One staged build at a time. Anything already here is either this same download starting
  // over or an artifact for a release nobody is going to install now.
  await rm(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const response = await get(assetUrl(version, name), DOWNLOAD_TIMEOUT_MS);
  if (!response.body) throw new Error(`downloading ${name} returned no content`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(`${file}.part`));
  const digest = hash.digest('hex');
  if (digest !== expected) {
    await rm(`${file}.part`, { force: true });
    throw new Error(`${name} is not the published file: sha256 ${digest} instead of ${expected}`);
  }
  await rename(`${file}.part`, file);
  return file;
}

/**
 * Records that the user pressed Install, and says whether there was anything to install.
 *
 * It deliberately replaces nothing itself. The handoff belongs at the end of the ordinary
 * shutdown sequence and nowhere else: that is what guarantees the bridge has drained, the child
 * processes are gone and every durable write has landed before the AppImage is replaced.
 * All this does is record that the user asked — which is also what makes the difference between
 * an update applied on an ordinary quit and one they are waiting to come back from.
 *
 * The caller quits. This module still never does.
 */
export function markInstallOnQuit(): boolean {
  if (!staged) return false;
  runAfterInstall = true;
  return true;
}

/**
 * Replaces the running AppImage at the end of the ordinary quit sequence.
 *
 * The running image is mounted from its path. Copying to a new path and renaming over the old
 * one gives the new build a new inode while the old build finishes shutting down. The staged
 * bytes are verified again at handoff, including when the download survived a prior process.
 */
export async function applyStagedUpdate(): Promise<void> {
  const ready = staged;
  const relaunch = runAfterInstall;
  staged = null;
  runAfterInstall = false;
  if (!ready) return;
  try {
    if ((await fileDigest(ready.file)) !== ready.digest) throw new Error('the staged artifact changed after verification');
    const next = `${ready.target}.new`;
    await copyFile(ready.file, next);
    await chmod(next, 0o755);
    await rename(next, ready.target);
    // An ordinary quit stays closed; Install explicitly asks Electron to reopen the new image.
    if (relaunch) app.relaunch({ execPath: ready.target });
    logInfo(
      relaunch
        ? `update: installing ${ready.version} now; the app starts itself again as the new version`
        : `update: ${ready.version} handed over; the next start of this app is the new version`
    );
  } catch (err) {
    // Nothing is retried and nothing is left half-applied. The next app start checks again.
    logWarn(`could not apply the staged ${ready.version} update: ${(err as Error).message}`);
  }
}

/** Test seam: forgets the pass, the staged file and everything reported about them. */
export function resetUpdateForTests(): void {
  status = CLEAR;
  staged = null;
  pass = null;
  runAfterInstall = false;
  listeners.clear();
}
