/**
 * One-time adaptation of the vendored obra/superpowers pack to ChatBBC's tool surface.
 *
 * Two things must NOT be touched. The `.superpowers/` directory name is the SDD workspace path
 * (`.superpowers/sdd/<plan>/`), not a namespace reference — rewriting it would break the layout
 * subagent-driven-development describes. And `obra/superpowers` is a repository URL.
 *
 * This runs once; the result is committed. Re-run it after re-vendoring a newer upstream tag,
 * then review the diff by hand, because blanket substitution produces awkward prose.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const pack = path.resolve(process.argv[2] ?? 'skill-pack');
const SKILLS = ['brainstorming', 'dispatching-parallel-agents', 'executing-plans',
  'finishing-a-development-branch', 'receiving-code-review', 'requesting-code-review',
  'subagent-driven-development', 'systematic-debugging', 'test-driven-development',
  'using-git-worktrees', 'using-superpowers', 'verification-before-completion',
  'writing-plans', 'writing-skills'];

// Order matters: the namespace rule must run before the bare-word rule, or `superpowers:x`
// becomes `the skill library:x`.
const RULES = [
  [/superpowers:([a-z0-9-]+)/g, '/$1'],
  [/\bSuperpowers\b/g, 'the skill library'],
  [/\bTodoWrite\b/g, 'update_plan'],
  [/\bClaude Code\b/g, 'ChatBBC'],
  [/\bClaude\b/g, 'ChatGPT'],
  [/\bAnthropic\b/g, 'the model provider'],
  [/`Bash`/g, '`exec_command`'],
  [/`Read`/g, '`read`'],
  [/`Write`/g, '`apply_patch`'],
  [/`Edit`/g, '`apply_patch`'],
  [/`Grep`|`Glob`/g, '`find`'],
  [/\bthe Task tool\b|\bTask tool\b/g, 'the `agents` tool']
];

// Preserve these spans by masking them before substitution and restoring afterwards.
const PROTECTED = [/obra\/superpowers/g, /\.superpowers\//g, /docs\/superpowers\//g];

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

let changed = 0;
for (const id of SKILLS) {
  for await (const file of walk(path.join(pack, id))) {
    const original = await fs.readFile(file, 'utf8');
    const mask = [];
    let text = original.replace(new RegExp(PROTECTED.map(r => r.source).join('|'), 'g'),
      match => `\u0000${mask.push(match) - 1}\u0000`);
    for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
    text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => mask[Number(index)]);
    if (text !== original) { await fs.writeFile(file, text, 'utf8'); changed++; }
  }
}
console.log(`adapted ${changed} files in ${pack}`);
