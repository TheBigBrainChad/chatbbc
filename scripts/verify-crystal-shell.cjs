/** Real Electron layout for the Adaptive Studio shell. No installed app, session, or provider access. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');

function bandFor(width) {
  if (width < 560) return 'rail';
  if (width < 780) return 'navigator';
  if (width < 1100) return 'workbench';
  return 'wide';
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.error('Crystal shell smoke exceeded 120 seconds');
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
      name: 'crystal-shell-fixture',
      configureServer(vite) {
        vite.middlewares.use('/crystal-shell.html', (_request, response) => {
          let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
          html = html.replaceAll('href="./styles/', 'href="/src/renderer/styles/');
          html = html.replace(
            '<script type="module" src="./main.ts"></script>',
            `<script type="module">
              import { createAppShell } from '/src/renderer/app-shell.ts';
              import { createPresentationStore, initialPresentationState } from '/src/renderer/presentation-store.ts';
              const store = createPresentationStore(initialPresentationState());
              window.__shell = createAppShell({
                document,
                store,
                roots: {
                  rail: document.getElementById('globalRail'),
                  navigator: document.getElementById('chatNavigator'),
                  stage: document.getElementById('conversationStage'),
                  workbench: document.getElementById('contextWorkbench')
                }
              });
              const prose = document.createElement('p');
              prose.className = 'msg';
              prose.id = 'shellProse';
              prose.textContent = 'The chat text should keep the same line breaks when the workbench opens. '.repeat(6);
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
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, webPreferences: { offscreen: true }
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/crystal-shell.html`);
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => window.__ready ? resolve(true)
      : Date.now() - start > 15000 ? reject(new Error('shell boot timeout'))
      : setTimeout(tick, 40);
    tick();
  })`);

  const read = () => win.webContents.executeJavaScript(`(() => {
    const box = id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const frame = document.querySelector('.app');
    const stage = document.getElementById('conversationStage');
    return {
      band: frame.dataset.collapse,
      inner: window.innerWidth,
      client: frame.clientWidth,
      stageMounted: stage.contains(document.getElementById('timeline')) && stage.contains(document.getElementById('composer')),
      regions: ['globalRail', 'chatNavigator', 'conversationStage', 'contextWorkbench'].map(id => document.querySelectorAll('#' + id).length),
      rail: box('globalRail'), navigator: box('chatNavigator'), stage: box('conversationStage'),
      workbench: box('contextWorkbench'), composer: box('composer'), prose: box('shellProse')
    };
  })()`);
  const settle = () => win.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  );
  const resize = async (width, height) => {
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))');
    await settle();
  };

  const samples = [];
  for (const zoom of [1, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom);
    for (const width of [1600, 1000, 700, 480]) {
      await resize(width, 860);
      const sample = await read();
      const measured = sample.client > 0 ? sample.client : sample.inner;
      assert.equal(sample.band, bandFor(measured), `collapse at zoom ${zoom}, content ${width}: ${JSON.stringify(sample)}`);
      assert.equal(sample.stageMounted, true, 'conversation stage lost its transcript or composer');
      assert.deepEqual(sample.regions, [1, 1, 1, 1]);
      assert.ok(sample.stage.w > 120 && sample.stage.h > 80, `stage is not the primary surface ${JSON.stringify(sample.stage)}`);
      if (sample.band === 'navigator') {
        assert.ok(sample.stage.w > measured - 120, `navigator drawer still reserves a column ${JSON.stringify(sample)}`);
      }
      samples.push({ zoom, width, measured, band: sample.band, stage: sample.stage.w, composer: sample.composer.w });
    }
  }

  win.webContents.setZoomFactor(1);
  await resize(1760, 980);
  const stable = await win.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector('.app');
    // 42vw is only the fallback. An explicit width is the docked track. 360px still leaves the
    // 800px prose measure in this window; 900px is wider than 42vw and must not be clamped.
    frame.style.setProperty('--workbench-width', '360px');
    const measure = () => ({
      prose: document.getElementById('shellProse').getBoundingClientRect().width,
      composer: document.getElementById('composer').getBoundingClientRect().width
    });
    const before = measure();
    window.__shell.setWorkbenchOpen(true);
    const open = measure();
    frame.style.setProperty('--workbench-width', '900px');
    const widened = document.getElementById('contextWorkbench').getBoundingClientRect().width;
    frame.style.setProperty('--workbench-width', '360px');
    const restored = measure();
    window.__shell.setWorkbenchOpen(false);
    const closed = measure();
    return { before, open, restored, closed, widened, band: frame.dataset.collapse, viewport: window.innerWidth };
  })()`);
  assert.equal(stable.band, 'wide', JSON.stringify(stable));
  assert.equal(stable.open.prose, stable.before.prose, `prose width moved with the workbench ${JSON.stringify(stable)}`);
  assert.equal(stable.restored.prose, stable.before.prose, `prose width stayed narrow after the explicit width returned ${JSON.stringify(stable)}`);
  assert.equal(stable.closed.prose, stable.before.prose, `prose width moved when the workbench closed ${JSON.stringify(stable)}`);
  assert.equal(stable.open.composer, stable.before.composer, `composer width moved with the workbench ${JSON.stringify(stable)}`);
  assert.equal(stable.closed.composer, stable.before.composer, `composer width moved when the workbench closed ${JSON.stringify(stable)}`);
  assert.ok(stable.widened > stable.viewport * 0.42 + 40, `explicit workbench width was clamped to 42vw ${JSON.stringify(stable)}`);

  const keys = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('#globalRail [data-destination]')];
    buttons[0].focus();
    const press = name => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    press('ArrowDown');
    const afterDown = document.activeElement?.dataset.destination ?? null;
    const chatsCurrent = buttons[0].getAttribute('aria-current');
    press('End');
    return { labels: buttons.map(button => button.dataset.destination), afterDown, chatsCurrent, afterEnd: document.activeElement?.dataset.destination ?? null };
  })()`);
  assert.deepEqual(keys.labels, ['chats', 'files', 'agents', 'usage', 'settings']);
  assert.equal(keys.afterDown, 'files');
  assert.equal(keys.chatsCurrent, 'page');
  assert.equal(keys.afterEnd, 'settings');

  await resize(480, 800);
  const drawers = await win.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector('.app');
    const chats = document.querySelector('[data-destination="chats"]');
    const files = document.querySelector('[data-destination="files"]');
    chats.focus(); chats.click();
    files.focus(); files.click();
    const opened = { navigator: frame.dataset.navigatorOpen, workbench: frame.dataset.workbenchOpen };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const first = { navigator: frame.dataset.navigatorOpen, workbench: frame.dataset.workbenchOpen, focus: document.activeElement?.dataset.destination ?? null };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const second = { navigator: frame.dataset.navigatorOpen, workbench: frame.dataset.workbenchOpen, focus: document.activeElement?.dataset.destination ?? null };
    return { band: frame.dataset.collapse, opened, first, second };
  })()`);
  assert.equal(drawers.band, 'rail', JSON.stringify(drawers));
  assert.equal(drawers.opened.navigator, 'true');
  assert.equal(drawers.opened.workbench, 'true');
  assert.deepEqual(drawers.first, { navigator: 'true', workbench: 'false', focus: 'files' });
  assert.deepEqual(drawers.second, { navigator: 'false', workbench: 'false', focus: 'chats' });

  await resize(1440, 900);
  const geometry = async mode => {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.glassMode = ${JSON.stringify(mode)}`);
    await settle();
    return read();
  };
  const atmospheric = await geometry('atmospheric');
  const transparent = await geometry('transparent');
  const hyprland = await geometry('hyprland-blur');
  for (const key of ['rail', 'navigator', 'stage', 'workbench', 'composer']) {
    assert.deepEqual(transparent[key], atmospheric[key], `${key} changed between atmospheric and transparent`);
    assert.deepEqual(hyprland[key], atmospheric[key], `${key} changed between atmospheric and hyprland blur`);
  }

  console.log(JSON.stringify(samples));
  console.log('Crystal shell passed: four regions, collapse priority, zoom, keyboard, drawer focus, glass geometry, stable prose.');
  clearTimeout(deadline);
  win.destroy();
  await server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
