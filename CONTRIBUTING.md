# Contributing

ChatBBC 2.2.0 supports Linux x64 AppImage releases, maintained locally. Bug reports, focused fixes and concrete improvements are welcome. This downstream builds on [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids/tree/dee4b5e94b8598d7630e6db62bada9ac6050f457); preserve its MIT license and [contributor credit](CONTRIBUTORS.md).

## Before a pull request

For anything non-trivial, open an issue first so the intended behavior is clear. Security problems must be reported privately through [`SECURITY.md`](SECURITY.md), not as an issue or PR.

Keep changes narrow. Preserve existing permission, identity and recovery behavior unless the issue specifically requires changing it. Avoid unrelated formatting, generated output, local debugging material and private data. In screenshots, logs and examples, replace real usernames, local paths, chat text, IDs and credentials with placeholders such as `/home/you/project`.

## Responsible-use expectations

Contributions and examples should follow the [responsible-use notice](README.md#responsible-use-and-provider-rules). Do not propose or promote bypassing provider safety decisions, usage limits or account restrictions. Describe browser automation and recording accurately; do not market ChatBBC as a way to avoid quota. Claims about usage allowances or OpenAI approval require evidence. Keep account notices, appeals and private conversation evidence out of public issues, PRs and documentation. These expectations do not alter the MIT license or replace any provider's terms.

## Development setup

Development and release acceptance target Linux x64 on Omarchy/Wayland/Hyprland. Cross-platform source/helpers remain for shared behavior, but there are no supported Windows, macOS or ARM releases. Use a project-compatible Node runtime and the checked-in lockfile.

```sh
npm ci
npm run verify          # local privacy, rebrand, map, typecheck and test gates
npm run verify:ui       # real Wayland Electron fixtures
npm run dev             # Electron development build
```

A behavior change should include a deterministic regression test where practical. Run nearest focused tests while working and `npm run verify` before submitting. For downstream source ports, follow [the porting runbook](docs/UPSTREAM.md).

## Packaging

Build on Linux x64 only. Packaging stages pinned external assets and verifies their checksums; the first packaging run needs network access.

```sh
npm run dist:linux:x64      # ChatBBC-Linux-x64.AppImage
npm run dist:dir:linux:x64  # unpacked directory for local smoke
npm run release:local       # verified local candidate, no publication
```

`npm run release:publish -- --tag v2.2.0` is an explicit later operation requiring a reviewed tag, absent release, successful local gates and repository Actions disabled. Do not claim a package is validated from source tests alone. No hosted CI, workflow dispatch or hosted release builder runs for this downstream.

## Pull requests

Explain the root cause, the smallest behavior change that fixes it, and exactly how you validated it. Packaging/runtime changes should include a packaged-runtime smoke check where relevant.

## Credit and attribution

Contributors retain credit when their patches are adapted, rewritten or consolidated into release snapshots. Merge the original PR when appropriate and preserve its author. For adapted work, link the original PR, explain what was incorporated, and include the original contributor in the integration commit's `Co-authored-by` trailers using their public GitHub noreply identity. Verify the resulting commit resolves to the intended GitHub account.

Record incorporated work in [CONTRIBUTORS.md](CONTRIBUTORS.md). Credit bug reports, designs and review explicitly, distinguishing them from incorporated code. Closing a PR as incorporated or superseded must explain that distinction and link the integration; it must not erase attribution. AI-assisted integration does not transfer the original contributor's credit to the maintainer or the model.

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
