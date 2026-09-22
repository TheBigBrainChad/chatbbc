/**
 * Regression tests for the unpacked Chrome companion itself.
 *
 * These execute the shipped JavaScript rather than a TypeScript reimplementation. The
 * DOM adapter runs against tiny structural fakes for the ChatGPT shapes we have seen in
 * the browser, and the service worker runs in a VM with fake Chrome storage so its
 * restart/durability rules are exercised without needing a Chrome process in CI.
 */

import { promises as fs } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { APP_SLUG, APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');

let domSource = '';
let backgroundSource = '';

beforeAll(async () => {
  [domSource, backgroundSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8')
  ]);
  backgroundSource = backgroundSource.replace(/\r\n/g, '\n');
});

describe('extension release metadata', () => {
  it('keeps the app package, bundled extension and bridge protocol on the same release', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { version: string };
    expect(pkg.version).toBe(APP_VERSION);
    expect(lock.version).toBe(APP_VERSION);
    expect(lock.packages?.['']?.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
    expect(BRIDGE_PROTOCOL).toBe(17);
    expect(backgroundSource).toContain('const BRIDGE_PROTOCOL = 17;');
  });

  it('grants the companion download custody without exposing a main-process URL path', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { permissions: string[] };
    expect(manifest.permissions).toContain('downloads');
    expect(backgroundSource).toContain('chrome.downloads.download');
    expect(backgroundSource).toContain("call('/generated-assets/claim'");
    expect(backgroundSource).toContain("call('/generated-assets/result'");
    expect(backgroundSource).toContain('generatedAssetDownloads');
    expect(backgroundSource).not.toMatch(/generatedAssetDownloads[^\n]*(?:signedUrl|sourceUrl|https?:)/);
  });

  it('claims an exact document, persists Chrome download custody before started, and never persists the signed URL', async () => {
    const code = backgroundSource.slice(
      backgroundSource.indexOf('function validGeneratedAssetOffer('),
      backgroundSource.indexOf('\nasync function maintainOnce(')
    );
    const order: string[] = [];
    const persisted: unknown[] = [];
    const downloads = vi.fn(async () => { order.push('download'); return 73; });
    const call = vi.fn(async (route: string, init: { body?: string }) => {
      if (route === '/generated-assets/claim') {
        order.push('claim');
        const body = JSON.parse(init.body || '{}');
        return { ok: true, data: { claim: {
          id: body.id,
          conversationId: body.conversationId,
          logicalMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          assetId: 'file_AuroraOriginal0001',
          filename: 'ChatBBC image 01.png',
          claimToken: 'a'.repeat(32)
        } } };
      }
      order.push(`result:${JSON.parse(init.body || '{}').state}`);
      return { ok: true, data: { ok: true } };
    });
    const generatedAssetDownloads: Record<string, unknown> = {};
    const context = vm.createContext({
      chrome: { downloads: { download: downloads } },
      URL,
      cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
      conversationForTab: (tab: { url: string }) => new URL(tab.url).pathname.split('/').at(-1),
      tabConversations: { '42': '11111111-2222-4333-8444-555555555555' },
      tabDocuments: { '42': 'doc-42' },
      tabEpochs: { '42': 7 },
      registeredDocuments: { '42': { documentId: 'doc-42', epoch: 3 } },
      ownsDocument: (source: any) => source.tab === 42 && source.documentId === 'doc-42' && source.navigationEpoch === 7,
      tabReply: async () => ({ ok: true,
        logicalMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        assetId: 'file_AuroraOriginal0001',
        url: 'https://chatgpt.com/backend-api/estuary/content?id=file_AuroraOriginal0001&sig=secret' }),
      call,
      generatedAssetDownloads,
      MAX_GENERATED_ASSET_DOWNLOADS: 100,
      persistLive: async () => {
        order.push('persist');
        persisted.push(structuredClone(generatedAssetDownloads));
      }
    });
    const processDownloads = vm.runInContext(`${code}\nprocessGeneratedAssetDownloads`, context);
    await processDownloads([{
      id: '22222222-3333-4444-8555-666666666666',
      conversationId: '11111111-2222-4333-8444-555555555555',
      logicalMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      assetId: 'file_AuroraOriginal0001',
      filename: 'ChatBBC image 01.png',
      document: { tab: 42, documentId: 'doc-42', documentGeneration: 3, spaEpoch: 7 }
    }], [{
      id: 42,
      active: true,
      url: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555'
    }]);
    expect(downloads).toHaveBeenCalledWith({
      url: 'https://chatgpt.com/backend-api/estuary/content?id=file_AuroraOriginal0001&sig=secret',
      filename: 'ChatBBC image 01.png',
      conflictAction: 'uniquify',
      saveAs: false
    });
    expect(order.indexOf('persist')).toBeGreaterThan(order.indexOf('download'));
    expect(order.indexOf('result:started')).toBeGreaterThan(order.indexOf('persist'));
    expect(JSON.stringify(persisted)).not.toContain('sig=secret');
    expect(persisted[0]).toEqual(expect.objectContaining({
      '22222222-3333-4444-8555-666666666666': expect.objectContaining({
        browserDownloadId: 73,
        state: 'started'
      })
    }));
  });

  it('keeps restored started custody exclusive and reports a Chrome start refusal without replaying it', async () => {
    const code = backgroundSource.slice(
      backgroundSource.indexOf('function validGeneratedAssetOffer('),
      backgroundSource.indexOf('\nasync function maintainOnce(')
    );
    const offer = {
      id: '22222222-3333-4444-8555-666666666666',
      conversationId: '11111111-2222-4333-8444-555555555555',
      logicalMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      assetId: 'file_AuroraOriginal0001',
      filename: 'ChatBBC image 01.png',
      document: { tab: 42, documentId: 'doc-42', documentGeneration: 3, spaEpoch: 7 }
    };
    const calls: Array<{ route: string; body: any }> = [];
    const downloads = vi.fn(async () => { throw new Error('start refused'); });
    const generatedAssetDownloads: Record<string, any> = {
      [offer.id]: { ...offer, claimToken: 'a'.repeat(32), browserDownloadId: 73, state: 'started' }
    };
    const context = vm.createContext({
      chrome: { downloads: { download: downloads } },
      URL,
      cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
      conversationForTab: (tab: { url: string }) => new URL(tab.url).pathname.split('/').at(-1),
      tabConversations: { '42': offer.conversationId },
      tabDocuments: { '42': 'doc-42' },
      tabEpochs: { '42': 7 },
      registeredDocuments: { '42': { documentId: 'doc-42', epoch: 3 } },
      ownsDocument: () => true,
      tabReply: async () => ({ ok: true, logicalMessageId: offer.logicalMessageId,
        assetId: offer.assetId,
        url: `https://chatgpt.com/backend-api/estuary/content?id=${offer.assetId}&sig=secret` }),
      call: async (route: string, init: { body?: string }) => {
        const body = JSON.parse(init.body || '{}');
        calls.push({ route, body });
        if (route === '/generated-assets/claim') return { ok: true, data: { claim: {
          ...offer, claimToken: 'a'.repeat(32)
        } } };
        return { ok: true, data: { ok: true } };
      },
      generatedAssetDownloads,
      MAX_GENERATED_ASSET_DOWNLOADS: 100,
      persistLive: async () => undefined
    });
    const processDownloads = vm.runInContext(`${code}\nprocessGeneratedAssetDownloads`, context);
    const tabs = [{ id: 42, active: true, url: `https://chatgpt.com/c/${offer.conversationId}` }];
    await processDownloads([offer], tabs);
    expect(downloads).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    delete generatedAssetDownloads[offer.id];
    await processDownloads([offer], tabs);
    expect(downloads).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toMatchObject({
      route: '/generated-assets/result',
      body: { id: offer.id, state: 'failed' }
    });
    expect(generatedAssetDownloads).toEqual({});
  });

  it('reports unconfirmed and drops memory custody when Chrome accepted a download that could not be saved', async () => {
    const code = backgroundSource.slice(
      backgroundSource.indexOf('function validGeneratedAssetOffer('),
      backgroundSource.indexOf('\nasync function maintainOnce(')
    );
    const offer = {
      id: '22222222-3333-4444-8555-666666666666',
      conversationId: '11111111-2222-4333-8444-555555555555',
      logicalMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      assetId: 'file_AuroraOriginal0001',
      filename: 'ChatBBC image 01.png',
      document: { tab: 42, documentId: 'doc-42', documentGeneration: 3, spaEpoch: 7 }
    };
    const calls: Array<{ route: string; body: any }> = [];
    const generatedAssetDownloads: Record<string, any> = {};
    const context = vm.createContext({
      chrome: { downloads: { download: async () => 73 } },
      URL,
      cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
      conversationForTab: (tab: { url: string }) => new URL(tab.url).pathname.split('/').at(-1),
      tabConversations: { '42': offer.conversationId },
      tabDocuments: { '42': 'doc-42' },
      tabEpochs: { '42': 7 },
      registeredDocuments: { '42': { documentId: 'doc-42', epoch: 3 } },
      ownsDocument: () => true,
      tabReply: async () => ({ ok: true, logicalMessageId: offer.logicalMessageId, assetId: offer.assetId,
        url: `https://chatgpt.com/backend-api/estuary/content?id=${offer.assetId}&sig=secret` }),
      call: async (route: string, init: { body?: string }) => {
        const body = JSON.parse(init.body || '{}');
        calls.push({ route, body });
        if (route === '/generated-assets/claim') return { ok: true, data: { claim: { ...offer, claimToken: 'a'.repeat(32) } } };
        return { ok: false, data: { ok: false } };
      },
      generatedAssetDownloads,
      MAX_GENERATED_ASSET_DOWNLOADS: 100,
      persistLive: async () => { throw new Error('session storage full'); }
    });
    const api = vm.runInContext(`${code}\n({ processGeneratedAssetDownloads, lost: () => downloadCustodyNeedsReconcile })`, context);
    await api.processGeneratedAssetDownloads([offer], [{
      id: 42, active: true, url: `https://chatgpt.com/c/${offer.conversationId}`
    }]);
    expect(generatedAssetDownloads).toEqual({});
    expect(calls.filter(entry => entry.route === '/generated-assets/result')).toHaveLength(3);
    expect(calls.filter(entry => entry.route === '/generated-assets/result').every(entry => entry.body.state === 'unconfirmed')).toBe(true);
    expect(api.lost()).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('sig=secret');
  });

  it('settles restored Chrome download changes once, including cancellation, and ignores unknown receipts', async () => {
    expect(backgroundSource).toContain('async function settleGeneratedAssetDownloadChange(');
    const code = backgroundSource.slice(
      backgroundSource.indexOf('async function settleGeneratedAssetDownloadChange('),
      backgroundSource.indexOf('\nasync function processGeneratedAssetDownloads(')
    );
    const row = {
      id: '22222222-3333-4444-8555-666666666666',
      claimToken: 'a'.repeat(32),
      browserDownloadId: 73,
      state: 'started',
      detail: null
    };
    const generatedAssetDownloads: Record<string, any> = { [row.id]: row };
    const order: string[] = [];
    const context = vm.createContext({
      generatedAssetDownloads,
      persistLive: async () => { order.push('persist'); },
      publishGeneratedAssetDownloadResult: async (value: any) => { order.push(`publish:${value.state}`); }
    });
    const settle = vm.runInContext(`${code}\nsettleGeneratedAssetDownloadChange`, context);
    expect(await settle({ id: 999, state: { current: 'complete' } })).toBe(false);
    expect(await settle({ id: 73, state: { current: 'complete' } })).toBe(true);
    expect(row.state).toBe('complete');
    expect(order).toEqual(['persist', 'publish:complete']);
    row.state = 'started';
    order.length = 0;
    expect(await settle({ id: 73, error: { current: 'USER_CANCELED' } })).toBe(true);
    expect(row).toMatchObject({ state: 'failed', detail: 'USER_CANCELED' });
    expect(order).toEqual(['persist', 'publish:failed']);
    expect(await settle({ id: 73, state: { current: 'complete' } })).toBe(false);
  });

  /**
   * The Fiber helper is the one piece of this extension that runs in ChatGPT's own
   * JavaScript context, and it only does so because the manifest says `"world": "MAIN"`.
   * Lose that one word and the file still loads, still finds nothing — `__reactFiber$` is
   * invisible from an isolated world — and fails closed, so every collapsed row silently
   * goes back to standing for one call. That is a regression with no symptom, which is
   * why it is pinned here.
   */
  it('runs only the fiber and bounded usage readers in the page context', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { content_scripts: Array<{ js: string[]; world?: string }> };

    const main = manifest.content_scripts.filter((entry) => entry.world === 'MAIN');
    expect(main).toHaveLength(2);
    expect(main.flatMap((entry) => entry.js).sort()).toEqual(['fiber.js', 'usage.js']);
    // The rest stays isolated: the page must not be able to reach the code that talks to
    // the service worker, holds the bridge token, or decides what gets recorded.
    for (const entry of manifest.content_scripts) {
      if (entry.world === 'MAIN') continue;
      expect(entry.js).not.toContain('fiber.js');
      expect(entry.world ?? 'ISOLATED').toBe('ISOLATED');
    }
  });

  /**
   * The helper's whole justification is that it reads props the page owns. What it may
   * hand back is an allowlist, and these are the two things that must never be in it: a
   * tool's arguments, which are the user's text, and the secrets observed inside them.
   */
  it('never sends tool arguments or secrets out of the page context', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
    // Comments discuss the secrets by name; the code must never touch them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/agent_key|authorization|access_token/i);
    // The payload is never turned into an object at all. It used to be parsed for its
    // `path`, which meant the arguments — the user's text, and the secrets observed inside
    // them — existed as live values in this scope, one careless line from crossing over.
    // The path is read off the front of the string instead, so `args` is never walked.
    expect(code).not.toMatch(/JSON\.parse/);
    expect(code).not.toMatch(/\bargs\b/);
    // Nor may a whole object be serialised across, which would defeat the allowlist.
    expect(code).not.toMatch(/JSON\.stringify/);
  });

  /**
   * The installed popup showed "Paired · port 8765" with a green dot and, underneath it,
   * a six-digit code field and a Pair button — a page contradicting itself about the one
   * thing it exists to report. There is nothing to type any more, so the way to keep that
   * from coming back is for the markup to have no field to type into.
   */
  it('has no pairing-code UI anywhere in the popup', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/000000|six[- ]digit|pairing code/i);
    expect(html).not.toMatch(/type=["'](?:text|number|password)["']/i);
    expect(js).not.toMatch(/\bcode\b/);
    // The message the worker understands carries no code either.
    expect(js).not.toMatch(/type: 'pair'[^}]*code/);
  });

  it('ships Overwrite on by default and exposes one persistent toggle that refreshes immediately', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [content, html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'content.js'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(content).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(content).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(content).toContain('let RENDER_STREAM = TEST_MODE ? false : true;');
    expect(html).toContain('id="overwriteToggle"');
    expect(html).toContain('id="timeToggle"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('id="overwriteBtn"');
    expect(js).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(js).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(js).toContain('chrome.storage.local.set');
    expect(js).toContain("type: 'overwriteNow'");
    expect(backgroundSource).toContain('async overwriteNow()');
    expect(backgroundSource).toContain("chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' })");
  });
});

// ---------------------------------------------------------------------- DOM

const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
const TOOL_SELECTOR = 'span[class*="tool-message"]';

class FakeNode {
  textContent = '';
  innerText = '';
  className = '';
  tagName = 'DIV';
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
  private all = new Map<string, FakeNode[]>();
  private closestMatches = new Set<string>();

