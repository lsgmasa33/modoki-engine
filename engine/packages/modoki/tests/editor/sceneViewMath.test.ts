/** sceneViewMath — pure viewport helpers extracted from SceneView's render effect
 *  (editor-sceneview F4, Missing Tests 1–4): camera framing, letterbox/NDC remap, and
 *  frustum-wireframe generation. All runnable without a GPU/DOM. */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeLetterbox, computeUIModeNDC, computeFullNDC, computeCamFrustumPositions, frameCameraToBox,
  frameCameraToBoxFixed, computeDeviceLetterbox, resolveDeviceSize, gameAspectFromRect,
  createSelectGesture, DESELECT_DRAG_PX, outlineSourceGeometry,
  resolveFocusTarget, FOCUS_DEFAULT_RADIUS,
} from '../../src/editor/scene/sceneViewMath';

describe('frameCameraToBox (Missing Test #1 — camera framing)', () => {
  it('frames a box preserving the current view direction; sets near/far from radius', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, 0, 10);
    const target = new THREE.Vector3(0, 0, 0);
    frameCameraToBox(cam, target, new THREE.Vector3(5, 0, 0), 2);
    // dir = (0,0,1); dist = 2 * 2.8 = 5.6 → pos = center + dir*dist
    expect(target.toArray()).toEqual([5, 0, 0]);
    expect(cam.position.x).toBeCloseTo(5, 5);
    expect(cam.position.z).toBeCloseTo(5.6, 5);
    expect(cam.near).toBeCloseTo(Math.max(0.01, 2 / 50), 6); // 0.04
    expect(cam.far).toBeCloseTo(Math.max(500, 2 * 100), 6);  // 500
  });

  it('uses the default viewing angle when the camera sits on the target (degenerate dir)', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(3, 3, 3);
    const target = new THREE.Vector3(3, 3, 3); // dir length 0 → fallback (1,0.75,1)
    frameCameraToBox(cam, target, new THREE.Vector3(0, 0, 0), 1);
    const fallback = new THREE.Vector3(1, 0.75, 1).normalize();
    const offset = cam.position.clone().sub(new THREE.Vector3(0, 0, 0)).normalize();
    expect(offset.x).toBeCloseTo(fallback.x, 5);
    expect(offset.y).toBeCloseTo(fallback.y, 5);
    expect(offset.z).toBeCloseTo(fallback.z, 5);
  });

  it('honors a custom distance multiplier', () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, 0, 1);
    const target = new THREE.Vector3();
    frameCameraToBox(cam, target, new THREE.Vector3(), 2, 4);
    expect(cam.position.z).toBeCloseTo(8, 5); // 2 * 4
  });
});

describe('frameCameraToBoxFixed (ModelPreview F8 — fixed-angle thumbnail framing)', () => {
  it('frames from the canonical down-the-corner direction regardless of current view', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
    cam.position.set(0, 0, 10); // current orbit is ignored (unlike frameCameraToBox)
    const target = new THREE.Vector3();
    const center = new THREE.Vector3(1, 2, 3);
    const diag = 4;
    frameCameraToBoxFixed(cam, target, center, diag);
    const dist = diag * 1.4; // 5.6
    expect(target.toArray()).toEqual([1, 2, 3]);
    expect(cam.position.x).toBeCloseTo(center.x + dist, 5);
    expect(cam.position.y).toBeCloseTo(center.y + dist * 0.6, 5);
    expect(cam.position.z).toBeCloseTo(center.z + dist, 5);
    expect(cam.near).toBeCloseTo(Math.max(0.01, diag / 100), 6); // 0.04
    expect(cam.far).toBeCloseTo(Math.max(100, diag * 50), 6);    // 200
  });

  it('clamps near/far for a tiny model', () => {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
    const target = new THREE.Vector3();
    frameCameraToBoxFixed(cam, target, new THREE.Vector3(), 0.5);
    expect(cam.near).toBeCloseTo(0.01, 6); // 0.5/100 = 0.005 → clamped to 0.01
    expect(cam.far).toBeCloseTo(100, 6);   // 0.5*50 = 25 → clamped to 100
  });
});

