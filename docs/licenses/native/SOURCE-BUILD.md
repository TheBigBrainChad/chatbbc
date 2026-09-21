# Building and replacing the native image libraries

`sources.json` maps each archive to its URL, version, applicable OS and SHA-256. Verify
`SHA256SUMS.txt` before extracting. Keep embedded subprojects and notices. Source retains
its original licenses. The application consumes the published sharp 0.35.4/@img binaries
on targets other than Linux x64. Linux x64 uses the separately pinned patched
`@janhapke/sharp-electron@0.35.4-electron.1` addon and libvips pair; it does
not modify the official @img binaries. Windows and Unix use different dependency versions
even though both report libvips 8.18.6. The inventory retains earlier source versions
as an inclusive set; use the current build revisions below and each target's versions.json.

## Source preparation

Extract component archives separately with one leading path component removed, as the
upstream recipes do with `tar --strip-components=1`. Archive filenames contain a URL hash
to avoid collisions; the inventory maps them to recipe downloads. The build repositories
retain platform settings, inline source edits, generated-file recipes, patches and scripts.

The libimagequant v2.4.1 tag moved after the older June builds. The current August
recipes use commit `ce5fdeb1ccd9db288950faa21fd09c42c0a59bbb`; its immutable archive
is included alongside the older source. Use that recorded current commit rather
than resolving the tag again. The commit archive has different directory/compression
bytes from the recipe's tagged archive, so adjust the cache filename/hash accordingly.
TIFF and Fontconfig include mirrored source archives where original download endpoints
were unavailable. Windows libxml2's recipe directory must resolve to `2.15`.

### Linux x64 fork: archive-only reconstruction

The fork's GitHub source archive has empty `vendor/sharp` and
`vendor/sharp-libvips` directories: GitHub archives omit submodule contents and Git
metadata. The fork README's `git clone --recurse-submodules` example therefore is
**not** a reconstruction procedure for the delivered source archive. Use the three
archives below from **the same release's** `ChatBBC-Native-Sources.tar.gz`, in its
`archives/` directory. Their names, bytes, SHA-256 and commit-labelled source
versions are recorded in `sources.json` (select the current entries, not the
earlier sharp 0.35.3 / sharp-libvips 1.3.2 entries).

This Bash recipe takes two arguments: the **absolute** extracted `archives/`
directory and a **new, nonexistent** destination directory. It verifies the
three delivered source bodies before extraction, places the exact upstream
Sharp 0.35.4 commit `7f1a0a22cc285fe180766f4935d50b55af6e8432` and
sharp-libvips 1.3.3 commit `6e5971d333377743163edc3ad9e5d0b897abcbc9`
under the fork commit `f7afa507bfc6975bad73ed9c6a8ee5c3be88b848`, creates
local Git metadata needed by the fork's `git apply` script, checks both patches
against the pristine sources, applies them, then verifies their reversibility.
All archive inputs are local; these steps make no network requests.

```bash
archive_dir=${1:?pass the absolute extracted archives directory}
fork_dir=${2:?pass a new destination directory}
test -d "$archive_dir"
test ! -e "$fork_dir"
(
  cd "$archive_dir"
  printf '%s\n' \
    '5826538e26d76f7db44b1adfe0766e6f00c86ce3c9495225d26386198d0247de  sharp-electron-f7afa507.tar.gz' \
    '9e84202dc927f0c0dfda583301f245b6d92bdd8c5af7bd4dae436c608f01785f  sharp-source-903128da.tar.gz' \
    'aea60d36644f88b47a3998564f12264fd7638dc4559f083e9ff3fb25c9caa87b  sharp-libvips-build-f6fad46c.tar.gz' \
    | sha256sum --check
  test "$(wc -c < sharp-electron-f7afa507.tar.gz)" -eq 50967
  test "$(wc -c < sharp-source-903128da.tar.gz)" -eq 41797945
  test "$(wc -c < sharp-libvips-build-f6fad46c.tar.gz)" -eq 24041
)
mkdir -p "$fork_dir"
tar -xzf "$archive_dir/sharp-electron-f7afa507.tar.gz" -C "$fork_dir" --strip-components=1
tar -xzf "$archive_dir/sharp-source-903128da.tar.gz" -C "$fork_dir/vendor/sharp" --strip-components=1
tar -xzf "$archive_dir/sharp-libvips-build-f6fad46c.tar.gz" -C "$fork_dir/vendor/sharp-libvips" --strip-components=1
grep -Fq '"version": "0.35.4"' "$fork_dir/vendor/sharp/package.json"
grep -Fxq 'VERSION_VIPS=8.18.6' "$fork_dir/vendor/sharp-libvips/versions.properties"
git -C "$fork_dir/vendor/sharp" init -q
git -C "$fork_dir/vendor/sharp-libvips" init -q
git -C "$fork_dir/vendor/sharp" apply --check "$fork_dir/patches/sharp-glib-calls.patch"
git -C "$fork_dir/vendor/sharp-libvips" apply --check "$fork_dir/patches/sharp-libvips-glib-wrapper.patch"
(cd "$fork_dir" && ./scripts/apply-patches.sh)
git -C "$fork_dir/vendor/sharp" apply --reverse --check "$fork_dir/patches/sharp-glib-calls.patch"
git -C "$fork_dir/vendor/sharp-libvips" apply --reverse --check "$fork_dir/patches/sharp-libvips-glib-wrapper.patch"
```

