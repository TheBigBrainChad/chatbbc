// Isolated renderer + the real main-process Omarchy theme owner, against a temporary state
// directory. The installed theme under the real HOME is only ever read (as the initial input);
// nothing here runs a theme program, edits settings or touches the user's desktop.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/omarchy-theme');
app.setPath('userData', path.join(output, 'runtime'));

const darkPalette = [
  'background = "#282828"',
  'foreground = "#d4be98"',
  'accent = "#7daea3"',
  'dark_background = "#1e1e1e"',
  'selection = "#504945"',
  'red = "#ea6962"',
  'green = "#a9b665"',
  ''
].join('\n');
const lightPalette = [
  'background = "#fafafa"',
  'foreground = "#202020"',
  'accent = "#2456a6"',
  'mode = "light"',
  'selection = "#b3c7f0"',
  ''
].join('\n');

/** The host's live palette is the first input, read with a bounded handle and never written. */
function installedPalette() {
  try {
    const file = path.join(os.homedir(), '.local/state/omarchy/current/theme/colors.toml');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024) return { source: 'fixture', text: darkPalette };
    return { source: 'installed', text: fs.readFileSync(file, 'utf8') };
  } catch { return { source: 'fixture', text: darkPalette }; }
}

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const { buildSync } = require('esbuild');

  // The real owner, config and native-appearance helper — no reimplementation in the fixture.
  const helper = path.join(output, 'main.cjs');
  fs.mkdirSync(output, { recursive: true });
  buildSync({ stdin: { contents: [
    "export { startOmarchyTheme, getOmarchyTheme, onOmarchyThemeChange, refreshOmarchyTheme, stopOmarchyTheme, parseOmarchyPalette } from './src/main/omarchy-theme.ts';",
    "export { initConfigPath, defaultConfig, saveConfig } from './src/main/config.ts';",
    "export { resolvedAppearance, applyNativeAppearance } from './src/main/appearance.ts';",
    "export { resolveAppearance, defaultAppearance, mixColor, contrastRatio, paletteTokens } from './src/shared/appearance.ts';"
  ].join('\n'), resolveDir: root }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  const backend = require(helper);

  const initial = installedPalette();
  const stateDir = path.join(output, 'omarchy-state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  const currentDirectory = path.join(stateDir, 'current');
  const themeDirectory = path.join(currentDirectory, 'theme');
  const colorsFile = path.join(themeDirectory, 'colors.toml');
  fs.mkdirSync(themeDirectory, { recursive: true });
  fs.writeFileSync(colorsFile, initial.text);

  backend.initConfigPath(path.join(output, 'config'));
  await backend.saveConfig(backend.defaultConfig());
  await backend.startOmarchyTheme({ currentDirectory });

  const first = backend.getOmarchyTheme();
  assert.equal(first.status, 'available', 'temporary palette directory must be readable');
  assert.ok(first.palette, 'a valid palette must publish a snapshot');
  assert.equal(backend.resolvedAppearance().theme, first.palette.mode);

  const mainJson = JSON.stringify(first);
  const fixture = `
    localStorage.removeItem('chat-on-steroids.sidebar-order');
    localStorage.removeItem('cos.ui.language');
    const config = {
      roots: [{name:'demo',path:'/tmp/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      commandAllowlist:{enabled:false,mode:'allow',rules:[]},mcp:{instructions:''},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark',tabsToKeepOpen:7,finishAction:'notify'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      omarchyTheme:${mainJson},
      update:{current:'2.2.0',latest:null,stage:'idle',error:null,checkedAt:null}};
    const project = {id:'demo-project',name:'VideoClipper',path:'/tmp/demo',createdAt:1};
    const rows = [0,1,2].map(i=>({id:'task-'+i,title:'Project chat '+(i+1),projectId:project.id,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    const ok=data=>Promise.resolve({ok:true,data});
    window.api = new Proxy({ getState:()=>ok(structuredClone(state)),getLog:()=>ok([]),
      listProjects:()=>ok([project]),listSessions:()=>ok({sessions:rows,total:rows.length,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:callback=>{window.pushState=()=>callback(structuredClone(state));},
      saveSettings:async patch=>{window.savedPatches=(window.savedPatches??[]).concat([structuredClone(patch)]);
        state.config={...state.config,...patch};return {ok:true,data:structuredClone(state)}},
      addSetupProfile:()=>ok(structuredClone(state)),removeSetupProfile:()=>ok(structuredClone(state))
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style'); still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(still);
    window.setOmarchy=value=>{state.omarchyTheme=value;};
    window.fixtureState=state; window.fixtureReady=true;
  `;

  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'omarchy-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request, response) => {
        const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</body>', '<script type="module">' + fixture + '</script></body>');
        response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/fixture.html', source));
      });
    } }] });

  let win;
  const pushes = [];
  let listenerCalls = 0;
  try {
    await server.listen();
    win = new BrowserWindow({ show: true, width: 1100, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    win.webContents.setZoomFactor(1);

    const js = code => win.webContents.executeJavaScript(code);
    const until = async (expression, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await js(expression)) return true;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return false;
    };
    const screenshot = async name => {
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    // Production wiring: one listener owns native chrome and state publication.
    backend.onOmarchyThemeChange(() => {
      listenerCalls++;
      backend.applyNativeAppearance(win);
      const snapshot = JSON.stringify(backend.getOmarchyTheme());
      pushes.push(snapshot);
      void js(`window.setOmarchy(${snapshot});window.pushState()`);
    });
    backend.applyNativeAppearance(win);

    assert.ok(await until('!!window.fixtureReady'), 'renderer fixture did not load');
    assert.ok(await until('document.querySelectorAll(".sess").length > 0'), 'fixture sessions did not render');

    const page = () => js(`document.documentElement.style.getPropertyValue('--page')`);
    const ink = () => js(`document.documentElement.style.getPropertyValue('--ink')`);
    const theme = () => js(`document.documentElement.dataset.theme`);
    const sameColor = async (value, expected, label) => {
      const normalized = hex => {
        const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
        if (match) return match.slice(1).map(part => parseInt(part, 16)).join(',');
        const parts = (hex.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        return parts.join(',');
      };
      assert.equal(normalized(value), normalized(expected), `${label} (${value} vs ${expected})`);
    };
    const expectPalette = async (palette, label) => {
      assert.deepEqual(await js('window.fixtureState.omarchyTheme.palette'), palette, label + ': renderer snapshot');
      assert.equal(await page(), palette.background, label + ': page background');
      assert.equal(await theme(), palette.mode, label + ': theme mode');
      const ratio = backend.contrastRatio(await page(), await ink());
      assert.ok(ratio >= 4.5, label + ': body ink contrast ' + ratio);
      assert.ok((await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)).length > 0, label + ': accent token');
      const sidebarSurface = backend.mixColor(palette.sidebar, palette.background, .13);
      assert.equal(await js(`document.querySelector('.sidebar').style.getPropertyValue('--page')`), sidebarSurface, label + ': sidebar surface');
      assert.ok(backend.contrastRatio(sidebarSurface, await js(`document.querySelector('.sidebar').style.getPropertyValue('--ink')`)) >= 4.5, label + ': sidebar ink contrast');
      assert.equal(await js(`document.querySelector('#connectionPopover').style.getPropertyValue('--page')`), sidebarSurface, label + ': popover surface');
      assert.equal(nativeTheme.themeSource, palette.mode, label + ': native theme');
      await sameColor(win.getBackgroundColor(), palette.background, label + ': native backing');
    };

    await js(`document.querySelector('[data-tab="appearance"]').click()`);
    assert.equal(await js(`document.getElementById('appearancePanel').classList.contains('is-active')`), true);
    const initialPalette = first.palette;
    await expectPalette(initialPalette, 'initial ' + initial.source + ' palette');
    assert.equal(await js(`document.getElementById('appearanceFollowOmarchy').checked`), true);
    assert.ok((await js(`document.getElementById('appearanceOmarchyStatus').textContent`)).length > 0);
    assert.equal(await js(`document.querySelector('[data-color="background"]').disabled`), true, 'manual colors stay locked while following');
    const initialTokens = backend.paletteTokens(initialPalette.background, initialPalette.accent, 60, initialPalette);
    if (initialPalette.selection) {
      assert.equal(await js(`document.documentElement.style.getPropertyValue('--selection')`), initialTokens['--selection'],
        'Omarchy selection must reach the semantic selection token');
      assert.ok((await js(`document.documentElement.style.getPropertyValue('--selection-ink')`)).length > 0);
    }
    // The terminal reads this same projection, so its palette source must move with the theme.
    const terminalSource = { page: await page(), ink: await ink() };
    await screenshot('initial.png');

    // --- dark/light replacement while the owner stays alive.
    const replaceTheme = content => {
      fs.rmSync(themeDirectory, { recursive: true, force: true });
      fs.mkdirSync(themeDirectory, { recursive: true });
      const temporary = colorsFile + '.next';
      fs.writeFileSync(temporary, content);
      fs.renameSync(temporary, colorsFile);
    };
    const waitForPalette = async (mode, timeout = 4_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (backend.getOmarchyTheme().palette?.mode === mode) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    };

    const beforeLight = pushes.length;
    replaceTheme(lightPalette);
    let watcherDriven = await waitForPalette('light');
    if (!watcherDriven) { await backend.refreshOmarchyTheme(); watcherDriven = await waitForPalette('light'); }
    assert.ok(watcherDriven, 'light palette must publish');
    assert.ok(await until(`document.documentElement.style.getPropertyValue('--page') === '#fafafa'`), 'light palette did not reach the renderer');
    assert.ok(pushes.length > beforeLight, 'a replacement directory must publish a new generation');
    await expectPalette(backend.getOmarchyTheme().palette, 'light palette');
    assert.notEqual(await page(), terminalSource.page);
    assert.notEqual(await ink(), terminalSource.ink);
    await screenshot('light.png');

    // --- malformed replacement keeps the last valid palette and says so.
    const generationBeforeInvalid = backend.getOmarchyTheme().generation;
    replaceTheme('background = "#282828"\nbroken = [\n');
    assert.ok(await until(`window.fixtureState.omarchyTheme.status === 'invalid'`, 6_000), 'malformed palette must report invalid');
    assert.equal(await page(), '#fafafa', 'renderer keeps the last valid palette');
    assert.equal(await js(`document.getElementById('appearanceFollowOmarchy').checked`), true);
    assert.ok((await js(`document.getElementById('appearanceOmarchyStatus').textContent`)).length > 0, 'status must explain the live source');
    assert.ok(backend.getOmarchyTheme().generation > generationBeforeInvalid);

    // --- a live push never clobbers a draft or the selected chat.
    await js(`document.querySelector('.sess [data-session-select]').click()`);
    const selectedId = await js(`document.querySelector('.sess.is-sel').dataset.id`);
    const screenBefore = await js(`document.querySelector('.app').dataset.screen`);
    await js(`document.getElementById('chatInput').value='Draft survives the palette';`);
    await screenshot('invalid-last-good.png');
    replaceTheme(darkPalette);
    if (!(await waitForPalette('dark'))) { await backend.refreshOmarchyTheme(); }
    assert.ok(await waitForPalette('dark'), 'dark palette must return');
    assert.ok(await until(`document.documentElement.style.getPropertyValue('--page') === '#282828'`), 'dark palette did not reach the renderer');
    assert.deepEqual(await js('window.fixtureState.omarchyTheme.palette'), backend.getOmarchyTheme().palette);
    // Optional Omarchy colors must reach the semantic tokens the renderer actually painted.
    const darkResolved = backend.resolvedAppearance();
    const darkExpected = backend.paletteTokens(darkResolved.settings[darkResolved.theme].background,
      darkResolved.settings[darkResolved.theme].accent, darkResolved.settings[darkResolved.theme].contrast, darkResolved);
    for (const key of ['--page', '--ink', '--selection', '--selection-ink', '--red-wash', '--green-wash', '--accent-fill']) {
      assert.equal(await js(`document.documentElement.style.getPropertyValue(${JSON.stringify(key)})`), darkExpected[key], key + ' token');
    }
    assert.notEqual(darkExpected['--red'], darkExpected['--green']);
    assert.equal(await js(`document.getElementById('chatInput').value`), 'Draft survives the palette');
    assert.equal(await js(`document.querySelector('.sess.is-sel').dataset.id`), selectedId);
    assert.equal(await js(`document.querySelector('.app').dataset.screen`), screenBefore, 'a live push must not navigate the shell');
    assert.equal(await js(`document.getElementById('appearancePanel').classList.contains('is-active')`), false, 'the session view stays where the user left it');

    // --- follow Off restores saved manual colors; follow On applies the live snapshot again.
    await js(`document.querySelector('[data-tab="appearance"]').click()`);
    assert.equal(await js(`document.getElementById('appearancePanel').classList.contains('is-active')`), true);
    const toggleFollow = async () => {
      await js(`document.getElementById('appearanceFollowOmarchy').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    };
    const following = () => js(`document.getElementById('appearanceFollowOmarchy').checked`);
    await toggleFollow();
    assert.ok(await until('document.getElementById("appearanceFollowOmarchy").checked === false'), 'Space must toggle the follow control');
    assert.equal(await page(), '#181818', 'manual dark background returns when following is off');
    assert.equal(await js(`document.querySelector('[data-color="background"]').disabled`), false);
    assert.ok((await js(`document.getElementById('appearanceOmarchyStatus').textContent`)).length > 0);
    await screenshot('manual-fallback.png');
    await toggleFollow();
    assert.ok(await until('document.getElementById("appearanceFollowOmarchy").checked === true'), 'Space must re-enable following');
    assert.equal(await page(), '#282828', 'live palette applies again');
    assert.equal(await js(`document.querySelector('[data-color="background"]').disabled`), true);

    // --- manual editing while following is off, including a dirty incomplete hex edit.
    await toggleFollow();
    assert.ok(await until('document.getElementById("appearanceFollowOmarchy").checked === false'));
    const change = async (id, value) => {
      await js(`(() => {const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await js('new Promise(r=>setTimeout(r,40))');
    };
    await change('appearance-background-hex', '#123456');
    assert.equal(await page(), '#123456');
    assert.equal(await js(`window.fixtureState.config.ui.appearance.dark.background`), '#123456');
    await js(`window.countBefore=window.savedPatches.length;const hex=document.getElementById('appearance-background-hex');
      hex.focus();hex.value='#12';hex.dispatchEvent(new Event('input',{bubbles:true}));window.pushState()`);
    assert.equal(await js(`document.getElementById('appearance-background-hex').value`), '#12', 'a dirty edit survives a live push');
    assert.equal(await js('window.savedPatches.length===window.countBefore'), true, 'incomplete hex never reaches storage');
    assert.equal(await page(), '#123456');
    await js(`document.getElementById('appearance-background-hex').dispatchEvent(new Event('change',{bubbles:true}))`);
    assert.equal(await js(`document.getElementById('appearance-background-hex').value`), '#123456'.toUpperCase());
    await toggleFollow();
    assert.ok(await until('document.getElementById("appearanceFollowOmarchy").checked === true'));
    assert.equal(await page(), '#282828', 'projected colors stay in memory, not in config');
    assert.equal(await js(`window.fixtureState.config.ui.appearance.dark.background`), '#123456', 'projection never persists live colors');

    // --- reload keeps saved manual choices while the live palette is re-projected.
    const savedUi = JSON.stringify(await js('window.fixtureState.config.ui'));
    const snapshot = JSON.stringify(backend.getOmarchyTheme());
    await win.reload();
    assert.ok(await until('!!window.fixtureReady', 15_000), 'renderer did not reload');
    assert.ok(await until('document.querySelectorAll(".sess").length > 0'));
    await js(`window.fixtureState.config.ui=${savedUi};window.setOmarchy(${snapshot});window.pushState();document.querySelector('[data-tab="appearance"]').click()`);
    assert.equal(await following(), true);
    assert.equal(await js(`window.fixtureState.config.ui.appearance.dark.background`), '#123456');
    assert.equal(await page(), '#282828');
    await expectPalette(backend.getOmarchyTheme().palette, 'reloaded palette');

    // --- the follow control stays keyboard reachable; live status fits narrow and large text.
    assert.deepEqual(await js(`(() => {const box=document.getElementById('appearanceFollowOmarchy');
      return {disabled:box.disabled,tag:box.tagName,labelled:!!box.closest('label'),status:document.getElementById('appearanceOmarchyStatus').getAttribute('role')};})()`),
      { disabled: false, tag: 'INPUT', labelled: true, status: 'status' });
    const layout = [];
    for (const [width, zoom] of [[1100, 1], [640, 1], [1100, 1.5], [800, 1.17]]) {
      win.setSize(width, 900); win.webContents.setZoomFactor(zoom);
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const geometry = await js(`(() => {const panel=document.getElementById('appearancePanel');
        return {viewport:innerWidth,scroll:panel.scrollWidth,width:panel.clientWidth,body:document.documentElement.scrollWidth};})()`);
      assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify({ width, zoom, geometry }));
      assert.ok(geometry.body <= geometry.viewport + 1, JSON.stringify({ width, zoom, geometry }));
      layout.push({ windowWidth: width, zoom, ...geometry });
    }
    await screenshot('narrow-large-zoom.png');
    win.setSize(1100, 900); win.webContents.setZoomFactor(1);

    // --- shutdown: the snapshot is released and a stopped owner publishes nothing.
    const callsAtStop = listenerCalls;
    backend.stopOmarchyTheme();
    assert.equal(backend.getOmarchyTheme().palette, null, 'stop must release the snapshot');
    replaceTheme(lightPalette);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(listenerCalls, callsAtStop, 'a stopped owner must not publish');
    assert.equal(backend.getOmarchyTheme().palette, null);

    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      initialSource: initial.source, watcherDrivenReplace: watcherDriven,
      manualFallback: true, dirtyEditProtected: true, projectedNotPersisted: true, reload: true, layout
    }, null, 2) + '\n');
    console.log('Omarchy live-theme checks passed. ' + output);
  } finally {
    backend.stopOmarchyTheme();
    win?.destroy(); await server.close(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
