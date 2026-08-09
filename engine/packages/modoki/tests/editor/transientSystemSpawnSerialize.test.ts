/** #124 regression — save-all was persisting runtime-spawned entities into the scene file:
 *  loading `games/chess` and saving wrote ~70 system-spawned entities (`piece_a1`…) as if
 *  authored, because chess's board-sync system is registered at PROJECTION (300) — a tier that
 *  `runPipeline` runs even while the editor is Stopped (only sim tiers < TRANSFORM are gated) —
 *  and nothing tagged a plain system spawn as generated.
 *
 *  Fix: `spawnEntity` (ecs/world.ts) now tags a spawn made from inside a running system
 *  `Transient`, and `serializeScene` already skips `Transient` subtrees (transientSerializeSkip
 *  .test.ts covers that half). This test proves the two halves compose: a PROJECTION-tier system
 *  spawning entities while STOPPED must not survive a save, while authored entities do. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { setCurrentWorld, spawnEntity } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { registerSystem, unregisterSystem, runPipeline, SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { serializeScene } from '../../src/editor/scene/serialize';
import { setRunMode } from '../../src/runtime/core/playState';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] }, guid: { type: 'string' } },
  });
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component',
    fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } },
  });
}

function freshWorld() {
  const w = createWorld();
  setCurrentWorld(w);
  return w;
}

describe('save-all no longer persists a PROJECTION-tier system spawn (#124)', () => {
  afterEach(() => {
    unregisterSystem('boardSyncLikeChess');
    setRunMode('playing', { advancing: true }); // restore runtime default
  });

  it('drops entities spawned by a stopped-but-still-running PROJECTION system; keeps authored ones', async () => {
    registerAll();
    const w = freshWorld();

    const authored = spawnEntity(w, EntityAttributes({ name: 'Authored', guid: 'g-authored' }), Transform);
    expect(authored.has).toBeDefined(); // sanity: real koota entity

    // Mirrors chess's board-sync: a PROJECTION-tier (300) system that spawns into the live
    // world. Editor Stopped — the sim tiers are gated, PROJECTION is not (pipeline.ts).
    setRunMode('stopped');
    registerSystem('boardSyncLikeChess', (world) => {
      spawnEntity(world, EntityAttributes({ name: 'piece_a1', guid: 'g-piece-a1' }), Transform);
      spawnEntity(world, EntityAttributes({ name: 'highlight_legal_0', guid: 'g-highlight-0' }), Transform);
    }, SYSTEM_PRIORITY.PROJECTION);

    runPipeline(w);

    const scene = await serializeScene();
    const names = scene.entities.map((e) => e.name);
    expect(names).toContain('Authored');
    expect(names).not.toContain('piece_a1');
    expect(names).not.toContain('highlight_legal_0');
    expect(scene.entities).toHaveLength(1);
  });
});
