// Isolated renderer/Chromium acceptance. No backend, provider, credentials or pairing.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/sidebar-setup');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    window.fixtureErrors=[];
    window.addEventListener('error',event=>window.fixtureErrors.push(event.error?.stack||event.message));
    window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(event.reason?.stack||String(event.reason)));
    localStorage.removeItem('chatbbc.sidebar-order');
    localStorage.setItem('chatbbc.sidebar-order',JSON.stringify([
      ['demo-project',Array.from({length:18},(_,i)=>'task-'+i)],
      ['second-project',['task-18','task-19','task-20']],
      ['', ['task-21']]
    ]));
    localStorage.removeItem('cos.ui.language');
    const config = {
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      tunnel: {kind:'openai',tunnelId:'',desktopTunnelId:'',binaryPath:''},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    };
    const state = {config,hasApiKey:false,hasGoalKey:false,hasCustomProviderKey:false,
      resolvedBinary:null,bundledTunnelVersion:null,
      platform:{family:'linux',name:'Linux',desktopAutomation:false},
      secureStorage:{available:true,backend:'secret-service',detail:null},
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null},
      omarchy:{generation:0,theme:null,diagnostic:null},
      glass:{mode:'atmospheric',transparent:false,diagnostic:null},glassGeneration:0};
    const project = {id:'demo-project',name:'VideoClipper',path:'C:/demo',createdAt:1};
    const secondProject = {id:'second-project',name:'Second project',path:'C:/second',createdAt:2};
    const rows = Array.from({length:22},(_,i)=>({id:'task-'+i,title:'Project chat '+(i+1),
      projectId:i<18?project.id:i<21?secondProject.id:null,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    const detailEvents = [
      {seq:1,time:1,source:'extension',kind:'user_message',messageId:'navigator-authored',authoredText:'Navigator authored needle',message:{text:'Navigator authored needle',chars:25,truncated:false}},
      {seq:2,time:2,source:'extension',kind:'native_image',messageId:'navigator-image-set',providerAssetId:'file-navigator',providerRole:'tool',providerChannel:'final',previewStatus:'pending'}
    ];
    const ok=data=>Promise.resolve({ok:true,data});
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok([project,secondProject]),listSessions:()=>ok({sessions:rows,total:22,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSession:id=>ok({summary:rows.find(row=>row.id===id),events:detailEvents,total:detailEvents.length,nextFrom:3}),
      listProjectFiles:(projectId,directory)=>ok({projectId,projectName:projectId===project.id?project.name:secondProject.name,directory,
        entries:directory?[]:[{name:'Aurora-notes.md',path:'Aurora-notes.md',kind:'file',bytes:12}],truncated:false}),
      previewProjectFile:(projectId,path)=>{window.navigatorFileOpened=projectId+':'+path;return ok({projectId,projectName:project.name,path,name:path,bytes:12,
        modifiedAt:new Date(0).toISOString(),revision:'a'.repeat(64),binary:false,text:'Aurora file preview',truncated:false})},
      watchProjectFiles:()=>ok(true),onProjectFilesChanged:()=>()=>{},
      getChatModels:()=>ok({state:'unknown',models:[]}),
      saveSettings:patch=>{state.config={...state.config,...patch};return ok(state)},
      addSetupProfile:name=>{
        const previous={id:config.tunnel.profileId??'default',name:config.tunnel.profileName??'Default',tunnelId:'',desktopTunnelId:'',pluginsTunnelId:''};
        config.setupProfiles=[...(config.setupProfiles??[]),previous];
        config.tunnel={...config.tunnel,profileId:'fixture-profile',profileName:name,profileEpoch:(config.tunnel.profileEpoch??0)+1};
        return ok(state);
      },
      removeSetupProfile:id=>{config.setupProfiles=config.setupProfiles.filter(p=>p.id!==id);return ok(state)}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style'); still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(still);
    window.fixtureReady=true;
  `;
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'),
    server:{host:'127.0.0.1',port:0}, plugins:[{ name:'sidebar-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`Renderer expression failed: ${code}\n${error?.stack || error}`); }
    };
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group[data-project-id=\\"demo-project\\"] > .sess").length === 5'));i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js('window.fixtureReady===true'),true,JSON.stringify(await js('window.fixtureErrors')));
    await js(`window.disclosureEvents=[]; for(const type of ['keydown','keypress','keyup','click']) document.addEventListener(type,e=>window.disclosureEvents.push({type,key:e.key,tag:e.target.tagName,cls:e.target.className,open:document.querySelector('.project-group')?.open}),true)`);
    assert.equal(await js(`document.querySelectorAll('.project-group[data-project-id="demo-project"] > .sess').length`),5,
      JSON.stringify(await js(`({errors:window.fixtureErrors,body:document.body.innerText.slice(0,500)})`)));
    // Project groups start closed. Exercise native summary activation before the
    // existing visible-row geometry, drag ordering and pagination checks.
    assert.equal(await js(`document.querySelector('.project-group').open`), false);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const headingPoint = await js(`(() => {const r=document.querySelector('.project-heading').getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})()`);
    const expectDisclosure = async open => {
      for (let i=0;i<100;i++) {
        if (await js(`document.querySelector('.project-group').open === ${open}`)) return;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(await js(`document.querySelector('.project-group').open`),open,
        JSON.stringify(await js(`({focus:document.activeElement.outerHTML.slice(0,250),events:window.disclosureEvents.slice(-12)})`)));
    };
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...headingPoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...headingPoint});
    await expectDisclosure(true);
    await js(`document.querySelector('.project-heading').focus()`);
    for (const keyCode of ['Space','Enter']) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode});
      // Enter's native summary activation uses the character event. Electron's
      // low-level keyDown/keyUp pair does not synthesize that part of typing.
      if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode});
      await expectDisclosure(keyCode === 'Enter');
    }
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const geometry = await js(`(() => { const group=document.querySelector('.project-group');
      const title=group.querySelector('.project-name').getBoundingClientRect(), chat=group.querySelector('.sess-top b').getBoundingClientRect();
      return {title:title.left,chat:chat.left,count:group.querySelectorAll(':scope > .sess').length,color:getComputedStyle(document.getElementById('newChat')).color,
        icon:document.querySelector('#newChat use').getAttribute('href')}; })()`);
    assert.equal(geometry.count,5); assert.ok(Math.abs(geometry.title-geometry.chat)<1,JSON.stringify(geometry));
    assert.equal(geometry.color,'rgb(255, 255, 255)'); assert.equal(geometry.icon,'#i-pencil');
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await new Promise(r=>setTimeout(r,200));
    const points=await js(`[...document.querySelectorAll('.project-group[data-project-id="demo-project"] > .sess')].map(row=>{const r=row.getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    const moved=await js(`[...document.querySelectorAll('.project-group[data-project-id="demo-project"] > .sess')].map(row=>row.dataset.id)`);
    assert.deepEqual(moved,['task-1','task-2','task-0','task-3','task-4']);
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await new Promise(r=>setTimeout(r,200));
    win.webContents.setZoomFactor(1.17);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true);
    win.webContents.setZoomFactor(1);
    await js(`document.querySelector('.project-show-more').click()`);
    assert.equal(await js(`document.querySelectorAll('.project-group[data-project-id="demo-project"] > .sess').length`),13);
    const groups=await js(`[...document.querySelectorAll('.project-group')].map(group=>({id:group.dataset.projectId,open:group.open}))`);
    assert.equal(groups.some(group=>group.id==='second-project'),true,JSON.stringify(groups));
    await js(`document.querySelector('.project-group[data-project-id="second-project"]').open=true`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const cross=await js(`(() => {
      const source=document.querySelector('.project-group[data-project-id="demo-project"] > .sess');
      const target=document.querySelector('.project-group[data-project-id="second-project"] > .sess');
      const a=source.getBoundingClientRect(),b=target.getBoundingClientRect();
      return {source:{x:Math.round(a.left+35),y:Math.round(a.top+a.height/2)},target:{x:Math.round(b.left+35),y:Math.round(b.top+b.height/2)}};
    })()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...cross.source});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...cross.target});
    await new Promise(r=>setTimeout(r,40));
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...cross.target});
    await new Promise(r=>setTimeout(r,40));
    const clamped=await js(`(() => {
      const ids=id=>[...document.querySelectorAll('.project-group[data-project-id="'+id+'"] > .sess')].map(row=>row.dataset.id);
      return {first:ids('demo-project'),second:ids('second-project'),saved:JSON.parse(localStorage.getItem('chatbbc.sidebar-order'))};
    })()`);
    assert.deepEqual(clamped.first,['task-2','task-0','task-3','task-4','task-5','task-6','task-7','task-8','task-9','task-10','task-11','task-12','task-1']);
    assert.deepEqual(clamped.second,['task-18','task-19','task-20']);
    const savedFirst=clamped.saved.find(([scope])=>scope==='demo-project')[1];
    assert.deepEqual(savedFirst.slice(-5),['task-13','task-14','task-15','task-16','task-17']);
    assert.equal(savedFirst.some(id=>['task-18','task-19','task-20'].includes(id)),false);
    await js(`(() => {
      const search=document.getElementById('navigatorSearch');
      search.value='Project chat 14';
      search.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    assert.equal(await js(`document.querySelectorAll('#navigatorResults [data-id="task-13"]').length`),1);
    await js(`document.querySelector('#navigatorResults [data-id="task-13"]').click()`);
    for(let i=0;i<100 && !(await js(`document.getElementById('timeline').textContent.includes('Navigator authored needle')`));i++) await new Promise(r=>setTimeout(r,25));
    await js(`(() => {const search=document.getElementById('navigatorSearch');search.value='Navigator authored needle';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await js(`document.querySelector('#navigatorResults [data-id="task-13"]')!==null`),true);
    await js(`(() => {const search=document.getElementById('navigatorSearch');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const railPoint = async destination => js(`(() => {const r=document.querySelector('[data-destination="${destination}"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    const filesPoint = await railPoint('files');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...filesPoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...filesPoint});
    for(let i=0;i<100 && !(await js(`document.querySelector('.file-tree-row[data-path="Aurora-notes.md"]')`));i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js(`document.querySelector('[data-destination="chats"]').getAttribute('aria-current')`),'page');
    assert.equal(await js(`document.getElementById('appShell').dataset.workbenchOpen`),'true');
    assert.equal(await js(`document.querySelector('[data-work-tab="files"]').getAttribute('aria-selected')`),'true');
    await js(`document.querySelector('[data-destination="chats"]').click()`);
    await js(`(() => {const search=document.getElementById('navigatorSearch');search.value='Aurora-notes';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await js(`document.querySelector('#navigatorResults [data-path="Aurora-notes.md"]')!==null`),true);
    await js(`document.querySelector('#navigatorResults [data-path="Aurora-notes.md"]').click()`);
    for(let i=0;i<100 && !(await js(`window.navigatorFileOpened==='demo-project:Aurora-notes.md'`));i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js(`document.querySelector('.file-tree-row[data-path="Aurora-notes.md"]').classList.contains('is-selected')`),true);
    await js(`document.querySelector('[data-destination="chats"]').click()`);
    await js(`(() => {const search=document.getElementById('navigatorSearch');search.value='ChatGPT generated image';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await js(`document.querySelector('#navigatorResults [data-image-set]')!==null`),true);
    await js(`document.querySelector('#navigatorResults [data-image-set]').click()`);
    assert.equal(await js(`document.activeElement.closest('.generated-image-gallery,.said.native-image')!==null`),true);
    await js(`(() => {const search=document.getElementById('navigatorSearch');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await js(`document.querySelector('[data-destination="agents"]').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await new Promise(r=>setTimeout(r,40));
    assert.equal(await js(`document.querySelector('[data-destination="chats"]').getAttribute('aria-current')`),'page');
    assert.equal(await js(`document.querySelector('[data-work-tab="agents"]').getAttribute('aria-selected')`),'true');
    await js(`document.querySelector('[data-destination="usage"]').click()`);
    assert.equal(await js(`document.querySelector('[data-panel="usage"]').classList.contains('is-active')`),true);
    assert.equal(await js(`document.querySelector('[data-destination="usage"]').getAttribute('aria-current')`),'page');
    await js(`document.querySelector('[data-destination="settings"]').click()`);
    for (const [index,panel] of ['workspace','automation','appearance'].entries()) {
      if(index%2===0) {
        const point=await js(`(() => {const r=document.querySelector('[data-settings-panel="${panel}"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
        win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
        win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      } else {
        await js(`document.querySelector('[data-settings-panel="${panel}"]').focus()`);
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
      }
      await new Promise(r=>setTimeout(r,25));
      const targetPanel=panel==='automation'?'chat':panel;
      assert.equal(await js(`document.querySelector('[data-panel="${targetPanel}"]').classList.contains('is-active')`),true,panel);
    }
    await js(`document.querySelector('[data-settings-panel="activity"]').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await new Promise(r=>setTimeout(r,40));
    assert.equal(await js(`document.querySelector('[data-panel="activity"]').classList.contains('is-active')`),true);
    await js(`document.querySelector('[data-settings-panel="workspace"]').click();document.getElementById('openSetup').click();document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').classList.contains('is-active')`),true);
    await new Promise(r=>setTimeout(r,200));
    await js(`document.getElementById('wizExpand').click()`);
    assert.equal(await js(`document.getElementById('wizard').classList.contains('is-tidy')`),false);
    await new Promise(r=>setTimeout(r,100));
    await js(`document.querySelector('[data-destination="chats"]').click()`);
    assert.equal(await js(`document.getElementById('appShell').dataset.screen`),'chat');
    assert.equal(await js(`document.getElementById('appShell').dataset.workbenchOpen`),'false');
    assert.equal(await js(`document.querySelector('[data-destination="chats"]').getAttribute('aria-current')`),'page');
    console.log(JSON.stringify({projectDisclosure:{initiallyCollapsed:true,pointer:true,space:true,enter:true},geometry,drag:moved,dragClamp:clamped,showMore:13,navigatorSearch:{chat:true,authoredPreview:true,file:true,imageSet:true},rail:{files:true,agents:true,usage:true,settings:true,chats:true},settingsPanels:true,collapse:true,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
