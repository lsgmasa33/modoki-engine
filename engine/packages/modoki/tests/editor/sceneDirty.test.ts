/** scene-loading.md Phase 12, M2 — per-scene dirty tracking.
 *  Deliberately has NO SceneManager involvement (see sceneDirty.ts's own doc
 *  comment: the primary is never tracked here — only a base's own guid is —
 *  which is what keeps this module's dependency footprint light enough to import
 *  from entityActions.ts without dragging SceneManager's loader graph into every
 *  trait-edit unit test). */

import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { setCurrentWorld, registerEntity } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import {
  markSceneDirty, resolveAffectedScenes, markSceneDirtyForEntity,
  clearSceneDirty, isSceneDirty, clearAllSceneDirty, dirtySceneGuidsSnapshot,
} from '../../src/editor/scene/sceneDirty';

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } },
  });
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
  return ent.id();
}

beforeEach(() => {
  clearAllSceneDirty();
  registerAll();
  freshWorld();
});

describe('sceneDirty (Phase 12, M2)', () => {
  it('resolveAffectedScenes returns [] for a primary-owned entity (sourceScene "")', () => {
    const id = spawn(EntityAttributes({ name: 'Primary', sourceScene: '' }));
    expect(resolveAffectedScenes([id])).toEqual([]);
  });

  it('resolveAffectedScenes returns the base guid for a base-origin entity', () => {
    const id = spawn(EntityAttributes({ name: 'BaseEntity', sourceScene: 'base-guid-1' }));
    expect(resolveAffectedScenes([id])).toEqual(['base-guid-1']);
  });

  it('resolveAffectedScenes dedupes across several entities from the same base', () => {
    const a = spawn(EntityAttributes({ name: 'A', sourceScene: 'base-guid-1' }));
    const b = spawn(EntityAttributes({ name: 'B', sourceScene: 'base-guid-1' }));
    expect(resolveAffectedScenes([a, b])).toEqual(['base-guid-1']);
  });

  it('markSceneDirtyForEntity + isSceneDirty round-trip for a base entity', () => {
    const id = spawn(EntityAttributes({ name: 'BaseEntity', sourceScene: 'base-guid-1' }));
    expect(isSceneDirty('base-guid-1')).toBe(false);
    markSceneDirtyForEntity(id);
    expect(isSceneDirty('base-guid-1')).toBe(true);
  });

  it('marking a primary entity dirty is a no-op (nothing to track)', () => {
    const id = spawn(EntityAttributes({ name: 'Primary', sourceScene: '' }));
    markSceneDirtyForEntity(id);
    expect(dirtySceneGuidsSnapshot().size).toBe(0);
  });

  it('clearSceneDirty removes only the named guid', () => {
    markSceneDirty('base-guid-1');
    markSceneDirty('base-guid-2');
    clearSceneDirty('base-guid-1');
    expect(isSceneDirty('base-guid-1')).toBe(false);
    expect(isSceneDirty('base-guid-2')).toBe(true);
  });

  it('clearAllSceneDirty clears everything (a scene load/new-scene baseline)', () => {
    markSceneDirty('base-guid-1');
    markSceneDirty('base-guid-2');
    clearAllSceneDirty();
    expect(dirtySceneGuidsSnapshot().size).toBe(0);
  });

  it('dirtySceneGuidsSnapshot is a copy — mutating it does not affect internal state', () => {
    markSceneDirty('base-guid-1');
    const snap = dirtySceneGuidsSnapshot() as Set<string>;
    snap.add('base-guid-2');
    expect(isSceneDirty('base-guid-2')).toBe(false);
  });
});
