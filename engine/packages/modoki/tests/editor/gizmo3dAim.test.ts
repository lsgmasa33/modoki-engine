import { describe, it, expect } from 'vitest';
import { gizmoWorldScale, rotateRingAim, scaleCenterAim, axisPickAim, ROTATE_RING_RADIUS, SCALE_XYZ_HALF_EXTENT, AXIS_PICKER_CENTER } from '../../src/editor/panels/gizmo3dAim';

/** A pinhole projection that is enough to reason about aim points: CSS px per world unit at the
 *  target's depth, origin at the viewport centre, +y down. Mirrors what `SceneView`'s `project()`
 *  does through THREE, without needing a renderer. */
function makeProject(camPos: { x: number; y: number; z: number }, fovDeg: number, w: number, h: number) {
  const f = h / 2 / Math.tan((Math.PI * fovDeg) / 360);
  return (p: { x: number; y: number; z: number }) => {
    // Camera looks down -Z from camPos; depth is the distance along -Z.
    const d = camPos.z - p.z;
    // A monotonic stand-in for NDC depth: nearer to the camera → smaller z, inside [-1, 1].
    return { x: w / 2 + ((p.x - camPos.x) * f) / d, y: h / 2 - ((p.y - camPos.y) * f) / d, z: Math.tanh(d / 100) };
  };
}

const X = { x: 1, y: 0, z: 0 };
const Y = { x: 0, y: 1, z: 0 };
const Z = { x: 0, y: 0, z: 1 };

describe('gizmoWorldScale', () => {
  it('reproduces three.js TransformControls factor * size / 4 for a perspective camera', () => {
    // three: factor = distance * min(1.9 * tan(fov/2), 7); handle.scale = factor * size / 4.
    const distance = 27.73;
    const expected = (distance * 1.9 * Math.tan((Math.PI * 50) / 360) * 1.5) / 4;
    const got = gizmoWorldScale({ fov: 50, zoom: 1 }, { x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 1.5);
    expect(got).toBeCloseTo(expected, 9);
  });

  it('clamps the perspective term at 7, as three does for very wide fovs', () => {
    const wide = gizmoWorldScale({ fov: 179, zoom: 1 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }, 1.5);
    expect(wide).toBeCloseTo((10 * 7 * 1.5) / 4, 9);
  });

  it('ignores distance for an orthographic camera and uses the frustum height / zoom', () => {
    const near = gizmoWorldScale({ isOrthographicCamera: true, top: 10, bottom: -10, zoom: 2 }, { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 1.5);
    const far = gizmoWorldScale({ isOrthographicCamera: true, top: 10, bottom: -10, zoom: 2 }, { x: 0, y: 0, z: 500 }, { x: 0, y: 0, z: 0 }, 1.5);
    expect(near).toBeCloseTo(3.75, 9); // (20 / 2) * 1.5 / 4
    expect(far).toBeCloseTo(near, 9);
  });

  it('holds the ring at a CONSTANT screen radius regardless of distance — which is why a fixed pixel offset could never work', () => {
    const w = 1600, h = 968, fov = 50;
    const radiusPx = (distance: number) => {
      const project = makeProject({ x: 0, y: 0, z: distance }, fov, w, h);
      const r = ROTATE_RING_RADIUS * gizmoWorldScale({ fov, zoom: 1 }, { x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 1.5);
      const c = project({ x: 0, y: 0, z: 0 });
      const p = project({ x: r, y: 0, z: 0 });
      return Math.hypot(p.x - c.x, p.y - c.y);
    };
    expect(radiusPx(10)).toBeCloseTo(radiusPx(200), 6);
    // ~172 px at this viewport — the old aim was hard-coded to 66 px, i.e. inside the ring's hole
    // at EVERY distance, which is the whole defect (testboard zBgcNtw2HLyXwT9lMEe4).
    expect(radiusPx(27.73)).toBeGreaterThan(150);
    expect(radiusPx(27.73)).toBeLessThan(200);
  });
});

describe('rotateRingAim', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const camPos = { x: 0, y: 0, z: 30 };
  const project = makeProject(camPos, 50, 1600, 968);
  const radius = 5;

  it('lands ON the ring — at the ring radius, in the ring plane', () => {
    const aim = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project })!;
    expect(aim).not.toBeNull();
    expect(Math.hypot(aim.world.x, aim.world.y, aim.world.z)).toBeCloseTo(radius, 9);
    expect(aim.world.x).toBeCloseTo(0, 9); // the X ring lies in the YZ plane
  });

  it('aims at a 45° diagonal, never at an axis where two rings intersect', () => {
    const aim = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project })!;
    // Both in-plane components non-zero ⇒ the point is on the X ring alone.
    expect(Math.abs(aim.world.y)).toBeGreaterThan(radius * 0.5);
    expect(Math.abs(aim.world.z)).toBeGreaterThan(radius * 0.5);
    expect(Math.abs(aim.world.y)).toBeCloseTo(Math.abs(aim.world.z), 9);
  });

  it('picks the candidate NEAREST the camera, so the press cannot be shadowed by the far side', () => {
    const aim = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project })!;
    expect(aim.world.z).toBeGreaterThan(0); // camera sits at +z
  });

  it('breaks a face-on tie on screen separation rather than returning the centre-most point', () => {
    // The Z ring (XY plane) is face-on to this camera: all four diagonals are equidistant.
    const aim = rotateRingAim({ origin, u: X, vAxis: Y, radius, project })!;
    const c = project(origin);
    expect(Math.hypot(aim.x - c.x, aim.y - c.y)).toBeGreaterThan(1);
  });

  it('prefers a REACHABLE candidate over the nearest one when chrome covers the near point', () => {
    const near = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project })!;
    const blocked = rotateRingAim({
      origin, u: Y, vAxis: Z, radius, project,
      reachable: (p) => !(Math.abs(p.x - near.x) < 0.5 && Math.abs(p.y - near.y) < 0.5),
    })!;
    // Moved to a different point on the SAME ring rather than aiming at the covered one.
    expect(Math.hypot(blocked.x - near.x, blocked.y - near.y)).toBeGreaterThan(1);
    expect(Math.hypot(blocked.world.x, blocked.world.y, blocked.world.z)).toBeCloseTo(radius, 9);
    expect(blocked.world.x).toBeCloseTo(0, 9);
  });

  it('still answers with the nearest candidate when EVERY candidate is covered', () => {
    const free = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project })!;
    const allBlocked = rotateRingAim({ origin, u: Y, vAxis: Z, radius, project, reachable: () => false })!;
    expect(allBlocked).not.toBeNull();
    expect(allBlocked.x).toBeCloseTo(free.x, 9);
    expect(allBlocked.y).toBeCloseTo(free.y, 9);
  });

  it('returns null when every candidate is clipped', () => {
    const clipped = () => ({ x: 0, y: 0, z: 42 });
    expect(rotateRingAim({ origin, u: X, vAxis: Y, radius, project: clipped })).toBeNull();
  });

  it('follows a rotated (local-space) basis', () => {
    // A ring whose plane is spanned by two axes rotated 90° about X: Y→Z, Z→-Y.
    const aim = rotateRingAim({ origin, u: Z, vAxis: { x: 0, y: -1, z: 0 }, radius, project })!;
    expect(aim.world.x).toBeCloseTo(0, 9);
    expect(Math.hypot(aim.world.y, aim.world.z)).toBeCloseTo(radius, 9);
  });
});

