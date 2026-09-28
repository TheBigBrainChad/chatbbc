#!/usr/bin/env node
/**
 * Guards the ChatBBC rebrand: no predecessor product identity may survive in the tracked tree
 * (or in nonignored new files) unless the change map records the exact literal and reasons it.
 *
 * Two things are checked:
 *
 *  1. Residue. Every predecessor spelling, standalone `CoS`/`COS` token and `TobisComputer`
 *     reference found in a text file must be covered by a `retainedIdentifiers` entry in
 *     `docs/upstream-map.json` naming that exact path and literal, with a precise reason code.
 *     Files are enumerated, never allowlisted wholesale: one historical comment in a runtime
 *     file does not excuse the rest of it.
 *  2. Live declarations. The identity values a release depends on — package, desktop entry,
 *     app slug/protocol, extension, connector titles — must state ChatBBC and version 2.2.0,
 *     and no `.github/workflows` file may exist at all.
 *
 * `docs/upstream-map.json` is not scanned because it is the inventory itself, and this script is
 * not scanned because it holds the pattern list. Both exceptions are constant, not configurable.
 *
 * This scan supplements the runtime checks; it cannot certify pixels or connector behavior.
 *
 * Usage: node scripts/verify-rebrand.mjs
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { retainedReasonProblem } from './verify-upstream-map.mjs';

export const MAP_PATH = 'docs/upstream-map.json';
export const SCAN_EXCLUSIONS = Object.freeze([MAP_PATH, 'scripts/verify-rebrand.mjs']);

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif',
  '.zip', '.gz', '.tgz', '.tar', '.xz', '.bz2', '.7z', '.pdf', '.woff', '.woff2', '.ttf', '.otf',
  '.node', '.so', '.dll', '.dylib', '.exe', '.wasm', '.appimage', '.pyc'
]);
const WORKFLOW_PATTERN = /^\.github\/workflows\/.*\.(ya?ml)$/;

class GuardError extends Error {}

function runGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : error.message;
    throw new GuardError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

/**
 * The predecessor spellings, assembled from fragments so this file's own text stays clean.
 * `chat on steroids`, `chat-on-steroids`, `ChatOnSteroids` and `chatonsteroids` all match the
 * first pattern; the acronym tokens are matched only as standalone words so the retained
 * `COS_*`/`cos-*` protocol identifiers and unrelated words like "cosy" are untouched.
 */
const PREDECESSOR_PATTERNS = Object.freeze([
  new RegExp(['chat', 'on', 'steroids'].join('[\\s_-]?'), 'gi'),
  new RegExp(`(?<![A-Za-z0-9_])${'CoS'}(?![A-Za-z0-9_])`, 'g'),
  new RegExp(`(?<![A-Za-z0-9_])${'COS'}(?![A-Za-z0-9_])`, 'g'),
  new RegExp(['tobis', 'computer'].join('[\\s_-]?'), 'gi')
]);

/** Every predecessor match in a text, with the literal as it appears and its 1-based line. */
export function findBrandMatches(text) {
  const matches = [];
  for (const pattern of PREDECESSOR_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      matches.push({ literal: match[0], line: text.slice(0, match.index).split('\n').length });
    }
  }
  matches.sort((left, right) => left.line - right.line || left.literal.localeCompare(right.literal));
  return matches;
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The live identity declarations, as data so the guard's coverage is auditable rather than
 * scattered through prose. Each check reads file text and returns the problems it found.
 */
