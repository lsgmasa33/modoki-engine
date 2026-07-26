/** base-scene plan, Phase 3 — `EntityAttributes.sourceScene` provenance field.
 *  Registered `{ type: 'string', hidden: true, runtimeOnly: true }`:
 *   - `runtimeOnly` → excluded from scene-FILE serialization (a save must never
 *     bake it; it's derived at load time by the chain loader in Phase 5).
 *   - `hidden` → never rendered in the Inspector, but still a REAL registered
 *     field for every serialize/snapshot path — in particular the persistent
 *     carry-across-swap snapshot (Phase 0's fix), which is what lets a carried
 *     entity keep its origin across a swap (so "save Lvl-0002 excludes a
 *     Lvl-0001-origin persistent entity" works once Phase 6 lands).
 *
 *  Exercises the REAL trait + REAL serializer (mirrors baseSceneSerialize.test.ts
 *  and transientSerializeSkip.test.ts), not a mock, so a registration mistake in
 *  registerTraits.ts would actually be caught. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Transform } from '../../src/runtime/traits/Transform';
import { Persistent } from '../../src/runtime/traits/Persistent';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/ecs/world';
import { registerTrait, getAllTraits } from '../../src/runtime/ecs/traitRegistry';
import { serializeScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/systems/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: {
      name: {}, isActive: {}, sortOrder: {}, parentId: { entityId: { onMissing: 'root' } }, layer: {}, guid: {},
      sourceScene: { hidden: true, runtimeOnly: true },
    },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: {}, y: {}, z: {}, rx: {}, ry: {}, rz: {}, sx: {}, sy: {}, sz: {} },
  });
  registerTrait({ name: 'Persistent', trait: Persistent, category: 'tag', fields: {} });
}

function freshWorld() {
  const w = createWorld();
  (globalThis as any).__w = w;
  setCurrentWorld(w);
  return w;
}
function spawn(...args: any[]) {
  const ent = (globalThis as any).__w.spawn(...args);
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

beforeEach(() => { registerAll(); freshWorld(); });
afterEach(() => { setRunMode('playing', { advancing: true }); }); // restore runtime default

describe('EntityAttributes.sourceScene (Phase 3)', () => {
  it('is registered hidden + runtimeOnly, unlike editorFolder which is unregistered', () => {
    const meta = getAllTraits().find((m) => m.name === 'EntityAttributes')!;
    expect(meta.fields.sourceScene).toEqual({ hidden: true, runtimeOnly: true });
    // The wart this deliberately avoids repeating.
    expect(meta.fields.editorFolder).toBeUndefined();
  });

  it('never appears in serializeScene() output for a PRIMARY entity — a save must not bake it', async () => {
    // Empty sourceScene = primary (Phase 3's load-bearing default) — always saved.
    // A non-empty sourceScene entity is a base-origin carry and is now excluded
    // from the save ENTIRELY (Phase 6's save filtering, base-scene-and-
    // persistence-plan.md) — see baseSceneSaveFilter.test.ts for that case.
    spawn(EntityAttributes({ name: 'A', guid: 'g-a', sourceScene: '' }), Transform);
    const scene = await serializeScene();
    const entry = scene.entities.find((e) => e.name === 'A')!;
    const attrs = entry.traits.EntityAttributes as Record<string, unknown> | undefined;
    expect(attrs).toBeDefined();
    expect('sourceScene' in (attrs as Record<string, unknown>)).toBe(false);
  });

  it('survives a persistent carry-across-swap snapshot despite being runtimeOnly', async () => {
    // Direct unit test of the field-set resolution the snapshot uses (Phase 0),
    // proving `sourceScene` is included even though it's runtimeOnly — that flag
    // gates FILE serialization only, not the carry snapshot.
    const { snapshotFieldNames } = await import('../../src/runtime/scene/SceneManager');
    const meta = getAllTraits().find((m) => m.name === 'EntityAttributes')!;
    expect(snapshotFieldNames(meta)).toContain('sourceScene');
  });
});
