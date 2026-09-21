/**
 * Single main-process image backend. Electron on Linux x64 exposes system GLib
 * symbols that conflict with the stock Sharp/libvips binary, crashing during
 * image decoding. Use the separately pinned, symbol-isolated native build only
 * inside Electron on that platform. Host Node (including unit tests) must use
 * upstream Sharp: the patched addon relies on Electron's GLib/runtime linkage.
 * All other supported targets retain upstream Sharp.
 *
 * Require exactly one implementation, not both: loading two libvips builds in
 * the same process can bind the wrong library through their shared SONAME.
 */
import type upstreamSharp from 'sharp';

const sharp: typeof upstreamSharp = process.platform === 'linux' && process.arch === 'x64' &&
  Boolean(process.versions.electron)
  ? require('@janhapke/sharp-electron') as typeof upstreamSharp
  : require('sharp') as typeof upstreamSharp;

export default sharp;
