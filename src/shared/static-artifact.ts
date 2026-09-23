/** Scriptless static artifact bounds. Shared by extension capture and renderer admission. */
export const STATIC_ARTIFACT_LIMITS = {
  bytes: 131_072,
  nodes: 1_024,
  depth: 24,
  text: 65_536,
  css: 65_536,
  images: 4,
  deadlineMs: 2_000
} as const;

export type StaticMedia = { id: string; dataUrl: string };
export type SanitizedArtifact = { html: string; rejected: string | null };

const ALLOWED = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'pre', 'code', 'strong', 'em',
  'b', 'i', 'br', 'hr', 'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'blockquote', 'img'
]);
const STYLE_PROPS = new Set([
  'color', 'background', 'background-color', 'font', 'font-size', 'font-weight', 'font-family', 'font-style',
  'text-align', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-color', 'display',
  'width', 'height', 'max-width', 'gap', 'line-height', 'white-space', 'overflow-wrap'
]);

const reject = (reason: string): SanitizedArtifact => ({ html: '', rejected: reason });

const VOID_TAGS = new Set(['br', 'hr', 'img']);

type FragmentShape = { tag: string; children: FragmentShape[] };

/** The element tree the author wrote. Parser repair must not become a different tree. */
export function fragmentShape(html: string): FragmentShape[] | null {
  const stack: FragmentShape[] = [];
  const roots: FragmentShape[] = [];
  let index = 0;
  const place = (node: FragmentShape): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
  };
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close < 0) return null;
    const raw = html.slice(open + 1, close).trim();
    const closing = raw.startsWith('/');
    const body = (closing ? raw.slice(1) : raw).trim();
    const name = /^([a-zA-Z][\w:-]*)/.exec(body);
    if (!name) return null;
    const tag = name[1]!.toLowerCase();
    const selfClosing = raw.endsWith('/');
    if (closing) {
      if (selfClosing || stack.pop()?.tag !== tag) return null;
    } else if (selfClosing && !VOID_TAGS.has(tag)) return null;
    else {
      const node = { tag, children: [] as FragmentShape[] };
      place(node);
      if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(node);
    }
    index = close + 1;
  }
  return stack.length === 0 ? roots : null;
}

/** Require an explicitly closed fragment. HTML repair must not become admission. */
export function wellFormedFragment(html: string): boolean {
  return fragmentShape(html) !== null;
}

function elementShape(element: Element): FragmentShape[] {
  const shapes: FragmentShape[] = [];
  for (const child of element.childNodes) {
    if (child.nodeType !== 1) continue;
    const node = child as Element;
    shapes.push({ tag: node.tagName.toLowerCase(), children: elementShape(node) });
  }
  return shapes;
}

function sameShape(left: FragmentShape[], right: FragmentShape[]): boolean {
  return left.length === right.length && left.every((node, index) =>
    node.tag === right[index]!.tag && sameShape(node.children, right[index]!.children));
}