For example, after extracting the release's native-source bundle, save this
recipe as `reconstruct.sh` and run
`bash reconstruct.sh "$PWD/archives" "$PWD/sharp-electron-reconstructed"`
from the extraction directory. The
destination must not already exist. The source archive's directory names and
inventory identify the supplied upstream commits; its omitted Git gitlinks
do **not** independently prove which submodule commits the original fork Git
tree recorded. Patch applicability and actual source versions are checked
above; do not describe the locally initialized repositories as original
upstream Git history.

The reconstructed fork's `scripts/build-all.sh` is its build entry point. It
runs the libvips and addon Docker builds, gates and local package step; these
may fetch build dependencies, and the supplied source bodies alone do not
constitute a complete offline toolchain or guarantee byte-identical binaries.
The relevant output and replacement mapping for **Linux x64 only** is:

```text
vendor/sharp/src/build/Release/sharp-linux-x64-0.35.4.node
dist/linux-x64/lib/libvips-cpp.so.8.18.6
  -> package/linux-x64/sharp/src/build/Release/ (both files, via scripts/package-local.sh)
  -> app.asar.unpacked/node_modules/@janhapke/sharp-electron/linux-x64/sharp/src/build/Release/sharp-linux-x64-0.35.4.node
  -> app.asar.unpacked/node_modules/@janhapke/sharp-electron/linux-x64/sharp/src/build/Release/libvips-cpp.so.8.18.6
```

Replace the two installed files **together** in an offline copy of the same
target's package. Preserve the addon's `$ORIGIN` `DT_RPATH`, the library's
`libvips-cpp.so.8.18.6` SONAME, and the source/license notices; the official
Linux arm64 `@img` backend is a separate, unchanged build.

## macOS and Linux

Use sharp-libvips commit `6e5971d333377743163edc3ad9e5d0b897abcbc9` (v1.3.3).
Its `build.sh`, `build/posix.sh`, `versions.properties` and `platforms/` directories
describe configuration and installation. The entry points are:

```sh
./build.sh linux-x64
./build.sh linux-arm64v8
./build.sh darwin-x64
./build.sh darwin-arm64v8
```

Linux uses the supplied Dockerfiles; macOS uses Xcode command-line tools and Homebrew's
pkg-config. Supply the retained source bodies to the corresponding CURL download steps
instead of resolving moving tags again. Four external patches are included; the UltraHDR
PR patch is pinned to its byte-identical commit patch. Preserve all inline `sed` edits,
generated `vips.map`, static inner libraries, SONAME changes and linker flags in `posix.sh`.

The release logs record Rust `1.100.0-nightly (787af2b8c 2026-08-25)` and cargo-c
`0.10.25+cargo-0.99.0`. Use the 2026-08-26 Rust toolchain rather than today's floating
nightly. Original librsvg 2.62.91 Cargo.lock and source-local workspace are in
its archive. The published build records `Locking 0 packages` after the recipe's edits.
Retained crates include that lock's dependency sources, checked against Cargo.lock hashes.
Retain the lock for `cargo vendor` / `--locked`; do not run an unrestricted update.
GVDB and libnsgif sources are embedded in their parent archives.

