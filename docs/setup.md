# Setup and reference

[Back to the overview](../README.md)

## Before connecting

Read the [responsible-use notice and provider rules](../README.md#responsible-use-and-provider-rules). ChatBBC is an independent beta, used at your own risk. Its companion observes and automates the ChatGPT browser UI and records conversation content locally; this is not a public ChatGPT automation API. MCP/tunnel access does not establish permission for every automated workflow. Your account's terms, usage limits, safety decisions and workspace rules still apply.

## Quick start

1. **Install and open ChatBBC.** Choose the download for your operating system and CPU.
2. **Choose what ChatGPT may access.** In **Settings → Workspace**, approve a project folder and review the tool permissions.
3. **Connect the local tools.** Configure a tunnel in **Settings → Setup**, press **Connect**, then add the **ChatBBC Core** app in ChatGPT's Developer mode.
4. **Load the companion extension.** Press **Open extension folder**. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Start a task.** Choose a project and model in ChatBBC, write your request and send it.

Want screen and keyboard control? Enable **Desktop** permissions and connect its separate app. On macOS, also grant Screen Recording and Accessibility in System Settings.

**After an update:** reload the companion extension and refresh the ChatBBC apps in ChatGPT when prompted. These are two separate steps.

## Appearance and workspace

The Adaptive Studio rail selects Chats, Files, Agents, Usage or Settings. The chat navigator,
conversation and contextual workbench keep the current transcript mounted when you change
destinations; Files and Agents open beside it when space permits. Narrow windows use drawers.

On Omarchy, **Settings → Appearance → Follow this desktop** uses the materialized current
desktop palette, light/dark mode and font. Theme changes normally update without restarting
the app. If that theme cannot be read, ChatBBC keeps the last valid palette (or its built-in
palette on first launch) and shows a diagnostic with a manual retry. Turning Follow off
uses your saved ChatBBC colors again. Supported Hyprland blur permits native window glass;
otherwise ChatBBC uses its readable atmospheric surface. Neither appearance setting grants
local file or browser permission, and transparency does not prove compositor blur was applied.

## Upgrading from Chat On Steroids

ChatBBC is a hard identity cut from Chat On Steroids, not an in-place update.

1. **Install and open ChatBBC.** It installs beside Chat On Steroids under the app id `com.chatbbc.app` and its own `chatbbc` user data folder. Do not run both at once: they contend for the same local bridge ports.
2. **Load the ChatBBC companion.** Use **Open extension folder** and load that copy, replacing the Chat On Steroids extension in `chrome://extensions`.
3. **Delete the three Chat On Steroids connectors** in ChatGPT's Developer mode.
4. **Create the ChatBBC connectors.** Use the names and MCP URLs this app's Setup shows: **ChatBBC Core**, **ChatBBC Desktop**, **ChatBBC Plugins**.
5. **Refresh ChatGPT's connector snapshot** when Setup asks. The new connector names and schemas do not map onto the old app ids.
6. **Nothing is migrated.** Sessions, settings, secrets and pairing from the Chat On Steroids user data folder stay there. The old companion does not connect to ChatBBC: it only accepts a reply stamped with its own app slug, so it reports ChatBBC as an app that is not running. Loading this app's companion is the fix.

## Tunnel setup

### OpenAI Secure MCP Tunnel

1. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), in the same workspace you use in ChatGPT.
2. Create a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**.
3. Enter the tunnel ID and key in ChatBBC and press **Connect**.
4. In ChatGPT, enable Developer mode under **Settings → Apps → Advanced settings**, then create a custom app of type **Tunnel**. Review and enable its actions.

ChatBBC Core, ChatBBC Desktop and ChatBBC Plugins are separate connectors. Configure each surface you enable. Release packages include the pinned, checksum-verified `tunnel-client`.

### Other tunnels

**Cloudflare quick tunnel:** connect in ChatBBC and use the displayed public URL as the MCP server URL in ChatGPT. The random path is a secret and changes on restart.

**Your own HTTPS tunnel:** forward to the loopback URL shown by ChatBBC and preserve its secret path. Treat the resulting URL like a password.

## Permissions and connectors

| Connector | What it adds |
| --- | --- |
| **ChatBBC Core** | Local files, patches, terminals, generated-image listing and approved-path saves, plans and workers. Available on supported platforms. |
| **ChatBBC Desktop** | Screen inspection, mouse, keyboard and clipboard. Windows and macOS; macOS requires explicit enablement and OS permissions. |
| **ChatBBC Plugins** | External MCP tools such as Blender, Playwright and Memory, plus custom local or remote servers. [Plugin guide](plugins.md). |

You choose the approved folders and capabilities. File tools enforce those roots; shell commands run with your normal user privileges. Desktop access applies to the desktop, and external plugins have their own permissions. **Read-only mode** disables writes, command execution and desktop control.

