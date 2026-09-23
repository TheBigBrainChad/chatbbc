// Run with the repository's Electron binary. Uses real Chromium layout and production CSS.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  // The renderer's stylesheet is split by responsibility: the modules are read in link
  // order, which is also cascade order, so this sees the same rules the renderer applies.
  const sheets = ['base', 'shell', 'transcript', 'composer', 'panels', 'pages', 'dialogs'];
  const css = sheets.map(name => fs.readFileSync(path.join(__dirname, '../src/renderer/styles', `${name}.css`), 'utf8')).join('\n');
  assert.match(css, /field-sizing:\s*content/);
  assert.match(css, /max-height:\s*220px/);
  assert.match(css, /\.card\.is-session > #composer \{[^}]*var\(--glass-high\)/);
  assert.match(css, /\.card\.is-session > \.composer-dock \{[^}]*var\(--glass-medium\)/);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style>
    <section id="host" hidden><form id="composer" class="composer">
    <textarea id="chatInput" rows="1" dir="auto" placeholder="Ask anything…"></textarea>
    <div class="composer-toolbar"><button type="button">+</button></div>
    </form></section>`));
  const results = await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('chatInput'), host = document.getElementById('host');
    const results = [];
    const record = name => results.push({ name, height: input.clientHeight,
      scrollHeight: input.scrollHeight, scrollTop: input.scrollTop,
      overflow: input.scrollHeight > input.clientHeight });
    host.hidden = false; record('initial reveal');
    input.value = 'Pasted line\\n'.repeat(100); input.scrollTop = input.scrollHeight; record('long paste');
    input.value = ''; record('clear');
    input.value = 'one line'; record('short draft');
    input.value = 'wrapped words '.repeat(25); record('wide draft');
    host.style.width = '320px'; record('narrow draft');
    host.style.width = ''; record('wide again');
    host.hidden = true; input.value = 'restored line\\n'.repeat(5);
    host.hidden = false; record('hidden draft restore');
    input.value = ''; record('empty again');
    return results;
  })()`);
  console.log(JSON.stringify(results, null, 2));
  for (const name of ['initial reveal', 'clear', 'short draft', 'wide draft', 'wide again', 'hidden draft restore', 'empty again']) {
    assert.equal(results.find(r => r.name === name).overflow, false, name + ' must fit without scrolling');
  }
  const long = results.find(r => r.name === 'long paste');
  assert.equal(long.height, 220, 'Long input stays bounded');
  assert.equal(long.overflow, true, 'Long input remains scrollable');
  assert.ok(long.scrollTop > 0, 'Overflowing text can actually scroll');
  assert.equal(results.find(r => r.name === 'clear').scrollTop, 0, 'Clearing also resets the scroll position');
  assert.ok(results.find(r => r.name === 'narrow draft').height > results.find(r => r.name === 'wide draft').height,
    'Width changes must recalculate wrapping without an input event');
  assert.equal(results.at(-1).height, results[0].height, 'Empty input has stable initial and cleared geometry');
  const crystal = await win.webContents.executeJavaScript(`(() => {
    const composer = getComputedStyle(document.getElementById('composer'));
    const field = getComputedStyle(document.getElementById('chatInput'));
    return { position: composer.position, shadow: composer.boxShadow, fieldSizing: field.fieldSizing, maxHeight: field.maxHeight };
  })()`);
  assert.equal(crystal.position, 'relative', 'the composer stays anchored');
  assert.notEqual(crystal.shadow, 'none', 'the composer floats');
  assert.equal(crystal.fieldSizing, 'content', 'CSS field sizing owns composer height');
  assert.equal(crystal.maxHeight, '220px');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
