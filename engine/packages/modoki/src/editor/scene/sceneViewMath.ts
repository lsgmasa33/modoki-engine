/** Pure viewport math extracted from SceneView's ~920-line render effect (editor-sceneview
 *  F4) so it's independently unit-testable. No three/webgpu, no DOM, no closure capture —
 *  only core `three` math + plain numbers. SceneView calls these; the orchestration effect
 *  keeps the side effects (geometry.needsUpdate, controls.update, renderer.setScissor). */

import * as THREE from 'three';

/** Letterbox viewport rect (in CSS px from the container's top-left) that fits `gameAspect`
 *  inside a `cW × cH` container, centered. Shared by UI-mode picking (NDC remap) and the
 *  render-side scissor so they can never drift. `round` snaps to integers for the renderer
 *  (the picking path uses exact floats). */
export function computeLetterbox(
  cW: number,
  cH: number,
  gameAspect: number,
  round = false,
): { vpX: number; vpY: number; vpW: number; vpH: number } {
  const containerAspect = cW / cH;
  const r = round ? Math.round : (n: number) => n;
  let vpW: number, vpH: number, vpX: number, vpY: number;
  // Dimensions are rounded BEFORE centering so vpX/vpY derive from the integer extent
  // (matches the renderer's original scissor math exactly — no ±1px center drift).
  if (containerAspect > gameAspect) {
    vpH = cH; vpW = r(cH * gameAspect);
    vpX = r((cW - vpW) / 2); vpY = 0;
  } else {
    vpW = cW; vpH = r(cW / gameAspect);
    vpX = 0; vpY = r((cH - vpH) / 2);
  }
  return { vpX, vpY, vpW, vpH };
}

/** GameView device-preset letterbox: fit a `deviceW × deviceH` logical device inside the
 *  `pw × ph` game area, centered, snapping the scaled extent to integers. Returns the visual
 *  rect (CSS px from the area's top-left) that GameView writes to the store and SceneView's
 *  overlay/picking reads back. Free mode (deviceW/deviceH = 0) yields a zero rect. */