  constructor(attrs: Record<string, string> = {}, text = '') {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    this.textContent = text;
    this.innerText = text;
    this.className = attrs.class ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.all.get(selector) ?? [];
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  with(selector: string, nodes: FakeNode[]): this {
    this.all.set(selector, nodes);
    return this;
  }

  under(selector: string): this {
    this.closestMatches.add(selector);
    return this;
  }

  closest(selector: string): FakeNode | null {
    return this.closestMatches.has(selector) ? this : null;
  }

  /** Flat fakes: a node only ever contains itself, which is all toolBlocks() asks. */
  contains(other: FakeNode): boolean {
    return other === this;
  }
}

/** A tool block as the live page renders it: a short header line and nothing else. */
function toolBlock(label = 'Called tool'): FakeNode {
  return new FakeNode({ class: 'pointer-events-none contents' }, label);
}

interface DomApi {
  conversationId(): string | null;
  conversationFromPath(pathname: unknown): string | null;
  turns(): Array<{ node: FakeNode; nodes: FakeNode[]; id: string | null; role: string | null }>;
  messages(): Array<{ id: string; role: string; text: string; turnId: string | null }>;
  progressLine(turn: unknown): string | null;
  interrupted(turn: unknown): boolean;
  markProgress(turn: unknown): number;
  hideProgress(turn: unknown, hidden: boolean): void;
  toolBlocks(turn: unknown): FakeNode[];
  errors(): string[];
}

function loadDom(sections: FakeNode[], pathname = '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): DomApi {
  const document = {
    querySelectorAll: (selector: string) => (selector === TURN_SELECTOR ? sections : []),
    querySelector: () => null
  };
  const context = vm.createContext({ document, location: { pathname } });
  vm.runInContext(domSource, context, { filename: 'chatgpt-dom.js' });
  return (context as unknown as { CLF_DOM: DomApi }).CLF_DOM;
}

function turn(role: 'user' | 'assistant', id: string): FakeNode {
  return new FakeNode({ 'data-testid': 'conversation-turn-1', 'data-turn': role, 'data-turn-id': id });
}

describe('ChatGPT DOM adapter', () => {
  const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  /**
   * Project conversations are routed under the project, and everything downstream — app
   * session, ownership registry, caller attribution — is keyed on the id this returns.
   * A shared snapshot is deliberately not a conversation this document can own.
   */
  it('recognises a conversation at the site root and inside a Project, and only those', () => {
    const dom = loadDom([]);
    for (const accepted of [
      `/c/${CONVERSATION}`,
      `/c/${CONVERSATION}/`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}/`,
      `/g/g-abcdef/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(accepted), accepted).toBe(CONVERSATION);
    }

    for (const rejected of [
      '/',
      '/c/short',
      `/share/c/${CONVERSATION}`,
      `/share/${CONVERSATION}`,
      `/gpts/c/${CONVERSATION}`,
      `/g/g-p-one/g/g-p-two/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(rejected), rejected).toBeNull();
    }

    expect(dom.conversationFromPath(null)).toBeNull();
    expect(dom.conversationFromPath(undefined)).toBeNull();
  });

  it('reads the live route through that same parser', () => {
    expect(loadDom([], `/g/g-p-68abcdef1234/c/${CONVERSATION}`).conversationId()).toBe(CONVERSATION);
    expect(loadDom([], `/share/c/${CONVERSATION}`).conversationId()).toBeNull();
    expect(loadDom([], '/').conversationId()).toBeNull();
  });

  it('groups split assistant sections that share one data-turn-id before counting tool blocks', () => {
    const user = turn('user', 'user-1');
    const a1 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock()]);
    const a2 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock(), toolBlock()]);
    const dom = loadDom([user, a1, a2]);

    const turns = dom.turns();
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.id).toBe('request-1');
    expect(assistant.nodes).toEqual([a1, a2]);
    expect(dom.toolBlocks(assistant)).toHaveLength(5);
  });

  /**
   * `div.pointer-events-none.contents` is a layout shape ChatGPT also uses for containers
   * that hold a whole answer. Counting one of those as a tool block inflates the block
   * count of the turn, which is exactly what the relabelling has to match against.
   */
  it('refuses a display-contents container that holds prose rather than a tool label', () => {
    const prose = toolBlock('a very long assistant answer').with('.markdown', [new FakeNode({}, 'answer')]);
    const real = toolBlock();
    const assistant = turn('assistant', 'request-3').with(TOOL_SELECTOR, [prose, real]);
    const dom = loadDom([assistant]);

    expect(dom.toolBlocks(dom.turns()[0]!)).toEqual([real]);
  });

  it('does not mistake ChatGPT transport-failure markdown for a completed assistant answer', () => {
    const failure = new FakeNode({}, 'Message delivery timed out. Please try again. Retry');
    const assistant = turn('assistant', 'request-failed')
      .with('[data-message-id]', [])
      .with('.markdown', [failure])
      .with('[data-interrupted="true"]', []);
    const dom = loadDom([assistant]);

    expect(dom.messages()).toEqual([]);
    // An occurrence, not a bare string: the node is what tells one showing of this banner
    // apart from the next, and the turn is what scopes it.
    expect(dom.errors()).toMatchObject([
      { text: 'Message delivery timed out. Please try again. Retry', node: failure, turnId: 'request-failed' }
    ]);
  });

  it('records assistant prose from .markdown when ChatGPT supplies no assistant data-message-id', () => {
    const userMessage = new FakeNode(
      { 'data-message-id': 'user-message-1', 'data-message-author-role': 'user' },
      'do the thing'
    );
    const user = turn('user', 'user-1').with('[data-message-id]', [userMessage]);

    const liveProgress = new FakeNode({}, 'Reading files').under('[data-interrupted]');
    const finalA = new FakeNode({}, 'First paragraph');
    const finalB = new FakeNode({}, 'Second paragraph');
    const assistant = turn('assistant', 'request-2')
      .with('[data-message-id]', [])
      .with('.markdown', [liveProgress, finalA, finalB])
      .with('[data-interrupted="true"]', []);

    const messages = loadDom([user, assistant]).messages();
    // toMatchObject rather than toEqual: each message also carries the section it was read
    // from, which is what lets the content script tell a message left behind by a chat it
    // has navigated away from apart from one belonging to the chat it is on now.
    expect(messages).toMatchObject([
      { id: 'user-message-1', role: 'user', text: 'do the thing', turnId: 'user-1', interrupted: false, node: user },
      {
        id: 'assistant:request-2',
        role: 'assistant',
        text: 'Second paragraph',
        turnId: 'request-2',
        interrupted: false,
        node: assistant
      }
    ]);
    expect(messages).toHaveLength(2);
  });

  it('marks only the observed progress containers so the overlay can make them legible', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tests');
    const a1 = turn('assistant', 'request-progress').with('[data-interrupted]', [firstBox]);
    const a2 = turn('assistant', 'request-progress').with('[data-interrupted]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;
    expect(dom.markProgress(logical)).toBe(2);
    expect(firstBox.getAttribute('data-clf-progress')).toBe('1');
    expect(secondBox.getAttribute('data-clf-progress')).toBe('1');
    expect(dom.markProgress(logical)).toBe(0);
  });

  it('never hides a progress container that ChatGPT has put the answer inside', () => {
    // ChatGPT reparents the finished prose into a data-interrupted box on some turns.
    // Hiding by the attribute alone therefore hid the answer as well, which is what left
    // completed turns showing "Worked for 45s" over an empty gap with no way to get the
    // text back. Commentary is replaceable; the answer is not.
    const commentary = new FakeNode({ 'data-interrupted': 'false' }, 'Reading files');
    const answer = new FakeNode({ 'data-interrupted': 'false' }, 'Here is the summary');
    answer.with('.markdown', [new FakeNode({ class: 'markdown' }, 'Here is the summary')]);
    const section = turn('assistant', 'request-answer').with('[data-interrupted], [data-clf-progress]', [commentary, answer]);
    const dom = loadDom([section]);
    const logical = dom.turns()[0]!;

    dom.hideProgress(logical, true);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(answer.getAttribute('data-clf-native-hidden')).toBeNull();

    dom.hideProgress(logical, false);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('reads every progress container of the turn, in order, rather than only the last', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking\nReading files');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tool\nRunning tests');
    const a1 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [firstBox])
      .with('[data-interrupted="true"]', [firstBox]);
    const a2 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [secondBox])
      .with('[data-interrupted="true"]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;

    // Taking only the newest box made this value shrink whenever ChatGPT grew a new one,
    // and a shrink reads as new text to the delta logic, which printed it all over again.
    expect(dom.progressLine(logical)).toBe('Thinking\nReading files\nRunning tool\nRunning tests');
    expect(dom.interrupted(logical)).toBe(true);
  });
});

// --------------------------------------------------------------- service worker

class FakeStorageArea {
  data: Record<string, unknown>;
  /** Optional quota used to make writes fail the way Chrome does. */
  maxBytes: number | null = null;
  /** Deterministic transient write failure seam for durability/restart regressions. */
  failNextSets = 0;
  /**
   * Optional read latency, in milliseconds.
   *
   * Chrome answers a read from another process, so a read is not instant and two readers
   * do not advance in lockstep. The snapshot is still taken when the read is *issued* —
   * that is the whole point of modelling it: a read issued before someone else's write
   * can be answered after it, and then it carries stale data into live state.
   */
  lagMs = 0;
  /** Per-write completion delay; the snapshot is taken before waiting, like an async IPC write. */
  setDelays: number[] = [];
  private setCount = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string): Promise<Record<string, unknown>> {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const snapshot = Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
    if (this.lagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.lagMs));
    return snapshot;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    if (this.failNextSets > 0) {
      this.failNextSets--;
      throw new Error('synthetic storage write failure');
    }
    const next = { ...this.data, ...structuredClone(values) };
    if (this.maxBytes !== null && Buffer.byteLength(JSON.stringify(next), 'utf8') > this.maxBytes) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    const delay = this.setDelays[this.setCount++] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.data = next;
  }
}

interface WorkerHarness {
  send(message: Record<string, unknown>, tabId?: number, documentId?: string, senderUrl?: string,
    frameId?: number): Promise<any>;
  /** Fires Chrome's real tab-close lifecycle event. */
  closeTab(tabId: number): Promise<void>;
  /** Fires only Chrome's navigation-start signal, without inventing a replacement document. */
  startTabNavigation(tabId: number, url?: string): Promise<void>;
  /** Completes navigation with no URL, as Chrome does outside granted hosts. */
  completeTabNavigation(tabId: number): Promise<void>;
  /** Fires Chrome's tab URL-change lifecycle event. */
  navigateTab(tabId: number, url: string): Promise<void>;
  /** Fires the extension install/update lifecycle event. */
  installed(reason?: string): Promise<void>;
  /** Fires the periodic maintenance alarm this worker schedules for itself. */
  fireAlarm(name?: string): Promise<void>;
  /** Registers the browser document that owns subsequent tab-scoped messages. */
  registerTab(tabId: number, documentId?: string, senderUrl?: string): Promise<any>;
  /** Fires Chrome's tab-created lifecycle event, the way opening a link in a new tab does. */
  createTab(tab: { id: number; url?: string; pendingUrl?: string; autoDiscardable?: boolean }): Promise<void>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  tabsRemove: ReturnType<typeof vi.fn>;
  tabsReload: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  scriptingExecuteScript: ReturnType<typeof vi.fn>;
  scriptingInsertCSS: ReturnType<typeof vi.fn>;
  alarmCreate: ReturnType<typeof vi.fn>;
  alarmClear: ReturnType<typeof vi.fn>;
}

function response(status: number, data: unknown) {
  const body =
    data && typeof data === 'object' && (data as Record<string, unknown>).app === APP_SLUG
      ? { bridge: BRIDGE_PROTOCOL, compatible: true, ...structuredClone(data as Record<string, unknown>) }
      : structuredClone(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

function loadWorker(options: {
  local: FakeStorageArea;
  session: FakeStorageArea;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
  tabsGet?: (tabId: number) => Promise<{ id?: number; url?: string; pendingUrl?: string; status?: string; autoDiscardable?: boolean }>;
  tabsQuery?: () => Promise<
    Array<{ id?: number; windowId?: number; url?: string; pendingUrl?: string; status?: string; autoDiscardable?: boolean; active?: boolean; discarded?: boolean; frozen?: boolean }>
  >;
  tabsSendMessage?: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
  windowsGet?: (windowId: number) => Promise<{ focused?: boolean }>;
}): WorkerHarness {
  let listener: ((message: any, sender: any, sendResponse: (value: any) => void) => boolean) | null = null;
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabCreatedListeners: Array<(tab: { id?: number; url?: string; pendingUrl?: string }) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string; status?: string }) => void> = [];
  const installedListeners: Array<(details: { reason: string }) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const knownTabs = new Map<
    number,
    { id: number; windowId: number; url?: string; pendingUrl?: string; autoDiscardable?: boolean }
  >();
  const tabsCreate = vi.fn(async ({ url }: { url?: string } = {}) => {
    knownTabs.set(99, { id: 99, windowId: 7, ...(url ? { url } : {}) });
    return { id: 99 };
  });
  const tabsQuery = vi.fn(options.tabsQuery ?? (async () => [...knownTabs.values()]));
  const tabsUpdate = vi.fn(async (id: number, properties: { autoDiscardable?: boolean } = {}) => {
    const tab = knownTabs.get(id);
    if (tab && typeof properties.autoDiscardable === 'boolean') tab.autoDiscardable = properties.autoDiscardable;
    return { id, windowId: 7, ...properties };
  });
  const tabsSendMessage = vi.fn(options.tabsSendMessage ?? (async () => ({ ok: true })));
  const tabsRemove = vi.fn(async () => undefined);
  const tabsReload = vi.fn(async () => undefined);
  const scriptingExecuteScript = vi.fn(async () => []);
  const scriptingInsertCSS = vi.fn(async () => undefined);
  const alarmCreate = vi.fn(() => undefined);
  const alarmClear = vi.fn(async () => true);
  const windowsUpdate = vi.fn(async () => ({ id: 7 }));
  const documentNumbers = new Map<number, number>();
  const currentDocuments = new Map<number, string>();
  const documentFor = (tabId: number): string => {
    const current = currentDocuments.get(tabId);
    if (current) return current;
    const created = `document-${tabId}-0`;
    currentDocuments.set(tabId, created);
    documentNumbers.set(tabId, 0);
    return created;
  };
  const event = () => ({ addListener: () => undefined });
  const chrome = {
    storage: { local: options.local, session: options.session },
    runtime: {
      getManifest: () => ({ version: '1.6.0' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      },
      onInstalled: {
        addListener(fn: (details: { reason: string }) => void) {
          installedListeners.push(fn);
        }
      },
      onStartup: event()
    },
    windows: { update: windowsUpdate, get: options.windowsGet ?? (async () => ({ focused: true })) },
    scripting: {
      executeScript: scriptingExecuteScript,
      insertCSS: scriptingInsertCSS
    },
    alarms: {
      create: alarmCreate,
      clear: alarmClear,
      onAlarm: {
        addListener(fn: (alarm: { name: string }) => void) {
          alarmListeners.push(fn);
        }
      }
    },
    tabs: {
      create: tabsCreate,
      query: tabsQuery,
      update: tabsUpdate,
      get: options.tabsGet ?? vi.fn(async () => {
        throw new Error('tab state unavailable in this harness');
      }),
      sendMessage: tabsSendMessage,
      remove: tabsRemove,
      reload: tabsReload,
      onCreated: {
        addListener(fn: (tab: { id?: number; url?: string; pendingUrl?: string }) => void) {
          tabCreatedListeners.push(fn);
        }
      },
      onRemoved: {
        addListener(fn: (tabId: number) => void) {
          tabRemovedListeners.push(fn);
        }
      },
      onUpdated: {
        addListener(fn: (tabId: number, changeInfo: { url?: string; status?: string }) => void) {
          tabUpdatedListeners.push(fn);
        }
      }
    }
  };
  const fetch = options.fetch ?? (async () => response(503, {}));
  // This legacy VM harness exercises non-debugger hosts. The real MV3 entry fixture
  // separately loads the unchanged module graph and verifies browser registration.
  vm.runInNewContext(backgroundSource.replace(/^import .*$/gm, ''), {
    chrome,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    crypto: webcrypto,
    atob,
    console
  }, { filename: 'background.js' });
  if (!listener) throw new Error('background.js did not register a message listener');

  return {
    tabsCreate,
    tabsQuery,
    tabsUpdate,
    tabsSendMessage,
    tabsRemove,
    tabsReload,
    windowsUpdate,
    scriptingExecuteScript,
    scriptingInsertCSS,
    alarmCreate,
    alarmClear,
    async fireAlarm(name = 'clf-bridge-drain') {
      for (const fn of alarmListeners) fn({ name });
      for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async installed(reason = 'update') {
      for (const fn of installedListeners) fn({ reason });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async createTab(tab: { id: number; url?: string; pendingUrl?: string; autoDiscardable?: boolean }) {
      knownTabs.set(tab.id, {
        id: tab.id,
        windowId: 7,
        ...(tab.url ? { url: tab.url } : {}),
        ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
        autoDiscardable: tab.autoDiscardable ?? true
      });
      for (const fn of tabCreatedListeners) fn(tab);
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async closeTab(tabId: number) {
      knownTabs.delete(tabId);
      for (const fn of tabRemovedListeners) fn(tabId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async startTabNavigation(tabId: number, url?: string) {
      for (const fn of tabUpdatedListeners) fn(tabId, { ...(url ? { url } : {}), status: 'loading' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async completeTabNavigation(tabId: number) {
      for (const fn of tabUpdatedListeners) fn(tabId, { status: 'complete' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    registerTab(tabId, documentId = documentFor(tabId)) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(
            { type: 'register_document' },
            { tab: { id: tabId }, documentId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    },
    async navigateTab(tabId: number, url: string) {
      knownTabs.set(tabId, { id: tabId, windowId: 7, url });
      const chatGpt = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(url);
      for (const fn of tabUpdatedListeners) fn(tabId, { url, ...(chatGpt ? { status: 'loading' } : {}) });
      let newDocument: string | null = null;
      if (chatGpt) {
        const next = (documentNumbers.get(tabId) ?? 0) + 1;
        documentNumbers.set(tabId, next);
        newDocument = `document-${tabId}-${next}`;
        currentDocuments.set(tabId, newDocument);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Static content injection registers the new ChatGPT document before its normal page
      // traffic. Model that handshake here rather than letting a later bind implicitly clear
      // a terminal lease.
      if (newDocument) {
        await new Promise((resolve, reject) => {
          try {
            const keep = listener!(
              { type: 'register_document' },
              { tab: { id: tabId }, documentId: newDocument, frameId: 0 },
              resolve
            );
            if (keep !== true) reject(new Error('listener did not keep the response channel open'));
          } catch (err) {
            reject(err);
          }
        });
      }
    },
    send(message, tabId = 1, documentId = documentFor(tabId), senderUrl, frameId = 0) {
      if (message.type === 'bind' && typeof message.conversationId === 'string') {
        knownTabs.set(tabId, {
          ...knownTabs.get(tabId),
          id: tabId,
          windowId: 7,
          url: `https://chatgpt.com/c/${message.conversationId}`,
          autoDiscardable: knownTabs.get(tabId)?.autoDiscardable ?? true
        });
      }
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, { tab: { id: tabId }, documentId, frameId, url: senderUrl }, resolve);
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

function journalOf(session: FakeStorageArea): any[] {
  const value = session.data.journal;
  return Array.isArray(value) ? value : [];
}

it.each(['discarded', 'frozen', 'woke', 'navigated', 'loading', 'closed', 'missing'])(
  'rechecks suspended-tab recovery at the browser action (%s)', async state => {
    const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, discarded: state !== 'frozen', frozen: state === 'frozen' };
    const reload = vi.fn();
    const create = vi.fn();
    const call = vi.fn(async () => ({ ok: true }));
    const source = backgroundSource.slice(backgroundSource.indexOf('async function performBrowserRepairs('),
      backgroundSource.indexOf('\nfunction conversationStillOpen('));
    const repair = vm.runInNewContext(`${source}\nperformBrowserRepairs`, {
      tabConversations: { '71': conversationId }, tabDocuments: { '71': 'suspended-document' },
      conversationForTab: (value: { url?: string }) => value.url?.split('/c/')[1] ?? null,
      createChatTab: create, call,
      chrome: { tabs: {
        query: async () => state === 'missing' ? [] : [tab], reload,
        get: async () => {
          if (state === 'closed') throw new Error('Tab closed');
          return { ...tab, discarded: state !== 'woke' && state !== 'frozen',
            ...(state === 'navigated' ? { url: 'https://example.com/' } : {}),
            ...(state === 'loading' ? { pendingUrl: tab.url } : {}) };
        }
      } }, CHATGPT_TAB_URLS: ['https://chatgpt.com/*']
    });
    await repair([{ conversationId, token: 'suspension', suspended: true }], {});
    expect(reload).toHaveBeenCalledTimes(state === 'discarded' || state === 'frozen' ? 1 : 0);
    expect(create).not.toHaveBeenCalled();
  }
);

describe('accepted helper tab cleanup', () => {
  it('shares pending diagnostic reads and discards a result after disconnect', async () => {
    const source = backgroundSource.slice(backgroundSource.indexOf('function publishCompanionDiagnostics()'),
      backgroundSource.indexOf('\nchrome.runtime.onMessage.addListener', backgroundSource.indexOf('function publishCompanionDiagnostics()')));
    let complete!: (value: unknown) => void;
    const snapshot = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const call = vi.fn(async () => ({ ok: true }));
    const context = vm.createContext({ token: 'fixture-token', disconnected: false, connectionEpoch: 1, port: 8765,
      companionDiagnosticsFlight: null, discover: async () => ({ port: 8765 }), companionDiagnosticSnapshot: snapshot, call });
    const publish = vm.runInContext(`${source}\npublishCompanionDiagnostics`, context);
    const first = publish();
    const second = publish();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    context.connectionEpoch++;
    context.disconnected = true;
    complete({ capturedAt: 1 });
    await first;
    expect(call).not.toHaveBeenCalled();
    context.disconnected = false;
    const third = publish();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    complete({ capturedAt: 2 });
    await third;
    expect(call).toHaveBeenCalledTimes(1);
  });

  for (const outcome of ['accepted', 'rejected', 'navigated', 'pinned', 'busy', 'draft', 'pinned-during-proof'] as const) {
    it(`closes only the exact accepted helper document (${outcome})`, async () => {
      const helper = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const other = '11111111-2222-4333-8444-555555555555';
      let url = `https://chatgpt.com/c/${helper}`;
      let pinned = outcome === 'pinned';
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
        tabsGet: async () => ({ id: 1, url, pinned }),
        tabsSendMessage: async (_id, message) => {
          if (message.type !== 'clf-tab-close-check') return { ok: true };
          if (outcome === 'pinned-during-proof') pinned = true;
          return { safe: outcome !== 'busy' && outcome !== 'draft', conversationId: helper, navigationEpoch: 0 };
        },
        fetch: async (input) => {
          const route = new URL(input).pathname;
          if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
          if (route === '/input/answer') {
            if (outcome === 'navigated') url = `https://chatgpt.com/c/${other}`;
            return response(200, { ok: outcome !== 'rejected' });
          }
          return response(200, {});
        }
      });
      await worker.registerTab(1);
      const result = await worker.send({ type: 'desktop_input', id: 'ffffffff-1111-4222-8333-444444444444',
        owner: '1:document-1-0:0', response: '{"action":"stop","reply":""}' });
      expect(result.ok).toBe(true);
      if (outcome === 'accepted') expect(worker.tabsRemove).toHaveBeenCalledExactlyOnceWith(1);
      else expect(worker.tabsRemove).not.toHaveBeenCalled();
    });
  }
});

describe('automatic Continue shares scheduled reload custody', () => {
  it.each(['accepted', 'draft', 'navigated', 'rejected'] as const)('never reloads immediately after Stop (%s)', async outcome => {
    const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    let url = `https://chatgpt.com/c/${chat}`;
    const actions: string[] = [];
    let consumed = false;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 1, url }),
      tabsSendMessage: async (_id, message) => {
        if (message.type === 'clf-recovery-reload-check') return { safe: outcome !== 'draft' };
        return { ok: true };
      },
      fetch: async (address, init) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (route === '/input/claim') {
          const body = JSON.parse(String(init?.body)); actions.push(body.recoveryAction);
          if (body.recoveryAction === 'stopped') {
            if (outcome === 'navigated') url = 'https://chatgpt.com/';
            const allowed = !consumed && outcome !== 'rejected'; consumed = true;
            return response(200, { ok: allowed });
          }
          return response(200, { ok: true });
        }
        return response(200, {});
      }
    });
    await worker.registerTab(1);
    const message = { type: 'desktop_input', id: 'ffffffff-1111-4222-8333-444444444444',
      owner: '1:document-1-0:0', conversationId: chat, recoveryAction: 'stopped' };
    await worker.send(message);
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(actions.includes('reloaded')).toBe(false);
    if (outcome === 'accepted') {
      await worker.send(message);
      expect(worker.tabsReload).not.toHaveBeenCalled();
    }
  });
});

/**
 * Exact chat recovery, from the browser's side.
 *
 * The app can prove one chat's tool calls stopped being attributable to it, and can name that
 * chat — but it cannot reach it. The page it would instruct is the page that stopped listening,
 * and opening the url would make a second tab of a chat that is still on screen, which is the
 * failure this whole path exists to avoid. The tab registry lives here, so the decision does
 * too: this worker asks on the maintenance alarm it already runs, and reloads the exact tab.
 */
