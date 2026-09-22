import zhCN from './locales/zh-CN.json';
import es from './locales/es.json';
import zhTW from './locales/zh-TW.json';

export type Language = 'en' | 'es' | 'zh-CN' | 'zh-TW';
const STORAGE_KEY = 'cos.ui.language';
type Catalog = Readonly<Record<string, string>>;
const catalogs: Readonly<Record<Exclude<Language, 'en'>, Catalog>> = { es, 'zh-CN': zhCN, 'zh-TW': zhTW };
const sourceKeys = new Set(Object.values(catalogs).flatMap(catalog => Object.keys(catalog)));

function parseLanguage(value: string | null | undefined): Language {
  return value === 'es' || value === 'zh-CN' || value === 'zh-TW' ? value : 'en';
}

let language: Language = 'en';
try { language = parseLanguage(window.localStorage.getItem(STORAGE_KEY)); }
catch { /* Storage may be unavailable in a restricted renderer; English remains the default. */ }

export function currentLanguage(): Language { return language; }

type NodeFs = {
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
type NodePath = { join: (...parts: string[]) => string };

/** Keys passed to t() in renderer source that this catalog does not contain. */
export function missingLocaleKeys(locale: Exclude<Language, 'en'>): string[] {
  const proc = (globalThis as { process?: { cwd: () => string; getBuiltinModule: (name: string) => NodeFs | NodePath } }).process;
  if (!proc?.getBuiltinModule) throw new Error('missingLocaleKeys reads renderer source from Node');
  const fs = proc.getBuiltinModule('node:fs') as NodeFs;
  const path = proc.getBuiltinModule('node:path') as NodePath;
  const root = path.join(proc.cwd(), 'src', 'renderer');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  const keys = new Set<string>();
  const literal = /\bt\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(literal)) {
      const quote = match[1]!;
      const body = match[2]!;
      if (quote === '`' && body.includes('${')) continue;
      const decoded = quote === "'"
        ? JSON.parse(`"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string
        : JSON.parse(`"${body}"`) as string;
      keys.add(decoded);
    }
  }
  const catalog = catalogs[locale];
  return [...keys].filter(key => !Object.hasOwn(catalog, key)).sort();
}

/** Translate only app-authored copy at explicit call sites. Arguments remain verbatim. */
export function t(source: string, args: readonly unknown[] = []): string {
  const catalog = language === 'en' ? undefined : catalogs[language];
  const key = catalog && Object.hasOwn(catalog, source) ? source : source.replace(/\s+/g, ' ').trim();
  const translated = catalog && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}

type Property = 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint';
type Binding = { read: () => string; last: string };
const bindings = new WeakMap<Node, Map<Property, Binding>>();

function read(node: Node, property: Property): string | null {
  return property === 'textContent' ? node.textContent : (node as Element).getAttribute(property);
}
function write(node: Node, property: Property, value: string): void {
  if (property === 'textContent') node.textContent = value;
  else (node as Element).setAttribute(property, value);
}

/** Bind the existing node, never reconstruct controls, drafts, icons or chat history. */
export function ui<T extends Node>(node: T, property: Property, value: () => string): T {
  let properties = bindings.get(node);
  if (!properties) {
    bindings.set(node, properties = new Map());
  }
  const last = value();
  properties.set(property, { read: value, last });
  write(node, property, last);
  return node;
}

export function uiText(value: () => string): Text {
  return ui(document.createTextNode(''), 'textContent', value);
}

export function setLanguage(next: Language): void {
  language = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* The current window can still change language. */ }
  document.documentElement.lang = next;
  syncLanguageControls();
  // The document owns the live labels, including hidden settings and collapsed
  // history. Do not index every label ever created: sweeping WeakRefs during
  // rendering keeps their detached DOM trees alive until the job ends and makes
  // each repaint revisit accumulated history. Bindings alone do not retain nodes.
  const walker = document.createTreeWalker(document.body, 1 | 4 /* elements + text */);
  do {
    const node = walker.currentNode;
    for (const [property, binding] of bindings.get(node) ?? []) {
      // A renderer may replace a placeholder with an authored title or an error.
      // That newer value owns the node; a language change cannot overwrite it.
      if (read(node, property) !== binding.last) { bindings.get(node)?.delete(property); continue; }
      binding.last = binding.read();
      write(node, property, binding.last);
    }
  } while (walker.nextNode());
}

/** Setup and settings project the same saved preference. */
function syncLanguageControls(): void {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null;
  if (select) select.value = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
}

/** Run once on the static shell, before any user/provider content is inserted. */
export function initLanguage(): void {
  const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
    const source = node.data;
    const key = source.replace(/\s+/g, ' ').trim();
    if (sourceKeys.has(key)) ui(node, 'textContent', () => source.replace(/\S[\s\S]*\S|\S/, t(key)));
  }
  for (const node of document.querySelectorAll<HTMLElement>('[title], [placeholder], [aria-label]')) {
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && sourceKeys.has(source)) ui(node, property, () => t(source));
    }
  }
  document.documentElement.lang = language;
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  syncLanguageControls();
  select.addEventListener('change', () => setLanguage(parseLanguage(select.value)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-language]')) {
    button.addEventListener('click', () => setLanguage(parseLanguage(button.dataset.language)));
  }
}
