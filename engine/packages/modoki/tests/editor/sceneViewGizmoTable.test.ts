/** SceneView's gizmo slots are owned by the ROW — its kind and its entity's generation — not by the
 *  index (#1206). Every shape below was measured live on `games/3d-test` before the fix: a destroy
 *  and a cross-kind respawn in one frame leaked the dead gizmo into the scene (①②④), the empty loop
 *  adopted the shared camera pivot and wrote a scale onto it (④), and a Camera+Light entity cast the
 *  pivot to a Mesh and threw every frame (③). Real koota entities, so the index reuse is koota's own
 *  and each test asserts it happened. */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createWorld, type Entity } from 'koota';
import { SceneViewGizmoTable, GIZMO_LOOP_ORDER, GIZMO_RANK, type GizmoKind } from '../../src/editor/scene/sceneViewGizmoTable';

const WORLD = createWorld();

function setup() {
  const scene = new THREE.Scene();
  const pivot = new THREE.Object3D();
  scene.add(pivot);
  const violations: string[] = [];
  const table = new SceneViewGizmoTable({ scene, shared: new Set([pivot]), onOrderViolation: (m) => violations.push(m) });
  const icon = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  /** One pass: run each loop's claim in GIZMO_LOOP_ORDER, then sweep. */
  const pass = (claims: Array<[Entity, GizmoKind, (() => THREE.Object3D)?]>) => {
    table.beginPass();
    const out = new Map<string, THREE.Object3D | undefined>();
    const ordered = [...claims].sort((a, b) => GIZMO_LOOP_ORDER.indexOf(a[1]) - GIZMO_LOOP_ORDER.indexOf(b[1]));
    for (const [e, kind, make] of ordered) out.set(`${e.id()}:${kind}`, table.claim(e, kind, make ?? (kind === 'camera' ? () => pivot : icon)));
    table.endPass();
    return out;
  };
  /** Destroy `dead` and spawn a replacement on the same index — the premise of every shape. */
  const respawn = (dead: Entity) => {
    const id = dead.id();
    dead.destroy();
    const fresh = WORLD.spawn();
    expect(fresh.id()).toBe(id);
    return fresh;
  };
  return { scene, pivot, table, pass, respawn, violations };
}

const disposeSpy = (o: THREE.Object3D) => vi.spyOn((o as THREE.Mesh).material as THREE.Material, 'dispose');

