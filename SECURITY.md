# Security policy

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.** Use GitHub's private vulnerability reporting for this repository: **Security → Report a vulnerability**.

Include the smallest useful reproduction, the app version, operating-system version/architecture, and whether the Chrome extension was connected. Redact personal file contents, usernames/paths, conversation text and account/workspace identifiers. Never post live API keys, connector URLs, tunnel tokens or other credentials. Rotate anything accidentally exposed.

This is a solo-maintained beta. There is no bug bounty or guaranteed response window.

Security fixes target the **latest published release**. If you can reproduce an issue safely on
the latest version, include that result in the private report.

## Security model

ChatBBC is a permission boundary between ChatGPT and the logged-in OS user running the app:

- Filesystem tools validate paths against folders you explicitly approve.
- Read-only mode disables effective file writes, commands, desktop control and clipboard writes.
- `exec_command` is intentionally **not** confined to approved folders. It starts in an approved working directory, then runs with the normal privileges of your account.
- The optional Allowlist/Denylist command policy controls which simple command invocation may start. Unsupported shell syntax still fails closed. It does not sandbox a permitted executable, its child processes, interactive stdin, build scripts or later filesystem/system effects.
- Screen/control permissions also enable the companion's background browser tools on Chromium hosts. Chrome grants required debugger/tabs and HTTP(S) host permissions; there is no additional per-tab approval dialog. Read-only disables browser input, navigation, tab creation/closure and page JavaScript. Linux does not provide the native desktop screen/input API; retained Windows/macOS helpers are not supported release targets.
- MCP servers bind to loopback and use secret tokenized paths. Public reachability comes only from the tunnel you configure.
- The companion-extension bridge is a separate loopback service and exposes no filesystem, command or settings-mutation route.
- The optional local control API is off by default and is a separate, loopback-only, read-only status projection for trusted local tooling.
  - It binds only `127.0.0.1`; its per-launch bearer token is stored under ChatBBC's user-data directory and is never issued over HTTP. Any same-user process that can read that directory can use the API.
  - Requests carrying a browser `Origin` are refused.
  - Status responses are explicitly allowlisted and do not expose MCP paths, tunnel ids, plugin configuration or credentials.
- Stored API/bridge credentials use Electron `safeStorage` backed by a secure desktop secret store on Linux. Linux `basic_text` is refused; normal Activity logs are redacted, capped and memory-only.
- Session recording is separate durable local history. It is on for fresh installs and can be disabled.

## Provider rules and responsible use

Local permissions control access to your machine; they do not authorize bypassing a provider's safety decision, usage limit or account restriction. Do not route a blocked action through another tool, worker, connector or account. Follow the [responsible-use notice](README.md#responsible-use-and-provider-rules) and the applicable provider terms.

ChatBBC is an independent beta used at your own risk. Its browser automation and local recording are not an OpenAI approval or a guarantee of compliance or continued account access. Review the security model and limitations on this page, supervise tool use and stop workflows that receive a provider restriction or policy warning. Account enforcement questions belong with the provider's support or appeal process; keep private notices and account identifiers out of public reports.

## Expected limitations

These are properties of the current design, not vulnerability reports by themselves:

- **Linux x64 AppImage release binaries are not publisher-signed.** Verify release SHA-256 checksums before running them.
- **The AppImage has a sandbox-availability fallback.** Its electron-builder static launcher can add `--no-sandbox` when the host disables unprivileged user namespaces. There is no supported DEB alternative; assess this security trade-off before running.
- **Fresh installs start Core permissions enabled and read-only mode off.** Linux enables extension browser screen/control; it does not provide native desktop screen/input. Existing installs keep their explicit stored choices.
- **Application path checks are not a kernel/VM sandbox.** They substantially constrain the app's filesystem tools, but same-user filesystem races can still exist. Do not treat approved roots as isolation from a hostile local process.
- **Command and browser-control capabilities are powerful by design.** If enabled, they can act with your logged-in user's permissions or in the paired browser, subject to normal OS and browser privilege boundaries.
- **Session recording is intentionally detailed and is not encrypted by `safeStorage`.** Recorded conversations/tool activity stay local to this app, but anyone with access to your OS account may be able to read the session files.

## Scope

In scope: this repository's desktop app, MCP surfaces, local browser bridge and `extension/` companion.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, and other third-party dependencies. Report upstream vulnerabilities to the relevant project as well.
