/** Timeline review C1 — a control-track prefab spawned by the editor SCRUB reconciler
 *  (`previewControlAt`) must NEVER leak into a saved scene, EVEN when the reconciler runs while
 *  RunMode is still `stopped`.
 *
 *  The bug: `spawnPrefabInstance` tags a spawn `Transient` only when `getRunMode() !== 'stopped'`,
 *  but `previewControlAt` is also reached from the commit/undo pose (`TimelineEditor.pose`) while
 *  the mode is `stopped` — so the spawned prefab was untagged and the real serializer kept it,
 *  leaking a preview artifact into the authored scene. The fix: `previewControlAt` passes
 *  `forceTransient: true`, so its spawn is tagged regardless of mode.
 *
 *  This drives the REAL spawn path + REAL serializer (mirrors transientSerializeSkip.test.ts); only
 *  the prefab CACHE lookup is stubbed (like timelineControlSpawn.test.ts) so no asset fetch is needed. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PREFAB_DEF = {
  rootLocalId: 1,
  id: 'p',
  entities: [
    { localId: 1, traits: { EntityAttributes: { name: 'Spark' }, Transform: { x: 0, y: 0, z: 0 } } },
  ],
};

// Only the cache lookup is stubbed — spawnPrefabInstance (the code under test) stays REAL.
vi.mock('../../src/runtime/loaders/meshTemplateCache', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCachedPrefab: () => PREFAB_DEF,
}));

import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { Transient } from '../../src/runtime/traits/Transient';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/systems/playState';
import { spawnPrefabInstance } from '../../src/runtime/loaders/loadSceneFile';
import { previewControlAt, clearPreviewControls } from '../../src/runtime/systems/timelineSystem';
import { normalizeTimeline } from '../../src/runtime/timeline/types';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: {}, isActive: {}, sortOrder: {}, parentId: {}, layer: {}, guid: {} },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
}

let world: ReturnType<typeof createWorld>;
function spawnAuthored(...args: unknown[]) {
  const ent = world.spawn(...(args as Parameters<typeof world.spawn>));
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

beforeEach(() => {
  registerAll();
  world = createWorld();
  setCurrentWorld(world);
});
afterEach(() => {
  clearPreviewControls();
  setRunMode('playing', { advancing: true }); // restore runtime default
  world.destroy();
});

function controlTimeline() {
  return normalizeTimeline({
    id: 'c', name: 'Ctrl', duration: 4, frameRate: 30,
    tracks: [{ id: 'ctl', name: 'FX', target: '', type: 'control', clips: [{ start: 1, duration: 1, prefab: 'prefab-guid-x' }] }],
  });
}

function findByName(name: string): { has(t: unknown): boolean } | null {
  let found: { has(t: unknown): boolean } | null = null;
  world.query(EntityAttributes).updateEach(([ea], entity) => {
    if (!found && (ea as { name?: string }).name === name) found = entity as unknown as { has(t: unknown): boolean };
  });
  return found;
}

describe('timeline scrub control-spawn transience (review C1)', () => {
  it('a previewControlAt spawn in STOPPED mode is Transient and is dropped by the serializer', async () => {
    setRunMode('stopped'); // the commit/undo pose path — the exact condition that used to leak
    const root = spawnAuthored(EntityAttributes({ name: 'Root', guid: 'dir-guid' }), Transform);

    previewControlAt(world, root.id(), controlTimeline(), 1.5); // inside [1,2) → spawns the prefab

    const spark = findByName('Spark');
    expect(spark).not.toBeNull();
    expect(spark!.has(Transient)).toBe(true); // tagged despite stopped mode (forceTransient)

    const scene = await serializeScene();
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Root');     // authored entity survives
    expect(names).not.toContain('Spark'); // preview spawn never reaches disk
  });

  it('forceTransient is what tags the spawn — a plain spawnPrefabInstance in stopped mode does NOT', () => {
    setRunMode('stopped');
    const parent = spawnAuthored(EntityAttributes({ name: 'Root', guid: 'dir-guid' }), Transform);

    const plainId = spawnPrefabInstance(world, PREFAB_DEF, { parentId: parent.id() });
    const forcedId = spawnPrefabInstance(world, PREFAB_DEF, { parentId: parent.id(), forceTransient: true });

    const get = (id: number) => {
      let e: { has(t: unknown): boolean } | null = null;
      world.query(EntityAttributes).updateEach((_v, entity) => {
        if (!e && (entity as unknown as { id(): number }).id() === id) e = entity as unknown as { has(t: unknown): boolean };
      });
      return e;
    };
    expect(get(plainId)!.has(Transient)).toBe(false); // default: stopped-mode spawn is authored
    expect(get(forcedId)!.has(Transient)).toBe(true);  // forceTransient overrides the mode check
  });
});
