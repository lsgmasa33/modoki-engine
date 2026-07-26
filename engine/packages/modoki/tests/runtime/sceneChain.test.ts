/** resolveSceneChain — base-scene plan, Phase 4. Pure function, fake in-memory
 *  scene registry (keyed by both path AND guid, mirroring how a real
 *  fetchSceneMeta would resolve the start path directly and every later hop by
 *  its baseScene guid via the asset manifest). */

import { describe, it, expect } from 'vitest';
import { resolveSceneChain, type SceneChainMeta, type FetchSceneMeta } from '../../src/runtime/scene/sceneChain';

/** Build a fetchSceneMeta over a fixed set of scenes, addressable by path or guid. */
function registryOf(scenes: SceneChainMeta[]): FetchSceneMeta {
  const byPath = new Map(scenes.map((s) => [s.path, s]));
  const byGuid = new Map(scenes.map((s) => [s.guid, s]));
  return async (locator: string) => byPath.get(locator) ?? byGuid.get(locator) ?? null;
}

describe('resolveSceneChain', () => {
  it('a scene with no baseScene resolves to a chain of one', async () => {
    const fetch = registryOf([{ path: '/level.json', guid: 'g-level' }]);
    const { chain, warnings } = await resolveSceneChain('/level.json', fetch);
    expect(warnings).toEqual([]);
    expect(chain).toEqual([{ path: '/level.json', guid: 'g-level' }]);
  });

  it('a linear chain resolves root-most base FIRST, the level LAST', async () => {
    const fetch = registryOf([
      { path: '/level.json', guid: 'g-level', baseScene: 'g-game-base' },
      { path: '/game-base.json', guid: 'g-game-base', baseScene: 'g-engine-base' },
      { path: '/engine-base.json', guid: 'g-engine-base' },
    ]);
    const { chain, warnings } = await resolveSceneChain('/level.json', fetch);
    expect(warnings).toEqual([]);
    expect(chain.map((r) => r.path)).toEqual(['/engine-base.json', '/game-base.json', '/level.json']);
  });

  it('two independent chains sharing a common base each resolve it once, with no cross-call state leak', async () => {
    // "Diamond" in the sense the plan means: two DIFFERENT primaries whose chains
    // both bottom out at the same shared base. Each resolveSceneChain call must
    // succeed on its own — the per-call `visited` set must not leak into the next
    // call and falsely flag the shared base as a cycle.
    const fetch = registryOf([
      { path: '/level1.json', guid: 'g-level1', baseScene: 'g-base-a' },
      { path: '/base-a.json', guid: 'g-base-a', baseScene: 'g-shared' },
      { path: '/level2.json', guid: 'g-level2', baseScene: 'g-base-b' },
      { path: '/base-b.json', guid: 'g-base-b', baseScene: 'g-shared' },
      { path: '/shared.json', guid: 'g-shared' },
    ]);

    const chain1 = await resolveSceneChain('/level1.json', fetch);
    expect(chain1.warnings).toEqual([]);
    expect(chain1.chain.map((r) => r.path)).toEqual(['/shared.json', '/base-a.json', '/level1.json']);

    const chain2 = await resolveSceneChain('/level2.json', fetch);
    expect(chain2.warnings).toEqual([]);
    expect(chain2.chain.map((r) => r.path)).toEqual(['/shared.json', '/base-b.json', '/level2.json']);
  });

  it('a direct cycle (A -> B -> A) warns and degrades — returns what resolved, never throws', async () => {
    const fetch = registryOf([
      { path: '/a.json', guid: 'g-a', baseScene: 'g-b' },
      { path: '/b.json', guid: 'g-b', baseScene: 'g-a' },
    ]);
    const { chain, warnings } = await resolveSceneChain('/a.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cycle/i);
    // Resolved as far as it safely could: A, then B, then stopped before re-adding A.
    expect(chain.map((r) => r.path)).toEqual(['/b.json', '/a.json']);
  });

  it('an indirect cycle (A -> B -> C -> A) warns and degrades', async () => {
    const fetch = registryOf([
      { path: '/a.json', guid: 'g-a', baseScene: 'g-b' },
      { path: '/b.json', guid: 'g-b', baseScene: 'g-c' },
      { path: '/c.json', guid: 'g-c', baseScene: 'g-a' },
    ]);
    const { chain, warnings } = await resolveSceneChain('/a.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cycle/i);
    expect(chain.map((r) => r.path)).toEqual(['/c.json', '/b.json', '/a.json']);
  });

  it('a self-cycle (A -> A) warns and resolves to just A', async () => {
    const fetch = registryOf([{ path: '/a.json', guid: 'g-a', baseScene: 'g-a' }]);
    const { chain, warnings } = await resolveSceneChain('/a.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cycle/i);
    expect(chain.map((r) => r.path)).toEqual(['/a.json']);
  });

  it('a dangling baseScene guid warns and degrades — resolves everything up to the break', async () => {
    const fetch = registryOf([
      { path: '/level.json', guid: 'g-level', baseScene: 'g-missing' },
    ]);
    const { chain, warnings } = await resolveSceneChain('/level.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not resolve/i);
    expect(chain.map((r) => r.path)).toEqual(['/level.json']);
  });

  it('an unresolvable start path warns and returns an empty chain', async () => {
    const fetch = registryOf([]);
    const { chain, warnings } = await resolveSceneChain('/ghost.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(chain).toEqual([]);
  });

  it('the depth cap stops a pathologically long (non-cyclic) chain and warns', async () => {
    // 60 scenes, each pointing at the next — no guid repeats, so the cycle guard
    // never fires; only the depth cap can stop this.
    const N = 60;
    const scenes: SceneChainMeta[] = [];
    for (let i = 0; i < N; i++) {
      scenes.push({
        path: `/s${i}.json`,
        guid: `g-${i}`,
        ...(i + 1 < N ? { baseScene: `g-${i + 1}` } : {}),
      });
    }
    const fetch = registryOf(scenes);
    const { chain, warnings } = await resolveSceneChain('/s0.json', fetch);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/depth cap/i);
    expect(chain.length).toBe(50); // MAX_CHAIN_DEPTH
    expect(chain[chain.length - 1].path).toBe('/s0.json'); // level still last
  });
});