describe('scaleCenterAim', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const camPos = { x: 0, y: 0, z: 30 };
  const project = makeProject(camPos, 50, 1600, 968);
  const halfExtentWorld = SCALE_XYZ_HALF_EXTENT * gizmoWorldScale({ fov: 50, zoom: 1 }, camPos, origin, 1.5);
  const right = X, up = Y;

  it('does NOT press the origin — three divides the uniform-scale ratio by the press radius', () => {
    const aim = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    const c = project(origin);
    expect(Math.hypot(aim.x - c.x, aim.y - c.y)).toBeGreaterThan(4);
  });

  it('stays INSIDE the picker box on every axis, so the press still selects uniform scale', () => {
    const aim = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(aim.world[k])).toBeLessThan(halfExtentWorld);
    }
  });

  it('offsets along the CAMERA axes, so an origin-facing world axis cannot collapse it to 0 px', () => {
    // Camera rolled 90°: right/up swap. The aim must still move on screen.
    const aim = scaleCenterAim({ origin, cameraRight: up, cameraUp: { x: -1, y: 0, z: 0 }, halfExtentWorld, project })!;
    const c = project(origin);
    expect(Math.hypot(aim.x - c.x, aim.y - c.y)).toBeGreaterThan(4);
  });

  it('takes the screen DOWN-RIGHT corner, so a dx+/dy+ drag grows instead of crossing the pivot', () => {
    const aim = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    const c = project(origin);
    expect(aim.x).toBeGreaterThan(c.x);
    expect(aim.y).toBeGreaterThan(c.y); // +y is DOWN in CSS px
  });

  it('prefers a corner that selects the UNIFORM picker over one that lands on a plane plate', () => {
    const plain = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    const steered = scaleCenterAim({
      origin, cameraRight: right, cameraUp: up, halfExtentWorld, project,
      picksUniform: (p) => !(Math.abs(p.x - plain.x) < 0.5 && Math.abs(p.y - plain.y) < 0.5),
    })!;
    expect(Math.hypot(steered.x - plain.x, steered.y - plain.y)).toBeGreaterThan(1);
  });

  it('outranks reachability with the uniform picker — a refusal is louder than a two-axis scale', () => {
    // The down-right corner is reachable but hits a plate; another corner is covered but uniform.
    const plain = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    const isPlain = (p: { x: number; y: number }) => Math.abs(p.x - plain.x) < 0.5 && Math.abs(p.y - plain.y) < 0.5;
    const steered = scaleCenterAim({
      origin, cameraRight: right, cameraUp: up, halfExtentWorld, project,
      reachable: isPlain,          // only the plate corner is clickable…
      picksUniform: (p) => !isPlain(p), // …and it is the one that is NOT uniform
    })!;
    expect(isPlain(steered)).toBe(false);
  });

  it('prefers a reachable corner, and still answers when all four are covered', () => {
    const free = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project })!;
    const moved = scaleCenterAim({
      origin, cameraRight: right, cameraUp: up, halfExtentWorld, project,
      reachable: (p) => !(Math.abs(p.x - free.x) < 0.5 && Math.abs(p.y - free.y) < 0.5),
    })!;
    expect(Math.hypot(moved.x - free.x, moved.y - free.y)).toBeGreaterThan(1);
    const blocked = scaleCenterAim({ origin, cameraRight: right, cameraUp: up, halfExtentWorld, project, reachable: () => false })!;
    expect(blocked).not.toBeNull();
  });
});