describe('exact chat recovery from a fresh Chrome tab scan', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const OTHER = '11111111-2222-4333-8444-555555555555';

  /**
   * The app, as far as this worker can tell: it keeps handing the same repair out until a pass
   * reports having carried it out. That is the contract these tests are written against - a
   * pass that reports nothing must leave the repair outstanding.
   *
   * Each handout is minted with its own token, and only that token closes it, exactly as the
   * app does it. `asked` records what a receipt actually quoted, so a test can tell the
   * difference between a pass that reported the repair and one that reported something else.
   */
  function appWith(repair: string | null, browserOnly = false) {
    const asked: string[] = [];
    const actions: string[] = [];
    const failedActions: string[] = [];
    let outstanding = repair;
    let token = '';
    let minted = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') {
        const repaired = url.searchParams.get('repaired');
        const repairFailed = url.searchParams.get('repairFailed');
        if (repairFailed) {
          failedActions.push(url.searchParams.get('repairAction') || '');
          asked.push(repairFailed === token ? `failed:${outstanding}` : `stale-failure:${repairFailed}`);
          return response(200, { ok: true, repairs: [] });
        }
        if (repaired) actions.push(url.searchParams.get('repairAction') || '');
        asked.push(repaired ? (repaired === token ? `repaired:${outstanding}` : `stale:${repaired}`) : 'status');
        if (repaired && repaired === token) outstanding = null;
        if (!outstanding) return response(200, { ok: true, repairs: [] });
        token = `tok-${(minted += 1)}`;
        return response(200, { ok: true, browserOnly, repairs: [{ conversationId: outstanding, token }] });
      }
      return response(404, {});
    });
    return { fetch, asked, actions, failedActions, arm: (id: string) => { outstanding = id; } };
  }

  it('browser-only recovery waits for the missing chat and then reloads its exact existing tab', async () => {
    const { fetch, asked } = appWith(OTHER, true);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(41);
    await worker.send({ type: 'bind', conversationId: CHAT }, 41);
    await worker.fireAlarm(); await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(asked.every(item => item === 'status')).toBe(true);
    await worker.registerTab(42);
    await worker.send({ type: 'bind', conversationId: OTHER }, 42);
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledWith(42);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(asked).toContain(`repaired:${OTHER}`);
  });
  it('reloads the exact tab holding the chat the app named, and reports it once', async () => {
    const { fetch, asked, actions } = appWith(CHAT);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(21);
    await worker.send({ type: 'bind', conversationId: CHAT }, 21);
    await worker.registerTab(22);
    await worker.send({ type: 'bind', conversationId: OTHER }, 22);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(worker.tabsReload).toHaveBeenCalledWith(21);
    // Document registration also wakes maintenance immediately; the repair itself is once.
    expect(asked.filter((item) => item !== 'status')).toEqual([`repaired:${CHAT}`]);
    expect(asked[0]).toBe('status');
    expect(actions).toEqual(['reloaded']);

    // Reported, so the app has nothing outstanding and nothing here repeats it.
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
  });

  it.each(['unattributed', 'assistant-error', 'silence', 'no-tab', 'goal'].flatMap(reason =>
    ['unresolved', 'resolved-during-scan', 'claim-unavailable'].map(mode => ({ reason, mode }))))(
    'claims $reason recovery after the tab scan: $mode', async ({ reason, mode }) => {
      let armed = false;
      let handed = false;
      let resolved = false;
      const trace: string[] = [];
      const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/repairs/claim') {
          trace.push('claim');
          expect(init.method).toBe('POST');
          expect(JSON.parse(String(init.body))).toEqual({ token: 'attribution-attempt' });
          return mode === 'claim-unavailable' ? response(503, {}) : response(200, { allowed: !resolved });
        }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repaired')) trace.push('repaired');
          if (armed && !handed) {
            handed = true;
            trace.push('handout');
            return response(200, { repairs: [{ conversationId: CHAT, token: 'attribution-attempt', reason, requiresClaim: true }] });
          }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsGet: async () => ({ id: 21, url: `https://chatgpt.com/c/${CHAT}` }),
        tabsSendMessage: async (_id, message) => message.type === 'clf-repair-check'
          ? { safe: true, revision: 1, turnId: 'source', questionId: 'question' } : { ok: true },
        tabsQuery: async () => {
          if (handed) {
            trace.push('scan');
            if (mode === 'resolved-during-scan') resolved = true;
          }
          return [{ id: 21, url: `https://chatgpt.com/c/${CHAT}` }];
        } });
      await worker.registerTab(21);
      await worker.send({ type: 'bind', conversationId: CHAT }, 21);
      await worker.fireAlarm();
      armed = true;
      await worker.fireAlarm();
      expect(trace.indexOf('scan')).toBeGreaterThan(trace.indexOf('handout'));
      expect(trace.indexOf('claim')).toBeGreaterThan(trace.indexOf('scan'));
      if (mode === 'unresolved') {
        expect(worker.tabsReload).toHaveBeenCalledExactlyOnceWith(21);
        expect(trace).toContain('repaired');
      } else {
        expect(worker.tabsReload).not.toHaveBeenCalled();
        expect(trace).not.toContain('repaired');
      }
      expect(worker.tabsCreate).not.toHaveBeenCalled();
    }
  );

  /**
   * Two tabs of one chat used to end the repair: neither was reloaded and the duplicate stayed
   * open, so the chat was left broken *and* the tab spam was left standing. One chat is one tab,
   * so the ambiguity is resolved rather than deferred - the registry-bound copy is the one
   * reloaded, deterministically, and no third tab is ever created to settle it.
   */
  it.each(['stop-before-claim', 'work-after-claim', 'stop-after-claim', 'navigation-after-claim'] as const)(
    'vetoes the exact browser repair at its last page check: %s', async scenario => {
      let armed = false, handed = false, claimed = false, receipts = 0;
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/repairs/claim') { claimed = true; return response(200, { allowed: true }); }
        if (url.pathname === '/status') {
          if (url.searchParams.has('repaired')) receipts++;
          if (armed && !handed) { handed = true; return response(200, { repairs: [{ conversationId: CHAT,
            token: 'quiet-repair', reason: 'silence', requiresClaim: true }] }); }
          return response(200, { repairs: [] });
        }
        return response(200, {});
      });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsQuery: async () => [{ id: 21, url: `https://chatgpt.com/c/${CHAT}` }],
        tabsGet: async () => ({ id: 21, url: `https://chatgpt.com/c/${claimed && scenario === 'navigation-after-claim' ? OTHER : CHAT}` }),
        tabsSendMessage: async (_id, message) => {
          if (message.type !== 'clf-repair-check') return { ok: true };
          if (scenario === 'stop-before-claim') return { safe: false };
          if (message.expected) {
            expect(message.expected).toEqual({ revision: 1, turnId: 'source', questionId: 'question' });
            return { safe: scenario === 'navigation-after-claim', revision: 2, turnId: 'source', questionId: 'question' };
          }
          return { safe: true, revision: 1, turnId: 'source', questionId: 'question' };
        } });
      await worker.registerTab(21);
      await worker.send({ type: 'bind', conversationId: CHAT }, 21);
      await worker.fireAlarm(); armed = true; await worker.fireAlarm();
      expect(claimed).toBe(scenario !== 'stop-before-claim');
      expect(worker.tabsReload).not.toHaveBeenCalled();
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(receipts).toBe(0);
    });

  it('reloads the registry-bound copy when one chat has two tabs', async () => {
    const { fetch, asked } = appWith(CHAT);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(31);
    await worker.send({ type: 'bind', conversationId: CHAT }, 31);
    await worker.registerTab(32);
    await worker.send({ type: 'bind', conversationId: CHAT }, 32);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(worker.tabsReload).toHaveBeenCalledWith(31);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(asked).toContain(`repaired:${CHAT}`);

    // Reported, so nothing outstanding remains and the duplicate is never reloaded after it.
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
  });

  /** A reload that throws reports that attempt as failed, then the next pass retries it. */
  it('retries a repair whose reload failed', async () => {
    const { fetch, asked, failedActions, arm } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    await worker.fireAlarm();
    asked.length = 0;
    worker.tabsReload.mockRejectedValueOnce(new Error('tab is gone'));
    arm(CHAT);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['status', `failed:${CHAT}`]);
    expect(failedActions).toEqual(['reloaded']);

    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(['status', `failed:${CHAT}`, 'status', `repaired:${CHAT}`]);
  });

  /** A missing exact chat is opened once after the same fresh scan that prevents duplicates. */
  it('opens the exact chat when the scan proves this browser is not holding it', async () => {
    const { fetch, asked, actions } = appWith(OTHER);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(41);
    await worker.send({ type: 'bind', conversationId: CHAT }, 41);

    await worker.fireAlarm();
    expect(worker.tabsReload).not.toHaveBeenCalled();
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${OTHER}`, active: false });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(asked).toEqual(['status', `repaired:${OTHER}`]);
    expect(actions).toEqual(['reopened']);
  });

  /**
   * Automatic compaction selects its exact tab before reload while preserving
   * OS focus on the user's current app, even when Chrome is minimized.
   */
  it('selects the repair tab before reload without activating the Chrome window', async () => {
    let outstanding: string | null = CHAT;
    let token = '';
    let minted = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') {
        const repaired = url.searchParams.get('repaired');
        if (repaired && repaired === token) outstanding = outstanding === CHAT ? OTHER : null;
        if (!outstanding) return response(200, { ok: true, repairs: [] });
        token = `tok-${(minted += 1)}`;
        return response(200, { ok: true, repairs: [{ conversationId: outstanding, token, focus: true }] });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(51, { active: true });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsReload).toHaveBeenCalledWith(51);
    const raised = worker.tabsUpdate.mock.invocationCallOrder.find(
      (_order, index) => worker.tabsUpdate.mock.calls[index]?.[1]?.active === true
    );
    expect(raised).toBeLessThan(worker.tabsReload.mock.invocationCallOrder[0]!);

    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${OTHER}`, active: true });
  });

  it('opens an active agent chat in the same close transaction instead of losing its retry alarm', async () => {
    const asked: string[] = [];
    let repaired = false;
    let closed = false;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed' && init.method === 'POST') {
        closed = true;
        return response(200, { ok: true });
      }
      if (url.pathname === '/status') {
        const receipt = url.searchParams.get('repaired');
        asked.push(receipt ? `repaired:${receipt}` : 'status');
        if (receipt === 'close-repair') repaired = true;
        return response(200, {
          ok: true,
          recoveryMonitoring: closed && !repaired,
          repairs: !closed || repaired ? [] : [{ conversationId: CHAT, token: 'close-repair' }]
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(71);
    await worker.send({ type: 'bind', conversationId: CHAT }, 71);

    await worker.closeTab(71);
    for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${CHAT}`, active: false });
    expect(asked.filter((item) => item !== 'status')).toEqual(['repaired:close-repair']);
    expect(asked[0]).toBe('status');
    expect(worker.alarmClear).not.toHaveBeenCalled();
  });

  /**
   * The alarm is the only thing that wakes a stopped service worker, and a dead reporter is
   * precisely the case where no page will wake it. So holding a chat is itself a reason to
   * keep the alarm running - without that, the repair waits for traffic that never comes.
   */
  /**
   * Paired is reason enough to ask. The app hands out reopen work only when this worker asks,
   * and after a browser restart the worker holds no tabs — which is exactly when a Loop chat
   * the user closed is waiting to be opened again (2026-09-02: a Loop prime never came back
   * because the worker, holding nothing, never asked).
   */
  it('keeps its maintenance alarm running and asks the app on every pass while it is paired, tabs or none', async () => {
    const { fetch, asked } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.fireAlarm();
    expect(asked).toEqual(['status']);
    expect(worker.alarmCreate).toHaveBeenCalledWith('clf-bridge-drain', { delayInMinutes: 0.5 });

    await worker.registerTab(51);
    await worker.send({ type: 'bind', conversationId: CHAT }, 51);
    await worker.fireAlarm();
    // Fresh content readiness wakes a pass without waiting for the maintenance alarm.
    expect(asked).toEqual(['status', 'status', 'status']);
  });

  it('asks nobody while it is not paired', async () => {
    const { fetch, asked } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea({}), session: new FakeStorageArea(), fetch });
    await worker.fireAlarm();
    expect(asked).toEqual([]);
  });

  /**
   * How long a repair can sit in the app before this browser sees it.
   *
   * The app arms a repair fifteen to sixty seconds into an unattributed incident. A collector
   * that came round once a minute would make that deadline meaningless: an alarm created at
   * T+0 with `periodInMinutes: 1` ticks at T+15, too early for the app to have decided, and
   * then not again until T+75.
   *
   * Every pass re-arms the next one at Chrome's floor instead. Thirty seconds is that floor -
   * alarms fire at most twice a minute, and a packed extension has anything shorter clamped up
   * to it whatever this asks for - so the honest guarantee is that a repair armed at T+20 is
   * collected by T+50 at the latest, not that it is collected at T+20. One alarm, one owner,
   * one cadence, and it still stops dead when there is nothing left to hold.
   */
  it('comes round at Chrome’s alarm floor while it holds a chat, so a repair waits at most one pass', async () => {
    const { fetch, asked, arm } = appWith(null);
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(61);
    await worker.send({ type: 'bind', conversationId: CHAT }, 61);

    const armings = () => worker.alarmCreate.mock.calls.filter((call) => call[0] === 'clf-bridge-drain');
    expect(armings()).toHaveLength(1);

    // Every pass leaves the next one armed, and never asks for a delay Chrome would clamp -
    // asking for less is not an error, it is a number that quietly means something else in a
    // packed extension than it does in the unpacked copy a developer is looking at.
    for (let pass = 1; pass <= 3; pass++) {
      await worker.fireAlarm();
      expect(armings()).toHaveLength(pass + 1);
      expect(armings().at(-1)![1]).toEqual({ delayInMinutes: 0.5 });
      expect(armings().at(-1)![1].delayInMinutes).toBeGreaterThanOrEqual(0.5);
    }

    // A repair armed by the app between two passes is carried out on the very next one.
    arm(CHAT);
    await worker.fireAlarm();
    expect(worker.tabsReload).toHaveBeenCalledWith(61);
    expect(asked.slice(-2)).toEqual(['status', `repaired:${CHAT}`]);

    // The cadence outlives the tab: a paired worker with nothing open is the one that has to
    // open the chat the app is owed.
    await worker.closeTab(61);
    expect(worker.alarmClear).not.toHaveBeenCalledWith('clf-bridge-drain');
  });
});

describe('active agent tab discard protection', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('protects the exact live chat and restores only the tab policy it changed', async () => {
    let live = true;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: live,
          nonDiscardableConversations: live ? [CHAT] : []
        });
      }
      return response(404, {});
    });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea(paired), session, fetch });
    await worker.registerTab(81);
    await worker.send({ type: 'bind', conversationId: CHAT }, 81);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).toHaveBeenCalledWith(81, { autoDiscardable: false });
    expect(session.data.discardProtectedTabs).toEqual({ '81': true });

    live = false;
    const restarted = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch,
      tabsQuery: async () => [
        { id: 81, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, autoDiscardable: false }
      ]
    });
    await restarted.fireAlarm();
    expect(restarted.tabsUpdate).toHaveBeenLastCalledWith(81, { autoDiscardable: true });
    expect(session.data.discardProtectedTabs).toEqual({});
  });

  it('closes finished managed chats including an idle selected tab', async () => {
    const OLD_WORKER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const COMPACTED = 'cccccccc-dddd-4eee-8fff-000000000000';
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: true,
          nonDiscardableConversations: [CHAT],
          managedConversations: [CHAT, OLD_WORKER, COMPACTED],
          retiredConversations: [COMPACTED],
          tabsToKeepOpen: 1,
          closableConversations: [OLD_WORKER, COMPACTED]
        });
      }
      return response(404, {});
    });
    const tabs = [
      { id: 91, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` },
      { id: 92, windowId: 7, url: `https://chatgpt.com/c/${OLD_WORKER}` },
      { id: 93, windowId: 7, url: `https://chatgpt.com/c/${COMPACTED}`, active: true },
      { id: 94, windowId: 8, url: `https://chatgpt.com/c/${COMPACTED}` }
    ];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ tabDocuments: Object.fromEntries(tabs.map(tab => [tab.id, `doc-${tab.id}`])), tabEpochs: Object.fromEntries(tabs.map(tab => [tab.id, 0])) }),
      fetch,
      tabsQuery: async () => tabs,
      tabsGet: async id => tabs.find(tab => tab.id === id)!,
      tabsSendMessage: async id => ({ safe: true, navigationEpoch: 0, conversationId: tabs.find(tab => tab.id === id)!.url.split('/c/')[1] })
    });

    await worker.fireAlarm();
    expect(worker.tabsRemove.mock.calls.map((call) => call[0]).sort()).toEqual([92, 93, 94]);
    // The live prime chat is still protected, never closed.
    expect(worker.tabsUpdate).toHaveBeenCalledWith(91, { autoDiscardable: false });
  });

  it('does not claim or restore a tab Chrome was already told not to discard', async () => {
    let live = true;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/status') {
        return response(200, {
          ok: true,
          repairs: [],
          recoveryMonitoring: live,
          nonDiscardableConversations: live ? [CHAT] : []
        });
      }
      return response(404, {});
    });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea(paired), session, fetch });
    await worker.createTab({ id: 82, url: `https://chatgpt.com/c/${CHAT}`, autoDiscardable: false });
    await worker.registerTab(82);
    await worker.send({ type: 'bind', conversationId: CHAT }, 82);

    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.discardProtectedTabs).toEqual({});

    live = false;
    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
  });

  it('reports discarded and frozen shells separately from genuinely open conversations', async () => {
    const DISCARDED = 'bbbbbbbb-cccc-4ddd-8eee-111111111111';
    const FROZEN = 'cccccccc-dddd-4eee-8fff-222222222222';
    const posted: Array<{ openConversations?: string[]; stalledConversations?: string[] }> = [];
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: vi.fn(async (input: string, init?: Record<string, unknown>) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/status') {
          posted.push(JSON.parse(String(init?.body || '{}')));
          return response(200, { ok: true, repairs: [] });
        }
        return response(404, {});
      }),
      tabsQuery: async () => [
        { id: 1, windowId: 7, url: `https://chatgpt.com/c/${DISCARDED}`, discarded: true },
        { id: 2, windowId: 7, url: `https://chatgpt.com/c/${FROZEN}`, frozen: true },
        { id: 3, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' }
      ]
    });

    await worker.fireAlarm();

    // The shells keep their URLs and stay inside openConversations — the app decides what a
    // dead page means — while stalledConversations names the ones that cannot record or receive.
    expect(posted.at(-1)?.openConversations).toEqual([DISCARDED, FROZEN, CHAT]);
    expect(posted.at(-1)?.stalledConversations).toEqual([DISCARDED, FROZEN]);
  });

  it('protects a newly created input tab until its conversation binds', async () => {
    const inputId = 'ffffffff-1111-4222-8333-444444444444';
    const session = new FakeStorageArea();
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session,
      fetch: vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/status') {
          return response(200, { ok: true, repairs: [], inputs: [{ id: inputId }], inputOpeningIds: [inputId] });
        }
        return response(404, {});
      })
    });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(99, { autoDiscardable: false });
    expect(session.data.discardProtectedTabs).toEqual({ '99': true });

    // The cos-input marker holds the protection across later passes; release belongs to the
    // app's policy set once a real conversation binds, not to a sweep that cannot see one yet.
    await worker.fireAlarm();
    expect(worker.tabsUpdate).not.toHaveBeenCalledWith(99, { autoDiscardable: true });
    expect(session.data.discardProtectedTabs).toEqual({ '99': true });
  });
});

describe('app-owned retained tab pool', () => {
  const id = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
  async function budget(options: { safe?: (tab: number) => boolean; changed?: number; keep?: number; recent?: number; protectDuplicate?: boolean; reverseActivity?: boolean; retired?: boolean; idle?: boolean; ordinary?: number; pinned?: number } = {}) {
    const tabs = [1, 2, 3, 4, 5, 6].map(n => ({ id: n, windowId: n === 5 ? 9 : 7, url: `https://chatgpt.com/c/${id(n === 4 ? 3 : n)}`, active: n === 5, pinned: n === options.pinned, lastAccessed: n === options.recent ? Date.now() : 0 }));
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea({ tabDocuments: Object.fromEntries(tabs.map(tab => [tab.id, `doc-${tab.id}`])), tabEpochs: Object.fromEntries(tabs.map(tab => [tab.id, 0])) }),
      fetch: async input => response(200, new URL(input).pathname === '/hello' ? { app: APP_SLUG, paired: true } : {
        ok: true, repairs: [], tabsToKeepOpen: options.keep ?? 2, retiredConversations: options.retired ? [id(2), id(5)] : [],
        workerConversations: [1, 2, 3, 5].filter(n => n !== options.ordinary).map(id), sleepingWorkerConversations: [2, 3, 5].map(id),
        conversationActivityAt: Object.fromEntries([1, 2, 3, 5].map(n => [id(n), (options.reverseActivity ? 10 - n : n) * 1000])),
        managedConversations: [1, 2, 3, 5].map(id), nonDiscardableConversations: [id(1), ...(options.protectDuplicate ? [id(3)] : [])], closableConversations: options.idle ? [2, 3, 5].map(id) : []
      }),
      tabsQuery: async () => tabs,
      windowsGet: async () => ({ focused: true }),
      tabsGet: async n => ({ ...tabs.find(tab => tab.id === n)!, ...(n === options.changed ? { url: `https://chatgpt.com/c/${id(99)}` } : {}) }),
      tabsSendMessage: async n => ({ safe: options.safe?.(n) ?? true, navigationEpoch: 0, conversationId: tabs.find(tab => tab.id === n)!.url.split('/c/')[1] })
    });
    await worker.fireAlarm();
    return worker;
  }
  it('retains sleeping chats regardless of broker capacity and removes only an exact idle duplicate', async () => {
    const worker = await budget();
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(1); // live app work
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(6); // unrelated manual chat
  });
  it('preserves a user-pinned duplicate while still retiring an unpinned terminal worker', async () => {
    const worker = await budget({ pinned: 4, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([2, 5]);
  });
  it('retires explicitly terminal workers while preserving drafts and live work', async () => {
    const worker = await budget({ keep: 20, retired: true, safe: n => n !== 5 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 2]);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(5);
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(1);
  });
  it('keeps idle conversations below the pool limit while removing an idle duplicate', async () => {
    const worker = await budget({ keep: 20 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('keeps waiting prime and helper tabs as well as reusable worker tabs', async () => {
    const worker = await budget({ ordinary: 1 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('releases idle pages independently of worker capacity while keeping the selected page', async () => {
    const worker = await budget({ keep: 20, idle: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 2, 3]);
  });
  it('does not use tab selection as model activity', async () => {
    const worker = await budget({ recent: 5 });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4]);
  });
  it('never removes copies of a protected active conversation', async () => {
    const worker = await budget({ protectDuplicate: true, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0]).sort()).toEqual([2, 5]);
  });
  it('orders terminal retirement by work time without evicting other waiting chats', async () => {
    const worker = await budget({ reverseActivity: true, recent: 5, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([4, 5, 2]);
  });
  it('retains drafts/unreadable pages and refuses a navigated candidate', async () => {
    const worker = await budget({ safe: n => n !== 3 && n !== 4, changed: 5, retired: true });
    expect(worker.tabsRemove.mock.calls.map(call => call[0])).toEqual([2]);
  });
});

describe('worker settings authority', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('authorizes Stop through the real runtime dispatcher and rejects a retired document', async () => {
    const posted: string[] = [];
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 42, url: `https://chatgpt.com/c/${CHAT}` }),
      fetch: async input => {
        const route = new URL(input).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        posted.push(route);
        return response(200, { ok: true, command: { type: 'stop', conversationId: CHAT, turnId: 'live-turn' } });
      }
    });
    await worker.registerTab(42);
    const command = { id: '1111111111111111', client: 'page-owner', conversationId: CHAT, turnId: 'live-turn' };
    expect(await worker.send({ type: 'stop_redeem', ...command }, 42)).toMatchObject({ ok: true, command: { type: 'stop' } });
    expect(await worker.send({ type: 'stop_ack', status: 'sent', ...command }, 42)).toMatchObject({ ok: true });
    expect(posted).toContain('/commands/redeem');
    await worker.registerTab(42, 'replacement-document');
    const before = posted.filter(route => route === '/commands/redeem').length;
    expect(await worker.send({ type: 'stop_redeem', ...command }, 42, 'document-42-0')).toMatchObject({ ok: false, error: 'stale_document' });
    expect(posted.filter(route => route === '/commands/redeem')).toHaveLength(before);
  });

  it('forwards auto-compaction writes with the source tab conversation so the app can reject worker authority', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/settings' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(409, { error: 'worker_compaction_disabled' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(42);
    await worker.send({ type: 'bind', conversationId: CHAT }, 42);

    const reply = await worker.send({ type: 'settings_set', conversationId: CHAT, autoCompact: false }, 42);
    expect(reply).toMatchObject({ ok: false, status: 409, data: { error: 'worker_compaction_disabled' } });
    expect(posted).toEqual([{ autoCompact: false, conversationId: CHAT }]);
  });

  it('forwards compaction ticket, safe source loss, and both irreversible dispatch checkpoints', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: `https://chatgpt.com/c/${CHAT}` }) });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);
    const token = '0123456789abcdef0123456789abcdef';

    await worker.send({ type: 'compact', conversationId: CHAT, ticket: true, automatic: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceLost: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceDispatch: true }, 44);
    await worker.send({ type: 'compact', conversationId: CHAT, token, destinationDispatch: true }, 44);

    expect(posted).toEqual([
      expect.objectContaining({ conversationId: CHAT, ticket: true, automatic: true }),
      expect.objectContaining({ conversationId: CHAT, token, sourceLost: true }),
      expect.objectContaining({ conversationId: CHAT, token, sourceDispatch: true }),
      expect.objectContaining({ conversationId: CHAT, token, destinationDispatch: true })
    ]);
  });

  it('carries destinationLost, and still refuses anything not on the checkpoint list', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: `https://chatgpt.com/c/${CHAT}` }) });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);
    const token = '0123456789abcdef0123456789abcdef';

    // The page sends this and the app acts on it — it retires the lease and re-offers the brief
    // to a fresh chat at once instead of waiting the lease out. The relay used to drop it.
    await worker.send({ type: 'compact', conversationId: CHAT, token, destinationLost: true }, 44);
    // A field nobody named must not ride along on a valid token.
    await worker.send({ type: 'compact', conversationId: CHAT, token, sourceLost: true, invented: true }, 44);
    // And a checkpoint without its token says nothing about any transaction.
    await worker.send({ type: 'compact', conversationId: CHAT, destinationLost: true }, 44);

    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({ conversationId: CHAT, token, destinationLost: true });
    expect(posted[1]).toMatchObject({ conversationId: CHAT, token, sourceLost: true });
    expect(posted[1]).not.toHaveProperty('invented');
    expect(posted[2]).not.toHaveProperty('destinationLost');
    expect(posted[2]).not.toHaveProperty('token');
  });

  it.each(['new-chat', 'other-chat', 'pending-navigation'])('checks the current Chrome route for compaction after %s', async scenario => {
    const currentUrl = scenario === 'other-chat' ? 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      : `https://chatgpt.com/g/g-p-abcdef1234567890abcdef1234567890/c/${CHAT}`;
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname === '/compact') posted.push(JSON.parse(String(init.body)));
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 44, url: currentUrl, ...(scenario === 'pending-navigation' ? { pendingUrl: 'https://chatgpt.com/' } : {}) }) });
    await worker.registerTab(44);
    const reply = await worker.send({ type: 'compact', conversationId: CHAT, ticket: true }, 44, undefined, 'https://chatgpt.com/');
    if (scenario === 'new-chat') {
      expect(reply).toMatchObject({ ok: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ conversationId: CHAT, project: expect.any(String) });
    } else {
      expect(reply).toMatchObject({ ok: false, error: 'stale_document' });
      expect(posted).toEqual([]);
    }
  });

  /**
   * Which Chrome instance the replacement chat is created in.
   *
   * The user had two Chrome instances open. A chat finished in the background one, Compact &
   * Resume captured its summary, and the app asked the operating system to open chat B — which
   * resolved to the foreground instance, because that is what `chrome.exe <url>` does. The
   * summary was typed into a chat in a browser this extension was not loaded in, nothing ever
   * redeemed the command, and the handoff was left connected to nothing.
   *
   * No argument names a window and no extension can report which instance it is, so the app
   * cannot decide this from outside. It answers the capture request with the successor instead,
   * and the browser that holds chat A creates the tab in chat A's own window.
   */
  it('opens the replacement chat in the window of the chat it continues', async () => {
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        return response(200, { stored: true, commandId: 'cmd-handoff', placement: { id: 'cmd-handoff' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch,
      // Chat A's tab, in the background instance's window, third from the left.
      tabsGet: async () => ({ id: 45, windowId: 9, index: 2, url: `https://chatgpt.com/c/${CHAT}` }) as never
    });
    await worker.registerTab(45);
    await worker.send({ type: 'bind', conversationId: CHAT }, 45);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      45
    );

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    const created = worker.tabsCreate.mock.calls[0]![0] as Record<string, unknown>;
    // The window is the whole point. The marker is the app's command id and nothing else —
    // redeeming it still requires the pairing token this worker holds.
    expect(created.windowId).toBe(9);
    expect(created.index).toBe(3);
    expect(String(created.url)).toBe('https://chatgpt.com/?clf=cmd-handoff#clf=cmd-handoff');
    // Active in its own window, and its own window only: nothing here focuses that window, so
    // a handoff in the background instance does not yank the user out of the one they are in.
    expect(created.active).toBe(true);
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  it('leaves a compaction reply that places nothing to the app’s own opener', async () => {
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        // What an automatic pickup or a restart-restored resume answers with: there is no page
        // in flight to hand the successor to, so the app opened it the way it always did.
        return response(200, { stored: true, commandId: 'cmd-auto', placement: null });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch,
      tabsGet: async () => ({ id: 46, windowId: 9, index: 0, url: `https://chatgpt.com/c/${CHAT}` }) as never
    });
    await worker.registerTab(46);
    await worker.send({ type: 'bind', conversationId: CHAT }, 46);

    await worker.send(
      { type: 'compact', conversationId: CHAT, token: '0123456789abcdef0123456789abcdef', summary: 'the brief' },
      46
    );

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a settings write that names a different conversation than the source tab owns', async () => {
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(43);
    await worker.send({ type: 'bind', conversationId: CHAT }, 43);
    const other = '11111111-2222-4333-8444-555555555555';

    expect(await worker.send({ type: 'settings_set', conversationId: other, autoCompact: true }, 43)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/settings')).toBe(false);
  });

  /**
   * The half of this route that no test covered: the replacement chat's own checkpoints.
   *
   * Every case above sends `conversationId` alongside the token, because every one of them is
   * the *source* chat — a conversation that exists. The destination is the opposite by
   * construction: content.js asks for its permit from a page opened at `/?clf=<id>`, before
   * ChatGPT has assigned anything, so it sends a token and a flag and no conversation id at
   * all. Nothing here ever exercised that shape, and it is the shape the whole handoff depends
   * on: refuse it and the page clears its composer and stops, with no ack and no log line
   * anywhere — which is exactly what a stuck handoff looks like from the outside.
   */
  /**
   * The replacement chat asks for its permit while ChatGPT is still loading.
   *
   * Measured in the browser on 2026-09-10: the tab redeemed at 04:39:55.218 and got the whole
   * 48,975-character brief, then asked for `destinationAttempt` at 04:39:58.262 — three seconds
   * into a freshly opened ChatGPT, which is still `loading`. The worker refused it as a stale
   * document without ever calling the app, content.js read that as a denied permit, cleared the
   * composer and returned without an ack. The app then waited out its whole deadline and gave up
   * with "the chat this app opened did not report back in time", and nothing anywhere said why.
   *
   * The loading/pendingUrl guard is for a tab navigating *away* from what the message names. A
   * checkpoint that names no conversation, from a document the worker still owns, is the
   * opposite case: there is nothing to navigate away from yet.
   */
  it.each(['loading', 'pending'])('forwards a replacement chat permit while the tab is still %s', async state => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { allowed: true });
      }
      return response(404, {});
    });
    const tab = state === 'loading'
      ? { id: 47, url: 'https://chatgpt.com/?clf=cmd-successor', status: 'loading' }
      : { id: 47, url: 'https://chatgpt.com/?clf=cmd-successor', pendingUrl: 'https://chatgpt.com/?clf=cmd-successor' };
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => tab });
    await worker.registerTab(47);
    const token = '0123456789abcdef0123456789abcdef';

    const commandId = 'cmd-successor', client = 'run-successor-document';
    const reply = await worker.send({ type: 'compact', token, commandId, client, destinationAttempt: true }, 47);

    expect(reply).not.toMatchObject({ error: 'stale_document' });
    expect(posted).toEqual([expect.objectContaining({ token, commandId, client, destinationAttempt: true })]);
  });

  it('forwards the destination checkpoints a replacement chat sends, which name no conversation', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/compact' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { allowed: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => ({ id: 46, url: 'https://chatgpt.com/?clf=cmd-successor' }) });
    await worker.registerTab(46);
    const token = '0123456789abcdef0123456789abcdef';

    const commandId = 'cmd-successor', client = 'run-successor-document';
    await worker.send({ type: 'compact', token, commandId, client, destinationAttempt: true }, 46);
    await worker.send({ type: 'compact', token, commandId, client, destinationDispatch: true }, 46);
    await worker.send({ type: 'compact', token, commandId, client, destinationLost: true }, 46);

    expect(posted).toEqual([
      expect.objectContaining({ token, commandId, client, destinationAttempt: true }),
      expect.objectContaining({ token, commandId, client, destinationDispatch: true }),
      expect.objectContaining({ token, commandId, client, destinationLost: true })
    ]);
  });

  it.each(['conversation', 'pending-conversation', 'pending-foreign'])('refuses a replacement permit on a %s route', async state => {
    const fetch = vi.fn(async (input: string) => new URL(input).pathname === '/hello'
      ? response(200, { app: APP_SLUG, paired: true }) : response(200, { allowed: true }));
    const home = 'https://chatgpt.com/?clf=cmd-successor';
    const chat = `https://chatgpt.com/c/${CHAT}`;
    const tab = { id: 48, url: state === 'conversation' ? chat : home,
      ...(state === 'pending-conversation' ? { pendingUrl: chat } : {}),
      ...(state === 'pending-foreign' ? { pendingUrl: 'https://example.com/' } : {}) };
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
      tabsGet: async () => tab });
    await worker.registerTab(48);
    expect(await worker.send({ type: 'compact', token: '0123456789abcdef0123456789abcdef',
      commandId: 'cmd-successor', client: 'run-successor-document', destinationAttempt: true }, 48))
      .toMatchObject({ ok: false, error: 'stale_document' });
    expect(fetch.mock.calls.some(([input]) => new URL(input).pathname === '/compact')).toBe(false);
  });


  /**
   * The mode a goal was written in, which the app turns into a durable per-chat switch.
   *
   * Both halves matter. It has to cross — a goal written with "add specific loop" that arrives
   * without its mode is answered by the standing switch, which is how an unattended run meant
   * to be endless stopped at its second turn. And only these two words may cross, because what
   * arrives here is written to disk and then decides whether a run is allowed to end at all.
   */
  it('passes the goal mode through, and only ever the two words that are modes', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/goal/objective') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(200, { objective: 'build the sandbox', enabled: true, mode: 'loop' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(44);
    await worker.send({ type: 'bind', conversationId: CHAT }, 44);

    const looped = await worker.send(
      { type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox', mode: 'loop' },
      44
    );
    expect(looped).toMatchObject({ ok: true, data: { enabled: true, mode: 'loop' } });
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox', mode: 'loop' });

    // Anything else is absent rather than forwarded, which leaves the standing switch deciding
    // exactly as it did before the two buttons existed — a state the app already handles.
    await worker.send({ type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox', mode: 'endless' }, 44);
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox' });

    await worker.send({ type: 'goal_objective', conversationId: CHAT, text: 'build the sandbox' }, 44);
    expect(posted.at(-1)).toEqual({ conversationId: CHAT, text: 'build the sandbox' });
  });
});