export const IDENTITY_CHECKS = Object.freeze([
  {
    id: 'package-identity',
    files: ['package.json'],
    verify: files => {
      const problems = [];
      let pkg;
      try {
        pkg = JSON.parse(files['package.json']);
      } catch {
        return ['package.json is not valid JSON'];
      }
      if (pkg.name !== 'chatbbc') problems.push(`package.json name must be "chatbbc", got ${JSON.stringify(pkg.name)}`);
      if (pkg.version !== '2.2.0') problems.push(`package.json version must be "2.2.0", got ${JSON.stringify(pkg.version)}`);
      if (pkg.homepage !== 'https://github.com/TheBigBrainChad/chatbbc') problems.push(`package.json homepage must point at TheBigBrainChad/chatbbc, got ${JSON.stringify(pkg.homepage)}`);
      const author = record(pkg.author) ? pkg.author.name : pkg.author;
      if (author !== 'TheBigBrainChad') problems.push(`package.json author must be "TheBigBrainChad", got ${JSON.stringify(pkg.author)}`);
      return problems;
    }
  },
  {
    id: 'desktop-identity',
    files: ['package.json', 'electron-builder.yml'],
    verify: files => {
      const problems = [];
      let pkg;
      try {
        pkg = JSON.parse(files['package.json']);
      } catch {
        return ['package.json is not valid JSON'];
      }
      if (pkg.desktopName !== 'com.chatbbc.app.desktop') problems.push(`package.json desktopName must be "com.chatbbc.app.desktop", got ${JSON.stringify(pkg.desktopName)}`);
      const builder = files['electron-builder.yml'];
      for (const expected of ['appId: com.chatbbc.app', 'productName: ChatBBC', 'executableName: chatbbc', 'artifactName: ChatBBC-Linux-x64.AppImage']) {
        if (!builder.includes(expected)) problems.push(`electron-builder.yml must declare "${expected}"`);
      }
      if (!/target:\s*\n\s*-\s*AppImage\b/.test(builder)) problems.push('electron-builder.yml must target only the Linux AppImage builder');
      for (const forbidden of ['nsis:', 'dmg:', 'deb:', 'afterPack:', 'mac:']) {
        if (builder.includes(forbidden)) problems.push(`electron-builder.yml must not declare "${forbidden}" for an unsupported target`);
      }
      return problems;
    }
  },
  {
    id: 'app-slug-protocol',
    files: ['src/main/version.ts', 'extension/background.js'],
    verify: files => {
      const problems = [];
      const version = files['src/main/version.ts'];
      for (const expected of ["APP_VERSION = '2.2.0'", "APP_TITLE = 'ChatBBC'", "APP_SLUG = 'chatbbc'", 'BRIDGE_PROTOCOL = 18', 'TheBigBrainChad/chatbbc/releases/download', 'ChatBBC-Extension.zip']) {
        if (!version.includes(expected)) problems.push(`src/main/version.ts must declare ${JSON.stringify(expected)}`);
      }
      const background = files['extension/background.js'];
      if (!/const BRIDGE_PROTOCOL = 18\b/.test(background)) problems.push('extension/background.js must speak bridge protocol 18');
      if (!/app === 'chatbbc'/.test(background)) problems.push("extension/background.js must accept only the 'chatbbc' app stamp");
      return problems;
    }
  },
  {
    id: 'extension-identity',
    files: ['extension/manifest.json', 'extension/_locales/en/messages.json'],
    verify: files => {
      const problems = [];
      let manifest;
      try {
        manifest = JSON.parse(files['extension/manifest.json']);
      } catch {
        return ['extension/manifest.json is not valid JSON'];
      }
      if (manifest.version !== '2.2.0') problems.push(`extension/manifest.json version must be "2.2.0", got ${JSON.stringify(manifest.version)}`);
      let messages;
      try {
        messages = JSON.parse(files['extension/_locales/en/messages.json']);
      } catch {
        return [...problems, 'extension/_locales/en/messages.json is not valid JSON'];
      }
      const name = messages.extension_name?.message;
      if (name !== 'ChatBBC Companion') problems.push(`extension_name must be "ChatBBC Companion", got ${JSON.stringify(name)}`);
      return problems;
    }
  },
  {
    id: 'connector-titles',
    files: ['src/main/mcp/surfaces.ts'],
    verify: files => {
      const problems = [];
      const surfaces = files['src/main/mcp/surfaces.ts'];
      if (!surfaces.includes("CONNECTOR_BRAND = 'ChatBBC'")) problems.push("src/main/mcp/surfaces.ts must set CONNECTOR_BRAND = 'ChatBBC'");
      for (const expected of ["serverName: 'chatbbc-core'", "serverName: 'chatbbc-desktop'", "serverName: 'chatbbc-plugins'"]) {
        if (!surfaces.includes(expected)) problems.push(`src/main/mcp/surfaces.ts must declare ${expected}`);
      }
      return problems;
    }
  }
]);

