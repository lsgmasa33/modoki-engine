/** Tests for selection restore across world swaps. The path-matching logic
 *  walks EntityAttributes.parentId chains in both worlds and re-attaches the
 *  editor's selectedEntityId to the entity with the same name + ancestor path
 *  in the new world. Persistent entities survive; everything else clears. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld as _createWorld, trait, type World } from 'koota';

// Wrap createWorld so every test's worlds can be destroyed in afterEach —
// keeps us under koota's 16-world budget across the whole suite.
const _trackedWorlds: World[] = [];
function createWorld(): World {
  const w = _createWorld();
  _trackedWorlds.push(w);
  return w;
}

// Test traits — minimal subset. Universal entity guid lives on EntityAttributes;
// Persistent is just a marker trait for "survives scene swap".
const Transform = trait({ x: 0, y: 0, z: 0 });
const EntityAttributes = trait({ name: '', parentId: 0, sortOrder: 0, layer: '', guid: '' });
const Persistent = trait({});

vi.mock('../../src/runtime/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, parentId: { type: 'number' }, sortOrder: { type: 'number' }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: Persistent, category: 'tag', fields: {} },
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find(t => t.name === name),
  };
});

beforeEach(async () => {
  vi.resetModules();
});

afterEach(() => {
  // Free koota world ids so the per-process 16-world budget isn't exhausted
  while (_trackedWorlds.length > 0) {
    const w = _trackedWorlds.pop();
    try { (w as any)?.destroy?.(); } catch { /* already destroyed */ }
  }
});

async function getRestore() {
  return import('../../src/editor/store/selectionRestore');
}

async function getStore() {
  return import('../../src/editor/store/editorStore');
}