export function computeDeviceLetterbox(
  pw: number,
  ph: number,
  deviceW: number,
  deviceH: number,
): { left: number; top: number; width: number; height: number } {
  if (deviceW <= 0 || deviceH <= 0 || pw <= 0 || ph <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(pw / deviceW, ph / deviceH);
  const w = Math.round(deviceW * scale);
  const h = Math.round(deviceH * scale);
  return { left: Math.round((pw - w) / 2), top: Math.round((ph - h) / 2), width: w, height: h };
}

/** Resolve the effective device dimensions for a preset under an orientation. Portrait keeps
 *  the preset's authored (width, height); landscape swaps them. */
export function resolveDeviceSize(
  presetW: number,
  presetH: number,
  orientation: 'portrait' | 'landscape',
): { deviceW: number; deviceH: number } {
  return orientation === 'portrait'
    ? { deviceW: presetW, deviceH: presetH }
    : { deviceW: presetH, deviceH: presetW };
}

/** The single source of truth for the UI-mode letterbox aspect ratio (F11): prefer the measured
 *  `gameRect` (what GameView is actually rendering), else a fallback aspect (the game-view default
 *  size). Used by the gameCam projection, the render-side scissor, the overlay letterbox, and
 *  picking so they can never disagree. */
export function gameAspectFromRect(
  rect: { width: number; height: number },
  fallbackAspect: number,
): number {
  return rect.width > 0 && rect.height > 0 ? rect.width / rect.height : fallbackAspect;
}

/** Map a pointer event to normalized device coords (-1..1) inside the UI-mode letterboxed
 *  viewport (the 3D render is letterboxed to `gameAspect`, not the full canvas). */
export function computeUIModeNDC(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  gameAspect: number,
): { x: number; y: number } {
  const { vpX, vpY, vpW, vpH } = computeLetterbox(rect.width, rect.height, gameAspect);
  return {
    x: ((clientX - rect.left - vpX) / vpW) * 2 - 1,
    y: -((clientY - rect.top - vpY) / vpH) * 2 + 1,
  };
}

/** Default press→release travel (CSS px) under which a press counts as a click (a selection
 *  change) rather than a drag (camera pan/orbit — keep the current selection). */
export const DESELECT_DRAG_PX = 4;

/** EVERY left-press in the viewport is ambiguous, whether or not it hits an entity: a plain
 *  click means "select what's under the cursor" (nothing → deselect), while a press that
 *  travels means "orbit/pan the camera" and must leave the selection exactly as it was. The
 *  camera is dragged with the same button over the same pixels as a pick, so the two are
 *  indistinguishable until the gesture ENDS.
 *
 *  So the selection change is deferred to pointer-up: arm on press with the picked entity
 *  (`null` = empty space → deselect), cancel once the pointer leaves the drag threshold, and
 *  commit only on a release that was still a click. Selecting a HIT entity on press instead
 *  would re-select whatever the user happened to start an orbit over — which is exactly the
 *  bug this replaced.
 *
 *  Deferring costs nothing: an already-selected entity's gizmo is grabbed by the capture-phase
 *  handler before this runs, and a press on an UNSELECTED entity could never grab a gizmo that
 *  doesn't exist yet, so there is no "select on press → immediate gizmo grab" to preserve.
 *
 *  Pure + closure-free so SceneView's pointer wiring is unit-testable (mirrors the
 *  createViewportDirtyGate factory pattern). */
export interface SelectGesture {
  /** Press → arm a pending selection at the press point. `entityId` is the pick result:
   *  an id to select, or `null` for empty space (deselect). */
  arm(x: number, y: number, entityId: number | null): void;
  /** New gesture / non-selecting press (gizmo drag, non-left button) → drop any pending change. */
  reset(): void;
  /** Pointer moved → cancel the pending change once it leaves the drag threshold (= a camera move). */
  move(x: number, y: number): void;
  /** Pointer up → `clicked` iff still armed (a plain click); caller then selects `entityId`. */
  release(): { clicked: boolean; entityId: number | null };
  /** Diagnostics/tests: is a selection change currently pending? */
  isArmed(): boolean;
}

export function createSelectGesture(thresholdPx: number = DESELECT_DRAG_PX): SelectGesture {
  let pending: { x: number; y: number; entityId: number | null } | null = null;
  return {
    arm: (x, y, entityId) => { pending = { x, y, entityId }; },
    reset: () => { pending = null; },
    move: (x, y) => {
      if (pending && Math.hypot(x - pending.x, y - pending.y) > thresholdPx) pending = null;
    },
    release: () => {
      const r = { clicked: pending !== null, entityId: pending?.entityId ?? null };
      pending = null;
      return r;
    },
    isArmed: () => pending !== null,
  };
}

/** Map a pointer event to NDC against the full canvas (non-UI / 3D orbit mode). */
export function computeFullNDC(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

/** Fill `out` (96 floats = 16 line segments × 2 endpoints × 3) with a camera frustum
 *  wireframe in the camera's local space: near rect, far rect, the 4 connectors, and the
 *  4 apex rays from the origin to the near corners. Caller flags the geometry dirty. */
export function computeCamFrustumPositions(
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
  out: Float32Array,
): void {
  const fovRad = (fovDeg * Math.PI) / 180;
  const tanHalf = Math.tan(fovRad / 2);
  const nh = near * tanHalf;
  const nw = nh * aspect;
  const fh = far * tanHalf;
  const fw = fh * aspect;
  // 8 corners: near TL/TR/BR/BL then far TL/TR/BR/BL
  const c = [
    [-nw,  nh, -near], [ nw,  nh, -near], [ nw, -nh, -near], [-nw, -nh, -near],
    [-fw,  fh, -far ], [ fw,  fh, -far ], [ fw, -fh, -far ], [-fw, -fh, -far ],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],   // near rect
    [4, 5], [5, 6], [6, 7], [7, 4],   // far rect
    [0, 4], [1, 5], [2, 6], [3, 7],   // connectors
  ];
  let o = 0;
  for (const [a, b] of edges) {
    out[o++] = c[a][0]; out[o++] = c[a][1]; out[o++] = c[a][2];
    out[o++] = c[b][0]; out[o++] = c[b][1]; out[o++] = c[b][2];
  }
  // Apex rays from origin to the near corners (4 segments)
  for (let i = 0; i < 4; i++) {
    out[o++] = 0; out[o++] = 0; out[o++] = 0;
    out[o++] = c[i][0]; out[o++] = c[i][1]; out[o++] = c[i][2];
  }
}

/** Frame `center`/`radius` in the orbit camera, preserving the current viewing direction
 *  (from `target` → `camera.position`). Degenerate direction falls back to a default angle.
 *  Mutates `camera` (position/near/far/projection) and `target`; the caller runs
 *  `controls.update()` afterward. Pure w.r.t. the DOM — testable with a real
 *  PerspectiveCamera + a Vector3 target. */
export function frameCameraToBox(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  distMul = 2.8,
): void {
  const dir = new THREE.Vector3().subVectors(camera.position, target);
  if (dir.lengthSq() < 1e-6) dir.set(1, 0.75, 1); // degenerate → default angle
  dir.normalize();
  const dist = radius * distMul;
  target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.01, radius / 50);
  camera.far = Math.max(500, radius * 100);
  camera.updateProjectionMatrix();
}

