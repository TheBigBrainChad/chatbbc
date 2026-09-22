// Ordinary Crystal Studio flow in the production renderer.
// Launches Vite plus the real renderer modules and drives Chromium input.
// No provider, credentials, or Hyprland changes. Run: node scripts/verify-crystal-workspace.cjs
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const extra = process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu', '--in-process-gpu'] : [];
  const { status } = require('node:child_process').spawnSync(require('electron'), [__filename, ...extra], { env, stdio: 'inherit', windowsHide: true });
  process.exit(status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/crystal-workspace');
app.setPath('userData', path.join(output, 'runtime'));

function message(seq, text) {
  return {
    seq, time: seq, source: 'extension', kind: 'user_message', messageId: 'm' + seq,
    authoredText: text, message: { text, chars: text.length, truncated: false }
  };
}

const eventsA = Array.from({ length: 240 }, (_, index) => {
  const seq = index + 1;
  const text = seq === 1 ? 'OLDER_PAGE_A' : seq === 240 ? 'LIVE_PAGE_A' : 'note ' + seq;
  return message(seq, text);
});
const eventsB = [message(1, 'LIVE_PAGE_B')];

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    window.fixtureErrors = [];
    window.addEventListener('error', event => window.fixtureErrors.push(event.error?.stack || event.message));
    window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(event.reason?.stack || String(event.reason)));
    localStorage.removeItem('chatbbc.sidebar-order');
    localStorage.removeItem('cos.ui.language');
    const config = {
      roots: [{ name: 'demo', path: '/tmp/crystal-demo' }], readOnly: true,
      capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false, command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
      tunnel: { kind: 'openai', tunnelId: 'tunnel_0123456789abcdef0123456789abcdef', desktopTunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'dark', tabsToKeepOpen: 7, finishAction: 'notify', planBackend: 'chatgpt' },
      sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
      compaction: { auto: true, autoTokens: 300000 },
      multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: false },
      goal: { enabled: false, model: 'fixture', reasoning: 'default', prompt: 'Fixture' }
    };
    const state = {
      config, hasApiKey: true, hasGoalKey: false, hasCustomProviderKey: false, resolvedBinary: null, bundledTunnelVersion: null,
      platform: { family: 'linux', name: 'Linux', desktopAutomation: false },
      secureStorage: { available: true, backend: 'secret-service', detail: null },
      status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
      bridge: { running: false, port: 0, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
      update: { current: '2.0.9', latest: null, stage: 'idle', error: null, checkedAt: null },
      omarchy: { generation: 0, theme: null, diagnostic: null },
      glass: { mode: 'atmospheric', transparent: false, diagnostic: null }, glassGeneration: 0
    };
    const project = { id: 'demo-project', name: 'Crystal', path: '/tmp/crystal-demo', createdAt: 1 };
    const summary = (id, title, extra) => ({
      id, title, projectId: project.id, conversationId: 'chat-' + id, chatIds: ['chat-' + id],
      startedAt: 1, updatedAt: 10, endedAt: null, events: 1, userMessages: 1, toolCalls: 0,
      lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
      estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null,
      activeTurnId: null, agents: [], origin: null,
      selectedModel: { conversationId: 'chat-' + id, model: 'gpt-6-astra', reasoningEffort: 'high', observedAt: 2 }, ...extra
    });
    const chatA = summary('task-a', 'Chat A');
    const chatB = summary('task-b', 'Chat B');
    const worker = summary('worker-1', 'Worker note', { origin: { kind: 'worker', fromSessionId: 'task-a', agentId: 'worker-1', task: 'Inspect the notes' } });
    const eventsA = ${JSON.stringify(eventsA)};
    const eventsB = ${JSON.stringify(eventsB)};
    const catalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'], aliases: [] }] };
    const usage = { contextTokenCap: 1000, limits: [], days: [{ date: '2026-09-21', tokens: 12, models: [] }], models: [], tokens: 12, sessions: 2 };
    const controls = { objective: '', automation: 'off', plan: null, activeTurnId: null, canInject: false, canSendDirectly: true, queueAtFinish: false, recovery: [], goalDraft: null, goalWait: null, finishGoalDraft: null, stopPending: false, finishWaiting: false };
    const filePreview = { projectId: project.id, projectName: project.name, path: 'notes.md', name: 'notes.md', bytes: 13, modifiedAt: new Date(0).toISOString(), revision: '${'a'.repeat(64)}', binary: false, text: 'ORIGINAL_NOTE', truncated: false };
    window.sent = [];
    window.sessionReads = [];
    window.terminalWrites = [];
    const listeners = { terminal: [] };
    const ok = data => Promise.resolve({ ok: true, data });
    window.api = new Proxy({
      getState: () => ok(state), getLog: () => ok([]), getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      listProjects: () => ok([project]),
      listSessions: () => ok({ sessions: [chatA, chatB, worker], total: 3, nextCursor: null, activeId: null, pressure: [], blocked: [] }),
      getSession: (id, query) => {
        window.sessionReads.push({ id, before: query && query.before, limit: query && query.limit });
        const source = id === 'task-b' ? eventsB : id === 'worker-1' ? [{ seq: 1, time: 1, source: 'extension', kind: 'user_message', messageId: 'worker-line', authoredText: 'Worker transcript', message: { text: 'Worker transcript', chars: 17, truncated: false } }] : eventsA;
        const page = query && typeof query.before === 'number' ? source.filter(event => event.seq < query.before).slice(-80) : source.slice(-(query && query.limit || source.length));
        const summaryRow = id === 'task-b' ? chatB : id === 'worker-1' ? worker : chatA;
        return ok({ summary: summaryRow, events: page, total: source.length, nextFrom: page.length ? page[page.length - 1].seq + 1 : 1 });
      },
      getSessionControls: () => ok(controls),
      getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog),
      getUsage: () => ok(usage),
      sendInput: entry => { window.sent.push(entry); return ok(entry); },
      listInputs: () => ok(window.sent.filter(entry => entry.mode === 'finish').map(entry => Object.assign({}, entry, { state: 'queued', owner: null, createdAt: entry.dueAt || Date.now(), conversationId: null }))),
      draftTaskPlan: () => new Promise(resolve => {
        const finish = () => resolve({ ok: true, data: ['Check the notes', 'Confirm the result'] });
        if (window.releasePlan) finish();
        else window.addEventListener('crystal-release-plan', finish, { once: true });
      }),
      listProjectFiles: (projectId, directory) => ok({ projectId, projectName: project.name, directory: directory || '', entries: directory ? [] : [{ name: 'notes.md', path: 'notes.md', kind: 'file', bytes: 13 }], truncated: false }),
      previewProjectFile: () => ok(filePreview),
      watchProjectFiles: () => ok(true), onProjectFilesChanged: () => () => {},
      terminalCreate: () => ok(true), terminalResize: () => ok(true), terminalAck: () => ok(true), terminalClose: () => ok(true),
      terminalWrite: (id, data) => { window.terminalWrites.push(String(data)); for (const listener of listeners.terminal) listener({ id, data: String(data) }); return ok(true); },
      onTerminalEvent: listener => { listeners.terminal.push(listener); return () => {}; },
      onTaskProgress: () => () => {},
      onStateChanged: () => () => {}, onLogEntry: () => () => {}, onSwarmChanged: () => () => {}, onChatModelsChanged: () => () => {}
    }, { get: (target, key) => key in target ? target[key] : () => ok(null) });
    await import('/main.ts');
    const still = document.createElement('style');
    still.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.append(still);
    window.fixtureReady = true;
  `;
  const server = await createServer({
    configFile: false, root: path.join(root, 'src/renderer'), server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'crystal-workspace', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }]
  });
  let win;
  const js = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { throw new Error('Renderer expression failed: ' + code + '\\n' + (error?.stack || error)); }
  };
  const until = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timeout: ' + expression + '\\n' + JSON.stringify(await js('({errors:window.fixtureErrors,screen:document.querySelector(".app")?.dataset.screen,text:document.body.innerText.slice(0,700)})')));
  };
  const box = async expression => js(`(() => {
    const node = (${expression});
    if (!node) return null;
    node.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(Math.max(rect.height / 2, 1), rect.height - 1), w: rect.width, h: rect.height };
  })()`);
  const click = async expression => {
    const at = await box(expression);
    assert.ok(at && at.w > 0 && at.h > 0, 'no hit target for ' + expression + ' ' + JSON.stringify(at));
    const x = Math.round(at.x), y = Math.round(at.y);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  const key = (name, modifiers) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: name, modifiers: modifiers || [] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: name, modifiers: modifiers || [] });
  };
  try {
    await server.listen();
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
    });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    await until('window.fixtureReady === true && !!document.querySelector(".project-group[data-project-id=\\"demo-project\\"]")');
    assert.deepEqual(await js('window.fixtureErrors'), []);

    await click('document.querySelector(".project-group[data-project-id=\\"demo-project\\"] > .project-heading")');
    await until('document.querySelector(".project-group[data-project-id=\\"demo-project\\"]").open === true');
    await click('document.querySelector(".sess[data-id=\\"task-a\\"]")');
    await until('document.body.innerText.includes("LIVE_PAGE_A")');
    await js('document.getElementById("timeline").dataset.flow = "kept"');

    await click('document.getElementById("chatInput")');
    await until('document.activeElement && document.activeElement.id === "chatInput"');
    win.webContents.insertText('Draft alpha');
    await until('document.getElementById("chatInput").value === "Draft alpha"');
    key('A', ['control']);
    win.webContents.insertText('Draft beta');
    await until('document.getElementById("chatInput").value === "Draft beta"');
    await click('document.getElementById("chatSend")');
    await until('window.sent.some(row => String(row.text).includes("Draft beta"))');

    win.webContents.insertText('Plan the notes');
    await until('document.getElementById("chatInput").value.includes("Plan the notes")');
    await click('document.querySelector("#composerSettings > summary")');
    await until('document.getElementById("composerSettings").open === true && document.getElementById("sessionControls").hidden === false');
    await click('document.getElementById("createPlan")');
    await until('document.getElementById("composerStatusLine").hidden === false && document.getElementById("taskPlanPreview").hidden === false');
    await click('document.getElementById("composerStatusToggle")');
    await until('document.getElementById("composerStatusLine").open === true && document.getElementById("taskPlanPreview").getBoundingClientRect().height > 0 && document.getElementById("taskPlanPreview").textContent.trim().length > 0');
    assert.equal(await js('document.activeElement && document.activeElement.id'), 'composerStatusToggle');
    await js('window.dispatchEvent(new Event("crystal-release-plan"))');
    await until('document.getElementById("finishQueue").hidden === false && document.getElementById("finishQueue").textContent.includes("Check the notes") && document.getElementById("finishQueue").textContent.includes("Confirm the result")');
    if (!(await js('document.getElementById("composerStatusLine").open === true'))) await click('document.getElementById("composerStatusToggle")');
    await until('document.getElementById("composerStatusLine").open === true && document.getElementById("finishQueue").getBoundingClientRect().height > 0');
    await click('document.querySelector("#finishQueue .queue-label")');
    await until('document.activeElement && document.activeElement.classList.contains("queue-label") && document.getElementById("finishQueue").contains(document.activeElement)');

    const history = await js(`(() => {
      const pane = document.getElementById('chatBody');
      pane.scrollTop = 0;
      const bounds = pane.getBoundingClientRect();
      return { x: Math.round(bounds.right - 100), y: Math.round(bounds.top + 100) };
    })()`);
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: history.x, y: history.y, deltaX: 0, deltaY: -240 });
    await until('window.sessionReads.some(read => read.id === "task-a" && typeof read.before === "number") && document.body.innerText.includes("OLDER_PAGE_A")');
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();

    await click('document.querySelector(".sess[data-id=\\"task-b\\"]")');
    await until('document.body.innerText.includes("LIVE_PAGE_B") && !document.body.innerText.includes("LIVE_PAGE_A")');
    await click('document.querySelector(".sess[data-id=\\"task-a\\"]")');
    await until('document.body.innerText.includes("LIVE_PAGE_A") && !document.body.innerText.includes("LIVE_PAGE_B") && document.getElementById("timeline").dataset.flow === "kept"');

    await click('document.getElementById("chatInput")');
    await until('document.activeElement && document.activeElement.id === "chatInput"');
    const held = await js('({scroll:document.getElementById("chatBody").scrollTop,value:document.getElementById("chatInput").value})');

    await click('document.querySelector("[data-destination=\\"files\\"]")');
    await until('document.querySelector(".app").dataset.workbenchOpen === "true" && !!document.querySelector(".file-tree-row")');
    await click('document.querySelector(".file-tree-row")');
    await until('!!document.querySelector(".file-preview:not([hidden]) .file-preview-actions button:nth-child(2)")');
    await click('document.querySelector(".file-preview:not([hidden]) .file-preview-actions button:nth-child(2)")');
    await until('!!document.querySelector(".cm-content")');
    await click('document.querySelector(".cm-content")');
    win.webContents.insertText('DRAFT_LINE');
    await until('document.querySelector(".cm-content").innerText.includes("DRAFT_LINE") && document.querySelector(".file-editor-dirty") && document.querySelector(".file-editor-dirty").hidden === false');
    await click('document.querySelector("[data-work-tab=\\"agents\\"]")');
    await until('document.querySelector(".agent-panel") && document.querySelector(".agent-panel").hidden === false');
    await click('document.querySelector(".agent-panel-row")');
    await until('document.querySelector(".agent-panel-header") && document.querySelector(".agent-panel-header").innerText.includes("Worker note")');
    await click('document.querySelector("[data-work-tab=\\"files\\"]")');
    await until('document.querySelector(".cm-content") && document.querySelector(".cm-content").innerText.includes("DRAFT_LINE")');

    await click('document.querySelector("[data-work-tab=\\"terminal\\"]")');
    await until('!!document.querySelector("#workspaceTerminal .xterm-screen")');
    await click('document.querySelector("#workspaceTerminal .xterm-screen")');
    await until('document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")');
    win.webContents.insertText('echo CRYSTAL');
    await until('window.terminalWrites.some(chunk => chunk.includes("echo CRYSTAL"))');

    await click('document.querySelector("[data-destination=\\"usage\\"]")');
    await until('document.querySelector(".panel[data-panel=\\"usage\\"]").classList.contains("is-active") && document.getElementById("usageSummary").innerText.includes("2") && document.querySelector("[data-destination=\\"usage\\"]").getAttribute("aria-current") === "page"');
    await click('document.querySelector("[data-destination=\\"settings\\"]")');
    await until('document.querySelector(".panel[data-panel=\\"workspace\\"]").classList.contains("is-active") && document.getElementById("settingsPages").hidden === false');
    await click('document.querySelector("[data-settings-panel=\\"appearance\\"]")');
    await until('document.querySelector(".panel[data-panel=\\"appearance\\"]").classList.contains("is-active") && document.getElementById("uiLanguage").getBoundingClientRect().width > 0');
    await click('document.getElementById("uiLanguage")');
    key('Down');
    key('Enter');
    await until('document.documentElement.lang === "es"');
    await click('document.querySelector("[data-destination=\\"chats\\"]")');
    await until('document.querySelector(".app").dataset.screen === "chat" && document.body.innerText.includes("LIVE_PAGE_A") && document.getElementById("timeline").dataset.flow === "kept"');
    const returned = await js('({scroll:document.getElementById("chatBody").scrollTop,value:document.getElementById("chatInput").value,focus:document.activeElement && (document.activeElement.id || document.activeElement.dataset.destination || "")})');
    assert.equal(returned.value, held.value);
    assert.ok(Math.abs(returned.scroll - held.scroll) < 4, 'scroll moved from ' + held.scroll + ' to ' + returned.scroll);
    assert.equal(returned.focus, 'chats');
    assert.equal(await js('document.querySelector("[data-destination=chats]").getAttribute("aria-current")'), 'page');
    win.webContents.setZoomFactor(1.5);
    await new Promise(resolve => setTimeout(resolve, 200));
    const zoom = win.webContents.getZoomFactor();
    const target = await js(`(() => {
      const rect = document.querySelector('#globalRail [data-destination="chats"]').getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    })()`);
    assert.ok(zoom >= 1.5, 'zoom ' + zoom);
    assert.ok(target.w >= 44 && target.h >= 44 && target.w * zoom >= 44 && target.h * zoom >= 44, JSON.stringify({ zoom, target }));
    win.webContents.setZoomFactor(1);
    const directions = await js(`(() => {
      const input = document.getElementById('chatInput');
      const read = value => { input.value = value; return getComputedStyle(input).direction; };
      const host = document.createElement('div');
      host.className = 'msg rich';
      host.setAttribute('dir', 'rtl');
      host.innerHTML = '<p>مرحبا</p><pre><code>const value = 1;</code></pre>';
      document.body.append(host);
      const code = getComputedStyle(host.querySelector('code')).direction;
      const rail = getComputedStyle(document.getElementById('globalRail')).direction;
      const arabic = read('مرحبا');
      const hebrew = read('שלום');
      const english = read('Hello');
      host.remove();
      input.value = ${JSON.stringify('')} ;
      return { arabic, hebrew, english, code, rail };
    })()`);
    await js('document.getElementById("chatInput").value = ' + JSON.stringify(held.value));
    assert.equal(directions.arabic, 'rtl');
    assert.equal(directions.hebrew, 'rtl');
    assert.equal(directions.english, 'ltr');
    assert.equal(directions.code, 'ltr');
    assert.equal(directions.rail, 'ltr');
    const outline = await js(`(() => {
      const host = document.createElement('div');
      host.className = 'delivery-choices';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Now';
      host.append(button);
      document.body.append(host);
      button.focus({ focusVisible: true });
      const style = getComputedStyle(button);
      const result = { style: style.outlineStyle, width: style.outlineWidth };
      host.remove();
      return result;
    })()`);
    assert.equal(outline.style, 'solid');
    assert.equal(outline.width, '2px');
    win.setContentSize(700, 800);
    await until('document.querySelector(".app").dataset.collapse === "navigator" || document.querySelector(".app").dataset.collapse === "rail"');
    await click('document.querySelector("[data-destination=\\"chats\\"]")');
    await until('document.querySelector(".app").dataset.navigatorOpen === "true"');
    key('Tab');
    await until('document.getElementById("chatNavigator").contains(document.activeElement)');
    key('Tab', ['shift']);
    await until('document.activeElement && document.activeElement.dataset.destination === "chats"');
    assert.deepEqual(await js('window.fixtureErrors'), []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      sent: true, history: true, switched: true, fileDraft: true, terminal: true, agents: true, usage: true, settings: true, locale: 'es', scroll: returned.scroll, focus: returned.focus
    }, null, 2));
    console.log('Crystal workspace flow passed. ' + output);
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