// ------------------------------------------------------------ command delivery

/**
 * The half of delivery that lives in the browser.
 *
 * The app opens the marked chat itself, so what is tested here is what the extension
 * does with a marker once a page has it, and the recovery path for commands the app
 * could not open — which is the only thing that runs while no ChatGPT page exists.
 */
describe('extension command delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };

  it('redeems only the command id the page was opened for', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/redeem') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.id !== 'cmd-1') return response(404, { error: 'gone' });
        return response(200, { command: { id: 'cmd-1', kind: 'open-chat', text: 'do the thing', agent: null } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const mine = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(mine).toMatchObject({ ok: true, command: { id: 'cmd-1', text: 'do the thing' } });

    // A marker for a command that has been cancelled, superseded or already sent gets
    // nothing, so a stale URL in history types nothing into a chat.
    const stale = await worker.send({ type: 'redeem', id: 'cmd-gone', client: 'page-1' });
    expect(stale).toMatchObject({ ok: true, command: null, gone: true });
    // The page identifies itself, because a command belongs to one page: a second tab on
    // the same marker is a different claimant and the app refuses it.
    expect(bodies).toEqual([
      { id: 'cmd-1', client: 'page-1' },
      { id: 'cmd-gone', client: 'page-1' }
    ]);
  });

  it('never redeems a command this browser already delivered', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({ settled: ['cmd-done'] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      return response(200, { command: { id: 'cmd-done', text: 'again?' } });
    });
    const worker = loadWorker({ local, session, fetch });

    expect(await worker.send({ type: 'redeem', id: 'cmd-done' })).toMatchObject({ ok: true, command: null });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/commands/redeem'))).toBe(false);
  });

  /**
   * The extension does not go looking for work, and cannot open a chat of its own accord.
   *
   * This replaces the whole recovery-alarm path. A command used to be a thing the browser
   * fetched: a half-minute `chrome.alarms` tick pulled `GET /commands`, opened a marked tab
   * per unopened command, and persisted an `opened` list so a restarted service worker would
   * not open a second chat for the same job. Every part of that could act on a run the app
   * had already finished with, and every part of it was a clock. The app opens the chat now,
   * in the same transaction that creates the command, so the extension has nothing to poll
   * and nothing to remember. The only alarm now is a delivery retry for observations and
   * close notices already accepted into durable session storage; it never discovers work
   * and never opens a tab.
   */
  it('opens no tabs and holds no alarm of its own', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // Starting up is not a reason to open anything, and neither is asking how things are.
    await worker.send({ type: 'status' });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.opened).toBeUndefined();

    // There is no listing route left to ask, so nothing here ever asks for one.
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
    expect(backgroundSource).toContain("const RETRY_ALARM = 'clf-bridge-drain'");
    expect(backgroundSource).not.toContain("call('/commands'");
  });

  it('re-injects the recorder into already-open ChatGPT tabs after an extension reload', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }, { id: 42 }]);

    await worker.installed('update');

    expect(worker.tabsQuery).toHaveBeenCalledWith({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 41 }, files: ['content.js'] }],
      [{ target: { tabId: 42 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 42 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 42 }, files: ['content.js'] }]
    ]);
    expect(worker.scriptingInsertCSS.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['overlay.css'] }],
      [{ target: { tabId: 42 }, files: ['overlay.css'] }]
    ]);
  });

  it.each(['healthy', 'missing', 'loading', 'discarded', 'frozen', 'navigated'] as const)(
    'repairs missing recorders through maintenance without opening or reloading (%s)', async scenario => {
      const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/status') return response(200, { ok: true, repairs: [], commandIds: [] });
        return response(404, {});
      });
      const tab = { id: 41, url: `https://chatgpt.com/c/${chat}`,
        ...(scenario === 'loading' ? { status: 'loading' } : {}),
        ...(scenario === 'discarded' ? { discarded: true } : {}),
        ...(scenario === 'frozen' ? { frozen: true } : {}) };
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch,
        tabsQuery: async () => [tab],
        tabsGet: async () => scenario === 'navigated' ? { id: 41, url: 'https://example.com/' } : tab });
      if (scenario === 'healthy') worker.tabsSendMessage.mockResolvedValue({ ok: true, recorderVersion: 13 });
      // Startup restoration is a separate path; exercise the later maintenance pass.
      await worker.installed('update');
      worker.scriptingExecuteScript.mockClear();
      worker.scriptingInsertCSS.mockClear();
      await worker.fireAlarm();
      if (scenario === 'healthy' || scenario === 'missing') {
        await vi.waitFor(() => expect(worker.scriptingExecuteScript).toHaveBeenCalledWith({
          target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js']
        }));
        if (scenario === 'missing') await vi.waitFor(() => expect(worker.scriptingInsertCSS).toHaveBeenCalled());
      } else expect(worker.scriptingExecuteScript).not.toHaveBeenCalled();
      const calls = worker.scriptingExecuteScript.mock.calls.length;
      await worker.fireAlarm();
      expect(worker.scriptingExecuteScript).toHaveBeenCalledTimes(calls);
      expect(worker.tabsCreate).not.toHaveBeenCalled();
      expect(worker.tabsReload).not.toHaveBeenCalled();
    });

  it.each(['live', 'retired', 'expired', 'foreign-chat', 'unknown-policy'] as const)(
    'keeps command tab custody through conversation promotion and MV3 restoration (%s)', async scenario => {
      const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      let commandIds: string[] | undefined = scenario === 'unknown-policy' ? undefined : ['cmd-handoff'];
      const fetch = vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (url.pathname === '/status') return response(200, { ok: true, repairs: [], commandIds });
        return response(404, {});
      });
      const session = new FakeStorageArea({ discardProtectedTabs: { '71': {
        commandId: 'cmd-handoff', at: Date.now() - (scenario === 'expired' ? 31 * 60_000 : 0),
        conversationId: scenario === 'foreign-chat' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : null
      } } });
      const worker = loadWorker({ local: new FakeStorageArea(paired), session, fetch });
      await worker.createTab({ id: 71, url: `https://chatgpt.com/c/${CHAT}`, autoDiscardable: false });
      if (scenario === 'retired') commandIds = [];
      await worker.fireAlarm();
      const releases = () => worker.tabsUpdate.mock.calls.filter(call =>
        (call[1] as { autoDiscardable?: boolean })?.autoDiscardable === true);
      expect(releases()).toHaveLength(scenario === 'live' ? 0 : 1);
      if (scenario === 'live') {
        expect(session.data.discardProtectedTabs).toMatchObject({ '71': { commandId: 'cmd-handoff', conversationId: CHAT } });
        commandIds = [];
        await worker.fireAlarm();
        expect(releases()).toEqual([[71, { autoDiscardable: true }]]);
      }
    });

  it('keeps a live recorder but revalidates the idempotent MAIN-world Fiber helper', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: 13 });

    await worker.installed('update');

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(41, { type: 'clf-recorder-ping' }, undefined);
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }]
    ]);
    expect(worker.scriptingInsertCSS).not.toHaveBeenCalled();
  });

  it('repairs a missing MAIN-world Fiber helper on demand for the sending tab only', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    const repaired = await worker.send({ type: 'repair_fiber' }, 73);

    expect(repaired).toMatchObject({ ok: true });
    expect(worker.scriptingExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 73, documentIds: ['document-73-0'] },
      world: 'MAIN',
      files: ['fiber.js']
    });

    await worker.navigateTab(73, 'https://example.com/left');
    expect(await worker.send({ type: 'repair_fiber' }, 73)).toMatchObject({ ok: false, error: 'tab_closed' });
  });

  it('has no way to ask the app for work at all', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The old poll message, from a stale content script that was never reloaded. It is not
    // a route any more, so it is answered as the unknown message it is rather than
    // reopening a path the app has stopped serving.
    const reply = await worker.send({ type: 'poll' });
    expect(reply?.ok).not.toBe(true);
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
  });

  it('provisions itself silently on the first call and retries with the new token', async () => {
    const local = new FakeStorageArea({ port: 8765 });
    const session = new FakeStorageArea();
    const seen: Array<{ path: string; auth: unknown }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ path: url.pathname, auth: headers.authorization });
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: false });
      if (url.pathname === '/pair') return response(200, { token: 'fresh-token' });
      if (url.pathname === '/commands/redeem') return response(200, { command: null });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ connected: true, paired: true });
    expect(seen.some((call) => call.path === '/pair')).toBe(true);
    expect(local.data.token).toBe('fresh-token');

    await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(seen.find((call) => call.path === '/commands/redeem')?.auth).toBe('Bearer fresh-token');
    // Nothing anywhere asked for a code.
    expect(fetch.mock.calls.some(([, init]) => String((init as any)?.body ?? '').includes('code'))).toBe(false);
  });

  it('re-provisions once when the app no longer recognises the stored token', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'stale-token' });
    const session = new FakeStorageArea();
    const tokens: Array<unknown> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/pair') return response(200, { token: 'second-token' });
      if (url.pathname === '/commands/redeem') {
        tokens.push(headers.authorization);
        return headers.authorization === 'Bearer second-token'
          ? response(200, { command: null })
          : response(401, { error: 'unauthorised' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const result = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(result.ok).toBe(true);
    expect(tokens).toEqual(['Bearer stale-token', 'Bearer second-token']);
    expect(local.data.token).toBe('second-token');
  });
});

/**
 * Waking a worker happens in the chat that worker already has.
 *
 * The app cannot reach into the browser, so it opens `/c/<id>?clf=<command>` and lets the
 * page redeem the marker. That is right when the chat is closed and wrong when it is not:
 * ChatGPT is a single-page app, and a second tab on the same conversation is exactly the
 * duplicate this whole feature exists to avoid. The service worker sees the tab being
 * created, notices the conversation is already open somewhere, and hands the job over to
 * that document instead.
 */
describe('extension revival delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const PRIME = '11111111-2222-4333-8444-555555555555';
  const revival = { id: 'cmd-wake', conversationId: CHAT };

  const app = (route: 'status' | 'activity' = 'status') =>
    vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === `/${route}`) {
        return response(200, { ok: true, recoveryMonitoring: true, repairs: [], revival });
      }
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}'));
        return response(200, { pending: body.entries.map((entry: { id: string }) => entry.id) });
      }
      return response(404, {});
    });

  const liveRecorder = async (_tabId: number, message: Record<string, unknown>) =>
    message.type === 'clf-recorder-ping'
      ? { ok: true, recorderVersion: 13 }
      : { ok: true, claimed: true };

  it('scans before opening and routes to the oldest exact worker tab', async () => {
    const local = new FakeStorageArea(paired);
    const worker = loadWorker({
      local,
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 9, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' },
        { id: 4, windowId: 7, url: `https://chat.openai.com/c/${CHAT}`, status: 'complete' }
      ],
      tabsSendMessage: liveRecorder
    });

    await worker.fireAlarm();

    await vi.waitFor(() =>
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
        type: 'clf-run-command',
        id: revival.id,
        conversationId: CHAT,
        deferredRecovery: true
      })
    );
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([revival]);
  });

  it('opens one marked exact-chat tab only when the fresh scan finds none', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app()
    });
    await worker.createTab({ id: 41, url: `https://chatgpt.com/c/${PRIME}` });

    await worker.fireAlarm();

    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
    const opened = String(worker.tabsCreate.mock.calls[0]?.[0]?.url || '');
    expect(opened).toContain(`/c/${CHAT}`);
    expect(opened).toContain(`clf=${revival.id}`);
    expect(worker.tabsCreate.mock.calls[0]?.[0]?.active).toBe(false);

    // The marker tab is visible to the next fresh scan even before redeem settles. The same
    // pending revival can therefore never turn an alarm/activity burst into a tab spiral.
    await worker.fireAlarm();
    expect(worker.tabsCreate).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate an exact tab while its replacement document is still loading', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'loading' }
      ],
      tabsSendMessage: async () => {
        throw new Error('receiver is still starting');
      }
    });
    worker.scriptingExecuteScript.mockRejectedValue(new Error('document is navigating'));

    await worker.fireAlarm();

    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not turn a failed browser scan into absence or an opening permit', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired), session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(), tabsQuery: async () => { throw new Error('browser snapshot unavailable'); }
    });
    await worker.fireAlarm();
    await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('keeps an inaccessible complete exact tab as the only revival target', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' }
      ],
      tabsSendMessage: async () => {
        throw new Error('no receiver');
      }
    });
    worker.scriptingExecuteScript.mockRejectedValue(new Error('page cannot be repaired'));

    await worker.fireAlarm();

    await worker.fireAlarm();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('reloads a discarded exact tab and offers the revival to its reloaded document', async () => {
    let discarded = true;
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea({ recoveryMonitoring: true }),
      fetch: app(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, ...(discarded ? { discarded: true } : { status: 'complete' }) }
      ],
      tabsGet: async id => ({ id, url: `https://chatgpt.com/c/${CHAT}`, discarded }),
      tabsSendMessage: liveRecorder
    });

    await worker.fireAlarm();

    // A discarded shell can never answer the ping or accept an injection. Reloading it is the
    // exact repair; creating a second tab for the same conversation is the failure this
    // prevents.
    expect(worker.tabsReload).toHaveBeenCalledWith(4);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage.mock.calls.some(([id, message]) => id === 4 && message.type === 'clf-run-command')).toBe(false);

    // The reloaded document registers, and that registration re-enters this exact flow.
    discarded = false;
    await worker.registerTab(4, 'document-4-reloaded');
    await vi.waitFor(() =>
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
        type: 'clf-run-command',
        id: revival.id,
        conversationId: CHAT,
        deferredRecovery: true
      })
    );
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('takes the fast path from any live activity poll without waiting for the alarm', async () => {
    const worker = loadWorker({
      local: new FakeStorageArea(paired),
      session: new FakeStorageArea(),
      fetch: app('activity'),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}`, status: 'complete' },
        { id: 9, windowId: 7, url: `https://chatgpt.com/c/${PRIME}`, status: 'complete' }
      ],
      tabsSendMessage: liveRecorder
    });
    await worker.registerTab(9, 'prime-document');
    await worker.send({ type: 'bind', conversationId: PRIME }, 9, 'prime-document');

    await worker.send({ type: 'activity', conversationId: PRIME, since: 0 }, 9, 'prime-document');

    await vi.waitFor(() =>
      expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
        type: 'clf-run-command',
        id: revival.id,
        conversationId: CHAT,
        deferredRecovery: true
      })
    );
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('persists revival custody and never recreates its user-closed tab after browser restart', async () => {
    const local = new FakeStorageArea(paired);
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: app() });
    await first.registerTab(4, 'document-4-live');

    local.failNextSets = 1;
    const failed = await first.send({ type: 'defer_revival', ...revival }, 4, 'document-4-live');
    expect(failed).toMatchObject({ ok: false });
    expect(local.data.deferredRevivals ?? []).toEqual([]);

    const retried = await first.send({ type: 'defer_revival', ...revival }, 4, 'document-4-live');
    expect(retried).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([revival]);

    const restarted = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch: app(),
      tabsQuery: async () => []
    });
    await restarted.fireAlarm();
    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([{ ...revival, openingSpent: true }]);
  });

  it('persists the first revival opening before Chrome and never repeats it across restart', async () => {
    const local = new FakeStorageArea({ ...paired, deferredRevivals: [revival] });
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: app(), tabsQuery: async () => [] });
    await vi.waitFor(() => expect(first.tabsCreate).toHaveBeenCalledTimes(1));
    expect(local.data.deferredRevivals).toMatchObject([{ ...revival, openingSpent: true }]);
    await first.fireAlarm();
    expect(first.tabsCreate).toHaveBeenCalledTimes(1);
    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch: app(), tabsQuery: async () => [] });
    await restarted.fireAlarm();
    expect(restarted.tabsCreate).not.toHaveBeenCalled();
  });

  it('prunes a stale deferred revival before browser startup can recreate its ChatGPT tab', async () => {
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: 'cmd-dead-after-restart', conversationId: CHAT, queuedAt: Date.now() }]
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(200, { pending: [] });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toEqual([]);
  });

  it('fails closed when deferred-revival validation is unavailable instead of opening an unproven tab', async () => {
    const marker = { id: 'cmd-validation-unavailable', conversationId: CHAT, queuedAt: Date.now() };
    const local = new FakeStorageArea({ ...paired, deferredRevivals: [marker] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(503, { error: 'bridge_recovering' });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([marker]);
  });

  it('replaces an obsolete deferred wake for the same worker conversation', async () => {
    const oldId = 'cmd-old-deferred-worker-wake';
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: oldId, conversationId: CHAT, queuedAt: 1 }]
    });
    const worker = loadWorker({ local, session: new FakeStorageArea() });
    await worker.registerTab(4, 'document-4-current');

    const custody = await worker.send({ type: 'defer_revival', ...revival }, 4, 'document-4-current');

    expect(custody).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([revival]);
    expect((local.data.deferredRevivals as Array<{ id: string }>).some((entry) => entry.id === oldId)).toBe(false);
  });
});

