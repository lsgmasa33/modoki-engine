/** 3D screen bounds — what a viewport MEASURES, shared by SceneView and the runtime Scene3D.
 *
 *  These pin QA-CTX-0006 / QA-SVIEW-0004: the provider projected only meshes and skinned roots
 *  while a real click could also select billboards, SDF text and the Camera/Light/Environment
 *  icon gizmos — so a light was on screen, selectable, and refused by `modoki_tap{entity}` with
 *  "has no screen bounds". The fix landed verified only against a live editor; this is the
 *  headless gate for it.
 *
 *  Real `three` objects and a real camera throughout — the projection is pure math and mocking
 *  it would assert the mock. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createWorld } from 'koota';
import { computeEntityScreenBounds, expandPickableBounds, boundsSourcesOf, type EntityBoundsSources } from '../../src/runtime/rendering/entityScreenBounds';
import { EntityTable } from '../../src/runtime/core/ecs/entityTable';

/** ONE world for the whole file: koota allows 16 worlds per process and never frees an id this file
 *  does not destroy, so a world per case runs out a few cases later with an unrelated error. */
const WORLD = createWorld();
/** A packed owner that stays alive for the whole file — the owner of every entry that is not
 *  itself about a dead owner. Its id is unrelated to the entry ids below, deliberately: liveness is
 *  read from the packed value alone. */
const LIVE = WORLD.spawn().valueOf();

const VP = { left: 0, top: 0, width: 800, height: 600 };

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, VP.width / VP.height, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A 1x1x1 box mesh at the origin (or wherever placed). */
function boxMesh(x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  m.position.set(x, y, z);
  return m;
}

const empty = (): EntityBoundsSources =>
  ({ ecsObjects: [], skinned: [], billboards: [], textMeshes: [], gizmos: [] });

describe('computeSceneViewBounds — coverage matches what a click can select', () => {
  it('measures meshes, skinned roots, billboards, text meshes AND icon gizmos', () => {
    const skinRoot = new THREE.Object3D(); skinRoot.add(boxMesh());
    const billboard = new THREE.Object3D(); billboard.add(boxMesh());
    const text = new THREE.Object3D(); text.add(boxMesh());
    const out = computeEntityScreenBounds({
      ecsObjects: [[1, boxMesh(), LIVE]],
      skinned: [[2, skinRoot, LIVE]],
      billboards: [[3, billboard, LIVE]],
      textMeshes: [[4, text, LIVE]],
      gizmos: [[5, boxMesh(), LIVE]],
    }, camera(), VP, 'scene-view');
    expect(out.map((b) => b.id).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const b of out) {
      expect(b.surface).toBe('scene-view');
      expect(b.layer).toBe('3d');
      expect(b.screen).not.toBeNull();
    }
  });

  it('a LIGHT-style entity — an icon gizmo and nothing else — is measurable', () => {
    // The QA-SVIEW-0004 shape exactly: no mesh anywhere, only the icon that makes it clickable.
    const out = computeEntityScreenBounds({ ...empty(), gizmos: [[7, boxMesh(), LIVE]] }, camera(), VP, 'scene-view');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(7);
    expect(out[0].onScreen).toBe(true);
    expect(out[0].screen!.w).toBeGreaterThan(0);
  });

  it('an icon gizmo reports NO worldAABB, while a mesh does', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[1, boxMesh(), LIVE]], gizmos: [[2, boxMesh(), LIVE]],
    }, camera(), VP, 'scene-view');
    const mesh = out.find((b) => b.id === 1)!;
    const gizmo = out.find((b) => b.id === 2)!;
    // A Light has no geometry — reporting the ICON's extent as the entity's would be a
    // confident wrong answer, which is worse than the field being absent.
    expect(mesh.worldAABB).toBeDefined();
    expect(mesh.worldAABB!.size.map(Math.round)).toEqual([1, 1, 1]);
    expect(gizmo.worldAABB).toBeUndefined();
  });

  it('an invisible billboard / text mesh is not measured (it is not clickable either)', () => {
    const hidden = new THREE.Object3D(); hidden.add(boxMesh()); hidden.visible = false;
    const shown = new THREE.Object3D(); shown.add(boxMesh());
    const out = computeEntityScreenBounds({
      ...empty(), billboards: [[1, hidden, LIVE]], textMeshes: [[2, shown, LIVE]],
    }, camera(), VP, 'scene-view');
    expect(out.map((b) => b.id)).toEqual([2]);
  });

  it('measures an id ONCE even when two maps carry it', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[9, boxMesh(), LIVE]], gizmos: [[9, boxMesh(5, 0, 0), LIVE]],
    }, camera(), VP, 'scene-view');
    expect(out).toHaveLength(1);
    expect(out[0].worldAABB).toBeDefined(); // the ecsObjects (geometric) reading won
  });

  it('honours the ids filter across every map', () => {
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[1, boxMesh(), LIVE], [2, boxMesh(), LIVE]], gizmos: [[3, boxMesh(), LIVE]],
    }, camera(), VP, 'scene-view', new Set([2, 3]));
    expect(out.map((b) => b.id).sort()).toEqual([2, 3]);
  });
});

