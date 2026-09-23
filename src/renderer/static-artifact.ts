import { t } from './i18n.js';
import { artifactSrcdoc, sanitizeStaticArtifact, type SanitizedArtifact, type StaticMedia } from '../shared/static-artifact.js';

/** Sandboxed preview. Rejection is a complete unavailable state, not a partial document. */
export function mountStaticArtifact(host: HTMLElement, source: { html: string; media?: StaticMedia[] }): SanitizedArtifact {
  const doc = host.ownerDocument;
  const safe = sanitizeStaticArtifact(doc, { html: source.html, media: source.media ?? [] });
  host.replaceChildren();
  if (safe.rejected) {
    const note = doc.createElement('p');
    note.textContent = t('Open original in ChatGPT');
    host.append(note);
    return safe;
  }
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = artifactSrcdoc(safe);
  host.append(frame);
  return safe;
}
