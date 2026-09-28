/** #1708 review — the macOS/Linux branch of `createAssetTreeWatcher` (chokidar, as before), which is what the hub runs
 *  and which nothing else starts. A REAL chokidar over a scratch root; `platform: 'darwin'` picks the branch, so it
 *  also runs on Windows, where chokidar hands the `ignored` predicate `/`-separated paths — the spelling the first
 *  version of the predicate did not handle (observed inert there).
 *
 *  Mutation, checked red here: `ignored: () => false`. */

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

describe('assetTreeWatcher, chokidar branch (macOS/Linux)', () => {
  it('reports files under the root, and nothing under a dot segment or node_modules', async () => {
    root = makeScratchDir('modoki-tree-chokidar-');
    for (const d of ['.cache', 'kit', 'node_modules']) fs.mkdirSync(path.join(root, d));
    const events: Array<[TreeEventKind, string]> = [];
    w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]), platform: 'darwin' });
    await sleep(400); // chokidar's initial scan
    put('.cache/x.json'); put('kit/.hidden.json'); put('node_modules/y.json'); put('kit/a.json');
    const end = Date.now() + 5000;
    while (Date.now() < end && !events.some(([, p]) => p.endsWith('a.json'))) await sleep(25);
    await sleep(300); // time for any ignored file's event to (wrongly) arrive too
    expect(events.map(([k, p]) => [k, path.relative(root, p)])).toEqual([['add', path.join('kit', 'a.json')]]);
  });
});
