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
    expect(normScenePath(current)).toBe('/assets/scenes/Warp.json');
  });

  it('strips a ?url / query suffix and reduces to the /assets suffix', () => {
    expect(normScenePath('/games/x/assets/scenes/a.json?url')).toBe('/assets/scenes/a.json');
    expect(normScenePath('/games/x/assets/scenes/a.json?t=123')).toBe('/assets/scenes/a.json');
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
