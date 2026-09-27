/** #1591 — a spawn or destroy dirties the UI tree on its own, not only through a trait write.
 *
 *  The UI tree rebuilt on a trait write or a world swap only. `createEntityWithUndo` got its rebuild
 *  by accident — `ensureGuid` writes a guid when the entity has none — so every create path that
 *  spawns an entity already carrying a guid left it out of the tree: an addEntity with an authored
 *  `EntityAttributes.guid` (the report: a Canvas2D host rendering black in both views until a
 *  reload), a redone create, and an undone delete (both respawn from a snapshot holding the guid).
 *
 *  REAL world, spawn seam, trait registry, entityActions and undoManager — the mechanism is the
 *  `spawnEntity` → `registerEntity` → structure-callback chain, so none of it may be mocked (a
 *  mocked `spawnEntity` could never fail this test). Each case clears the flag first, so the only
 *  thing that can set it is the operation under test. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { RenderableUI } from '../../src/runtime/traits/RenderableUI';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { uiTreeProjection, useUITreeStore } from '../../src/runtime/ui/uiTreeStore';
import { isUIDirty, clearUIDirty } from '../../src/runtime/core/uiDirty';
import { createEntityWithUndo, deleteEntityWithUndo } from '../../src/editor/undo/entityActions';
import { undo, redo, clearHistory } from '../../src/editor/undo/undoManager';
import { findEntityByGuid } from '../../src/runtime/core/ecs/world';
import { setPlayState } from '../../src/runtime/core/playState';

// The real field list matters: `ensureGuid` reads the guid through `readTraitData`, which returns only
// the listed fields — an empty list would make it mint over the authored guid and dirty the tree itself.
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {
  name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number' },
  guid: { type: 'string' }, layer: { type: 'string' },
} } as never);
registerTrait({ name: 'RenderableUI', trait: RenderableUI, category: 'component', fields: {} } as never);
// Registered so `buildTree` can run: without it the projection returns null and only the flag is observable.
registerTrait({ name: 'UIElement', trait: UIElement, category: 'component', fields: {} } as never);

const GUID = 'a1591000-0000-4000-8000-000000000001';

let tw: TestWorld;
beforeEach(() => {
  tw = createTestWorld();
  setPlayState('stopped'); // editor undo/redo is an edit-mode operation; the harness starts 'playing'
  clearHistory();
  uiTreeProjection(tw.world); // registers the tree's listeners (lazy, on the first projection)
});
afterEach(() => { clearHistory(); tw.dispose(); });

function createHost(guid?: string): number {
  const id = createEntityWithUndo('Add Host', 0, [
    { name: 'RenderableUI' },
    { name: 'UIElement' },
    { name: 'EntityAttributes', data: { name: 'Host', layer: 'ui', ...(guid ? { guid } : {}) } },
  ], () => {});
  expect(id).not.toBeNull();
  return id!;
}

describe('#1591: entity structure changes dirty the UI tree', () => {
  it('a create carrying an authored guid dirties the tree (no guid mint happens)', async () => {
    clearUIDirty();
    createHost(GUID);
    expect(findEntityByGuid(GUID)).toBeDefined(); // the authored guid was kept: nothing was minted
    expect(isUIDirty()).toBe(true);
  });

  it('a redone create dirties the tree', async () => {
    createHost();
    await undo();
    clearUIDirty();
    await redo();
    expect(isUIDirty()).toBe(true);
  });

  it('an undone delete dirties the tree', async () => {
    const id = createHost(GUID);
    deleteEntityWithUndo(id);
    expect(findEntityByGuid(GUID)).toBeUndefined();
    clearUIDirty();
    await undo();
    expect(findEntityByGuid(GUID)).toBeDefined();
    expect(isUIDirty()).toBe(true);
  });

  it('the authored-guid host reaches the projected tree — the reported symptom, not just the flag', () => {
    uiTreeProjection(tw.world);
    const before = useUITreeStore.getState().tree.length;
    const id = createHost(GUID);
    uiTreeProjection(tw.world);
    const tree = useUITreeStore.getState().tree;
    expect(tree.length).toBe(before + 1);
    expect(tree.some((n) => n.entityId === id)).toBe(true);
  });
});
