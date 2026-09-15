/** The editor store's entity pointers follow their entity inside a world (#1221, #1222 phase 2).
 *
 *  `selectedEntityIds`/`selectedEntityId` and `animatorRootEntityId`/`directorRootEntityId` are bare
 *  koota ids. koota recycles an index LIFO, so destroying the selected entity and spawning anything
 *  used to leave the NEWCOMER selected (gizmo, Inspector) or bound to the Animation panel. Each case
 *  stages that on a reclaimed index and asserts the precondition, and names the mutation that must
 *  turn it red:
 *  - a newcomer on the index is never selected/bound — drop the SYNCHRONOUS structure listener in
 *    `registerEditorRefLiveness` (the check between the destroy and the spawn goes red);
 *  - a replacement carrying the guid is followed — make `resolveHeld` return null instead of parking;
 *  - a pointer that did not move writes nothing — drop the `!selectionMoved && !rootsMoved` return;
 *  - a store write from elsewhere forgets a parked pointer — keep the parked entries in
 *    `captureSelection` instead of rebuilding from the new ids;
 *  - the roots are followed at all — drop the `rootsMoved` assignment;
 *  - the roots are re-held on a world swap — drop the `swap` listener (close-out review 1);
 *  - a swap out and back does not unbind them — re-take inside the swap listener instead of a tick later;
 *  - the frame-later pass follows a guid written without `indexEntityGuid` — pass `rescan: false`
 *    from the coalesced listener (close-out review 3);
 *  - selection undo does not fall back to a guid ref's recycled raw id — restore `?? ref.rawId`. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../packages/modoki/src/runtime/harness/createTestWorld';
import { Transform } from '../../packages/modoki/src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../packages/modoki/src/runtime/core/traits/EntityAttributes';
import { createWorld } from 'koota';
import { destroyEntity, indexEntityGuid, setCurrentWorld, spawnEntity } from '../../packages/modoki/src/runtime/core/ecs/world';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { undo, clearHistory } from '../../packages/modoki/src/editor/undo/undoManager';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import {
  registerEditorRefLiveness, unregisterEditorRefLiveness, reconcileEditorRefs,
} from '../../packages/modoki/src/editor/store/editorRefLiveness';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const G = 'e1221000-0000-4000-8000-000000000001';

let tw: TestWorld | undefined;
beforeEach(() => {
  useEditorStore.setState({ selectedEntityId: null, selectedEntityIds: [], animatorRootEntityId: null, directorRootEntityId: null });
  tw = createTestWorld({});
  registerEditorRefLiveness();
});
afterEach(() => {
  unregisterEditorRefLiveness();
  useEditorStore.setState({ selectedEntityId: null, selectedEntityIds: [], animatorRootEntityId: null, directorRootEntityId: null });
  tw?.dispose(); tw = undefined;
});

const sel = () => ({ ids: useEditorStore.getState().selectedEntityIds, primary: useEditorStore.getState().selectedEntityId });

describe('selection follows its entity, not its index (#1221)', () => {
  it('a newcomer on the destroyed selection\'s index is not selected — and never was, even for a moment', () => {
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    useEditorStore.getState().selectEntity(a.id());
    destroyEntity(a);
    expect(sel()).toEqual({ ids: [], primary: null }); // cleared BEFORE any spawn can take the index
    const c = tw!.spawn(Transform(), EntityAttributes({ name: 'C' }));
    expect(c.id()).toBe(a.id()); // precondition: the index really was reclaimed
    reconcileEditorRefs(); // the frame-later pass must not select it either
    expect(sel()).toEqual({ ids: [], primary: null });
  });

  it('a guid-less entity (a resource singleton) is dropped, not parked', () => {
    const t = tw!.spawn(Transform());
    useEditorStore.getState().selectEntity(t.id());
    destroyEntity(t);
    const c = tw!.spawn(Transform());
    expect(c.id()).toBe(t.id());
    reconcileEditorRefs();
    expect(sel().ids).toEqual([]);
  });

  it('a replacement carrying the guid is followed, once its guid is written (a seeded respawn)', () => {
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'Preview', guid: G }));
    useEditorStore.getState().selectEntity(a.id());
    destroyEntity(a);
    // spawnPrefabInstance's shape: spawn first, write the seeded guid after.
    const b = tw!.spawn(Transform({ x: 5 }), EntityAttributes({ name: 'Preview' }));
    expect(sel().ids).toEqual([]); // parked: hidden, and not the newcomer by index
    b.set(EntityAttributes, { ...(b.get(EntityAttributes) as object), guid: G });
    indexEntityGuid(b);
    reconcileEditorRefs(); // the coalesced pass
    expect(sel()).toEqual({ ids: [b.id()], primary: b.id() });
  });

  it('a multi-selection keeps its survivors and moves the primary onto one', () => {
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const b = tw!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    const c = tw!.spawn(Transform(), EntityAttributes({ name: 'C' }));
    useEditorStore.getState().setSelectedEntities([a.id(), b.id(), c.id()], a.id());
    destroyEntity(a);
    expect(sel()).toEqual({ ids: [b.id(), c.id()], primary: c.id() });
  });

  it('a selection whose entity is untouched is not rewritten by unrelated spawns and destroys', () => {
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'A' }));
    useEditorStore.getState().selectEntity(a.id());
    const before = useEditorStore.getState().selectedEntityIds;
    let notified = 0;
    const unsub = useEditorStore.subscribe(() => { notified++; });
    try {
      const other = tw!.spawn(Transform(), EntityAttributes({ name: 'Other' }));
      destroyEntity(other);
      tw!.spawn(Transform(), EntityAttributes({ name: 'Another' }));
      reconcileEditorRefs();
    } finally { unsub(); }
    expect(useEditorStore.getState().selectedEntityIds).toBe(before);
    expect(notified).toBe(0); // no store write at all: every subscriber would re-render on one
  });

  it('a selection made elsewhere after the park forgets the parked entity', () => {
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'Preview', guid: G }));
    const x = tw!.spawn(Transform(), EntityAttributes({ name: 'X' }));
    useEditorStore.getState().selectEntity(a.id());
    destroyEntity(a); // parked
    useEditorStore.getState().selectEntity(x.id()); // the user moved on
    tw!.spawn(Transform(), EntityAttributes({ name: 'Preview', guid: G }));
    reconcileEditorRefs();
    expect(sel()).toEqual({ ids: [x.id()], primary: x.id() });
  });
});

describe('the Animator and Director roots follow their entity too (#1221)', () => {
  it('a destroyed root unbinds instead of binding the newcomer, and follows a guid replacement', () => {
    const anim = tw!.spawn(Transform(), EntityAttributes({ name: 'Rig', guid: G }));
    const dir = tw!.spawn(Transform(), EntityAttributes({ name: 'Director' }));
    useEditorStore.setState({ animatorRootEntityId: anim.id(), directorRootEntityId: dir.id() });
    destroyEntity(dir);
    const squatter = tw!.spawn(Transform(), EntityAttributes({ name: 'Squatter' }));
    expect(squatter.id()).toBe(dir.id());
    expect(useEditorStore.getState().directorRootEntityId).toBeNull();
    expect(useEditorStore.getState().animatorRootEntityId).toBe(anim.id());

    destroyEntity(anim);
    expect(useEditorStore.getState().animatorRootEntityId).toBeNull();
    const rig2 = tw!.spawn(Transform(), EntityAttributes({ name: 'Rig', guid: G }));
    reconcileEditorRefs();
    expect(useEditorStore.getState().animatorRootEntityId).toBe(rig2.id());
  });
});

describe('close-out review cases (#1221)', () => {
  it('a root held before a world swap is re-held in the new world, even when its store value does not change', async () => {
    const w1 = tw!.world;
    tw!.spawn(Transform(), EntityAttributes({ name: 'Old director' }));
    const oldRoot = tw!.spawn(Transform(), EntityAttributes({ name: 'Old rig' }));
    useEditorStore.setState({ animatorRootEntityId: oldRoot.id(), directorRootEntityId: oldRoot.id() });
    const w2 = createWorld();
    try {
      // SceneManager's order: the incoming scene is spawned into the staging world, THEN swapped in.
      let root = spawnEntity(w2, Transform(), EntityAttributes({ name: 'New rig' }));
      for (let i = 0; i < 16 && root.id() < oldRoot.id(); i++) root = spawnEntity(w2, Transform(), EntityAttributes({ name: 'New rig' }));
      expect(root.id()).toBe(oldRoot.id()); // precondition: the panels' ids are still "right" by number
      setCurrentWorld(w2); // a Stop / scene load: the same numbers now name other entities
      useEditorStore.getState().setDirectorRoot(root.id()); // the Timeline re-resolve: same value, no change
      await new Promise((r) => setTimeout(r, 0)); // the re-take runs a tick after the swap
      destroyEntity(root, w2);
      const squatter = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Squatter' }));
      expect(squatter.id()).toBe(root.id());
      expect(useEditorStore.getState().directorRootEntityId).toBeNull();
      expect(useEditorStore.getState().animatorRootEntityId).toBeNull();
    } finally {
      setCurrentWorld(w1);
      w2.destroy();
    }
  });

  it('the frame-later pass follows a guid written without indexEntityGuid (the prefab rebuild shape)', () => {
    const G2 = 'e1221000-0000-4000-8000-000000000002';
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'Instance', guid: G2 }));
    useEditorStore.getState().selectEntity(a.id());
    destroyEntity(a);
    const b = tw!.spawn(Transform(), EntityAttributes({ name: 'Instance' }));
    b.set(EntityAttributes, { ...(b.get(EntityAttributes) as object), guid: G2 }); // no indexEntityGuid
    reconcileEditorRefs(undefined, { rescan: true }); // what the coalesced listener runs
    expect(sel()).toEqual({ ids: [b.id()], primary: b.id() });
  });

  it('undoing a selection never selects the entity that took a destroyed selection\'s index', async () => {
    setRunMode('stopped');
    clearHistory();
    const G3 = 'e1221000-0000-4000-8000-000000000003';
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'A', guid: G3 }));
    const b = tw!.spawn(Transform(), EntityAttributes({ name: 'B' }));
    useEditorStore.getState().selectEntity(a.id());
    useEditorStore.getState().selectEntity(b.id());
    unregisterEditorRefLiveness(); // isolate the undo path: nothing but resolveSnap decides this
    destroyEntity(a);
    const c = tw!.spawn(Transform(), EntityAttributes({ name: 'C' }));
    expect(c.id()).toBe(a.id());
    await undo(); // back to "A selected" — A is gone
    expect(useEditorStore.getState().selectedEntityIds).not.toContain(c.id());
    clearHistory();
  });

  it('a swap out to a populated world and back (stepSimulation\'s shape) leaves the roots bound', async () => {
    const w1 = tw!.world;
    for (let i = 0; i < 4; i++) tw!.spawn(Transform(), EntityAttributes({ name: `n${i}` }));
    const rig = tw!.spawn(Transform(), EntityAttributes({ name: 'Rig' }));
    useEditorStore.setState({ animatorRootEntityId: rig.id() });
    const w2 = createWorld();
    try {
      let there = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Other' }));
      for (let i = 0; i < 16 && there.id() < rig.id(); i++) there = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Other' }));
      expect(there.id()).toBe(rig.id()); // precondition: the transient world has an entity at that number
      setCurrentWorld(w2);
      destroyEntity(there, w2);
      setCurrentWorld(w1);
      await new Promise((r) => setTimeout(r, 0));
      expect(useEditorStore.getState().animatorRootEntityId).toBe(rig.id());
    } finally {
      setCurrentWorld(w1);
      w2.destroy();
    }
  });

  it('undo never selects the newcomer on a destroyed RUNTIME-guid entity\'s index either', async () => {
    setRunMode('stopped');
    clearHistory();
    const p = tw!.spawn(Transform(), EntityAttributes({ name: 'Spawned' })); // runtime guid: the capture keeps none
    const q = tw!.spawn(Transform(), EntityAttributes({ name: 'Q' }));
    useEditorStore.getState().selectEntity(p.id());
    useEditorStore.getState().selectEntity(q.id());
    unregisterEditorRefLiveness();
    destroyEntity(p);
    const c = tw!.spawn(Transform(), EntityAttributes({ name: 'Newcomer' }));
    expect(c.id()).toBe(p.id());
    await undo();
    expect(useEditorStore.getState().selectedEntityIds).not.toContain(c.id());
    clearHistory();
  });

  it('undo keeps the primary inside the restored set when the old primary is gone', async () => {
    setRunMode('stopped');
    clearHistory();
    const GA = 'e1221000-0000-4000-8000-00000000000a';
    const GB = 'e1221000-0000-4000-8000-00000000000b';
    const a = tw!.spawn(Transform(), EntityAttributes({ name: 'A', guid: GA }));
    const b = tw!.spawn(Transform(), EntityAttributes({ name: 'B', guid: GB }));
    const x = tw!.spawn(Transform(), EntityAttributes({ name: 'X' }));
    useEditorStore.getState().setSelectedEntities([a.id(), b.id()], a.id());
    useEditorStore.getState().selectEntity(x.id());
    unregisterEditorRefLiveness();
    destroyEntity(a);
    await undo();
    expect(sel()).toEqual({ ids: [b.id()], primary: b.id() });
    clearHistory();
  });

  it('undo after a world swap does not re-select a newcomer on a deleted durable-guid entity\'s old number', async () => {
    setRunMode('stopped');
    clearHistory();
    const w1 = tw!.world;
    const GE = 'e1221000-0000-4000-8000-00000000000e';
    const e = tw!.spawn(Transform(), EntityAttributes({ name: 'E', guid: GE }));
    const x = tw!.spawn(Transform(), EntityAttributes({ name: 'X' }));
    useEditorStore.getState().selectEntity(e.id());
    useEditorStore.getState().selectEntity(x.id());
    unregisterEditorRefLiveness();
    const w2 = createWorld();
    try {
      let other = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Other' }));
      for (let i = 0; i < 16 && other.id() < e.id(); i++) other = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Other' }));
      expect(other.id()).toBe(e.id()); // precondition: the reloaded world has a stranger at E's number
      setCurrentWorld(w2); // a same-scene reload without E; the undo history survives it
      await undo();
      expect(useEditorStore.getState().selectedEntityIds).not.toContain(other.id());
    } finally {
      setCurrentWorld(w1);
      w2.destroy();
      clearHistory();
    }
  });

  it('a park made in the new world before the deferred re-take survives it and follows the respawn', async () => {
    const w1 = tw!.world;
    const rig = tw!.spawn(Transform(), EntityAttributes({ name: 'Rig' }));
    useEditorStore.setState({ animatorRootEntityId: rig.id() }); // a root held in w1 keeps the re-take armed
    const w2 = createWorld();
    try {
      const GP = 'e1221000-0000-4000-8000-00000000000f';
      const sel2 = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Preview', guid: GP }));
      setCurrentWorld(w2);
      useEditorStore.getState().selectEntity(sel2.id()); // captured in w2
      destroyEntity(sel2, w2); // parked, inside the tick
      await new Promise((r) => setTimeout(r, 0)); // the re-take runs
      const back = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Preview', guid: GP }));
      reconcileEditorRefs(w2, { rescan: true });
      expect(useEditorStore.getState().selectedEntityIds).toEqual([back.id()]);
    } finally {
      setCurrentWorld(w1);
      w2.destroy();
    }
  });

  it('a root whose id named nothing before the swap is held after it', async () => {
    const w1 = tw!.world;
    useEditorStore.setState({ directorRootEntityId: 7 }); // nothing registered at 7 in w1
    const w2 = createWorld();
    try {
      let at7 = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Director' }));
      for (let i = 0; i < 16 && at7.id() < 7; i++) at7 = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Director' }));
      expect(at7.id()).toBe(7);
      setCurrentWorld(w2);
      await new Promise((r) => setTimeout(r, 0));
      destroyEntity(at7, w2);
      const squatter = spawnEntity(w2, Transform(), EntityAttributes({ name: 'Squatter' }));
      expect(squatter.id()).toBe(7);
      expect(useEditorStore.getState().directorRootEntityId).toBeNull();
    } finally {
      setCurrentWorld(w1);
      w2.destroy();
    }
  });
});