describe('extension observation journal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists a new pixel-purpose lease bound to the actual Chrome sender and existing exact target before returning it', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const providerMessageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const captureId = 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const target = { messageId: 'assistant:page-pixel', providerMessageId,
      nodeId: 'n-0-1', mediaId: 'media-n-0-1' };
    const session = new FakeStorageArea();
    const posts: Record<string, unknown>[] = [];
    const fetch = async (address: string, init: Record<string, unknown> = {}) => {
      const route = new URL(address).pathname;
      if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, paired: true, compatible: true });
      if (route === '/recording/generation') return response(200, { recordingGeneration });
      if (route === '/rich/pixel/begin') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return response(200, { capture: { captureId, purpose: 'page_pixel', ...body,
          sessionId: 'physical-session', bindingRevision: 4, richRevision: 3,
          slotVersion: 0, sourceIncarnation: null, sourceSequence: null } });
      }
      return response(503, { error: 'journal_retry' });
    };
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session, fetch,
      tabsGet: async () => ({ id: 42, url, status: 'complete' }) });
    await worker.registerTab(42, 'registered-pixel-document');
    const begin = await worker.send({ type: 'rich_pixel_begin', conversationId, ...target,
      recordingGeneration, navigationEpoch: 0,
      sessionId: 'page-forged', slotVersion: 999, sourceIncarnation: 'page-forged',
      documentId: 'page-forged', tab: 999 }, 42, 'registered-pixel-document', url);
    expect(posts).toEqual([{ conversationId, tab: 42, documentId: 'registered-pixel-document',
      documentGeneration: 1, spaEpoch: 0, recordingGeneration, ...target }]);
    expect(begin).toMatchObject({ ok: true, capture: { captureId, purpose: 'page_pixel',
      conversationId, sessionId: 'physical-session', bindingRevision: 4,
      ...target, richRevision: 3, slotVersion: 0, sourceIncarnation: null, sourceSequence: null } });
    const persisted = (session.data.workerRichIssuances as Record<string, any>)[captureId];
    expect(persisted).toMatchObject({ captureId, purpose: 'page_pixel',
      tab: 42, documentId: 'registered-pixel-document', documentGeneration: 1, spaEpoch: 0,
      recordingGeneration, sessionId: 'physical-session', bindingRevision: 4,
      ...target, richRevision: 3, slotVersion: 0, sourceIncarnation: null, sourceSequence: null });
    expect(JSON.stringify(persisted)).not.toContain('page-forged');
    const restored = loadWorker({ local, session, fetch,
      tabsGet: async () => ({ id: 42, url, status: 'complete' }) });
    await restored.send({ type: 'status' });
    expect((session.data.workerRichIssuances as Record<string, any>)[captureId]).toMatchObject({
      purpose: 'page_pixel', captureId, ...target
    });

    // A pixel-purpose issuance cannot be spent to mint a structural rich receipt.
    const rich = { version: 1, status: 'available', reason: null, conversationId,
      messageId: target.messageId, providerMessageId, revision: 0, accessibleText: '', nodes: [] };
    await restored.send({ type: 'events', conversationId, navigationEpoch: 0, entries: [{
      conversationId, recordingGeneration, recordingNavigationEpoch: 0,
      richSeal: { captureId, scanToken: 'forged-structural',
        messageId: target.messageId, providerMessageId },
      event: { kind: 'assistant_message', time: Date.now(), ...target, rich }
    }] }, 42, 'registered-pixel-document', url);
    expect(journalOf(session)).toEqual([]);
  });

  it('refuses pixel issuance without current Chrome document, route, source G and a valid fixed target', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    let beginPosts = 0;
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async address => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, paired: true, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration });
        if (route === '/rich/pixel/begin') beginPosts++;
        return response(503, { error: 'no_slot' });
      } });
    await worker.registerTab(42, 'registered-pixel-document');
    const target = { messageId: 'assistant:page-pixel', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      nodeId: 'n-0-1', mediaId: 'media-n-0-1' };
    const cases = [
      { message: { type: 'rich_pixel_begin', conversationId, ...target,
        recordingGeneration, navigationEpoch: 0 }, doc: 'wrong-document', senderUrl: url },
      { message: { type: 'rich_pixel_begin', conversationId, ...target,
        recordingGeneration: 'Z'.repeat(43), navigationEpoch: 0 }, doc: 'registered-pixel-document', senderUrl: url },
      { message: { type: 'rich_pixel_begin', conversationId, ...target,
        recordingGeneration, navigationEpoch: 1 }, doc: 'registered-pixel-document', senderUrl: url },
      { message: { type: 'rich_pixel_begin', conversationId, ...target,
        nodeId: 'n-0-2', recordingGeneration, navigationEpoch: 0 }, doc: 'registered-pixel-document', senderUrl: url },
      { message: { type: 'rich_pixel_begin', conversationId, ...target,
        recordingGeneration, navigationEpoch: 0 }, doc: 'registered-pixel-document',
        senderUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    ];
    for (const item of cases) {
      const reply = await worker.send(item.message, 42, item.doc, item.senderUrl);
      expect(reply.ok).toBe(false);
    }
    expect(beginPosts).toBe(0);
  });

  it('attests only exact-purpose pixel rows, verifies actual encoded-byte digest, and journals independent positional receipts', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const providerMessageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const captureId = 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
    const scanToken = 'pixel-scan-1';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const target = { messageId: 'assistant:page-pixel', providerMessageId,
      nodeId: 'n-0-1', mediaId: 'media-n-0-1' };
    const sourceIncarnation = `src_${'a'.repeat(32)}_1`, sourceSequence = 1;
    // A synthetic WebP header only exercises the worker's custody/hash boundary.
    // It is NOT evidence for decoded media, provider pixels or recorder availability.
    const bytes = Buffer.from('524946460400000057454250', 'hex');
    const pixelSha256 = createHash('sha256').update(bytes).digest('hex');
    const previewDataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
    const rootStamp = `${scanToken}:0:${encodeURIComponent(target.messageId)}:${encodeURIComponent(providerMessageId)}`;
    const seal = { captureId, scanToken, ...target, rootStamp,
      sourceIncarnation, sourceSequence, status: 'available',
      pixelBytes: bytes.length, pixelSha256 };
    const event = { kind: 'rich_media', time: Date.now(), ...target,
      status: 'available', previewDataUrl, previewWidth: 4, previewHeight: 4,
      pixelBytes: bytes.length, pixelSha256 };
    const session = new FakeStorageArea();
    const posts: any[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, paired: true, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration });
        if (route === '/rich/pixel/begin') return response(200, { capture: {
          captureId, purpose: 'page_pixel', ...JSON.parse(String(init.body)),
          sessionId: 'physical-session', bindingRevision: 4, richRevision: 1,
          slotVersion: 0, sourceIncarnation: null, sourceSequence: null } });
        if (route === '/events') { posts.push(JSON.parse(String(init.body))); return response(503, {}); }
        return response(503, {});
      } });
    await worker.registerTab(42, 'registered-pixel-document');
    expect((await worker.send({ type: 'rich_pixel_begin', conversationId, ...target,
      recordingGeneration, navigationEpoch: 0 }, 42, 'registered-pixel-document', url))
      .capture).toMatchObject({ captureId, purpose: 'page_pixel' });
    const entries = [
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        pixelSeal: seal, pixelReceipt: { captureId: 'FORGED', status: 'available' }, event },
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        event: { kind: 'user_message', time: Date.now(), messageId: 'ordinary-user', text: 'Ordinary prose' } },
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        pixelSeal: { ...seal, status: 'unavailable', pixelBytes: null, pixelSha256: null },
        event: { kind: 'rich_media', time: Date.now(), ...target, status: 'unavailable', reason: 'tainted' } }
    ];
    expect(await worker.send({ type: 'events', conversationId, navigationEpoch: 0, entries },
      42, 'registered-pixel-document', url)).toMatchObject({ ok: true, durable: true });
    const journal = journalOf(session);
    expect(journal).toHaveLength(3);
    expect(journal.map(row => row.pixelReceipt)).toEqual([
      expect.objectContaining({ captureId, scanToken, ...target, rootStamp,
        sourceIncarnation, sourceSequence, status: 'available', pixelBytes: bytes.length, pixelSha256,
        conversationId, tab: 42, documentId: 'registered-pixel-document',
        documentGeneration: 1, spaEpoch: 0, recordingGeneration }),
      null,
      expect.objectContaining({ captureId, ...target, sourceIncarnation, sourceSequence,
        status: 'unavailable', pixelBytes: null, pixelSha256: null })
    ]);
    expect(JSON.stringify(journal)).not.toContain('FORGED');
    expect(journal[0].event.previewDataUrl).toBe(previewDataUrl);
    expect(posts[0]).toMatchObject({ recordingGenerations: [recordingGeneration, recordingGeneration, recordingGeneration],
      richPixelReceipts: [expect.objectContaining({ captureId, status: 'available' }),
        null, expect.objectContaining({ captureId, status: 'unavailable' })] });
    expect(posts[0].richPixelReceipts).toHaveLength(posts[0].events.length);

    const forgedBytes = { ...event, previewDataUrl: `data:image/webp;base64,${Buffer.from('not-webp').toString('base64')}` };
    const forgedSeal = { ...seal, captureId };
    await worker.send({ type: 'events', conversationId, navigationEpoch: 0, entries: [
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        pixelSeal: forgedSeal, event: forgedBytes }
    ] }, 42, 'registered-pixel-document', url);
    expect(journalOf(session)).toHaveLength(3); // No forged digest can journal a pixel.
  });

  it('preserves exact original pixel-receipt indexes and null gaps in both HTTP 413 halves', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const providerMessageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const captureId = 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
    const scanToken = 'pixel-scan-413', sourceIncarnation = `src_${'a'.repeat(32)}_1`;
    const url = `https://chatgpt.com/c/${conversationId}`;
    const target = { messageId: 'assistant:page-pixel', providerMessageId,
      mediaId: 'media-n-0-1', nodeId: 'n-0-1' };
    const rootStamp = `${scanToken}:0:${encodeURIComponent(target.messageId)}:${encodeURIComponent(providerMessageId)}`;
    const pixel = (status: 'pending' | 'unavailable') => ({
      conversationId, recordingGeneration, recordingNavigationEpoch: 0,
      pixelSeal: { captureId, scanToken, ...target, rootStamp, sourceIncarnation,
        sourceSequence: 1, status, pixelBytes: null, pixelSha256: null },
      event: { kind: 'rich_media', time: Date.now(), ...target, status,
        ...(status === 'unavailable' ? { reason: 'tainted' } : {}) }
    });
    const posts: any[] = [];
    let refuseOnce = true;
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, paired: true, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration });
        if (route === '/rich/pixel/begin') return response(200, { capture: {
          captureId, purpose: 'page_pixel', ...JSON.parse(String(init.body)),
          sessionId: 'physical-session', bindingRevision: 4, richRevision: 1,
          slotVersion: 0, sourceIncarnation: null, sourceSequence: null } });
        if (route === '/events') {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          if (refuseOnce) { refuseOnce = false; return response(413, { error: 'body_too_large' }); }
          return response(200, { stored: body.events.length });
        }
        return response(503, {});
      } });
    await worker.registerTab(42, 'registered-pixel-document');
    expect((await worker.send({ type: 'rich_pixel_begin', conversationId,
      recordingGeneration, navigationEpoch: 0, ...target },
    42, 'registered-pixel-document', url)).ok).toBe(true);
    const normal = { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
      event: { kind: 'user_message', time: Date.now(), messageId: 'author-prose', text: 'exact prose' } };
    await worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: [pixel('pending'), normal, pixel('unavailable')] },
    42, 'registered-pixel-document', url);
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posts.length).toBeGreaterThanOrEqual(3);
    expect(posts[0].richPixelReceipts).toEqual([
      expect.objectContaining({ captureId, scanToken, status: 'pending', ...target }),
      null,
      expect.objectContaining({ captureId, scanToken, status: 'unavailable', ...target })
    ]);
    for (const post of posts) {
      expect(post.richPixelReceipts).toHaveLength(post.events.length);
      expect(post.recordingGenerations).toHaveLength(post.events.length);
      expect(post.richPixelReceipts).toEqual(post.events.map((event: any) =>
        event.kind === 'rich_media' ? expect.objectContaining({
          captureId, scanToken, ...target, status: event.status
        }) : null));
    }
    expect(posts.filter(post => post.events.length < 3)).toHaveLength(2);
    expect(posts.flatMap(post => post.events.map((event: any) => event.messageId)))
      .toEqual([target.messageId, 'author-prose', target.messageId,
        target.messageId, 'author-prose', target.messageId]);
  });

  it('persists the issued Chrome document ticket before ACK and freezes its exact row receipt across MV3 restart', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const captureId = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const providerMessageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const scanToken = 'frame-before-scan';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = async (address: string, init: Record<string, unknown> = {}) => {
      const route = new URL(address).pathname;
      if (route === '/hello') return response(200, { app: APP_SLUG, paired: true, bridge: 17, compatible: true });
      if (route === '/recording/generation') return response(200, { recordingGeneration });
      if (route === '/rich/capture/begin') return response(200, { capture: {
        captureId, ...JSON.parse(String(init.body)), sessionId: 'physical-session', bindingRevision: 3
      } });
      return response(503, { error: 'journal_retry' });
    };
    const worker = loadWorker({ local, session, fetch,
      tabsGet: async () => ({ id: 42, url, status: 'complete' }) });
    await worker.registerTab(42, 'physical-document');
    const begin = await worker.send({ type: 'rich_capture_begin', conversationId,
      navigationEpoch: 0, recordingGeneration }, 42, 'physical-document', url);
    expect(begin).toMatchObject({ ok: true, capture: { captureId,
      sessionId: 'physical-session', bindingRevision: 3 } });
    // This is the durable storage image, not the returned ticket's page-controlled body.
    expect((session.data.workerRichIssuances as Record<string, any>)[captureId]).toMatchObject({
      captureId, tab: 42, documentId: 'physical-document', documentGeneration: 1,
      spaEpoch: 0, conversationId, recordingGeneration, sessionId: 'physical-session', bindingRevision: 3
    });
    const rich = { version: 1, status: 'available', reason: null,
      conversationId, messageId: 'logical-one', providerMessageId, revision: 0,
      accessibleText: 'Example', nodes: [] };
    const entry = { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
      richSeal: { captureId, scanToken, messageId: 'logical-one', providerMessageId },
      event: { kind: 'assistant_message', time: Date.now(), messageId: 'logical-one',
        providerMessageId, rich } };
    expect(await worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: [entry] }, 42, 'physical-document', url)).toMatchObject({ ok: true, durable: true });
    const journal = journalOf(session);
    expect(journal).toHaveLength(1);
    expect(journal[0].richReceipt).toEqual({ captureId, scanToken,
      messageId: 'logical-one', providerMessageId, conversationId, recordingGeneration,
      tab: 42, documentId: 'physical-document', documentGeneration: 1, spaEpoch: 0 });
    const restored = loadWorker({ local, session, fetch,
      tabsGet: async () => ({ id: 42, url, status: 'complete' }) });
    await restored.send({ type: 'status' });
    expect(journalOf(session)[0].richReceipt).toEqual(journal[0].richReceipt);
    expect((session.data.workerRichIssuances as Record<string, any>)[captureId]).toMatchObject({
      scanToken, pairs: { 'logical-one': providerMessageId }
    });
  });

  it('strips forged rich receipt and unsealed rich-only rows but preserves independent authored text', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async address => new URL(address).pathname === '/recording/generation'
        ? response(200, { recordingGeneration }) : response(503, {}) });
    await worker.registerTab(42, 'physical-document');
    const rich = { version: 1, status: 'available', reason: null,
      conversationId, messageId: 'logical', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      revision: 0, accessibleText: 'Untrusted', nodes: [] };
    await worker.send({ type: 'events', conversationId, navigationEpoch: 0, entries: [
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        richReceipt: { captureId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', scanToken: 'forged' },
        event: { kind: 'assistant_message', messageId: rich.messageId,
          providerMessageId: rich.providerMessageId, text: 'Real authored prose', rich } },
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        event: { kind: 'assistant_message', messageId: 'rich-only',
          providerMessageId: rich.providerMessageId, rich: { ...rich, messageId: 'rich-only' } } }
    ] }, 42, 'physical-document', url);
    const journal = journalOf(session);
    expect(journal).toHaveLength(1);
    expect(journal[0].event).toMatchObject({ kind: 'assistant_message', text: 'Real authored prose' });
    expect(journal[0].event).not.toHaveProperty('rich');
    expect(journal[0].richReceipt).toBeNull();
    expect(JSON.stringify(journal)).not.toContain('forged');
  });

  it('slices genuine exact-row receipts positionally with null ordinary rows through HTTP 413 and replay', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const captureId = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const providerA = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const providerB = '3150f756-bf2d-45fa-ac0f-45010b2239fc';
    const scanToken = 'scan-two-pairs';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const posts: any[] = [];
    let first = true;
    const session = new FakeStorageArea();
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, compatible: true, paired: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration });
        if (route === '/rich/capture/begin') return response(200, { capture: {
          captureId, ...JSON.parse(String(init.body)), sessionId: 'physical-session', bindingRevision: 1
        } });
        if (route === '/events') {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          if (first) { first = false; return response(413, { error: 'body_too_large' }); }
          return response(200, { stored: body.events.length });
        }
        return response(200, {});
      } });
    await worker.registerTab(42, 'physical-document');
    expect(await worker.send({ type: 'rich_capture_begin', conversationId,
      recordingGeneration, navigationEpoch: 0 }, 42, 'physical-document', url))
      .toMatchObject({ ok: true, capture: { captureId } });
    const richEntry = (messageId: string, providerMessageId: string) => ({
      conversationId, recordingGeneration, recordingNavigationEpoch: 0,
      richSeal: { captureId, scanToken, messageId, providerMessageId },
      richReceipt: { captureId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', scanToken: 'forged' },
      event: { kind: 'assistant_message', time: Date.now(), messageId, providerMessageId,
        rich: { version: 1, status: 'available', reason: null, conversationId,
          messageId, providerMessageId, revision: 0, accessibleText: '', nodes: [] } }
    });
    await worker.send({ type: 'events', conversationId, navigationEpoch: 0, entries: [
      richEntry('logical-a', providerA),
      { conversationId, recordingGeneration, recordingNavigationEpoch: 0,
        event: { kind: 'user_message', time: Date.now(), messageId: 'normal-user', text: 'authored' } },
      richEntry('logical-b', providerB)
    ] }, 42, 'physical-document', url);
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0].richCaptureReceipts).toHaveLength(3);
    expect(posts[0].richCaptureReceipts[0]).toMatchObject({ captureId,
      scanToken, messageId: 'logical-a', providerMessageId: providerA });
    expect(posts[0].richCaptureReceipts[1]).toBeNull();
    expect(posts[0].richCaptureReceipts[2]).toMatchObject({ captureId,
      scanToken, messageId: 'logical-b', providerMessageId: providerB });
    for (const post of posts) {
      expect(post.recordingGenerations).toHaveLength(post.events.length);
      if (post.richCaptureReceipts) {
        expect(post.richCaptureReceipts).toHaveLength(post.events.length);
        expect(post.richCaptureReceipts).toEqual(post.events.map((event: any) =>
          event.kind === 'assistant_message' ? expect.objectContaining({
            captureId, scanToken, messageId: event.messageId, providerMessageId: event.providerMessageId
          }) : null));
      } else expect(post.events.every((event: any) => event.kind !== 'assistant_message')).toBe(true);
    }
    expect(JSON.stringify(posts)).not.toContain('forged');
  });

  it('attests a pre-scan rich ticket from registered Chrome sender, physical document, SPA grant and settled route', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const generation = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const posted: any[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(), tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true, bridge: 17, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration: generation });
        if (route === '/rich/capture/begin') {
          const body = JSON.parse(String(init.body));
          posted.push(body);
          return response(200, { capture: { captureId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            ...body, sessionId: 'session-from-main', bindingRevision: 0 } });
        }
        return response(200, {});
      } });
    expect(await worker.registerTab(42, 'registered-document')).toMatchObject({ ok: true, recordingGeneration: generation });
    const result = await worker.send({ type: 'rich_capture_begin', conversationId,
      navigationEpoch: 0, recordingGeneration: generation,
      tab: 999, documentId: 'page-forged', sessionId: 'page-forged', bindingRevision: 999 },
    42, 'registered-document', url);
    expect(result).toMatchObject({ ok: true, capture: { captureId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      sessionId: 'session-from-main', bindingRevision: 0, documentId: 'registered-document',
      documentGeneration: 1, spaEpoch: 0, conversationId, recordingGeneration: generation } });
    expect(posted).toEqual([{ conversationId, tab: 42, documentId: 'registered-document',
      documentGeneration: 1, spaEpoch: 0, recordingGeneration: generation }]);
  });

  it.each(['missing-sender', 'subframe', 'unregistered-document', 'wrong-spa', 'unknown-grant', 'loading', 'wrong-sender-route'])(
    'refuses rich ticket before app issuance for %s', async failure => {
      const conversationId = '11111111-2222-3333-4444-555555555555';
      const generation = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const url = `https://chatgpt.com/c/${conversationId}`;
      let capturePosts = 0;
      const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
        session: new FakeStorageArea(), tabsGet: async () => ({ id: 42, url,
          status: failure === 'loading' ? 'loading' : 'complete' }),
        fetch: async (address) => {
          const route = new URL(address).pathname;
          if (route === '/hello') return response(200, { app: APP_SLUG, paired: true, bridge: 17, compatible: true });
          if (route === '/recording/generation') return response(200, { recordingGeneration: generation });
          if (route === '/rich/capture/begin') capturePosts++;
          return response(200, {});
        } });
      await worker.registerTab(42, 'registered-document');
      const result = await worker.send({ type: 'rich_capture_begin', conversationId,
        navigationEpoch: failure === 'wrong-spa' ? 700 : 0,
        recordingGeneration: failure === 'unknown-grant' ? 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' : generation },
      42, failure === 'missing-sender' ? '' : failure === 'unregistered-document' ? 'unregistered-document' : 'registered-document',
      failure === 'wrong-sender-route' ? 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : url,
      failure === 'subframe' ? 3 : 0);
      expect(result.ok).toBe(false);
      expect(capturePosts).toBe(0);
    }
  );

  it('refuses an in-flight rich ticket if the Chrome route changes while main answers', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const generation = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    let currentUrl = url;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(), tabsGet: async () => ({ id: 42, url: currentUrl, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true, bridge: 17, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration: generation });
        if (route === '/rich/capture/begin') {
          entered();
          await gate;
          return response(200, { capture: { captureId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            ...JSON.parse(String(init.body)), sessionId: 'session-from-main', bindingRevision: 0 } });
        }
        return response(200, {});
      } });
    await worker.registerTab(42, 'registered-document');
    const pending = worker.send({ type: 'rich_capture_begin', conversationId,
      navigationEpoch: 0, recordingGeneration: generation }, 42, 'registered-document', url);
    try {
      await reached;
      currentUrl = 'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    } finally { release(); }
    expect((await pending).ok).toBe(false);
  });

  it('journals canonical events after a bounded rich begin even when its app response never settles', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const generation = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const session = new FakeStorageArea();
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const requests: string[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async address => {
        const route = new URL(address).pathname;
        requests.push(route);
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration: generation });
        if (route === '/rich/capture/begin') {
          entered();
          // The fetch intentionally ignores AbortSignal: the worker's whole-operation
          // deadline must still release the per-tab queue for the canonical event.
          return new Promise<ReturnType<typeof response>>(() => undefined);
        }
        return response(503, { error: 'app_unavailable' });
      } });
    await worker.registerTab(42, 'registered-document');
    const pendingCapture = worker.send({ type: 'rich_capture_begin', conversationId,
      navigationEpoch: 0, recordingGeneration: generation }, 42, 'registered-document', url);
    await reached;
    const canonical = worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: [{ conversationId, recordingGeneration: generation, recordingNavigationEpoch: 0,
        event: { kind: 'user_message', time: Date.now(), messageId: 'authored-event', text: 'Keep this' } }] },
    42, 'registered-document', url);
    expect(await pendingCapture).toMatchObject({ ok: false, error: 'rich_capture_unavailable' });
    expect(await canonical).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map(row => row.event.messageId)).toContain('authored-event');
    expect(requests.filter(route => route === '/rich/capture/begin')).toHaveLength(1);
  });

  it('refuses a cold rich probe without running port discovery ahead of canonical event custody', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const generation = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const local = new FakeStorageArea({ port: null, token: 'paired-token' });
    const session = new FakeStorageArea({
      tabDocuments: { '42': 'registered-document' }, tabEpochs: { '42': 0 },
      registeredDocuments: { '42': { documentId: 'registered-document', epoch: 1,
        recordingIssuances: [{ epoch: 0, generation }] } }
    });
    let helloCount = 0;
    const worker = loadWorker({ local, session, tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async address => {
        if (new URL(address).pathname === '/hello') helloCount++;
        return response(503, { error: 'app_unavailable' });
      } });
    expect(await worker.send({ type: 'rich_capture_begin', conversationId,
      navigationEpoch: 0, recordingGeneration: generation }, 42, 'registered-document', url))
      .toMatchObject({ ok: false, error: 'rich_capture_unavailable' });
    expect(helloCount).toBe(0);
  });

  it('binds old and renewed recording grants to the Chrome document before accepting page rows and preserves 413 positions', async () => {
    const g0 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const g2 = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    let issued = g0;
    const id = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const batches: any[] = [];
    let first = true;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (route === '/recording/generation') return response(200, { recordingGeneration: issued });
      if (route === '/events') {
        const body = JSON.parse(String(init.body));
        batches.push(body);
        if (first) { first = false; return response(413, { error: 'body_too_large' }); }
        return response(200, { stored: body.events.length });
      }
      return response(200, {});
    } });
    const initial = await worker.registerTab(42, 'issued-document');
    expect(initial).toMatchObject({ ok: true, recordingGeneration: g0 });
    issued = g2; // App committed Off then On before content's old G0 queue reached worker.
    expect(await worker.send({ type: 'recording_generation', navigationEpoch: 0 }, 42, 'issued-document'))
      .toMatchObject({ ok: true, recordingGeneration: g2 });
    await worker.send({ type: 'events', conversationId: id, navigationEpoch: 0, entries: [
      { conversationId: id, recordingGeneration: g0, recordingNavigationEpoch: 0,
        event: { kind: 'user_message', messageId: 'old-g0', text: 'private', recordingGeneration: g2 } },
      { conversationId: id, recordingGeneration: g2, recordingNavigationEpoch: 0,
        event: { kind: 'assistant_message', messageId: 'fresh-g2', text: 'new', recordingGeneration: g0 } },
      { conversationId: id, recordingGeneration: 'forged', recordingNavigationEpoch: 0,
        event: { kind: 'user_message', messageId: 'unknown', text: 'not authorized' } }
    ] }, 42, 'issued-document');
    expect(batches.map(batch => batch.recordingGenerations)).toEqual([
      [g0, g2, null], [g0], [g2, null]
    ]);
    expect(batches[0].events.every((entry: any) => !Object.hasOwn(entry, 'recordingGeneration'))).toBe(true);
    expect(session.data.journal).toEqual([]);
    const registered = session.data.registeredDocuments as Record<string, any>;
    expect(registered['42'].recordingIssuances).toMatchObject([
      { generation: g0, epoch: 0 }, { generation: g2, epoch: 0 }
    ]);
  });

  it('retires unversioned and malformed saved observations as unknown without forging a new gap', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const session = new FakeStorageArea({ journal: [
      { conversationId: id, provisional: null, event: { kind: 'user_message', messageId: 'v16-legacy', text: 'old' } },
      { conversationId: id, provisional: null, recordingGeneration: 'malformed-v17',
        event: { kind: 'assistant_message', messageId: 'bad-token', text: 'unknown' } }
    ] });
    const posts: any[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      fetch: async (input, init = {}) => {
        if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (new URL(input).pathname === '/events') posts.push(JSON.parse(String(init.body)));
        return response(200, { stored: 0, recordingSuppressed: true });
      } });
    await worker.send({ type: 'status' });
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posts).toMatchObject([{ recordingGenerations: [null, null], events: [
      { messageId: 'v16-legacy' }, { messageId: 'bad-token' }
    ] }]);
    expect(posts.flatMap(post => post.events).some(entry => entry.kind === 'chat_error')).toBe(false);
  });

  it('refuses a protocol-16 hello without attempting an events POST or retiring the journal', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const requests: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input) => {
      const path = new URL(input).pathname;
      requests.push(path);
      if (path === '/hello') return response(200, { app: APP_SLUG, bridge: 16, compatible: false, paired: true });
      throw new Error(`incompatible extension attempted ${path}`);
    } });
    const id = '11111111-2222-3333-4444-555555555555';
    await worker.send({ type: 'events', conversationId: id,
      entries: [{ conversationId: id, event: { kind: 'user_message', time: Date.now(), text: 'retain' } }] });
    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ compatible: false, extensionProtocol: 17, appProtocol: 16, pending: 1 });
    expect(requests).not.toContain('/events');
    expect(journalOf(session)).toHaveLength(1);
  });

  it('captures Chrome sender per journal row, never forged entry fields, and retains old document across reload/rename', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const sent: any[] = [];
    let deliver = false;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (route === '/events') {
        sent.push(JSON.parse(String(init.body)));
        return deliver ? response(200, { stored: 1 }) : response(503, { error: 'retry' });
      }
      return response(200, {});
    } });
    const id = '11111111-2222-3333-4444-555555555555';
    const provider = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const projection = { version: 1, status: 'available', reason: null, conversationId: id,
      messageId: 'logical-a', providerMessageId: provider, revision: 0, accessibleText: 'Choose', nodes: [] };
    expect(await worker.registerTab(42, 'document-42-0')).toMatchObject({ ok: true });
    await worker.send({ type: 'events', entries: [{ conversationId: null,
      capture: { tab: 999, documentId: 'forged', navigationEpoch: 999, routeVerified: true },
      event: { kind: 'assistant_message', time: Date.now(), messageId: 'logical-a',
        providerMessageId: provider, text: 'Authored answer', rich: projection } }] }, 42, 'document-42-0');
    const original = journalOf(session)[0].capture;
    expect(original).toMatchObject({ tab: 42, documentId: 'document-42-0', navigationEpoch: 1, routeVerified: false });
    expect(JSON.stringify(original)).not.toContain('forged');
    expect(journalOf(session)[0].event).not.toHaveProperty('rich');
    expect(journalOf(session)[0].richReceipt).toBeNull();
    await worker.navigateTab(42, 'https://chatgpt.com/');
    expect(journalOf(session)[0].capture).toEqual(original);
    expect(journalOf(session)[0].provisional).toBe('tab-42:document-42-1');
    deliver = true;
    await worker.send({ type: 'bind', conversationId: id }, 42, 'document-42-1');
    expect(sent.at(-1)).toMatchObject({ conversationId: id,
      sourceCaptures: [original], events: [expect.objectContaining({ messageId: 'logical-a' })] });
    expect(journalOf(session)).toEqual([]);
  });

  it('attests a rich row route only against Chrome tab URL, not its claimed conversation or page epoch', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session,
      tabsGet: async (id) => ({ id, url: `https://chatgpt.com/c/${a}`, status: 'complete' }) });
    await worker.registerTab(42, 'document-42-0');
    const rich = { version: 1, status: 'available', reason: null, conversationId: a,
      messageId: 'logical-a', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      revision: 0, accessibleText: 'Choose', nodes: [] };
    await worker.send({ type: 'events', conversationId: a, navigationEpoch: 700,
      entries: [{ conversationId: a, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored A', rich } },
        { conversationId: b, event: { kind: 'assistant_message', time: Date.now(),
          text: 'Authored B', rich } }] },
      42, 'document-42-0', `https://chatgpt.com/c/${a}`);
    expect(journalOf(session).map(entry => entry.capture)).toEqual([
      { tab: 42, documentId: 'document-42-0', navigationEpoch: 1, routeVerified: true, conversationId: a },
      { tab: 42, documentId: 'document-42-0', navigationEpoch: 1, routeVerified: false, conversationId: null }
    ]);
    // The independently registered document generation did not become the page's `700`.
    expect(session.data.registeredDocuments).toMatchObject({ '42': { documentId: 'document-42-0', epoch: 1 } });
    await worker.send({ type: 'events', conversationId: a,
      entries: [{ conversationId: a, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored A', rich } }] },
      42, 'document-42-0', `https://chatgpt.com/c/${b}`);
    expect(journalOf(session).at(-1).capture).toMatchObject({ routeVerified: false, conversationId: null });
  });

  it('does not attest a rich route while Chrome is loading with no pendingUrl, then attests it when settled', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const session = new FakeStorageArea();
    let status = 'loading';
    const worker = loadWorker({
      local: new FakeStorageArea(), session,
      tabsGet: async (id) => ({ id, url, status })
    });
    await worker.registerTab(42, 'document-42-0');
    const rich = { version: 1, status: 'available', reason: null, conversationId,
      messageId: 'logical-a', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      revision: 0, accessibleText: 'Choose', nodes: [] };
    const entry = { conversationId, event: { kind: 'assistant_message',
      time: Date.now(), text: 'Authored answer', rich } };

    await worker.send({ type: 'events', conversationId, entries: [entry] }, 42, 'document-42-0', url);
    expect(journalOf(session)[0].capture).toEqual({
      tab: 42, documentId: 'document-42-0', navigationEpoch: 1,
      routeVerified: false, conversationId: null
    });

    status = 'complete';
    await worker.send({ type: 'events', conversationId, entries: [entry] }, 42, 'document-42-0', url);
    expect(journalOf(session)[1].capture).toEqual({
      tab: 42, documentId: 'document-42-0', navigationEpoch: 1,
      routeVerified: true, conversationId
    });
    expect(journalOf(session)[0].capture.routeVerified).toBe(false);
  });

  it('retires registration on physical close and preserves queued rich provenance when a tab id is reused', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const session = new FakeStorageArea();
    let url = `https://chatgpt.com/c/${a}`;
    const worker = loadWorker({
      local: new FakeStorageArea(), session,
      tabsGet: async (id) => ({ id, url, status: 'complete' })
    });
    const rich = (conversationId: string) => ({ version: 1, status: 'available', reason: null,
      conversationId, messageId: 'logical', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      revision: 0, accessibleText: 'Choose', nodes: [] });
    await worker.registerTab(42, 'old-document');
    await worker.send({ type: 'events', conversationId: a,
      entries: [{ conversationId: a, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored A', rich: rich(a) } }] },
    42, 'old-document', url);
    const oldCapture = journalOf(session)[0].capture;
    expect(oldCapture).toMatchObject({ documentId: 'old-document', navigationEpoch: 1, routeVerified: true });

    await worker.closeTab(42);
    await vi.waitFor(() => expect(session.data.registeredDocuments).toEqual({}));
    expect(journalOf(session)[0].capture).toEqual(oldCapture);

    url = `https://chatgpt.com/c/${b}`;
    await worker.registerTab(42, 'new-document');
    await worker.send({ type: 'events', conversationId: b,
      entries: [{ conversationId: b, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored B', rich: rich(b) } }] },
    42, 'new-document', url);
    expect(journalOf(session).map((entry) => entry.capture)).toEqual([
      oldCapture,
      { tab: 42, documentId: 'new-document', navigationEpoch: 1, routeVerified: true, conversationId: b }
    ]);
    expect(session.data.registeredDocuments).toMatchObject({ '42': { documentId: 'new-document', epoch: 1 } });
  });

  it('sends the exact per-entry Chrome capture with both 413 halves and persisted retry', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const provider = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const batches: any[] = [];
    let first = true;
    const fetch = async (input: string, init: Record<string, unknown> = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname !== '/events') return response(200, {});
      const body = JSON.parse(String(init.body));
      batches.push(body);
      if (first) { first = false; return response(413, { error: 'body_too_large' }); }
      return response(200, { stored: body.events.length });
    };
    const worker = loadWorker({ local, session, fetch });
    expect(await worker.registerTab(42, 'document-42-0')).toMatchObject({ ok: true });
    const rich = (messageId: string) => ({ version: 1, status: 'available', reason: null,
      conversationId: id, messageId, providerMessageId: provider, revision: 0, accessibleText: '', nodes: [] });
    await worker.send({ type: 'events', conversationId: id, entries: [
      { conversationId: id, event: { kind: 'assistant_message', time: Date.now(),
        messageId: 'logical-a', text: 'Authored A', rich: rich('logical-a') } },
      { conversationId: id, event: { kind: 'assistant_message', time: Date.now(),
        messageId: 'logical-b', text: 'Authored B', rich: rich('logical-b') } }
    ] }, 42, 'document-42-0');
    expect(batches.map(batch => batch.events.length)).toEqual([2, 1, 1]);
    expect(batches[0].sourceCaptures).toHaveLength(2);
    for (const batch of batches) {
      expect(batch.sourceCaptures).toHaveLength(batch.events.length);
      expect(batch.sourceCaptures).toEqual(batch.events.map(() => ({
        tab: 42, documentId: 'document-42-0', navigationEpoch: 1, routeVerified: false, conversationId: null
      })));
    }
    expect(journalOf(session)).toEqual([]);
  });

  it('replays the original registered document capture after a service-worker restart', async () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const provider = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const rich = { version: 1, status: 'available', reason: null, conversationId: id,
      messageId: 'logical-retry', providerMessageId: provider, revision: 0, accessibleText: '', nodes: [] };
    const first = loadWorker({ local, session, fetch: async (input) =>
      new URL(input).pathname === '/hello' ? response(200, { app: APP_SLUG, paired: true }) : response(503, {}) });
    await first.registerTab(42, 'document-42-0');
    await first.send({ type: 'events', conversationId: id,
      entries: [{ conversationId: id, event: { kind: 'assistant_message',
        time: Date.now(), text: 'Authored retry', rich } }] }, 42);
    const captured = journalOf(session)[0].capture;
    expect(captured).toMatchObject({ tab: 42, documentId: 'document-42-0', navigationEpoch: 1 });
    const posted: any[] = [];
    const restored = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname === '/events') posted.push(JSON.parse(String(init.body)));
      return response(200, {});
    } });
    await restored.send({ type: 'status' });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].sourceCaptures).toEqual([captured]);
    expect(journalOf(session)).toEqual([]);
  });

  it('keeps old-chat source on delayed journal replay after a different Chrome document binds B', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posts: any[] = [];
    let healthy = false;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const route = new URL(input).pathname;
      if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (route === '/events') {
        posts.push(JSON.parse(String(init.body)));
        return healthy ? response(200, {}) : response(503, {});
      }
      return response(200, {});
    } });
    const provider = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const rich = (conversationId: string) => ({ version: 1, status: 'available', reason: null,
      conversationId, messageId: 'logical-shard', providerMessageId: provider, revision: 0,
      accessibleText: 'Choose', nodes: [] });
    await worker.registerTab(42, 'document-42-0');
    await worker.send({ type: 'bind', conversationId: a }, 42, 'document-42-0');
    await worker.send({ type: 'events', conversationId: a,
      entries: [{ conversationId: a, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored A', rich: rich(a) } }] },
      42, 'document-42-0', `https://chatgpt.com/c/${a}`);
    const oldCapture = journalOf(session)[0].capture;
    await worker.navigateTab(42, `https://chatgpt.com/c/${b}`);
    expect(await worker.send({ type: 'events', conversationId: a,
      entries: [{ conversationId: a, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored A', rich: rich(a) } }] },
      42, 'document-42-0', `https://chatgpt.com/c/${a}`)).toMatchObject({ ok: false });
    await worker.send({ type: 'bind', conversationId: b }, 42, 'document-42-1');
    await worker.send({ type: 'events', conversationId: b,
      entries: [{ conversationId: b, event: { kind: 'assistant_message', time: Date.now(),
        text: 'Authored B', rich: rich(b) } }] },
      42, 'document-42-1', `https://chatgpt.com/c/${b}`);
    expect(journalOf(session)).toMatchObject([
      { conversationId: a, capture: oldCapture },
      { conversationId: b, capture: { documentId: 'document-42-1', navigationEpoch: 2, conversationId: null } }
    ]);
    healthy = true;
    await worker.send({ type: 'status' });
    await vi.waitFor(() => expect(journalOf(session)).toHaveLength(0));
    expect(posts.filter(post => post.conversationId === a).at(-1).sourceCaptures).toEqual([oldCapture]);
    expect(posts.filter(post => post.conversationId === b).at(-1).sourceCaptures).toEqual([
      expect.objectContaining({ documentId: 'document-42-1', navigationEpoch: 2 })
    ]);
  });

  it.each([false, true])('retains a slow durable event batch beyond ten seconds, including a split retry: %s', async split => {
    vi.useFakeTimers();
    const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const signals: AbortSignal[] = [];
    const posted: Array<{ events: Array<{ text: string }> }> = [];
    let release = () => {};
    let delayed = false;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname !== '/events') return response(404, {});
      const batch = JSON.parse(String(init.body));
      posted.push(batch);
      if (split && posted.length === 1) return response(413, { error: 'body_too_large' });
      if (delayed) return response(200, { stored: batch.events.length });
      delayed = true;
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<ReturnType<typeof response>>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        release = () => {
          signal.removeEventListener('abort', abort);
          resolve(response(200, { stored: batch.events.length }));
        };
      });
    } });
    let pending: Promise<unknown> | undefined;
    try {
      await worker.registerTab(61);
      pending = worker.send({ type: 'events', conversationId: chat, entries: ['first', 'second'].map(text => ({
        conversationId: chat, event: { kind: 'progress', time: Date.now(), text }
      })) }, 61);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      expect(journalOf(session).map(entry => entry.event.text)).toEqual(['first', 'second']);
      release();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(journalOf(session)).toEqual([]);
      expect(posted.map(batch => batch.events.map(event => event.text))).toEqual(
        split ? [['first', 'second'], ['first'], ['second']] : [['first', 'second']]
      );
    } finally {
      release();
      await pending;
      vi.useRealTimers();
    }
  });

  it('keeps an event batch durable when its extended deadline expires and drains it on a later successful attempt', async () => {
    vi.useFakeTimers();
    const chat = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const signals: AbortSignal[] = [];
    let healthy = false;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname !== '/events') return response(404, {});
      if (healthy) return response(200, { stored: 1 });
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<ReturnType<typeof response>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } });
    try {
      await worker.registerTab(61);
      const pending = worker.send({ type: 'events', conversationId: chat, entries: [{
        conversationId: chat, event: { kind: 'progress', time: Date.now(), text: 'preserve this observation' }
      }] }, 61);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(signals[0]!.aborted).toBe(true);
      expect(journalOf(session).map(entry => entry.event.text)).toEqual(['preserve this observation']);
      healthy = true;
      const retry = worker.send({ type: 'status' }, 61);
      await vi.advanceTimersByTimeAsync(0);
      await retry;
      expect(journalOf(session)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('delivers another chat and its Goal while a slow chat holds one slot, without overlapping same-chat batches', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const posted: Array<{ conversationId: string; events: Array<{ text: string }> }> = [];
    const active = new Set<string>();
    let maximum = 0;
    let overlaps = 0;
    let drafts = 0;
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') {
        const batch = JSON.parse(String(init.body));
        posted.push(batch);
        if (active.has(batch.conversationId)) overlaps++;
        active.add(batch.conversationId);
        maximum = Math.max(maximum, active.size);
        if (batch.conversationId === a) await gateA;
        if (batch.conversationId === b && batch.events[0].text === 'B1') await gateB;
        active.delete(batch.conversationId);
        return response(200, { stored: batch.events.length });
      }
      if (url.pathname === '/goal/draft') { drafts++; return response(200, { goal: { stage: 'drafting' } }); }
      return response(404, {});
    } });
    const event = (conversationId: string, text: string) => ({
      type: 'events', conversationId,
      entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text } }]
    });
    let aFinished = false;
    const pendingA = worker.send(event(a, 'A1'), 61).then(result => { aFinished = true; return result; });
    try {
      await vi.waitFor(() => expect(active.has(a)).toBe(true));
      await worker.send(event(b, 'B1'), 62);
      await vi.waitFor(() => expect(active.has(b)).toBe(true));
      await worker.send(event(b, 'B2'), 62);
      expect(posted.filter(batch => batch.conversationId === b)).toHaveLength(1);
      const goal = worker.send({ type: 'goal_draft', conversationId: b, turnId: 'B-final' }, 62);
      releaseB();
      await expect(goal).resolves.toMatchObject({ ok: true });
      expect(aFinished).toBe(false);
      expect(drafts).toBe(1);
      expect(posted.filter(batch => batch.conversationId === b).flatMap(batch => batch.events.map(row => row.text))).toEqual(['B1', 'B2']);
      expect(maximum).toBe(2);
      expect(overlaps).toBe(0);
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([a]);
    } finally { releaseA(); releaseB(); }
    await pendingA;
    expect(journalOf(session)).toEqual([]);
  });

  it('keeps command-receipt custody and failed batches isolated while another transport slot is busy', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const c = '33333333-4444-5555-6666-777777777777';
    const d = '44444444-5555-6666-7777-888888888888';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let healthy = false;
    const posted: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/ack') return healthy ? response(200, { ok: true }) : response(503, {});
      if (url.pathname === '/events') {
        const id = JSON.parse(String(init.body)).conversationId;
        posted.push(id);
        if (id === a) await gate;
        if (id === c && !healthy) return response(503, {});
        return response(200, { stored: 1 });
      }
      return response(404, {});
    } });
    await worker.send({ type: 'ack', id: 'blocked-command', status: 'sent', conversationId: b }, 62);
    const row = (conversationId: string) => ({ conversationId, event: { kind: 'progress', time: Date.now(), text: conversationId } });
    const pending = worker.send({ type: 'events', entries: [a, b, c, d].map(row) }, 61);
    try {
      await vi.waitFor(() => expect(posted).toContain(d));
      expect(posted).not.toContain(b);
      expect(posted.filter(id => id === c)).toHaveLength(1);
      await expect(worker.send({ type: 'goal_draft', conversationId: b, turnId: 'blocked' }, 62))
        .resolves.toMatchObject({ ok: false, error: 'transcript_not_delivered' });
      expect(journalOf(session).map(entry => entry.conversationId)).toEqual([a, b, c]);
    } finally { release(); }
    await pending;
    healthy = true;
    await worker.send({ type: 'status' }, 62);
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posted).toContain(b);
    expect(posted.filter(id => id === c)).toHaveLength(2);
  });

  it('yields a hot conversation to an unserved conversation between batches', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const c = '33333333-4444-5555-6666-777777777777';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posted: string[] = [];
    const worker = loadWorker({ local, session, fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') {
        const id = JSON.parse(String(init.body)).conversationId;
        posted.push(id);
        if (id === a) await gate;
        return response(200, { stored: 1 });
      }
      return response(404, {});
    } });
    const row = (conversationId: string, index: number) => ({ conversationId, event: { kind: 'progress', time: index, text: String(index) } });
    const pending = worker.send({ type: 'events', entries: [row(a, 0), ...Array.from({ length: 101 }, (_, i) => row(b, i)), row(c, 0)] });
    try {
      await vi.waitFor(() => expect(posted).toHaveLength(4));
      expect(posted).toEqual([a, b, c, b]);
    } finally { release(); }
    await pending;
    expect(journalOf(session)).toEqual([]);
  });

  it('does not permanently settle a worker command merely because its bootstrap message was sent', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/ack') return response(200, { ok: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    await worker.send({ type: 'ack', id: 'worker-command', status: 'sent', agent: 'worker-1' });
    expect(session.data.settled ?? []).toEqual([]);

    await worker.send({ type: 'ack', id: 'resume-command', status: 'sent' });
    expect(session.data.settled).toEqual(['resume-command']);
  });

  it('preserves the observation journal on a 426 protocol mismatch', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return response(426, { error: 'upgrade_required' });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    const result = await worker.send({
      type: 'events',
      conversationId,
      entries: [
        { conversationId, event: { kind: 'user_message', time: 1_700_000_000_000, text: 'must survive upgrade skew' } }
      ]
    });

    expect(result).toMatchObject({ ok: true, pending: 1, durable: true });
    expect(journalOf(session)).toEqual([
      expect.objectContaining({
        conversationId,
        event: expect.objectContaining({ kind: 'user_message', text: 'must survive upgrade skew' })
      })
    ]);
    expect(JSON.stringify(journalOf(session))).not.toContain('rejected by the local bridge');
  });

  it('retains a 500-failed batch in Chrome storage and retries the exact payload after service-worker restart', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const conversationId = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
    let original: unknown = null;
    const failing = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname === '/events') {
        original = JSON.parse(String(init.body));
        return response(500, { error: 'pending_off' });
      }
      return response(200, {});
    } });
    await failing.send({ type: 'events', conversationId, entries: [
      { conversationId, event: { kind: 'user_message', time: 101, messageId: 'original-500', text: 'owed once' } }
    ] });
    expect(journalOf(session)).toMatchObject([{ event: { messageId: 'original-500', text: 'owed once' } }]);
    const posts: unknown[] = [];
    const restored = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname === '/events') posts.push(JSON.parse(String(init.body)));
      return response(200, { stored: 1 });
    } });
    await restored.send({ type: 'status' });
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posts).toEqual([original]);
  });

  it('retains the exact journal payload through the real 60-second events AbortController deadline', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const conversationId = '77777777-8888-4999-aaaa-cccccccccccc';
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    let original: unknown = null;
    const timedFetch = async (input: string, init: Record<string, unknown> = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname !== '/events') return response(200, {});
      original = JSON.parse(String(init.body));
      reached();
      return new Promise<ReturnType<typeof response>>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    try {
      // Inject the fake clock before constructing the VM; it captures its timer
      // references at load time, not when a later request starts.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const failing = loadWorker({ local, session, fetch: timedFetch });
      const pending = failing.send({ type: 'events', conversationId, entries: [
        { conversationId, event: { kind: 'assistant_message', time: 101, messageId: 'timeout-owned', text: 'original final' } }
      ] });
      await started;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(journalOf(session)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ ok: true, pending: 1, durable: true });
      expect(journalOf(session)).toMatchObject([{ event: { messageId: 'timeout-owned', text: 'original final' } }]);
    } finally {
      vi.useRealTimers();
    }
    const posts: unknown[] = [];
    const restored = loadWorker({ local, session, fetch: async (input, init = {}) => {
      if (new URL(input).pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (new URL(input).pathname === '/events') posts.push(JSON.parse(String(init.body)));
      return response(200, { stored: 1 });
    } });
    await restored.send({ type: 'status' });
    await vi.waitFor(() => expect(journalOf(session)).toEqual([]));
    expect(posts).toEqual([original]);
  });

  it('keeps one retry alarm while work remains instead of resetting it on every failure', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let healthy = false;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return healthy ? response(200, { ok: true }) : response(503, { error: 'retry' });
      if (url.pathname === '/closed') return response(200, { ok: true });
      if (url.pathname === '/status') return response(200, { ok: true, repairs: [], recoveryMonitoring: false });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '12121212-3434-5656-7878-909090909090';
    const event = (text: string) => ({ conversationId, event: { kind: 'progress', time: 1, text } });

    await worker.send({ type: 'events', conversationId, entries: [event('first')] });
    await worker.send({ type: 'events', conversationId, entries: [event('second')] });
    expect(worker.alarmCreate).toHaveBeenCalledTimes(1);
    expect(worker.alarmCreate).toHaveBeenCalledWith('clf-bridge-drain', { delayInMinutes: 0.5 });
    expect(journalOf(session)).toHaveLength(2);

    healthy = true;
    await worker.send({ type: 'events', conversationId, entries: [event('third')] });
    expect(journalOf(session)).toEqual([]);
    // Delivered, but this browser is paired - and a paired worker keeps asking, because the
    // alarm is the only thing that wakes a stopped worker to collect a repair, tab or no tab.
    expect(worker.alarmClear).not.toHaveBeenCalled();

    await worker.closeTab(1);
    expect(worker.alarmClear).not.toHaveBeenCalledWith('clf-bridge-drain');
  });

  it('durably retries a lost command ACK after the service worker restarts', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const firstFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/ack') return response(503, { error: 'temporarily_unavailable' });
      return response(404, {});
    });
    const first = loadWorker({ local, session, fetch: firstFetch });
    const conversationId = '22222222-3333-4444-5555-666666666666';

    const attempted = await first.send({
      type: 'ack',
      id: 'resume-retry',
      status: 'sent',
      conversationId,
      client: 'page-one'
    });
    expect(attempted.ok).toBe(false);
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.settled ?? []).toEqual([]);

    const bodies: Array<Record<string, unknown>> = [];
    const secondFetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, committed: true });
      }
      return response(404, {});
    });
    const restarted = loadWorker({ local, session, fetch: secondFetch });
    await restarted.send({ type: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bodies).toEqual([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled).toEqual(['resume-retry']);
  });

  it('keeps a fresh command page journal behind its pending ACK after the route gets an id', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let ackHealthy = false;
    const postedEvents: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/commands/ack') {
        return ackHealthy ? response(200, { ok: true, committed: true }) : response(503, { error: 'retry' });
      }
      if (url.pathname === '/events') {
        postedEvents.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const tabId = 42;
    const documentId = 'command-document';
    const conversationId = '33333333-4444-5555-6666-777777777777';
    await worker.registerTab(tabId, documentId);

    await worker.send(
      { type: 'ack', id: 'cmd-gate', status: 'sent', client: 'command-page' },
      tabId,
      documentId
    );
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${documentId}` }
    ]);

    // The command result and its id-less observations may both survive a real fresh-chat
    // reload. They must migrate to the replacement document together or the later /c/<id>
    // bind would gate only the journal and let it overtake the still-pending command ACK.
    await worker.navigateTab(tabId, 'https://chatgpt.com/');
    const replacementDocument = `document-${tabId}-1`;
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${replacementDocument}` }
    ]);

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'user_message', time: 10, text: 'command bootstrap' } }]
      },
      tabId,
      replacementDocument
    );
    expect(postedEvents).toEqual([]);
    expect(session.data.commandAckOutbox).toMatchObject([{ id: 'cmd-gate', conversationId }]);
    expect(journalOf(session)).toHaveLength(1);

    ackHealthy = true;
    await worker.send({ type: 'status' }, tabId, replacementDocument);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postedEvents).toEqual([
      { conversationId, events: [expect.objectContaining({ kind: 'user_message', text: 'command bootstrap' })],
        recordingGenerations: [null] }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(journalOf(session)).toEqual([]);
  });

  it('keeps pre-conversation observations across page/service-worker reload and binds them when /c/<id> exists', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const first = loadWorker({ local, session });
    await first.send(
      {
        type: 'events',
        entries: [
          {
            conversationId: null,
            agent: null,
            event: { kind: 'user_message', time: Date.now(), text: 'opening requirement' }
          }
        ]
      },
      42
    );

    expect(journalOf(session)).toMatchObject([
      {
        conversationId: null,
        provisional: 'tab-42:document-42-0',
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);

    // Same Chrome tab after the page and service worker have both been recreated.
    const reloaded = loadWorker({ local, session });
    const bound = await reloaded.send(
      { type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      42
    );
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)).toMatchObject([
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provisional: null,
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);
  });

  it('keeps a fresh chat provisional journal through a real ChatGPT page reload', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'fresh prompt' } }]
      },
      42
    );
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-0', conversationId: null });

    await worker.navigateTab(42, 'https://chatgpt.com/');
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-1', conversationId: null });

    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const bound = await worker.send({ type: 'bind', conversationId }, 42);
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)[0]).toMatchObject({ provisional: null, conversationId });
  });

  it('does not lose an observation when two tabs wake a cold service worker at once', async () => {
    // Chrome shuts the worker down after seconds of idling, so two tabs reporting at the
    // same moment after that is ordinary, not exotic. Both handlers used to walk the cold
    // load path concurrently, and the second one assigned the journal it had read — before
    // the first one's write — straight over the global, discarding an entry the first tab
    // had already been told was durable.
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    local.lagMs = 40;
    session.lagMs = 40;
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    // Tab one starts the cold load. Tab two arrives while that load is still in flight, so
    // its own reads are issued before tab one's journal write and answered after it.
    const first = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 1, text: 'from tab one' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 2, text: 'from tab two' } }] },
      2
    );
    const answers = await Promise.all([first, second]);

    for (const answer of answers) expect(answer).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['from tab one', 'from tab two']);
  });

  it('serializes durable journal snapshots so an older slow write cannot erase a newer event', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });

    const first = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'A' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 2, text: 'B' } }] },
      2
    );
    const replies = await Promise.all([first, second]);

    for (const reply of replies) expect(reply).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['A', 'B']);
  });

  it('serializes live tab snapshots so a slow older write cannot forget a newer tab owner', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const first = worker.send({ type: 'activity', conversationId: a, since: 0 }, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send({ type: 'activity', conversationId: b, since: 0 }, 11);
    await Promise.all([first, second]);

    expect(session.data.tabConversations).toEqual({ '10': a, '11': b });
  });

  it('drains each conversation separately so navigation cannot file chat A observations into chat B', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posted: Array<{ conversationId: string; events: Array<{ text?: string }> }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') {
        posted.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await worker.send({
      type: 'events',
      entries: [
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A1' } },
        { conversationId: b, event: { kind: 'progress', time: Date.now(), text: 'B1' } },
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A2' } }
      ]
    });

    expect(posted).toEqual([
      { conversationId: a, events: [{ kind: 'progress', time: expect.any(Number), text: 'A1' }, { kind: 'progress', time: expect.any(Number), text: 'A2' }], recordingGenerations: [null, null] },
      { conversationId: b, events: [{ kind: 'progress', time: expect.any(Number), text: 'B1' }], recordingGenerations: [null] }
    ]);
    expect(journalOf(session)).toEqual([]);
  });

  it('delivers the triggering conversation journal before asking the app for a Goal draft', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let acceptEvents = false;
    const order: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') {
        order.push('/events');
        return acceptEvents
          ? response(200, { sessionId: 'session', stored: 1 })
          : response(503, { error: 'temporarily_unavailable' });
      }
      if (url.pathname === '/goal/draft') {
        order.push('/goal/draft');
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The page handed the final assistant row to the service worker, but the app was briefly
    // unavailable, so the row is durable only in the worker journal when Goal asks for its
    // continuation. Drafting before retrying /events would omit the very answer that triggered
    // the Goal turn from conversationMessages().
    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'the answer Goal must continue from',
              messageId: 'assistant-final',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      61
    );
    expect(journalOf(session)).toHaveLength(1);

    order.length = 0;
    acceptEvents = true;
    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-final' },
      61
    );

    expect(drafted).toMatchObject({ ok: true });
    expect(order).toEqual(['/events', '/goal/draft']);
    expect(journalOf(session)).toEqual([]);
  });

  it('carries the browser tab identity through Goal activity, draft and acknowledgement', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const seen: Array<{ route: string; client: string | null }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/activity') {
        seen.push({ route: url.pathname, client: url.searchParams.get('goalClient') });
        return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
      }
      if (url.pathname === '/goal/draft' || url.pathname === '/goal/ack') {
        const body = JSON.parse(String(init.body || '{}'));
        seen.push({ route: url.pathname, client: typeof body.clientId === 'string' ? body.clientId : null });
        return response(200, url.pathname.endsWith('/draft') ? { goal: { stage: 'drafting' } } : { acknowledged: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({ type: 'activity', conversationId, since: 0 }, 73);
    await worker.send({ type: 'goal_draft', conversationId, turnId: 'generation-owned' }, 73);
    await worker.send({ type: 'goal_ack', conversationId, token: 'goal-token' }, 73);

    expect(seen).toEqual([
      { route: '/activity', client: '73' },
      { route: '/goal/draft', client: '73' },
      { route: '/goal/ack', client: '73' }
    ]);
  });

  it('selects only the exact owned Goal tab without activating Chrome or opening a duplicate', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    await worker.registerTab(73);
    await worker.send({ type: 'bind', conversationId }, 73);

    expect(await worker.send({ type: 'focus_tab', conversationId, turnId: 'generation-owned' }, 73)).toMatchObject({
      ok: true,
      focused: true
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(73, { active: true });
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();

    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(await worker.send({ type: 'focus_tab', conversationId: other, turnId: 'wrong-chat' }, 73)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a Goal draft while the triggering transcript is still not deliverable', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let drafts = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return response(503, { error: 'temporarily_unavailable' });
      if (url.pathname === '/goal/draft') {
        drafts += 1;
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'still only in the browser journal',
              messageId: 'assistant-undelivered',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      62
    );
    expect(journalOf(session)).toHaveLength(1);

    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-undelivered' },
      62
    );

    expect(drafted).toMatchObject({
      ok: false,
      status: 503,
      error: 'transcript_not_delivered',
      retryable: true
    });
    expect(drafts).toBe(0);
    expect(journalOf(session)).toHaveLength(1);
  });

  it('closes a conversation only when its final browser tab is actually gone', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    for (const tabId of [10, 11]) {
      await worker.send(
        {
          type: 'events',
          conversationId,
          entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: `tab ${tabId}` } }]
        },
        tabId
      );
    }

    await worker.closeTab(10);
    expect(closed).toEqual([]);
    await worker.closeTab(11);
    expect(closed).toEqual([conversationId]);
  });

  it('relays one exact recorded-call disclosure only while its document and route stay current', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let tabUrl = `https://chatgpt.com/c/${conversationId}`;
    let tabStatus = 'complete';
    let pendingUrl: string | undefined;
    const detailBodies: unknown[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const path = new URL(input).pathname;
      if (path === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (path === '/activity/detail') {
        detailBodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, conversationId, callId: 'call-1', detailRevision: 17 });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch,
      tabsGet: async (id) => ({ id, url: tabUrl, status: tabStatus, ...(pendingUrl ? { pendingUrl } : {}) })
    });

    await worker.send({ type: 'bind', conversationId }, 63);
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: true, data: { callId: 'call-1', detailRevision: 17 } });
    expect(detailBodies).toEqual([{ conversationId, callId: 'call-1', detailRevision: 17 }]);

    await expect(worker.send({ type: 'activity_detail', conversationId, callId: ['call-1'], detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: false, status: 400, error: 'bad_activity_detail' });
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 0 }, 63))
      .resolves.toMatchObject({ ok: false, status: 400, error: 'bad_activity_detail' });
    await expect(worker.send({ type: 'activity_detail', conversationId: other, callId: 'call-1', detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: false, error: 'stale_document' });
    tabStatus = 'loading';
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: false, error: 'stale_document' });
    tabStatus = 'complete'; pendingUrl = tabUrl;
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: false, error: 'stale_document' });
    pendingUrl = undefined;
    tabUrl = `https://chatgpt.com/c/${other}`;
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 17 }, 63))
      .resolves.toMatchObject({ ok: false, error: 'stale_document' });
    expect(detailBodies).toHaveLength(1);
  });

  it('discards a recorded-call detail response if the browser route changes during the read', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let tabUrl = `https://chatgpt.com/c/${conversationId}`;
    const fetch = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (path === '/activity/detail') {
        tabUrl = `https://chatgpt.com/c/${other}`;
        return response(200, { ok: true, conversationId, callId: 'call-1', detailRevision: 17 });
      }
      return response(200, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(), fetch,
      tabsGet: async (id) => ({ id, url: tabUrl, status: 'complete' })
    });

    await worker.send({ type: 'bind', conversationId }, 64);
    await expect(worker.send({ type: 'activity_detail', conversationId, callId: 'call-1', detailRevision: 17 }, 64))
      .resolves.toMatchObject({ ok: false, error: 'stale_document' });
    expect(fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/activity/detail')).toHaveLength(1);
  });

  it.each(['absent', 'present', 'query-failed', 'same-chat', 'pending-chat', 'still-loading'])(
    'only closes a URL-redacted completed departure with positive absence: %s', async (mode) => {
      const conversationId = '11111111-2222-3333-4444-555555555555';
      const session = new FakeStorageArea();
      const closed: string[] = [];
      let completed = false;
      const worker = loadWorker({
        local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
        tabsGet: async () => ({ id: 12, status: completed && mode !== 'still-loading' ? 'complete' : 'loading',
          ...(mode === 'same-chat' ? { url: `https://chatgpt.com/c/${conversationId}` } : {}),
          ...(mode === 'pending-chat' ? { pendingUrl: `https://chatgpt.com/c/${conversationId}` } : {}) }),
        tabsQuery: async () => {
          if (mode === 'query-failed') throw new Error('query unavailable');
          return mode === 'present' ? [{ id: 12 }] : [];
        },
        fetch: async (input, init = {}) => {
          const path = new URL(input).pathname;
          if (path === '/hello') return response(200, { app: APP_SLUG, paired: true });
          if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
          return response(200, {});
        }
      });
      await worker.send({ type: 'bind', conversationId }, 12);
      await worker.startTabNavigation(12);
      expect(closed).toEqual([]);
      completed = true;
      await worker.completeTabNavigation(12);
      await worker.completeTabNavigation(12);
      expect(closed).toEqual(mode === 'absent' ? [conversationId] : []);
      expect(session.data.tabConversations).toEqual(mode === 'absent' ? {} : { '12': conversationId });
    }
  );

  it('does not let delayed departure absence release a newly registered document', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const session = new FakeStorageArea();
    const closed: string[] = [];
    let finishQuery!: (tabs: []) => void;
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      tabsGet: async () => ({ id: 12, status: 'complete' }),
      tabsQuery: () => new Promise((resolve) => { finishQuery = resolve; }),
      fetch: async (input, init = {}) => {
        const path = new URL(input).pathname;
        if (path === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, {});
      }
    });
    await worker.send({ type: 'bind', conversationId }, 12);
    await worker.startTabNavigation(12);
    await worker.completeTabNavigation(12);
    await worker.registerTab(12, 'replacement-document');
    finishQuery([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '12': conversationId });
    expect(session.data.tabDocuments).toMatchObject({ '12': 'replacement-document' });
  });

  it('uses the pending destination before an old committed ChatGPT URL', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }), session,
      tabsGet: async () => ({ id: 12, status: 'loading',
        url: `https://chatgpt.com/c/${conversationId}`, pendingUrl: 'https://example.com/away' }),
      fetch: async (input, init = {}) => {
        const path = new URL(input).pathname;
        if (path === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (path === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, {});
      }
    });
    await worker.send({ type: 'bind', conversationId }, 12);
    await worker.startTabNavigation(12);
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  it('closes a conversation when its tab survives but navigates away from ChatGPT', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: 'still here' } }]
      },
      12
    );
    await worker.navigateTab(12, 'https://example.com/elsewhere');

    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  /**
   * Typing chatgpt.com into a Prime's tab used to leave that chat bound to the tab until some
   * later chat happened to be given an id there, so the app never heard the page was gone and
   * never reopened it (2026-09-03). A full document load of any ChatGPT URL that is concretely
   * not the chat's own is the chat leaving; its own URL is the ambiguous reload it always was.
   */
  it('closes a conversation when its tab does a full navigation to another ChatGPT URL', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    await worker.send({ type: 'bind', conversationId }, 12);
    // A reload of the chat's own URL is not a departure.
    await worker.navigateTab(12, `https://chatgpt.com/c/${conversationId}`);
    expect(closed).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '12': conversationId });

    await worker.navigateTab(12, 'https://chatgpt.com/');
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  it('lets terminal navigation beat a delayed message from the dying document', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({ tabConversations: { '12': conversationId } });
    // Force both handlers through the same cold-worker load window. The browser event is
    // delivered first; stale content IPC arrives while storage is still resolving.
    session.lagMs = 40;
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'should-not-be-called', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const leaving = worker.navigateTab(12, 'https://example.com/elsewhere');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stale = await worker.send({ type: 'activity', conversationId, since: 0 }, 12);
    await leaving;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stale).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/activity')).toBe(false);
  });

  it('rejects the old document after an external round trip and lets only the new document own the tab', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-12-0';

    await worker.send({ type: 'bind', conversationId: a }, 12, oldDocument);
    await worker.navigateTab(12, 'https://example.com/away');
    await worker.navigateTab(12, `https://chatgpt.com/c/${b}`);

    expect(await worker.send({ type: 'activity', conversationId: a, since: 0 }, 12, oldDocument)).toMatchObject({
      ok: false,
      error: 'stale_document'
    });
    expect(await worker.send({ type: 'bind', conversationId: b }, 12)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '12': b });
    expect(closed).toEqual([a]);
  });

  it('tombstones a direct ChatGPT document navigation before the replacement document registers', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-19-0';

    await worker.send(
      {
        type: 'events',
        conversationId: null,
        entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'belongs only to A' } }]
      },
      19,
      oldDocument
    );
    await worker.send({ type: 'bind', conversationId: a }, 19, oldDocument);

    const navigating = worker.navigateTab(19, `https://chatgpt.com/c/${b}`);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 19, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 19)).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '19': b });
    expect(calls).toContain('/closed');
  });

  it('does not let the dying document revoke its terminal lease while Chrome is still navigating', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const target = `https://chatgpt.com/c/${b}`;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      // During a real navigation Chrome can still deliver IPC from the old document while
      // tabs.get already describes the destination. That message is not evidence the
      // navigation was a false-positive terminal prediction.
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: target, pendingUrl: target, status: 'loading' }))
    });
    const oldDocument = 'document-31-0';

    await worker.send({ type: 'bind', conversationId: a }, 31, oldDocument);
    const navigating = worker.navigateTab(31, target);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 31, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 31)).toMatchObject({ ok: true });
  });

  it('reopens a speculative terminal lease once Chrome proves the original document is settled', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: `https://chatgpt.com/c/${a}`, status: 'complete' }))
    });
    const documentId = 'document-32-0';

    await worker.send({ type: 'bind', conversationId: a }, 32, documentId);
    // Chrome emitted a speculative loading transition but the navigation was cancelled or
    // otherwise never replaced this document. Once tabs.get reports the page settled again,
    // its next message is the evidence that should reopen the lease.
    await worker.startTabNavigation(32, `https://chatgpt.com/c/${a}`);
    const recovered = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 32, documentId);

    expect(recovered).toMatchObject({ ok: true });
    expect(calls).toContain('/activity');
  });

  it('blocks the dying reload document without closing the same conversation', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-27-0';

    await worker.send({ type: 'bind', conversationId }, 27, oldDocument);
    const reloading = worker.navigateTab(27, `https://chatgpt.com/c/${conversationId}`);
    const dying = await worker.send({ type: 'activity', conversationId, since: 0 }, 27, oldDocument);
    await reloading;
    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });

    expect(await worker.send({ type: 'bind', conversationId }, 27)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '27': conversationId });
    expect(closed).toEqual([]);
  });

  it('keeps a terminal document tombstone across service-worker restart', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const oldDocument = 'document-44-old';
    const first = loadWorker({ local, session });
    await first.send({ type: 'bind', conversationId }, 44, oldDocument);
    await first.navigateTab(44, 'https://example.com/away');

    const restarted = loadWorker({ local, session });
    expect(
      await restarted.send({ type: 'compact', conversationId, resume: true }, 44, oldDocument)
    ).toMatchObject({ ok: false, error: 'tab_closed' });

    const newDocument = 'document-44-new';
    expect(await restarted.registerTab(44, newDocument)).toMatchObject({ ok: true });
    expect(await restarted.send({ type: 'bind', conversationId }, 44, newDocument)).toMatchObject({ ok: true });
  });

  it('does not bind an abandoned fresh chat into a later chat that reuses the tab', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'chat A opening' } }]
      },
      12
    );
    expect(journalOf(session)).toHaveLength(1);

    await worker.navigateTab(12, 'https://example.com/abandoned');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journalOf(session)).toEqual([]);

    // A later real ChatGPT navigation is a new document and clears the terminal tombstone.
    await worker.navigateTab(12, 'https://chatgpt.com/');
    const bound = await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    expect(bound).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
  });

  it('stays inside the count budget and leaves an explicit gap when progress has to be discarded', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(journal.length).toBeLessThanOrEqual(4000);
    expect(journal.some((entry) => entry.gap === true && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
  });

  it('evicts optional attested pixels without inventing worker progress or changing authored prose', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const url = `https://chatgpt.com/c/${conversationId}`;
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const captureId = 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
    const target = { messageId: 'assistant:page-pixel',
      providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      mediaId: 'media-n-0-1', nodeId: 'n-0-1' };
    const scanToken = 'pressure-pixel-scan';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posts: any[] = [];
    const worker = loadWorker({ local, session,
      tabsGet: async () => ({ id: 42, url, status: 'complete' }),
      fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, bridge: 17, paired: true, compatible: true });
        if (route === '/recording/generation') return response(200, { recordingGeneration });
        if (route === '/rich/pixel/begin') return response(200, { capture: {
          captureId, purpose: 'page_pixel', ...JSON.parse(String(init.body)),
          sessionId: 'physical-session', bindingRevision: 4, richRevision: 1,
          slotVersion: 0, sourceIncarnation: null, sourceSequence: null
        } });
        if (route === '/events') { posts.push(JSON.parse(String(init.body))); return response(503, {}); }
        return response(503, {});
      } });
    await worker.registerTab(42, 'pixel-document');
    expect((await worker.send({ type: 'recording_generation', navigationEpoch: 0 },
      42, 'pixel-document', url)).recordingGeneration).toBe(recordingGeneration);
    expect((await worker.send({ type: 'rich_pixel_begin', conversationId,
      recordingGeneration, navigationEpoch: 0, ...target }, 42, 'pixel-document', url)).ok).toBe(true);
    const pixel = { conversationId, agent: 'worker-1', agentCommandId: 'exact-worker-command',
      recordingGeneration, recordingNavigationEpoch: 0,
      pixelSeal: { captureId, scanToken, ...target,
        rootStamp: `${scanToken}:0:${encodeURIComponent(target.messageId)}:${encodeURIComponent(target.providerMessageId)}`,
        sourceIncarnation: `src_${'a'.repeat(32)}_1`, sourceSequence: 1,
        status: 'pending', pixelBytes: null, pixelSha256: null },
      event: { kind: 'rich_media', time: Date.now(), ...target, status: 'pending' } };
    expect((await worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: [pixel] }, 42, 'pixel-document', url)).durable).toBe(true);
    expect(journalOf(session)[0]).toMatchObject({ agentCommandId: 'exact-worker-command',
      pixelReceipt: { captureId, status: 'pending' } });

    // Real progress may carry the exact worker command, but a *later synthetic*
    // loss marker cannot borrow that same worker authority after both optional
    // progress rows and their neighboring pixel have been evicted.
    const genuineProgress = Array.from({ length: 2 }, (_, index) => ({
      conversationId, agent: 'worker-1', agentCommandId: 'exact-worker-command',
      recordingGeneration, recordingNavigationEpoch: 0,
      event: { kind: 'progress', time: Date.now(), text: `real worker progress ${index}` }
    }));
    expect((await worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: genuineProgress }, 42, 'pixel-document', url)).durable).toBe(true);
    expect(posts.some(post => post.agent === 'worker-1' &&
      post.agentCommandId === 'exact-worker-command' &&
      post.events.some((event: any) => event.text === 'real worker progress 0'))).toBe(true);

    const prose = (index: number) => ({ conversationId, recordingGeneration,
      recordingNavigationEpoch: 0,
      event: { kind: 'user_message', time: Date.now(), messageId: `user-${index}`,
        text: `authored prose ${index}` } });
    posts.length = 0;
    expect((await worker.send({ type: 'events', conversationId, navigationEpoch: 0,
      entries: Array.from({ length: 3999 }, (_, index) => prose(index)) },
    42, 'pixel-document', url)).durable).toBe(true);

    const retained = journalOf(session);
    expect(retained).toHaveLength(4000);
    expect(retained[0]).toMatchObject({ conversationId, provisional: null,
      agent: null, agentCommandId: null, gap: true,
      event: { kind: 'progress', text: expect.stringMatching(/2 progress line\(s\).*dropped/) } });
    expect(retained.slice(1).every(row => row.event.kind === 'user_message' && row.gap !== true &&
      row.agent === null && row.agentCommandId === null && row.pixelReceipt === null)).toBe(true);
    expect(retained.slice(1).map(row => row.event.text)).toEqual(
      Array.from({ length: 3999 }, (_, index) => `authored prose ${index}`));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every(post => post.agent == null && post.agentCommandId == null &&
      post.events.every((event: any) => event.kind === 'user_message' || event.kind === 'progress'))).toBe(true);
    expect(posts.some(post => post.events.some((event: any) => event.kind === 'progress'))).toBe(true);
    expect(posts.every(post => post.events.every((event: any) => event.kind !== 'chat_error' &&
      event.kind !== 'rich_media'))).toBe(true);
  });

  it('keeps queue-pressure gap evidence scoped to every affected chat and provisional route', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const tabId = 42;
    const provisional = `tab-${tabId}:document-${tabId}-0`;
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 3 === 0 ? chatA : index % 3 === 1 ? chatB : null,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries }, tabId);
    let journal = journalOf(session);
    const gaps = journal.filter((entry) => entry.gap === true);
    expect(gaps.some((entry) => entry.conversationId === chatA && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === null && entry.provisional === provisional)).toBe(true);

    const freshChat = 'cccccccc-1111-2222-3333-444444444444';
    await worker.send({ type: 'bind', conversationId: freshChat }, tabId);
    journal = journalOf(session);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === freshChat && entry.provisional === null)).toBe(true);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === null && entry.provisional === provisional)).toBe(false);
  });

  it('keeps essential-loss markers scoped to each affected conversation', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'dddddddd-1111-2222-3333-444444444444';
    const chatB = 'eeeeeeee-1111-2222-3333-444444444444';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 2 === 0 ? chatA : chatB,
      event: { kind: 'user_message', time: Date.now(), text: `essential ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const gaps = journalOf(session).filter((entry) => entry.gap === true && entry.event.kind === 'chat_error');
    expect(gaps.some((entry) => entry.conversationId === chatA && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
  });

  it('stays inside the journal byte budget under large observations', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '99999999-8888-7777-6666-555555555555';
    // Four UTF-8 bytes but only two UTF-16 code units each. The old string-length budget
    // undercounted this journal by half and could acknowledge more than Chrome could store.
    const blob = '🧠'.repeat(2500);
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${blob}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(Buffer.byteLength(JSON.stringify(journal), 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(journal.some((entry) => entry.gap === true)).toBe(true);
  });

  it('replaces a single unhalvable 413 observation with an explicit durable gap', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const received: any[] = [];
    let rejected = false;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/events') {
        const body = JSON.parse(String(init.body));
        if (!rejected) {
          rejected = true;
          return response(413, { error: 'body_too_large' });
        }
        received.push(...body.events);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({
      type: 'events',
      conversationId: '11111111-2222-3333-4444-555555555555',
      entries: [{
        conversationId: '11111111-2222-3333-4444-555555555555',
        event: { kind: 'assistant_message', time: 1, text: 'x'.repeat(600_000) }
      }]
    });

    expect(journalOf(session)).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'chat_error' });
    expect(received[0].text).toMatch(/too large.*explicit gap/i);
  });

  it('retires a single 413 pixel without generating a worker-bearing chat error', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const captured: any[] = [];
    const session = new FakeStorageArea({ journal: [{
      conversationId, provisional: null, agent: 'worker-1', agentCommandId: 'exact-worker-command',
      recordingGeneration: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      pixelReceipt: { captureId: 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP' },
      event: { kind: 'rich_media', time: Date.now(), messageId: 'assistant:page-pixel',
        providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
        mediaId: 'media-n-0-1', nodeId: 'n-0-1', status: 'pending' }
    }] });
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (route === '/events') {
          captured.push(JSON.parse(String(init.body)));
          return response(413, { error: 'body_too_large' });
        }
        return response(503, {});
      } });
    await worker.send({ type: 'drain' });
    expect(captured).toHaveLength(1);
    expect(captured[0].events).toMatchObject([{ kind: 'rich_media', status: 'pending' }]);
    expect(journalOf(session)).toEqual([]);
  });

  it('does not manufacture a worker chat error when storage refuses an optional pixel journal', async () => {
    const pixel = { conversationId: '11111111-2222-3333-4444-555555555555',
      provisional: null, agent: 'worker-1', agentCommandId: 'exact-worker-command',
      recordingGeneration: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      event: { kind: 'rich_media', time: Date.now(), messageId: 'assistant:page-pixel',
        providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
        mediaId: 'media-n-0-1', nodeId: 'n-0-1', status: 'pending' } };
    // This is a restored pending journal fixture: the test targets the persistence
    // failure owner, independent from separate Chrome ticket/receipt admission.
    const session = new FakeStorageArea({ journal: [pixel] });
    const worker = loadWorker({ local: new FakeStorageArea(), session });
    await worker.registerTab(42, 'pixel-document');
    session.failNextSets = 2;
    expect((await worker.send({ type: 'events', entries: [] }, 42, 'pixel-document')).durable).toBe(false);
    expect((await worker.send({ type: 'events', entries: [] }, 42, 'pixel-document')).durable).toBe(true);
    expect(journalOf(session)).toEqual([pixel]);
  });

  it('does not promote mixed pixel and real worker progress into worker-bearing chat error after double storage failure', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const route = { conversationId, provisional: null,
      agent: 'worker-1', agentCommandId: 'exact-worker-command', recordingGeneration };
    const pixel = { ...route, event: { kind: 'rich_media', time: Date.now(),
      messageId: 'assistant:page-pixel', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
      mediaId: 'media-n-0-1', nodeId: 'n-0-1', status: 'pending' } };
    const progress = { ...route, event: { kind: 'progress', time: Date.now(), text: 'real worker progress' } };
    const session = new FakeStorageArea({ journal: [pixel, progress] });
    const worker = loadWorker({ local: new FakeStorageArea(), session });
    await worker.registerTab(42, 'pixel-document');
    session.failNextSets = 2;
    expect((await worker.send({ type: 'events', entries: [] }, 42, 'pixel-document')).durable).toBe(false);
    expect((await worker.send({ type: 'events', entries: [] }, 42, 'pixel-document')).durable).toBe(true);
    expect(journalOf(session)).toEqual([
      pixel, progress,
      { ...route, agent: null, agentCommandId: null, gap: true,
        event: { kind: 'chat_error', time: expect.any(Number),
          text: expect.stringMatching(/browser refused to store.*pending observations/) } }
    ]);
    const genuine = { type: 'events', conversationId,
      entries: [{ conversationId, agent: 'worker-1', agentCommandId: 'exact-worker-command',
        event: { kind: 'chat_error', time: Date.now(), text: 'Actual page error' } }] };
    expect((await worker.send(genuine, 42, 'pixel-document')).durable).toBe(true);
    expect(journalOf(session).at(-1)).toMatchObject({ conversationId,
      agent: 'worker-1', agentCommandId: 'exact-worker-command',
      event: { kind: 'chat_error', text: 'Actual page error' } });
    expect(journalOf(session).at(-1)).not.toHaveProperty('gap');
  });

  it.each([413, 422])('retains the error marker but drops worker command identity after HTTP %i rejects progress', async status => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const original = { conversationId, provisional: null,
      agent: 'worker-1', agentCommandId: 'exact-worker-command',
      recordingGeneration: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      event: { kind: 'progress', time: Date.now(), text: 'Real worker progress' } };
    const session = new FakeStorageArea({ journal: [original] });
    const sent: any[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (route === '/events') {
          sent.push(JSON.parse(String(init.body)));
          return response(sent.length === 1 ? status : 200, { stored: 1 });
        }
        return response(503, {});
      } });
    await worker.send({ type: 'drain' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ conversationId, agent: 'worker-1',
      agentCommandId: 'exact-worker-command', events: [{ kind: 'progress', text: 'Real worker progress' }] });
    expect(sent[1]).toMatchObject({ conversationId,
      events: [{ kind: 'chat_error', text: expect.stringMatching(/explicit gap/) }] });
    expect(sent[1]).not.toHaveProperty('agent');
    expect(sent[1]).not.toHaveProperty('agentCommandId');
    expect(journalOf(session)).toEqual([]);
  });

  it('never borrows a surviving pixel command for a neighboring synthetic loss marker', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const recordingGeneration = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const session = new FakeStorageArea({ journal: [
      { conversationId, provisional: null, agent: 'worker-1', agentCommandId: 'exact-worker-command',
        recordingGeneration, pixelReceipt: { captureId: 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP' },
        event: { kind: 'rich_media', time: Date.now(), messageId: 'assistant:page-pixel',
          providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
          mediaId: 'media-n-0-1', nodeId: 'n-0-1', status: 'pending' } },
      { conversationId, provisional: null, agent: null, agentCommandId: null,
        recordingGeneration, gap: true,
        event: { kind: 'chat_error', time: Date.now(), text: 'A browser observation was lost' } },
      { conversationId, provisional: null, agent: 'worker-1', agentCommandId: 'exact-worker-command',
        recordingGeneration, event: { kind: 'progress', time: Date.now(), text: 'Authentic progress after loss' } }
    ] });
    const posts: any[] = [];
    const worker = loadWorker({ local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session, fetch: async (address, init = {}) => {
        const route = new URL(address).pathname;
        if (route === '/hello') return response(200, { app: APP_SLUG, paired: true });
        if (route === '/events') {
          posts.push(JSON.parse(String(init.body)));
          return response(200, { stored: 1 });
        }
        return response(503, {});
      } });
    await worker.send({ type: 'drain' });
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({ conversationId,
      events: [{ kind: 'rich_media', status: 'pending' }] });
    expect(posts[0]).not.toHaveProperty('agent');
    expect(posts[0]).not.toHaveProperty('agentCommandId');
    expect(posts[0].richPixelReceipts).toHaveLength(1);
    expect(posts[1]).toMatchObject({ conversationId,
      events: [{ kind: 'chat_error', text: 'A browser observation was lost' }] });
    expect(posts[1]).not.toHaveProperty('agent');
    expect(posts[1]).not.toHaveProperty('agentCommandId');
    expect(posts[1]).not.toHaveProperty('richPixelReceipts');
    expect(posts[2]).toMatchObject({ conversationId,
      agent: 'worker-1', agentCommandId: 'exact-worker-command',
      events: [{ kind: 'progress', text: 'Authentic progress after loss' }] });
    expect(journalOf(session)).toEqual([]);
  });

  it('tightens and retries when Chrome rejects a session-storage write', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    // Below the journal's normal 4 MiB target but above its tightened 3 MiB target,
    // purely to force the "write rejected → compact harder → retry" path.
    session.maxBytes = 3_500_000;
    const worker = loadWorker({ local, session });
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const entries = Array.from({ length: 3200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${'y'.repeat(1500)}` }
    }));

    const reply = await worker.send({ type: 'events', entries });
    expect(reply.durable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(session.data), 'utf8')).toBeLessThanOrEqual(3_500_000);
  });
});