describe('expandPickableBounds — bounds must not exceed what a raycast can hit', () => {
  /** The camera gizmo: a small icon plus frustum lines that already have a no-op `raycast`
   *  and now carry `noBounds`. Measured whole, the camera came out 5613x1981 px — a rect no
   *  click inside it selects the camera in, so the entity aim was correctly refused. */
  function cameraGizmo(): THREE.Object3D {
    const pivot = new THREE.Object3D();
    pivot.add(boxMesh()); // the icon
    const frustum = new THREE.Mesh(new THREE.BoxGeometry(60, 40, 100));
    frustum.raycast = () => {};
    frustum.userData.noBounds = true;
    pivot.add(frustum);
    pivot.updateMatrixWorld(true);
    return pivot;
  }

  it('prunes a noBounds subtree, where setFromObject would include it', () => {
    const pivot = cameraGizmo();
    const pruned = expandPickableBounds(new THREE.Box3(), pivot);
    const naive = new THREE.Box3().setFromObject(pivot);
    const size = new THREE.Vector3(); pruned.getSize(size);
    expect(size.x).toBeCloseTo(1, 5);   // just the icon
    const naiveSize = new THREE.Vector3(); naive.getSize(naiveSize);
    expect(naiveSize.x).toBeCloseTo(60, 5); // …which is what the bug measured
  });

  it('so the camera projected rect is icon-sized, not frustum-sized', () => {
    const out = computeEntityScreenBounds({ ...empty(), gizmos: [[1, cameraGizmo(), LIVE]] }, camera(), VP, 'scene-view');
    const naive = computeEntityScreenBounds({ ...empty(), ecsObjects: [[1, cameraGizmo(), LIVE]] }, camera(), VP, 'scene-view');
    expect(out[0].screen!.w).toBeLessThan(naive[0].screen!.w / 10);
  });

  it('an object with no geometry anywhere yields an empty box (no crash, no rect claim)', () => {
    const box = expandPickableBounds(new THREE.Box3(), new THREE.Object3D());
    expect(box.isEmpty()).toBe(true);
  });
});

/** The surface label is the caller's, and the runtime provider passes no gizmos.
 *
 *  Found by the close-out sweep: `registerBoundsProvider` has exactly three non-test callers
 *  (Scene2D, Scene3D, SceneView), and of the two 3D ones only SceneView measured more than
 *  `ecsObjects`. So a skinned character had no bounds in the GAME view at all — an entity aim
 *  at `surface:'game-3d'` was refused for something plainly on screen. Both now run this body. */
describe('computeEntityScreenBounds — shared by both 3D surfaces', () => {
  it('stamps the surface the caller asked for, on every rect', () => {
    const out = computeEntityScreenBounds({ ...empty(), ecsObjects: [[1, boxMesh(), LIVE]] }, camera(), VP, 'game-3d');
    expect(out[0].surface).toBe('game-3d');
  });

  it('measures a skinned root on the game surface (the Scene3D gap)', () => {
    const root = new THREE.Object3D(); root.add(boxMesh());
    const out = computeEntityScreenBounds({ ...empty(), skinned: [[4, root, LIVE]] }, camera(), VP, 'game-3d');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(4);
    expect(out[0].worldAABB).toBeDefined();
  });

  it('gizmos are optional — the runtime provider omits the key entirely', () => {
    const sources: EntityBoundsSources = {
      ecsObjects: [[1, boxMesh(), LIVE]],
      skinned: [], billboards: [], textMeshes: [],
    };
    expect(() => computeEntityScreenBounds(sources, camera(), VP, 'game-3d')).not.toThrow();
    expect(computeEntityScreenBounds(sources, camera(), VP, 'game-3d')).toHaveLength(1);
  });
});

/** #1197 — every source is keyed by entity id and swept only on the renderer's NEXT pass, and koota
 *  hands a destroyed entity's index to the next spawn. Between the two, an id-only provider reported
 *  the dead entity's rect under the newcomer's id — measured live on games/3d-test on BOTH 3D
 *  surfaces — and an entity aim tapped where the dead entity had been. */
