// Crystal rich-output renderer check plus source contracts.
// Does not open ChatGPT and does not prove signed-in provider behavior.
// Run: node scripts/verify-crystal-rich-outputs.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

function sourceContracts() {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const background = read('extension/background.js');
  assert.match(background, /generated-assets\/original\/chunk/);
  assert.match(background, /processGeneratedAssetOriginals/);
  assert.doesNotMatch(background, /generatedAssetDownloads[^\n]*sig=/);
  assert.match(read('src/main/mcp/surfaces.ts'), /generated_assets/);
  for (const locale of ['src/renderer/locales/es.json', 'src/renderer/locales/zh-CN.json', 'src/renderer/locales/zh-TW.json']) {
    const catalog = JSON.parse(read(locale));
    for (const key of ['Download original', 'Download all originals', 'Download selected originals',
      'Saved to browser Downloads', 'Save preview', 'Save all previews', 'Save selected previews']) {
      assert.equal(typeof catalog[key], 'string', `${locale} missing ${key}`);
    }
  }
}

if (!process.versions.electron) {
  sourceContracts();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const extra = process.platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu', '--in-process-gpu'] : [];
  const { status } = require('node:child_process').spawnSync(require('electron'), [__filename, ...extra], {
    cwd: root, env, stdio: 'inherit', windowsHide: true
  });
  process.exit(status ?? 1);
}

const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const deadline = setTimeout(() => {
    console.error('Crystal rich-output smoke exceeded 90 seconds');
    app.exit(1);
  }, 90_000);
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'crystal-rich-fixture',
      configureServer(vite) {
        vite.middlewares.use('/crystal-rich.html', (_request, response) => {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(`<!doctype html><body><div id="host"></div><script type="module">
            import { applyImageSetMembers } from '/src/renderer/image-set.ts';
            import { mountStaticArtifact } from '/src/renderer/static-artifact.ts';
            import { renderRichResponse } from '/src/renderer/rich-response.ts';
            let savedSelection = null;
            window.api = {
              saveGeneratedAssetPreviews: async (session, message, assetIds) => {
                savedSelection = [session, message, assetIds];
                return { ok: true, data: { saved: 1, failed: 1, cancelled: false, firstError: 'Preview unavailable' } };
              }
            };
            const gallery = document.createElement('div');
            gallery.className = 'generated-image-gallery';
            document.body.append(gallery);
            applyImageSetMembers(gallery, {
              responseId: 'response-multi',
              origin: 1,
              completeness: 'partial',
              images: [
                { providerAssetId: 'file_AuroraOriginal0001', origin: 1, previewStatus: 'available', hasPreview: true,
                  previewAssetId: 'abcdef12.bin', previewMime: 'image/webp' },
                { providerAssetId: 'file_AuroraOriginal0002', origin: 2, previewStatus: 'unavailable', hasPreview: false }
              ]
            }, { sessionId: 'session-rich', current: () => true });
            const all = gallery.querySelector('.image-set-download-all');
            const saveAll = gallery.querySelector('.image-set-save-all');
            const saveEnabled = saveAll && !saveAll.disabled;
            saveAll?.click();
            await Promise.resolve();
            const artifact = document.createElement('div');
            document.body.append(artifact);
            const mounted = mountStaticArtifact(artifact, { html: '<p>Safe</p><script>window.hacked=true<\\/script>' });
            const safeHost = document.createElement('div');
            document.body.append(safeHost);
            const accepted = mountStaticArtifact(safeHost, { html: '<p>Safe</p>' });
            const safeFrame = safeHost.querySelector('iframe');
            const rich = renderRichResponse({
              version: 1, status: 'available', reason: null,
              conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              messageId: 'assistant:choice', providerMessageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
              revision: 1, accessibleText: 'Yes',
              nodes: [{ id: 'c1', kind: 'control', control: 'choice', label: 'Yes', groupId: null, value: null, selected: false, disabled: true, children: [] }]
            }, 'Yes');
            document.body.append(rich);
            const choice = rich.querySelector('[data-rich-control]');
            window.__result = {
              downloadCount: gallery.querySelectorAll('.image-set-download').length,
              downloadAll: all?.dataset.downloadAssets ?? '',
              single: gallery.classList.contains('is-single'),
              saveEnabled,
              savedSelection,
              saveOutcome: saveAll?.textContent ?? '',
              artifactRejected: mounted.rejected,
              sandbox: safeFrame?.getAttribute('sandbox') ?? null,
              srcdocHasScript: safeFrame?.srcdoc.includes('<script') === true,
              safeAccepted: accepted.rejected === null,
              choiceDisabled: choice?.getAttribute('aria-disabled') ?? null
            };
            window.__ready = true;
          </script>`);
        });
      }
    }]
  });
  await server.listen();
  const address = server.httpServer.address();
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadURL(`http://127.0.0.1:${address.port}/crystal-rich.html`);
  let result = null;
  for (let attempt = 0; attempt < 100 && !result; attempt += 1) {
    result = await win.webContents.executeJavaScript(`window.__ready ? window.__result : null`);
    if (!result) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(result, 'the rich-output fixture never became ready');
  assert.equal(result.downloadCount, 2);
  assert.equal(result.downloadAll, 'file_AuroraOriginal0001\u0001file_AuroraOriginal0002');
  assert.equal(result.saveEnabled, true);
  assert.deepEqual(result.savedSelection, ['session-rich', 'response-multi',
    ['file_AuroraOriginal0001', 'file_AuroraOriginal0002']]);
  assert.equal(result.saveOutcome, '1 saved · 1 failed');
  assert.equal(result.single, false);
  assert.equal(result.artifactRejected, 'rejected');
  assert.equal(result.safeAccepted, true);
  assert.equal(result.sandbox, '');
  assert.equal(result.srcdocHasScript, false);
  assert.equal(result.choiceDisabled, 'true');
  clearTimeout(deadline);
  console.log('crystal rich-output renderer ok');
  console.log('signed-in ChatGPT download, choice, and save acceptance: not run');
  win.destroy();
  await server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
