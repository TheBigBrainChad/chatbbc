#!/usr/bin/env node
/**
 * Guards the downstream change map (`docs/upstream-map.json`) against the pinned upstream tree.
 *
 * ChatBBC is a downstream of the pinned upstream repository, and every tracked, staged or nonignored new
 * path must be accounted for exactly once against the pinned upstream commit. Without this
 * check a port silently loses a file, a stale entry claims a path that upstream never changed,
 * or two groups both claim the same path and the map stops being an authority.
 *
 * The comparison is deliberately `git diff --no-renames <upstream> --` plus the nonignored
 * untracked list: git resolves attributes, filters and modes exactly as a later port would,
 * so the guard cannot drift from the real tree. When the pinned object is missing the guard
 * prints the exact fetch command and fails instead of downloading anything.
 *
 * Usage:
 *   node scripts/verify-upstream-map.mjs
 *   node scripts/verify-upstream-map.mjs --emit-draft   # paste-ready entry groups for unmapped paths
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAP_PATH = 'docs/upstream-map.json';
export const CATEGORIES = Object.freeze([
  'identity',
  'assets',
  'prompts',
  'omarchy',
  'linux-release',
  'local-automation',
  'documentation',
  'verification',
  'composer',
  'content-reference',
  'control-api'
]);
export const PORT_CLASSIFICATIONS = Object.freeze([
  'port',
  'adapt',
  'already-equivalent',
  'translate',
  'provenance-only',
  'intentionally-not-imported'
]);
export const RETAINED_REASON_CODES = Object.freeze([
  'license',
  'historical-report',
  'provenance-url',
  'internal-identifier',
  'negative-test-fixture'
]);

const CATEGORY_SET = new Set(CATEGORIES);
const ENTRY_KEYS = new Set(['id', 'category', 'paths', 'upstreamAnchors', 'decision', 'portRule', 'checks', 'notes']);
const ROOT_KEYS = new Set(['schemaVersion', 'upstream', 'downstream', 'changes', 'retainedIdentifiers', 'ports']);
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const WORKFLOW_PATTERN = /^\.github\/workflows\//;

class GuardError extends Error {}

function runGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = typeof error.stderr === 'string' && error.stderr.trim() ? error.stderr.trim() : error.message;
    throw new GuardError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.includes('\\') || value.endsWith('/')) return false;
  return !value.split('/').some(segment => segment === '.' || segment === '..' || segment === '');
}

function checkKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown field "${key}"`);
  }
}

function nonEmptyString(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function stringArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array of strings`);
    return;
  }
  value.forEach((item, index) => {
    if (!nonEmptyString(item, `${label}[${index}]`, errors)) return;
    if (!validRepoPath(item)) errors.push(`${label}[${index}] "${item}" is not a normalized repository-relative path`);
  });
}

/** Structural validation of the map document. Pure: no filesystem, no git. */
export function validateMap(map) {
  const errors = [];
  if (!isRecord(map)) return ['docs/upstream-map.json must contain a JSON object'];
  checkKeys(map, ROOT_KEYS, 'docs/upstream-map.json', errors);
  if (map.schemaVersion !== 1) errors.push(`schemaVersion must be the number 1, got ${JSON.stringify(map.schemaVersion)}`);
  for (const side of ['upstream', 'downstream']) {
    const block = map[side];
    if (!isRecord(block)) {
      errors.push(`${side} must be an object`);
      continue;
    }
    checkKeys(block, new Set(['repository', 'commit', 'version']), side, errors);
    nonEmptyString(block.repository, `${side}.repository`, errors);
    nonEmptyString(block.version, `${side}.version`, errors);
    if (side === 'upstream' && !COMMIT_PATTERN.test(String(block.commit))) {
      errors.push(`upstream.commit must be a full 40-character lowercase SHA, got ${JSON.stringify(block.commit)}`);
    }
  }
  if (!Array.isArray(map.changes)) {
    errors.push('changes must be an array');
  } else {
    const ids = new Map();
    map.changes.forEach((change, index) => {
      const label = `changes[${index}]`;
      if (!isRecord(change)) {
        errors.push(`${label} must be an object`);
        return;
      }
      checkKeys(change, ENTRY_KEYS, label, errors);
      if (nonEmptyString(change.id, `${label}.id`, errors) && !ID_PATTERN.test(change.id)) {
        errors.push(`${label}.id "${change.id}" must be lowercase kebab-case`);
      }
      const previous = ids.get(change.id);
      if (previous !== undefined) errors.push(`duplicate entry id "${change.id}" in ${previous} and ${label}`);
      else ids.set(change.id, label);
      if (!CATEGORY_SET.has(change.category)) {
        errors.push(`${label}.category ${JSON.stringify(change.category)} is not one of ${CATEGORIES.join(', ')}`);
      }
      stringArray(change.paths, `${label}.paths`, errors);
      if (!Array.isArray(change.upstreamAnchors)) {
        errors.push(`${label}.upstreamAnchors must be an array of strings`);
      } else {
        change.upstreamAnchors.forEach((anchor, anchorIndex) => {
          if (!nonEmptyString(anchor, `${label}.upstreamAnchors[${anchorIndex}]`, errors)) return;
          if (!validRepoPath(anchor)) errors.push(`${label}.upstreamAnchors[${anchorIndex}] "${anchor}" is not a normalized repository-relative path`);
        });
      }
      nonEmptyString(change.decision, `${label}.decision`, errors);
      nonEmptyString(change.portRule, `${label}.portRule`, errors);
      stringArray(change.checks, `${label}.checks`, errors);
      if (change.notes !== undefined && typeof change.notes !== 'string') errors.push(`${label}.notes must be a string when present`);
    });
  }
  if (!Array.isArray(map.retainedIdentifiers)) {
    errors.push('retainedIdentifiers must be an array');
  } else {
    map.retainedIdentifiers.forEach((entry, index) => {
      const label = `retainedIdentifiers[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${label} must be an object`);
        return;
      }
      checkKeys(entry, new Set(['path', 'literal', 'reason']), label, errors);
      if (nonEmptyString(entry.path, `${label}.path`, errors) && !validRepoPath(entry.path)) {
        errors.push(`${label}.path "${entry.path}" is not a normalized repository-relative path`);
      }
      nonEmptyString(entry.literal, `${label}.literal`, errors);
      if (nonEmptyString(entry.reason, `${label}.reason`, errors)) {
        const problem = retainedReasonProblem(entry.reason);
        if (problem) errors.push(`${label}.reason ${problem}`);
      }
    });
  }
  validatePortsShape(map.ports, errors);
  return errors;
}

