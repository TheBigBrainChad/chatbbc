# ChatBBC 2.2.0 local port — 2026-09-28

## Source and ownership

Imported upstream `dee4b5e94b8598d7630e6db62bada9ac6050f457` (2.1.18) from the upstream repository identified in `docs/upstream-map.json`; excluded its three hosted workflows and disabled repository GitHub Actions. Downstream identity, protocol 18, connector names, asset ownership, appearance, Linux x64 packaging and updater are mapped there. Retained upstream history/attribution and license text remain identified rather than rewritten as ChatBBC originals.

## Local verification observed

- `npm run verify` (the local gate): 248 test files passed, 13 skipped; 6,336 tests passed, 124 skipped. Rebrand, upstream-map, privacy, notices, typecheck, Electron runtime and bundled ripgrep checks passed.
- `npm run build` and `npm run verify:upstream-map` passed after native-source selection and Settings select-paint changes.
- `npm run verify:notices`: 160 production package notices, seven catalog entries, 731 native source archives and patches validated.
- Direct packaged-runtime probe: native Linux x64 Electron, Sharp 0.35.4 WebAssembly PNG decode/WebP encode, node-pty and tree-sitter loaded and exercised.
- `npm run verify:ui` passed six fixtures on Wayland: appearance, live Omarchy, Settings geometry, Sidebar/profile controls, real Linux PTY input/cwd/interrupt/dock lifecycle, and the production MV3 entry with Chromium browser-control transport. The terminal fixture's upstream PowerShell assumption was replaced with POSIX shell commands and shell-ready/viewport-owned waits; the GUI runner now supplies the installed Chromium path to its browser fixture.
- `npm run dist:linux:x64` built the AppImage and verified packaged native runtime (Electron 44.3.0, Sharp WebAssembly 0.35.4, libvips 8.18.6, PNG decode/WebP encode, PTY and tree-sitter). `node scripts/verify-chatbbc-package.mjs` exercised that AppImage's visible shell, composer retention, Appearance controls, embedded metadata and x64 architecture. This host's AppImageLauncher intercepted the first launch and waited on its integration dialog; the smoke runner now sets `APPIMAGELAUNCHER_DISABLE=1` for its isolated child so the actual AppImage runtime runs without altering host integration.
- Review found two release-boundary risks: `release:publish` now checks that `origin` resolves to the preflighted repository and pins each `gh release` operation with `--repo`; the packaged smoke kills its child process group after its graceful shutdown deadline and bounds reaping. The foreign-origin regression failed before the fix and `test/release-local.test.ts` passed 30/30 afterward. The packaged AppImage GUI smoke passed again after the cleanup change.

## Release gate remaining

Assemble/check the clean-tree local candidate after integrating this port. Local source/package checks do not prove a signed-in ChatGPT provider session or human-selected installation. No hosted release or publication is implied.
