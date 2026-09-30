/** #1911 — an outside write whose watcher event was DROPPED still reaches the editor.
 *
 *  chokidar throws away a `change` inside 50 ms of the path's previous `change`, with no trailing emit. So a
 *  `git checkout` a few ms after `save_all` delivered only the save's own event, which the self-write guard rightly
 *  vouched for, and nothing at all for the checkout: no hold, no reload, `modoki_refresh` applied nothing, and the undo
 *  stack stayed live over bytes the editor never saw. Measured through the real watcher and guard: an unlink + create
 *  0 ms after a save was lost 12 times in 15.
 *
 *  `createSceneChangeBatch` is what both watchers run (the Vite plugin's and the Electron backend's), so the drop is
 *  played here as what it is — the save's event arrives, the checkout's never does — with a real guard over real files.
 *  The Electron host's wiring of the same guard: electronBackendDroppedChange.test.ts.
 *
 *  Mutations, each checked red: the flush's `missedChanges` loop removed → the three dropped-change cases here (and
 *  the Electron file's); `collect(file, target)` in that loop given `file` for `target` → the shader-body case only.
 *  The guard's own rules (`vouched.clear()`, re-asking only a fingerprinted mark) are pinned in viteAssetScanner.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSceneChangeBatch, type AssetRoot, type LiveReloadKind } from '../../plugins/vite-asset-scanner';
import { createEditorWriteGuard, fingerprintBytes } from '../../plugins/editorWriteGuard';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let dir = '';
let assets = '';
beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.realpathSync(makeScratchDir('modoki-change-batch-'));
  assets = path.join(dir, 'runtime/assets');
  fs.mkdirSync(path.join(assets, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(assets, 'shaders'), { recursive: true });
});
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

function batch() {
  const guard = createEditorWriteGuard();
  const roots: AssetRoot[] = [{ urlPrefix: '/assets', absDir: assets }];
  const sent: { urlPath: string; kind: LiveReloadKind; viaSibling: boolean }[] = [];
  let rebuilds = 0;
  const b = createSceneChangeBatch({
    assetRoots: () => roots, guard, rebuildManifest: () => { rebuilds++; },
    broadcast: (urlPath, kind, viaSibling) => { sent.push({ urlPath, kind, viaSibling }); },
  });
  /** What `/api/write-file` does: mark the exact bytes, then write them. Then the one event the watcher delivers. */
  const save = (abs: string, content: string) => {
    guard.mark(abs, fingerprintBytes(content));
    fs.writeFileSync(abs, content);
    b.onChange(abs);
  };
  return { b, save, sent, guard, rebuilds: () => rebuilds };
}

describe('#1911: a change the watcher dropped is reported at the flush', () => {
  it('a checkout right after a save — only the save`s event arrived — is broadcast', () => {
    const { save, sent, rebuilds } = batch();
    const scene = path.join(assets, 'scenes/main.scene.json');
    fs.writeFileSync(scene, '{"entities":["Sphere"]}');
    save(scene, '{"entities":[]}');
    fs.writeFileSync(scene, '{"entities":["Sphere"]}'); // `git checkout` — its event is the one chokidar threw away
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ urlPath: '/assets/scenes/main.scene.json', kind: 'scene', viaSibling: false }]);
    expect(rebuilds()).toBe(1);
  });

  it('once: a later flush does not broadcast it again', () => {
    const { b, save, sent } = batch();
    const scene = path.join(assets, 'scenes/main.scene.json');
    save(scene, '{"a":1}');
    fs.writeFileSync(scene, '{"a":2}');
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    b.onChange(path.join(assets, 'scenes/other.txt')); // any later event: a manifest rebuild, nothing to report
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
  });

  it('a shader body overwritten after a save is broadcast as its descriptor, raised via its sibling', () => {
    const { save, sent } = batch();
    fs.writeFileSync(path.join(assets, 'shaders/lit.shader.json'), '{"id":"x"}');
    const body = path.join(assets, 'shaders/lit.wgsl');
    save(body, 'fn a() {}');
    fs.writeFileSync(body, 'fn b() {}');
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ urlPath: '/assets/shaders/lit.shader.json', kind: 'shader', viaSibling: true }]);
  });

  // Close-out review: a save whose event dropped, then an outside write putting back EXACTLY the earlier save's bytes.
  it('a checkout that restores the first of two saves — every event after the first dropped — is broadcast', () => {
    const { save, sent, guard } = batch();
    const scene = path.join(assets, 'scenes/main.scene.json');
    save(scene, '{"a":1}');
    guard.mark(scene, fingerprintBytes('{"a":2}')); // the second save — its event dropped
    fs.writeFileSync(scene, '{"a":2}');
    fs.writeFileSync(scene, '{"a":1}'); // `git checkout` puts the first save's bytes back — dropped too
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ urlPath: '/assets/scenes/main.scene.json', kind: 'scene', viaSibling: false }]);
  });

  // The accept side: the recheck must not turn the editor's own save into an outside change.
  it('the editor`s own save alone broadcasts nothing — and a second save of the same file neither', () => {
    const { save, sent, rebuilds } = batch();
    const scene = path.join(assets, 'scenes/main.scene.json');
    save(scene, '{"a":1}');
    save(scene, '{"a":2}'); // re-marked: the flush compares against the LAST save's bytes
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([]);
    expect(rebuilds()).toBe(1);
  });
});
