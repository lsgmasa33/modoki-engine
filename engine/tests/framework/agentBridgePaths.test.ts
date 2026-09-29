/** Regression test for the agent-bridge scene hot-reload path equality gate.
 *
 *  The game app loads scenes via `./assets/scenes/x.json?url`, which resolves to
 *  `/games/<id>/runtime/assets/...` (with `runtime/`), while the dev-server
 *  watcher broadcasts the asset-root URL `/games/<id>/assets/...` (without it).
 *  Without normalization the equality gate never matched in the game app, so the
 *  scene-edit hot-reload silently no-op'd there (it only worked in the editor).
 *  normScenePath must collapse both forms so the gate matches in both. */

import { describe, it, expect } from 'vitest';
import { normScenePath, sceneReloadSource } from '../../app/debug/agentBridge';

describe('normScenePath', () => {
  it('collapses the runtime/assets vs assets divergence', () => {
    const gameForm = '/games/3d-test/runtime/assets/scenes/tropical-island.json';
    const broadcastForm = '/games/3d-test/assets/scenes/tropical-island.json';
    expect(normScenePath(gameForm)).toBe(normScenePath(broadcastForm));
  });

  it('reconciles the editor /@fs absolute path with the clean /assets broadcast', () => {
    // Editor "open scene" holds the active scene as Vite's absolute @fs form, while
    // the watcher broadcasts the project-stripped asset-root URL. The gate must match.
    const current = '/@fs/Users/me/Projects/modoki/games/space-console/runtime/assets/scenes/Warp.json';
    const broadcast = '/assets/scenes/Warp.json';
    expect(normScenePath(current)).toBe(normScenePath(broadcast));
    expect(normScenePath(current), 'a key, case-folded (#1786)').toBe('/assets/scenes/warp.json');
  });

  it('strips a ?url / query suffix and reduces to the /assets suffix', () => {
    expect(normScenePath('/games/x/assets/scenes/a.json?url')).toBe('/assets/scenes/a.json');
    expect(normScenePath('/games/x/assets/scenes/a.json?t=123')).toBe('/assets/scenes/a.json');
  });

  // #1786 review siblings — synthetic spellings the server resolves (not observed live, unlike the case fold's strings
  // in agentBridgeReloadHoldsWorld.test.ts): an upper-case asset folder, a percent-encoded name, a malformed escape.
  it('finds the /assets/ segment in any case, and decodes a percent-encoded name', () => {
    const want = '/assets/scenes/2d animation.scene.json';
    expect(normScenePath('/@fs/E:/Proj/Runtime/Assets/scenes/2D Animation.scene.json')).toBe(want);
    expect(normScenePath('/assets/scenes/2D%20Animation.scene.json')).toBe(want);
    expect(normScenePath('/assets/scenes/bad%E0.scene.json'), 'a malformed escape keeps its spelling').toBe('/assets/scenes/bad%e0.scene.json');
  });

  // #1791 — strings OBSERVED on Windows (games/scroll-demo, launch-editor.sh, 2026-09-29).
  it('keys a scene in a folder named Assets by its whole path under the root, not from the last /assets/ (#1791)', () => {
    const nested = '/assets/scenes/Assets/nest1791.scene.json';
    const top = '/assets/nest1791.scene.json';
    expect(normScenePath(nested), 'two files, one key: a change to one reloaded the other').not.toBe(normScenePath(top));
    expect(normScenePath(nested)).toBe('/assets/scenes/assets/nest1791.scene.json');
    // The same file in the other forms still meets it: the game app's, the broadcast's, and Vite's /@fs.
    expect(normScenePath('/games/scroll-demo/runtime/assets/scenes/Assets/nest1791.scene.json')).toBe(normScenePath(nested));
    expect(normScenePath('/games/scroll-demo/assets/scenes/Assets/nest1791.scene.json')).toBe(normScenePath(nested));
    expect(normScenePath('/@fs/E:/Projects/modoki/games/scroll-demo/runtime/assets/scenes/Assets/nest1791.scene.json')).toBe(normScenePath(nested));
  });

  it('collapses a dot segment and a doubled slash, as the server does when it resolves the file (#1791)', () => {
    const want = normScenePath('/assets/scenes/win1791.scene.json');
    expect(normScenePath('/assets/scenes/./win1791.scene.json'), 'observed: MCP load_scene stored this spelling').toBe(want);
    expect(normScenePath('/assets/prefabs/../scenes/win1791.scene.json')).toBe(want);
    expect(normScenePath('/assets/scenes//win1791.scene.json')).toBe(want);
    // A relative typed path is rooted first, as the server roots it (close-out review: `./assets/…` met the broadcast
    // before the collapse, and dropping its leading `.` without rooting it would have lost that).
    expect(normScenePath('./assets/scenes/win1791.scene.json')).toBe(want);
    expect(normScenePath('assets/scenes/win1791.scene.json')).toBe(want);
    expect(normScenePath(''), 'the untitled history key').toBe('');
  });

  it('anchors every URL root form, so a folder named Assets under any of them keeps its place (#1791)', () => {
    expect(normScenePath('/demos/forest-camp/assets/scenes/Assets/x.scene.json')).toBe('/assets/scenes/assets/x.scene.json');
    expect(normScenePath('/modoki/assets/scenes/Assets/x.scene.json')).toBe('/assets/scenes/assets/x.scene.json');
  });

  it('returns a prefab-edit key whole, even one built from a prefab PATH (it keeps the prefix adopt reads, U27)', () => {
    const byPath = '/__prefab-edit__//assets/prefabs/X.prefab.json';
    expect(normScenePath(byPath)).toBe(byPath);
  });

  it('is idempotent on the canonical /assets suffix', () => {
    const canonical = '/assets/scenes/a.json';
    expect(normScenePath('/games/x/assets/scenes/a.json')).toBe(canonical);
    expect(normScenePath(canonical)).toBe(canonical);
    expect(normScenePath(normScenePath(canonical))).toBe(canonical);
  });
});

/** Regression for "[Hierarchy] No prefab instance trait after Create Prefab": in
 *  the Electron editor the renderer writes through main's backend (which owns the
 *  self-write guard), but reloads were being driven by Vite's HMR watcher (separate,
 *  unmarked guard) — so the editor's own prefab write bounced the live scene and
 *  wiped the just-applied in-memory PrefabInstance tags. Exactly ONE source must
 *  drive reloads, and it must be the one owning the guard for this renderer's writes. */
describe('sceneReloadSource', () => {
  it('drives reloads off the Electron bridge whenever one is present (dev OR packaged)', () => {
    // Electron dev: Vite HMR is ALSO present, but main owns the write guard — bridge wins.
    expect(sceneReloadSource({ hasBridge: true, hasHot: true })).toBe('bridge');
    // Packaged Electron: no Vite HMR.
    expect(sceneReloadSource({ hasBridge: true, hasHot: false })).toBe('bridge');
  });

  it('drives reloads off Vite HMR only in browser dev (no Electron bridge)', () => {
    expect(sceneReloadSource({ hasBridge: false, hasHot: true })).toBe('vite');
  });

  it('reports no transport when neither is available', () => {
    expect(sceneReloadSource({ hasBridge: false, hasHot: false })).toBeNull();
  });

  it('never picks Vite when a bridge exists — the unguarded-double-reload bug', () => {
    // The whole point: with a bridge, Vite must NOT be a (second) reload driver.
    expect(sceneReloadSource({ hasBridge: true, hasHot: true })).not.toBe('vite');
  });
});
