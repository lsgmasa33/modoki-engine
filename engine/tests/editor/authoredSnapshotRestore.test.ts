/** #1547 — the ONE restore both editor envelopes use (`authoredSnapshot.ts`) puts back everything
 *  the reload does not rebuild.
 *
 *  `sceneManager.loadScene(key, { preloaded })` rebuilds the PRIMARY from the snapshot but CARRIES kept
 *  BASE scenes across from the live, posed world. Play/Stop replayed the bases (A5); the preview session
 *  replayed nothing. So the reload is stubbed in most of these — what is under test is the replay that
 *  has to follow it — and the live world is posed the way a preview or a play session would leave it.
 *
 *  A `Persistent` root is the exception, driven through the REAL reload (#1863): outside Play it is not
 *  carried at all, so the snapshot's own copy comes back — once. */

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
  captureAuthoredSnapshot, restoreAuthoredSnapshot, type AuthoredSnapshot,
} from '../../packages/modoki/src/editor/scene/authoredSnapshot';
import { getAllEntities } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { setRunMode } from '../../packages/modoki/src/runtime/core/playState';

registerAllTraits();

const HUD = 'aaaaaaaa-0000-4000-8000-000000001547';
const HUD_CHILD = 'aaaaaaaa-0000-4000-8000-000000011547';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000021547';
const CAM = 'bbbbbbbb-0000-4000-8000-000000001547';

afterEach(() => { vi.restoreAllMocks(); });

const xOf = (e: Entity) => (e.get(Transform) as { x: number }).x;
/** Every live entity's name, grouped by guid — a duplicate shows as two names under one guid. */
const namesByGuid = () => {
  const out: Record<string, string[]> = {};
  for (const e of getAllEntities()) if (e.guid && !e.isResource) (out[e.guid] ??= []).push(e.name);
  return out;
};
const setX = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x } as never);

describe('restoreAuthoredSnapshot replays what the reload carries (#1547)', () => {
  // #1863: the reload used to CARRY the live Persistent root and ALSO spawn the snapshot's own copy — a filter meant to drop
  // that copy never matched a current-format root — so every Stop added one more (measured: HUD, Other, HUD, HUD after two).
  // Unity destroys DontDestroyOnLoad objects on leaving Play mode; SceneManager now carries a Persistent root only in Play.
  for (const mode of ['stopped', 'preview'] as const) {
    it(`restored in "${mode}" (${mode === 'stopped' ? 'Stop' : 'a preview Exit'}), a Persistent root comes back ONCE, with its authored values`, async () => {
      const g = createTestWorld({});
      try {
        const hud = g.spawn(EntityAttributes({ name: 'HUD', guid: HUD } as never), Transform({ x: 0 } as never), Persistent());
        g.spawn(EntityAttributes({ name: 'HUD child', guid: HUD_CHILD, parentId: hud.id() } as never), Transform({ x: 0 } as never));
        g.spawn(EntityAttributes({ name: 'Other', guid: OTHER } as never), Transform({ x: 0 } as never));
        const snap = { ...(await captureAuthoredSnapshot()), key: '/restore1863.json' };
        setX(hud, 5);                                                      // posed / played
        setRunMode(mode);
        await restoreAuthoredSnapshot(snap);
        await restoreAuthoredSnapshot(snap);                               // a second Stop
        // MUTATION TARGET: carry Persistent roots whatever the mode (`carryPersistent` always true) and these are
        // HUD ×3 and HUD child ×3 — the carried subtrees beside each reload's own copy.
        expect(namesByGuid()).toEqual({ [HUD]: ['HUD'], [HUD_CHILD]: ['HUD child'], [OTHER]: ['Other'] });
        expect(xOf(findEntityByGuid(HUD)!)).toBe(0);                       // the authored value, from the snapshot's copy
      } finally { setRunMode('playing'); g.dispose(); }
    });
  }

  it('in Play, a scene reload carries the Persistent root AND spawns its file copy — the game guards it, as in Unity', async () => {
    const g = createTestWorld({});
    try {
      g.spawn(EntityAttributes({ name: 'HUD', guid: HUD } as never), Transform({ x: 0 } as never), Persistent());
      const snap = { ...(await captureAuthoredSnapshot()), key: '/restore1863.json' };
      setRunMode('playing');
      await sceneManager.loadScene(snap.key, { preloaded: snap.primary as never });
      // The accept side of the gate: DontDestroyOnLoad semantics, no engine dedupe (docs/scene-loading.md § Persistent).
      expect(namesByGuid()[HUD]).toEqual(['HUD', 'HUD']);
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

describe('restoreAuthoredSnapshot — EntityAttributes state, and a restore that fails (#1547/#1548 close-out review)', () => {
  it('isActive on a carried base entity is restored; its structural fields are not', async () => {
    const g = createTestWorld({});
    try {
      const hud = g.spawn(EntityAttributes({ name: 'HUD', guid: HUD, isActive: true, sortOrder: 0 } as never), Transform({ x: 0 } as never));
      const base = { entities: [{ guid: HUD, traits: { EntityAttributes: { name: 'HUD', guid: HUD }, Transform: {} } }] };
      const snap: AuthoredSnapshot = { primary: { entities: [] } as never, key: '/l.json', bases: new Map([['b', base as never]]) };
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

  it('a scene v20 entry is replayed from its "/" row: the root\'s posed fields return to what the row states (#2001 S6)', async () => {
    const g = createTestWorld({});
    try {
      const btn = g.spawn(EntityAttributes({ name: 'Button', guid: HUD_CHILD, isActive: false } as never), Transform({ x: 3, y: 2 } as never));
      // What a v20 save writes for a root: its placement on the entry's own traits, its records on the "/" row.
      const entry = {
        guid: HUD_CHILD, prefab: '/assets/prefabs/button.prefab.json', traits: { EntityAttributes: { sortOrder: 0 } },
        members: { '/': { traits: { EntityAttributes: { name: 'Button', isActive: false }, Transform: { x: 3 } } } },
      };
      const snap: AuthoredSnapshot = { primary: { entities: [] } as never, key: '/l.json', bases: new Map([['b', { entities: [entry] } as never]]) };
      vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({} as never);
      // Play (or a preview) posed it: moved, renamed by nothing, shown.
      setX(btn, 40);
      btn.set(EntityAttributes, { ...(btn.get(EntityAttributes) as object), isActive: true } as never);
      await restoreAuthoredSnapshot(snap);
      // MUTATION TARGET: drop the `rootRow` branch — the row is not read, and x stays 40 and isActive true.
      expect(xOf(btn)).toBe(3);
      expect((btn.get(EntityAttributes) as { isActive: boolean }).isActive).toBe(false);
      // A field the row does not state comes from the template, which this pass cannot see: left as it is.
      expect((btn.get(Transform) as { y: number }).y).toBe(2);
    } finally { g.dispose(); }
  });
});
