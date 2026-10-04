/** A reparent keeps the world pose, writing only what the move changes (#1848, docs/scene-loading.md § "A reparent keeps the world pose").
 *
 *  The study's probe table (#1848's study, folded into that section), as tests against the LIVE routes —
 *  `reparentEntity` (Hierarchy drop, reparent-entity, apply-scene-ops/set-traits parentId) and `moveEntityToScene`.
 *  The parent sits at {x:5, y:2}, a translation only, unless a test says otherwise. The file route's twins live in
 *  `engine/packages/modoki/tests/runtime/sceneMutate.test.ts` (#1847). */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setRunMode, getCurrentWorld, spawnEntity, Transform, EntityAttributes, readTraitData, getTraitByName,
  worldTransforms, PrefabInstance, Canvas2D, Frame2D, transformPropagationSystem, forgetCanvasView2D,
} from '@modoki/engine/runtime';
import { place } from '../../packages/modoki/src/editor/instance/instanceEdits';
import { overrideKeysOf } from '../../packages/modoki/src/editor/instance/instanceOverrideView';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { reparentEntity, planReparent, setActionCallback, pushAction, clearHistory, undo, redo } from '@modoki/engine/editor';
import { moveEntityToScene } from '../../packages/modoki/src/editor/undo/entityActions';

registerAllTraits();
setActionCallback(pushAction);

type Tf = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };
const tf = (id: number) => readTraitData(id, getTraitByName('Transform')!) as unknown as Tf;
const parentOf = (id: number) => readTraitData(id, getTraitByName('EntityAttributes')!)!.parentId as number;
const live = (id: number) => [...getCurrentWorld().entities].find((e) => e.id() === id)!;
const spawn = (name: string, t: Partial<Tf>, attrs: Record<string, unknown> = {}) =>
  spawnEntity(getCurrentWorld(), Transform(t), EntityAttributes({ name, guid: crypto.randomUUID(), ...attrs })).id();
/** Stamp the per-frame cache the way a propagation pass would have, at the poses `poses` gives — the STALE state the
 *  live routes used to read. */
const staleCache = (poses: Record<number, Partial<Tf>>) => {
  for (const [id, p] of Object.entries(poses)) worldTransforms.set(Number(id), { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, ...p });
};

beforeEach(() => {
  setRunMode('stopped'); // undo/redo refuse outside the authoring mode (#1148)
  clearHistory();
  worldTransforms.clear();
});