/** The translate/scale ARROW aim. A fixed pixel offset overshot the picker on a small Scene panel
 *  — measured on games/3d-test (canvas 366x227): three's own picker answered `X` from ~10 to ~45 px
 *  and NOTHING at the 52 px the provider published, so the press orbited the camera. */
describe('axisPickAim', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const camPos = { x: 0, y: 0, z: 30 };
  const eye = { x: 0, y: 0, z: 1 };
  const project = makeProject(camPos, 50, 1600, 968);
  const offsetWorld = AXIS_PICKER_CENTER * gizmoWorldScale({ fov: 50, zoom: 1 }, camPos, origin, 1.5);

  it('presses the picker cone CENTRE, in world units, not a screen constant', () => {
    const aim = axisPickAim({ origin, dir: X, offsetWorld, eye, project })!;
    expect(Math.abs(aim.world.x)).toBeCloseTo(offsetWorld, 9);
    expect(aim.world.y).toBeCloseTo(0, 9);
    expect(aim.world.z).toBeCloseTo(0, 9);
  });

  it('scales with the gizmo, so a small panel and a large one both land', () => {
    // Same world offset, two viewports: the SCREEN offset differs, which is the whole point.
    const small = makeProject(camPos, 50, 366, 227);
    const big = axisPickAim({ origin, dir: X, offsetWorld, eye, project })!;
    const tiny = axisPickAim({ origin, dir: X, offsetWorld, eye, project: small })!;
    const bigPx = Math.hypot(big.x - project(origin).x, big.y - project(origin).y);
    const tinyPx = Math.hypot(tiny.x - small(origin).x, tiny.y - small(origin).y);
    expect(bigPx).toBeGreaterThan(tinyPx * 3);
    // …and both describe the SAME world point, which is what makes them both correct.
    expect(tiny.world.x).toBeCloseTo(big.world.x, 9);
  });

  it('returns null for an axis three has HIDDEN (pointing within ~8° of the view)', () => {
    expect(axisPickAim({ origin, dir: Z, offsetWorld, eye, project })).toBeNull();
    // …and answers for one that is merely oblique.
    const oblique = { x: 0.3, y: 0, z: 0.954 };
    expect(axisPickAim({ origin, dir: oblique, offsetWorld, eye, project })).not.toBeNull();
  });

  it('the ANSWER depends on the eye it is given — which is why the ortho branch is load-bearing', () => {
    // three derives `eye` differently per projection: `cameraPosition - worldPosition` for a
    // perspective camera, but the negated VIEW DIRECTION for an orthographic one
    // (TransformControls.js:1113). For an entity off to the side those diverge, and the caller
    // passing the perspective form to an ortho camera would hide an axis three kept, or publish
    // one three collapsed to 1e-10. Same axis, two eyes, two answers:
    const offCentre = { x: 20, y: 0, z: 0 };
    const positionEye = { x: -0.196, y: 0, z: 0.981 };  // (camPos - origin).normalize()
    const viewDirEye = { x: 0, y: 0, z: 1 };            // -camera.getWorldDirection()
    expect(axisPickAim({ origin: offCentre, dir: Z, offsetWorld, eye: positionEye, project })).not.toBeNull();
    expect(axisPickAim({ origin: offCentre, dir: Z, offsetWorld, eye: viewDirEye, project })).toBeNull();
  });

  it('takes the OTHER end of the axis when the first is unreachable — both carry a picker', () => {
    const plain = axisPickAim({ origin, dir: X, offsetWorld, eye, project })!;
    const flipped = axisPickAim({
      origin, dir: X, offsetWorld, eye, project,
      reachable: (p) => !(Math.abs(p.x - plain.x) < 0.5 && Math.abs(p.y - plain.y) < 0.5),
    })!;
    expect(Math.sign(flipped.world.x)).toBe(-Math.sign(plain.world.x));
    expect(Math.abs(flipped.world.x)).toBeCloseTo(offsetWorld, 9);
  });

  it('still answers when BOTH ends are covered, rather than dropping the handle', () => {
    expect(axisPickAim({ origin, dir: X, offsetWorld, eye, project, reachable: () => false })).not.toBeNull();
  });
});
