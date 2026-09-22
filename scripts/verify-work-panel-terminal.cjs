// Hosted work-panel terminal acceptance. Proves the terminal works as a TENANT of the tabbed
// work panel — the path `verify-workspace-terminal.cjs` cannot reach, because that fixture calls
// `createWorkspaceTerminal()` with no host and so only ever covered the old bottom drawer.
//
// This is a separate fixture rather than a branch of that one for a platform reason: it drives a
// real POSIX shell, while the drawer fixture asserts Windows `powershell` titles and PowerShell
// commands. Neither command set runs on the other OS, and weakening either would remove evidence.
//
// Same isolated backend, real IPC and real PTY as the drawer fixture. Run with:
//   node_modules/.bin/electron scripts/verify-work-panel-terminal.cjs \
//     --ozone-platform=x11 --disable-gpu --in-process-gpu
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/work-panel-terminal');

app.setPath('userData', path.join(output, 'runtime'));
if (!process.versions.electron) { console.error('This fixture must run under Electron.'); process.exit(1); }

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const { buildSync } = require('esbuild');
  const helper = path.join(output, 'main.cjs');
  // Bundle the backend from source, so the fixture cannot silently test a stale build.
  buildSync({ stdin: { contents: [
    "export {registerWorkspaceTerminalIpc} from './src/main/workspace-terminal-ipc.ts';",
    "export {initConfigPath, defaultConfig, saveConfig} from './src/main/config.ts';",
    "export {initDurableStore, flushDurable} from './src/main/durable.ts';",
    "export {addProject} from './src/main/projects.ts';"
  ].join('\n'), resolveDir: root }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  const backend = require(helper);
  const workspace = path.join(output, 'project');
  fs.mkdirSync(path.join(workspace, 'child'), { recursive: true });
  backend.initConfigPath(path.join(output, 'state'));
  backend.initDurableStore(path.join(output, 'state'));
  await backend.saveConfig({ ...backend.defaultConfig(), roots: [{ name: 'fixture', path: workspace }] });
  const project = await backend.addProject(workspace);
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    const request=payload=>ipcRenderer.invoke('workspaceTerminal:request',payload);
    contextBridge.exposeInMainWorld('api',{
      terminalCreate:(id,projectId,cols,rows)=>request({action:'create',id,projectId,cols,rows}),
      terminalWrite:(id,data)=>request({action:'write',id,data}),
      terminalResize:(id,cols,rows)=>request({action:'resize',id,cols,rows}),
      terminalAck:(id,count)=>request({action:'ack',id,count}),terminalClose:id=>request({action:'close',id}),
      onTerminalEvent:listener=>{const fn=(_,value)=>listener(value);ipcRenderer.on('workspaceTerminal:event',fn);return()=>ipcRenderer.removeListener('workspaceTerminal:event',fn)},
      writeClipboard:()=>Promise.resolve({ok:true,data:true})
    });`);
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  backend.registerWorkspaceTerminalIpc(() => win);
  const fixture = `
    window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
    window.ids=[];window.outputs={};window.exits={};
    window.api.onTerminalEvent(e=>{if('data' in e){window.outputs[e.id]=(window.outputs[e.id]||'')+e.data;}else window.exits[e.id]=e.exitCode;});
    const {createWorkspaceTerminal}=await import('/workspace-terminal.ts');
    const {createWorkPanel}=await import('/work-panel.ts');
    const host=document.querySelector('[data-panel="chat"]');
    const work=createWorkPanel({host});
    // Stub the other two tenants so the strip behaves as it does in the app: selecting one has
    // to retire the others. Only the terminal is under test here.
    for(const name of ['files','agents']){
      const pane=document.createElement('section');pane.id='stub-'+name;pane.hidden=true;host.append(pane);
      work.register(name,{element:pane,show:()=>{pane.hidden=false;},hide:()=>{pane.hidden=true;}});
    }
    // The one entry point the terminal now has: a tenant of the work panel.
    const terminal=createWorkspaceTerminal({host});
    work.register('terminal',terminal);
    const proto=crypto.randomUUID.bind(crypto);crypto.randomUUID=()=>{const id=proto();window.ids.push(id);return id;};
    terminal.update(${JSON.stringify(project)});
    window.host=host;window.work=work;window.ready=true;`;
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'work-panel-terminal', configureServer(vite) {
    vite.middlewares.use('/fixture.html', async (_, response) => {
      const source = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</body>', '<script type="module">' + fixture + '</script></body>');
      response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml('/fixture.html', source));
    });
  } }] });
  const js = code => win.webContents.executeJavaScript(code);
  const until = async expression => {
    const end = Date.now() + 20_000;
    while (Date.now() < end) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Timeout: ' + expression + ' ' + JSON.stringify(await js('({errors,outputs})')));
  };
  const width = () => js(`Number.parseFloat(getComputedStyle(window.host).getPropertyValue('--work-panel-width'))`);
  const send = text => {
    win.webContents.insertText(text);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  try {
    await server.listen(); fs.mkdirSync(output, { recursive: true });
    await win.loadURL(server.resolvedUrls.local[0] + 'fixture.html');
    await until('window.ready');

    // 1. The strip carries the three tabs, and the terminal is a tenant of the work panel's body.
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-work-tab]')].map(n=>n.dataset.workTab)`),
      ['files', 'agents', 'terminal', 'inspector', 'plan', 'session']);
    await js(`document.querySelector('[data-work-tab="terminal"]').click()`);
    await until('ids.length===1');
    assert.equal(await js('document.getElementById("workspaceTerminal").parentElement.id'), 'workPanelBody');
    assert.equal(await js('document.getElementById("workspaceTerminal").hidden'), false);

    // 2. Selecting the terminal lends the slot its maximum; a second visit lends the same one.
    const widened = await width();
    assert.ok(widened > 600, 'the terminal tab must widen the column, got ' + widened);
    await js(`document.querySelector('[data-work-tab="files"]').click()`);
    await until('document.getElementById("workspaceTerminal").hidden===true');
    assert.ok(await width() < widened, 'leaving the terminal tab must hand the reader width back');
    await js(`document.querySelector('[data-work-tab="terminal"]').click()`);
    await until('document.getElementById("workspaceTerminal").hidden===false');
    assert.equal(await width(), widened);

    // 3. A real shell, in the project's own directory, taking real keyboard input.
    // xterm only receives `sendInputEvent` while its own textarea has focus, so take it first —
    // otherwise the characters echo and the Return is delivered to nothing.
    await js(`document.querySelector('#workspaceTerminal .xterm-helper-textarea').focus()`);
    await until(`document.activeElement?.classList.contains('xterm-helper-textarea')`);
    // The marker is printed by the shell, so waiting for the RESOLVED text ('..._project') cannot
    // be satisfied by the echoed command line, which contains the literal '%s'.
    send(`printf 'HOSTED_%s\\n' "$(basename "$PWD")"`);
    const first = await js('ids[0]');
    await until(`outputs[${JSON.stringify(first)}]?.includes('HOSTED_project')`);
    assert.match(await js(`outputs[${JSON.stringify(first)}]`), /HOSTED_project/);

    // 4. A second tab is a second live shell; switching tabs retires neither.
    await js("document.getElementById('terminalNew').click()");
    await until('ids.length===2');
    const second = await js('ids[1]');
    await js(`document.querySelector('[data-work-tab="files"]').click()`);
    await until('document.getElementById("workspaceTerminal").hidden===true');
    await js(`window.api.terminalWrite(${JSON.stringify(first)}, "echo STILL_ALIVE\\r")`);
    await until(`outputs[${JSON.stringify(first)}]?.includes('STILL_ALIVE')`);

    // 5. Hiding and reopening keeps custody of the same shells.
    await js(`document.querySelector('[data-work-tab="terminal"]').click()`);
    await until('document.getElementById("workspaceTerminal").hidden===false');
    await js("document.getElementById('terminalHide').click()");
    await until('document.getElementById("workspaceTerminal").hidden===true');
    await js("document.getElementById('terminalToggle').click()");
    await until('document.getElementById("workspaceTerminal").hidden===false');
    await js(`window.api.terminalWrite(${JSON.stringify(first)}, "echo REOPENED\\r")`);
    await until(`outputs[${JSON.stringify(first)}]?.includes('REOPENED')`);

    // 6. A shell that exits reports its own code, and the fixture raised no page error.
    await js(`window.api.terminalWrite(${JSON.stringify(second)}, "exit 7\\r")`);
    await until(`exits[${JSON.stringify(second)}]!==undefined`);
    assert.equal(await js(`exits[${JSON.stringify(second)}]`), 7);
    assert.deepEqual(await js('errors'), []);

    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      hosted: true, realPty: true, projectCwd: true, multipleTabs: true, survivesTabSwitch: true,
      hideReopen: true, exitCode: 7, widened
    }, null, 2));
    console.log('Hosted work-panel terminal checks passed. ' + output);
  } finally {
    win.destroy(); await server.close(); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
