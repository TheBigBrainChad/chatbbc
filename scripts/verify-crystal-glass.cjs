// Real Electron/Chromium acceptance for the production Crystal glass owner and renderer CSS.
// Backing release goes through the production preload, AppState generation, and IPC handler.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const trace = message => { if (process.env.CRYSTAL_GLASS_TRACE === '1') console.log(`[glass-smoke] ${message}`); };

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
const output = path.join(root, 'outputs', 'crystal-glass');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'runtime'));
app.on('window-all-closed', () => {});


app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.error('Crystal glass smoke exceeded 120 seconds');
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
      name: 'crystal-glass-fixture',
      configureServer(vite) {
        vite.middlewares.use('/crystal-glass.html', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>Crystal glass fixture</title>
<link rel="stylesheet" href="/src/renderer/styles/base.css">
<link rel="stylesheet" href="/src/renderer/styles/shell.css">
<style>
  .app { width:100vw; height:100vh; }
  .sidebar { grid-row:2 / -1; }
  main { padding:32px; }
  .card { width:360px; height:180px; padding:24px; }
  #hit { width:180px; height:48px; border:1px solid var(--hairline); background:var(--glass-readable); color:var(--ink); }
</style></head><body>
<div class="app" data-screen="chat"><div class="app-topbar">ChatBBC Crystal</div>
<aside class="sidebar"><strong>Workspace</strong></aside><main><section class="card"><h1>Readable glass</h1><button id="hit">Hit target</button></section></main></div>
<script type="module">
  import { applyAppearance } from '/src/renderer/appearance.ts';
  window.applyGlassMode = async () => {
    const state = await window.api.getState();
    if (!state.ok) throw new Error(state.error || 'glass state unavailable');
    const generation = state.data.glassGeneration;
    if (!Number.isInteger(generation) || generation < 0) throw new Error('AppState is missing glassGeneration');
    applyAppearance('dark', undefined, null, { mode: state.data.glass.mode });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const ack = await window.api.appearanceReady(generation);
    if (!ack.ok) throw new Error(ack.error || 'appearance acknowledgement rejected');
    window.appliedGlassGeneration = generation;
  };
  window.fixtureLoaded = true;
</script></body></html>`);
        });
      }
    }]
  });
  await server.listen();

  const glass = await server.ssrLoadModule('/src/main/window-glass.ts');
  const preload = path.join(output, 'preload.cjs');
  const bridgeFile = path.join(output, 'bridge.cjs');
  const esbuild = require('esbuild');
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: preload,
    packages: 'external',
    external: ['electron'],
    logLevel: 'warning'
  });
  esbuild.buildSync({
    stdin: {
      contents: [
        `export { registerIpc } from ${JSON.stringify(path.join(root, 'src/main/ipc.ts'))};`,
        `export { initConfigPath, loadConfig } from ${JSON.stringify(path.join(root, 'src/main/config.ts'))};`,
        `export { initSecretsPath } from ${JSON.stringify(path.join(root, 'src/main/secrets.ts'))};`,
        `export { initSessionStore } from ${JSON.stringify(path.join(root, 'src/main/session/store.ts'))};`,
        `export { initDurableStore } from ${JSON.stringify(path.join(root, 'src/main/durable.ts'))};`
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'glass-smoke-bridge.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bridgeFile,
    packages: 'external',
    external: ['electron'],
    logLevel: 'warning'
  });
  const bridge = require(bridgeFile);
  const runtime = path.join(output, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  bridge.initConfigPath(runtime);
  bridge.initSecretsPath(runtime);
  bridge.initSessionStore(runtime);
  bridge.initDurableStore(runtime);
  await bridge.loadConfig();
  let activeWindow = null;
  let activeSupport = { mode: 'atmospheric', transparent: false, diagnostic: null };
  let activeHandshake = glass.createGlassBackingHandshake(
    { setBackgroundColor() {} },
    activeSupport,
    '#181818'
  );
  const stopIpc = bridge.registerIpc(
    () => activeWindow,
    () => {},
    {
      glassSupport: () => activeSupport,
      glassGeneration: () => activeHandshake.generation(),
      appearancePainted: generation => activeHandshake.appearancePainted(generation),
      updateBackground: background => activeHandshake.updateBackground(background)
    }
  );
  const baseUrl = server.resolvedUrls.local[0];
  const results = [];
  let captureLimit = process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? 'Chromium Viz capture is skipped on Wayland because this session reports an incompatible Vulkan surface. DOM paint, native backing, hit testing and geometry checks still run in real Electron.'
    : null;
  async function capture(win, name) {
    if (captureLimit) return;
    try {
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      fs.writeFileSync(path.join(output, name), image.toPNG());
    } catch (error) {
      if (error instanceof Error && error.message === 'UnknownVizError') {
        captureLimit = 'Chromium Viz capture is unavailable in this session (UnknownVizError). DOM paint, native backing, hit testing and geometry checks still ran in real Electron.';
        return;
      }
      throw error;
    }
  }

  const geometry = win => win.webContents.executeJavaScript(`(() => {
    const app = document.querySelector('.app'), target = document.getElementById('hit');
    const a = app.getBoundingClientRect(), t = target.getBoundingClientRect();
    const appStyle = getComputedStyle(app), targetStyle = getComputedStyle(target);
    const point = document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2);
    return {
      app: { x:a.x, y:a.y, width:a.width, height:a.height },
      target: { x:t.x, y:t.y, width:t.width, height:t.height },
      page: getComputedStyle(document.documentElement).getPropertyValue('--page').trim(),
      sheets: [...document.styleSheets].map(sheet => sheet.href || 'inline'),
      appBackground: appStyle.backgroundColor,
      targetBackground: targetStyle.backgroundColor,
      targetColor: targetStyle.color,
      hit: target.contains(point),
      mode: document.documentElement.dataset.glassMode || null
    };
  })()`);

  async function runMode(name, support) {
    trace(`${name}: construct`);
    const projected = glass.windowGlassOptions('linux', { HYPRLAND_INSTANCE_SIGNATURE: 'fixture' }, support);
    const constructorOptions = {
      show: false,
      width: 900,
      height: 640,
      backgroundColor: '#181818',
      ...projected,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        partition: `crystal-glass-${name}`
      }
    };
    const win = new BrowserWindow(constructorOptions);
    const backing = [];
    const nativeSetBackgroundColor = win.setBackgroundColor.bind(win);
    const handshake = glass.createGlassBackingHandshake({
      setBackgroundColor(color) { backing.push(color); nativeSetBackgroundColor(color); }
    }, support, '#181818');
    activeWindow = win;
    activeSupport = support;
    activeHandshake = handshake;
    win.webContents.on('did-start-loading', () => {
      if (activeWindow === win) activeHandshake.loading('#181818');
    });
    win.webContents.on('did-finish-load', () => {
      if (activeWindow === win) activeHandshake.didFinishLoad();
    });

    try {
      trace(`${name}: loading`);
      await win.loadURL(`${baseUrl}crystal-glass.html`);
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      trace(`${name}: loaded`);
      const first = await geometry(win);
      assert.equal(first.mode, null, `${name}: fixture must expose the readable boot surface before glass`);
      assert.match(first.page, /^#[0-9a-f]{6}$/i, `${name}: first paint must resolve a readable palette`);
      assert.equal(first.hit, true, `${name}: boot surface must remain hit-testable`);
      assert.equal(backing.at(-1), '#181818', `${name}: did-finish-load alone must not clear backing`);
      assert.notEqual(first.targetBackground, 'rgba(0, 0, 0, 0)', `${name}: first-paint control must retain backing`);
      trace(`${name}: first capture`);
      await capture(win, `${name}-first-paint.png`);

      await win.webContents.executeJavaScript('window.applyGlassMode()');
      const appliedGeneration = await win.webContents.executeJavaScript('window.appliedGlassGeneration');
      assert.equal(appliedGeneration, handshake.generation(), `${name}: acknowledgement must echo the published generation`);
      trace(`${name}: appearance applied`);
      const painted = await geometry(win);
      assert.equal(painted.mode, support.mode);
      assert.equal(painted.hit, true, `${name}: glass surface must remain hit-testable`);
      assert.deepEqual(painted.app, first.app, `${name}: glass mode must not move the app`);
      assert.deepEqual(painted.target, first.target, `${name}: glass mode must not move controls`);
      assert.notEqual(painted.targetBackground, 'rgba(0, 0, 0, 0)', `${name}: target backing must remain readable`);
      assert.notEqual(painted.targetColor, painted.targetBackground, `${name}: target ink must remain visible`);
      assert.equal(backing.at(-1), support.transparent ? '#00000000' : '#181818');

      await capture(win, `${name}.png`);

      const beforeReloadCount = backing.length;
      trace(`${name}: painted capture`);
      const reloaded = once(win.webContents, 'did-finish-load');
      win.reload();
      await reloaded;
      assert.ok(backing.slice(beforeReloadCount).includes('#181818'), `${name}: reload must restore readable backing`);
      const reloadFirst = await geometry(win);
      assert.match(reloadFirst.page, /^#[0-9a-f]{6}$/i);
      assert.notEqual(reloadFirst.targetBackground, 'rgba(0, 0, 0, 0)');
      trace(`${name}: reloaded`);
      assert.equal(backing.at(-1), '#181818', `${name}: reload backing must wait for appearance`);
      const stale = await win.webContents.executeJavaScript(`window.api.appearanceReady(${JSON.stringify(appliedGeneration)})`);
      assert.equal(stale.ok, false, `${name}: a delayed old-document acknowledgement must be rejected`);
      assert.equal(backing.at(-1), '#181818', `${name}: a stale acknowledgement must not release the reloaded backing`);
      await win.webContents.executeJavaScript('window.applyGlassMode()');
      const reloadGeneration = await win.webContents.executeJavaScript('window.appliedGlassGeneration');
      assert.equal(reloadGeneration, handshake.generation(), `${name}: reload acknowledgement must echo the new generation`);
      assert.notEqual(reloadGeneration, appliedGeneration, `${name}: reload must issue a new generation`);
      const reloadPainted = await geometry(win);
      trace(`${name}: reload appearance applied`);
      assert.deepEqual(reloadPainted.app, painted.app, `${name}: reload must preserve layout`);
      assert.deepEqual(reloadPainted.target, painted.target, `${name}: reload must preserve target layout`);
      assert.equal(backing.at(-1), support.transparent ? '#00000000' : '#181818');

      results.push({
        name,
        constructor: { transparent: projected.transparent === true, backgroundColor: projected.backgroundColor ?? '#181818' },
        backing,
        firstPaint: first,
        painted,
        reload: reloadPainted
      });
      trace(`${name}: complete`);
    } finally {
      if (activeWindow === win) activeWindow = null;
      win.destroy();
    }
  }

  try {
    await runMode('atmospheric', { mode: 'atmospheric', transparent: false, diagnostic: 'fixture fallback' });
    await runMode('transparent', { mode: 'transparent', transparent: true, diagnostic: null });
    const report = {
      electron: process.versions.electron,
      platform: process.platform,
      cases: results,
      captureLimit,
      compositorBlurObserved: false,
      compositorLimit: 'The isolated fixture proves Electron transparency, backing, paint, hit testing and layout. A hidden fixture cannot prove that the live compositor applied a ChatBBC-scoped blur rule.'
    };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`Crystal glass Electron checks passed: 2 modes, readable first paint/reload, hit testing, zero layout delta. ${output}`);
    console.log(`Compositor limit: ${report.compositorLimit}`);
  } finally {
    clearTimeout(deadline);
    if (captureLimit) console.log(`Capture limit: ${captureLimit}`);
    if (typeof stopIpc === 'function') stopIpc();
    await server.close();
    app.quit();
  }
}).catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});