/** Fixed-angle box fit for the standalone model thumbnail (`ModelPreview`): frames
 *  `center`/`diag` (the bounding-box *diagonal length*, not a radius) from a constant
 *  down-the-corner direction, so the preview's Reset always returns to the same
 *  canonical view. This intentionally differs from {@link frameCameraToBox}, which
 *  preserves the user's current orbit direction (right for the live viewport, wrong
 *  for a thumbnail "reset"). Shared by `ModelPreview`'s initial-frame and Reset paths
 *  (was duplicated). Mutates `camera` (position/near/far/projection) + `target`; the
 *  caller runs `controls.update()` afterward. */
export function frameCameraToBoxFixed(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  center: THREE.Vector3,
  diag: number,
): void {
  const dist = diag * 1.4;
  camera.position.set(center.x + dist, center.y + dist * 0.6, center.z + dist);
  target.copy(center);
  camera.near = Math.max(0.01, diag / 100);
  camera.far = Math.max(100, diag * 50);
  camera.updateProjectionMatrix();
}

// ── Orientation-gizmo view snapping (SceneViewGizmo) ─────────────────────────

/** The six canonical view directions the corner gizmo snaps to, as the OFFSET from the
 *  orbit target toward the camera (so the camera looks back down `-dir`). RGB-signed:
 *  +X/+Y/+Z are the solid cones, negatives the hollow ones. `label` names the resulting
 *  view (clicking +Y looks straight DOWN, i.e. the "Top" view). */
export const GIZMO_AXES: { name: string; label: string; dir: readonly [number, number, number] }[] = [
  { name: '+x', label: 'Right',  dir: [1, 0, 0] },
  { name: '-x', label: 'Left',   dir: [-1, 0, 0] },
  { name: '+y', label: 'Top',    dir: [0, 1, 0] },
  { name: '-y', label: 'Bottom', dir: [0, -1, 0] },
  { name: '+z', label: 'Front',  dir: [0, 0, 1] },
  { name: '-z', label: 'Back',   dir: [0, 0, -1] },
];

/** Camera position that looks straight down `dir` at `target` from `distance` away —
 *  `target + normalize(dir) * distance`. Pure; used as the snap-tween end position (the
 *  distance is the CURRENT orbit distance, so a snap only rotates the view). A degenerate
 *  `dir` falls back to +Z so the result is always finite. */
export function axisSnapCameraPosition(
  target: THREE.Vector3,
  dir: THREE.Vector3,
  distance: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const d = out.copy(dir);
  if (d.lengthSq() < 1e-12) d.set(0, 0, 1);
  d.normalize();
  return d.multiplyScalar(distance).add(target);
}

/** Constant-distance interpolation of a camera OFFSET (position − target) from `from` to
 *  `to`: slerp the direction on the unit sphere, lerp the magnitude. Keeps the camera on
 *  an arc around the target (no dip through it) even when `from`/`to` point oppositely.
 *  `t` is clamped to [0,1]. Near-antipodal inputs (dot ≈ −1) pick a stable perpendicular
 *  axis so the arc is still well-defined. Returns `out`. */
