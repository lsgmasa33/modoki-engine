/** sampleClip — relative-path target resolution + writing trait fields. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld as _createWorld, trait, type World } from 'koota';

// koota caps live worlds at 16; these tests create a world per case. Track + destroy
// them after each test so the id pool never overflows as cases accumulate.
const _worlds: World[] = [];
function createWorld(): World { const w = _createWorld(); _worlds.push(w); return w; }
afterEach(() => { for (const w of _worlds.splice(0)) w.destroy(); });
import { Transform } from '../../src/runtime/traits/Transform';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { Tint } from '../../src/runtime/traits/Tint';
import { MaterialInstance } from '../../src/runtime/traits/MaterialInstance';
import { registerTrait, getAllTraits } from '../../src/runtime/ecs/traitRegistry';
import { markUIDirty } from '../../src/runtime/ui/uiTreeStore';

// Spy on markUIDirty so we can assert the UI tree is dirtied ONLY when a UI trait
// is animated (the rest of uiTreeStore is preserved via importOriginal).
vi.mock('../../src/runtime/ui/uiTreeStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/ui/uiTreeStore')>();
  return { ...actual, markUIDirty: vi.fn() };
});

/** A throwaway trait carrying an enum field, to exercise enum index→string decode. */
const Widget = trait({ mode: 'fitW' });
const WIDGET_MODES = ['fitW', 'fitH', 'fill'];
/** A throwaway UI-category trait, to exercise the UI-dirty repaint path. */
const Panel = trait({ w: 0 });
/** A throwaway tag trait (no fields), to exercise the tag-category skip. */
const TagOnly = trait();
import { applyClipAtTime, applyClipAtTimeBlended, advanceClipTime, buildEntityIndex, resolveTrackTarget } from '../../src/runtime/animation/sampleClip';
import type { AnimationClipDef, Keyframe } from '../../src/runtime/animation/types';

const key = (t: number, v: number): Keyframe => ({ t, v, inTangent: 0, outTangent: 0 });

function ensureRegistered() {
  const names = new Set(getAllTraits().map((m) => m.name));
  if (!names.has('Transform'))
    registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, rx: { type: 'number' } } });
  if (!names.has('EntityAttributes'))
    registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' } } });
  if (!names.has('Tint'))
    registerTrait({ name: 'Tint', trait: Tint, category: 'component', fields: { color: { type: 'color' } } });
  if (!names.has('Widget'))
    registerTrait({ name: 'Widget', trait: Widget, category: 'component', fields: { mode: { type: 'enum', options: WIDGET_MODES } } });
  if (!names.has('MaterialInstance'))
    registerTrait({ name: 'MaterialInstance', trait: MaterialInstance, category: 'component', fields: { overrides: { type: 'materialOverrides' } } });
  if (!names.has('Panel'))
    registerTrait({ name: 'Panel', trait: Panel, category: 'component', componentCategory: 'UI', fields: { w: { type: 'number' } } });
  if (!names.has('TagOnly'))
    registerTrait({ name: 'TagOnly', trait: TagOnly, category: 'tag', fields: {} });
}

function clip(tracks: AnimationClipDef['tracks']): AnimationClipDef {
  return { id: '', name: 'c', duration: 2, frameRate: 60, loop: true, tracks };
}

