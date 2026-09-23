/**
 * Version constants shared by the app, the bridge and the Chrome extension.
 *
 * `APP_VERSION` is written here rather than imported from package.json so the bundled
 * main process does not have to reach outside its own build. A test asserts that this
 * constant, package.json and extension/manifest.json all agree, so a release cannot ship
 * an extension that silently disagrees with the app it pairs to.
 *
 * `BRIDGE_PROTOCOL` is what actually has to match. It moves only when the request or
 * response shape between app and extension changes in a way an older peer cannot handle,
 * which is far less often than the app's own version moves — and it is what turns "the
 * extension does nothing" into a diagnosable mismatch.
 */

export const APP_VERSION = '2.1.20';

/**
 * The app's own name, in two spellings that different peers need.
 *
 * `APP_TITLE` is for humans: the window, the connector, the installer. `APP_SLUG` is the
 * machine spelling and is what the bridge stamps every `/hello` reply with, because the
 * companion compares that field to decide whether the answer came from this app at all.
 */
export const APP_TITLE = 'ChatBBC';
export const APP_SLUG = 'chatbbc';

/**
 * Standalone extension recovery must stay on the app's own release. Using GitHub's moving
 * `latest` asset can pair an older installed app with a newer, incompatible bridge protocol.
 */
export function extensionDownloadUrl(version = APP_VERSION): string {
  return `https://github.com/TheBigBrainChad/chatbbc/releases/download/v${encodeURIComponent(version)}/ChatBBC-Extension.zip`;
}

/**
 * 1 — original observations/activity bridge.
 * 2 — leased commands: /commands hands out a claim, /commands/ack reports the outcome.
 * 3 — browser-triggered compaction via /compact and worker bootstrap completion semantics.
 * 4 — targeted open: the app opens the chat itself with a ?clf=<id> marker and the page
 *     redeems that one id through /commands/redeem, /commands also reports which ids are
 *     still active, /activity carries the resume job and compaction progress, and /pair
 *     provisions silently.
 * 5 — canonical Fiber message/request observations, exact request-id attribution metadata,
 *     automatic-compaction edge/claim state, and the 1.8 activity payload contract.
 * 6 — 1.8.8 reshaped the wire in ways a 1.8.7 peer mishandles silently rather than loudly:
 *     /activity carries resetActivity and truncatedFrom so a page that merged from a cursor
 *     predating the truncated window resyncs instead of projecting stale turns, /activity
 *     carries retiredWorker, /commands/ack answers 404 no_such_command when the caller names
 *     a client, and observations carry authoredTime, which now drives message ordering. None
 *     of those degrade gracefully, so the 426 gate has to be able to see the mismatch.
 * 7 — the app renamed itself to Chat On Steroids, and the `app` field every bridge response
 *     is stamped with renamed along with it. A 6 extension reads that field to decide the
 *     reply came from this app at all, so against a 7 app it silently discards every answer
 *     and reports nothing — which looks exactly like a bridge that is down. The bump turns
 *     that into the 426 the user can act on.
 * 8 — explicit app-side browser disconnect became a durable pairing state. /hello reports
 *     `disconnected`, protected routes distinguish that revocation from a stale token, and
 *     /pair accepts `reconnect: true` only for an explicit browser-side reconnect. An older
 *     extension would otherwise silently undo the user's app-side Disconnect on its next 401.
 * 9 — automatic compaction no longer spends a separate pre-send `/compact/claim-auto` wire
 *     claim. The live page owns retryable preflight and the existing continuation transaction
 *     remains the only durable post-send authority.
 * 10 — worker revival identity is returned by /status and /activity so the extension can scan
 *      Chrome before routing to an existing exact conversation or opening one proven absent.
 * 11 — two additions to the goal projection, both of which a 10 peer reads as absent and then
 *      acts wrongly on rather than loudly. `pending.acceptedAt` names the pickup episode, so a
 *      stable final reply deliberately re-armed by an Off -> On is a new claim rather than the
 *      turn id the page has already spent. `own` says whether this chat has moved its own
 *      Goal/Loop switch, which is the only way to tell an Off somebody chose in the composer
 *      from an Off merely inherited from the app-wide setting — without it a 10 extension goes
 *      on letting a saved goal speak over the user's Off.
 *
 * 12 — `/status` answers with `repairs`, every repair now due, in place of the single `repair`.
 *      An 11 peer reads the new field as absent and quietly stops repairing anything at all,
 *      which is exactly the silent failure this fence exists to turn into a 426.
 */
// 13 — native file attachments require exact claimed-input chunk delivery and final
// draft ownership. A 12 companion would silently send text without these files.
// 14 — exact native generated-image metadata and bounded preview observations. A 13 app
// would ACK the journal while silently discarding that new event kind.
// 15 — the app renamed itself from Chat On Steroids to ChatBBC, and the `/hello` `app`
// stamp renamed from `chat-on-steroids` to `chatbbc` with it. The two halves identify each
// other twice: a companion accepts a `/hello` reply only when `app` equals its own expected
// slug, and separately compares this integer. A 14 companion carrying the predecessor's slug
// therefore discards every answer as not its own and reports the app as not running — it
// fails closed without ever reaching the integer gate. A companion that disagrees only about
// the integer is refused with 426 `incompatible_extension`, which is why the slug and the
// integer moved together for this rename.
// 16 — bounded rich-response observations and separately journalled Chrome sender evidence.
// A 15 app would ACK the new wire fields without understanding them; a 15 extension cannot
// supply the paired envelope.
// 17 — authenticated, pre-observation recording generations and a positional journal envelope
// suppress old/unknown rows after Recording Off→On, including retries. A 16 peer cannot safely
// exchange this wire shape. ChatBBC 2.1.19 is the first release that ships this protocol.
export const BRIDGE_PROTOCOL = 17;
