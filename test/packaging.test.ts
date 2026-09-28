import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingTargets from '../scripts/packaging-targets.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertSupportedReleaseTarget } from '../scripts/package.mjs';
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
  it('stages only the target Pets FFI payload and probes the packaged binding', () => {
    const config = yamlFile('electron-builder.yml');
    expect(config.files).toContain('!node_modules/@koromix/koffi-*/**/*');
    expect(config.files).toContain('!node_modules/koffi/build/**/*');
    expect(config.asarUnpack).toContain('**/node_modules/@koromix/koffi-*/**');
    const staging = readFileSync(path.join(root, 'scripts/prepare-packaging-native.mjs'), 'utf8');
    expect(staging).toContain("if (platform === 'win32') packages.push(`@koromix/koffi-win32-${arch}`)");
    const smoke = readFileSync(path.join(root, 'scripts/smoke-packaged-runtime.mjs'), 'utf8');
    expect(smoke).toContain("appRequire('koffi')");
    expect(smoke).toContain('runtime.petFocus !== true');
  });
  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('pins tunnel-client and ripgrep bytes for every retained platform and CPU pair', () => {
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
    expect(sharpPackagesFor('linux', 'x64')).toEqual(['@img/sharp-wasm32']);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every supported host', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('exposes exactly the supported local Linux x64 distribution commands', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const supported: Record<string, string> = {
      dist: 'node scripts/package.mjs --platform linux --arch x64',
      'dist:linux:x64': 'node scripts/package.mjs --platform linux --arch x64',
      'dist:dir': 'node scripts/package.mjs --platform linux --arch x64 --dir',
      'dist:dir:linux:x64': 'node scripts/package.mjs --platform linux --arch x64 --dir'
    };
    for (const [name, command] of Object.entries(supported)) expect(pkg.scripts[name]).toBe(command);
    for (const name of Object.keys(pkg.scripts) as string[]) {
      if (name.startsWith('dist')) expect(Object.keys(supported)).toContain(name);
    }
    // Aliases for targets this project neither builds nor verifies are removed instead of left
    // behind to fail the host/target gate only after someone invoked them.
    for (const removed of [
      'dist:win', 'dist:x64', 'dist:arm64', 'dist:mac', 'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux', 'dist:linux:arm64', 'dist:dir:win', 'dist:dir:x64', 'dist:dir:arm64',
      'dist:dir:mac', 'dist:dir:mac:x64', 'dist:dir:mac:arm64', 'dist:dir:linux', 'dist:dir:linux:arm64',
      'desktop:mac', 'verify:ci'
    ]) expect(pkg.scripts[removed]).toBeUndefined();
  });

  it('wires verification and release through the local-only command names', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.verify).toBe('npm run verify:local');
    const chain: string = pkg.scripts['verify:local'];
    const referenced = [...chain.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((match) => match[1]!);
    for (const name of referenced) expect(pkg.scripts[name]).toBeTypeOf('string');
    expect(referenced).toContain('verify:rebrand');
    expect(referenced).toContain('verify:upstream-map');
    // The foreground-sensitive native suites still run last, in their own single-worker stage.
    expect(chain).toContain('vitest run --exclude test/mcp-shutdown.test.ts --exclude test/computer.test.ts');
    expect(chain).toContain('vitest run --maxWorkers=1 test/computer.test.ts test/mcp-shutdown.test.ts');
    expect(pkg.scripts['verify:ui']).toBe('node scripts/verify-local-ui.mjs');
    expect(pkg.scripts['release:local']).toBe('node scripts/release-local.mjs');
    expect(pkg.scripts['release:publish']).toBe('node scripts/release-local.mjs --publish');
  });

  it('refuses an unsupported host or release target before starting any build step', () => {
    expect(() => assertSupportedReleaseTarget({
      hostPlatform: 'darwin', hostArch: 'arm64', platform: 'linux', arches: ['x64']
    })).toThrow(/builds only on Linux x64/);
    expect(() => assertSupportedReleaseTarget({
      hostPlatform: 'linux', hostArch: 'arm64', platform: 'linux', arches: ['x64']
    })).toThrow(/builds only on Linux x64/);
    expect(() => assertSupportedReleaseTarget({
      hostPlatform: 'linux', hostArch: 'x64', platform: 'linux', arches: ['x64', 'arm64']
    })).toThrow(/requested arch arm64/);
    expect(() => assertSupportedReleaseTarget({
      hostPlatform: 'linux', hostArch: 'x64', platform: 'linux', arches: ['x64']
    })).not.toThrow();

    for (const target of [
      ['--platform', 'win32', '--arch', 'x64'],
      ['--platform', 'darwin', '--arch', 'x64'],
      ['--platform', 'linux', '--arch', 'arm64']
    ]) {
      const result = spawnSync(process.execPath, ['scripts/package.mjs', ...target], {
        cwd: root, encoding: 'utf8', timeout: 30_000
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Linux x64/);
    }
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
    expect(smoke).toContain("'@modelcontextprotocol/core/internal'");
    expect(smoke).toContain("'@modelcontextprotocol/server'");
    expect(smoke).toContain("'@modelcontextprotocol/client'");
    expect(smoke).toContain("'@modelcontextprotocol/node'");
    expect(smoke).toContain('runtime.mcp !== true');
  });

  it('only reports renderer readiness after the initial state snapshot has completed', () => {
    const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
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

  it('runs the packaging pipeline once the host and target are supported', async () => {
    const fixture = await makeTempDir('package-');
    try {
      const scripts = path.join(fixture, 'scripts');
      await fs.mkdir(scripts, { recursive: true });
      for (const file of ['package.mjs', 'packaging-targets.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(scripts, file));
      }
      // The first pipeline step materializes the Electron runtime from the project's own
      // node_modules, which the fixture satisfies; the second step's generator is deliberately
      // absent, so its failure proves the entrypoint kept running the pipeline in order. A
      // regression that made the script exit silently (for example a broken main guard) would
      // instead end at the host/target gate with exit 2 and no further step output.
      await fs.mkdir(path.join(fixture, 'node_modules', 'electron'), { recursive: true });
      await fs.writeFile(path.join(fixture, 'node_modules', 'electron', 'package.json'),
        JSON.stringify({ name: 'electron', version: '44.3.0', main: 'index.js' }));
      await fs.writeFile(path.join(fixture, 'node_modules', 'electron', 'index.js'), 'module.exports = {}\n');

      const result = spawnSync(process.execPath, ['scripts/package.mjs', '--platform', 'linux', '--arch', 'x64'], {
        cwd: fixture, encoding: 'utf8', timeout: 30_000
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('Linux x64 AppImages only');
      expect(result.stderr).toContain('generate-third-party-notices.mjs');
    } finally {
      await removeTempDir(fixture);
    }
  });

  it('ships only the ChatBBC Linux x64 AppImage with its native payloads and notices', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('chatbbc');
    expect(pkg.desktopName).toBe('com.chatbbc.app.desktop');
    expect(pkg.homepage).toBe('https://github.com/TheBigBrainChad/chatbbc');
    expect(builder.appId).toBe('com.chatbbc.app');
    expect(builder.productName).toBe('ChatBBC');
    expect(builder.linux.executableName).toBe('chatbbc');
    expect(builder.linux.target).toEqual(['AppImage']);
    expect(builder.linux.artifactName).toBe('ChatBBC-Linux-x64.AppImage');
    expect(builder.linux.icon).toBe('build/icon.png');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(builder.linux.maintainer).toBe('TheBigBrainChad <TheBigBrainChad@users.noreply.github.com>');
    // electron-builder 26 defaults to a FUSE2-dependent AppImage runtime, which is not installed
    // by default on the current Ubuntu LTS the release target tracks.
    expect(builder.toolsets.appimage).toBe('1.0.3');

    // Target-native payload narrowing, runtime icon, tunnel, ripgrep and sharp notices still ship.
    expect(builder.linux.files).toEqual([{
      from: 'resources/packaging/native/linux/${arch}/node_modules',
      to: 'node_modules',
      filter: ['**/*']
    }]);
    expect(builder.linux.extraResources).toContainEqual({ from: 'build/runtime-icon.png', to: 'runtime-icon.png' });
    expect(builder.linux.extraResources).toContainEqual({
      from: 'resources/packaging/tunnel/linux/${arch}', to: 'tunnel', filter: ['**/*']
    });
    expect(builder.linux.extraResources).toContainEqual({
      from: 'resources/packaging/rg/linux/${arch}', to: 'rg', filter: ['**/*']
    });
    expect(builder.extraResources).toContainEqual({ from: 'LICENSE', to: 'LICENSE' });
    expect(builder.extraResources).toContainEqual({ from: 'THIRD-PARTY-NOTICES.txt', to: 'THIRD-PARTY-NOTICES.txt' });
    expect(builder.extraResources).toContainEqual({
      from: 'extension', to: 'extension', filter: ['**/*', '!**/*.map']
    });
    expect(builder.asarUnpack).toContain('**/node_modules/node-pty/**');
    expect(builder.asarUnpack).toContain('**/node_modules/@img/**');

    // No configuration remains for artifacts this project does not build, verify or publish.
    for (const key of ['win', 'nsis', 'mac', 'deb', 'afterPack']) expect(builder[key]).toBeUndefined();

    // The packaging entrypoint keeps the unpacked-artifact smoke instead of trusting builder's
    // exit status, and no longer stages a target whose helper cannot exist on Linux.
    const packageScript = readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8');
    expect(packageScript).toContain('scripts/smoke-packaged-runtime.mjs');
    expect(packageScript).not.toContain('prepare-macos-desktop-helper');
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

  it('fails release-existence preflight closed on API errors instead of continuing to a candidate build', async () => {
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
});
