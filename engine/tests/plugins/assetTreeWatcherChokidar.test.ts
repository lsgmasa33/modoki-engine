/** #1708 review — the macOS/Linux branch of `createAssetTreeWatcher` (chokidar, as before), which is what the hub runs
 *  and which nothing else starts. A REAL chokidar over a scratch root; `platform: 'darwin'` picks the branch, so it
 *  also runs on Windows, where chokidar hands the `ignored` predicate `/`-separated paths — the spelling the first
 *  version of the predicate did not handle (observed inert there).
 *
 *  Mutation, checked red here: `ignored: () => false`.
 *
 *  Waits on events, never on the clock (#1742, docs/windows.md § Tests). It slept 400 ms for chokidar's scan, and with
 *  `ignoreInitial` a file written before the scan ends is never reported, so a loaded box could lose `a.json` outright. It
 *  also asserted the exact event list, and FSEvents under load reports a create-then-write as `add` + `change`
 *  (`[['add','kit/a.json'],['change','kit/a.json']]`, work-ai's gate). Both consumers read only the path
 *  (`(_kind, file) => onChange(file)` in vite-asset-scanner and electron/assetBackend), so that is not a defect: the
 *  assertion is on WHICH files were reported, plus a.json arriving as an `add`. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAssetTreeWatcher, type AssetTreeWatcher } from '../../plugins/assetTreeWatcher';
import type { TreeEventKind } from '../../plugins/assetTreeIndex';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let root = '';
let w: AssetTreeWatcher | null = null;
afterEach(async () => { await w?.close(); w = null; fs.rmSync(root, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), '{}'); };
const PROBE = /probe-\d+\.json$/;

/** Poll until the watcher reports `rel`, or fail after `ms`. */
async function until(events: Array<[TreeEventKind, string]>, rel: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (events.some(([, p]) => path.relative(root, p) === rel)) return true;
    await sleep(10);
  }
  return false;
}

/** Ready is OBSERVED, not guessed: write a fresh probe file until ANY probe is reported, so chokidar's initial scan is over.
 *  Any one, not the one just written: a working watcher slower than a pass would otherwise miss every probe's window
 *  (close-out review: every event delayed 300 ms turned this red 2/2). */
async function untilWatching(events: Array<[TreeEventKind, string]>): Promise<void> {
  const end = Date.now() + 10_000;
  for (let i = 0; Date.now() < end; i++) {
    put(path.join('kit', `probe-${i}.json`));
    const pass = Date.now() + 250;
    while (Date.now() < pass) {
      if (events.some(([, p]) => PROBE.test(p))) return;
      await sleep(10);
    }
  }
  throw new Error('the watcher never reported a probe file');
}

describe('assetTreeWatcher, chokidar branch (macOS/Linux)', () => {
  it('reports files under the root, and nothing under a dot segment or node_modules', async () => {
    root = makeScratchDir('modoki-tree-chokidar-');
    for (const d of ['.cache', 'kit', 'node_modules']) fs.mkdirSync(path.join(root, d));
    const events: Array<[TreeEventKind, string]> = [];
    w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]), platform: 'darwin' });
    await untilWatching(events);
    put('.cache/x.json'); put('kit/.hidden.json'); put('node_modules/y.json'); put('kit/a.json');
    expect(await until(events, path.join('kit', 'a.json'))).toBe(true);
    // The negative window is bounded by an EVENT: a file written after the ignored ones. An ignored file's event, had it
    // been reported, is queued ahead of this one.
    put('kit/z.json');
    expect(await until(events, path.join('kit', 'z.json'))).toBe(true);
    const seen = events.filter(([, p]) => !PROBE.test(p)).map(([k, p]) => [k, path.relative(root, p)] as const);
    expect([...new Set(seen.map(([, p]) => p))].sort()).toEqual([path.join('kit', 'a.json'), path.join('kit', 'z.json')]);
    expect(seen.find(([, p]) => p === path.join('kit', 'a.json'))?.[0]).toBe('add');
  });
});
