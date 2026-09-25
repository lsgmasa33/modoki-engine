/** Aim points for the 3D transform gizmo's axis handles — the geometry behind `modoki_handles`
 *  (`gizmo3d:*`) and therefore behind every agent-driven `modoki_drag_handle` on a 3D gizmo.
 *
 *  Extracted from `SceneView.tsx` deliberately, for the same reason as `gizmoBounds.ts`: a panel
 *  holds JSX, hooks and imperative wiring, and its DECISIONS belong in a plain `.ts` module beside
 *  it where a unit test can reach them (docs/editor.md § Panels).
 *
 *  ## Why a fixed pixel offset cannot work for ANY of them
 *
 *  three.js `TransformControls` owns its own pickable geometry, so we cannot report its exact
 *  handle rects — we project BEST-EFFORT aim points instead. Those points used to be a fixed screen
 *  offset (52 px for a translate/scale arrow, 66 px for a rotate ring), and a constant is wrong for
 *  a reason no camera distance reveals: the gizmo is scaled to hold a constant size in the
 *  RENDERER'S OWN VIEWPORT, so its screen size in px scales with the PANEL, not with the window. In
 *  the default dock the Scene canvas is small, and a constant sized for a large one overshoots.
 *
 *  Measured 2026-08-19 on games/3d-test (Scene canvas 366x227, cube at distance 27.0, gizmo world
 *  scale 8.976 — matching `gizmoWorldScale` exactly): raycasting three's own picker along the X
 *  axis's screen direction hits `X` from ~10 px out to ~45 px and returns NOTHING at 52 px. The
 *  aim sat past the arrow's tip, the press fell through to the viewport background, and the drag
 *  ORBITED THE CAMERA — (12, 15, 20) -> (-21.0, 15.0, 10.1) — while `modoki_drag_handle` answered
 *  ok:true. A miss over empty viewport also MARQUEE-SELECTS, so it can silently replace the
 *  selection and make the NEXT drag move the wrong entities.
 *
 *  So every axis aim is now derived from the picker's real geometry (`AXIS_PICKER_CENTER`), and
 *  every ring from its real radius (`ROTATE_RING_RADIUS`), through three's own handle scale.
 *
 *  A **rotate ring** was the worst case of the same thing. Its picker is `TorusGeometry(0.5, 0.1)` — a thin
 *  tube on a circle of radius 0.5 gizmo-units, i.e. an annulus and nothing inside it. The old code
 *  aimed at a fixed 66 px, which is INSIDE the ring at every camera distance: the press missed the torus
 *  entirely, fell through to the viewport background, and **orbited the SceneView camera** instead
 *  of rotating anything. Measured 2026-08-19 on games/anim-bug: a `gizmo3d:rotate:x` drag on `Sun`
 *  left rx/ry/rz byte-identical, emitted zero journal events, and moved the camera from
 *  (12, 15, 20) to (-21.4, 14.9, 9.5) — testboard bug zBgcNtw2HLyXwT9lMEe4.
 *
 *  So the rotate aim is computed from the ring's ACTUAL world radius (`gizmoWorldScale()` reproduces
 *  three's own `factor * size / 4`) rather than guessed in pixels.
 *
 *  ## Why the aim point is a 45° diagonal
 *
 *  The three rings pairwise INTERSECT on the axes: the X ring (the YZ plane) and the Z ring (the XY
 *  plane) both pass through +Y at radius R. Aiming straight along a perpendicular axis therefore
 *  aims at a point where two pickers coincide, and which one the raycast returns is luck. A 45°
 *  bisector inside the ring's own plane is on exactly one ring.
 */

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The subset of THREE.Vector3 this module needs, so a test can hand in plain objects. */
const v = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const add = (a: Vec3Like, b: Vec3Like, s = 1): Vec3Like => v(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
const sub = (a: Vec3Like, b: Vec3Like): Vec3Like => v(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a: Vec3Like): number => Math.hypot(a.x, a.y, a.z);

/** A camera, structurally — perspective (fov/zoom) or orthographic (top/bottom/zoom). Deliberately
 *  not `THREE.Camera`: this mirrors three's own `updateMatrixWorld` branch and a test should be able
 *  to state a camera as four numbers. */
export interface GizmoCameraLike {
  isOrthographicCamera?: boolean;
  fov?: number;
  zoom?: number;
  top?: number;
  bottom?: number;
}

/** The world-space scale three.js applies to every gizmo handle, reproduced EXACTLY from
 *  `TransformControls.js`'s `updateMatrixWorld`:
 *
 *  ```js
 *  factor = ortho ? (camera.top - camera.bottom) / camera.zoom
 *                 : worldPosition.distanceTo(cameraPosition) *
 *                   Math.min(1.9 * Math.tan(Math.PI * camera.fov / 360) / camera.zoom, 7);
 *  handle.scale.setScalar(factor * this.size / 4);
 *  ```
 *
 *  Multiply a gizmo-local dimension (ring radius 0.5, arrow tip 0.5, picker cone centre 0.3) by this
 *  to get its size in WORLD units. Keep it in step with three on upgrade — a drifted formula is
 *  exactly the class of bug this module exists to fix.
 */
export function gizmoWorldScale(camera: GizmoCameraLike, cameraPos: Vec3Like, origin: Vec3Like, size: number): number {
  const zoom = camera.zoom ?? 1;
  const factor = camera.isOrthographicCamera
    ? ((camera.top ?? 1) - (camera.bottom ?? -1)) / zoom
    : len(sub(origin, cameraPos)) * Math.min((1.9 * Math.tan((Math.PI * (camera.fov ?? 50)) / 360)) / zoom, 7);
  return (factor * size) / 4;
}

/** three's rotate-ring picker: `TorusGeometry(0.5, 0.1, 4, 24)` — radius 0.5 in gizmo-local units. */
export const ROTATE_RING_RADIUS = 0.5;

/** Centre of three's translate/scale AXIS picker along its axis: `CylinderGeometry(0.2, 0, 0.6)`
 *  positioned at 0.3, i.e. a cone spanning 0 → 0.6 gizmo-units. Aiming at its middle is the most
 *  forgiving point, and it is identical for translate and scale (`pickerTranslate`/`pickerScale`). */
export const AXIS_PICKER_CENTER = 0.3;

/** three hides an axis handle — and collapses its picker to a 1e-10 scale — when the axis points
 *  within ~8° of the view direction (`AXIS_HIDE_THRESHOLD = 0.99` in `TransformControls.js`). There
 *  is then nothing to press, so publishing an aim for it would be a handle that cannot work. */
export const AXIS_HIDE_DOT = 0.99;

export interface AxisPickAimOpts {
  origin: Vec3Like;
  /** Unit axis in the gizmo's basis (world axes for `space:'world'`, the object's for `'local'`). */
  dir: Vec3Like;
  /** `AXIS_PICKER_CENTER * gizmoWorldScale(...)` — how far along the axis to press, in world units. */
  offsetWorld: number;
  /** Unit vector from the gizmo origin toward the camera — three's `eye`. Used for the hide test. */
  eye: Vec3Like;
  project: (p: Vec3Like) => { x: number; y: number; z: number };
  reachable?: (p: { x: number; y: number }) => boolean;
  /** Would a press here select THIS axis's picker? `true`/`false`, or `null` when the caller cannot
   *  tell (three's internal picker unreadable). The axis cones are fat — `CylinderGeometry(0.2, 0,
   *  0.6)`, both ends — so under an oblique camera a ray at one axis's cone can cross a NEIGHBOUR's
   *  first, and the drag then moves the neighbour's axis. Measured 2026-09-25 (#1570, SceneView
   *  'ui', tropical-island's cube, world space): the published `translate:x` point dragged the cube
   *  along z only. The same class `picksUniform` guards on the scale centre. */
  picksAxis?: (p: { x: number; y: number }) => boolean | null;
}

/** Where along the cone to try, as multiples of `offsetWorld` (the cone's middle, 0.3). The cone
 *  WIDENS toward its far end (radius 0 at the origin, 0.2 at 0.6), so the outer samples are the
 *  fatter, more forgiving ones; the inner one gives a steep view a point clear of the far end. */
const AXIS_SAMPLE_FRACTIONS = [1, 1.5, 0.6] as const;

/** Where to press for a translate/scale AXIS handle. Both directions of the axis carry a picker
 *  (three builds `+0.3` and `-0.3` cones), so this returns whichever projects better — preferring
 *  one the canvas actually owns, then the one further from the crowded centre. Null when three has
 *  hidden the axis, or when neither end projects on screen. */
export function axisPickAim(opts: AxisPickAimOpts): { x: number; y: number; world: Vec3Like } | null {
  const { origin, dir, offsetWorld, eye, project, reachable, picksAxis } = opts;
  if (Math.abs(dir.x * eye.x + dir.y * eye.y + dir.z * eye.z) > AXIS_HIDE_DOT) return null;
  const oC = project(origin);
  // Ranked, most important first: a press that selects THIS axis (2), cannot tell (1), selects
  // another (0) — a covered point on the right axis is a loud refusal, a free one on the wrong
  // axis is a silent wrong edit, so this outranks reachability exactly as `picksUniform` does. Then
  // reachable, then the cone centre (the extra samples exist only to find the axis, not to move a
  // point that was already fine), then the further from the crowded centre.
  type Cand = { x: number; y: number; world: Vec3Like; own: number; free: boolean; centre: boolean; sep: number };
  const better = (a: Cand, b: Cand) => a.own !== b.own ? a.own > b.own
    : a.free !== b.free ? a.free
      : a.centre !== b.centre ? a.centre
        : a.sep > b.sep;
  let best: Cand | null = null;
  for (const frac of AXIS_SAMPLE_FRACTIONS) {
    for (const sign of [1, -1]) {
      const world = add(origin, dir, offsetWorld * frac * sign);
      const p = project(world);
      if (p.z > 1 || p.z < -1) continue;
      const picks = picksAxis ? picksAxis(p) : null;
      const cand: Cand = {
        x: p.x, y: p.y, world,
        own: picks === true ? 2 : picks === null ? 1 : 0,
        free: reachable ? reachable(p) : true,
        centre: frac === 1,
        sep: Math.hypot(p.x - oC.x, p.y - oC.y),
      };
      if (!best || better(cand, best)) best = cand;
    }
  }
  // Every grab point is KNOWN to select another axis (or nothing): there is no press that drags this
  // one, and publishing a point anyway is a handle that edits the wrong axis and reports success.
  if (best && best.own === 0) return null;
  return best ? { x: best.x, y: best.y, world: best.world } : null;
}

/** Half-extent of three's uniform-scale picker, `BoxGeometry(0.2, 0.2, 0.2)` at the gizmo origin. */
export const SCALE_XYZ_HALF_EXTENT = 0.1;

/** How far off the origin the uniform-scale press lands, as a fraction of that half-extent. Any
 *  value < 1 stays inside the box on every axis; 0.5 keeps a healthy margin while still giving the
 *  drag a real starting radius. */
export const SCALE_CENTER_OFFSET_FRACTION = 0.5;

export interface ScaleCenterAimOpts {
  origin: Vec3Like;
  /** The camera's right and up axes — offsetting along these is guaranteed to move on screen,
   *  which offsetting along a world axis pointing at the camera would not. */
  cameraRight: Vec3Like;
  cameraUp: Vec3Like;
  /** `SCALE_XYZ_HALF_EXTENT * gizmoWorldScale(...)` — the picker box's half-extent in world units. */
  halfExtentWorld: number;
  project: (p: Vec3Like) => { x: number; y: number; z: number };
  reachable?: (p: { x: number; y: number }) => boolean;
  /** Would a press here select the UNIFORM (XYZ) picker? three's three PLANE pickers are thin
   *  plates in the gizmo's positive octant (`BoxGeometry(0.2, 0.2, 0.01)` at `[0.15, 0, 0.15]` and
   *  friends), and a ray from the camera can cross one BEFORE it reaches the uniform box — the
   *  press then scales two axes instead of three, silently. Measured 2026-08-19 on a two-entity
   *  selection (whose proxy has no rotation, so the plates lie in the world planes): the drag came
   *  back `sy` UNCHANGED at 3 while x and z grew, which is the XZ plate's signature. Optional
   *  because only the caller can raycast three's internal picker. */
  picksUniform?: (p: { x: number; y: number }) => boolean;
}

/** Where to press for a UNIFORM (centre) scale — deliberately NOT the gizmo origin.
 *
 *  three computes uniform scale as a RADIUS RATIO about the gizmo origin
 *  (`TransformControls.js`: `d = pointEnd.length() / pointStart.length()`, then
 *  `if (pointEnd.dot(pointStart) < 0) d *= -1`). Press exactly at the origin and `pointStart` is
 *  ~zero: the ratio explodes and the dot's sign is noise. Measured 2026-08-19 on games/anim-bug —
 *  a 120x80 px drag from the origin scaled `Sun` to 8.3e7 — which is also what makes the reported
 *  sign flip (testboard 1Rg36fFvZBdeNmUrtjs7) reproduce. That report guessed a near-degenerate
 *  camera was to blame; it is not, the camera was healthy for this measurement. It is the same
 *  hazard `Gizmo2D`'s `SCALE_MIN_START_DIST` already guards on the 2D side.
 *
 *  So aim INSIDE the picker box but off its centre: the press still selects XYZ (uniform), and the
 *  drag gets a non-degenerate starting radius, i.e. the ratio a human dragging that cube would get.
 *
 *  WHICH corner is not cosmetic. The ratio is radial about the pivot, so a drag AWAY from the press
 *  point grows and a drag through the pivot shrinks to 0 — meaning the corner decides which screen
 *  direction means "bigger". We take the screen DOWN-RIGHT corner so the natural
 *  `delta:{dx:+, dy:+}` drag grows, rather than crossing the pivot and collapsing to 0.
 */
export function scaleCenterAim(opts: ScaleCenterAimOpts): { x: number; y: number; world: Vec3Like } | null {
  const { origin, cameraRight, cameraUp, halfExtentWorld, project, reachable, picksUniform } = opts;
  const oC = project(origin);
  // Split the offset across two axes: each world component then stays well inside the box.
  const step = (SCALE_CENTER_OFFSET_FRACTION * halfExtentWorld) / Math.SQRT2;
  let best: { x: number; y: number; world: Vec3Like; uniform: boolean; free: boolean; toward: number } | null = null;
  for (const [sr, su] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    const world = add(add(origin, cameraRight, step * sr), cameraUp, step * su);
    const p = project(world);
    if (p.z > 1 || p.z < -1) continue;
    // `toward` ranks how far down-right of the centre this candidate sits (see the header).
    const cand = {
      x: p.x, y: p.y, world,
      uniform: picksUniform ? picksUniform(p) : true,
      free: reachable ? reachable(p) : true,
      toward: p.x - oC.x + (p.y - oC.y),
    };
    // Selecting the UNIFORM picker outranks reachability on purpose: an unreachable aim is REFUSED
    // by the input route, naming what covers it, whereas a plane-picker aim succeeds and quietly
    // scales two axes. A loud failure beats a quiet wrong answer.
    const better = !best
      || (cand.uniform !== best.uniform ? cand.uniform
        : cand.free !== best.free ? cand.free
          : cand.toward > best.toward);
    if (better) best = cand;
  }
  return best ? { x: best.x, y: best.y, world: best.world } : null;
}

export interface RotateRingAimOpts {
  /** The ring's centre — the gizmo'd object's world position. */
  origin: Vec3Like;
  /** The two unit axes spanning the ring's plane (the two axes that are NOT the ring's own), already
   *  in the gizmo's basis: world axes for `space:'world'`, the object's rotated axes for `'local'`. */
  u: Vec3Like;
  vAxis: Vec3Like;
  /** Ring radius in WORLD units — `ROTATE_RING_RADIUS * gizmoWorldScale(...)`. */
  radius: number;
  /** Projects a world point to viewport CSS px + NDC z. `z` outside [-1, 1] means clipped. */
  project: (p: Vec3Like) => { x: number; y: number; z: number };
  /** Optional: is this screen point actually reachable by a click — i.e. is the viewport itself
   *  the topmost element there? A ring has four equally valid grab points, and the editor's own
   *  toolbar/view-cube chrome sits over the canvas corners, so preferring a clickable one turns a
   *  correctly-reported-but-blocked aim into a usable one. Never a hard filter: when every
   *  candidate is covered, the nearest still comes back and the caller reports the occlusion. */
  reachable?: (p: { x: number; y: number }) => boolean;
  /** Would a press here select THIS ring's picker — `true`/`false`, or `null` when the caller cannot
   *  tell. The 45° diagonals avoid where two rings meet in 3D, but not where their projected
   *  ellipses CROSS on screen, which under an oblique camera can be anywhere; a ray at one ring
   *  there can reach a neighbour's torus first. The ring twin of `AxisPickAimOpts.picksAxis`
   *  (#1570 close-out sweep: same mechanism, found by pattern rather than observed). */
  picksRing?: (p: { x: number; y: number }) => boolean | null;
}

/** Pick the screen point to press for one rotation ring, or null when no candidate is on screen.
 *
 *  Candidates are the four 45° diagonals of the ring (see the header: the axis-aligned points are
 *  where two rings intersect). Depth decides: the NEAREST candidate wins, because it is the one a
 *  ray reaches first and so cannot be shadowed by the ring's own far side. Depth is read as
 *  projected NDC `z`, which is correct under BOTH projections — ranking by distance to the camera's
 *  POSITION would quietly be the wrong measure for an orthographic camera, where depth is measured
 *  along the view direction and the camera's position is not a focal point. Ties (a face-on ring
 *  has two equally near diagonals) break on screen distance from the projected centre. */
export function rotateRingAim(opts: RotateRingAimOpts): { x: number; y: number; world: Vec3Like } | null {
  const { origin, u, vAxis, radius, project, reachable, picksRing } = opts;
  const oC = project(origin);
  const k = Math.SQRT1_2;
  let best: { x: number; y: number; world: Vec3Like; own: number; free: boolean; depth: number; sep: number } | null = null;
  for (const [su, sv] of [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const) {
    const world = add(add(origin, u, radius * k * su), vAxis, radius * k * sv);
    const p = project(world);
    if (p.z > 1 || p.z < -1) continue; // behind the camera / clipped
    const picks = picksRing ? picksRing(p) : null;
    const cand = {
      x: p.x,
      y: p.y,
      world,
      own: picks === true ? 2 : picks === null ? 1 : 0,
      free: reachable ? reachable(p) : true,
      depth: p.z,
      sep: Math.hypot(p.x - oC.x, p.y - oC.y),
    };
    // Selects THIS ring first (a covered right ring is a loud refusal, a free wrong one a silent
    // wrong rotation — as `axisPickAim` ranks it); then clickable beats blocked; then nearest (a
    // near point cannot be shadowed by the ring's own far side); then a tie breaks on screen
    // separation, so the press lands as far from the crowded centre as possible.
    const better =
      !best ||
      (cand.own !== best.own ? cand.own > best.own
        : cand.free !== best.free ? cand.free
          : Math.abs(cand.depth - best.depth) > 1e-9 ? cand.depth < best.depth
            : cand.sep > best.sep);
    if (better) best = cand;
  }
  // Every diagonal is KNOWN to select something else: no press rotates about this ring.
  if (best && best.own === 0) return null;
  return best ? { x: best.x, y: best.y, world: best.world } : null;
}