describe('applyClipAtTime', () => {
  beforeEach(ensureRegistered);

  it('animates the root entity (empty path) and a nested descendant', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const body = world.spawn(Transform({ rx: 0 }), EntityAttributes({ name: 'body', parentId: root.id() }));
    const hand = world.spawn(Transform({ y: 0 }), EntityAttributes({ name: 'hand', parentId: body.id() }));

    const c = clip([
      { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 0), key(1, 100)] },
      { path: 'body', trait: 'Transform', field: 'rx', type: 'number', keys: [key(0, 0), key(1, 10)] },
      { path: 'body/hand', trait: 'Transform', field: 'y', type: 'number', keys: [key(0, 0), key(1, 50)] },
    ]);

    const applied = applyClipAtTime(world, root.id(), c, 1);
    expect(applied).toBe(3);
    expect(root.get(Transform)!.x).toBeCloseTo(100);
    expect(body.get(Transform)!.rx).toBeCloseTo(10);
    expect(hand.get(Transform)!.y).toBeCloseTo(50);
  });

  it('applies multiple fields of one trait on the same entity in a single write', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0, y: 0, rx: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([
      { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 0), key(1, 100)] },
      { path: '', trait: 'Transform', field: 'y', type: 'number', keys: [key(0, 0), key(1, 50)] },
      { path: '', trait: 'Transform', field: 'rx', type: 'number', keys: [key(0, 0), key(1, 10)] },
    ]);
    const applied = applyClipAtTime(world, root.id(), c, 1);
    expect(applied).toBe(3);
    // Batched write must not clobber sibling fields — all three land together.
    const tr = root.get(Transform)!;
    expect(tr.x).toBeCloseTo(100);
    expect(tr.y).toBeCloseTo(50);
    expect(tr.rx).toBeCloseTo(10);
  });

  it('animates a NESTED field (MaterialInstance override value) preserving the rest of the array', () => {
    const world = createWorld();
    const root = world.spawn(
      MaterialInstance({ overrides: [
        { target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0 } },
        { target: 'glow', kind: 'uniform', source: { type: 'time' } },
      ] }),
      EntityAttributes({ name: 'root', parentId: 0 }),
    );
    const c = clip([{ path: '', trait: 'MaterialInstance', field: 'overrides.0.source.value', type: 'number', keys: [key(0, 0), key(1, 1)] }]);

    expect(applyClipAtTime(world, root.id(), c, 0.5)).toBe(1);
    const mi = root.get(MaterialInstance)! as unknown as { overrides: { target: string; kind: string; source: { type: string; value?: number } }[] };
    expect(mi.overrides[0].source.value).toBeCloseTo(0.5, 6); // driven
    // The rest of override[0] and the whole override[1] are untouched.
    expect(mi.overrides[0].target).toBe('opacity');
    expect(mi.overrides[0].kind).toBe('prop');
    expect(mi.overrides[0].source.type).toBe('constant');
    expect(mi.overrides[1]).toEqual({ target: 'glow', kind: 'uniform', source: { type: 'time' } });
  });

  it('animates TWO nested fields of one trait in a single write (both land, siblings intact)', () => {
    const world = createWorld();
    const root = world.spawn(
      MaterialInstance({ overrides: [
        { target: 'opacity', kind: 'prop', source: { type: 'constant', value: 0 } },
        { target: 'roughness', kind: 'prop', source: { type: 'constant', value: 0 } },
      ] }),
      EntityAttributes({ name: 'root', parentId: 0 }),
    );
    const c = clip([
      { path: '', trait: 'MaterialInstance', field: 'overrides.0.source.value', type: 'number', keys: [key(0, 0), key(1, 1)] },
      { path: '', trait: 'MaterialInstance', field: 'overrides.1.source.value', type: 'number', keys: [key(0, 0), key(1, 0.5)] },
    ]);
    expect(applyClipAtTime(world, root.id(), c, 1)).toBe(2);
    const mi = root.get(MaterialInstance)! as unknown as { overrides: { target: string; kind: string; source: { type: string; value?: number } }[] };
    // Both dotted writes fold into ONE trait mutation — the second must not clobber the first.
    expect(mi.overrides[0].source.value).toBeCloseTo(1, 6);
    expect(mi.overrides[1].source.value).toBeCloseTo(0.5, 6);
    expect(mi.overrides[0].target).toBe('opacity');
    expect(mi.overrides[1].target).toBe('roughness');
  });

  it('reuses a prebuilt entity index when one is passed', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 0), key(1, 100)] }]);
    // Build the index once (as animationSystem does) and pass it through.
    const index = buildEntityIndex(world);
    expect(applyClipAtTime(world, root.id(), c, 1, index)).toBe(1);
    expect(root.get(Transform)!.x).toBeCloseTo(100);
  });

  it('ignores missing paths and missing traits without throwing', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([
      { path: 'nope', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 5)] },
      { path: '', trait: 'Tint', field: 'color', type: 'color', keys: [key(0, 1)] }, // root has no Tint
    ]);
    expect(() => applyClipAtTime(world, root.id(), c, 0)).not.toThrow();
    expect(applyClipAtTime(world, root.id(), c, 0)).toBe(0);
    expect(root.get(Transform)!.x).toBe(0);
  });

  it('coerces color and boolean values', () => {
    const world = createWorld();
    const root = world.spawn(Tint({ color: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([
      { path: '', trait: 'Tint', field: 'color', type: 'color', keys: [key(0, 0x000000), key(1, 0xffffff)] },
    ]);
    applyClipAtTime(world, root.id(), c, 0.5);
    expect(root.get(Tint)!.color).toBe(0x808080);
  });

  it('decodes an enum index back to its option string (stepped)', () => {
    const world = createWorld();
    const root = world.spawn(Widget({ mode: 'fitW' }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([
      { path: '', trait: 'Widget', field: 'mode', type: 'enum', keys: [key(0, 0), key(1, 2)] },
    ]);
    applyClipAtTime(world, root.id(), c, 0);
    expect(root.get(Widget)!.mode).toBe('fitW');
    applyClipAtTime(world, root.id(), c, 0.4); // stepped → still index 0 before the next key
    expect(root.get(Widget)!.mode).toBe('fitW');
    applyClipAtTime(world, root.id(), c, 1);
    expect(root.get(Widget)!.mode).toBe('fill'); // index 2
  });

  it('skips an enum track whose field has no static option list (dynamic enum)', () => {
    const DynWidget = trait({ mode: 'a' });
    const names = new Set(getAllTraits().map((m) => m.name));
    if (!names.has('DynWidget'))
      registerTrait({ name: 'DynWidget', trait: DynWidget, category: 'component', fields: { mode: { type: 'enum' } } });
    const world = createWorld();
    const root = world.spawn(DynWidget({ mode: 'a' }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([{ path: '', trait: 'DynWidget', field: 'mode', type: 'enum', keys: [key(0, 1)] }]);
    // No options ⇒ can't decode the index to a string ⇒ skip, leaving the field intact.
    expect(applyClipAtTime(world, root.id(), c, 0)).toBe(0);
    expect(root.get(DynWidget)!.mode).toBe('a');
  });

  it('skips zero-key tracks and tag-category traits (neither counts as applied)', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), TagOnly, EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([
      { path: '', trait: 'Transform', field: 'x', type: 'number', keys: [] },          // zero keys → skipped
      { path: '', trait: 'TagOnly', field: 'flag', type: 'number', keys: [key(0, 1)] }, // tag category → skipped
    ]);
    // Both tracks are dropped: the zero-key track never resolves a target, the tag
    // track is rejected on `meta.category === 'tag'`. Applied count excludes both.
    expect(applyClipAtTime(world, root.id(), c, 0)).toBe(0);
    expect(root.get(Transform)!.x).toBe(0);
  });

  it('buildEntityIndex resolves duplicate child names last-writer-wins', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'dup', parentId: root.id() }));      // first 'dup'
    const second = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'dup', parentId: root.id() })); // last 'dup' wins
    const index = buildEntityIndex(world);
    // Two siblings share the name 'dup' → the childrenByParent bucket keeps the LAST id.
    expect(resolveTrackTarget(index, root.id(), 'dup')).toBe(second.id());
  });
});

