/**
 * A staged AppImage must match the published SHA-256 both on download and at quit.
 * Failed checks leave the running image intact; later checks can retry or reuse verified bytes.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


let userData = '';
let packaged = true;
const relaunched: Array<{ execPath?: string }> = [];
vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    get isPackaged() {
      return packaged;
    },
    relaunch: (options: { execPath?: string }) => relaunched.push(options)
  }
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: () => undefined, logWarn: () => undefined }));

const { APP_VERSION } = await import('../src/main/version.js');
const { isNewer } = await import('../src/shared/types.js');
const {
  applyStagedUpdate,
  checkForUpdates,
  manualDownloadName,
  manualDownloadUrl,
  markInstallOnQuit,
  releaseVersion,
  resetUpdateForTests,
  stagedArtifact,
  updateStatus
} = await import('../src/main/update.js');

const NEXT = '99.0.0';
const APPIMAGE_ASSET = 'ChatBBC-Linux-x64.AppImage';

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

/**
 * GitHub, as the three requests this makes: the release, its checksums, and one artifact.
 *
 * `checksums` is supplied as text so a test can hand over a manifest that disagrees with the
 * bytes, which is the whole point of having one.
 */
function github(options: {
  version?: string;
  body?: string;
  checksums?: string;
  fail?: 'release' | 'sums' | 'asset';
} = {}) {
  const version = options.version ?? NEXT;
  const body = options.body ?? 'new AppImage bytes';
  const sums = options.checksums ?? `${sha256(body)}  ${APPIMAGE_ASSET}\n`;
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const name = url.split('/').pop()!;
    asked.push(name);
    if (url.includes('api.github.com')) {
      if (options.fail === 'release') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 });
    }
    if (name === 'SHA256SUMS.txt') {
      if (options.fail === 'sums') return new Response('nope', { status: 404 });
      return new Response(sums, { status: 200 });
    }
    if (options.fail === 'asset') return new Response('nope', { status: 500 });
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return { asked, fetch, body };
}

/** Runs a pass with isolated platform, architecture and AppImage path, restoring all three. */
async function asPlatform(platform: string, appImage: string | undefined, run: () => Promise<void>, arch = 'x64'): Promise<void> {
  const realPlatform = process.platform;
  const realArch = process.arch;
  const realAppImage = process.env.APPIMAGE;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  }
}

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'chatbbc-update-'));
  packaged = true;
  relaunched.length = 0;
  resetUpdateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(userData, { recursive: true, force: true });
});

describe('the file Get update opens for an installation that cannot update itself', () => {
  it('offers only the published Linux x64 AppImage for a packaged non-AppImage install', () => {
    expect(manualDownloadName('linux', 'x64', undefined, true)).toBe(APPIMAGE_ASSET);
    expect(manualDownloadName('linux', 'x64', '/opt/chatbbc.AppImage', true)).toBeNull();
    expect(manualDownloadName('linux', 'arm64', undefined, true)).toBeNull();
    expect(manualDownloadName('win32', 'x64', undefined, true)).toBeNull();
    expect(manualDownloadName('darwin', 'x64', undefined, true)).toBeNull();
    expect(manualDownloadName('linux', 'x64', undefined, false)).toBeNull();
  });
  it('links the exact file for the announced version, and the release page otherwise', () => {
    expect(manualDownloadUrl('2.2.0', APPIMAGE_ASSET))
      .toBe('https://github.com/TheBigBrainChad/chatbbc/releases/download/v2.2.0/ChatBBC-Linux-x64.AppImage');
    expect(manualDownloadUrl(null, APPIMAGE_ASSET)).toBe('https://github.com/TheBigBrainChad/chatbbc/releases/latest');
    expect(manualDownloadUrl('2.2.0', null)).toBe('https://github.com/TheBigBrainChad/chatbbc/releases/latest');
    expect(manualDownloadUrl('../evil', 'x.AppImage')).toBe('https://github.com/TheBigBrainChad/chatbbc/releases/latest');
  });
});

