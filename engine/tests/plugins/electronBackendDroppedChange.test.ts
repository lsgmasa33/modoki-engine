/** #1911 — the Electron backend, the one whose watcher drives the editor's reloads, reports an outside write whose
 *  watcher event was dropped. The real `createAssetBackend` and the real `/api/write-file` save; only the watcher is
 *  played, because the drop is chokidar's timing (a `change` inside 50 ms of the previous one is thrown away), which a
 *  real watcher reproduces 12 times in 15 at 0 ms and never on demand. Here the save's event is delivered and the
 *  checkout's is not — exactly the failing run.
 *
 *  What this pins beyond sceneChangeBatchMissed.test.ts is the host's WIRING: the batch must be handed the guard the
 *  save route marks, and the route's mark-after-write order. Mutations, each checked red: the flush's `missedChanges`
 *  loop removed → the first case; `/api/write-file` marking before its write again → the failed-write case; the host
 *  building the batch on a second `createEditorWriteGuard()` → the accept side (the save itself is then reported, as
 *  #1744's electronBackendSelfWrite.test.ts also sees). */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const watchers: { onEvent: (kind: string, file: string) => void }[] = [];
vi.mock('../../plugins/assetTreeWatcher', () => ({
  createAssetTreeWatcher: (opts: { onEvent: (kind: string, file: string) => void }) => {
    watchers.push(opts);
    return { close: async () => {} };
  },
}));

const { createAssetBackend } = await import('../../electron/assetBackend');
const { handleBackendRequest } = await import('../../plugins/backend/editorBackendRouter');
type BackendContext = import('../../plugins/backend/editorBackendRouter').BackendContext;

let dir = '';
let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; watchers.length = 0; fs.rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scene = (tag: string) => JSON.stringify({ id: randomUUID(), version: 13, entities: [{ guid: tag }] }, null, 2);

function open() {
  dir = makeScratchDir('modoki-electron-dropped-');
  const scenes = path.join(dir, 'runtime/assets/scenes');
  fs.mkdirSync(scenes, { recursive: true });
  const abs = path.join(scenes, 'main.scene.json');
  fs.writeFileSync(abs, scene('sphere'));
  const changed: string[] = [];
  const b = createAssetBackend({ projectRoot: dir, onSceneChanged: (urlPath) => changed.push(urlPath) });
  b.start();
  stop = () => b.stop();
  const ctx = {
    projectRoot: dir, resolveAssetPath: b.resolveAssetPath, absToAssetUrl: b.absToAssetUrl, rebuildManifest: b.rebuildManifest,
    getManifest: b.getManifest, requestBrowser: async () => ({ ok: true, notes: [] }), getSchema: () => undefined,
    firstRootDir: b.firstRootDir, invalidateProjectConfig: () => {}, markEditorWrite: b.markEditorWrite,
  } as unknown as BackendContext;
  const save = (content: string) => handleBackendRequest(ctx, {
    method: 'POST', urlPath: '/api/write-file', query: new URLSearchParams(), body: { path: '/assets/scenes/main.scene.json', content },
  }) as Promise<{ body: Record<string, unknown> }>;
  return { abs, changed, save, event: (file: string) => watchers[0].onEvent('change', file) };
}

describe('#1911: the Electron backend reports a checkout whose event the watcher dropped', () => {
  it('save_all, then `git checkout` with no event of its own → onSceneChanged', async () => {
    const { abs, changed, save, event } = open();
    expect(watchers).toHaveLength(1);
    const r = await save(scene('deleted-sphere'));
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    event(abs); // the save's own event: vouched for
    fs.writeFileSync(abs, scene('sphere')); // the checkout — chokidar threw its event away
    const end = Date.now() + 3000;
    while (Date.now() < end && !changed.length) await sleep(10);
    expect(changed).toEqual(['/assets/scenes/main.scene.json']);
  }, 10_000);

  // Close-out review: the route marked BEFORE writing, so a save whose write threw left a mark the disk never got, and the
  // flush's recheck reported the editor's own earlier save as an outside change. A `.tmp` directory makes it throw.
  it('a save whose write throws leaves no mark: the earlier save is not reported', async () => {
    const { abs, changed, save, event } = open();
    await save(scene('first'));
    event(abs);
    fs.mkdirSync(`${abs}.tmp`); // the next write's tmp file cannot be created
    const r = await save(scene('second'));
    expect(r.body.ok, JSON.stringify(r.body)).not.toBe(true);
    await sleep(400);
    expect(changed).toEqual([]);
  }, 10_000);

  it('the save alone reports nothing (the accept side)', async () => {
    const { abs, changed, save, event } = open();
    await save(scene('deleted-sphere'));
    event(abs);
    await sleep(400); // two debounce windows past the save's event: the flush has run
    expect(changed).toEqual([]);
  }, 10_000);
});