describe('applyClipAtTime — UI dirty flag', () => {
  beforeEach(() => { ensureRegistered(); vi.mocked(markUIDirty).mockClear(); });

  it('dirties the UI tree when a UI-category trait is animated', () => {
    const world = createWorld();
    const root = world.spawn(Panel({ w: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([{ path: '', trait: 'Panel', field: 'w', type: 'number', keys: [key(0, 0), key(1, 100)] }]);
    applyClipAtTime(world, root.id(), c, 1);
    expect(root.get(Panel)!.w).toBeCloseTo(100);
    expect(markUIDirty).toHaveBeenCalledTimes(1);
  });

  it('does NOT dirty the UI tree when only a non-UI trait (Transform) is animated', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const c = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 0), key(1, 100)] }]);
    applyClipAtTime(world, root.id(), c, 1);
    expect(markUIDirty).not.toHaveBeenCalled();
  });
});

describe('applyClipAtTimeBlended (crossfade)', () => {
  beforeEach(ensureRegistered);
  const rad = (deg: number) => (deg * Math.PI) / 180;

  it('lerps a numeric field at the blend weight (midpoint at w=0.5)', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 0)] }]);
    const to = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 100)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.5);
    expect(root.get(Transform)!.x).toBeCloseTo(50);
  });

  it('w=0 is pure from, w=1 is pure to', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 20)] }]);
    const to = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 80)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0);
    expect(root.get(Transform)!.x).toBeCloseTo(20);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 1);
    expect(root.get(Transform)!.x).toBeCloseTo(80);
  });

  it('blends Transform rotation along the SHORTEST arc (±180° wraps, not through 0)', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ rx: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Transform', field: 'rx', type: 'number', keys: [key(0, rad(170))] }]);
    const to = clip([{ path: '', trait: 'Transform', field: 'rx', type: 'number', keys: [key(0, rad(-170))] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.5);
    // Short arc 170°→190°(=−170°) midpoint is 180° (π), NOT the long-way 0° a plain lerp gives.
    expect(root.get(Transform)!.rx).toBeCloseTo(Math.PI, 3);
  });

  it('blends a color field per-channel', () => {
    const world = createWorld();
    const root = world.spawn(Tint({ color: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Tint', field: 'color', type: 'color', keys: [key(0, 0xff0000)] }]);
    const to = clip([{ path: '', trait: 'Tint', field: 'color', type: 'color', keys: [key(0, 0x0000ff)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.5);
    expect(root.get(Tint)!.color).toBe(0x800080); // (128,0,128), not a packed-int average
  });

  it('snaps a stepped enum to the dominant side of the blend', () => {
    const world = createWorld();
    const root = world.spawn(Widget({ mode: 'fitW' }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Widget', field: 'mode', type: 'enum', keys: [key(0, 0)] }]);
    const to = clip([{ path: '', trait: 'Widget', field: 'mode', type: 'enum', keys: [key(0, 2)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.4);
    expect(root.get(Widget)!.mode).toBe('fitW'); // w<0.5 → from
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.6);
    expect(root.get(Widget)!.mode).toBe('fill'); // w≥0.5 → to
  });

  it('blends a NESTED-path (MaterialInstance override) track, preserving array structure', () => {
    const world = createWorld();
    const root = world.spawn(
      MaterialInstance({ overrides: [{ target: 'opacity', kind: 'uniform', source: { type: 'constant', value: 0 } }] }),
      EntityAttributes({ name: 'root', parentId: 0 }),
    );
    const from = clip([{ path: '', trait: 'MaterialInstance', field: 'overrides.0.source.value', type: 'number', keys: [key(0, 0)] }]);
    const to = clip([{ path: '', trait: 'MaterialInstance', field: 'overrides.0.source.value', type: 'number', keys: [key(0, 1)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.5);

    const mi = root.get(MaterialInstance)! as unknown as { overrides: { target: string; kind: string; source: { type: string; value?: number } }[] };
    expect(mi.overrides[0].source.value).toBeCloseTo(0.5, 6); // blended 0↔1 @ w=0.5
    // The crossfade path must fold the dotted field via setPath, not a flat spread:
    // the array structure + sibling fields survive intact...
    expect(mi.overrides[0].target).toBe('opacity');
    expect(mi.overrides[0].kind).toBe('uniform');
    expect(mi.overrides[0].source.type).toBe('constant');
    // ...and there is NO bogus flat key literally named the dotted path (the pre-fix bug).
    expect((root.get(MaterialInstance)! as Record<string, unknown>)['overrides.0.source.value']).toBeUndefined();
  });

  it('applies a field only ONE clip animates at full strength (no bind-pose fade)', () => {
    const world = createWorld();
    const root = world.spawn(Transform({ x: 0, y: 0 }), EntityAttributes({ name: 'root', parentId: 0 }));
    const from = clip([{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [key(0, 100)] }]);
    const to = clip([{ path: '', trait: 'Transform', field: 'y', type: 'number', keys: [key(0, 50)] }]);
    applyClipAtTimeBlended(world, root.id(), { clip: from, time: 0 }, { clip: to, time: 0 }, 0.5);
    const tr = root.get(Transform)!;
    expect(tr.x).toBeCloseTo(100); // from-only → full
    expect(tr.y).toBeCloseTo(50);  // to-only → full
  });
});

describe('advanceClipTime', () => {
  it('loops within [0, duration)', () => {
    expect(advanceClipTime(1.9, 0.2, 2, true)).toBeCloseTo(0.1);
    expect(advanceClipTime(0, -0.1, 2, true)).toBeCloseTo(1.9);
  });
  it('clamps when not looping', () => {
    expect(advanceClipTime(1.9, 0.5, 2, false)).toBe(2);
    expect(advanceClipTime(0, -0.5, 2, false)).toBe(0);
  });

  // Missing Test #5 — overshoot: dt larger than the clip duration (a long frame hitch
  // or a fast timeScale) must not skip past the loop point or leave time out of range.
  it('wraps a multi-duration overshoot when looping (dt > duration)', () => {
    expect(advanceClipTime(0, 5, 2, true)).toBeCloseTo(1); // 5 % 2 = 1
    expect(advanceClipTime(0.5, 4, 2, true)).toBeCloseTo(0.5); // 4.5 % 2 = 0.5
  });
  it('wraps a large negative overshoot into range when looping', () => {
    expect(advanceClipTime(0, -5, 2, true)).toBeCloseTo(1); // -5 → +range → 1
    const r = advanceClipTime(0, -5, 2, true);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(2);
  });
  it('clamps a huge overshoot to the endpoints when not looping', () => {
    expect(advanceClipTime(0, 100, 2, false)).toBe(2);
    expect(advanceClipTime(2, -100, 2, false)).toBe(0);
  });
  it('returns 0 for a non-positive duration (avoids modulo-by-zero NaN)', () => {
    expect(advanceClipTime(1, 0.5, 0, true)).toBe(0);
    expect(advanceClipTime(1, 0.5, -3, false)).toBe(0);
  });
});