describe('which installations update themselves', () => {
  it('stages only a packaged Linux x64 AppImage', () => {
    expect(stagedArtifact('linux', 'x64', '/opt/chatbbc.AppImage', true)).toEqual({
      name: APPIMAGE_ASSET, target: '/opt/chatbbc.AppImage'
    });
    expect(stagedArtifact('win32', 'x64', undefined, true)).toBeNull();
    expect(stagedArtifact('linux', 'arm64', '/opt/chatbbc.AppImage', true)).toBeNull();
  });

  /** An unpacked installation has no running AppImage to replace. */
  it('leaves an unpacked Linux install to download the AppImage manually', async () => {
    expect(stagedArtifact('linux', 'x64', undefined)).toBeNull();
    expect(stagedArtifact('darwin', 'arm64')).toBeNull();
    expect(stagedArtifact('win32', 'ia32')).toBeNull();

    const { asked } = github();
    await asPlatform('linux', undefined, () => checkForUpdates());

    // Told, and told exactly: a version that is newer, and no pretence of a download.
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(relaunched).toEqual([]);
  });

  /** A development tree is not an installation, even when APPIMAGE is set. */
  it('never stages for an unpackaged run', async () => {
    packaged = false;
    expect(stagedArtifact('linux', 'x64', '/opt/chatbbc.AppImage')).toBeNull();

    const { asked } = github();
    await asPlatform('linux', path.join(userData, 'ChatBBC.AppImage'), () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
    expect(asked).toEqual(['latest']);
    await applyStagedUpdate();
    expect(relaunched).toEqual([]);
  });
  it('does not stage or offer downloads on an unsupported host or architecture', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['linux', 'arm64']] as const) {
      resetUpdateForTests();
      const { asked } = github();
      await asPlatform(platform, live, () => checkForUpdates(), arch);
      expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'idle', error: null });
      expect(asked).toEqual(['latest']);
      expect(manualDownloadName(platform, arch, undefined, true)).toBeNull();
    }
    expect(existsSync(path.join(userData, 'updates'))).toBe(false);
  });
});

describe('finding a newer release', () => {
  it('reads a release tag, and refuses anything that is not one', () => {
    expect(releaseVersion('v2.1.0')).toBe('2.1.0');
    expect(releaseVersion('2.1.0')).toBe('2.1.0');
    expect(releaseVersion('v2.1.0-rc.1')).toBeNull();
    expect(releaseVersion(null)).toBeNull();
  });

  /** A published downgrade must not install itself over a newer app. */
  it('compares versions as numbers, not as strings', () => {
    expect(isNewer('2.0.10', '2.0.9')).toBe(true);
    expect(isNewer('2.0.9', '2.0.10')).toBe(false);
    expect(isNewer('2.0.2', '2.0.2')).toBe(false);
    expect(isNewer('1.9.9', '2.0.0')).toBe(false);
  });

  /**
   * `checkedAt` is the difference between "checked, nothing to install" and "has not asked yet",
   * which are the same `{latest: null, stage: 'idle'}` record otherwise. The renderer says "up to
   * date" on the strength of that timestamp, so a pass that never reached GitHub must not set it.
   */
  it('reports nothing when the published release is the version already running', async () => {
    const { asked } = github({ version: APP_VERSION });
    expect(updateStatus().checkedAt).toBeNull();
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ current: APP_VERSION, latest: null, stage: 'idle' });
    expect(updateStatus().checkedAt).toBeGreaterThan(0);
    // It stopped at the release: no checksums, no artifact, nothing written.
    expect(asked).toEqual(['latest']);
    expect(readdirSync(userData)).toEqual([]);
  });
});

describe('staging the new version', () => {
  it('downloads the digest-verified AppImage and replaces the running file on ordinary quit', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    const { asked, body } = github();
    await asPlatform('linux', live, () => checkForUpdates());

    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', APPIMAGE_ASSET]);
    const staged = path.join(userData, 'updates', NEXT, APPIMAGE_ASSET);
    expect(readFileSync(staged, 'utf8')).toBe(body);
    expect(existsSync(`${staged}.part`)).toBe(false);

    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(existsSync(`${live}.new`)).toBe(false);
    expect(relaunched).toEqual([]);
  });

  /**
   * The one that a length check would wave through, and the reason the digest is the bar: the
   * artifact that arrives is the wrong build at exactly the right size. Nothing may be staged,
   * and nothing may be left on disk for a later quit to find.
   */
  it('stages nothing when the artifact is not the file the release published', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github({ checksums: `${sha256('a different build')}  ${APPIMAGE_ASSET}\n` });
    await asPlatform('linux', live, () => checkForUpdates());

    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain('not the published file');
    expect(readdirSync(path.join(userData, 'updates', NEXT))).toEqual([]);
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('old image bytes');
    expect(relaunched).toEqual([]);
  });

  it('stages nothing when the release does not publish an artifact for this installation', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github({ checksums: `${sha256('x')}  ChatBBC-Extension.zip\n` });
    await asPlatform('linux', live, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(updateStatus().error).toContain(`publishes no ${APPIMAGE_ASSET}`);
    expect(readFileSync(live, 'utf8')).toBe('old image bytes');
  });
});