// ---------------------------------------------------------------- connecting

/**
 * How this browser gets, keeps and gives up a credential.
 *
 * All three of these were the same shape of bug: a decision taken once being quietly
 * retaken a couple of seconds later by a poll that runs in every open tab.
 */
describe('extension connection', () => {
  /** Records every request the worker makes, and answers them the way the app would. */
  function app(): {
    calls: string[];
    fetch: (input: string, init?: Record<string, unknown>) => Promise<any>;
    tokens: number;
  } {
    const state = {
      calls: [] as string[],
      tokens: 0,
      async fetch(input: string) {
        state.calls.push(input);
        if (input.endsWith('/hello')) return response(200, { app: APP_SLUG, paired: true });
        if (input.endsWith('/pair')) {
          state.tokens++;
          return response(200, { token: `token-${state.tokens}` });
        }
        return response(200, {});
      }
    };
    return state;
  }

  /**
   * `/pair` mints a fresh credential and invalidates the one before it, so two callers
   * arriving together do not get two tokens — they get one working token and one that
   * has already been revoked, and then each 401 provisions again.
   */
  it('mints one token however many callers ask at once', async () => {
    const server = app();
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea(), fetch: server.fetch });

    await Promise.all([
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' })
    ]);
    expect(server.tokens).toBe(1);
  });

  /**
   * A `/hello` in front of every authenticated request doubled the traffic of a poll that
   * already runs every two seconds in every open tab, against a 900/min budget.
   */
  it('forwards an exact live request ownership handshake and returns the app read-back', async () => {
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const requestId = 'f0f00009-1111-4111-8111-111111111111';
    let body: any = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/correlations') {
        body = JSON.parse(String(init.body));
        return response(200, {
          ok: true,
          conversationId,
          sessionId: '2026-08-21-live',
          requestIds: [requestId],
          confirmed: [requestId],
          complete: true
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch,
      tabsGet: async (id) => ({ id, url: `https://chatgpt.com/c/${conversationId}` })
    });

    const reply = await worker.send({
      type: 'correlate',
      conversationId,
      calls: [{ messageId: 'request-message', tool: 'exec_command', order: 0, answered: false, requestId }]
    });

    expect(body).toMatchObject({
      conversationId,
      calls: [expect.objectContaining({ requestId, messageId: 'request-message' })]
    });
    expect(reply).toMatchObject({
      ok: true,
      status: 200,
      data: { conversationId, confirmed: [requestId], complete: true }
    });
  });

  it('does not publish request ownership from a document on another conversation route', async () => {
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const otherConversationId = '11111111-2222-3333-4444-555555555555';
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const pathname = new URL(input).pathname;
      requested.push(pathname);
      return pathname === '/hello'
        ? response(200, { app: APP_SLUG, paired: true })
        : response(200, { ok: true });
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch,
      tabsGet: async (id) => ({ id, url: `https://chatgpt.com/c/${otherConversationId}` })
    });

    await expect(worker.send({
      type: 'correlate',
      conversationId,
      calls: [{ messageId: 'request-message', tool: 'exec_command', order: 0, answered: false,
        requestId: 'f0f00009-1111-4111-8111-111111111111' }]
    })).resolves.toMatchObject({ ok: false, error: 'stale_document' });
    expect(requested).not.toContain('/correlations');
  });

  it('does not re-ask where the app is before every single request', async () => {
    const server = app();
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    for (let n = 0; n < 5; n++) {
      await worker.send({ type: 'activity', conversationId: 'abababab-cdcd-efef-1212-343434343434', since: 0 });
    }
    const hellos = server.calls.filter((url) => url.endsWith('/hello'));
    expect(hellos.length).toBeLessThanOrEqual(1);
    expect(server.calls.filter((url) => url.includes('/activity'))).toHaveLength(5);
  });

  it('stays disconnected once it has been disconnected', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    await worker.send({ type: 'status' });
    expect(server.tokens).toBe(1);

    await worker.send({ type: 'unpair' });
    expect(local.data.disconnected).toBe(true);

    // The two things that used to undo it: the next poll from a tab, and opening the
    // popup to check. Neither is a request to connect.
    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });
    expect(activity.ok).toBe(false);
    expect(activity.error).toBe('disconnected');
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(false);
    expect(status.disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('does not silently re-pair after the app explicitly disconnects this browser', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'should-never-be-minted' });
      }
      if (url.pathname === '/activity') return response(401, { error: 'browser_disconnected' });
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });

    expect(activity).toMatchObject({ ok: false, status: 401, error: 'disconnected' });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);

    // Opening the popup after the failed poll is observation, not reconnect intent.
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(pairCalls).toBe(0);
  });

  it('mirrors an app-side disconnect from hello before the popup can report a stale pair', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, { app: APP_SLUG, paired: false, disconnected: true });
      }
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'must-not-auto-pair' });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'old-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: true,
      paired: false,
      disconnected: true
    });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);
  });

  it('does not let an older in-flight connect undo a later Disconnect', async () => {
    let releasePair!: () => void;
    let pairStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pairStarted = resolve;
    });
    const pairGate = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: false });
      if (url.pathname === '/pair') {
        pairStarted();
        await pairGate;
        return response(200, { token: 'late-token' });
      }
      return response(200, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    // Status auto-connects a never-paired browser. Disconnect wins when the user clicks it
    // after that request has already left, even if the old /pair answer arrives afterwards.
    const connecting = worker.send({ type: 'status' });
    await started;
    expect(await worker.send({ type: 'unpair' })).toMatchObject({ ok: true });
    expect(local.data.disconnected).toBe(true);
    releasePair();
    await connecting;

    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
  });

  /** Persisted in `local`, not `session`: a choice a restart undoes is not a choice. */
  it('is still disconnected after the worker has been shut down and restarted', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    await first.send({ type: 'status' });
    await first.send({ type: 'unpair' });

    const second = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    expect((await second.send({ type: 'status' })).disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('connects again when the user asks it to, and only then', async () => {
    const pairBodies: unknown[] = [];
    const server = app();
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      if (input.endsWith('/pair')) pairBodies.push(JSON.parse(String(init.body ?? '{}')));
      return server.fetch(input, init);
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    await worker.send({ type: 'status' });
    await worker.send({ type: 'unpair' });

    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(true);
    expect(status.disconnected).toBe(false);
    expect(local.data.disconnected).toBe(false);
    expect(pairBodies).toEqual([{}, { reconnect: true }]);
  });

  it('forces an immediate overwrite in known and newly discovered ChatGPT tabs', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: app().fetch });
    await worker.send({ type: 'bind', conversationId: '11111111-2222-3333-4444-555555555555' }, 11);
    await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    worker.tabsQuery.mockResolvedValueOnce([{ id: 12 }, { id: 13 }]);

    const result = await worker.send({ type: 'overwriteNow' });

    expect(result).toMatchObject({ ok: true, tabs: 3, attempted: 3 });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(3);
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(11, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(12, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(13, { type: 'clf-overwrite-now' });
  });
});

