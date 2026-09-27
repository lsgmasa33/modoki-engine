/** #1595 — `discardOrbitMotion` against a REAL OrbitControls: a pose written after it stays put, while
 *  the same write without it is carried off by the damping coast of the last gesture. Measured live
 *  before the fix: a pan drag followed by a focus drifted the framed pose 0.4 units in 600 ms.
 *
 *  The residue is injected into OrbitControls' own delta fields — the state a pointer gesture
 *  leaves behind — because the public API has no way to start a coast without a DOM element. */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyOrbitPose, discardOrbitMotion, frameCameraToBox } from '../../src/editor/scene/sceneViewMath';

type Coasting = { _sphericalDelta: THREE.Spherical; _panOffset: THREE.Vector3 };

/** Controls with damping on, mid-coast: a rotate AND a pan still owed. */
function coastingControls() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(12, 15, 20);
  const controls = new OrbitControls(camera);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.update();
  const c = controls as unknown as Coasting;
  c._sphericalDelta.theta = 0.4;
  c._sphericalDelta.phi = -0.2;
  c._panOffset.set(1.5, 0, -0.5);
  return { camera, controls };
}

/** Write a pose the way SceneView's setPose / focus do, then run 60 frames of `update()`. */
function writeAndRun(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  controls.target.set(1, 1, 1);
  camera.position.set(3, 4, 5);
  controls.update();
  for (let i = 0; i < 60; i++) controls.update();
  return { position: camera.position.clone(), target: controls.target.clone() };
}

describe('discardOrbitMotion (#1595)', () => {
  it('a pose written after it is the pose that stays', () => {
    const { camera, controls } = coastingControls();
    discardOrbitMotion(controls);
    const { position, target } = writeAndRun(camera, controls);
    expect(position.distanceTo(new THREE.Vector3(3, 4, 5))).toBeLessThan(1e-6);
    expect(target.distanceTo(new THREE.Vector3(1, 1, 1))).toBeLessThan(1e-6);
  });

  it('control: without it, the coast carries the written pose away (the defect)', () => {
    const { camera, controls } = coastingControls();
    const { position, target } = writeAndRun(camera, controls);
    expect(position.distanceTo(new THREE.Vector3(3, 4, 5))).toBeGreaterThan(0.5);
    expect(target.distanceTo(new THREE.Vector3(1, 1, 1))).toBeGreaterThan(0.5);
  });

  it('leaves damping as it found it, so a human gesture afterwards still eases', () => {
    const { controls } = coastingControls();
    discardOrbitMotion(controls);
    expect(controls.enableDamping).toBe(true);
    controls.enableDamping = false;
    discardOrbitMotion(controls);
    expect(controls.enableDamping).toBe(false);
  });
});

describe('applyOrbitPose — the set_view_camera write (#1595)', () => {
  it('discards the coast itself: the written pose survives 60 frames on coasting controls', () => {
    const { camera, controls } = coastingControls();
    applyOrbitPose(controls, camera, { position: [3, 4, 5], target: [1, 1, 1], fov: 35 }, 1.5);
    for (let i = 0; i < 60; i++) controls.update();
    expect(camera.position.distanceTo(new THREE.Vector3(3, 4, 5))).toBeLessThan(1e-6);
    expect(controls.target.distanceTo(new THREE.Vector3(1, 1, 1))).toBeLessThan(1e-6);
    expect(camera.fov).toBe(35);
  });

  it('derives near/far from the NEW stand-off — a close pose after a big focus does not clip its pivot', () => {
    const { camera, controls } = coastingControls();
    frameCameraToBox(camera, controls.target, new THREE.Vector3(), 250); // near = 5, far = 25000
    applyOrbitPose(controls, camera, { position: [0, 0, 3], target: [0, 0, 0] }, 1);
    expect(camera.near).toBeLessThan(3);
    expect(camera.far).toBe(500); // not the 25000 the focus left behind
    applyOrbitPose(controls, camera, { position: [0, 0, 1e4], target: [0, 0, 0] }, 1);
    expect(camera.far).toBeGreaterThan(1e4);
  });

  it('an ortho pose sets the frustum half-height from orthoSize and leaves fov alone', () => {
    const o = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    o.zoom = 3;
    const controls = new OrbitControls(o);
    applyOrbitPose(controls, o, { position: [0, 10, 0.01], target: [0, 0, 0], orthoSize: 4 }, 2);
    expect(o.top).toBe(4);
    expect(o.right).toBe(8);
    expect(o.zoom).toBe(1);
    // A close ortho pose keeps the ortho far floor: its view does not shrink with distance.
    expect(o.far).toBe(2000);
  });

  it('a close perspective pose keeps a fresh editor\'s near (0.1), not a z-fighting 0.01', () => {
    const { camera, controls } = coastingControls();
    applyOrbitPose(controls, camera, { position: [0, 1, 2], target: [0, 0, 0] }, 1);
    expect(camera.near).toBeCloseTo(0.1, 9);
    applyOrbitPose(controls, camera, { position: [0, 0, 0.5], target: [0, 0, 0] }, 1);
    expect(camera.near).toBeLessThan(0.5); // closer than 1 unit: near backs off so the pivot shows
  });
});

describe('frameCameraToBox far plane follows a distanceScale stand-off (#1595 review)', () => {
  it('radius 10 at 40x the stand-off still has the entity inside far', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, 0, 10);
    const target = new THREE.Vector3();
    frameCameraToBox(cam, target, new THREE.Vector3(), 10, 2.8 * 40);
    expect(cam.position.length()).toBeCloseTo(1120, 6);
    expect(cam.far).toBeGreaterThan(1120);
  });
});