export function slerpCameraOffset(
  from: THREE.Vector3,
  to: THREE.Vector3,
  t: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  const lenFrom = from.length();
  const lenTo = to.length();
  const len = lenFrom + (lenTo - lenFrom) * tc;
  const a = _tmpA.copy(from).normalize();
  const b = _tmpB.copy(to).normalize();
  let dot = a.dot(b);
  dot = dot < -1 ? -1 : dot > 1 ? 1 : dot;
  if (dot > 0.9995) {
    // Nearly parallel — plain lerp + renormalize avoids a divide-by-tiny-sin.
    out.copy(a).lerp(b, tc).normalize();
    return out.multiplyScalar(len);
  }
  if (dot < -0.9995) {
    // Antipodal — no unique arc; sweep `a` toward `-a` THROUGH a stable perpendicular axis.
    // The total angle a→−a is π (the perpendicular is only the halfway point), so θ MUST run
    // to π at t=1 — using acos(0)=π/2 here would land the tween on the perpendicular axis
    // instead of the clicked (opposite) one. `rel` is the perpendicular unit itself.
    const perp = Math.abs(a.x) < 0.9 ? _tmpP.set(1, 0, 0) : _tmpP.set(0, 1, 0);
    const rel = _tmpR.copy(perp).addScaledVector(a, -a.dot(perp)).normalize();
    const theta = Math.PI * tc;
    out.copy(a).multiplyScalar(Math.cos(theta)).addScaledVector(rel, Math.sin(theta));
    return out.multiplyScalar(len);
  }
  const theta = Math.acos(dot) * tc;
  // Gram–Schmidt: component of b perpendicular to a, then rotate a by theta toward it.
  const rel = _tmpR.copy(b).addScaledVector(a, -dot).normalize();
  out.copy(a).multiplyScalar(Math.cos(theta)).addScaledVector(rel, Math.sin(theta));
  return out.multiplyScalar(len);
}
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpP = new THREE.Vector3();
const _tmpR = new THREE.Vector3();

// ── Perspective ↔ orthographic frustum matching (editor-camera projection toggle) ──

/** Vertical half-height of a perspective frustum at `dist` from the camera:
 *  `dist * tan(fov/2)`. `fovDeg` is the THREE vertical FOV in degrees. Used to size an
 *  ortho frustum so toggling to ortho keeps the same on-screen extent at the orbit pivot. */
export function perspHalfHeightAtDistance(fovDeg: number, dist: number): number {
  return dist * Math.tan((fovDeg * Math.PI) / 360); // (fov/2) in radians
}

/** Inverse of {@link perspHalfHeightAtDistance}: the distance at which a perspective camera
 *  of `fovDeg` shows `halfH` of vertical half-height. Used on ortho→persp toggle to place the
 *  perspective camera so the extent matches. Guards a degenerate ~0 FOV. */
export function perspDistanceForHalfHeight(fovDeg: number, halfH: number): number {
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return t > 1e-6 ? halfH / t : halfH;
}

/** Ortho frustum extents for a given vertical `halfH` and viewport `aspect` (w/h), centered.
 *  `zoom` stays 1; OrbitControls dolly then drives `camera.zoom`. */
export function orthoFrustumForHalfHeight(halfH: number, aspect: number): {
  top: number; bottom: number; left: number; right: number;
} {
  const halfW = halfH * aspect;
  return { top: halfH, bottom: -halfH, left: -halfW, right: halfW };
}

/** Project a world-space axis direction into the corner gizmo's 2D face, as seen from a
 *  camera with orientation `camQuat`. Transforms `dir` into camera space (inverse of the
 *  camera rotation): `x` is right, `y` is up (SVG callers flip it), `depth` is toward the
 *  viewer (larger = nearer the front → draw on top). All components are in [-1, 1] for a
 *  unit `dir`. Pure — a plain quaternion in, plain numbers out; unit-testable without a
 *  renderer. */
export function projectGizmoAxis(
  dir: THREE.Vector3,
  camQuat: THREE.Quaternion,
): { x: number; y: number; depth: number } {
  // Camera looks down its local −Z, so a world axis whose camera-space z is POSITIVE points
  // back toward the viewer (in front of the gizmo face). Invert the camera rotation to bring
  // the world axis into camera space.
  const v = _tmpA.copy(dir).applyQuaternion(_tmpQ.copy(camQuat).invert());
  return { x: v.x, y: v.y, depth: v.z };
}
const _tmpQ = new THREE.Quaternion();

