/** Real Electron settled-work and retained-node checks for the Crystal shell. No provider access.
 * Run: node scripts/verify-crystal-performance.cjs */
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
    console.error('Crystal performance smoke exceeded 120 seconds');
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
      name: 'crystal-perf-fixture',
      configureServer(vite) {
        vite.middlewares.use('/crystal-perf.html', (_request, response) => {
          let html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
          html = html.replaceAll('href="./styles/', 'href="/src/renderer/styles/');
          html = html.replace(
            '<script type="module" src="./main.ts"></script>',
            `<script type="module">
              import { createAppShell } from '/src/renderer/app-shell.ts';
              import { createPresentationStore, initialPresentationState } from '/src/renderer/presentation-store.ts';
              import { applyImageSetMembers } from '/src/renderer/image-set.ts';
              const store = createPresentationStore(initialPresentationState());
              const shell = createAppShell({ document, store, roots: {
                rail: document.getElementById('globalRail'),
                navigator: document.getElementById('chatNavigator'),
                stage: document.getElementById('conversationStage'),
                workbench: document.getElementById('contextWorkbench')
              } });
              window.__shell = shell;
              const timeline = document.getElementById('timeline');
              for (let index = 0; index < 240; index += 1) {
                const row = document.createElement('p');
                row.className = 'msg';
                row.textContent = 'Row ' + index + ' — ' + 'prose '.repeat(8);
                timeline.append(row);
              }
              // A pending gallery keeps reserved geometry with no hydrated full preview.
              const gallery = document.createElement('div');
              gallery.className = 'generated-image-gallery';
              gallery.id = 'perfGallery';
              timeline.append(gallery);
              applyImageSetMembers(gallery, {
                responseId: 'perf-response', origin: 1, completeness: 'partial',
                images: [
                  { providerAssetId: 'file_AuroraOriginal0001', origin: 1, previewStatus: 'pending', hasPreview: false, width: 1024, height: 768 },
                  { providerAssetId: 'file_AuroraOriginal0002', origin: 2, previewStatus: 'pending', hasPreview: false, width: 768, height: 1024 }
                ]
              }, { sessionId: 'perf-session', current: () => true });
              window.__reserved = [...gallery.querySelectorAll('.generated-image-frame')]
                .map(frame => Math.round(frame.getBoundingClientRect().height));
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
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/crystal-perf.html`);
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => window.__ready ? resolve(true)
      : Date.now() - start > 15000 ? reject(new Error('perf boot timeout')) : setTimeout(tick, 40);
    tick();
  })`);
  // Settle before measuring animation work.
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  // A settled, hidden document must schedule no recurring animation frames.
  await win.webContents.executeJavaScript(`(() => {
    window.__frames = 0;
    const count = () => { window.__frames += 1; window.__raf = requestAnimationFrame(count); };
    window.__raf = requestAnimationFrame(count);
  })()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  const frames = await win.webContents.executeJavaScript('(cancelAnimationFrame(window.__raf), window.__frames)');
  assert.ok(frames <= 60, `settled document kept animating: ${frames} frames in 700ms`);

  // Reserving gallery geometry must not hydrate every full preview.
  const gallery = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#perfGallery > .ev-native_image')];
    return {
      rows: rows.length,
      images: document.querySelectorAll('#perfGallery img').length,
      reserved: window.__reserved,
      downloadAll: document.querySelector('#perfGallery .image-set-download-all')?.dataset.downloadAssets ?? ''
    };
  })()`);
  assert.equal(gallery.rows, 2, 'both gallery rows must be reserved');
  assert.equal(gallery.images, 0, 'a pending gallery must not hydrate previews');
  assert.ok(gallery.reserved.every(height => height > 40), `reserved geometry was lost: ${JSON.stringify(gallery.reserved)}`);
  assert.equal(gallery.downloadAll, 'file_AuroraOriginal0001\u0001file_AuroraOriginal0002');

  // Routing must not remount the transcript.
  const routing = await win.webContents.executeJavaScript(`(() => {
    const before = document.getElementById('timeline');
    for (const destination of ['settings', 'usage', 'agents', 'chats']) window.__shell.setDestination(destination);
    return { kept: before === document.getElementById('timeline'), rows: before.children.length };
  })()`);
  assert.equal(routing.kept, true, 'routing remounted the transcript');
  assert.equal(routing.rows, 241, 'routing changed resident transcript rows');

  // Opening the workbench must not remount the transcript or the composer.
  const workbench = await win.webContents.executeJavaScript(`(() => {
    const timeline = document.getElementById('timeline');
    const composer = document.getElementById('composer');
    window.__shell.setWorkbenchOpen(true);
    const open = { keptTimeline: timeline === document.getElementById('timeline'), keptComposer: composer === document.getElementById('composer') };
    window.__shell.setWorkbenchOpen(false);
    return open;
  })()`);
  assert.equal(workbench.keptTimeline, true, 'workbench open remounted the transcript');
  assert.equal(workbench.keptComposer, true, 'workbench open remounted the composer');

  clearTimeout(deadline);
  console.log('Crystal performance passed: settled frames bounded, gallery geometry reserved without hydration, routing and workbench keep the transcript.');
  win.destroy();
  await server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
