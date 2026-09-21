// An explicit target decision for native Sharp packaging, never a mutation of
// shared node_modules. Official and patched libvips have the same SONAME and
// must not coexist in the Linux x64 Electron process. Linux arm64 has no fork
// binary and must continue to use the original target-specific @img payload.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { load } = require('js-yaml');

const root = path.resolve(__dirname, '..');
const config = load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
const platform = process.env.COS_PACKAGE_PLATFORM;
const arch = process.env.COS_PACKAGE_ARCH;

if (!['linux', 'win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Missing or invalid native packaging target: ${platform}/${arch}`);
}
if (platform === 'linux' && arch === 'x64') {
  config.files.push('!node_modules/sharp/**', '!node_modules/sharp-upstream/**');
  // The x64 backend uses the co-located patched addon/libvips, never @img's
  // conflicting libvips. Keep node-pty and tree-sitter native staging intact.
  config.linux.files[0].filter = ['**/*', '!@img/**'];
} else {
  // The fork contains only Linux x64 ELF files. Do not ship them to arm64 or
  // an unrelated operating system simply because the dependency is pinned.
  config.files.push('!node_modules/@janhapke/sharp-electron/**');
}

module.exports = config;
