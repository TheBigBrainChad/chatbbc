#!/usr/bin/env node
/**
 * Packaged GUI acceptance for the just-built ChatBBC Linux x64 AppImage.
 *
 * Launches the real artifact on Wayland in a throwaway HOME/XDG profile with a bounded Omarchy
 * palette fixture, attaches to that child's renderer over loopback CDP only, and checks the
 * visible shell, composer draft retention across navigation, and live Appearance off/on/color
 * behaviour. The embedded desktop metadata and executable architecture of the same file are
 * inspected from an extraction under the same temporary directory. Nothing outside that
 * directory is read or written, and every process/socket this script owns is closed before it
 * exits.
 *
 * Native file/folder, PTY and hide-to-tray acceptance stay a separate manual local run: this
 * script never reports them as verified.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'outputs/chatbbc-package');
const darkPalette = [
  'background = "#282828"',
  'foreground = "#d4be98"',
  'accent = "#7daea3"',
  'dark_background = "#1e1e1e"',
  'selection = "#504945"',
  ''
].join('\n');

class AcceptanceFailure extends Error {}
const fail = message => { throw new AcceptanceFailure(message); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function findAppImage() {
  const expected = 'ChatBBC-Linux-x64.AppImage';
  const found = [];
  const walk = directory => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === expected) found.push(full);
    }
  };
  walk(path.join(root, 'release'));
  if (!found.length) fail(`no ${expected} under release/; run npm run dist:linux:x64 first`);
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}

function elfHeader(file) {
  const buffer = Buffer.alloc(20);
  const handle = fs.openSync(file, 'r');
  try { fs.readSync(handle, buffer, 0, 20, 0); } finally { fs.closeSync(handle); }
  if (!(buffer[0] === 0x7f && buffer.subarray(1, 4).toString() === 'ELF')) return { elf: false };
  return { elf: true, bits: buffer[4] === 2 ? 64 : buffer[4] === 1 ? 32 : 0, machine: buffer.readUInt16LE(18) };
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const request = url => new Promise((resolve, reject) => {
  const call = http.get(url, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  call.on('error', reject);
  call.setTimeout(2_000, () => call.destroy(new Error('CDP request timeout')));
});

function cdpClient(socket) {
  let nextId = 0;
  const pending = new Map();
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
    else entry.resolve(message.result);
  });
  socket.on('close', () => { for (const entry of pending.values()) entry.reject(new Error('CDP socket closed')); pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    evaluate: async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails)}`);
      return result.result.value;
    },
    press: async text => {
      for (const character of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
      }
    }
  };
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail(`supports the packaged linux x64 artifact only (running ${process.platform}/${process.arch})`);
  }
  if (!process.env.WAYLAND_DISPLAY?.trim()) fail('requires a working Wayland session: WAYLAND_DISPLAY is not set');

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== '2.2.1') fail(`expected product version 2.2.1, package.json says ${version}`);

  const appImage = findAppImage();
  const run = path.join(output, randomUUID());
  const home = path.join(run, 'home');
  const configDir = path.join(run, 'config');
  const extractDir = path.join(run, 'extract');
  for (const directory of [home, configDir, extractDir]) fs.mkdirSync(directory, { recursive: true });
  const paletteFile = path.join(home, '.local/state/omarchy/current/theme/colors.toml');
  fs.mkdirSync(path.dirname(paletteFile), { recursive: true });
  fs.writeFileSync(paletteFile, darkPalette);

  const childEnvironment = {
    ...process.env,
    APPIMAGELAUNCHER_DISABLE: '1',
    HOME: home,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: path.join(run, 'data'),
    XDG_STATE_HOME: path.join(run, 'state'),
    XDG_CACHE_HOME: path.join(run, 'cache')
  };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  const remotePort = await freePort();
  const logs = [];
  const recordLog = data => {
    logs.push(data.toString());
    if (logs.length > 64) logs.splice(0, logs.length - 64);
  };
  let child = null;
  let socket = null;
  let client = null;
  const exited = () => !child || child.exitCode !== null || child.signalCode !== null;
  const tail = () => logs.join('').split('\n').filter(Boolean).slice(-12).join('\n');

  const launch = extraEnvironment => {
    child = spawn(appImage, [
      '--ozone-platform=wayland',
      `--remote-debugging-port=${remotePort}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run'
    ], { cwd: run, env: { ...childEnvironment, ...extraEnvironment }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', recordLog);
    child.stderr.on('data', recordLog);
    child.on('error', error => logs.push(`spawn error: ${error.message}\n`));
  };

  const stopChild = async () => {
    if (exited()) return;
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      new Promise(resolve => child.once('exit', () => resolve(true))),
      sleep(5_000).then(() => false)
    ]);
    // A hung AppImage must not hold the release gate indefinitely after the graceful deadline.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
    if (!stopped) await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(2_000)
    ]);
  };

  const pageTarget = async (timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (exited()) return null;
      try {
        const listing = JSON.parse(await request(`http://127.0.0.1:${remotePort}/json/list`));
        const target = (Array.isArray(listing) ? listing : [])
          .find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl);
        if (target) return target;
      } catch { /* the browser process has not opened the endpoint yet */ }
      await sleep(250);
    }
    return null;
  };

  try {
    launch();
    let target = await pageTarget(45_000);
    let extractedRuntime = false;
    if (!target) {
      // A host without FUSE still runs the same image through the AppImage runtime's own
      // extractor; both paths execute the artifact that was just built.
      const firstTail = tail();
      await stopChild();
      logs.length = 0;
      launch({ APPIMAGE_EXTRACT_AND_RUN: '1' });
      extractedRuntime = true;
      target = await pageTarget(60_000);
      if (!target) fail(`the packaged app never exposed a renderer over CDP\n${firstTail}\n${tail()}`);
    }

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    client = cdpClient(socket);
    await client.send('Runtime.enable');
    await client.send('Page.enable');

    const title = await client.evaluate('document.title');
    if (title !== 'ChatBBC') fail(`packaged window title is ${JSON.stringify(title)}, expected "ChatBBC"`);
    if (!(await client.evaluate(`!!document.querySelector('.app') && document.querySelector('.sidebar-brand strong').textContent.trim() === 'ChatBBC'`))) {
      fail('the packaged renderer did not paint the ChatBBC shell');
    }
    if (!(await client.evaluate(`!!document.getElementById('composer') && !!document.getElementById('chatInput')`))) {
      fail('the packaged renderer is missing the composer');
    }
    const shot = async name => {
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(run, name), Buffer.from(data, 'base64'));
    };
    await shot('shell.png');

    // --- composer keyboard input survives a navigation round trip.
    await client.evaluate(`document.getElementById('backToChat').click()`);
    await sleep(300);
    if (!(await client.evaluate(`!document.getElementById('composer').hidden`))) fail('the chat composer did not open');
    await client.evaluate(`document.getElementById('chatInput').focus()`);
    await client.press('ChatBBC draft');
    const typed = await client.evaluate(`document.getElementById('chatInput').value`);
    if (typed !== 'ChatBBC draft') fail(`typed composer text is ${JSON.stringify(typed)}`);
    await client.evaluate(`document.getElementById('workspaceSettings').click()`);
    await sleep(300);
    await client.evaluate(`document.getElementById('backToChat').click()`);
    await sleep(300);
    const retained = await client.evaluate(`document.getElementById('chatInput').value`);
    if (retained !== 'ChatBBC draft') fail(`composer draft was lost across navigation (${JSON.stringify(retained)})`);
    await shot('composer.png');

    // --- live Omarchy palette, manual fallback and manual color updates.
    await client.evaluate(`document.getElementById('workspaceSettings').click()`);
    await sleep(200);
    await client.evaluate(`document.querySelector('[data-tab="appearance"]').click()`);
    await sleep(400);
    if (!(await client.evaluate(`document.getElementById('appearancePanel').classList.contains('is-active')`))) {
      fail('the Appearance panel did not open');
    }
    const pageColor = () => client.evaluate(`document.documentElement.style.getPropertyValue('--page').trim()`);
    const following = () => client.evaluate(`document.getElementById('appearanceFollowOmarchy').checked`);
    const status = () => client.evaluate(`document.getElementById('appearanceOmarchyStatus').textContent.trim()`);
    const manualDisabled = () => client.evaluate(`document.querySelector('[data-color="background"]').disabled`);
    const configFile = () => {
      const found = [];
      const walk = directory => {
        let entries = [];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name === 'config.json') found.push(full);
        }
      };
      walk(configDir);
      return found[0] ?? null;
    };
    const savedBackground = () => {
      const file = configFile();
      if (!file) return null;
      try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.ui?.appearance?.dark?.background ?? null; } catch { return null; }
    };

    if (!(await following())) fail('a fresh profile must follow the Omarchy theme');
    if ((await pageColor()) !== '#282828') fail(`live Omarchy background did not apply (${await pageColor()})`);
    if ((await manualDisabled()) !== true) fail('manual colors must stay locked while following a live palette');
    if (!(await status()).length) fail('the Omarchy availability line is empty');
    await shot('appearance-live.png');

    await client.evaluate(`document.getElementById('appearanceFollowOmarchy').click()`);
    await sleep(300);
    if (await following()) fail('turning follow off did not stick');
    if ((await pageColor()) !== '#181818') fail(`manual background did not return (${await pageColor()})`);
    if ((await manualDisabled()) !== false) fail('manual colors must unlock when following is off');
    await shot('appearance-manual.png');

    await client.evaluate(`(() => {const input=document.getElementById('appearance-background-hex');
      input.value='#123456';input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(400);
    if ((await pageColor()) !== '#123456') fail(`a manual color update did not apply (${await pageColor()})`);
    if ((await savedBackground()) !== '#123456') fail(`the manual color was not persisted (${savedBackground()})`);
    await client.evaluate(`document.getElementById('appearanceFollowOmarchy').click()`);
    await sleep(400);
    if (!(await following())) fail('turning follow back on did not stick');
    if ((await pageColor()) !== '#282828') fail(`the live palette did not return (${await pageColor()})`);
    if ((await savedBackground()) !== '#123456') fail('projected live colors must never be persisted');
    await shot('appearance-projection.png');

    // --- embedded identity and architecture of the same file.
    const appImageHeader = elfHeader(appImage);
    if (!appImageHeader.elf || appImageHeader.bits !== 64 || appImageHeader.machine !== 0x3e) {
      fail(`AppImage is not an x86-64 ELF (${JSON.stringify(appImageHeader)})`);
    }
    const extraction = spawnSync(appImage, ['--appimage-extract'], { cwd: extractDir, encoding: 'utf8' });
    if (extraction.status !== 0) fail(`--appimage-extract failed: ${(extraction.stderr || extraction.stdout || '').trim().slice(-400)}`);
    const squashfs = path.join(extractDir, 'squashfs-root');
    if (!fs.existsSync(squashfs)) fail('--appimage-extract produced no squashfs-root');
    const extracted = [];
    const sizes = new Map();
    const collect = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        const relative = path.relative(squashfs, full);
        extracted.push(relative);
        try { sizes.set(relative, fs.lstatSync(full).isFile()); } catch { sizes.set(relative, false); }
        if (entry.isDirectory()) collect(full);
      }
    };
    collect(squashfs);
    const desktopFiles = extracted.filter(relative => relative.endsWith('.desktop'));
    if (desktopFiles.length !== 1) fail(`expected exactly one desktop entry, found ${JSON.stringify(desktopFiles)}`);
    if (path.basename(desktopFiles[0]) !== 'com.chatbbc.app.desktop') fail(`desktop entry is named ${desktopFiles[0]}`);
    const fields = new Map(fs.readFileSync(path.join(squashfs, desktopFiles[0]), 'utf8').split('\n')
      .map(line => /^([A-Za-z0-9-]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(match => [match[1], match[2]]));
    for (const [key, expected] of [['Name', 'ChatBBC'], ['Icon', 'chatbbc'], ['StartupWMClass', 'com.chatbbc.app'], ['X-AppImage-Version', version]]) {
      if (fields.get(key) !== expected) fail(`desktop ${key}=${JSON.stringify(fields.get(key))}, expected ${JSON.stringify(expected)}`);
    }
    if (!/(^|\/)AppRun(\s|$)/.test(fields.get('Exec') ?? '')) fail(`desktop Exec=${JSON.stringify(fields.get('Exec'))} does not launch AppRun`);
    if (!extracted.includes('AppRun')) fail('the AppImage does not carry AppRun');
    const executable = extracted.filter(relative => /(^|\/)chatbbc$/.test(relative)).sort((a, b) => Number(sizes.get(b)) - Number(sizes.get(a)))[0];
    if (!executable) fail('the AppImage does not carry the chatbbc executable');
    const innerHeader = elfHeader(path.join(squashfs, executable));
    if (!innerHeader.elf || innerHeader.bits !== 64 || innerHeader.machine !== 0x3e) {
      fail(`packaged executable ${executable} is not an x86-64 ELF (${JSON.stringify(innerHeader)})`);
    }
    const foreign = extracted.filter(relative =>
      /(^|\/)(win32|win-arm64|darwin|arm64|armv7l)(\/|$)/.test(relative)
      || /\.(exe|dll|dylib)$/.test(relative));
    if (foreign.length) fail(`non-Linux-x64 payload in the artifact: ${foreign.slice(0, 8).join(', ')}`);

    const summary = {
      title: 'ok', shell: 'ok', composerRetention: 'ok', appearance: 'ok', metadata: 'ok', arch: 'ok',
      extractedRuntime, desktop: desktopFiles[0], executable, version,
      screenshots: fs.readdirSync(run).filter(name => name.endsWith('.png')).sort()
    };
    fs.writeFileSync(path.join(run, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`packaged-gui: title=${summary.title} shell=${summary.shell} composerRetention=${summary.composerRetention} `
      + `appearance=${summary.appearance} metadata=${summary.metadata} arch=${summary.arch} version=${summary.version} ${run}`);
  } finally {
    if (client) { try { await client.send('Runtime.disable'); } catch { /* socket already closing */ } }
    socket?.close();
    await stopChild();
    fs.rmSync(extractDir, { recursive: true, force: true });
    for (const directory of ['home', 'config', 'data', 'state', 'cache']) fs.rmSync(path.join(run, directory), { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AcceptanceFailure) console.error(`packaged-gui: ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
}