/** The geometry to edge the viewport outlines from, for the object a selected entity resolves
 *  to: the yellow selection outline and a convex/trimesh Collider3D's green wireframe.
 *
 *  A primitive (`Renderable3DPrimitive`) is a plain `THREE.Mesh` — its own `geometry`.
 *  An imported mesh whose model has baked LODs is a `THREE.LOD`, which carries NO
 *  `geometry` of its own; the geometry lives on its level meshes, so take level 0 (the
 *  highest-detail one). A model is built as a `THREE.LOD` whenever its `.meta.json` has a
 *  non-empty `modelCache.lodPaths` — including the `lodCount: 1` case, which looks like a
 *  plain mesh but isn't. Missing that made every LOD-processed model lose its outline.
 *
 *  Returns undefined for geometry-less pivots (Camera/Light/Environment gizmos): feeding
 *  those to EdgesGeometry yields a positionless BufferGeometry that makes WebGPU's
 *  NodeMaterial spam "AttributeNode: Vertex attribute 'position' not found" every frame.
 *  Deliberately does NOT traverse children, so those pivots' icon meshes stay unoutlined. */
export function outlineSourceGeometry(
  obj: THREE.Object3D | null | undefined,
): THREE.BufferGeometry | undefined {
  if (!obj) return undefined;
  const own = (obj as THREE.Mesh).geometry;
  if (own) return own;
  if ((obj as THREE.LOD).isLOD) {
    return ((obj as THREE.LOD).levels[0]?.object as THREE.Mesh | undefined)?.geometry;
  }
  return undefined;
}

/** Radius framed when an entity has nothing to measure — no mesh anywhere in its subtree
 *  and no gizmo. Roughly "one unit cube", so F on an empty lands at a workable distance
 *  instead of slamming the near plane into it. */
export const FOCUS_DEFAULT_RADIUS = 1;

/** What the F-key frames for one entity, in priority order:
 *
 *   1. **Meshes** — the union world-AABB of the entity's own renderable AND every
 *      renderable in its subtree. A group like an imported model's root carries no
 *      geometry itself; framing only its own (empty) box, or bailing because it has no
 *      object at all, is why F used to do nothing on it.
 *   2. **Gizmos** — nothing renderable in the subtree, so fall back to the union of the
 *      entity's (and its subtree's) gizmo pivots: a light, camera, or zone still has a
 *      position worth flying to. Framed as a small sphere, since a gizmo's on-screen size
 *      is a fixed icon, not a world extent.
 *   3. **Default** — no mesh, no gizmo (a bare empty): frame `fallbackCenter` (the
 *      entity's world position) at {@link FOCUS_DEFAULT_RADIUS}.
 *
 *  Gizmos are deliberately excluded from step 1: a light's icon geometry would otherwise
 *  inflate a real mesh's box, and an empty parenting one light would frame the icon rather
 *  than report "nothing to measure". Returns null only when there is nothing to frame at
 *  all — i.e. `fallbackCenter` is null and the first two tiers came up empty.
 *
 *  Objects must already have world matrices updated; the caller owns that. */
export function resolveFocusTarget(
  meshObjects: THREE.Object3D[],
  gizmoObjects: THREE.Object3D[],
  fallbackCenter: THREE.Vector3 | null,
  defaultRadius = FOCUS_DEFAULT_RADIUS,
): { center: THREE.Vector3; radius: number } | null {
  const box = new THREE.Box3();
  for (const o of meshObjects) box.union(new THREE.Box3().setFromObject(o));
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    // Guard the degenerate flat/point box (a plane, a single vertex) so near/far stay sane.
    return { center, radius: Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.01) };
  }
  if (gizmoObjects.length > 0) {
    // Average the gizmo positions — for a lone gizmo that IS its position.
    const center = new THREE.Vector3();
    for (const g of gizmoObjects) center.add(g.getWorldPosition(new THREE.Vector3()));
    center.divideScalar(gizmoObjects.length);
    return { center, radius: defaultRadius };
  }
  if (fallbackCenter) return { center: fallbackCenter.clone(), radius: defaultRadius };
  return null;
}