/** Comments, escapes, and any function other than rgb()/rgba() are not a style value. */
function cssValueAllowed(value: string): boolean {
  if (/[\\<>{}]|\/\*|\*\//.test(value)) return false;
  if (/url\s*\(|image-set\s*\(|-webkit-image-set\s*\(|expression\s*\(|@import|javascript:|https?:|\/\//i.test(value)) return false;
  const withoutColor = value.replace(/rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)/gi, ' ');
  return !/[()]/.test(withoutColor);
}


function safeStyle(value: string, css: { n: number }): string | null {
  if (!cssValueAllowed(value)) return null;
  const parts = value.split(';').map(part => part.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    const split = part.indexOf(':');
    if (split <= 0) return null;
    const prop = part.slice(0, split).trim().toLowerCase();
    const raw = part.slice(split + 1).trim();
    if (!STYLE_PROPS.has(prop) || !cssValueAllowed(raw)) return null;
    kept.push(`${prop}: ${raw}`);
  }
  const style = kept.join('; ');
  css.n += style.length;
  return css.n <= STATIC_ARTIFACT_LIMITS.css ? style : null;
}

/**
 * Rebuild one complete fenced document into scriptless markup.
 * Any forbidden node, handler, remote URL, form, or limit rejects the whole artifact.
 */
export function sanitizeStaticArtifact(
  doc: Document,
  input: { html: string; media?: StaticMedia[] },
  startedAt = Date.now()
): SanitizedArtifact {
  const expired = () => Date.now() - startedAt > STATIC_ARTIFACT_LIMITS.deadlineMs;
  if (expired()) return reject('deadline');
  const html = input.html;
  if (typeof html !== 'string' || new TextEncoder().encode(html).length > STATIC_ARTIFACT_LIMITS.bytes) return reject('bytes');
  const expected = fragmentShape(html);
  if (!expected) return reject('malformed');
  const media = input.media ?? [];
  if (media.length > STATIC_ARTIFACT_LIMITS.images) return reject('images');
  const seenMedia = new Set<string>();
  const byId = new Map<string, string>();
  for (const item of media) {
    if (seenMedia.has(item.id) || !/^[\w:-]{1,80}$/.test(item.id)) return reject('media');
    if (!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.dataUrl)) return reject('media');
    seenMedia.add(item.id);
    byId.set(item.id, item.dataUrl);
  }
  const parsed = new doc.defaultView!.DOMParser().parseFromString(html, 'text/html');
  if (parsed.querySelector('parsererror')) return reject('malformed');
  if (!sameShape(expected, elementShape(parsed.body))) return reject('malformed');
  const counts = { nodes: 0, text: 0 };
  const css = { n: 0 };
  const root = doc.createElement('div');
  const visit = (source: Element, parent: Element, depth: number): boolean => {
    if (expired()) return false;
    for (const child of [...source.childNodes]) {
      if (child.nodeType === doc.defaultView!.Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        counts.text += text.length;
        if (counts.text > STATIC_ARTIFACT_LIMITS.text) return false;
        parent.append(doc.createTextNode(text));
        continue;
      }
      if (child.nodeType !== doc.defaultView!.Node.ELEMENT_NODE) return false;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (tag === 'head' || tag === 'body' || tag === 'html') {
        if (!visit(element, parent, depth)) return false;
        continue;
      }
      if (!ALLOWED.has(tag) || ++counts.nodes > STATIC_ARTIFACT_LIMITS.nodes || depth > STATIC_ARTIFACT_LIMITS.depth) return false;
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'href' || name === 'srcset' || name === 'action' || name === 'formaction') return false;
        if (name !== 'style' && !(tag === 'img' && (name === 'alt' || name === 'src' || name === 'data-media-id'))) return false;
      }
      const next = doc.createElement(tag);
      if (tag === 'img') {
        const id = element.getAttribute('data-media-id') ?? '';
        const dataUrl = byId.get(id);
        if (!dataUrl || element.getAttribute('src')) return false;
        next.setAttribute('alt', element.getAttribute('alt') ?? '');
        next.setAttribute('src', dataUrl);
      }
      const style = element.getAttribute('style');
      if (style !== null) {
        const clean = safeStyle(style, css);
        if (clean === null) return false;
        if (clean) next.setAttribute('style', clean);
      }
      parent.append(next);
      if (tag !== 'br' && tag !== 'hr' && tag !== 'img' && !visit(element, next, depth + 1)) return false;
    }
    return true;
  };
  if (!visit(parsed.documentElement, root, 1) || expired()) return reject(expired() ? 'deadline' : 'rejected');
  return { html: root.innerHTML, rejected: null };
}

/** Sandboxed srcdoc. No scripts, forms, popups, or remote sources. */
export function artifactSrcdoc(artifact: { html: string }): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${artifact.html}`;
}

const ADMITTED_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Map at most four owned ids onto data URLs that were already admitted. */
export function admitArtifactMedia(
  ids: readonly string[],
  admitted: ReadonlyMap<string, string> | undefined
): StaticMedia[] | null {
  if (ids.length > STATIC_ARTIFACT_LIMITS.images) return null;
  const media: StaticMedia[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) || !/^[\w:-]{1,80}$/.test(id)) return null;
    const dataUrl = admitted?.get(id);
    if (!dataUrl || !ADMITTED_IMAGE.test(dataUrl)) return null;
    seen.add(id);
    media.push({ id, dataUrl });
  }
  return media;
}