async function readTextFile(root, relative) {
  try {
    const absolute = path.join(root, ...relative.split('/'));
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(absolute));
  } catch {
    return null;
  }
}

function isTextCandidate(relative) {
  if (SCAN_EXCLUSIONS.includes(relative)) return false;
  return !BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

async function listScannedTexts(root) {
  const tracked = runGit(root, ['ls-files', '-z']).split('\0');
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  const texts = new Map();
  for (const relative of new Set([...tracked, ...untracked])) {
    if (relative === '' || !isTextCandidate(relative)) continue;
    const text = await readTextFile(root, relative);
    if (text !== null) texts.set(relative, text);
  }
  return texts;
}

function retainedEntries(map) {
  return Array.isArray(map.retainedIdentifiers) ? map.retainedIdentifiers : [];
}

/** Every residual match needs an exception, and every exception needs a live literal and a reason code. */
export function residueErrors(texts, entries) {
  const problems = [];
  const excused = new Set();
  entries.forEach((entry, index) => {
    const label = `retainedIdentifiers[${index}]`;
    if (!record(entry) || typeof entry.path !== 'string' || typeof entry.literal !== 'string') {
      problems.push(`${label} must be an object with string "path" and "literal"`);
      return;
    }
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    const problem = retainedReasonProblem(reason);
    if (problem) problems.push(`${label}.reason ${problem}`);
    excused.add(`${entry.path}\0${entry.literal}`);
    const text = texts.get(entry.path);
    if (text === undefined) {
      problems.push(`${label} names ${entry.path}, which is not a scanned text file`);
      return;
    }
    if (!text.includes(entry.literal)) {
      problems.push(`${label}: "${entry.literal}" is no longer present in ${entry.path}, so the exception is stale`);
    }
  });
  for (const [relative, text] of texts) {
    for (const { literal, line } of findBrandMatches(text)) {
      if (!excused.has(`${relative}\0${literal}`)) {
        problems.push(`${relative}:${line} contains the predecessor name "${literal}" with no retainedIdentifiers entry`);
      }
    }
  }
  return problems.sort();
}

async function main() {
  const repo = runGit(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  let map;
  try {
    map = JSON.parse(await fs.readFile(path.join(repo, MAP_PATH), 'utf8'));
  } catch (error) {
    throw new GuardError(`${MAP_PATH} is unreadable or not valid JSON: ${error.message}`);
  }

  const problems = [];
  const paths = [...runGit(repo, ['ls-files', '-z']).split('\0'), ...runGit(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')];
  for (const relative of paths.sort()) {
    if (WORKFLOW_PATTERN.test(relative)) problems.push(`${relative} exists: hosted workflows are not part of this repository`);
  }

  const texts = await listScannedTexts(repo);
  for (const check of IDENTITY_CHECKS) {
    const missing = check.files.filter(file => !texts.has(file));
    if (missing.length > 0) {
      problems.push(`${check.id}: missing ${missing.join(', ')}`);
      continue;
    }
    const files = {};
    for (const file of check.files) files[file] = texts.get(file);
    problems.push(...check.verify(files).map(problem => `${check.id}: ${problem}`));
  }
  problems.push(...residueErrors(texts, retainedEntries(map)));

  if (problems.length > 0) {
    throw new GuardError(`rebrand problems:\n  ${problems.join('\n  ')}`);
  }
  process.stdout.write(`verify-rebrand: scanned ${texts.size} files; identity declarations and residue inventory are current.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const prefix = error instanceof GuardError ? 'verify-rebrand:' : 'verify-rebrand: unexpected failure:';
    process.stderr.write(`${prefix} ${error.message}\n`);
    process.exitCode = 1;
  });
}
