/** #1744 close-out review — the Electron backend's REAL watcher, not a copy of it. Since #1744 the self-write guard
 *  compares bytes on every event of every save, so the watcher's own call (`isEditorWrite(file, () =>
 *  fingerprintFile(file))` in `engine/electron/assetBackend.ts`) is what keeps an editor save from reloading the open
 *  scene. `editorOwnFileChangesMarked.test.ts` asks the guard exactly what that line asks, but through its own copy of
 *  the line, so a watcher that returned the wrong hash (a private hasher re-grown, a mangled callback) stayed green
 *  there. Not reached here either: hashing `target` for `file` — for a `.json` file they are the same path. Here a real
 *  `createAssetBackend` watches a scratch project, the real router saves through `/api/write-file`, and the assertion
 *  is on `onSceneChanged`, the hot-reload trigger itself.
 *
 *  Waits on events, never on the clock (#1742): readiness is a probe the watcher reported, and "the save raised
 *  nothing" is read only after an outside write made AFTER the save has been dispatched.
 *
 *  Mutations, each red here: the watcher's callback `() => 'mutated'` → the echo case; the guard's TTL fast path first
 *  (`if (e.exp > now()) return true`) → the in-window case. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssetBackend, type ElectronAssetBackend } from '../../electron/assetBackend';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let dir = '';
let backend: ElectronAssetBackend | null = null;
afterEach(async () => { await backend?.stop(); backend = null; fs.rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scene = (tag: string) => JSON.stringify({ id: randomUUID(), version: 13, entities: [{ guid: tag }] }, null, 2);
const scenesDir = () => path.join(dir, 'runtime/assets/scenes');
const put = (name: string, content: string) => fs.writeFileSync(path.join(scenesDir(), name), content);

function open() {
  dir = makeScratchDir('modoki-electron-self-write-');
  fs.mkdirSync(scenesDir(), { recursive: true });
  put('a.scene.json', scene('a0'));
  put('b.scene.json', scene('b0'));
  const changed: string[] = [];
  backend = createAssetBackend({ projectRoot: dir, onSceneChanged: (urlPath) => changed.push(urlPath) });
  backend.start();
  const b = backend;
  const ctx = {
    projectRoot: dir,
    resolveAssetPath: b.resolveAssetPath,
    absToAssetUrl: b.absToAssetUrl,
    rebuildManifest: b.rebuildManifest,
    getManifest: b.getManifest,
    requestBrowser: async () => ({ ok: true, notes: [] }),
    getSchema: () => undefined,
    firstRootDir: b.firstRootDir,
    invalidateProjectConfig: () => {},
    markEditorWrite: b.markEditorWrite,
  } as unknown as BackendContext;
  const save = (name: string, content: string) => handleBackendRequest(ctx, {
    method: 'POST', urlPath: '/api/write-file', query: new URLSearchParams(), body: { path: `/assets/scenes/${name}`, content },
  }) as Promise<{ status?: number; body: Record<string, unknown> }>;
  return { changed, save };
}

/** Poll until `onSceneChanged` has reported `urlPath`, or give up after `ms`. */
async function until(changed: string[], urlPath: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (changed.includes(urlPath)) return true;
    await sleep(10);
  }
  return false;
}

/** Ready is OBSERVED: write a fresh probe scene until one is dispatched, so the initial scan is over.
 *
 *  ANY probe counts, not just the one written last. A report trails its write by the watcher's coalescing plus the
 *  backend's 150 ms debounce — measured 220–230 ms on Windows — so looking only for the latest probe, 200 ms at a time,
 *  gave up on each one just before it arrived and never saw a probe at all (#1875: red on every Windows run). A probe
 *  reported after the clear below is harmless: every assertion is about `a` and `b`. */
async function ready(changed: string[]): Promise<void> {
  const isProbe = (urlPath: string) => /^\/assets\/scenes\/probe-\d+\.scene\.json$/.test(urlPath);
  for (let i = 0; i < 100; i++) {
    put(`probe-${i}.scene.json`, scene(`p${i}`));
    const end = Date.now() + 200;
    while (Date.now() < end) {
      if (changed.some(isProbe)) { changed.length = 0; return; }
      await sleep(10);
    }
  }
  throw new Error('the watcher never reported a probe');
}

describe('#1744: the Electron backend`s watcher, driven by a real save', () => {
  it('the editor`s own save raises no hot reload', async () => {
    const { changed, save } = open();
    await ready(changed);
    const r = await save('a.scene.json', scene('mine'));
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    put('b.scene.json', scene('b1')); // an outside write AFTER the save: once it is dispatched, the save's events were handled
    expect(await until(changed, '/assets/scenes/b.scene.json'), 'the sentinel was never dispatched').toBe(true);
    expect(changed).not.toContain('/assets/scenes/a.scene.json');
  }, 30_000);

  it('an outside write right after the save is dispatched — inside the 1.5 s window', async () => {
    const { changed, save } = open();
    await ready(changed);
    await save('a.scene.json', scene('mine'));
    put('a.scene.json', scene('checked-out')); // `git checkout` a few ms after `save_all`
    expect(await until(changed, '/assets/scenes/a.scene.json')).toBe(true);
  }, 30_000);
});
