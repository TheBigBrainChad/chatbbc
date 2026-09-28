#!/usr/bin/env node
/**
 * Local-only GUI acceptance for the ChatBBC desktop shell.
 *
 * Every GUI fixture is launched with the project's own Electron binary on a real Wayland
 * session (never Xvfb, never ELECTRON_RUN_AS_NODE), sequentially so two fixtures cannot fight
 * over one compositor seat. The Node-only browser-control entry fixture runs last.
 * A child failure fails the run; interruption terminates every child this process owns.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'outputs/verify-local-ui');

const guiFixtures = [
  'verify-appearance.cjs',
  'verify-omarchy-theme.cjs',
  'verify-settings-focus.cjs',
  'verify-sidebar-setup.cjs',
  'verify-workspace-terminal.cjs'
];
const nodeFixtures = ['verify-browser-control-entry.mjs'];

function fail(message) {
  console.error(`verify:ui ${message}`);
  process.exit(1);
}

function waylandSession() {
  const display = process.env.WAYLAND_DISPLAY?.trim();
  if (!display) fail('requires a working Wayland session: WAYLAND_DISPLAY is not set');
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  if (display.startsWith('/')) return display;
  return runtime ? path.join(runtime, display) : display;
}

if (process.platform !== 'linux' || process.arch !== 'x64') {
  fail(`supports linux x64 only (running ${process.platform}/${process.arch})`);
}
const socket = waylandSession();
if (socket.startsWith('/') && !fs.existsSync(socket)) fail(`Wayland socket ${socket} does not exist`);

const electron = path.join(root, 'node_modules', '.bin', 'electron');
if (!fs.existsSync(electron)) fail(`missing ${electron}; run npm ci first`);
const chromium = process.env.COS_TEST_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/brave-browser'].find(candidate => fs.existsSync(candidate));
if (!chromium || !fs.existsSync(chromium)) fail('requires Chromium: set COS_TEST_CHROMIUM to an installed executable');
/** Fixtures that load built output; named here so the failure states the missing prerequisite. */
const prerequisites = { 'verify-settings-focus.cjs': 'out/renderer/index.html' };

/** Electron's own CLI parsing needs the switch before the script path. */
const electronArgs = ['--ozone-platform=wayland'];
const children = new Set();
let interrupted = false;

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
    const force = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5_000);
    force.unref();
  });
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: root,
      // ELECTRON_RUN_AS_NODE would silently turn every GUI fixture into a plain Node script.
      env: (() => { const env = { ...process.env, COS_TEST_CHROMIUM: chromium }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
      stdio: 'inherit'
    });
    children.add(child);
    child.on('error', error => { children.delete(child); resolve({ code: null, error }); });
    child.on('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
}

fs.mkdirSync(output, { recursive: true });
const results = [];
let failed = false;

for (const fixture of guiFixtures) {
  const script = path.join('scripts', fixture);
  if (!fs.existsSync(path.join(root, script))) fail(`missing fixture ${script} (source drift)`);
  const required = prerequisites[fixture];
  if (required && !fs.existsSync(path.join(root, required))) fail(`${fixture} needs ${required}; run npm run build first`);
  console.log(`verify:ui electron ${fixture}`);
  const result = await run(electron, [...electronArgs, script]);
  results.push({ fixture, mode: 'electron', code: result.code, signal: result.signal ?? null, error: result.error?.message ?? null });
  if (interrupted) break;
  if (result.error || result.code !== 0) {
    failed = true;
    console.error(`verify:ui ${fixture} failed (${result.error?.message ?? `exit ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`})`);
    break;
  }
}

if (!interrupted && !failed) {
  for (const fixture of nodeFixtures) {
    const script = path.join('scripts', fixture);
    if (!fs.existsSync(path.join(root, script))) fail(`missing fixture ${script} (source drift)`);
    console.log(`verify:ui node ${fixture}`);
    const result = await run(process.execPath, [script]);
    results.push({ fixture, mode: 'node', code: result.code, signal: result.signal ?? null, error: result.error?.message ?? null });
    if (interrupted) break;
    if (result.error || result.code !== 0) {
      failed = true;
      console.error(`verify:ui ${fixture} failed (${result.error?.message ?? `exit ${result.code}`})`);
      break;
    }
  }
}

for (const child of children) child.kill('SIGTERM');
fs.writeFileSync(path.join(output, 'results.json'), `${JSON.stringify({
  session: { platform: process.platform, arch: process.arch, wayland: socket, electron: electronArgs.join(' ') },
  interrupted, results, passed: !failed && !interrupted
}, null, 2)}\n`);

if (interrupted) {
  console.error('verify:ui interrupted; owned children terminated');
  process.exit(130);
}
if (failed) process.exit(1);
console.log(`verify:ui passed (${results.length} fixtures) ${output}`);
