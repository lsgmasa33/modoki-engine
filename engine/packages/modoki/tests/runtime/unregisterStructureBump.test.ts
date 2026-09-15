/** #1220 — entity lifecycle is symmetric in the structure version: `registerEntity` bumps it, and so
 *  does `unregisterEntity`. Before the fix a destroy moved no version at all, so a memo keyed on the
 *  structure version (the Animation Editor's entity index, SceneView's 2D graph) kept a destroyed
 *  entity's row until the next spawn anywhere bumped it — a name-path or parent that still resolved
 *  to an entity that no longer exists. (A respawn on the SAME index was never the risk for such a
 *  memo: its own registerEntity bumps first.)
 *
 *  Real world module and real entityUtils (which wires the structure callback) — no mocks, because
 *  the callback wiring IS the mechanism. */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld, spawnEntity, destroyEntity } from '../../src/runtime/core/ecs/world';
import { getStructureVersion, onStructureDirty } from '../../src/runtime/core/ecs/entityUtils';

describe('destroyEntity bumps the structure version (#1220)', () => {
  it('a destroy bumps it once and notifies structure listeners', () => {
    const w = createWorld();
    setCurrentWorld(w);
    const e = spawnEntity(w, EntityAttributes({ name: 'doomed' }));
    let notified = 0;
    const unsub = onStructureDirty(() => { notified++; });
    const before = getStructureVersion();
    destroyEntity(e, w);
    unsub();
    expect(getStructureVersion()).toBe(before + 1);
    expect(notified).toBe(1);
  });

  it('a destroy in a world that is NOT current bumps too, exactly as a register there does', () => {
    // registerEntity fires for a staging world (a scene load registers there before the swap), so the
    // mirror does too: the structure version means "the entity set changed somewhere", and a
    // world-scoped variant of it would be a second contract for every subscriber to learn.
    const current = createWorld();
    setCurrentWorld(current);
    const staging = createWorld();
    const beforeSpawn = getStructureVersion();
    const e = spawnEntity(staging, EntityAttributes({ name: 'staged' }));
    expect(getStructureVersion()).toBe(beforeSpawn + 1);
    const beforeDestroy = getStructureVersion();
    destroyEntity(e, staging);
    expect(getStructureVersion()).toBe(beforeDestroy + 1);
  });
});
