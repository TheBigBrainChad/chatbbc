# Setup and reference

[Back to the overview](../README.md)

## Before connecting

Read the [responsible-use notice and provider rules](../README.md#responsible-use-and-provider-rules). ChatBBC is an independent beta, used at your own risk. Its companion observes and automates the ChatGPT browser UI and records conversation content locally; this is not a public ChatGPT automation API. MCP/tunnel access does not establish permission for every automated workflow. Your account's terms, usage limits, safety decisions and workspace rules still apply.

## Quick start

1. **Install and open ChatBBC.** Use the Linux x64 AppImage from the [ChatBBC releases](https://github.com/TheBigBrainChad/chatbbc/releases) and check its SHA-256 checksum.
2. **Choose what ChatGPT may access.** In **Settings → Workspace**, approve a project folder and review the tool permissions.
3. **Connect the local tools.** Configure a tunnel in **Settings → Setup**, press **Connect**, then add **ChatBBC Core** in ChatGPT under **Plugins → Add → Create MCP App**.
4. **Load ChatBBC Companion.** Press **Open extension folder**. In `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select that folder. Pairing is automatic.
5. **Start a task.** Choose a project and model in ChatBBC, write your request and send it.

Want browser control? Enable **Desktop** permissions and connect **ChatBBC Desktop** separately. Linux does not supply native screen/input desktop tools.

**After an update:** reload ChatBBC Companion and refresh the ChatBBC apps in ChatGPT when prompted. These are two separate steps.

## Tunnel setup

### OpenAI Secure MCP Tunnel

1. Create a tunnel in [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), in the same workspace you use in ChatGPT.
2. Create a **Restricted** [API key](https://platform.openai.com/settings/organization/api-keys) with **Tunnels: Read** and **Tunnels: Use**.
3. Enter the tunnel ID and key in ChatBBC and press **Connect**.
4. In ChatGPT, open [Plugins](https://chatgpt.com/plugins), click **Add** at the top right and choose **Create MCP App**. Pick **Tunnel** as the connection, select your tunnel and choose **No authentication**. Older ChatGPT versions instead need Developer mode turned on first (**Settings → Security and login**) and show a **+** button. Review and enable the app's actions.
5. Name each app exactly as ChatBBC shows it (for example `ChatBBC Core`). ChatBBC recognizes its tool calls by that name; a renamed app still works, but its calls are filed under Unattributed activity instead of your chat, which also keeps Goal and Loop from seeing them.

> **No Developer mode switch?** That's expected. Current ChatGPT accounts, including new Plus accounts, create the app from **Plugins → Add → Create MCP App** without it, and file edits and browser control work as before ([upstream report #522](https://github.com/totec448-spec/chat-on-steroids/issues/522)).

Core, Desktop and Plugins are separate connectors. Configure each surface you enable. Release packages include the pinned, checksum-verified `tunnel-client`.

### Other tunnels

**Cloudflare quick tunnel:** connect in ChatBBC and use the displayed public URL as the MCP server URL in ChatGPT. The random path is a secret and changes on restart.

**Your own HTTPS tunnel:** forward to the loopback URL shown by ChatBBC and preserve its secret path. Treat the resulting URL like a password.

## Browser bridge port

In **Settings → Browser & history → Browser bridge port**, choose **Auto** (default) or
**8765**, **8766**, **8767**, **8768**, **8769**. Auto uses the first available port in that
order. A fixed choice uses exactly that port. The companion discovers the same supported range.

If the selected port is occupied, the save is rejected and the previous choice and working
bridge remain active. If a saved port is occupied when ChatBBC starts, the app stays open with the
bridge stopped and an error in **Setup**. Choose a free port or Auto in Settings to recover.
The saved fixed choice never silently falls back to another port. Pairing survives a successful switch.

An effective `CLF_BRIDGE_PORTS` environment override takes precedence over the saved choice.
The dropdown is disabled and explains the override; unrelated Settings changes remain available.
Remove the override from the launch environment and restart ChatBBC to use this selector. The existing
comma-separated override and port `0` remain available for isolated development/tests.

## Permissions and connectors

| Connector | What it adds |
| --- | --- |
| **ChatBBC Core** | Local files, patches, terminals, generated-file downloads, session history, plans and workers. |
| **ChatBBC Desktop** | Companion browser tools on Linux; native screen, mouse, keyboard and clipboard are not supported on Linux. |
| **ChatBBC Plugins** | External MCP tools such as Blender, Playwright and Memory, plus custom local or remote servers. [Plugin guide](plugins.md). |

You choose the approved folders and capabilities. File tools enforce those roots; shell commands run with your normal user privileges. Browser control applies to the paired browser, and external plugins have their own permissions. **Read-only mode** disables writes, command execution and browser input.

History is stored locally, with recording on and 30-day retention by default. Credentials use the operating system's secure storage. Review permissions before connecting: fresh installs enable Core capabilities and two workers.

[Security policy](../SECURITY.md) · [Tool reference](tool-surface.md) · [Architecture](../AGENTS.md)

## Sessions, workers and Astra

**Session history** belongs to the local session, not a particular ChatGPT tab. The companion records messages and the actual local tool results so the app and the model can read earlier work.

**Compact & Resume** asks for a handoff, starts a fresh provider conversation and rebinds that same session. Task and worker history move with it. In Settings → Continuation prompts, **Handoff prompt** controls what the brief emphasizes; the continuation marker and recovery/provenance framing remain fixed. The shipped prompt prefers a dense roughly 2,000-6,000-token brief for substantial work instead of replaying completed chronology. Automatic compaction uses configured local estimates and eligible live work; Pro models never auto-compact.

**Workers** keep their conversation when they finish. Send a follow-up to reuse one. The default is two simultaneous workers per family, configurable up to eight. Idle owned tabs can be reused or closed after fresh checks; the durable worker history remains. Drafts, active work and pins are protected.

**Goal** can decide the task is complete and send nothing. **Loop** continues within the brief until disabled. Both support ChatGPT helpers or an optional API backend.

**Astra's finish boundary** can receive queued instructions, plan checkpoints and automatic follow-ups through tools within the same working turn when Session finish is enabled. You can end the turn from the composer. This does not remove provider usage or context limits.

These continuity features do not grant additional quota or access. Do not use new chats, workers, Goal/Loop or compaction to evade a provider restriction. Supervise automated work and stop a restricted workflow instead of asking another chat or tool to continue it.

## Troubleshooting

- **Missing or stale tools:** refresh the relevant ChatBBC app in ChatGPT. Reloading ChatBBC Companion is a separate action.
- **Provider usage limit or policy warning:** stop the affected workflow and disable its Goal/Loop automation. Follow the provider's stated reset or support/appeal process. Do not switch accounts, chats, models, connectors or tunnels to evade the restriction. A local retry or reconnection is not evidence that a policy restriction has been lifted. Keep account notices and appeal details private; a GitHub issue cannot resolve an account enforcement decision.
- **Tunnel rejects the API key or tunnel ID:** check the saved tunnel ID, the selected setup profile, and that its key has Tunnels Read + Use for that tunnel. Extension pairing does not authenticate the tunnel. If Platform offers no matching ChatGPT workspace, retain the exact error for an access investigation; a different tunnel does not establish account eligibility.
- **ChatGPT blocks a tool for safety:** local permission alone does not prove that ChatGPT accepted or dispatched the call. Inspect the local tool history for the exact request. If no result exists, execution is unconfirmed; do not replay a potentially executed operation or route it through another connector. Keep the task's progress and report the provider's error, selected Chat/Work surface, and app/extension versions without credentials or private content. A plan label alone does not diagnose a provider refusal.
- **ChatBBC returns `TOOL_DISABLED`:** check Read-only and the named local capability. `CALLER_IDENTITY_REQUIRED` or `WORKER_IDENTITY_LOST` instead concerns exact caller ownership; neither proves that command execution is globally disabled.
- **Extension version mismatch:** reload the unpacked companion after updating ChatBBC, then reload the ChatGPT page.
- **Models missing:** use **Reload ChatGPT models**. The picker reflects availability in your signed-in account.
- **`UNIDENTIFIED_CALLER`:** use that conversation in the paired browser so the extension can prove its request identity. ChatBBC does not guess from the active tab.
- **`COMPACTION_IN_PROGRESS`:** let the source chat finish its handoff. Work continues in the replacement conversation.
- **Linux credential storage unavailable:** unlock GNOME Keyring or KWallet, then restart ChatBBC.
- **A chat will not stop:** **Block** revokes local tools for that exact conversation. It does not claim to cancel the provider's generation.

## Build from source and contribute

Development and release acceptance run locally on Linux x64 with Wayland:

```sh
npm ci
npm run dev
npm run verify
npm run verify:ui
npm run dist:linux:x64
npm run dist:dir:linux:x64
npm run release:local
```

`npm run release:local` assembles a validated local candidate with checksums and corresponding native library sources; it does not publish. `npm run release:publish -- --tag v2.2.0` is a separate explicit, gated operation after review. Windows/macOS/ARM and DEB are not downstream release targets, and no hosted CI builds this release.

Read [AGENTS.md](../AGENTS.md) before changing the app, [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a PR, and [UPSTREAM.md](UPSTREAM.md) before porting upstream work.

---

[MIT licensed](../LICENSE). Not affiliated with or endorsed by OpenAI. ChatGPT and Codex are OpenAI trademarks.
