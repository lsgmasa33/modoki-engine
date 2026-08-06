/** #124 — spawnEntity (ecs/world.ts) tags a spawn made from inside a running system `Transient`,
 *  so runtime-spawned entities (e.g. chess's PROJECTION-tier board sync, which runs even while
 *  the editor is stopped) don't get baked into the scene file on save. This exercises the
 *  tagging mechanism itself, against a real koota world + the real pipeline: a spawn made from
 *  inside a registered system's `fn(world)` gets `Transient`; the identical `spawnEntity` call
 *  made outside a tick does not. (The serializer-level regression — that this actually keeps
 *  such entities out of a save — lives in transientSystemSpawnSerialize.test.ts.) */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';

beforeEach(() => {
  vi.resetModules();
});

async function modules() {
  const world = await import('../../src/runtime/core/ecs/world');
  const pipeline = await import('../../src/runtime/core/pipeline');
  const { Transient } = await import('../../src/runtime/core/traits/Transient');
  return { world, pipeline, Transient };
}

describe('spawnEntity Transient tagging', () => {
  it('tags a spawn made from inside a running system', async () => {
    const { world, pipeline, Transient } = await modules();
    const w = createWorld();
    world.setCurrentWorld(w);

    let spawnedInTick: ReturnType<typeof world.spawnEntity> | undefined;
    pipeline.registerSystem('spawner', (sysWorld) => {
      spawnedInTick = world.spawnEntity(sysWorld);
    }, 100);

    pipeline.runPipeline(w);

    expect(spawnedInTick).toBeDefined();
    expect(spawnedInTick!.has(Transient)).toBe(true);
  });

  it('does NOT tag the identical spawnEntity call made outside a tick', async () => {
    const { world, Transient } = await modules();
    const w = createWorld();
    world.setCurrentWorld(w);

    const spawnedOutside = world.spawnEntity(w);
    expect(spawnedOutside.has(Transient)).toBe(false);
  });
});