describe('computeLetterbox + NDC (Missing Test #4 — UI-mode letterbox remap)', () => {
  it('pillarboxes a wide container (containerAspect > gameAspect)', () => {
    // 200×100 container (aspect 2), game aspect 1 → square viewport centered horizontally
    const lb = computeLetterbox(200, 100, 1);
    expect(lb).toEqual({ vpX: 50, vpY: 0, vpW: 100, vpH: 100 });
  });

  it('letterboxes a tall container (containerAspect < gameAspect)', () => {
    // 100×200 container (aspect 0.5), game aspect 1 → square viewport centered vertically
    const lb = computeLetterbox(100, 200, 1);
    expect(lb).toEqual({ vpX: 0, vpY: 50, vpW: 100, vpH: 100 });
  });

  it('rounds dimensions before centering when round=true', () => {
    const lb = computeLetterbox(101, 100, 1, true);
    // vpW=round(100*1)=100, vpX=round((101-100)/2)=round(0.5)=1 (no half-pixel scissor)
    expect(Number.isInteger(lb.vpX) && Number.isInteger(lb.vpW)).toBe(true);
  });

  it('UI-mode NDC maps the viewport center to (0,0) and respects the letterbox offset', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 }; // pillarbox: vpX=50, vpW=100
    // center of the letterboxed viewport is at clientX=100, clientY=50
    const center = computeUIModeNDC(100, 50, rect, 1);
    expect(center.x).toBeCloseTo(0, 5);
    expect(center.y).toBeCloseTo(0, 5);
    // left edge of the viewport (clientX=50) → x=-1; right edge (150) → x=+1
    expect(computeUIModeNDC(50, 50, rect, 1).x).toBeCloseTo(-1, 5);
    expect(computeUIModeNDC(150, 50, rect, 1).x).toBeCloseTo(1, 5);
  });

  it('full-canvas NDC maps corners to ±1 with Y flipped', () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(computeFullNDC(0, 0, rect)).toEqual({ x: -1, y: 1 });   // top-left
    expect(computeFullNDC(100, 100, rect)).toEqual({ x: 1, y: -1 }); // bottom-right
    expect(computeFullNDC(50, 50, rect)).toEqual({ x: 0, y: 0 });    // center
  });
});

describe('computeCamFrustumPositions (Missing Test — frustum wireframe)', () => {
  it('fills 96 floats with near/far rects + apex rays at the origin', () => {
    const out = new Float32Array(96);
    const fov = 90, aspect = 1, near = 1, far = 2;
    computeCamFrustumPositions(fov, aspect, near, far, out);
    // fov 90 → tan(45)=1 → near half-height = 1, half-width = 1; far = 2,2.
    // First segment is near-rect edge [0→1]: corner0 (-1,1,-1) → corner1 (1,1,-1).
    expect([out[0], out[1], out[2]]).toEqual([-1, 1, -1]);
    expect([out[3], out[4], out[5]]).toEqual([1, 1, -1]);
    // The last 4 segments are apex rays: each starts at the origin (0,0,0).
    // Apex rays occupy segments 12..15 → float offset 12*6 = 72.
    for (let s = 12; s < 16; s++) {
      const o = s * 6;
      expect([out[o], out[o + 1], out[o + 2]]).toEqual([0, 0, 0]); // ray start = origin
      expect(out[o + 5]).toBe(-near); // ray end is a NEAR corner (z = -near)
    }
  });

  it('scales the far rectangle by far/near vs the near rectangle', () => {
    const out = new Float32Array(96);
    computeCamFrustumPositions(90, 1, 1, 3, out); // far 3× near
    // far-rect first edge is segment 4 → offset 24; its first corner is (-fw, fh, -far).
    expect([out[24], out[25], out[26]]).toEqual([-3, 3, -3]);
  });
});