function validatePortsShape(ports, errors) {
  if (ports === undefined) return;
  if (!isRecord(ports)) {
    errors.push('ports must be an object');
    return;
  }
  checkKeys(ports, new Set(['from', 'to', 'entries']), 'ports', errors);
  if (!COMMIT_PATTERN.test(String(ports.from))) errors.push('ports.from must be a full 40-character lowercase SHA');
  if (!COMMIT_PATTERN.test(String(ports.to))) errors.push('ports.to must be a full 40-character lowercase SHA');
  if (!Array.isArray(ports.entries)) {
    errors.push('ports.entries must be an array');
    return;
  }
  const seen = new Set();
  ports.entries.forEach((port, index) => {
    const label = `ports.entries[${index}]`;
    if (!isRecord(port)) {
      errors.push(`${label} must be an object`);
      return;
    }
    checkKeys(port, new Set(['commit', 'author', 'subject', 'pullRequest', 'classification', 'paths', 'decision', 'checks']), label, errors);
    if (!COMMIT_PATTERN.test(String(port.commit))) errors.push(`${label}.commit must be a full 40-character lowercase SHA`);
    if (seen.has(port.commit)) errors.push(`${label}.commit duplicates ${port.commit}`);
    else seen.add(port.commit);
    nonEmptyString(port.author, `${label}.author`, errors);
    nonEmptyString(port.subject, `${label}.subject`, errors);
    if (port.pullRequest !== undefined && (!Number.isInteger(port.pullRequest) || port.pullRequest <= 0)) {
      errors.push(`${label}.pullRequest must be a positive integer`);
    }
    if (!PORT_CLASSIFICATIONS.includes(port.classification)) {
      errors.push(`${label}.classification ${JSON.stringify(port.classification)} is not one of ${PORT_CLASSIFICATIONS.join(', ')}`);
    }
    if (!Array.isArray(port.paths)) {
      errors.push(`${label}.paths must be an array`);
    } else {
      port.paths.forEach((candidate, pathIndex) => {
        if (typeof candidate !== 'string' || !validRepoPath(candidate)) {
          errors.push(`${label}.paths[${pathIndex}] ${JSON.stringify(candidate)} is not a normalized repository-relative path`);
        }
      });
    }
    nonEmptyString(port.decision, `${label}.decision`, errors);
    stringArray(port.checks, `${label}.checks`, errors);
  });
}