Original release logs: https://github.com/lovell/sharp-libvips/actions/runs/32944388037

## Windows

Use build-win64-mxe commit `09cfccf20b91b441fbe97fa7a7ed8a597e55e830` (v8.18.6) and
MXE base `d973945bb92c7783d5afa41bb2b8d2e1a04eaba3` (`llvm-mingw-20260605`), both included.
The `container/` Dockerfiles, `build/`, `build.sh` and MXE settings define the Linux
cross-compilation environment. Sharp's `build/win.sh` selects the `web` variant,
`vips-dev-{ARCH}-web-8.18.6-static.zip`, without `-ffi`. The main libvips and C++ wrapper
remain DLLs; “static” describes their dependencies.

The pinned MXE recipes identify Rust nightly 2026-06-05 (`e7815e522`), LLVM 22.1.7,
and MinGW-w64 commit `b536c4fdb038a9c59a7e5fb36e7d1293c4dc61d6`. Their runtime sources
and the Rust standard-library lock's crate sources are included. The full LLVM source
archive is an inclusive delivery choice; use its compiler-rt, libc++, libc++abi and
libunwind recipes for the relevant runtimes. This does not assert that the whole compiler
is incorporated in the application. The dated Unix Rust standard-library source is
supplied separately, and readable standard-library/runtime notices accompany both sets.

The targets are `x86_64-w64-mingw32.static` and `aarch64-w64-mingw32.static`. With
the build repository's `build/` mounted at `/data`, the source collection command is:

```sh
make download-vips-web MXE_TARGETS=x86_64-w64-mingw32.static \
  MXE_PLUGIN_DIRS="plugins/llvm-mingw /data /data/plugins/mozjpeg /data/plugins/zlib-ng /data/plugins/web-deps /data/plugins/proxy-libintl"
```

Populate MXE's `pkg` cache from the retained inventory. Most archives match recipe
checksums directly; explicit mirror/commit substitutions in `sources.json` need the
corresponding filename/hash adjustment while preserving the recorded source commit.
Do not substitute another libimagequant fork. Preserve all build/MXE patches and settings.
GLib's GVDB and librsvg's workspace plus locked crates are included. Follow the retained
upstream build/packaging scripts after preparation; this archive is source, not a toolchain.

## Replacing the installed library

Close the app and work on a copy. Build for the same OS, CPU and Sharp/libvips ABI,
retaining exported interfaces and library names. Under application resources:

- Windows: `app.asar.unpacked/node_modules/@img/sharp-win32-{x64|arm64}/lib/`, with
  `libvips-42.dll` and `libvips-cpp-8.18.6.dll`.
- Linux arm64: `app.asar.unpacked/node_modules/@img/sharp-libvips-linux-arm64/lib/`.
- Linux x64: the paired patched addon and library are both under
  `app.asar.unpacked/node_modules/@janhapke/sharp-electron/linux-x64/sharp/src/build/Release/`.
  Replace `sharp-linux-x64-0.35.4.node` and `libvips-cpp.so.8.18.6` together;
  preserve the addon's `$ORIGIN` RPATH and library SONAME. Do not substitute
  only one file or the stock @img library.
- macOS: `app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-{x64|arm64}/lib/`
  under `ChatBBC.app/Contents/Resources`.

Replace the corresponding shared libraries and retain required SONAME links. Sharp is
also unpacked; its Apache-licensed binding source/build instructions are in the sharp
source distribution if an ABI change requires rebuilding it. No application hash check
or publisher-key requirement fences these files. On macOS seal the modified copy again:

```sh
codesign --force --deep --sign - "ChatBBC.app"
codesign --verify --deep --strict --verbose=2 "ChatBBC.app"
```

On Linux extract an AppImage or use an installed DEB copy to obtain ordinary writable
files. Normal OS access controls apply. Preserve source/license notices with modifications.
The application's MIT terms do not prohibit library modification or reverse engineering
for debugging those modifications.

The release pipeline tests the packaged Sharp runtime on each native OS/CPU. It does not
claim bit-identical compiler output or a full offline rebuild of all native dependencies;
those are separate reproducibility properties.