describe('one pass at a time, and one more next time the app opens', () => {
  it('joins an in-flight check instead of downloading twice', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    const { asked, body } = github();
    await asPlatform('linux', live, async () => {
      await Promise.all([checkForUpdates(), checkForUpdates(), checkForUpdates()]);
    });
    expect(asked).toEqual(['latest', 'SHA256SUMS.txt', APPIMAGE_ASSET]);
    expect(readFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'utf8')).toBe(body);
  });

  it('retries a failed release check on a later pass', async () => {
    github({ fail: 'release' });
    await checkForUpdates();
    expect(updateStatus()).toMatchObject({ latest: null, stage: 'failed', checkedAt: null });
    expect(updateStatus().error).toContain('503');
    const live = path.join(userData, 'ChatBBC.AppImage');
    const { body } = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    expect(readFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'utf8')).toBe(body);
  });

  it('retries a failed artifact download on a later pass', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    github({ fail: 'asset' });
    await asPlatform('linux', live, () => checkForUpdates());
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'failed' });
    const { body } = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(readFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'utf8')).toBe(body);
    expect(updateStatus().stage).toBe('ready');
  });

  it('does not download a version it has already staged', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    const first = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(first.asked).toEqual(['latest', 'SHA256SUMS.txt', APPIMAGE_ASSET]);
    const second = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(second.asked).toEqual(['latest']);
    expect(readFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'utf8')).toBe(first.body);
  });

  it('replaces the running AppImage only once', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    const { body } = github();
    await asPlatform('linux', live, () => checkForUpdates());
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe(body);
    writeFileSync(live, 'changed after first quit');
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('changed after first quit');
    expect(relaunched).toEqual([]);
  });
});

describe('a download that survives the process that fetched it', () => {
  it('reuses a previous run’s verified bytes instead of downloading again', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    const first = github();
    await asPlatform('linux', live, () => checkForUpdates());
    resetUpdateForTests();
    const second = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt']);
    expect(updateStatus()).toMatchObject({ latest: NEXT, stage: 'ready', error: null });
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe(first.body);
    expect(relaunched).toEqual([]);
  });

  it('refetches a corrupted staged artifact before it can replace the running file', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    writeFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'something else entirely');
    resetUpdateForTests();
    const second = github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(second.asked).toEqual(['latest', 'SHA256SUMS.txt', APPIMAGE_ASSET]);
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe(second.body);
  });

  it('keeps only the latest version staged', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    github({ version: '98.0.0' });
    await asPlatform('linux', live, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual(['98.0.0']);
    resetUpdateForTests();
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(readdirSync(path.join(userData, 'updates'))).toEqual([NEXT]);
  });
});

describe('installing on request', () => {
  it('relaunches only after replacing the running AppImage', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    const { body } = github();
    await asPlatform('linux', live, async () => {
      await checkForUpdates();
      expect(markInstallOnQuit()).toBe(true);
      await applyStagedUpdate();
    });
    expect(readFileSync(live, 'utf8')).toBe(body);
    expect(relaunched).toEqual([{ execPath: live }]);
  });

  it('refuses an Install request when no new image was downloaded', async () => {
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(markInstallOnQuit()).toBe(false);
    expect(relaunched).toEqual([]);
  });

  it('does not carry a relaunch request into the next ordinary quit', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(relaunched).toEqual([{ execPath: live }]);
    resetUpdateForTests();
    relaunched.length = 0;
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('new AppImage bytes');
    expect(relaunched).toEqual([]);
  });
});

describe('staged executable authority across later events', () => {
  it('retires the old staged artifact before a replacement download fails', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    github({ version: '99.0.1', fail: 'asset' });
    await asPlatform('linux', live, () => checkForUpdates());
    expect(updateStatus().stage).toBe('failed');
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('old image bytes');
  });

  it('does not apply a staged release withdrawn from the latest feed', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    github({ version: APP_VERSION });
    await checkForUpdates();
    expect(markInstallOnQuit()).toBe(false);
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('old image bytes');
  });

  it('checks staged bytes again at the actual AppImage handoff', async () => {
    const live = path.join(userData, 'ChatBBC.AppImage');
    writeFileSync(live, 'old image bytes');
    github();
    await asPlatform('linux', live, () => checkForUpdates());
    writeFileSync(path.join(userData, 'updates', NEXT, APPIMAGE_ASSET), 'changed after download');
    expect(markInstallOnQuit()).toBe(true);
    await applyStagedUpdate();
    expect(readFileSync(live, 'utf8')).toBe('old image bytes');
    expect(relaunched).toEqual([]);
  });

  it('starts immediately and repeats on the unreferenced six-hour timer', async () => {
    const unref = vi.fn();
    let repeat: (() => void) | undefined;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(6 * 60 * 60_000);
      repeat = callback;
      return { unref };
    }) as unknown as typeof setInterval);
    try {
      const { startUpdateChecks } = await import('../src/main/update.js');
      const first = github({ version: APP_VERSION });
      startUpdateChecks(); await checkForUpdates();
      expect(first.asked).toEqual(['latest']); expect(unref).toHaveBeenCalledOnce();
      const next = github({ version: APP_VERSION });
      repeat!(); await checkForUpdates();
      expect(next.asked).toEqual(['latest']);
    } finally { interval.mockRestore(); }
  });
});