describe('SceneViewGizmoTable — a slot is the row\'s, not the index\'s (#1206)', () => {
  it('① an Environment dies and a Camera takes its index: the dead icon leaves the scene and is disposed', () => {
    const { scene, pivot, table, pass, respawn } = setup();
    const env = WORLD.spawn();
    const envIcon = pass([[env, 'environment']]).get(`${env.id()}:environment`)!;
    const spy = disposeSpy(envIcon);
    expect(scene.children).toContain(envIcon);

    const cam = respawn(env);
    expect(pass([[cam, 'camera']]).get(`${cam.id()}:camera`)).toBe(pivot);

    expect(scene.children).not.toContain(envIcon);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(table.peekId(cam.id())).toBe(pivot);
    expect(table.kindAt(cam.id())).toBe('camera');
    cam.destroy();
  });

  it('② a Light dies and a Camera takes its index: the shared pivot stays in the scene and keeps its row', () => {
    const { scene, pivot, table, pass, respawn } = setup();
    const light = WORLD.spawn();
    const lightIcon = pass([[light, 'light']]).get(`${light.id()}:light`)!;
    const spy = disposeSpy(lightIcon);

    const cam = respawn(light);
    pass([[cam, 'camera']]);

    expect(pivot.parent).toBe(scene);
    expect(table.peekId(cam.id())).toBe(pivot);
    expect(scene.children).not.toContain(lightIcon);
    expect(spy).toHaveBeenCalledTimes(1);

    // And the pivot outlives the last Camera: its row goes, the object stays.
    cam.destroy();
    pass([]);
    expect(table.size).toBe(0);
    expect(pivot.parent).toBe(scene);
  });

  it('③ a Camera+Light entity: the light yields — it never receives the pivot, and builds nothing', () => {
    const { pivot, table, pass } = setup();
    const both = WORLD.spawn();
    const makeLight = vi.fn(() => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    for (let i = 0; i < 3; i++) {
      const out = pass([[both, 'camera'], [both, 'light', makeLight]]);
      expect(out.get(`${both.id()}:light`)).toBeUndefined();
    }
    expect(makeLight).not.toHaveBeenCalled();
    expect(table.peekId(both.id())).toBe(pivot);
    both.destroy();
  });

  it('④ an empty marker dies and a Camera takes its index: the empty loop gets nothing back, and the marker is disposed', () => {
    const { scene, pivot, pass, respawn } = setup();
    const empty = WORLD.spawn();
    const marker = pass([[empty, 'empty']]).get(`${empty.id()}:empty`)!;
    const spy = disposeSpy(marker);

    const cam = respawn(empty);
    // SceneView's empty loop visits every Transform entity, the camera included.
    const out = pass([[cam, 'camera'], [cam, 'empty']]);
    expect(out.get(`${cam.id()}:empty`)).toBeUndefined();
    expect(out.get(`${cam.id()}:empty`)).not.toBe(pivot);
    expect(scene.children).not.toContain(marker);
    expect(spy).toHaveBeenCalledTimes(1);
    cam.destroy();
  });

  it('accept: a same-kind respawn gets a NEW gizmo, and the dead one\'s is disposed', () => {
    const { scene, pass, respawn } = setup();
    const a = WORLD.spawn();
    const first = pass([[a, 'light']]).get(`${a.id()}:light`)!;
    const spy = disposeSpy(first);
    const b = respawn(a);
    const second = pass([[b, 'light']]).get(`${b.id()}:light`)!;
    expect(second).not.toBe(first);
    expect(scene.children).toContain(second);
    expect(scene.children).not.toContain(first);
    expect(spy).toHaveBeenCalledTimes(1);
    b.destroy();
  });

  it('accept: a live entity keeps the same gizmo object pass after pass', () => {
    const { pass } = setup();
    const e = WORLD.spawn();
    const make = vi.fn(() => new THREE.Mesh());
    const g1 = pass([[e, 'particle', make]]).get(`${e.id()}:particle`);
    const g2 = pass([[e, 'particle', make]]).get(`${e.id()}:particle`);
    expect(g2).toBe(g1);
    expect(make).toHaveBeenCalledTimes(1);
    e.destroy();
  });

  it('a row nobody claims or keeps is released at endPass', () => {
    const { scene, table, pass } = setup();
    const e = WORLD.spawn();
    const g = pass([[e, 'zone']]).get(`${e.id()}:zone`)!;
    pass([]);
    expect(scene.children).not.toContain(g);
    expect(table.size).toBe(0);
    e.destroy();
  });

  it('keep: a deactivated camera keeps its row without claiming; keep of another kind keeps nothing', () => {
    const { table, pass } = setup();
    const cam = WORLD.spawn();
    const light = WORLD.spawn();
    pass([[cam, 'camera'], [light, 'light']]);
    table.beginPass();
    table.keep(cam, 'camera');
    table.keep(light, 'camera'); // wrong kind — must not keep the light's icon
    table.endPass();
    expect(table.kindAt(cam.id())).toBe('camera');
    expect(table.peekId(light.id())).toBeUndefined();
    cam.destroy(); light.destroy();
  });

  it('a dead handle claims nothing and builds nothing', () => {
    const { table } = setup();
    const e = WORLD.spawn();
    e.destroy();
    const make = vi.fn(() => new THREE.Mesh());
    table.beginPass();
    expect(table.claim(e, 'light', make)).toBeUndefined();
    table.endPass();
    expect(make).not.toHaveBeenCalled();
    expect(table.size).toBe(0);
  });

  it('owned() carries the packed owner, so a reader can refuse a dead one before the sweep', () => {
    const { table, pass } = setup();
    const e = WORLD.spawn();
    pass([[e, 'environment']]);
    const packed = e.valueOf();
    expect([...table.owned()].map(([id, , owner]) => [id, owner])).toEqual([[e.id(), packed]]);
    e.destroy();
  });
});

describe('SceneViewGizmoTable — two kinds on one live entity (rank settled 2026-09-14)', () => {
  it('the rank keeps a toggled-on CameraFrame box and a Zone3D volume above a camera icon', () => {
    expect(GIZMO_RANK).toEqual(['empty', 'particle', 'light', 'environment', 'camera', 'frameBox', 'zone']);
  });

  it('CameraFrame box toggled ON: it replaces the empty marker, and the empty loop yields to it', () => {
    const { scene, pass } = setup();
    const e = WORLD.spawn();
    const marker = pass([[e, 'empty']]).get(`${e.id()}:empty`)!;
    const out = pass([[e, 'frameBox'], [e, 'empty']]);
    expect(out.get(`${e.id()}:frameBox`)).toBeDefined();
    expect(out.get(`${e.id()}:empty`)).toBeUndefined();
    expect(scene.children).not.toContain(marker);
    e.destroy();
  });

  it('CameraFrame box toggled OFF: the empty marker takes over in the SAME pass, not the next one', () => {
    const { table, pass } = setup();
    const e = WORLD.spawn();
    pass([[e, 'frameBox'], [e, 'empty']]);
    // The frame loop has run and did not claim; the empty loop comes after it.
    const out = pass([[e, 'empty']]);
    expect(out.get(`${e.id()}:empty`)).toBeDefined();
    expect(table.kindAt(e.id())).toBe('empty');
    e.destroy();
  });

  it('a higher-ranked row whose loop is still to come is NOT replaced — no rebuild every pass', () => {
    const { pass } = setup();
    const e = WORLD.spawn();
    const makeZone = vi.fn(() => new THREE.Mesh());
    const makeLight = vi.fn(() => new THREE.Mesh());
    const z1 = pass([[e, 'light', makeLight], [e, 'zone', makeZone]]).get(`${e.id()}:zone`);
    const second = pass([[e, 'light', makeLight], [e, 'zone', makeZone]]);
    expect(second.get(`${e.id()}:light`)).toBeUndefined();
    expect(second.get(`${e.id()}:zone`)).toBe(z1);
    expect(makeZone).toHaveBeenCalledTimes(1);
    e.destroy();
  });

  it('a claim out of GIZMO_LOOP_ORDER reports itself, once', () => {
    const { table, violations } = setup();
    const e = WORLD.spawn();
    for (let i = 0; i < 2; i++) {
      table.beginPass();
      table.claim(e, 'empty', () => new THREE.Mesh());
      table.claim(e, 'camera', () => new THREE.Object3D());
      table.endPass();
    }
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'camera' loop ran after the 'empty' loop");
    e.destroy();
  });

  it('accept: loops in order report nothing', () => {
    const { pass, violations } = setup();
    const e = WORLD.spawn();
    pass([[e, 'camera'], [e, 'environment'], [e, 'light'], [e, 'particle'], [e, 'frameBox'], [e, 'zone'], [e, 'empty']]);
    expect(violations).toEqual([]);
    e.destroy();
  });
});

describe('SceneViewGizmoTable — disposal', () => {
  it('a gizmo that no longer fits its shape is rebuilt, and a per-zone capsule geometry is disposed', () => {
    const { table } = setup();
    const e = WORLD.spawn();
    const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(1, 2, 6, 16), new THREE.MeshBasicMaterial());
    (capsule.userData as { zoneCapSig?: string }).zoneCapSig = '1:2';
    const geoSpy = vi.spyOn(capsule.geometry, 'dispose');
    table.beginPass();
    table.claim(e, 'zone', () => capsule);
    table.endPass();

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
    table.beginPass();
    expect(table.claim(e, 'zone', () => sphere, (o) => o === sphere)).toBe(sphere);
    table.endPass();
    expect(geoSpy).toHaveBeenCalledTimes(1);
    e.destroy();
  });

  it('a shared GIZMO_SHAPES-style geometry is NOT disposed when its gizmo is released', () => {
    const { table, pass } = setup();
    const shape = new THREE.BoxGeometry();
    const geoSpy = vi.spyOn(shape, 'dispose');
    const e = WORLD.spawn();
    pass([[e, 'light', () => new THREE.Mesh(shape, new THREE.MeshBasicMaterial())]]);
    table.clear();
    expect(geoSpy).not.toHaveBeenCalled();
    e.destroy();
  });

  it('clear() releases every gizmo — array materials and material-less groups included — but never a shared one', () => {
    const { scene, pivot, table } = setup();
    const matA = new THREE.MeshBasicMaterial();
    const matB = new THREE.MeshBasicMaterial();
    const multi = new THREE.Mesh(new THREE.BoxGeometry(), [matA, matB]);
    const group = new THREE.Group();
    const [a, b, c] = [WORLD.spawn(), WORLD.spawn(), WORLD.spawn()];
    table.beginPass();
    table.claim(a, 'camera', () => pivot);
    table.claim(b, 'particle', () => multi);
    table.claim(c, 'empty', () => group);
    table.endPass();
    const spyA = vi.spyOn(matA, 'dispose');
    const spyB = vi.spyOn(matB, 'dispose');

    expect(() => table.clear()).not.toThrow();
    expect(table.size).toBe(0);
    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(scene.children).not.toContain(multi);
    expect(scene.children).not.toContain(group);
    expect(pivot.parent).toBe(scene);
    a.destroy(); b.destroy(); c.destroy();
  });
});
