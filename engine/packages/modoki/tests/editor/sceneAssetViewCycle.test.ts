/** checkBaseSceneCycle — base-scene plan, Phase 8. Pure cycle check used by
 *  SceneAssetView before committing a base-ref change; a fake in-memory
 *  fetchSceneMeta registry mirrors sceneChain.test.ts's own pattern (keyed by
 *  both path AND guid, matching how the editor's real fetchSceneMeta resolves
 *  a guid-first candidate on the very first hop too). */

import { describe, it, expect } from 'vitest';
import { checkBaseSceneCycle } from '../../src/editor/panels/assetViews/SceneAssetView';
import type { SceneChainMeta, FetchSceneMeta } from '../../src/runtime/scene/sceneChain';

function registryOf(scenes: SceneChainMeta[]): FetchSceneMeta {
  const byPath = new Map(scenes.map((s) => [s.path, s]));
  const byGuid = new Map(scenes.map((s) => [s.guid, s]));
  return async (locator: string) => byPath.get(locator) ?? byGuid.get(locator) ?? null;
}

describe('checkBaseSceneCycle', () => {
  it('allows clearing the ref (empty candidate) regardless of myGuid', async () => {
    const fetch = registryOf([{ path: '/level.json', guid: 'g-level' }]);
    expect(await checkBaseSceneCycle('g-level', 'Level', '', fetch)).toBeNull();
  });

  it('refuses a scene naming itself as its own base', async () => {
    const fetch = registryOf([{ path: '/level.json', guid: 'g-level' }]);
    const reason = await checkBaseSceneCycle('g-level', 'Level', 'g-level', fetch);
    expect(reason).toMatch(/cannot be its own base/);
  });

  it('allows a candidate with no existing base (chain of one, no collision)', async () => {
    const fetch = registryOf([
      { path: '/level.json', guid: 'g-level' },
      { path: '/base.json', guid: 'g-base' },
    ]);
    expect(await checkBaseSceneCycle('g-level', 'Level', 'g-base', fetch)).toBeNull();
  });

  it('refuses a direct 2-cycle (base already points back at the level)', async () => {
    const fetch = registryOf([
      { path: '/level.json', guid: 'g-level' },
      { path: '/base.json', guid: 'g-base', baseScene: 'g-level' },
    ]);
    const reason = await checkBaseSceneCycle('g-level', 'Level', 'g-base', fetch);
    expect(reason).toMatch(/would create a cycle/);
    expect(reason).toContain('Level');
  });

  it('refuses an indirect cycle several hops up the chain', async () => {
    const fetch = registryOf([
      { path: '/level.json', guid: 'g-level' },
      { path: '/mid.json', guid: 'g-mid', baseScene: 'g-root' },
      { path: '/root.json', guid: 'g-root', baseScene: 'g-level' },
    ]);
    const reason = await checkBaseSceneCycle('g-level', 'Level', 'g-mid', fetch);
    expect(reason).toMatch(/would create a cycle/);
  });

  it('allows a diamond — two different scenes sharing the same base is not a cycle', async () => {
    const fetch = registryOf([
      { path: '/level-a.json', guid: 'g-a' },
      { path: '/level-b.json', guid: 'g-b' },
      { path: '/shared-base.json', guid: 'g-shared' },
    ]);
    expect(await checkBaseSceneCycle('g-a', 'A', 'g-shared', fetch)).toBeNull();
    expect(await checkBaseSceneCycle('g-b', 'B', 'g-shared', fetch)).toBeNull();
  });

  it('does not flag a cycle when myGuid is unresolved (legacy scene with no id)', async () => {
    const fetch = registryOf([{ path: '/base.json', guid: 'g-base' }]);
    expect(await checkBaseSceneCycle(null, 'Untitled', 'g-base', fetch)).toBeNull();
  });

  it('a dangling candidate guid (unresolvable) is not flagged as a cycle — the load-time warning is the backstop', async () => {
    const fetch = registryOf([{ path: '/level.json', guid: 'g-level' }]);
    expect(await checkBaseSceneCycle('g-level', 'Level', 'g-does-not-exist', fetch)).toBeNull();
  });
});
