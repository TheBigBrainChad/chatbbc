import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushDurable,
  initDurableStore,
  readDurable,
  readDurableStrict,
  resetDurableForTests,
  writeDurableNow,
  writeDurableSoon,
  writeDurableSnapshotSoon
} from '../src/main/durable.js';

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('strict read boundary for one-shot custody', () => {
  it('distinguishes an uninitialized root, an unhealthy missing state directory, and proven file absence', async () => {
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'uninitialized' });
    const directory = await tempStore();
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'storage' });
    await fs.symlink(directory, path.join(directory, 'state'));
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'storage' });
    await fs.rm(path.join(directory, 'state'));
    await fs.mkdir(path.join(directory, 'state'));
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'absent' });
    await writeDurableNow('rich-actions', { version: 1 });
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'valid', value: { version: 1 } });
    expect(await readDurableStrict('not-present')).toEqual({ kind: 'absent' });
  });

  it('refuses malformed, oversized, symlinked and unreadable custody files without rewriting them', async () => {
    const directory = await tempStore();
    const state = path.join(directory, 'state');
    await fs.mkdir(state);
    const file = path.join(state, 'rich-actions.json');
    await fs.writeFile(file, '{bad');
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'corrupt' });
    await fs.writeFile(file, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'corrupt' });
    await fs.writeFile(file, ' '.repeat(512 * 1024 + 1));
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'oversized' });
    await fs.rm(file);
    const outside = path.join(directory, 'outside.json');
    await fs.writeFile(outside, '{"version":1}');
    await fs.symlink(outside, file);
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'storage' });
    await fs.rm(file);
    // Replace the parent between its initial lstat and the file open. A no-follow
    // final-component check alone does not protect against a swapped directory.
    await fs.writeFile(file, '{"version":1}');
    await fs.writeFile(path.join(directory, 'rich-actions.json'), '{"version":99}');
    const realOpen = fs.open.bind(fs);
    const swapped = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(state, `${state}-old`);
      await fs.symlink(path.dirname(outside), state);
      return realOpen(...args);
    });
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'storage' });
    swapped.mockRestore();
    await fs.rm(state);
    await fs.rename(`${state}-old`, state);
    await fs.writeFile(file, '{"version":1}');
    const blocked = vi.spyOn(fs, 'open').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await readDurableStrict('rich-actions')).toEqual({ kind: 'unavailable', reason: 'storage' });
    blocked.mockRestore();
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":1}');
  });
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-durable-'));
  cleanup.push(dir);
  initDurableStore(dir);
  return dir;
}

describe('durable state commit boundary', () => {
  it('starts independent pending files during flush without duplicating an active immediate write', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    writeDurableSoon('independent', { ready: true });
    const flushing = flushDurable();
    try {
      await vi.waitFor(async () => expect(await readDurable('independent')).toEqual({ ready: true }));
    } finally { release(); }
    await Promise.all([first, flushing]);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('lets an independent file commit while preserving the blocked file FIFO', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    const second = writeDurableNow('first', { version: 2 });
    try {
      await writeDurableNow('independent', { ready: true });
      await expect(readDurable('independent')).resolves.toEqual({ ready: true });
      await expect(readDurable('first')).resolves.toBeNull();
    } finally { release(); }
    await Promise.all([first, second]);
    await expect(readDurable('first')).resolves.toEqual({ version: 2 });
  });

  it('coalesces lazy allocations and retains a captured snapshot after a failed write', async () => {
    await tempStore();
    let version = 1;
    const snapshot = vi.fn(() => ({ version }));
    for (let i = 0; i < 50; i++) writeDurableSnapshotSoon('projection', snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('busy'));
    await expect(flushDurable()).rejects.toThrow('busy');
    expect(snapshot).toHaveBeenCalledTimes(1);
    version = 2;
    rename.mockRestore();
    await flushDurable();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(readDurable('projection')).resolves.toEqual({ version: 1 });
  });

  it('never substitutes a later lazy projection for an immediate commit generation', async () => {
    await tempStore();
    const writes: unknown[] = [];
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      writes.push(JSON.parse(String(args[1])));
      return realWrite(...args);
    });
    const immediate = writeDurableNow('projection', { version: 1 });
    writeDurableSnapshotSoon('projection', () => ({ version: 2 }));
    await immediate;
    await flushDurable();
    expect(writes).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('rejects a failed immediate atomic rename and preserves the snapshot for retry', async () => {
    await tempStore();
    const busy = Object.assign(new Error('injected rename contention'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busy);

    await expect(writeDurableNow('probe', { generation: 1 })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rename).toHaveBeenCalledTimes(1);

    rename.mockRestore();
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 1 });
  });

  it('never lets an older in-flight generation erase a newer pending value', async () => {
    await tempStore();
    let releaseRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => {
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
        resolve();
        await new Promise<void>((release) => {
          releaseRename = release;
        });
        return vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((real) =>
          real.rename(args[0] as string, args[1] as string)
        );
      });
    });

    const first = writeDurableNow('probe', { generation: 1 });
    await renameEntered;
    writeDurableSoon('probe', { generation: 2 });
    releaseRename();
    await first;
    await flushDurable();

    await expect(readDurable('probe')).resolves.toEqual({ generation: 2 });
  });

  it('flushes pending state even when its debounce timer is no longer the authority', async () => {
    await tempStore();
    writeDurableSoon('probe', { generation: 3 });
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 3 });
  });

  it('attempts every pending state file even when one shutdown flush fails', async () => {
    await tempStore();
    const failed = Object.assign(new Error('injected swarm rename failure'), { code: 'EBUSY' });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}swarm.json`)) throw failed;
      return realRename(from, to);
    });

    // Keep the failing entry first: the regression is that flushDurable used to throw here
    // and never even try the unrelated continuation snapshot queued behind it.
    writeDurableSoon('swarm', { run: 1 });
    writeDurableSoon('continuations', { token: 'safe' });

    await expect(flushDurable()).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(readDurable('continuations')).resolves.toEqual({ token: 'safe' });
  });
});
