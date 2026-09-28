/** LIVE win32 test for #1708: a folder with subfolders can be recycled while the editor's watchers run.
 *
 *  Windows refuses to move a directory (the Recycle Bin is a move) while a DESCENDANT directory has an open handle.
 *  chokidar and Vite's watcher hold one per directory, and watching a single FILE holds its parent. So this file runs
 *  the real thing each way: the real `createAssetTreeWatcher`, a real Vite server with the real ignore predicate, and
 *  the real `moveToTrash` (PowerShell → Recycle Bin), against a nested tree with a non-ASCII folder name. Each has a
 *  CONTROL built the old way that must FAIL to recycle — that is what makes a green here mean the mechanism, not luck.
 *
 *  Skipped off win32: macOS and Linux let a directory with open handles under it be moved, so there is nothing to
 *  observe there; the logic itself is covered on every platform by `assetTreeIndex.test.ts`. The free public CI's
 *  Windows leg (#96) runs `engine/tests/**`, so it runs this file on every `main` push.
 *
 *  It really recycles its fixtures — a few tiny temp folders per run. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { moveToTrash } from '../../plugins/asset-fs-ops';
import { createAssetTreeWatcher } from '../../plugins/assetTreeWatcher';
import { projectAssetRootsWatchIgnore } from '../../plugins/vite-asset-scanner';
import type { TreeEventKind } from '../../plugins/assetTreeIndex';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const onWin = process.platform === 'win32';
const scratch: string[] = [];
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const r of scratch.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}

/** `<root>/kit/{a.prefab.json, sub é/b.prefab.json, sub é/deeper/c.scene.json}` */
function nestedTree(): { root: string; kit: string; files: string[] } {
  const root = makeScratchDir('modoki-1708-live-');
  scratch.push(root);
  const kit = path.join(root, 'kit');
  const files = ['a.prefab.json', path.join('sub é', 'b.prefab.json'), path.join('sub é', 'deeper', 'c.scene.json')].map((rel) => {
    const p = path.join(kit, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{}');
    return p;
  });
  return { root, kit, files };
}

describe.skipIf(!onWin)('#1708: recycling a folder with subfolders while the watchers run (real Windows)', () => {
  it('CONTROL: under a per-directory chokidar watch (the old Electron watcher), the recycle is refused', async () => {
    const { root, kit } = nestedTree();
    const w = chokidar.watch(root, { ignoreInitial: true });
    closers.push(() => w.close());
    await new Promise<void>((r) => w.once('ready', () => r()));
    expect(moveToTrash(kit).failed).toEqual([kit]);
    expect(fs.existsSync(kit)).toBe(true);
  });

  it('under the asset-tree watcher: ONE recycle, and an unlink for every file under the folder', async () => {
    const { root, kit, files } = nestedTree();
    const events: Array<[TreeEventKind, string]> = [];
    const w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]) });
    closers.push(() => w.close());
    await sleep(100);
    expect(moveToTrash(kit).failed).toEqual([]);
    expect(fs.existsSync(kit)).toBe(false);
    const unlinked = () => new Set(events.filter(([k]) => k === 'unlink').map(([, p]) => p));
    expect(await until(() => files.every((f) => unlinked().has(f))), JSON.stringify(events)).toBe(true);
  });

  it('under the asset-tree watcher: a folder moved back in (a restore) adds every file', async () => {
    const { root, kit, files } = nestedTree();
    const outside = makeScratchDir('modoki-1708-out-');
    scratch.push(outside);
    const parked = path.join(outside, 'kit');
    fs.renameSync(kit, parked);
    const events: Array<[TreeEventKind, string]> = [];
    const w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]) });
    closers.push(() => w.close());
    await sleep(100);
    fs.renameSync(parked, kit);
    const added = () => new Set(events.filter(([k]) => k === 'add').map(([, p]) => p));
    expect(await until(() => files.every((f) => added().has(f))), JSON.stringify(events)).toBe(true);
  });

  it('the watched ROOT deleted (a real handle then spins on the root`s own path): everything unlinks, and it is watched again once back', async () => {
    const { root, files } = nestedTree();
    const events: Array<[TreeEventKind, string]> = [];
    const w = createAssetTreeWatcher({ roots: [root], onEvent: (k, p) => events.push([k, p]) });
    closers.push(() => w.close());
    const warn = console.warn;
    console.warn = () => {};
    try {
      await sleep(100);
      fs.rmSync(root, { recursive: true });
      const unlinked = () => new Set(events.filter(([k]) => k === 'unlink').map(([, p]) => p));
      expect(await until(() => files.every((f) => unlinked().has(f))), JSON.stringify(events)).toBe(true);
      fs.mkdirSync(root);
      const back = path.join(root, 'back.json');
      fs.writeFileSync(back, '{}');
      expect(await until(() => events.some(([k, p]) => k === 'add' && p === back), 6000), JSON.stringify(events.slice(-5))).toBe(true);
    } finally { console.warn = warn; }
  });

  describe('a real Vite server watching a `?url`-imported scene (what ensureWatchedFile does)', () => {
    async function viteWatching(sceneFile: string, assetRoot: string, withIgnore: boolean) {
      const { createServer } = await import('vite');
      const viteRoot = makeScratchDir('modoki-1708-viteroot-'); // the asset root is OUTSIDE it, as a game's is
      scratch.push(viteRoot);
      const server = await createServer({
        configFile: false, root: viteRoot, logLevel: 'silent', appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          middlewareMode: true, hmr: false,
          ...(withIgnore ? { watch: { ignored: [projectAssetRootsWatchIgnore(() => [{ urlPrefix: '/assets', absDir: assetRoot }])] } } : {}),
        },
      });
      closers.push(() => server.close());
      server.watcher.add(sceneFile);
      return server;
    }

    it('CONTROL: without the ignore, the watched scene file blocks recycling its ancestor folder', async () => {
      const { root, kit, files } = nestedTree();
      const server = await viteWatching(files[2], root, false);
      const watchedDir = path.dirname(files[2]);
      expect(await until(() => Object.keys(server.watcher.getWatched()).some((d) => path.resolve(d) === watchedDir)), 'premise: Vite watches it').toBe(true);
      expect(moveToTrash(kit).failed).toEqual([kit]);
    });

    it('with projectAssetRootsWatchIgnore, the add is a no-op and the folder recycles', async () => {
      const { root, kit, files } = nestedTree();
      const server = await viteWatching(files[2], root, true);
      await sleep(500);
      expect(Object.keys(server.watcher.getWatched()).some((d) => path.resolve(d).startsWith(root))).toBe(false);
      expect(moveToTrash(kit).failed).toEqual([]);
      expect(fs.existsSync(kit)).toBe(false);
    });
  });
});