/** A partial ledger is allowed only while the old baseline remains pinned; the target baseline requires exact coverage. */
export function validatePortHistory(repo, map) {
  if (!map.ports) return [];
  const errors = [];
  const { from, to, entries } = map.ports;
  for (const commit of [from, to]) {
    try {
      runGit(repo, ['cat-file', '-e', `${commit}^{commit}`]);
    } catch {
      errors.push(`port range commit ${commit} is missing; fetch it explicitly from ${map.upstream.repository}`);
    }
  }
  if (errors.length > 0) return errors;
  const expected = runGit(repo, ['rev-list', '--reverse', `${from}..${to}`]).trim().split('\n').filter(Boolean);
  const allowed = new Set(expected);
  for (const port of entries) {
    if (!allowed.has(port.commit)) errors.push(`port commit ${port.commit} is outside ${from}..${to}`);
  }
  if (map.upstream.commit !== from && map.upstream.commit !== to) {
    errors.push('upstream.commit must equal ports.from during migration or ports.to after completion');
  }
  if (map.upstream.commit === to) {
    const actual = new Set(entries.map(port => port.commit));
    for (const commit of expected) if (!actual.has(commit)) errors.push(`final port ledger is missing ${commit}`);
    for (const commit of actual) if (!allowed.has(commit)) errors.push(`final port ledger contains out-of-range ${commit}`);
  }
  return errors;
}

/** The one rule for what makes a retained-identifier reason acceptable; both guards call it. */
export function retainedReasonProblem(reason) {
  const value = String(reason);
  const code = value.split(':')[0];
  if (!RETAINED_REASON_CODES.includes(code) || !value.startsWith(`${code}: `)) {
    return `must start with one of ${RETAINED_REASON_CODES.join(', ')} followed by ": " and an explanation`;
  }
  return null;
}

/** Parses `git diff --name-status -z --no-renames` output. Pure. */
export function parseNameStatus(output) {
  const fields = output.split('\0');
  const added = new Set();
  const modified = new Set();
  const deleted = new Set();
  for (let index = 0; index + 1 < fields.length; index += 1) {
    const status = fields[index];
    if (status === '') continue;
    if (/^[RC]\d+$/.test(status)) {
      const first = fields[index + 1];
      const second = fields[index + 2];
      if (first !== undefined && first !== '') modified.add(first);
      if (second !== undefined && second !== '') modified.add(second);
      index += 2;
      continue;
    }
    const target = fields[index + 1];
    index += 1;
    if (target === undefined || target === '') continue;
    if (status === 'A') added.add(target);
    else if (status === 'D') deleted.add(target);
    else modified.add(target);
  }
  return { added, modified, deleted };
}

/** Every changed path must be owned by exactly one entry, and no entry may own an unchanged path. */
export function validateOwnership(map, changed) {
  const errors = [];
  const owners = new Map();
  const changes = Array.isArray(map.changes) ? map.changes : [];
  for (const change of changes) {
    if (!isRecord(change) || !Array.isArray(change.paths) || typeof change.id !== 'string') continue;
    for (const owned of change.paths) {
      if (typeof owned !== 'string') continue;
      const list = owners.get(owned) ?? [];
      list.push(change.id);
      owners.set(owned, list);
    }
  }
  for (const [owned, ids] of owners) {
    if (ids.length > 1) {
      errors.push(`"${owned}" is listed by entries ${ids.map(id => `"${id}"`).join(' and ')}; exactly one entry owns a path`);
    }
  }
  const describe = candidate => {
    if (changed.added.has(candidate)) return 'added';
    if (changed.modified.has(candidate)) return 'modified';
    if (changed.deleted.has(candidate)) return 'deleted';
    return null;
  };
  const all = new Set([...changed.added, ...changed.modified, ...changed.deleted]);
  for (const candidate of [...all].sort()) {
    if (!owners.has(candidate)) errors.push(`"${candidate}" (${describe(candidate)}) has no map entry`);
  }
  for (const owned of [...owners.keys()].sort()) {
    if (!describe(owned)) errors.push(`"${owned}" is not changed against upstream, so its entry is stale`);
  }
  return errors;
}