describe('restoreSelectionAcrossSwap', () => {
  it('restores selection when a persistent root entity is in the new world', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    // Old world has Camera
    const oldCamera = oldWorld.spawn(Transform({ x: 1 }), EntityAttributes({ name: 'Camera', parentId: 0 }));
    // New world has a Camera at a different entity id
    const newCamera = newWorld.spawn(Transform({ x: 99 }), EntityAttributes({ name: 'Camera', parentId: 0 }));

    // User had selected the old Camera
    useEditorStore.setState({ selectedEntityId: oldCamera.id() });

    // Swap
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBe(newCamera.id());
  });

  it('matches a child entity by full ancestor name path, not just leaf name', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    // Old world: PlayerRoot → Inventory → Item
    const oldRoot = oldWorld.spawn(Transform(), EntityAttributes({ name: 'PlayerRoot', parentId: 0 }));
    const oldInv = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Inventory', parentId: oldRoot.id() }));
    const oldItem = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Item', parentId: oldInv.id() }));

    // New world: same structure but also has another unrelated 'Item' under a different parent
    const newRoot = newWorld.spawn(Transform(), EntityAttributes({ name: 'PlayerRoot', parentId: 0 }));
    const newInv = newWorld.spawn(Transform(), EntityAttributes({ name: 'Inventory', parentId: newRoot.id() }));
    const newItem = newWorld.spawn(Transform(), EntityAttributes({ name: 'Item', parentId: newInv.id() }));
    // Decoy: same leaf name, different path
    const decoyRoot = newWorld.spawn(Transform(), EntityAttributes({ name: 'EnemyRoot', parentId: 0 }));
    newWorld.spawn(Transform(), EntityAttributes({ name: 'Item', parentId: decoyRoot.id() }));

    useEditorStore.setState({ selectedEntityId: oldItem.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    // Should match the Item under PlayerRoot/Inventory, not the decoy
    expect(useEditorStore.getState().selectedEntityId).toBe(newItem.id());
  });

  it('clears selection when the selected entity has no match in the new world', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    const oldEntity = oldWorld.spawn(Transform(), EntityAttributes({ name: 'TempEntity', parentId: 0 }));
    // New world has nothing named "TempEntity"
    newWorld.spawn(Transform(), EntityAttributes({ name: 'OtherEntity', parentId: 0 }));

    useEditorStore.setState({ selectedEntityId: oldEntity.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('is a no-op when no entity is selected', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    useEditorStore.setState({ selectedEntityId: null });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('clears selection when the selected entity does not exist in the old world (stale id)', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();
    newWorld.spawn(Transform(), EntityAttributes({ name: 'Anything', parentId: 0 }));

    // Selection points to an entity that was never spawned in oldWorld
    useEditorStore.setState({ selectedEntityId: 99999 });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('clears selection when the ancestor chain is broken (missing parent entity)', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    // The selected entity's parentId points at an id that was never spawned,
    // so walking the chain should bail out and clear the selection.
    const oldWorld = createWorld();
    // 999 is not a real entity — the parent lookup will miss
    const oldChild = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Orphan', parentId: 999 }));

    const newWorld = createWorld();
    newWorld.spawn(Transform(), EntityAttributes({ name: 'Orphan', parentId: 0 }));

    useEditorStore.setState({ selectedEntityId: oldChild.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    // Broken old-world chain → path is null → selection clears
    expect(useEditorStore.getState().selectedEntityId).toBeNull();
  });

  it('does not infinite-loop on a circular parentId chain', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    // Build an old world where A's parent is B and B's parent is A. This
    // should never happen in practice, but the walker must be defensive.
    const oldWorld = createWorld();
    const a = oldWorld.spawn(Transform(), EntityAttributes({ name: 'A', parentId: 0 }));
    const b = oldWorld.spawn(Transform(), EntityAttributes({ name: 'B', parentId: a.id() }));
    // Rewrite A's parentId to point at B — creates a cycle A→B→A
    a.set(EntityAttributes, { name: 'A', parentId: b.id(), sortOrder: 0, layer: '' });

    const newWorld = createWorld();
    newWorld.spawn(Transform(), EntityAttributes({ name: 'Unrelated', parentId: 0 }));

    useEditorStore.setState({ selectedEntityId: b.id() });

    // Must terminate. The exact resulting selection value is secondary — the
    // point of this test is "does not hang / throw".
    expect(() => restoreSelectionAcrossSwap(newWorld, oldWorld)).not.toThrow();
  });

  it('restores selection across a parent reorder (different ancestor entity ids, same names)', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    // Simulates persistent entity transfer: same name path, totally different ids
    const oldWorld = createWorld();
    // Spawn some unrelated entities first to push the parent id higher
    oldWorld.spawn(Transform(), EntityAttributes({ name: 'Pad1', parentId: 0 }));
    oldWorld.spawn(Transform(), EntityAttributes({ name: 'Pad2', parentId: 0 }));
    const oldRoot = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Player', parentId: 0 }));
    const oldChild = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Hand', parentId: oldRoot.id() }));

    const newWorld = createWorld();
    // New world has Player + Hand at totally different entity ids (no padding entities)
    const newRoot = newWorld.spawn(Transform(), EntityAttributes({ name: 'Player', parentId: 0 }));
    const newChild = newWorld.spawn(Transform(), EntityAttributes({ name: 'Hand', parentId: newRoot.id() }));

    expect(oldChild.id()).not.toBe(newChild.id()); // sanity: ids genuinely differ

    useEditorStore.setState({ selectedEntityId: oldChild.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBe(newChild.id());
  });

  it('restores selection for a persistent entity via guid even when name/path changed', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    // Old world: Player is a root
    const oldPlayer = oldWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'Player', parentId: 0, guid: 'guid-player-1' }),
      Persistent(),
    );

    // New world: Player has a totally different name and path, but same guid
    const newRoot = newWorld.spawn(Transform(), EntityAttributes({ name: 'GameWorld', parentId: 0 }));
    const newPlayer = newWorld.spawn(
      Transform(),
      EntityAttributes({ name: 'RenamedPlayer', parentId: newRoot.id(), guid: 'guid-player-1' }),
      Persistent(),
    );

    // Name+path match would fail (Player vs GameWorld/RenamedPlayer)
    useEditorStore.setState({ selectedEntityId: oldPlayer.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    // Guid fast-path should find it
    expect(useEditorStore.getState().selectedEntityId).toBe(newPlayer.id());
  });

  it('falls back to name+path for non-persistent entities', async () => {
    const { restoreSelectionAcrossSwap } = await getRestore();
    const { useEditorStore } = await getStore();

    const oldWorld = createWorld();
    const newWorld = createWorld();

    // Non-persistent entity — no Persistent trait
    const oldEntity = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Tree', parentId: 0 }));
    const newEntity = newWorld.spawn(Transform(), EntityAttributes({ name: 'Tree', parentId: 0 }));

    useEditorStore.setState({ selectedEntityId: oldEntity.id() });
    restoreSelectionAcrossSwap(newWorld, oldWorld);

    // Should match via name+path fallback
    expect(useEditorStore.getState().selectedEntityId).toBe(newEntity.id());
  });
});

describe('registerSelectionRestore', () => {
  // These tests mock onWorldSwap so they don't need to exercise the real
  // worldRegistry (which would spend koota world-id slots per invocation).

  it('is idempotent: registering twice only subscribes one listener', async () => {
    // Capture registered listeners via a mock of the worldRegistry
    const registered: Array<(newWorld: any, oldWorld: any) => void> = [];
    vi.doMock('../../src/runtime/ecs/world', () => ({
      onWorldSwap: (fn: any) => { registered.push(fn); return () => {}; },
      // editorStore now transitively pulls in entityUtils (via entityRef), which
      // calls setStructureCallback at module load.
      getCurrentWorld: () => undefined, findEntityById: () => undefined,
      unregisterEntity: () => {}, setStructureCallback: () => {},
    }));

    const { registerSelectionRestore } = await import('../../src/editor/store/selectionRestore');

    registerSelectionRestore();
    registerSelectionRestore();
    registerSelectionRestore();

    expect(registered).toHaveLength(1);
    vi.doUnmock('../../src/runtime/ecs/world');
  });

  it('wires restoreSelectionAcrossSwap into the onWorldSwap callback', async () => {
    // Intercept the listener at registration time so we can invoke it manually
    let listener: ((newWorld: any, oldWorld: any) => void) | null = null;
    vi.doMock('../../src/runtime/ecs/world', () => ({
      onWorldSwap: (fn: any) => { listener = fn; return () => {}; },
      getCurrentWorld: () => undefined, findEntityById: () => undefined,
      unregisterEntity: () => {}, setStructureCallback: () => {},
    }));

    const { registerSelectionRestore } = await import('../../src/editor/store/selectionRestore');
    const { useEditorStore } = await getStore();

    registerSelectionRestore();
    expect(listener).not.toBeNull();

    const oldWorld = createWorld();
    const newWorld = createWorld();
    const oldCamera = oldWorld.spawn(Transform(), EntityAttributes({ name: 'Camera', parentId: 0 }));
    const newCamera = newWorld.spawn(Transform(), EntityAttributes({ name: 'Camera', parentId: 0 }));

    useEditorStore.setState({ selectedEntityId: oldCamera.id() });

    // Fire the listener directly — this is what worldRegistry would do on swap
    listener!(newWorld, oldWorld);

    expect(useEditorStore.getState().selectedEntityId).toBe(newCamera.id());
    vi.doUnmock('../../src/runtime/ecs/world');
  });
});