/**
 * A CSS `animation` naming keyframes nobody wrote is not an error. The declaration parses,
 * the name resolves to nothing, and the element simply appears — which is how the settings
 * menu and the hover bubble both shipped with `clf-pop-in` on them and no fade at all,
 * beside a page whose own popovers fade. Nothing in the browser will ever say so, so this
 * asks the stylesheet the question instead: everything it animates, it defines.
 */
describe('the overlay stylesheet', () => {
  it('defines every animation it asks for', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!));
    // Every animation this stylesheet owns is namespaced, so the name is the one token in
    // the shorthand that starts with `clf-`; durations, easings and `none` are not.
    const used = new Set(
      [...css.matchAll(/^[ 	]*animation(?:-name)?[ 	]*:([^;]+);/gm)]
        .flatMap((match) => match[1]!.split(/[\s,]+/))
        .filter((token) => token.startsWith('clf-'))
    );

    expect(used.size, 'the stylesheet animates nothing — has the namespace changed?').toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('wraps long recorded call lines inside their disclosure panel', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const rule = /\.clf-stream-recorded-detail\s+pre\s*\{([^}]+)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/overflow:\s*auto/);
  });
});

/**
 * The one request this worker makes that waits on a model rather than on the app.
 *
 * A goal written on a New Chat has no conversation to stream a draft onto, so `/goal/open`
 * holds the connection open for a whole OpenRouter completion — which the app allows 180s
 * for. This worker allowed every request ten seconds. A completion that took longer was
 * therefore abandoned here while the app went on to finish it: the account was billed for an
 * answer, the reply arrived with nobody left to receive it, and the page reported the
 * platform's opaque "signal is aborted without reason" and stopped. That is the shape these
 * tests pin — the deadline, and what a deadline is allowed to mean.
 */
