import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ChatBBC ships one artifact, built on one host kind. Both are refused rather than degraded. */
export const SUPPORTED_RELEASE_PLATFORM = 'linux';
export const SUPPORTED_RELEASE_ARCH = 'x64';

/**
 * Fail-closed host/target gate. Everything below it spends real build time (Electron runtime
 * materialization, icon/notices/stamp regeneration, the electron-vite bundle, pinned resource
 * fetches and electron-builder), so an unsupported request must stop here instead of emitting a
 * partial or misleadingly named artifact.
 */
export function assertSupportedReleaseTarget({
  hostPlatform = process.platform,
  hostArch = process.arch,
  platform,
  arches
}) {
  if (hostPlatform !== SUPPORTED_RELEASE_PLATFORM || hostArch !== SUPPORTED_RELEASE_ARCH) {
    throw new Error(
      `ChatBBC builds only on Linux ${SUPPORTED_RELEASE_ARCH}; this host is ${hostPlatform}/${hostArch}.`
    );
  }
  if (platform !== SUPPORTED_RELEASE_PLATFORM) {
    throw new Error(
      `ChatBBC releases are Linux ${SUPPORTED_RELEASE_ARCH} AppImages only; requested platform ${platform}.`
    );
  }
  for (const arch of arches) {
    if (arch !== SUPPORTED_RELEASE_ARCH) {
      throw new Error(
        `ChatBBC releases are Linux ${SUPPORTED_RELEASE_ARCH} AppImages only; requested arch ${arch}.`
      );
    }
  }
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);

  function value(name, fallback) {
    const direct = args.find((arg) => arg.startsWith(`--${name}=`));
    if (direct) return direct.slice(name.length + 3);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  }

  const platform = normalizePlatform(value('platform', process.platform));
  const arches = value('arch', process.arch).split(',').map((item) => normalizeArch(item.trim()));
  const dirOnly = args.includes('--dir');

  assertSupportedReleaseTarget({ platform, arches });

  const node = process.execPath;
  // electron-builder can download its own runtime into its cache, but our package also copies
  // Electron's LICENSE files from node_modules/electron/dist. A fresh npm install may leave that
  // package payload lazy until Electron itself is resolved, so make the local runtime materialize
  // before assembly instead of emitting an otherwise-working installer with missing notices.
  run(node, ['-e', "require('electron')"]);
  run(node, ['scripts/generate-third-party-notices.mjs']);
  run(node, ['scripts/make-icon.mjs']);
  // Before the bundle is built, so the stamp that ships is the stamp of what ships. The app and the
  // extension both read this one file to tell which extension build a browser is running.
  run(node, ['scripts/write-extension-stamp.mjs']);
  run(node, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build']);

  for (const arch of arches) {
    const targetArgs = ['--platform', platform, '--arch', arch];
    run(node, ['scripts/fetch-tunnel-client.mjs', ...targetArgs]);
    run(node, ['scripts/fetch-ripgrep.mjs', ...targetArgs]);
    run(node, ['scripts/prepare-packaging-native.mjs', ...targetArgs]);

    const builderArgs = [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      PLATFORM_INFO[platform].builderFlag,
      `--${arch}`,
      '--publish',
      'never'
    ];
    if (dirOnly) builderArgs.push('--dir');
    run(node, builderArgs);
    // A successful electron-builder exit only proves that an artifact was assembled. Exercise the
    // unpacked artifact immediately so missing transitive runtime modules (for example when the
    // checkout's node_modules was linked to another tree) fail this same packaging command instead
    // of producing an installer that crashes before the first BrowserWindow exists.
    run(node, ['scripts/smoke-packaged-runtime.mjs', ...targetArgs]);
  }
}

let invokedAsScript = false;
try {
  invokedAsScript = process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
} catch {
  invokedAsScript = false;
}
if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