/** Every recorded upstream anchor must still exist in the pinned upstream tree. */
export function validateAnchors(map, upstreamPaths) {
  const errors = [];
  for (const change of Array.isArray(map.changes) ? map.changes : []) {
    if (!isRecord(change) || !Array.isArray(change.upstreamAnchors)) continue;
    for (const anchor of change.upstreamAnchors) {
      if (typeof anchor !== 'string') continue;
      if (!upstreamPaths.has(anchor)) {
        errors.push(`entry "${change.id}" anchors on "${anchor}", which does not exist in the pinned upstream tree`);
      }
    }
  }
  return errors;
}

/** Each retained identifier must name a real path, a live literal, and a precise reason code. */
export function retainedIdentifierErrors(entries, readText) {
  const errors = [];
  const seen = new Set();
  const scanned = new Map();
  entries.forEach((entry, index) => {
    const label = `retainedIdentifiers[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const key = `${entry.path}\0${entry.literal}`;
    if (seen.has(key)) errors.push(`${label} duplicates the exception for "${entry.literal}" in ${entry.path}`);
    seen.add(key);
    if (typeof entry.path !== 'string' || typeof entry.literal !== 'string') return;
    if (typeof entry.reason === 'string') {
      const problem = retainedReasonProblem(entry.reason);
      if (problem) errors.push(`${label}.reason ${problem}`);
    }
    if (!scanned.has(entry.path)) scanned.set(entry.path, readText(entry.path));
    const text = scanned.get(entry.path);
    if (text === null || text === undefined) {
      errors.push(`${label} names ${entry.path}, which is not a readable text file in this tree`);
      return;
    }
    if (!text.includes(entry.literal)) {
      errors.push(`${label}: "${entry.literal}" is no longer present in ${entry.path}, so the exception is stale`);
    }
  });
  return errors;
}

/** Grouping heuristics only serve the --emit-draft helper; they never validate anything. */
function draftCategory(relative) {
  if (WORKFLOW_PATTERN.test(relative)) return 'local-automation';
  if (/^(artwork\/|extension\/icons\/|pets\/|docs\/images\/)/.test(relative)) return 'assets';
  if (relative.startsWith('test/')) return 'verification';
  if (relative.startsWith('docs/')) return 'documentation';
  if (relative.startsWith('scripts/')) {
    if (/(release|package|dist|installer|tunnel|ripgrep)/.test(relative)) return 'linux-release';
    if (/(verify|smoke|check|analyze|benchmark)/.test(relative)) return 'verification';
    return 'local-automation';
  }
  if (/omarchy-theme|appearance/.test(relative)) return 'omarchy';
  if (/mcp\/(coding-)?instructions|handoff|session\/title|plugins\/catalog/.test(relative)) return 'prompts';
  return 'identity';
}

function draftGroup(relative) {
  const segments = relative.split('/');
  const prefix = segments.length > 2 && ['src', 'extension', 'docs', 'test', 'scripts'].includes(segments[0])
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const category = draftCategory(relative);
  return { key: `${category}\0${prefix}`, category, prefix };
}

function emitDraft(unmapped, statuses) {
  const groups = new Map();
  for (const relative of [...unmapped].sort()) {
    const { key, category, prefix } = draftGroup(relative);
    const group = groups.get(key) ?? {
      id: `${category}-${prefix.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      category,
      paths: [],
      upstreamAnchors: [],
      decision: '',
      portRule: '',
      checks: []
    };
    group.paths.push(relative);
    groups.set(key, group);
  }
  process.stdout.write(`${JSON.stringify({
    note: 'Draft groups for unmapped paths: fill decision, portRule and checks before pasting into docs/upstream-map.json.',
    statuses,
    unmapped: [...groups.values()]
  }, null, 2)}\n`);
}

async function readTextWithin(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

export async function collectChangedPaths(repo, commit) {
  const parsed = parseNameStatus(runGit(repo, ['diff', '--name-status', '-z', '--no-renames', commit, '--']));
  const untracked = runGit(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  for (const candidate of untracked) {
    if (candidate !== '') parsed.added.add(candidate);
  }
  return parsed;
}

async function main(argv) {
  const emitDraftRequested = argv.includes('--emit-draft');
  const repo = runGit(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const mapFile = path.join(repo, MAP_PATH);
  let raw;
  try {
    raw = await fs.readFile(mapFile, 'utf8');
  } catch {
    throw new GuardError(`${MAP_PATH} is missing; it is the machine-readable authority for this port`);
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch (error) {
    throw new GuardError(`${MAP_PATH} is not valid JSON: ${error.message}`);
  }
  const metadataErrors = validateMap(map);
  if (metadataErrors.length > 0) throw new GuardError(`malformed ${MAP_PATH}:\n  ${metadataErrors.join('\n  ')}`);

  const portHistoryErrors = validatePortHistory(repo, map);
  if (portHistoryErrors.length > 0) throw new GuardError(`upstream port ledger problems:\n  ${portHistoryErrors.join('\n  ')}`);

  const commit = map.upstream.commit;
  let commitPresent = true;
  try {
    runGit(repo, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    commitPresent = false;
  }
  if (!commitPresent) {
    throw new GuardError([
      `pinned upstream commit ${commit} is not present in this repository.`,
      'Fetch it explicitly (no tags) and re-run; the guard never downloads implicitly:',
      `  git fetch --no-tags ${map.upstream.repository} ${commit}`
    ].join('\n'));
  }

  const changed = await collectChangedPaths(repo, commit);
  const upstreamPaths = new Set(runGit(repo, ['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean));
  const anchorErrors = validateAnchors(map, upstreamPaths);
  if (anchorErrors.length > 0) throw new GuardError(`upstream anchor problems:\n  ${anchorErrors.join('\n  ')}`);
  const ownershipErrors = validateOwnership(map, changed);
  const retainedErrors = [];
  const retainedTexts = new Map();
  for (const entry of map.retainedIdentifiers) {
    if (isRecord(entry) && typeof entry.path === 'string' && !retainedTexts.has(entry.path)) {
      retainedTexts.set(entry.path, await readTextWithin(repo, entry.path));
    }
  }
  retainedErrors.push(...retainedIdentifierErrors(map.retainedIdentifiers, relative => retainedTexts.get(relative) ?? null));
  if (retainedErrors.length > 0) throw new GuardError(`retained identifier inventory problems:\n  ${retainedErrors.join('\n  ')}`);

  if (emitDraftRequested && ownershipErrors.length > 0) {
    const changedSet = new Set([...changed.added, ...changed.modified, ...changed.deleted]);
    const owned = new Set();
    for (const change of map.changes) for (const candidate of change.paths ?? []) owned.add(candidate);
    const statuses = {};
    for (const candidate of [...changedSet].sort()) {
      if (changed.added.has(candidate)) statuses[candidate] = 'added';
      else if (changed.deleted.has(candidate)) statuses[candidate] = 'deleted';
      else statuses[candidate] = 'modified';
    }
    emitDraft([...changedSet].filter(candidate => !owned.has(candidate)), statuses);
  }
  if (ownershipErrors.length > 0) throw new GuardError(`change map coverage problems:\n  ${ownershipErrors.join('\n  ')}`);

  const changedCount = changed.added.size + changed.modified.size + changed.deleted.size;
  process.stdout.write(
    `${MAP_PATH} maps ${changedCount} changed paths across ${map.changes.length} entries against upstream ${commit.slice(0, 12)}.\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    const prefix = error instanceof GuardError ? 'verify-upstream-map:' : 'verify-upstream-map: unexpected failure:';
    process.stderr.write(`${prefix} ${error.message}\n`);
    process.exitCode = 1;
  });
}