describe('resolveDeviceSize (Missing Test #6 — GameView device-preset orientation)', () => {
  it('keeps authored (w,h) in portrait', () => {
    expect(resolveDeviceSize(393, 852, 'portrait')).toEqual({ deviceW: 393, deviceH: 852 });
  });
  it('swaps (w,h) in landscape', () => {
    expect(resolveDeviceSize(393, 852, 'landscape')).toEqual({ deviceW: 852, deviceH: 393 });
  });
});

describe('computeDeviceLetterbox (Missing Test #6 — GameView letterbox sizing)', () => {
  it('pillarboxes a portrait device in a wide area (centered horizontally)', () => {
    // 393×852 (aspect ≈ 0.461) inside an 800×600 area → height-bound.
    const r = computeDeviceLetterbox(800, 600, 393, 852);
    expect(r.height).toBe(600);
    const scale = 600 / 852;
    expect(r.width).toBe(Math.round(393 * scale)); // 277
    expect(r.left).toBe(Math.round((800 - r.width) / 2));
    expect(r.top).toBe(0);
  });

  it('letterboxes a landscape device in a tall area (centered vertically)', () => {
    // 16:9 1280×720 inside a 400×600 area → width-bound.
    const r = computeDeviceLetterbox(400, 600, 1280, 720);
    expect(r.width).toBe(400);
    const scale = 400 / 1280;
    expect(r.height).toBe(Math.round(720 * scale)); // 225
    expect(r.left).toBe(0);
    expect(r.top).toBe(Math.round((600 - r.height) / 2));
  });

  it('returns a zero rect for Free mode (deviceW/H = 0) or an unmeasured area', () => {
    expect(computeDeviceLetterbox(800, 600, 0, 0)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    expect(computeDeviceLetterbox(0, 0, 393, 852)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it('fits exactly with no offset when area aspect matches device aspect', () => {
    const r = computeDeviceLetterbox(786, 1704, 393, 852); // exact 2× scale
    expect(r).toEqual({ left: 0, top: 0, width: 786, height: 1704 });
  });
});

describe('gameAspectFromRect (F11 — single aspect source)', () => {
  it('uses the measured rect when it has area', () => {
    expect(gameAspectFromRect({ width: 800, height: 450 }, 1)).toBeCloseTo(800 / 450, 6);
  });
  it('falls back when the rect is unmeasured (zero w/h)', () => {
    expect(gameAspectFromRect({ width: 0, height: 0 }, 16 / 9)).toBeCloseTo(16 / 9, 6);
    expect(gameAspectFromRect({ width: 100, height: 0 }, 2)).toBe(2);
  });
  it('agrees with the render-side letterbox: picking + scissor see the same aspect', () => {
    // F11 regression guard — picking NDC and the render scissor both derive their
    // aspect from gameAspectFromRect(gameRect, …), so they can't disagree.
    const rect = { width: 600, height: 800 };
    const aspect = gameAspectFromRect(rect, 1);
    const lb = computeLetterbox(1000, 1000, aspect, true);
    // A click at the letterbox center maps to NDC (0,0) under the same aspect.
    const ndc = computeUIModeNDC(
      lb.vpX + lb.vpW / 2, lb.vpY + lb.vpH / 2,
      { left: 0, top: 0, width: 1000, height: 1000 }, aspect,
    );
    expect(ndc.x).toBeCloseTo(0, 6);
    expect(ndc.y).toBeCloseTo(0, 6);
  });
});

describe('createSelectGesture (viewport click vs. camera drag)', () => {
  // REGRESSION 1: a camera pan/orbit that STARTS on empty space (left-drag) used to clear the
  // selection because the deselect fired on pointer-DOWN.
  // REGRESSION 2: the same drag started OVER an entity used to SELECT that entity, because a
  // hit selected immediately on pointer-DOWN. Orbiting the camera with the cursor over
  // geometry — the common case, since the model fills the viewport — kept stealing selection.
  // Both now defer to pointer-up and are cancelled by any drag past the threshold.
  it('a plain click on an entity commits that selection', () => {
    const g = createSelectGesture();
    g.arm(100, 100, 42);
    expect(g.isArmed()).toBe(true);
    expect(g.release()).toEqual({ clicked: true, entityId: 42 });
  });

  it('a plain empty-space click (press → release, no move) commits the deselect', () => {
    const g = createSelectGesture();
    g.arm(100, 100, null);
    expect(g.release()).toEqual({ clicked: true, entityId: null }); // clicked nothing → deselect
  });

  it('a drag past the threshold starting ON an entity keeps the previous selection', () => {
    const g = createSelectGesture();
    g.arm(100, 100, 42);                      // press landed on entity 42…
    g.move(100 + DESELECT_DRAG_PX + 1, 100);  // …but the pointer travelled → it was an orbit
    expect(g.isArmed()).toBe(false);
    expect(g.release()).toEqual({ clicked: false, entityId: null }); // caller selects nothing
  });

  it('a drag past the threshold starting on empty space keeps the selection', () => {
    const g = createSelectGesture();
    g.arm(100, 100, null);
    g.move(100 + DESELECT_DRAG_PX + 1, 100);
    expect(g.release().clicked).toBe(false); // → caller keeps the selection
  });

  it('sub-threshold jitter does NOT cancel — a shaky click still selects', () => {
    const g = createSelectGesture();
    g.arm(100, 100, 7);
    g.move(101, 102); // hypot ≈ 2.24 < 4
    expect(g.release()).toEqual({ clicked: true, entityId: 7 });
  });

  it('release is one-shot: a second release does not re-fire', () => {
    const g = createSelectGesture();
    g.arm(0, 0, 3);
    expect(g.release().clicked).toBe(true);
    expect(g.release()).toEqual({ clicked: false, entityId: null }); // disarmed after the first
  });

  it('reset (gizmo drag / non-left button) disarms so no selection change happens on release', () => {
    const g = createSelectGesture();
    g.arm(50, 50, 9);
    g.reset();
    expect(g.isArmed()).toBe(false);
    expect(g.release().clicked).toBe(false);
  });

  it('move without arming is a no-op', () => {
    const g = createSelectGesture();
    g.move(500, 500);
    expect(g.isArmed()).toBe(false);
    expect(g.release().clicked).toBe(false);
  });

  it('honors a custom threshold', () => {
    const g = createSelectGesture(20);
    g.arm(0, 0, 1);
    g.move(15, 0);          // within 20 → still a click
    expect(g.isArmed()).toBe(true);
    g.move(25, 0);          // beyond 20 → drag
    expect(g.isArmed()).toBe(false);
  });
});

describe('outlineSourceGeometry', () => {
  it('returns a plain mesh\'s own geometry (Renderable3DPrimitive)', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    expect(outlineSourceGeometry(new THREE.Mesh(geo))).toBe(geo);
  });

  it('digs the level-0 geometry out of a THREE.LOD (imported model with baked LODs)', () => {
    // A model with modelCache.lodPaths — even a single level — is built as a THREE.LOD,
    // which has no `geometry` of its own. Guarding on `obj.geometry` alone silently drops
    // the selection outline for every such model.
    const lod = new THREE.LOD();
    const hi = new THREE.BoxGeometry(1, 1, 1);
    const lo = new THREE.BoxGeometry(2, 2, 2);
    lod.addLevel(new THREE.Mesh(hi), 0);
    lod.addLevel(new THREE.Mesh(lo), 50);
    expect(outlineSourceGeometry(lod)).toBe(hi);
  });

  it('handles a single-level LOD (lodCount: 1 — the tropical-island case)', () => {
    const lod = new THREE.LOD();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    lod.addLevel(new THREE.Mesh(geo), 0);
    expect(outlineSourceGeometry(lod)).toBe(geo);
  });

  it('returns undefined for geometry-less pivots and for null', () => {
    // Camera/Light/Environment gizmos are bare Object3D pivots; a positionless
    // EdgesGeometry makes WebGPU's NodeMaterial spam every frame. Children are NOT
    // traversed, so a pivot's icon mesh must not leak out as an outline source.
    const pivot = new THREE.Object3D();
    pivot.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(outlineSourceGeometry(pivot)).toBeUndefined();
    expect(outlineSourceGeometry(new THREE.LOD())).toBeUndefined();
    expect(outlineSourceGeometry(null)).toBeUndefined();
  });
});

describe('resolveFocusTarget (F-key framing tiers)', () => {
  /** A unit box mesh centered at (x,y,z), world matrix already updated. */
  function boxAt(x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    m.position.set(x, y, z);
    m.updateWorldMatrix(true, true);
    return m;
  }

  it('frames the UNION of the subtree meshes, not just the first', () => {
    // The motivating case: a mesh-less group whose children hold all the geometry.
    // Two unit cubes at x=-2 and x=+2 → union spans x ∈ [-2.5, 2.5], centered at origin.
    const t = resolveFocusTarget([boxAt(-2, 0, 0), boxAt(2, 0, 0)], [], null)!;
    expect(t.center.x).toBeCloseTo(0, 5);
    expect(t.radius).toBeCloseTo(new THREE.Vector3(5, 1, 1).length() * 0.5, 5);
  });

  it('a single mesh frames its own box', () => {
    const t = resolveFocusTarget([boxAt(3, 0, 0)], [], null)!;
    expect(t.center.toArray()).toEqual([3, 0, 0]);
    expect(t.radius).toBeCloseTo(new THREE.Vector3(1, 1, 1).length() * 0.5, 5);
  });

  it('clamps a degenerate (flat) box to a non-zero radius', () => {
    // A plane has zero thickness; radius 0 would collapse the camera near/far.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(0, 0));
    plane.updateWorldMatrix(true, true);
    expect(resolveFocusTarget([plane], [], null)!.radius).toBeGreaterThan(0);
  });

  it('falls back to gizmos when the subtree has no mesh', () => {
    const g = new THREE.Object3D();
    g.position.set(0, 5, 0);
    g.updateWorldMatrix(true, true);
    const t = resolveFocusTarget([], [g], null)!;
    expect(t.center.toArray()).toEqual([0, 5, 0]);
    expect(t.radius).toBe(FOCUS_DEFAULT_RADIUS);
  });

  it('averages multiple gizmo positions', () => {
    const a = new THREE.Object3D(); a.position.set(-1, 0, 0); a.updateWorldMatrix(true, true);
    const b = new THREE.Object3D(); b.position.set(3, 0, 0); b.updateWorldMatrix(true, true);
    expect(resolveFocusTarget([], [a, b], null)!.center.x).toBeCloseTo(1, 5);
  });

  it('a mesh WINS over a gizmo — a light icon must not inflate a real box', () => {
    const giz = new THREE.Object3D(); giz.position.set(100, 100, 100); giz.updateWorldMatrix(true, true);
    const t = resolveFocusTarget([boxAt(0, 0, 0)], [giz], null)!;
    expect(t.center.toArray()).toEqual([0, 0, 0]); // gizmo ignored entirely
  });

  it('falls back to the entity world position when there is no mesh and no gizmo', () => {
    const t = resolveFocusTarget([], [], new THREE.Vector3(7, 8, 9))!;
    expect(t.center.toArray()).toEqual([7, 8, 9]);
    expect(t.radius).toBe(FOCUS_DEFAULT_RADIUS);
  });

  it('does not alias the fallback vector (caller keeps ownership)', () => {
    const fallback = new THREE.Vector3(1, 2, 3);
    const t = resolveFocusTarget([], [], fallback)!;
    t.center.set(9, 9, 9);
    expect(fallback.toArray()).toEqual([1, 2, 3]);
  });

  it('returns null when there is nothing to frame at all', () => {
    expect(resolveFocusTarget([], [], null)).toBeNull();
  });
});