describe('the goal opening, which waits on a model', () => {
  const paired = { port: 8765, token: 'paired-token' };

  /** A worker whose `/goal/open` never answers on its own, and the signal it was handed. */
  function hangingApp() {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: APP_SLUG, paired: true });
      if (url.pathname === '/goal/open') {
        const signal = init.signal as AbortSignal;
        seen.signal = signal;
        return await new Promise<ReturnType<typeof response>>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return response(404, {});
    });
    return { fetch, seen };
  }

  it('waits past the ordinary request deadline, because the app is still allowed to answer', async () => {
    vi.useFakeTimers();
    try {
      const { fetch, seen } = hangingApp();
      const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
      await worker.registerTab(5);
      const pending = worker.send({ type: 'goal_open', text: 'ship the release' }, 5);

      // Comfortably past the ten seconds every other route gets, and still inside the 180s
      // the app itself allows the model. Giving up here is the whole bug.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(seen.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(120_000);
      const reply = await pending;
      // Past the app's own deadline it does end — but as a deadline, not as prose, and as
      // something worth asking again rather than a verdict.
      expect(reply).toMatchObject({ ok: false, status: 0, retryable: true });
      expect(String(reply.error)).toContain('took too long');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The deadline this worker enforces has to stay above the one the app enforces, or the app's
   * own error handling never gets to speak. Read from both files rather than restated, because
   * the regression was precisely the two numbers drifting apart.
   */
  it('keeps its deadline above the app’s own model timeout', async () => {
    const goalSource = await fs.readFile(path.join(process.cwd(), 'src', 'main', 'goal.ts'), 'utf8');
    const appMs = Number(/const REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(goalSource)?.[1]?.replace(/_/g, ''));
    const workerMs = Number(
      /const MODEL_REQUEST_TIMEOUT_MS = ([\d_]+);/.exec(backgroundSource)?.[1]?.replace(/_/g, '')
    );
    expect(Number.isFinite(appMs)).toBe(true);
    expect(workerMs).toBeGreaterThan(appMs);
    // And it is the goal opening that spends it. Nothing else here waits on a model.
    expect(backgroundSource).toContain("await call('/goal/open', {\n      method: 'POST',\n      timeoutMs: MODEL_REQUEST_TIMEOUT_MS,");
  });
});


it.each(['matching', 'wrong-document', 'unsafe-draft', 'newer-navigation', 'pinned', 'pinned-before-proof', 'pinned-during-proof'])('retires a cancelled helper only under its exact safe claim: %s', async scenario => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, active: false, pinned: scenario === 'pinned' };
  const claims = [{ id: 'old-input', owner: '71:doc:0', conversationId }, { id: 'new-input', owner: '71:doc:0', conversationId }];
  const tabsRemove = vi.fn();
  const sendMessage = vi.fn(async (..._args: unknown[]) => {
    if (scenario === 'pinned-during-proof') tab.pinned = true;
    return { safe: scenario !== 'unsafe-draft', conversationId, navigationEpoch: 0 };
  });
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('), backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    conversationFromUrl: (url: string) => url.split('/c/')[1], tabDocuments: { '71': scenario === 'wrong-document' ? 'replacement' : 'doc' },
    tabEpochs: { '71': 0 }, ownsDocument: () => true, journalCountForConversation: () => 0,
    tabReply: (...args: unknown[]) => sendMessage(...args),
    chrome: { tabs: { get: async () => ({ ...tab, pinned: tab.pinned || scenario === 'pinned-before-proof', ...(scenario === 'newer-navigation' ? { pendingUrl: 'https://chatgpt.com/' } : {}) }),
      sendMessage, remove: tabsRemove } }
  });
  await prune([tab], { managedConversations: [conversationId], retiredConversations: [conversationId], cancelledDecisionClaims: claims }, new Set(), new Set());
  expect(tabsRemove).toHaveBeenCalledTimes(scenario === 'matching' ? 1 : 0);
  if (scenario === 'matching') expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ cancelledDecisions: claims });
});

it.each(['idle', 'selected', 'selected-before-proof', 'selected-during-proof', 'draft', 'pinned', 'navigation', 'journal'])('releases an idle page only while its document remains unused: %s', async scenario => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, active: scenario === 'selected', pinned: scenario === 'pinned' };
  const remove = vi.fn();
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('), backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  let probed = false;
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    conversationFromUrl: (url: string) => url.split('/c/')[1], tabDocuments: { '71': 'doc' },
    tabEpochs: { '71': 0 }, ownsDocument: () => true,
    journalCountForConversation: () => scenario === 'journal' && probed ? 1 : 0,
    tabReply: async () => {
      probed = true;
      if (scenario === 'selected-during-proof') tab.active = true;
      return { safe: scenario !== 'draft', conversationId, navigationEpoch: 0 };
    },
    chrome: { tabs: { get: async () => ({ ...tab, active: tab.active || scenario === 'selected-before-proof',
      ...(scenario === 'navigation' && probed ? { pendingUrl: 'https://chatgpt.com/' } : {}) }), remove } }
  });
  await prune([tab], { managedConversations: [conversationId] }, new Set(), new Set([conversationId]));
  expect(remove).toHaveBeenCalledTimes(scenario === 'idle' ? 1 : 0);
});

it.each([
  { name: 'just read then switched away', age: 0, close: false },
  { name: 'one millisecond before grace expires', age: 299_999, close: false },
  { name: 'exact grace boundary', age: 300_000, close: true },
  { name: 'old access', age: 600_000, close: true },
  { name: 'absent timestamp', timestamp: undefined, close: true },
  { name: 'invalid timestamp', timestamp: NaN, close: true },
  { name: 'infinite timestamp', timestamp: Infinity, close: true },
  { name: 'zero timestamp', timestamp: 0, close: true },
  { name: 'negative timestamp', timestamp: -1, close: true },
  { name: 'future timestamp', age: -1, close: true },
  { name: 'read and left before proof', age: 600_000, freshAt: 1, close: false },
  { name: 'read and left during proof', age: 600_000, freshAt: 2, close: false },
  { name: 'explicit retired cleanup', age: 0, retired: true, close: true },
  { name: 'surplus copy cleanup', age: 10, duplicate: true, close: true }
])('honors tab-local reading intent without changing separate retirement authority: $name', async scenario => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const now = 1_800_000_000_000;
  const tab = { id: 71, url: `https://chatgpt.com/c/${conversationId}`, active: false, pinned: false,
    lastAccessed: 'age' in scenario ? now - scenario.age! : scenario.timestamp };
  const remove = vi.fn();
  const proof = vi.fn(async () => ({ safe: true, conversationId, navigationEpoch: 0 }));
  let snapshots = 0;
  const get = vi.fn(async () => ({ ...tab,
    lastAccessed: ++snapshots === scenario.freshAt ? now : tab.lastAccessed }));
  const code = backgroundSource.slice(backgroundSource.indexOf('async function pruneManagedTabs('),
    backgroundSource.indexOf('\nfunction maintain(', backgroundSource.indexOf('async function pruneManagedTabs(')));
  const prune = vm.runInNewContext(`${code}\npruneManagedTabs`, {
    Date: { now: () => now },
    cleanConversationId: (id: string) => id, conversationForTab: () => conversationId,
    conversationFromUrl: (url: string) => url.split('/c/')[1], tabDocuments: { '71': 'doc' },
    tabEpochs: { '71': 0 }, ownsDocument: (source: { tab: number }) => source.tab === 71,
    journalCountForConversation: () => 0, tabReply: proof, chrome: { tabs: { get, remove } }
  });
  const policy = { managedConversations: [conversationId], idleCloseAfterMs: 300_000,
    retiredConversations: scenario.retired ? [conversationId] : [],
    conversationActivityAt: { [conversationId]: now - 3_600_000 } };
  const tabs = scenario.duplicate ? [tab, { ...tab, id: 72, lastAccessed: now }] : [tab];
  const remaining = await prune(tabs, policy, new Set(), new Set([conversationId]));
  expect(remove.mock.calls).toEqual(scenario.close ? [[71]] : []);
  expect(remaining.map((held: { id: number }) => held.id)).toEqual(
    scenario.close ? tabs.filter(held => held.id !== 71).map(held => held.id) : tabs.map(held => held.id));
  if (scenario.freshAt === 1) expect(proof).not.toHaveBeenCalled();
  if (scenario.freshAt === 2) expect(proof).toHaveBeenCalledOnce();
  expect(policy.conversationActivityAt[conversationId]).toBe(now - 3_600_000);
});
