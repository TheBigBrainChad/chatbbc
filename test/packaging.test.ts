import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertReleaseAbsent } from '../scripts/check-release-absent.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertCurrentTunnelRelease } from '../scripts/verify-current-tunnel.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as macOSAuditUtils from '../scripts/macos-audit-utils.mjs';
const { RIPGREP, TUNNEL_CLIENT } = packagingVersions;
const {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  macOSDeploymentTargetsFromOtool,
  withOtoolSafePath
} = macOSAuditUtils;
const {
  normalizeArch,
  normalizePlatform,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = packagingTargets;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function yamlFile(relative: string): any {
  return loadYaml(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

describe('cross-platform packaging targets', () => {
  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('pins tunnel-client and ripgrep for every release OS/CPU pair', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(TUNNEL_CLIENT.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('fails closed unless the pinned tunnel-client is OpenAI\'s current stable release', async () => {
    const response = (body: Record<string, unknown>, status = 200) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });

    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).resolves.toMatchObject({ tag_name: 'v0.0.14' });
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.13',
      fetchImpl: response({ tag_name: 'v0.0.14', draft: false, prerelease: false })
    })).rejects.toThrow(/v0\.0\.13 is stale.*v0\.0\.14/);
    await expect(assertCurrentTunnelRelease({
      pinnedVersion: 'v0.0.14',
      fetchImpl: response({ message: 'rate limited' }, 403)
    })).rejects.toThrow(/refusing to publish without proving the pin is current/);
  });

  it('selects only target Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every CI operating system', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('keeps scripts for all six release targets and legacy Windows aliases', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const script of [
      'dist', 'dist:x64', 'dist:arm64',
      'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux:x64', 'dist:linux:arm64'
    ]) expect(pkg.scripts[script]).toBeTypeOf('string');
  });

  it('pins Electron 44.3.0 exactly and proves packaged runners use those runtime bytes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');

    expect(pkg.devDependencies.electron).toBe('44.3.0');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('44.3.0');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('44.3.0');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
  });

  it('pins the isolated Linux x64 image backend and provides its modified corresponding source', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const sources = JSON.parse(readFileSync(path.join(root, 'docs/licenses/native/sources.json'), 'utf8'));
    const backend = readFileSync(path.join(root, 'src/main/sharp.ts'), 'utf8');
    const packaging = readFileSync(path.join(root, 'scripts/package.mjs'), 'utf8');
    const smoke = readFileSync(path.join(root, 'scripts/smoke-packaged-runtime.mjs'), 'utf8');
    const builder = yamlFile('electron-builder.yml');

    expect(pkg.dependencies.sharp).toBe('0.35.4');
    expect(pkg.dependencies['@janhapke/sharp-electron']).toBe('0.35.4-electron.1');
    expect(lock.packages['node_modules/@janhapke/sharp-electron'].integrity)
      .toBe('sha512-a8G1T2Cs+SND8Be61gJspHNoUXXVQujbfnHr1+a6IxsPgDNSId58LjiL+HMPg0pCxyMY7aC8U/INRWRp7G7RXQ==');
    expect(sources.packages['@janhapke/sharp-electron']).toBe('0.35.4-electron.1');
    expect(sources.sources).toContainEqual(expect.objectContaining({
      id: 'sharp-electron-patched-build',
      sha256: '5826538e26d76f7db44b1adfe0766e6f00c86ce3c9495225d26386198d0247de',
      bytes: 50967
    }));
    expect(backend).toContain("process.platform === 'linux' && process.arch === 'x64'");
    expect(backend).toContain("require('@janhapke/sharp-electron')");
    expect(backend).toContain("require('sharp')");
    expect(packaging).toContain('target-builder-config.cjs');
    expect(builder.asarUnpack).toContain('**/node_modules/@janhapke/sharp-electron/**');
    expect(smoke).toContain("const decoded = await sharp(png).metadata()");
    expect(smoke).toContain("const webp = await sharp(png).resize(1, 1).webp().toBuffer()");
  });

  it('reconstructs the modified Linux x64 source from verified release archives and identifies its paired replacement files', () => {
    const sources = JSON.parse(readFileSync(path.join(root, 'docs/licenses/native/sources.json'), 'utf8'));
    const document = readFileSync(path.join(root, 'docs/licenses/native/SOURCE-BUILD.md'), 'utf8');
    const section = document.match(/### Linux x64 fork: archive-only reconstruction\n([\s\S]*?)(?=\n## |\n### |$)/)?.[1];
    expect(section, 'source recipient needs a runnable archive-only fork reconstruction procedure').toBeDefined();
    const recipe = section?.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(recipe, 'documented reconstruction recipe must be runnable verbatim').toBeDefined();

    const sourcePins = [
      { id: 'sharp-electron-patched-build', file: 'sharp-electron-f7afa507.tar.gz', version: 'f7afa507bfc6975bad73ed9c6a8ee5c3be88b848', sha256: '5826538e26d76f7db44b1adfe0766e6f00c86ce3c9495225d26386198d0247de' },
      { id: 'sharp-source', file: 'sharp-source-903128da.tar.gz', version: '7f1a0a22cc285fe180766f4935d50b55af6e8432', sha256: '9e84202dc927f0c0dfda583301f245b6d92bdd8c5af7bd4dae436c608f01785f' },
      { id: 'sharp-libvips-build', file: 'sharp-libvips-build-f6fad46c.tar.gz', version: '6e5971d333377743163edc3ad9e5d0b897abcbc9', sha256: 'aea60d36644f88b47a3998564f12264fd7638dc4559f083e9ff3fb25c9caa87b' }
    ];
    for (const pin of sourcePins) {
      expect(sources.sources).toContainEqual(expect.objectContaining({
        id: pin.id, file: pin.file, version: expect.stringContaining(pin.version), sha256: pin.sha256
      }));
      expect(recipe).toContain(pin.file);
      expect(recipe).toContain(`${pin.sha256}  ${pin.file}`);
    }

    const installed = 'app.asar.unpacked/node_modules/@janhapke/sharp-electron/linux-x64/sharp/src/build/Release/';
    expect(section).toContain('vendor/sharp/src/build/Release/sharp-linux-x64-0.35.4.node');
    expect(section).toContain('dist/linux-x64/lib/libvips-cpp.so.8.18.6');
    expect(section).toContain(`${installed}sharp-linux-x64-0.35.4.node`);
    expect(section).toContain(`${installed}libvips-cpp.so.8.18.6`);

    const archives = path.join(root, 'release/native-sources/archives');
    const available = sourcePins.map(({ file }) => existsSync(path.join(archives, file)));
    if (!available.some(Boolean)) return; // CI's source job generates release archives separately.
    expect(available, 'a partially staged native-source bundle must never be accepted').toEqual([true, true, true]);

    const scratch = mkdtempSync(path.join(tmpdir(), 'chatbbc-sharp-source-'));
    const checkout = path.join(scratch, 'fork');
    try {
      execFileSync('bash', ['-euo', 'pipefail', '-c', recipe!, '--', archives, checkout], {
        cwd: root, timeout: 90_000, stdio: 'pipe'
      });
      for (const [vendor, patch] of [
        ['sharp', 'sharp-glib-calls.patch'],
        ['sharp-libvips', 'sharp-libvips-glib-wrapper.patch']
      ] as const) {
        expect(existsSync(path.join(checkout, 'vendor', vendor, '.git'))).toBe(true);
        execFileSync('git', ['-C', path.join(checkout, 'vendor', vendor), 'apply', '--reverse', '--check',
          path.join(checkout, 'patches', patch)], { timeout: 15_000, stdio: 'pipe' });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 100_000);

  it('runs fork reconstruction unconditionally in the native-sources release job before upload', () => {
    const steps = yamlFile('.github/workflows/release.yml').jobs.sources.steps as Array<Record<string, unknown>>;
    const archive = steps.findIndex((step) => step.run === 'node scripts/package-native-sources.mjs');
    const dependencies = steps.findIndex((step) => step.run === 'npm ci');
    const reconstruct = steps.findIndex((step) => step.name === 'Reconstruct supplied Linux x64 Sharp fork');
    const upload = steps.findIndex((step) => step.name === 'Upload source artifact');
    expect(archive).toBeGreaterThanOrEqual(0);
    expect(dependencies).toBeGreaterThan(archive);
    expect(reconstruct).toBeGreaterThan(dependencies);
    expect(upload).toBeGreaterThan(reconstruct);

    const verification = steps[reconstruct];
    if (!verification) throw new Error('Native-source reconstruction step is missing');
    expect(verification.if).toBeUndefined();
    expect(verification['continue-on-error']).toBeUndefined();
    expect(verification.shell).toBe('bash');
    const command = verification.run as string;
    expect(command).toContain('set -euo pipefail');
    expect(command).toContain('test -f "$archives/$archive"');
    for (const file of [
      'sharp-electron-f7afa507.tar.gz',
      'sharp-source-903128da.tar.gz',
      'sharp-libvips-build-f6fad46c.tar.gz'
    ]) expect(command).toContain(file);
    expect(command).toContain("./node_modules/.bin/vitest run test/packaging.test.ts -t 'reconstructs the modified Linux x64 source from verified release archives and identifies its paired replacement files'");
    expect(command).not.toMatch(/\|\|\s*(?:true|:)|\bexit 0\b/);
  });

  it('grants sandbox read access only to the Windows install tree and fails on ACL errors', () => {
    const config = yamlFile('electron-builder.yml');
    const installer = readFileSync(path.join(root, 'scripts/windows-installer-acl.nsh'), 'utf8');
    expect(config.nsis.include).toBe('scripts/windows-installer-acl.nsh');
    expect(installer).toContain('!macro customInit');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(installer).toContain('ExecWait');
    expect(installer).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"');
    expect(installer).toContain('${If} ${Errors}');
    expect(installer).toContain('${If} $0 != 0');
    expect(installer).toContain('SetErrorLevel 2');
    expect(installer).toContain('Abort "Windows could not set the folder access needed');
    expect(installer).not.toMatch(/\/(?:reset|remove|T)\b/i);
    expect(installer).not.toMatch(/(?:no-sandbox|disable-gpu-sandbox)/i);
  });

  it('assembles every supported platform artifact in the reusable release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const parsed = yamlFile('.github/workflows/release.yml');
    const matrix = parsed.jobs.package.strategy.matrix.include;
    // This fork is Linux only. The assertion states which targets ship, so adding or removing one
    // is a deliberate edit here rather than something a workflow change can do quietly.
    expect(matrix).toEqual([
      {
        name: 'Linux x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04',
        script: 'dist:linux:x64', artifact: 'package-linux-x64',
        files: 'release/ChatBBC-Linux-x64.AppImage\nrelease/ChatBBC-Linux-x64.deb\n'
      },
      {
        name: 'Linux arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm',
        script: 'dist:linux:arm64', artifact: 'package-linux-arm64',
        files: 'release/ChatBBC-Linux-arm64.AppImage\nrelease/ChatBBC-Linux-arm64.deb\n'
      }
    ]);
    expect(parsed.jobs.package['runs-on']).toBe('${{ matrix.runner }}');

    // The Windows and macOS targets are gone on purpose, and their steps with them: a leftover
    // macOS step would never run, and a leftover installer path would fail the assembly step that
    // requires every listed file to exist. Both would read as "macOS still ships".
    for (const gone of ['windows-2025', 'macos-15', 'ChatBBC-Setup-x64.exe', 'ChatBBC-macOS-x64.dmg',
      'smoke-macos-gui.mjs', 'smoke-macos-bundle.mjs', 'Verify generated macOS archives',
      'Audit packaged macOS bundle metadata and Mach-O payloads', 'hdiutil verify']) {
      expect(workflow, `release.yml still references ${gone}`).not.toContain(gone);
    }

    expect(workflow).toContain('name: chatbbc-candidate-${{ github.run_id }}');
    expect(workflow).toContain('Install generated DEB on target distro');
    expect(workflow).toContain('Launch installed DEB normally under Xvfb');
    expect(workflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/chatbbc');
    expect(workflow).toContain('Execute generated static-runtime AppImage');
    expect(workflow).toContain('architecture: ${{ matrix.arch }}');

    const debGui = workflow.slice(
      workflow.indexOf('      - name: Launch installed DEB normally under Xvfb'),
      workflow.indexOf('      - name: Execute generated static-runtime AppImage')
    );
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain("grep -Fxq 'Name=ChatBBC' \"$desktop\"");
    expect(workflow).toContain("grep -Fxq 'Icon=chatbbc' \"$desktop\"");
    expect(debGui).toContain('deb_smoke_root="$(mktemp -d)"');
    // Same shape the AppImage smoke below is held to: the teardown may retry, and may fail,
    // but it may never decide the step. Only the assertions under it do that.
    expect(debGui).toContain('cleanup_path_with_retries()');
    expect(debGui).toContain("trap 'cleanup_path_with_retries \"$deb_smoke_root\"' EXIT");
    expect(debGui).toContain('rm -rf "$target" 2>/dev/null || true');
    expect(debGui).toContain('HOME="$deb_smoke_root/home"');
    expect(debGui).toContain('XDG_CONFIG_HOME="$deb_smoke_root/config"');
    expect(debGui).toContain('XDG_CACHE_HOME="$deb_smoke_root/cache"');
    expect(debGui).toContain('XDG_DATA_HOME="$deb_smoke_root/data"');
    expect(debGui).toContain('XDG_STATE_HOME="$deb_smoke_root/state"');
    expect(debGui).toContain('xvfb-run -a /usr/bin/chatbbc');
    expect(debGui).toContain('--kill-after=5s 12s');
    expect(debGui).toContain("grep -Fq '[info] app started' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] window loaded' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] renderer state ready' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] window failed to load' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] renderer:' deb-gui.log");
    expect(debGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const appImageGui = workflow.slice(
      workflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      workflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageGui).toContain('xvfb-run -a "$appimage"');
    expect(appImageGui).toContain('normal_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('fallback_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('rm -rf "$fake_bin" "$normal_smoke_root" "$fallback_smoke_root"');
    expect(appImageGui).toContain('HOME="$smoke_root/home"');
    expect(appImageGui).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(appImageGui).toContain('XDG_CACHE_HOME="$smoke_root/cache"');
    expect(appImageGui).toContain('XDG_DATA_HOME="$smoke_root/data"');
    expect(appImageGui).toContain('XDG_STATE_HOME="$smoke_root/state"');
    expect(appImageGui).toContain("printf '#!/bin/sh\\nexit 1\\n' > \"$fake_bin/unshare\"");
    expect(appImageGui).toContain('PATH="$launch_path"');
    expect(appImageGui).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(appImageGui).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] renderer state ready' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] window failed to load' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] renderer:' \"$log\"");
    expect(appImageGui).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(appImageGui).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(appImageGui.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('only reports renderer readiness after the initial state snapshot has completed', () => {
    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await currentState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    const returned = ipc.indexOf('return state;', ready);

    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
    expect(returned).toBeGreaterThan(ready);
  });

  it('keeps a losing second instance out of the async primary bootstrap', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const losingBranch = main.indexOf('if (!hasSingleInstanceLock) {', lock);
    const markQuitting = main.indexOf('quitting = true;', losingBranch);
    const ready = main.indexOf('void app.whenReady().then(async () => {', losingBranch);
    const readyGuard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstSharedStateRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(lock).toBeGreaterThan(-1);
    expect(losingBranch).toBeGreaterThan(lock);
    expect(markQuitting).toBeGreaterThan(losingBranch);
    expect(markQuitting).toBeLessThan(ready);
    expect(readyGuard).toBeGreaterThan(ready);
    expect(readyGuard).toBeLessThan(firstSharedStateRead);

    const beforeQuit = main.indexOf("app.on('before-quit', () => {");
    const beforeQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', beforeQuit);
    const beforeQuitMutation = main.indexOf('quitting = true;', beforeQuit);
    const windowAllClosed = main.indexOf("app.on('window-all-closed', () => {");
    const windowAllOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', windowAllClosed);
    const windowAllConfig = main.indexOf('getConfig().ui.minimizeToTray', windowAllClosed);
    const willQuit = main.indexOf("app.on('will-quit', (event) => {");
    const willQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', willQuit);
    const preventDefault = main.indexOf('event.preventDefault();', willQuit);

    expect(beforeQuitOwner).toBeGreaterThan(beforeQuit);
    expect(beforeQuitOwner).toBeLessThan(beforeQuitMutation);
    expect(windowAllOwner).toBeGreaterThan(windowAllClosed);
    expect(windowAllOwner).toBeLessThan(windowAllConfig);
    expect(willQuitOwner).toBeGreaterThan(willQuit);
    expect(willQuitOwner).toBeLessThan(preventDefault);
  });

  it('applies the persisted native theme before the first packaged BrowserWindow can be created', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const ready = main.indexOf('void app.whenReady().then(async () => {');
    const loadConfig = main.indexOf('await loadConfig();', ready);
    // The live desktop theme resolves through one helper that owns the native chrome update
    // (spec §5). The asserted contract is still "the persisted choice is applied before the
    // first window request", not that the assignment is written inline in the bootstrap.
    const refresh = main.indexOf('function refreshNativeChromeTheme(): void {');
    const themeAssign = main.indexOf('nativeTheme.themeSource = chrome.theme;', refresh);
    const refreshCall = main.indexOf('refreshNativeChromeTheme();', loadConfig);
    const enableActivation = main.indexOf('windowActivation.enable();', refreshCall);
    const firstWindowRequest = main.indexOf('windowActivation.request();', enableActivation);

    expect(refresh).toBeGreaterThan(-1);
    expect(themeAssign).toBeGreaterThan(refresh);
    expect(loadConfig).toBeGreaterThan(ready);
    expect(refreshCall).toBeGreaterThan(loadConfig);
    expect(enableActivation).toBeGreaterThan(refreshCall);
    expect(firstWindowRequest).toBeGreaterThan(enableActivation);

    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const save = ipc.indexOf("handle('settings:save', async (payload) => {");
    const liveTheme = ipc.indexOf('nativeTheme.themeSource = chromeTheme;', save);
    // The live palette update goes through the appearance bridge when one is registered, and
    // falls back to the plain window background otherwise. Either way it happens after the
    // theme mode is committed for this save.
    const background = ipc.indexOf('const background = windowBackgroundForTheme(chromeTheme, effectiveAppearance(next.ui, liveTheme));', liveTheme);
    const applied = ipc.indexOf('appearance.updateBackground(background);', background);
    expect(save).toBeGreaterThan(-1);
    expect(liveTheme).toBeGreaterThan(save);
    expect(background).toBeGreaterThan(liveTheme);
    expect(applied).toBeGreaterThan(background);
  });

  it('uses Noble-compatible Linux packages and a FUSE-independent AppImage runtime', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(builder.toolsets.appimage).toBe('1.0.3');
    expect(builder.linux.artifactName).toBe('ChatBBC-Linux-${env.COS_PACKAGE_ARCH}.${ext}');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    // The disposable DEB smoke owns ALSA provider resolution; a source-string
    // assertion passed while apt selected an incompatible libasound2 provider.
    expect(builder.deb.depends).toContain('libgbm1');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(builder.linux.maintainer).toMatch(/^ChatBBC <[^>]+@users\.noreply\.github\.com>$/);
    expect(pkg.desktopName).toBe('com.chatbbc.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/TheBigBrainChad/chatbbc');
    expect(iconScript).toContain("build', 'icon.png'), pngFor(1024)");

    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain('COS_PACKAGE_ARCH: arch');
    const releaseWorkflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseWorkflow).toContain('HOME="$deb_smoke_root/home"');
    expect(releaseWorkflow).toContain('HOME="$smoke_root/home"');
    expect(releaseWorkflow).toContain('PATH="$launch_path"');
    expect(releaseWorkflow).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(releaseWorkflow).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(releaseWorkflow).toContain('CLF_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/chatbbc');
    expect(releaseWorkflow).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(releaseWorkflow).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Package)\" = chatbbc");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Version)\" = \"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('expected_deb_arch=amd64');
    expect(releaseWorkflow).toContain('test -L /usr/bin/chatbbc');
    expect(releaseWorkflow).toContain('installed_executable="$(readlink -f /usr/bin/chatbbc)"');
    expect(releaseWorkflow).toContain('test -x "$installed_executable"');
    expect(releaseWorkflow).toContain('dpkg-query -S "$installed_executable"');
    expect(releaseWorkflow).toContain("printf '%s\\n' \"$depends\" | grep -Eq 'libasound2");
    expect(releaseWorkflow).toContain("printf '%s\\n' \"$depends\" | grep -Eq '(^|, )libgbm1(,|$)'");
    expect(releaseWorkflow).toContain("node scripts/smoke-packaged-runtime.mjs --platform linux --arch '${{ matrix.arch }}' --root \"$(dirname \"$installed_executable\")\"");

    const appImageSection = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      releaseWorkflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageSection.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');

    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const security = readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
    for (const document of [readme, security]) {
      expect(document).toContain('--no-sandbox');
      expect(document).toMatch(/unprivileged user namespaces/i);
    }
  });

  it('keeps the static AppImage sandbox fallback conditional and duplicate-safe', () => {
    // Read the shipped template rather than requiring app-builder-lib to render it. The
    // assertions below are on the template's own text, so loading that dependency graph buys
    // no coverage and is the reason this case could hit the global 30s timeout under full-suite
    // contention while passing in about 1.5s alone.
    const source = readFileSync(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js'),
      'utf8'
    );

    expect(source).toContain('HAVE_NO_SANDBOX=0');
    expect(source).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(source).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(source).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(source).toContain('exec "$BIN" "\\${NO_SANDBOX[@]}" "\\${args[@]}"');
  });

  it('pins the current macOS release to unsigned thin native bundles with explicit metadata checks', () => {
    const builder = yamlFile('electron-builder.yml');
    const macSmoke = readFileSync(path.join(root, 'scripts', 'smoke-macos-bundle.mjs'), 'utf8');
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.mac.category).toBe('public.app-category.developer-tools');
    expect(builder.mac.minimumSystemVersion).toBe('13.0');
    expect(builder.mac.artifactName).toBe('ChatBBC-macOS-${arch}.${ext}');
    expect(builder.mac.extendInfo.NSUserNotificationAlertStyle).toBe('alert');
    const nativePrep = readFileSync(path.join(root, 'scripts', 'prepare-packaging-native.mjs'), 'utf8');
    expect(nativePrep).toContain("await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755)");
    for (const marker of [
      "CFBundleIdentifier: 'com.chatbbc.app'",
      "CFBundleExecutable: 'ChatBBC'",
      "CFBundleName: 'ChatBBC'",
      "CFBundleDisplayName: 'ChatBBC'",
      "CFBundleIconFile: 'icon.icns'",
      'CFBundleShortVersionString: packageVersion',
      'CFBundleVersion: packageVersion',
      "LSApplicationCategoryType: 'public.app-category.developer-tools'",
      "LSMinimumSystemVersion: '13.0'",
      'NSScreenCaptureUsageDescription:',
      "path.join(resources, 'desktop', 'macos-desktop-addon.node')",
      "path.join(resources, 'desktop', 'libcos-desktop.dylib')",
      "path.join(ptyDir, 'spawn-helper')",
      "path.join(nodeModules, 'tree-sitter', 'prebuilds'",
      "path.join(nodeModules, 'tree-sitter-bash', 'prebuilds'",
      "relative of ['tunnel/tunnel-client', 'tunnel/cloudflared', 'rg/rg']",
      "run('lipo', ['-archs', file])",
      "withOtoolSafePath(file, (otoolPath) => run('otool', ['-l', otoolPath]).stdout)",
      'walkFiles(contents)',
      "normalized.includes('.app/Contents/MacOS/')",
      "path.basename(file) === 'chrome_crashpad_handler'",
      "path.basename(file) === 'macos-desktop-addon.node'",
      'requireThinMachO(desktopAddon, true)',
      'requireThinMachO(desktopLibrary, true)',
      'requireThinMachO(file, launched)',
      'launchedMachOCount < 6',
      "run('plutil', ['-extract', key, 'raw', plist])",
      "run('codesign', ['--display', '--verbose=4', app]",
      "run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])",
      'assertNoTrustBearingMacCodeSignature(',
      "path.join(contents, '_CodeSignature', 'CodeResources')"
    ]) expect(macSmoke).toContain(marker);
    expect(macSmoke).not.toContain("'12.3'");
    expect(macSmoke).toContain("requireFile(path.join(resources, 'icon.icns'))");
    expect(macSmoke).toContain("iconBytes.toString('ascii', 0, 4) !== 'icns'");
    const packagedRuntime = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(packagedRuntime).toContain("for (const dependency of ['node-pty', 'tree-sitter', 'tree-sitter-bash'])");
    expect(packagedRuntime).toContain('directories.length !== 1 || directories[0] !== nativeDir');
    expect(packagedRuntime).toContain("required('desktop/macos-desktop-addon.node')");
    expect(packagedRuntime).toContain("required('desktop/libcos-desktop.dylib')");
    expect(packagedRuntime).toContain("addon.handle('{\"op\":\"warm\"}')");

    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('macOS 13 Ventura or newer');
  });

  it('hides Electron helper parentheses from otool-classic without changing the inspected file', () => {
    const file = '/Applications/ChatBBC.app/Contents/Frameworks/ChatBBC Helper (GPU).app/Contents/MacOS/ChatBBC Helper (GPU)';
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const result = withOtoolSafePath(
      file,
      (safePath: string) => {
        calls.push({ kind: 'inspect', args: [safePath] });
        expect(path.basename(safePath)).toBe('payload');
        expect(safePath).not.toMatch(/[()]/);
        return 'otool-output';
      },
      {
        tmpdir: '/tmp',
        mkdtempSync: (prefix: string) => {
          calls.push({ kind: 'mkdtemp', args: [prefix] });
          return '/tmp/cos-otool-safe';
        },
        symlinkSync: (target: string, alias: string) => {
          calls.push({ kind: 'symlink', args: [target, alias] });
        },
        rmSync: (target: string, options: unknown) => {
          calls.push({ kind: 'remove', args: [target, options] });
        }
      }
    );

    expect(result).toBe('otool-output');
    const safePrefix = path.join('/tmp', 'cos-otool-');
    const safeDirectory = '/tmp/cos-otool-safe';
    const safePayload = path.join(safeDirectory, 'payload');
    expect(calls).toEqual([
      { kind: 'mkdtemp', args: [safePrefix] },
      { kind: 'symlink', args: [file, safePayload] },
      { kind: 'inspect', args: [safePayload] },
      { kind: 'remove', args: [safeDirectory, { recursive: true, force: true }] }
    ]);
  });

  it('rejects Mach-O payloads whose deployment target exceeds the declared macOS floor', () => {
    const modern = `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 11
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
`;
    expect(macOSDeploymentTargetsFromOtool(modern)).toEqual(['11.0', '10.15']);
    expect(() => assertCompatibleMacOSDeploymentTargets('good.node', modern, '12.0')).not.toThrow();

    const tooNew = modern.replace('minos 11.0', 'minos 13.0');
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew, '13.0')).not.toThrow();
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew.replace('minos 13.0', 'minos 14.0'), '13.0')).toThrow(
      /requires macOS 14\.0, newer than Info\.plist LSMinimumSystemVersion 13\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('bad.node', tooNew, '12.0')).toThrow(
      /requires macOS 13\.0, newer than Info\.plist LSMinimumSystemVersion 12\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('missing.node', 'Load command 1\n cmd LC_SEGMENT_64', '12.0')).toThrow(
      /no macOS deployment target load command/
    );
  });

  it('allows Apple-Silicon ad-hoc signatures but rejects publisher-bearing macOS signatures', () => {
    // The sealed ad-hoc bundle, which is what ships: no Authority, no TeamIdentifier, and the
    // resource envelope its own executables imply.
    expect(() => assertNoTrustBearingMacCodeSignature('adhoc.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, true)).not.toThrow();

    expect(() => assertNoTrustBearingMacCodeSignature('developer-id.app', {
      status: 0,
      stdout: '',
      stderr: 'Signature size=9000\nAuthority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('unknown-success.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('inspection-failed.app', {
      status: null,
      stdout: '',
      stderr: 'codesign was terminated unexpectedly'
    }, true)).toThrow(/inspection failed unexpectedly/);
  });

  /**
   * Issue #66: the shape that shipped twice and would not launch.
   *
   * arm64 Mach-Os are ad-hoc signed by the linker whether anyone asks or not, so a bundle with no
   * CodeResources is one whose executables claim a resource seal the bundle does not have. macOS
   * reads that contradiction as damage — with Gatekeeper assessment already disabled, and no
   * crash report to show for it. This assertion used to *demand* that state, which is why two
   * releases shipped it and nothing caught them.
   */
  it('rejects a bundle whose executables are signed but which has no resource seal', () => {
    expect(() => assertNoTrustBearingMacCodeSignature('linker-signed.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, false)).toThrow(/no bundle CodeResources envelope/);

    // "Never signed at all" earns the same refusal. The seal is what macOS needs, and a packaged
    // arm64 app cannot reach that state anyway — the linker signs it regardless.
    expect(() => assertNoTrustBearingMacCodeSignature('unsigned.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    }, false)).toThrow(/no bundle CodeResources envelope/);
  });

  it('fails release-existence preflight closed on API errors instead of spending packaging runners', async () => {
    const options = {
      repository: 'owner/repo',
      tag: 'v2.0.2',
      token: 'test-token'
    };
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('', { status: 404 })
    })).resolves.toBeUndefined();
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toThrow(/already exists/);
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 })
    })).rejects.toThrow(/refusing to assume the release is absent/);
  });

  it('rejects invalid publishes before allocating the reusable six-runner build', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const preflight = workflow.indexOf('  preflight:');
    const candidate = workflow.indexOf('  candidate:');
    const publish = workflow.indexOf('  publish:');
    expect(preflight).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(candidate);
    expect(workflow.slice(preflight, candidate)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(preflight, candidate)).toContain('npm run verify:tunnel-current');
    expect(workflow.slice(preflight, candidate)).toContain('Verify release metadata agrees');
    expect(workflow.slice(preflight, candidate)).toContain("APP_VERSION = '([^']+)'");
    expect(workflow.slice(preflight, candidate)).toContain('has no release title');
    expect(workflow.slice(candidate, publish)).toContain('needs: preflight');
    expect(workflow.slice(publish)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(publish).match(/npm run verify:tunnel-current/g)).toHaveLength(1);
    expect(workflow).toContain('name: chatbbc-candidate-${{ github.run_id }}');
  });

  it('keeps version metadata aligned and validates artifacts independently of editorial release notes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'src', 'main', 'version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1]).toBe(pkg.version);
    expect(notes).toMatch(/^## .+$/m);

    // Every shipped artifact must appear in the checksum step, the candidate upload and the
    // publish step alike — the lockstep is the subject, and Linux-only is the current set.
    const artifacts = [
      'ChatBBC-Linux-x64.AppImage',
      'ChatBBC-Linux-x64.deb',
      'ChatBBC-Linux-arm64.AppImage',
      'ChatBBC-Linux-arm64.deb',
      'ChatBBC-Extension.zip',
      'ChatBBC-Native-Sources.tar.gz',
      'SHA256SUMS.txt'
    ];
    const checksumStep = release.slice(
      release.indexOf('      - name: Create SHA-256 checksums'),
      release.indexOf('      - name: Upload release candidate')
    );
    const candidateUpload = release.slice(release.indexOf('      - name: Upload release candidate'));
    const publishStep = publish.slice(publish.indexOf('      - name: Publish the release'));
    for (const artifact of artifacts) {
      expect(candidateUpload).toContain(artifact);
      expect(publishStep).toContain(artifact);
    }
    for (const artifact of artifacts.filter((artifact) => artifact !== 'SHA256SUMS.txt')) {
      expect(checksumStep).toContain(artifact);
    }
  });
});