describe('computeEntityScreenBounds — a dead owner\'s entry is not measured (#1197)', () => {
  function deadOwner(): number {
    const e = WORLD.spawn();
    const packed = e.valueOf();
    e.destroy();
    return packed;
  }
  const SOURCES = ['ecsObjects', 'skinned', 'billboards', 'textMeshes', 'gizmos'] as const;

  for (const source of SOURCES) {
    it(`${source}: an entry whose owner was destroyed yields no rect`, () => {
      const out = computeEntityScreenBounds({ ...empty(), [source]: [[1, boxMesh(), deadOwner()]] }, camera(), VP, 'scene-view');
      expect(out).toEqual([]);
    });

    it(`${source}: an entry with no owner stamp yields no rect — unknown is not alive`, () => {
      const out = computeEntityScreenBounds({ ...empty(), [source]: [[1, boxMesh(), undefined]] }, camera(), VP, 'scene-view');
      expect(out).toEqual([]);
    });

    it(`${source}: the same entry with a live owner IS measured (the accept side)`, () => {
      const out = computeEntityScreenBounds({ ...empty(), [source]: [[1, boxMesh(), LIVE]] }, camera(), VP, 'scene-view');
      expect(out.map((b) => b.id)).toEqual([1]);
    });
  }

  it('a dead entry does not claim its id: a live entry for that id in a LATER map still counts', () => {
    // The dedupe marks an id seen when it is measured. Marking it before the owner check would let a
    // dead mesh hide the newcomer's live icon for the whole window.
    const out = computeEntityScreenBounds({
      ...empty(), ecsObjects: [[9, boxMesh(), deadOwner()]], gizmos: [[9, boxMesh(5, 0, 0), LIVE]],
    }, camera(), VP, 'scene-view');
    expect(out).toHaveLength(1);
    expect(out[0].worldAABB).toBeUndefined(); // the gizmo's reading, not the dead mesh's
  });
});

/** `boundsSourcesOf` is what Scene3D and SceneView actually pass, so this drives the REAL stamps —
 *  `ecsOwners`, the skinned `EntityTable`'s stored packed value, and the billboard/text `owner` field —
 *  through a real same-index respawn rather than a hand-written dead number. */
describe('boundsSourcesOf — the owner each RenderState map carries (#1197)', () => {
  function respawnState() {
    const world = WORLD;
    const dead = world.spawn();
    const id = dead.id();
    const dup = () => { const g = new THREE.Group(); g.add(boxMesh()); return g; };
    const skinned = new EntityTable<{ root: THREE.Object3D }>({ label: 'test', worldSwap: 'owner-clears' });
    skinned.set(dead, { root: dup() });
    const state = {
      ecsObjects: new Map<number, THREE.Object3D>([[id, dup()]]),
      ecsOwners: new Map<number, number>([[id, dead.valueOf()]]),
      skinned,
      billboards: new Map([[id, { group: dup(), owner: dead.valueOf() }]]),
      textMeshes: new Map([[id, { group: dup(), owner: dead.valueOf() }]]),
    };
    const gizmos = { objects: new Map<number, THREE.Object3D>([[id, dup()]]), owners: new Map([[id, dead.valueOf()]]) };
    dead.destroy();
    const fresh = world.spawn();
    return { state, gizmos, fresh, id };
  }
  // `state` is a structural stand-in for the five RenderState fields `boundsSourcesOf` reads — the
  // entries carry only `group` + `owner`, which is all it touches — hence the cast at the call.
  const measure = (state: object, gizmos: Parameters<typeof boundsSourcesOf>[1], id: number) =>
    computeEntityScreenBounds(boundsSourcesOf(state as Parameters<typeof boundsSourcesOf>[0], gizmos), camera(), VP, 'scene-view', new Set([id]));

  it('the respawn reclaimed the index (the premise — without it the test proves nothing)', () => {
    const { fresh, id } = respawnState();
    expect(fresh.id()).toBe(id);
  });

  it('before the next pass re-stamps, the newcomer\'s id has NO rect from any map', () => {
    const { state, gizmos, id } = respawnState();
    expect(measure(state, gizmos, id)).toEqual([]);
  });

  for (const map of ['ecsObjects', 'skinned', 'billboards', 'textMeshes', 'gizmos'] as const) {
    it(`once ${map} is re-stamped for the newcomer, that map measures it again`, () => {
      const { state, gizmos, fresh, id } = respawnState();
      const packed = fresh.valueOf();
      if (map === 'ecsObjects') state.ecsOwners.set(id, packed);
      if (map === 'skinned') state.skinned.set(fresh, { root: state.skinned.peekId(id)!.root });
      if (map === 'billboards') state.billboards.get(id)!.owner = packed;
      if (map === 'textMeshes') state.textMeshes.get(id)!.owner = packed;
      if (map === 'gizmos') gizmos.owners.set(id, packed);
      expect(measure(state, gizmos, id).map((b) => b.id)).toEqual([id]);
    });
  }
});