History is stored locally, with recording on and no age-based expiry by default; explicit deletion
and image-storage cleanup remain available. Credentials use the operating system's secure storage.
Review permissions before connecting: fresh installs enable Core capabilities and two workers;
Windows also starts with Desktop permissions enabled.

[Security policy](../SECURITY.md) · [Tool reference](tool-surface.md) · [Architecture](../AGENTS.md)

## Sessions, workers and Astra

**Session history** belongs to the local session, not a particular ChatGPT tab. The companion records messages and the actual local tool results so the app and the model can read earlier work.

**Compact & Resume** asks for a handoff, starts a fresh provider conversation and rebinds that same session. Task and worker history move with it. Automatic compaction uses configured local estimates and eligible live work; Pro models never auto-compact.

**Workers** keep their conversation when they finish. Send a follow-up to reuse one. The default is two simultaneous workers per family, configurable up to eight. Idle owned tabs can be reused or closed after fresh checks; the durable worker history remains. Drafts, active work and pins are protected.

**Goal** can decide the task is complete and send nothing. **Loop** continues within the brief until disabled. Both support ChatGPT helpers or an optional API backend.

**Astra's finish boundary** can receive queued instructions, plan checkpoints and automatic follow-ups through tools within the same working turn when Session finish is enabled. You can end the turn from the composer. This does not remove provider usage or context limits.

These continuity features do not grant additional quota or access. Do not use new chats, workers, Goal/Loop or compaction to evade a provider restriction. Supervise automated work and stop a restricted workflow instead of asking another chat or tool to continue it.

## Troubleshooting

- **Missing or stale tools:** refresh the relevant ChatBBC connector in ChatGPT. Reloading the Chrome extension is a separate action.
- **Provider usage limit or policy warning:** stop the affected workflow and disable its Goal/Loop automation. Follow the provider's stated reset or support/appeal process. Do not switch accounts, chats, models, connectors or tunnels to evade the restriction. A local retry or reconnection is not evidence that a policy restriction has been lifted. Keep account notices and appeal details private; a GitHub issue cannot resolve an account enforcement decision.
- **Tunnel rejects the API key or tunnel ID:** check the saved tunnel ID, the selected setup profile, and that its key has Tunnels Read + Use for that tunnel. Extension pairing does not authenticate the tunnel. If Platform offers no matching ChatGPT workspace, retain the exact error for an access investigation; a different tunnel does not establish account eligibility.
- **ChatGPT blocks a tool for safety:** local permission alone does not prove that ChatGPT accepted or dispatched the call. Inspect the local tool history for the exact request. If no result exists, execution is unconfirmed; do not replay a potentially executed operation or route it through another connector. Keep the task's progress and report the provider's error, selected Chat/Work surface, and app/extension versions without credentials or private content. A plan label alone does not diagnose a provider refusal.
- **ChatBBC returns `TOOL_DISABLED`:** check Read-only and the named local capability. `CALLER_IDENTITY_REQUIRED` or `WORKER_IDENTITY_LOST` instead concerns exact caller ownership; neither proves that command execution is globally disabled.
- **Extension version mismatch:** reload the unpacked companion after updating ChatBBC, then reload the ChatGPT page.
- **Connector says the app is not running, but it is:** the loaded companion is the old Chat On Steroids build. A companion only accepts `/hello` replies stamped with its own app slug, so it discards ChatBBC's reply and reports ChatBBC as absent. Load the ChatBBC companion from **Open extension folder**, then reload.
- **Connector says `incompatible_extension` (426):** the companion is this app's companion but a different bridge protocol — for example an older installed build. Load the companion packaged with this app version, then reload.
- **Models missing:** use **Reload ChatGPT models**. The picker reflects availability in your signed-in account.
- **`UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can prove its request identity. ChatBBC does not guess from the active tab.
- **`COMPACTION_IN_PROGRESS`:** let the source chat finish its handoff. Work continues in the replacement conversation.
- **Linux credential storage unavailable:** unlock GNOME Keyring or KWallet, then restart ChatBBC.
- **A chat will not stop:** **Block** revokes local tools for that exact conversation. It does not claim to cancel the provider's generation.

## Build from source and contribute

## Development

```sh
npm ci
npm run dev
npm run verify
```

Read [AGENTS.md](../AGENTS.md) before changing the app and [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR.

## Building

```sh
npm run dist:x64          # Windows x64
npm run dist:arm64        # Windows ARM64
npm run dist:mac:x64      # macOS Intel
npm run dist:mac:arm64    # macOS Apple silicon
npm run dist:linux:x64    # Linux x64
npm run dist:linux:arm64  # Linux ARM64
```

Build on the target OS. The release workflow uses native runners for all six targets, checks the packaged runtimes and assembles the complete artifact set with checksums and corresponding native library sources.

---

[MIT licensed](../LICENSE). Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.
