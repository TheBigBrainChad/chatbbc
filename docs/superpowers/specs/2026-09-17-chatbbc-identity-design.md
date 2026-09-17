# ChatBBC identity cutover

Date: 2026-09-17  
Status: draft for review  
Scope: public and ChatGPT-facing identity of this private fork. Not the Omarchy UI spec.

This fork is no longer Chat On Steroids in anything a human, installer, extension, or ChatGPT connector reads. Approach: one set of brand constants plus a user/model-facing cutover. Do not rename internal prefixes (`CLF_`, `COS_CONTEXT`) or historical git/changelog/contributor records.

## 1. Identity contract

| Role | Value |
|---|---|
| Display name | ChatBBC |
| Short name | ChatBBC (no CoS, BBC, or CBBC nickname) |
| Connector titles | ChatBBC Core, ChatBBC Desktop, ChatBBC Plugins |
| MCP `serverName` | `chatbbc-core`, `chatbbc-desktop`, `chatbbc-plugins` |
| Electron `appId` | `com.chatbbc.app` |
| `userData` directory | `chatbbc` (Windows `%APPDATA%/chatbbc`, macOS `~/Library/Application Support/chatbbc`, Linux XDG `chatbbc`) |
| Executable / DEB package / `StartupWMClass` companion | `chatbbc` / `com.chatbbc.app` as required by current packaging |
| Extension name | ChatBBC companion |
| GitHub | `TheBigBrainChad/chatbbc` (private; human renames the existing repo) |
| Window, tray, installer, shortcut, uninstall display | ChatBBC |

`CONNECTOR_BRAND` (today `'Chat On Steroids'` in `src/main/mcp/surfaces.ts`) becomes `'ChatBBC'`. Connector titles stay `${CONNECTOR_BRAND} Core|Desktop|Plugins`. `serverName` strings are explicit, not inferred from a slug helper that could drift.

Linux `desktopName` / `package.json` `"desktopName"` follow `com.chatbbc.app` so the running window still matches the desktop entry.

## 2. What ChatGPT sees

ChatGPT does not read the Electron window title. After this cutover it must see only ChatBBC.

### Connectors

Recreate three Developer-mode apps. Old CoS connectors stay cached against `chat-on-steroids-core|desktop|plugins` and will not hit this process.

- Paste names: ChatBBC Core / ChatBBC Desktop / ChatBBC Plugins.
- Tunnel URLs still come from this app’s Setup; only the connector identity changes.
- Descriptions keep the current **capability vocabulary** (files, patches, terminal, workers; browser/desktop; external plugins) and replace the product name with ChatBBC. Do not rewrite them into marketing. That sentence is how the model decides to pull schemas.

Plugin refresh fingerprints names and schemas. New `serverName` / `connectorName` means ChatGPT must refresh after the new apps exist. There is no mapping from old CoS ChatGPT app ids onto ChatBBC.

### Instructions and tool errors

MCP initialize instructions and the first-message executor frame speak as ChatBBC. Model-visible refusals that today say “Chat On Steroids” or “CoS” say ChatBBC.

The hidden frame token `COS_CONTEXT` stays. It is not model-facing brand.

### Operator cutover

After install:

1. Load the ChatBBC companion (this app’s Open extension folder), not the CoS extension.
2. Delete the three CoS connector apps in ChatGPT.
3. Create three ChatBBC connector apps with the new names and this app’s tunnel URLs.
4. Refresh ChatGPT’s connector snapshot when Setup asks.

Setup copy must say ChatBBC. Setup screenshots that still show CoS connector pixels are a follow-up recapture, not a blocker for the string cutover.

## 3. Local runtime and extension

Hard cut, same class as the historical rename to Chat On Steroids.

- New process identity installs **beside** CoS. It does not uninstall CoS or reuse its `appId`.
- `userData` starts empty. No copy of sessions, `config.json`, `secrets.bin`, pairing token, swarm, or Goal ledgers from the CoS directory.
- Bridge `/hello` `app` stamp becomes ChatBBC. **Bump `BRIDGE_PROTOCOL`** (today 14) so a leftover CoS companion gets 426 instead of silently dropping replies. Pairing remains loopback + `chrome-extension://` origin; the token lives in the new secrets file.
- Extension `manifest.json` name/description become ChatBBC companion. Version still matches `APP_VERSION`.
- Stop every `totec448-spec/chat-on-steroids` download, homepage, and updater URL. Point package metadata at `TheBigBrainChad/chatbbc`. The repo is private: GitHub `latest` is not a public extension zip. The packaged extension mirrored into `userData/extension` remains the load path.

The human renames the GitHub repository `TheBigBrainChad/chat-on-steroids` → `TheBigBrainChad/chatbbc`. This tree then updates `origin`, `package.json` `homepage`/`repository`, and `extensionDownloadUrl`. Leave `upstream` on `totec448-spec/chat-on-steroids` unless a later decision says otherwise.

## 4. Rewrite vs leave

**Rewrite**

- `package.json` name, description, `desktopName`, homepage/repository
- `electron-builder.yml` `appId`, `productName`, artifacts, shortcuts, Linux executable/maintainer/desktop checks
- `src/main/version.ts` GitHub download URL
- `CONNECTOR_BRAND` and the three `serverName` values
- Window title, tray tooltip, Linux maintainer string
- Extension manifest and popup product strings
- Renderer and i18n (`es`, `zh-CN`, `zh-TW`) labels that say Chat On Steroids or CoS
- MCP instructions and model-facing errors
- README, setup, SECURITY, CONTRIBUTING **product** sentences
- `AGENTS.md` product name (keep the owner map; change the brand)
- Tests that assert the old public name, `appId`, DEB `Package`, desktop `Name=`, `/hello` `app` field, or connector ids

**Leave**

- LICENSE and copyright attribution
- `CONTRIBUTORS.md` as history
- Existing CHANGELOG entries that describe CoS (add a ChatBBC identity note when this ships)
- Git history
- `CLF_*` environment reservation, `COS_CONTEXT`, session directory shape, bridge ports 8765–8769
- Protocol *behavior* other than the `app` stamp and protocol integer
- Omarchy layout, buttons, palette, and new icons (separate spec)

Do not add tests whose only job is counting the substring `ChatBBC`. Fix suites that pin the old public contract.

## 5. Out of scope

- Omarchy visual redesign, new buttons, layout
- New artwork/icons (ship existing icons under the new name until the visual spec)
- Nuclear rename of internals (`CLF_`, `COS_CONTEXT`, state filenames, comments-only churn)
- Migrating CoS `userData`
- Publishing a public GitHub release or changing `upstream`

## 6. Risks

- Running CoS and ChatBBC at once: two `appId`s and two `userData` dirs, but both still try bridge ports 8765–8769 and may fight if both are open. Don’t run both.
- Forgetting to bump `BRIDGE_PROTOCOL` reproduces the protocol-7 silent-drop failure.
- Keeping any `chat-on-steroids-*` `serverName` makes ChatGPT treat this fork as CoS.
- Private-repo updater: must not keep fetching upstream CoS artifacts.

## 7. Acceptance

A ChatBBC install, with its own companion loaded, publishes `chatbbc-core|desktop|plugins`. ChatGPT connector titles are ChatBBC Core/Desktop/Plugins. Window, tray, installer, and extension say ChatBBC. No user- or model-facing “Chat On Steroids” or “CoS”. A CoS companion against this app fails with 426. `userData` is a new empty `chatbbc` directory. LICENSE and contributor history still credit the upstream project.