describe('reparentEntity writes only what the move changes (F1)', () => {
  // Mutation (every test in this block): in `reparentWrite`, write all nine fields of `next` instead of the groups
  // that change — the mirror moves to sx with rz:-π, the yaw is respelled, and the translation-only move writes R/S.
  it('an authored flip {sy:-1} stays sy:-1 under a translation-only parent', () => {
    const parent = spawn('P', { x: 5, y: 2 });
    const child = spawn('C', { x: 1, sy: -1 });
    expect(reparentEntity(child, parent)).toBe(true);
    expect(tf(child)).toEqual({ x: -4, y: -2, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: -1, sz: 1 });
  });

  it('a yaw past 90° keeps its spelling {ry:2.5}', () => {
    const parent = spawn('P', { x: 5, y: 2 });
    const child = spawn('C', { x: 1, ry: 2.5 });
    reparentEntity(child, parent);
    expect(tf(child)).toEqual({ x: -4, y: -2, z: 0, rx: 0, ry: 2.5, rz: 0, sx: 1, sy: 1, sz: 1 });
  });

  it('a real turn keeps the authored mirror and writes only the rotation', () => {
    // Parent turned π/2 about z: the child's world (1,0) is local (0,-1), and its linear part really changes. The
    // mirror stays on sy (a decomposition moves it to sx and adds π). Mutation: drop the `rotationKeepingScale`
    // branch — sy comes back 1.
    const parent = spawn('P', { rz: Math.PI / 2 });
    const child = spawn('C', { x: 1, sy: -1 });
    reparentEntity(child, parent);
    const t = tf(child);
    expect(t.x).toBeCloseTo(0, 9); expect(t.y).toBeCloseTo(-1, 9);
    expect([t.sx, t.sy, t.sz]).toEqual([1, -1, 1]);
    expect(t.rz).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe('reparentEntity reads the live hierarchy, not the per-frame cache (F2, F3)', () => {
  // Mutation (both): read `worldTransforms` for the parent and the mover again, as the deleted block did.
  it('a parent created since the last propagation pass is read at its real pose (F2)', () => {
    const parent = spawn('P', { x: 5, y: 2 }); // no pass has run: the cache holds no entry for it
    const child = spawn('C', { x: 1 });
    reparentEntity(child, parent);
    expect([tf(child).x, tf(child).y]).toEqual([-4, -2]);
  });

  it('a mover edited since the last pass keeps the edit (F3)', () => {
    const parent = spawn('P', { x: 5, y: 2 });
    const child = spawn('C', { x: 1 });
    staleCache({ [parent]: { x: 5, y: 2 }, [child]: { x: 1 } });
    live(child).set(Transform, { ...(live(child).get(Transform) as object), x: 3 }); // the same call moves it…
    reparentEntity(child, parent);                                                    // …then reparents it
    expect([tf(child).x, tf(child).y]).toEqual([-2, -2]);
  });

  it('a parent chain moved since the last pass is read at its real pose', () => {
    const grand = spawn('G', { x: 5 });
    const parent = spawn('P', { y: 2 }, { parentId: grand });
    const child = spawn('C', { x: 1 });
    staleCache({ [grand]: {}, [parent]: { y: 2 }, [child]: { x: 1 } }); // the grandparent's x:5 is newer than the pass
    reparentEntity(child, parent);
    expect([tf(child).x, tf(child).y]).toEqual([-4, -2]);
  });
});

describe('a parent with no Transform holds its children at the root, as propagation does', () => {
  // #1848 close-out review: the new parent's own ancestors were composed in, and the mover shifted by their offset (G at
  // x=10 put M at world -10). Mutation: drop `places` from reparentSuffixes' new chain — the first two go red.
  const bare = (name: string, parentId: number) =>
    spawnEntity(getCurrentWorld(), EntityAttributes({ name, guid: crypto.randomUUID(), parentId })).id();

  it('a root mover dropped on it keeps its local pose', () => {
    const g = spawn('G', { x: 10 });
    const p = bare('HUD', g);
    const m = spawn('M', { x: 0, y: 3 });
    expect(reparentEntity(m, p)).toBe(true);
    expect([tf(m).x, tf(m).y]).toEqual([0, 3]);
  });

  it('a mover leaving its ancestor for it takes its world pose as its local one', () => {
    const g = spawn('G', { x: 10 });
    const p = bare('HUD', g);
    const m = spawn('M', { x: 1 }, { parentId: g }); // world x=11
    reparentEntity(m, p);
    expect(tf(m).x).toBe(11);
  });

  // The old-parent side: the chain ENDS at it. Mutation: drop `places` in chainOf — M composes past HUD and lands at 11.
  it('a mover leaving it for the root keeps its local pose', () => {
    const g = spawn('G', { x: 10 });
    const p = bare('HUD', g);
    const m = spawn('M', { x: 1 }, { parentId: p }); // world x=1: HUD places nothing
    reparentEntity(m, 0);
    expect(tf(m).x).toBe(1);
  });
});

describe('planReparent refuses a zero-scale parent before any entry point writes', () => {
  // Mutation: drop the `collapsesUnder` refusal in planReparent.
  it('says collapsed-parent', () => {
    const parent = spawn('P', { sz: 0 });
    const child = spawn('C', { x: 1 });
    expect(planReparent(child, parent)).toEqual({ kind: 'refused', reason: 'collapsed-parent' });
    expect(planReparent(child, 0)).toEqual({ kind: 'same-scene' }); // the root never collapses
  });

  // The accept side (#1848 close-out re-review): only the chain BELOW the shared prefix decides, so a zero-scale ancestor
  // both sides share collapses nothing. Mutation: judge the new chain whole in `collapsesUnder` (pass 0 as the mover) —
  // both are refused.
  it('allows a reorder under a zero-scale parent, and a move between two children of one', () => {
    const z = spawn('Z', { sx: 0 });
    const a = spawn('A', {}, { parentId: z });
    const b = spawn('B', {}, { parentId: z });
    expect(planReparent(a, z, 5)).toEqual({ kind: 'same-scene' });
    expect(planReparent(a, b)).toEqual({ kind: 'same-scene' });
    expect(reparentEntity(a, b)).toBe(true);
    expect(parentOf(a)).toBe(b);
  });
});

describe('undo and redo restore only the keys the move wrote', () => {
  // Hub note (2026-09-30). Mutation: make the undo (or the redo) write all nine fields again — the unrelated sx edit
  // is overwritten.
  it('an edit to a field the move did not write survives both undo and redo', async () => {
    const parent = spawn('P', { x: 5, y: 2 });
    const child = spawn('C', { x: 1 });
    reparentEntity(child, parent); // writes x, y, z only
    live(child).set(Transform, { ...(live(child).get(Transform) as object), sx: 2 });
    await undo();
    expect(parentOf(child)).toBe(0);
    expect([tf(child).x, tf(child).y, tf(child).sx]).toEqual([1, 0, 2]);
    live(child).set(Transform, { ...(live(child).get(Transform) as object), sy: 3 });
    await redo();
    expect(parentOf(child)).toBe(parent);
    expect([tf(child).x, tf(child).y, tf(child).sx, tf(child).sy]).toEqual([-4, -2, 2, 3]);
  });
});

describe('a zero-scale new parent is refused (the rule\'s zero-scale bullet)', () => {
  // Mutation: drop the `collapsed` return in `reparentWrite` — the move lands with an unsolvable pose.
  it('reparentEntity refuses before any write', () => {
    const parent = spawn('P', { x: 5, sx: 0 });
    const child = spawn('C', { x: 1, sy: -1 });
    expect(reparentEntity(child, parent)).toBe(false);
    expect(parentOf(child)).toBe(0);
    expect(tf(child)).toMatchObject({ x: 1, sy: -1 });
  });

  it('moveEntityToScene refuses before any write', () => {
    const parent = spawn('P', { sy: 0 }, { sourceScene: 'b1848000-0000-4000-8000-000000000001' });
    const child = spawn('C', { x: 1 });
    expect(moveEntityToScene(child, 'b1848000-0000-4000-8000-000000000001', { newParentId: parent })).toMatchObject({ ok: false, reason: 'collapsed-parent' });
    expect(parentOf(child)).toBe(0);
    expect(readTraitData(child, getTraitByName('EntityAttributes')!)!.sourceScene).toBe('');
  });
});

describe('moveEntityToScene computes with the same owner', () => {
  // Mutation: restore its own compensation block (all nine fields off the cache) — the flip is respelled and the
  // just-created parent reads as identity.
  it('keeps an authored flip, against a parent created since the last pass, and undo restores only the written keys', async () => {
    const BASE = 'b1848000-0000-4000-8000-000000000002';
    const parent = spawn('P', { x: 5, y: 2 }, { sourceScene: BASE });
    const child = spawn('C', { x: 1, sy: -1 });
    expect(moveEntityToScene(child, BASE, { newParentId: parent }).ok).toBe(true);
    expect(tf(child)).toEqual({ x: -4, y: -2, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: -1, sz: 1 });
    live(child).set(Transform, { ...(live(child).get(Transform) as object), sz: 2 });
    await undo();
    expect(tf(child)).toMatchObject({ x: 1, y: 0, sy: -1, sz: 2 });
  });
});

describe('a stored instance root is marked only on what the move changed (the rule\'s marks bullet)', () => {
  // Before: a translation-only move of a mirrored root re-spelled {rz, sx, sy} and the per-number diff marked all three,
  // pinning them as overrides. Mutation: write all nine fields in `reparentWrite` — Transform.rz/sx/sy are marked.
  it('a translation-only move marks x and y, and no rotation or scale', () => {
    const parent = spawn('P', { x: 5, y: 2 });
    const root = spawn('Root', { x: 1, sy: -1 });
    live(root).add(PrefabInstance({ source: 'x', localId: 1, rootInstanceId: root, parentLocalId: 0 }));
    place(root); // its record, as a drop mints one
    reparentEntity(root, parent);
    const marks = [...(overrideKeysOf(live(root)) ?? [])].filter((m) => m.startsWith('Transform.')).sort();
    expect(marks).toEqual(['Transform.x', 'Transform.y']);
  });
});

describe('a reparent into or out of a Frame2D subtree keeps the pose as drawn (#1952)', () => {
  // The Ice Reef shape: canvas 1000 x 2000 (no Transform: it places nothing), a Frame2D host 500 x 500 `cover` directly
  // under it — fit k = 4, x -500. The fit is applied by propagation, never authored, so only `fitOf` brings it into the
  // chains. Mutation (into + out): drop `fitOf` from liveHierarchy, or skip the fit in reparentSuffixes' compose — the
  // sprite keeps (100,100) going in (drawn at -100,400) and (150,25) coming out.
  const w = () => worldTransforms.get(sprite)!;
  let canvas = 0, host = 0, sprite = 0;
  const reef = (spriteParent: 'canvas' | 'host', at: Partial<Tf>) => {
    forgetCanvasView2D();
    canvas = spawnEntity(getCurrentWorld(), Canvas2D({ referenceWidth: 1000, referenceHeight: 2000 }), EntityAttributes({ name: 'Canvas', guid: crypto.randomUUID() })).id();
    host = spawnEntity(getCurrentWorld(), Transform({}), Frame2D({ width: 500, height: 500, fit: 'cover' }),
      EntityAttributes({ name: 'Reef', guid: crypto.randomUUID(), parentId: canvas })).id();
    sprite = spawn('Fish', at, { parentId: spriteParent === 'canvas' ? canvas : host });
    transformPropagationSystem(getCurrentWorld());
    expect([worldTransforms.get(host)!.x, worldTransforms.get(host)!.sx]).toEqual([-500, 4]); // the fit took
  };

  it('into the host: the sprite drawn at canvas (100,100) stays there', () => {
    reef('canvas', { x: 100, y: 100 });
    expect(reparentEntity(sprite, host)).toBe(true);
    expect([tf(sprite).x, tf(sprite).y, tf(sprite).sx]).toEqual([150, 25, 0.25]);
    transformPropagationSystem(getCurrentWorld());
    expect([w().x, w().y, w().sx]).toEqual([100, 100, 1]);
  });

  it('out of the host: the sprite drawn at (100,100) lands at its drawn pose, not its unfitted one', () => {
    reef('host', { x: 150, y: 25, sx: 0.25, sy: 0.25 });
    expect([w().x, w().y]).toEqual([100, 100]);
    expect(reparentEntity(sprite, canvas)).toBe(true);
    expect([tf(sprite).x, tf(sprite).y, tf(sprite).sx]).toEqual([100, 100, 1]);
    transformPropagationSystem(getCurrentWorld());
    expect([w().x, w().y]).toEqual([100, 100]);
  });

  // A TURNED host under a `stretch` fit (kx 2, ky 4): propagation folds the fit into the host's fields, which only a
  // per-field fold matches. Mutation: fold the fit as a matrix before the host's local in reparentSuffixes — the sprite
  // going in is drawn at (73, 85), and the one coming out turns to rz 0.53, sx 2.6. (Going IN, a sheared pose has no
  // TRS, so only the position is exact; coming OUT, the world pose is a TRS and is kept whole.)
  const turnedStretch = (spriteParent: 'canvas' | 'host', at: Partial<Tf>) => {
    forgetCanvasView2D();
    canvas = spawnEntity(getCurrentWorld(), Canvas2D({ referenceWidth: 1000, referenceHeight: 2000 }), EntityAttributes({ name: 'Canvas', guid: crypto.randomUUID() })).id();
    host = spawnEntity(getCurrentWorld(), Transform({ x: 30, rz: 0.5 }), Frame2D({ width: 500, height: 500, fit: 'stretch' }),
      EntityAttributes({ name: 'Reef', guid: crypto.randomUUID(), parentId: canvas })).id();
    sprite = spawn('Fish', at, { parentId: spriteParent === 'canvas' ? canvas : host });
    transformPropagationSystem(getCurrentWorld());
  };

  it('into a turned, stretched host: the sprite stays where it was drawn', () => {
    turnedStretch('canvas', { x: 100, y: 100 });
    reparentEntity(sprite, host);
    transformPropagationSystem(getCurrentWorld());
    expect(w().x).toBeCloseTo(100, 6); expect(w().y).toBeCloseTo(100, 6);
  });

  it('out of a turned, stretched host: the whole drawn pose is kept', () => {
    turnedStretch('host', { x: 20, y: 30 });
    const before = { ...w() };
    reparentEntity(sprite, canvas);
    transformPropagationSystem(getCurrentWorld());
    for (const k of ['x', 'y', 'rz', 'sx', 'sy'] as const) expect(w()[k], k).toBeCloseTo(before[k], 6);
  });

  // An op list (apply-scene-ops with two parentId ops) runs no pass between its moves, so the fit is computed NOW, not
  // read from the last pass. Mutation: read `localFit2DOf` (the last pass's) in liveHierarchy's fitOf — the host was not
  // fitted at that pass, so the sprite keeps (100,100) and is drawn at (-100, 400).
  it('a host moved under the canvas earlier in the same op list is fitted for the next move', () => {
    reef('canvas', { x: 100, y: 100 });
    const group = spawn('Group', {}, { parentId: canvas });
    reparentEntity(host, group);
    transformPropagationSystem(getCurrentWorld());                 // the host is nested now: no fit
    expect(worldTransforms.get(host)!.sx).toBe(1);
    reparentEntity(host, canvas);                                  // …then, with no pass between,
    reparentEntity(sprite, host);                                  // the sprite goes into it
    expect([tf(sprite).x, tf(sprite).y]).toEqual([150, 25]);
    transformPropagationSystem(getCurrentWorld());
    expect([w().x, w().y]).toEqual([100, 100]);
  });

  // The accept side: the MOVER's own fit is not compensated — a Frame2D keeps its authored box and is re-fitted by its
  // new parent. Mutation: compose the mover's own fit into the old chain — the host is written x -500, sx 4.
  it('the Frame2D host itself keeps its authored box when it moves', () => {
    reef('canvas', { x: 0 });
    expect(reparentEntity(host, 0)).toBe(true);
    expect([tf(host).x, tf(host).sx]).toEqual([0, 1]);
  });
});
