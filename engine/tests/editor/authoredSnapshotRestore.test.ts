/** #1547 — the ONE restore both editor envelopes use (`authoredSnapshot.ts`) puts back everything
 *  the reload does not rebuild.
 *
 *  `sceneManager.loadScene(key, { preloaded })` rebuilds the PRIMARY from the snapshot but CARRIES two
 *  things across from the live, posed world: kept BASE scenes, and the primary's `Persistent` roots
 *  (`filterPersistentDuplicates` drops the snapshot's own authored copy of those). Play/Stop replayed
 *  the bases (A5); the preview session replayed nothing, and neither replayed Persistent roots. So the
 *  reload is stubbed here — what is under test is exactly the replay that has to follow it — and the
 *  live world is posed the way a preview or a play session would leave it. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Entity } from 'koota';
import { createTestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { EntityAttributes } from '../../packages/modoki/src/runtime/core/traits/EntityAttributes';
import { Transform } from '../../packages/modoki/src/runtime/core/traits/Transform';
import { Persistent } from '../../packages/modoki/src/runtime/traits/Persistent';
import { Time } from '../../packages/modoki/src/runtime/core/traits/Time';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import {
  captureAuthoredSnapshot, restoreAuthoredSnapshot, persistentSubtreeEntries, type AuthoredSnapshot,
} from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import type { SerializedEntity } from '../../packages/modoki/src/editor/scene/serialize';

registerAllTraits();

const HUD = 'aaaaaaaa-0000-4000-8000-000000001547';
const HUD_CHILD = 'aaaaaaaa-0000-4000-8000-000000011547';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000021547';
const CAM = 'bbbbbbbb-0000-4000-8000-000000001547';

afterEach(() => { vi.restoreAllMocks(); });

const xOf = (e: Entity) => (e.get(Transform) as { x: number }).x;
const setX = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x } as never);

describe('restoreAuthoredSnapshot replays what the reload carries (#1547)', () => {
  it('a Persistent root AND its child get their authored values back; a rebuilt entity is left to the reload', async () => {
    const g = createTestWorld({});
    try {
      const hud = g.spawn(EntityAttributes({ name: 'HUD', guid: HUD } as never), Transform({ x: 0 } as never), Persistent());
      const child = g.spawn(EntityAttributes({ name: 'HUD child', guid: HUD_CHILD, parentId: hud.id() } as never), Transform({ x: 0 } as never));
      const other = g.spawn(EntityAttributes({ name: 'Other', guid: OTHER } as never), Transform({ x: 0 } as never));
      const snap = await captureAuthoredSnapshot();                 // the authored world, as either envelope takes it
      const load = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never); // the carry is what we test
      setX(hud, 5); setX(child, 6); setX(other, 7);                 // posed / played
      await restoreAuthoredSnapshot(snap);
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0][1]).toEqual({ preloaded: snap.primary });
      // MUTATION TARGET: drop the Persistent replay from restoreAuthoredSnapshot and these stay 5 / 6 —
      // the carried live root outranks the snapshot's own copy, so the pose survived Exit and Stop.
      expect(xOf(hud)).toBe(0);
      expect(xOf(child)).toBe(0);
      // Not Persistent: the real reload rebuilds it from the snapshot, so the replay must not touch it.
      expect(xOf(other)).toBe(7);
    } finally { g.dispose(); }
  });

  it('every base in the snapshot is replayed onto the carried live entities, by guid', async () => {
    const g = createTestWorld({});
    try {
      const cam = g.spawn(EntityAttributes({ name: 'Camera', guid: CAM } as never), Transform({ x: 555, y: 9 } as never));
      // SPARSE, exactly as `serializeScene` writes it: the authored x=0 is the schema default, so it is
      // not in the file at all — only the non-default y=3 is.
      const base = { entities: [{ guid: CAM, traits: { EntityAttributes: { name: 'Camera', guid: CAM }, Transform: { y: 3 } } }] };
      const snap: AuthoredSnapshot = {
        primary: { entities: [] } as never, key: '/level1.json', bases: new Map([['base-guid', base as never]]),
      };
      const load = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
      await restoreAuthoredSnapshot(snap);
      expect(load.mock.calls[0][0]).toBe('/level1.json');
      // MUTATION TARGET: drop the base loop and the Camera keeps the preview's 555 — the reviewer's
      // measured repro, `{"Level1Thing":1,"Camera":555}`. Replay only the keys PRESENT (the pre-#1547
      // A5 loop) and it keeps 555 too: an authored default is absent from a sparse snapshot.
      expect(xOf(cam)).toBe(0);
      expect((cam.get(Transform) as { y: number }).y).toBe(3);
    } finally { g.dispose(); }
  });

  it('the default fill skips runtimeOnly fields — live runtime state is not reset by a revert', async () => {
    const g = createTestWorld({});
    try {
      const clock = g.spawn(EntityAttributes({ name: 'Clock', guid: CAM } as never), Time({ elapsed: 12, frame: 700 } as never));
      const base = { entities: [{ guid: CAM, traits: { EntityAttributes: { name: 'Clock', guid: CAM }, Time: {} } }] };
      const snap: AuthoredSnapshot = { primary: { entities: [] } as never, key: '/l.json', bases: new Map([['b', base as never]]) };
      vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
      await restoreAuthoredSnapshot(snap);
      // MUTATION TARGET: drop the `isRuntimeOnlyField` skip and the default fill zeroes these — Phase 7's
      // "Time keeps climbing across Stop" gate, broken by the very fix above.
      expect((clock.get(Time) as { elapsed: number; frame: number }).elapsed).toBe(12);
      expect((clock.get(Time) as { elapsed: number; frame: number }).frame).toBe(700);
    } finally { g.dispose(); }
  });
});

describe('persistentSubtreeEntries', () => {
  const e = (guid: string, parentId: string, persistent = false): SerializedEntity => ({
    guid, traits: { EntityAttributes: { guid, parentId }, ...(persistent ? { Persistent: true } : {}) },
  } as never);

  it('takes the whole subtree whatever the listing order, and nothing outside it', () => {
    const entries = [e('grandchild', 'child'), e('child', 'root'), e('root', '', true), e('stranger', ''), e('strangerKid', 'stranger')];
    // MUTATION TARGET: a single pass instead of the fixed point loses `grandchild`, listed before its parent.
    expect(persistentSubtreeEntries(entries).map((x) => x.guid).sort()).toEqual(['child', 'grandchild', 'root']);
    expect(persistentSubtreeEntries([e('a', ''), e('b', 'a')])).toEqual([]);
  });
});

describe('restoreAuthoredSnapshot — EntityAttributes state, and a restore that fails (#1547/#1548 close-out review)', () => {
  it('isActive on a carried Persistent root is restored; its structural fields are not', async () => {
    const g = createTestWorld({});
    try {
      const hud = g.spawn(EntityAttributes({ name: 'HUD', guid: HUD, isActive: true, sortOrder: 0 } as never), Transform({ x: 0 } as never), Persistent());
      const snap = await captureAuthoredSnapshot();
      vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
      // An activation track hid it; an editor reorder moved it (structure the replay does not own).
      hud.set(EntityAttributes, { ...(hud.get(EntityAttributes) as object), isActive: false, sortOrder: 9 } as never);
      await restoreAuthoredSnapshot(snap);
      const attrs = hud.get(EntityAttributes) as { isActive: boolean; sortOrder: number; guid: string };
      // MUTATION TARGET: skip EntityAttributes wholesale again and this stays false — the HUD hidden after ⏹ Exit.
      expect(attrs.isActive).toBe(true);
      // MUTATION TARGET: drop sortOrder from ENTITY_STRUCTURE_FIELDS and the default fill resets it to 0.
      expect(attrs.sortOrder).toBe(9);
      expect(attrs.guid).toBe(HUD);
    } finally { g.dispose(); }
  });

  it('a restore that THROWS leaves the world "not authored" until the next world swap', async () => {
    const { whyWorldNotAuthored } = await import('../../packages/modoki/src/editor/scene/authoredWorld');
    const { createWorld } = await import('koota');
    const { getCurrentWorld, setCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/worldRegistry');
    const { setRunMode } = await import('@modoki/engine/runtime');
    setRunMode('stopped');
    vi.spyOn(sceneManager, 'loadScene').mockRejectedValue(new Error('load failed'));
    await expect(restoreAuthoredSnapshot({ primary: { entities: [] } as never, key: '/s.json', bases: new Map() })).rejects.toThrow('load failed');
    // MUTATION TARGET: never set `_restoreFailed` and this is null — a save would write the posed world.
    expect(whyWorldNotAuthored()).toMatch(/restore FAILED/);
    const before = getCurrentWorld();
    const next = createWorld();
    try {
      setCurrentWorld(next);                              // a load from disk replaces the posed world
      expect(whyWorldNotAuthored()).toBeNull();
    } finally { setCurrentWorld(before); next.destroy(); }
  });
});

describe('a PREFAB entry is replayed only as far as it states (#1547 re-review)', () => {
  it('a prefab root with no root overrides keeps its name and isActive — no schema fill', async () => {
    const g = createTestWorld({});
    try {
      const btn = g.spawn(EntityAttributes({ name: 'Button', guid: HUD_CHILD, isActive: false } as never), Transform({ x: 3 } as never));
      // Exactly what serializeScene writes for such a root: PrefabInstance + a bare parentId, no overrides.
      const entry = { guid: HUD_CHILD, prefab: '/assets/prefabs/button.prefab.json', traits: { PrefabInstance: {}, EntityAttributes: { parentId: '' } } };
      const snap: AuthoredSnapshot = { primary: { entities: [] } as never, key: '/l.json', bases: new Map([['b', { entities: [entry] } as never]]) };
      vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
      await restoreAuthoredSnapshot(snap);
      const a = btn.get(EntityAttributes) as { name: string; isActive: boolean };
      // MUTATION TARGET: key `sparseAgainstSchema` on having overrides again and these read '' / true.
      expect(a.name).toBe('Button');
      expect(a.isActive).toBe(false);
      expect(xOf(btn)).toBe(3);
    } finally { g.dispose(); }
  });
});
