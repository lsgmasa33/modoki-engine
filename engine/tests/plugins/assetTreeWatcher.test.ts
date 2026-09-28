/** #1708 — the thin win32 wiring around `assetTreeIndex`: one recursive watch per root, a coalescing timer, and a
 *  restart after the watch fails. Driven with an injected `watch` and fake timers, so it runs on every platform
 *  (`platform: 'win32'` picks the branch; the filesystem is the real one, under a scratch dir).
 *
 *  Mutations, each checked red on its own case here:
 *  - the error handler does not schedule a restart → "a failed watch is restarted".
 *  - the restart does not queue a rescan → "…and the rescan finds what changed while nothing watched".
 *  - `schedule` flushes on every event instead of coalescing → "a burst is reconciled once".
 *  - drop the `COALESCE_MAX_MS` cap (wait COALESCE_MS after every event) → "a steady stream is still reported".
 *  - the listener ignores an absolute filename → "the root itself deleted".
 *  - drop the root-identity interval → "the root renamed away".
 *  - `lose` rescans even when no live watch was lost → "a watch that THROWS as it opens".
 *  - `start(true)` resets `warned` again → "…warns ONCE". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAssetTreeWatcher, nodeTreeFs, COALESCE_MS, COALESCE_MAX_MS, RESTART_MS, ROOT_CHECK_MS, type RecursiveWatchFn } from '../../plugins/assetTreeWatcher';
import type { TreeEventKind, TreeFs } from '../../plugins/assetTreeIndex';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let root: string;
beforeEach(() => { vi.useFakeTimers(); root = makeScratchDir('modoki-tree-watch-'); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

function harness(opts: { throwOnFirstWatch?: boolean } = {}) {
  let watchCalls = 0;
  const handles: Array<{ root: string; emit: (ev: string, f: string | null) => void; fail: (e: Error) => void; closed: boolean }> = [];
  const watch: RecursiveWatchFn = (r, listener) => {
    if (watchCalls++ === 0 && opts.throwOnFirstWatch) throw new Error('EPERM: watch');
    const h = { root: r, emit: listener, fail: (_e: Error) => {}, closed: false };
    handles.push(h);
    return { on: (_ev: 'error', cb: (e: Error) => void) => { h.fail = cb; }, close: () => { h.closed = true; } };
  };
  let readdirs = 0;
  const treeFs: TreeFs = { readdir: (d) => { readdirs++; return nodeTreeFs.readdir(d); }, stat: nodeTreeFs.stat };
  const events: Array<[TreeEventKind, string]> = [];
  const w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]), platform: 'win32', watch, treeFs });
  return { handles, events, w, readdirs: () => readdirs };
}
const put = (rel: string, bytes = '{}') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), bytes); };

describe('assetTreeWatcher, win32 wiring', () => {
  it('watches each root once, recursively, and seeds without emitting', () => {
    put('kit/a.json');
    const h = harness();
    expect(h.handles.map((x) => x.root)).toEqual([root]);
    vi.advanceTimersByTime(1000);
    expect(h.events).toEqual([]);
  });

  it('a burst is reconciled once, after the events stop', () => {
    const h = harness();
    put('a.json'); put('b.json');
    h.handles[0].emit('rename', 'a.json');
    vi.advanceTimersByTime(COALESCE_MS - 10);
    h.handles[0].emit('rename', 'b.json');
    h.handles[0].emit('change', 'b.json');
    expect(h.events, 'nothing before the burst settles').toEqual([]);
    const before = h.readdirs();
    vi.advanceTimersByTime(COALESCE_MS);
    expect(h.events.sort()).toEqual([['add', path.join(root, 'a.json')], ['add', path.join(root, 'b.json')]]);
    expect(h.readdirs() - before, 'one flush read the shared parent listing once').toBe(1);
  });

  it('a null filename (the buffer overflowed) rescans', () => {
    put('a.json');
    const h = harness();
    put('a.json', '{"changed":1}');
    put('new/b.json');
    h.handles[0].emit('change', null);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(h.events.sort()).toEqual([['add', path.join(root, 'new', 'b.json')], ['change', path.join(root, 'a.json')]]);
  });

  it('a failed watch is restarted, and the rescan finds what changed while nothing watched', () => {
    put('a.json');
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.handles[0].fail(new Error('EPERM'));
      expect(h.handles[0].closed).toBe(true);
      put('a.json', '{"during":"outage"}');
      vi.advanceTimersByTime(RESTART_MS);
      expect(h.handles).toHaveLength(2);
      vi.advanceTimersByTime(COALESCE_MS);
      expect(h.events).toEqual([['change', path.join(root, 'a.json')]]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('a steady stream is still reported within the cap — a burst that never pauses cannot starve the flush', () => {
    const h = harness();
    put('a.json');
    for (let t = 0; t < COALESCE_MAX_MS + 20; t += COALESCE_MS - 10) {
      h.handles[0].emit('change', 'noise.json');
      vi.advanceTimersByTime(COALESCE_MS - 10);
      if (t === 0) h.handles[0].emit('rename', 'a.json');
    }
    expect(h.events).toEqual([['add', path.join(root, 'a.json')]]);
  });

  it('the root itself deleted (Windows then reports its ABSOLUTE path, in a flood): unlink everything, re-watch it once it is back', () => {
    put('a.json'); put('kit/b.json');
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fs.rmSync(root, { recursive: true });
      for (let i = 0; i < 1000; i++) h.handles[0].emit('rename', `\\\\?\\${root}`);
      expect(h.handles[0].closed, 'the spinning handle is closed at once').toBe(true);
      expect(h.events.sort()).toEqual([['unlink', path.join(root, 'a.json')], ['unlink', path.join(root, 'kit', 'b.json')]]);
      h.events.length = 0;
      vi.advanceTimersByTime(RESTART_MS);
      expect(h.handles, 'no re-watch while the root is missing').toHaveLength(1);
      fs.mkdirSync(root); put('c.json');
      vi.advanceTimersByTime(RESTART_MS + COALESCE_MS);
      expect(h.handles).toHaveLength(2);
      expect(h.events).toEqual([['add', path.join(root, 'c.json')]]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('the root renamed away (Windows reports NOTHING): the identity check notices, unlinks, and watches the new root', () => {
    put('a.json');
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = `${root}-old`;
    try {
      fs.renameSync(root, moved);
      fs.mkdirSync(root); put('fresh.json');
      vi.advanceTimersByTime(ROOT_CHECK_MS);
      expect(h.handles[0].closed).toBe(true);
      expect(h.events.sort()).toEqual([['add', path.join(root, 'fresh.json')], ['unlink', path.join(root, 'a.json')]]);
      vi.advanceTimersByTime(RESTART_MS + COALESCE_MS);
      expect(h.handles).toHaveLength(2);
    } finally { warn.mockRestore(); fs.rmSync(moved, { recursive: true, force: true }); }
  });

  it('a watch that THROWS as it opens, on a readable root, reports nothing at startup — no add for every file (review)', () => {
    put('a.prefab.json'); put('kit/b.scene.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = harness({ throwOnFirstWatch: true });
      expect(h.events, 'nothing before the seed').toEqual([]);
      vi.advanceTimersByTime(RESTART_MS + COALESCE_MS);
      expect(h.handles).toHaveLength(1);
      expect(h.events, 'the restart rescans a seeded index: nothing new').toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it('a watch that opens and then fails every time warns ONCE, not once per retry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = harness();
      for (let i = 0; i < 4; i++) { h.handles.at(-1)!.fail(new Error('async failure')); vi.advanceTimersByTime(RESTART_MS); }
      expect(h.handles).toHaveLength(5);
      expect(warn).toHaveBeenCalledTimes(1);
      h.handles.at(-1)!.emit('change', 'x.json'); // …and once a watch delivers again, the next outage is news
      h.handles.at(-1)!.fail(new Error('again'));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it('close stops the watch and any pending flush', async () => {
    const h = harness();
    put('a.json');
    h.handles[0].emit('rename', 'a.json');
    await h.w.close();
    vi.advanceTimersByTime(COALESCE_MS * 2);
    expect(h.handles[0].closed).toBe(true);
    expect(h.events).toEqual([]);
  });
});
