/**
 * The Skills settings section in real Chromium, against the production renderer.
 *
 * The unit test proves the module; this proves the section is actually in the shipped document,
 * that the existing settings search finds it, and that a toggle reaches the main process and
 * comes back as a redrawn list. The backend is a stub: no installed app, provider, tunnel or
 * user state is touched, and the skills it reports are fixtures.
 *
 * Run with the flags this machine needs for a hidden GPU-less window:
 *
 *   node scripts/verify-skills-library.cjs --ozone-platform=x11 --disable-gpu --in-process-gpu
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/skills-library');
app.setPath('userData', path.join(output, 'runtime'));

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.clear();
    window.fixtureErrors = [];
    window.addEventListener('error', event => window.fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.fixtureErrors.push(String(event.reason)));
    const config = {
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark',tabsToKeepOpen:7,finishAction:'notify'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null}};
    const row = (id,name,description,extra) => Object.assign({id,name,displayName:name,description,shortDescription:'',
      path:'/skills/'+id+'/SKILL.md',scope:'managed',source:'managed',managed:true,allowImplicitInvocation:true,bytes:15360},extra);
    window.fixtureSkills = {
      catalog: [row('brainstorming','Brainstorming','Turn a rough idea into a design.'), row('writing-plans','Writing Plans','Write a plan before touching code.')],
      disabled: [row('diagnose-crash','Diagnose Crash','Diagnose why a program crashed.',{enabled:false,allowImplicitInvocation:false,bytes:40960})],
      calls: [], toggles: 0
    };
    const ok = data => Promise.resolve({ok:true,data});
    window.api = new Proxy({
      getState: () => ok(state),
      getLog: () => ok([]),
      listProjects: () => ok([]),
      listSessions: () => ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm: () => ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels: () => ok({state:'unknown',models:[]}),
      onStateChanged: callback => { window.pushState = () => callback(structuredClone(state)); },
      skillLibrary: scope => {
        window.fixtureSkills.calls.push(structuredClone(scope));
        return ok({skills: structuredClone(window.fixtureSkills.catalog), errors: [], roots: [],
          includeInstructions: true, disabled: structuredClone(window.fixtureSkills.disabled)});
      },
      setSkill: payload => {
        // A refusal is what a stale write looks like; the fixture's own toggles succeed.
        if (window.fixtureReject) { window.fixtureReject = false; return Promise.resolve({ok:false,error:'Fixture refused the change'}); }
        window.fixtureSkills.toggles += 1;
        const list = payload.enabled === false ? window.fixtureSkills.catalog : window.fixtureSkills.disabled;
        const index = list.findIndex(entry => entry.id === payload.id);
        if (index >= 0) {
          const [moved] = list.splice(index, 1);
          if (payload.enabled === false) { moved.enabled = false; window.fixtureSkills.disabled.push(moved); }
          else { moved.enabled = true; window.fixtureSkills.catalog.push(moved); }
        }
        return ok({version:1,seeded:{},enabled:{},implicit:{},removed:[]});
      }
    }, {get:(target,key)=> key in target ? target[key] : () => ok(null)});
    await import('/main.ts');
    window.fixtureReady = true;
  `;

  const server = await createServer({
    configFile: false,
    root: path.join(root, 'src/renderer'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'skills-library-fixture',
      configureServer(vite) {
        vite.middlewares.use('/fixture.html', async (_request, response) => {
          const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace('</body>', '<script type="module">' + fixture + '</script></body>');
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/fixture.html', source));
        });
      }
    }]
  });

  let win;
  try {
    await server.listen();
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    const js = code => win.webContents.executeJavaScript(code);
    const until = async condition => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await js(condition)) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };
    assert.equal(await until('!!window.fixtureReady'), true, 'the renderer never became ready');
    assert.equal(await js('!!window.api && typeof window.api.skillLibrary === "function"'), true);
    // The page is opened through the app's own navigation, not by unhiding the view by hand.
    await js(`document.querySelector('[data-tab="automation"]').click()`);
    assert.equal(await js(`document.getElementById('chatBody').querySelector('[data-view="settings"]').hidden`), false);

    // The section is in the shipped document, under its own heading and inside a pane, which is
    // what lets the existing settings search treat it as a whole section.
    const section = await js(`(() => {
      const heading = [...document.querySelectorAll('.settings-section-title')].find(node => node.textContent.trim() === 'Skills');
      if (!heading) return null;
      const pane = heading.nextElementSibling;
      return {isPane: pane.classList.contains('pane'), list: !!pane.querySelector('#skillsLibraryList'), empty: !!pane.querySelector('#skillsLibraryEmpty')};
    })()`);
    assert.deepEqual(section, { isPane: true, list: true, empty: true }, 'the Skills section is missing or malformed');

    assert.equal(await until('document.querySelectorAll("#skillsLibraryList .skill-library-row").length === 3'), true, 'the rows never rendered');
    const rendered = await js(`(() => [...document.querySelectorAll('#skillsLibraryList .skill-library-row')].map(row => ({
      name: row.querySelector('strong').textContent,
      scope: row.querySelector('.skill-library-scope').textContent,
      size: row.querySelector('.skill-library-size')?.textContent ?? null,
      actions: [...row.querySelectorAll('button')].map(button => button.textContent),
      switches: row.querySelectorAll('input[type="checkbox"]').length
    })))()`);
    assert.deepEqual(rendered.map(row => row.name), ['Brainstorming', 'Writing Plans', 'Diagnose Crash']);
    assert.deepEqual(rendered.slice(0, 2).map(row => row.actions), [['Turn off'], ['Turn off']]);
    assert.deepEqual(rendered[0].size, '15 KB');
    assert.equal(rendered[2].size, '40 KB', 'a turned-off skill still reports what it costs');
    assert.equal(rendered.reduce((sum, row) => sum + row.switches, 0), 2, 'only an enabled skill offers the implicit switch');
    assert.equal(await js(`document.querySelector('#skillsLibraryList .skill-library-group').textContent`), 'Turned off · 1');
    assert.equal(await js(`document.getElementById('skillsLibraryEmpty').hidden`), true);

    // The existing settings search must find the section with no extra code. It searches the
    // heading plus the pane's text, so a term that only exists inside a rendered row proves the
    // search reaches the list rather than just the static markup.
    await js(`(() => {const search = document.getElementById('settingsSearch'); search.value = 'Turn a rough idea'; search.dispatchEvent(new Event('input', {bubbles:true}));})()`);
    const search = await js(`(() => {
      const heading = [...document.querySelectorAll('.settings-section-title')].find(node => node.textContent.trim() === 'Skills');
      return {skillsVisible: !heading.hidden, paneVisible: !heading.nextElementSibling.hidden, searchEmptyHidden: document.getElementById('settingsSearchEmpty').hidden};
    })()`);
    assert.deepEqual(search, { skillsVisible: true, paneVisible: true, searchEmptyHidden: true }, 'settings search does not match the Skills section');
    await js(`(() => {const search = document.getElementById('settingsSearch'); search.value = 'no-such-setting-123'; search.dispatchEvent(new Event('input', {bubbles:true}));})()`);
    assert.equal(await js(`[...document.querySelectorAll('.settings-section-title')].find(node => node.textContent.trim() === 'Skills').hidden`), true);
    await js(`(() => {const search = document.getElementById('settingsSearch'); search.value = ''; search.dispatchEvent(new Event('input', {bubbles:true}));})()`);

    // A toggle round-trips: the write reaches the main process, the re-read is redrawn, and the
    // skill lands in the other group.
    await js(`(() => [...document.querySelectorAll('#skillsLibraryList [data-action="disable"]')].find(button => button.dataset.skillId === 'brainstorming').click())()`);
    assert.equal(await until('document.querySelector("#skillsLibraryList .skill-library-group").textContent === "Turned off · 2"'), true, 'the row never moved groups');
    assert.equal(await js('window.fixtureSkills.toggles'), 1, 'the toggle never reached the main process');
    assert.equal(await js('window.fixtureSkills.calls.length >= 2'), true, 'the page did not re-read after the write');
    const scopes = await js('JSON.stringify(window.fixtureSkills.calls)');
    assert.equal(scopes.includes('"projectId"'), true, 'the page read the library without a scope');

    // And back on: the way back is the whole reason the disabled group exists.
    await js(`(() => [...document.querySelectorAll('#skillsLibraryList [data-action="enable"]')].find(button => button.dataset.skillId === 'brainstorming').click())()`);
    assert.equal(await until('document.querySelector("#skillsLibraryList .skill-library-group").textContent === "Turned off · 1"'), true, 'the skill never came back');
    assert.equal(await js('window.fixtureSkills.toggles'), 2);

    // A refused write is reported rather than silently shown as applied.
    await js('window.fixtureReject = true');
    await js(`(() => [...document.querySelectorAll('#skillsLibraryList [data-action="disable"]')].find(button => button.dataset.skillId === "writing-plans").click())()`);
    assert.equal(await until('!!document.querySelector(".toast")'), true, 'a refused change was not reported');
    assert.equal(await js('document.querySelector(".toast").textContent'), 'Fixture refused the change');
    assert.equal(await js('document.querySelector("#skillsLibraryList .skill-library-group").textContent'), 'Turned off · 1', 'a refused change still moved the row');

    // Nothing may scroll sideways at the window's own size.
    const geometry = await js(`(() => {
      const list = document.getElementById('skillsLibraryList');
      return {listOverflow: list.scrollWidth > list.clientWidth + 1, bodyOverflow: document.documentElement.scrollWidth > innerWidth + 1};
    })()`);
    assert.deepEqual(geometry, { listOverflow: false, bodyOverflow: false });
    assert.deepEqual(await js('window.fixtureErrors'), [], 'the renderer raised an error');

    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ rendered, search, scopes: JSON.parse(scopes), geometry }, null, 2));
    console.log('Skills library Electron checks passed: section renders, search matches, toggles round-trip, a refusal is reported. ' + output);
  } finally {
    win?.destroy();
    await server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
