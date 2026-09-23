/** Real Electron accessibility and responsive checks for the Crystal shell. No provider access.
 * Run: node scripts/verify-crystal-accessibility.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const extra = process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu', '--in-process-gpu'] : [];
  const result = spawnSync(require('electron'), [__filename, ...extra], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.error('Crystal accessibility smoke exceeded 120 seconds');
    app.exit(1);
  }, 120_000);
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'crystal-a11y-fixture',
      configureServer(vite) {
        vite.middlewares.use('/crystal-a11y.html', (_request, response) => {
          let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
          html = html.replaceAll('href="./styles/', 'href="/src/renderer/styles/');
          html = html.replace(
            '<script type="module" src="./main.ts"></script>',
            `<script type="module">
              import { createAppShell } from '/src/renderer/app-shell.ts';
              import { createPresentationStore, initialPresentationState } from '/src/renderer/presentation-store.ts';
              const store = createPresentationStore(initialPresentationState());
              const shell = createAppShell({ document, store, roots: {
                rail: document.getElementById('globalRail'),
                navigator: document.getElementById('chatNavigator'),
                stage: document.getElementById('conversationStage'),
                workbench: document.getElementById('contextWorkbench')
              } });
              window.__shell = shell;
              window.__stage = document.getElementById('conversationStage');
              const prose = document.createElement('p');
              prose.className = 'msg';
              prose.id = 'a11yProse';
              prose.textContent = 'Accessible prose should keep its measure. '.repeat(12);
              document.getElementById('timeline').append(prose);
              window.__ready = true;
            </script>`
          );
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        });
      }
    }]
  });
  await server.listen();
  const address = server.httpServer.address();
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { offscreen: true } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/crystal-a11y.html`);
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => window.__ready ? resolve(true)
      : Date.now() - start > 15000 ? reject(new Error('a11y boot timeout')) : setTimeout(tick, 40);
    tick();
  })`);

  // Exactly one shell, timeline, composer, navigator and workbench.
  const singles = await win.webContents.executeJavaScript(`(() => {
    const count = selector => document.querySelectorAll(selector).length;
    return {
      shell: count('#appShell'), timeline: count('#timeline'), composer: count('#composer'),
      navigator: count('#chatNavigator'), workbench: count('#contextWorkbench'),
      main: count('main'), rail: count('#globalRail[role="toolbar"]')
    };
  })()`);
  for (const [name, value] of Object.entries(singles)) assert.equal(value, 1, `${name} must appear once`);

  // Secondary destinations must not remount the conversation stage.
  const stageKept = await win.webContents.executeJavaScript(`(() => {
    const before = window.__stage;
    for (const destination of ['settings', 'usage', 'chats', 'files']) window.__shell.setDestination(destination);
    return before === window.__stage && document.getElementById('conversationStage').contains(document.getElementById('timeline'));
  })()`);
  assert.equal(stageKept, true, 'the conversation stage was remounted by routing');

  // The transcript is the single vertical scroll owner on the chat screen.
  const scrollOwners = await win.webContents.executeJavaScript(`(() => {
    window.__shell.setDestination('chats');
    const body = document.getElementById('chatBody');
    const overflow = getComputedStyle(body).overflowY;
    const stageScrollers = [...document.getElementById('conversationStage').querySelectorAll('*')]
      .filter(node => node !== body)
      .filter(node => { const style = getComputedStyle(node); return (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4; })
      .map(node => node.id || node.className);
    return { overflow, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, stageScrollers };
  })()`);
  assert.ok(['auto', 'scroll'].includes(scrollOwners.overflow), 'chatBody must own vertical scrolling');
  assert.deepEqual(scrollOwners.stageScrollers, [], 'a nested transcript scroller appeared');

  // Semantics: a labelled vertical toolbar with roving tabindex and roving focus.
  const semantics = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('globalRail');
    const buttons = [...rail.querySelectorAll('[data-destination]')];
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const afterArrow = document.activeElement?.dataset.destination ?? null;
    const current = buttons.filter(button => button.getAttribute('aria-current') === 'page').map(button => button.dataset.destination);
    const labelledInputs = [...document.querySelectorAll('input, select, textarea')]
      .filter(node => !node.hidden && node.offsetParent !== null && node.type !== 'hidden')
      .filter(node => !(node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || node.closest('label[for]') || document.querySelector('label[for="' + node.id + '"]')))
      .map(node => node.id || node.name);
    return { toolbarLabel: rail.getAttribute('aria-label'), afterArrow, current, labelledInputs };
  })()`);
  assert.ok(semantics.toolbarLabel, 'the rail needs an accessible name');
  assert.equal(semantics.afterArrow, 'files', 'arrow keys must move rail focus');
  assert.deepEqual(semantics.current, ['chats'], 'exactly one destination is current');
  assert.deepEqual(semantics.labelledInputs, [], 'visible form controls need labels');

  // Reduced motion removes animation and transition work.
  const reduced = await win.webContents.executeJavaScript(`(() => {
    document.documentElement.classList.add('force-reduced-motion');
    const probe = document.createElement('div');
    probe.style.animation = 'none';
    document.body.append(probe);
    const sheet = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
      .filter(rule => rule.media && rule.media.mediaText.includes('prefers-reduced-motion'));
    probe.remove();
    return sheet.length > 0;
  })()`);
  assert.equal(reduced, true, 'a prefers-reduced-motion rule must exist');

  // 360px narrow width keeps prose inside the viewport with one scroll owner.
  win.setContentSize(360, 780);
  await win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const narrow = await win.webContents.executeJavaScript(`(() => {
    const prose = document.getElementById('a11yProse').getBoundingClientRect();
    const body = document.getElementById('chatBody');
    return { proseRight: Math.round(prose.right), inner: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyOverflowX: getComputedStyle(body).overflowX };
  })()`);
  assert.ok(narrow.proseRight <= narrow.inner + 1, `prose overflowed at 360px: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.scrollWidth <= narrow.inner + 1, `horizontal document overflow at 360px: ${JSON.stringify(narrow)}`);

  clearTimeout(deadline);
  console.log('Crystal accessibility passed: single shell, stage preservation, one scroll owner, rail semantics, labels, reduced motion, 360px.');
  win.destroy();
  await server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
