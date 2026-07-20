/** 2D Transform Gizmo — Canvas2D rendering, hit testing, and drag math. */

import { clampAngle } from '../../runtime/traits/Transform';

// ── Handle Types ──

export type GizmoHandle =
  | 'x-axis'
  | 'y-axis'
  | 'free'
  | 'rotate'
  | 'scale-uniform'
  | 'scale-tl'
  | 'scale-tr'
  | 'scale-bl'
  | 'scale-br';

// ── Constants ──

const BASE_AXIS_LEN = 60;
const BASE_HANDLE_SIZE = 8;
const BASE_ARROW_HEAD = 10;
const BASE_RING_TOLERANCE = 8;
/** Minimum start radius (px) for a scale drag to engage — below this the denominator
 *  is too small and the ratio becomes unstable (F9). Was an inline `> 1`. */
const SCALE_MIN_START_DIST = 4;

const COLOR_X = '#e74c3c';
const COLOR_Y = '#2ecc71';
const COLOR_FREE = '#f1c40f';
const COLOR_ROTATE = '#1abc9c';
const COLOR_SCALE = '#9b59b6';
const COLOR_SCALE_UNIFORM = '#f39c12';

// ── Draw ──

export function drawGizmo2D(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rz: number,
  sx: number,
  sy: number,
  entityWidth: number,
  entityHeight: number,
  mode: 'translate' | 'rotate' | 'scale',
  space: 'world' | 'local',
  hovered: GizmoHandle | null,
  screenScale = 1,
) {
  ctx.save();
  const s = screenScale;

  if (mode === 'translate') {
    drawTranslateHandles(ctx, x, y, rz, space, hovered, s);
  } else if (mode === 'rotate') {
    drawRotateHandles(ctx, x, y, rz, hovered, s);
  } else if (mode === 'scale') {
    drawScaleHandles(ctx, x, y, rz, sx, sy, entityWidth, entityHeight, hovered, s);
  }

  ctx.restore();
}

function drawTranslateHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rz: number,
  space: 'world' | 'local',
  hovered: GizmoHandle | null,
  s: number,
) {
  const AXIS_LEN = BASE_AXIS_LEN * s;
  const HANDLE_SIZE = BASE_HANDLE_SIZE * s;
  const ARROW_HEAD = BASE_ARROW_HEAD * s;

  ctx.save();
  ctx.translate(x, y);
  if (space === 'local') ctx.rotate(rz);

  // X-axis arrow (red) — extends from -AXIS_LEN to +AXIS_LEN so it's grabbable from either side
  const xAlpha = hovered === 'x-axis' ? 1.0 : 0.8;
  ctx.globalAlpha = xAlpha;
  ctx.strokeStyle = COLOR_X;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(-AXIS_LEN, 0);
  ctx.lineTo(AXIS_LEN, 0);
  ctx.stroke();
  // Arrowhead (positive end)
  ctx.fillStyle = COLOR_X;
  ctx.beginPath();
  ctx.moveTo(AXIS_LEN + ARROW_HEAD, 0);
  ctx.lineTo(AXIS_LEN - 2 * s, -ARROW_HEAD / 2);
  ctx.lineTo(AXIS_LEN - 2 * s, ARROW_HEAD / 2);
  ctx.closePath();
  ctx.fill();
  // Grab square
  ctx.fillStyle = hovered === 'x-axis' ? COLOR_X : `${COLOR_X}99`;
  ctx.fillRect(AXIS_LEN - HANDLE_SIZE / 2, -HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);

  // Y-axis arrow (green) — extends from -AXIS_LEN to +AXIS_LEN
  const yAlpha = hovered === 'y-axis' ? 1.0 : 0.8;
  ctx.globalAlpha = yAlpha;
  ctx.strokeStyle = COLOR_Y;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(0, -AXIS_LEN);
  ctx.lineTo(0, AXIS_LEN);
  ctx.stroke();
  // Arrowhead (positive end)
  ctx.fillStyle = COLOR_Y;
  ctx.beginPath();
  ctx.moveTo(0, AXIS_LEN + ARROW_HEAD);
  ctx.lineTo(-ARROW_HEAD / 2, AXIS_LEN - 2 * s);
  ctx.lineTo(ARROW_HEAD / 2, AXIS_LEN - 2 * s);
  ctx.closePath();
  ctx.fill();
  // Grab square
  ctx.fillStyle = hovered === 'y-axis' ? COLOR_Y : `${COLOR_Y}99`;
  ctx.fillRect(-HANDLE_SIZE / 2, AXIS_LEN - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);

  // Free-move center square (yellow) — larger for easy grabbing
  ctx.globalAlpha = hovered === 'free' ? 0.8 : 0.4;
  ctx.fillStyle = COLOR_FREE;
  const cs = HANDLE_SIZE * 2;
  ctx.fillRect(-cs / 2, -cs / 2, cs, cs);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLOR_FREE;
  ctx.lineWidth = 1 * s;
  ctx.strokeRect(-cs / 2, -cs / 2, cs, cs);

  ctx.restore();
}

function drawRotateHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rz: number,
  hovered: GizmoHandle | null,
  s: number,
) {
  const AXIS_LEN = BASE_AXIS_LEN * s;

  ctx.globalAlpha = hovered === 'rotate' ? 1.0 : 0.7;
  ctx.strokeStyle = COLOR_ROTATE;
  ctx.lineWidth = (hovered === 'rotate' ? 3 : 2) * s;

  // Ring
  ctx.beginPath();
  ctx.arc(x, y, AXIS_LEN, 0, Math.PI * 2);
  ctx.stroke();

  // Current angle indicator
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLOR_ROTATE;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + AXIS_LEN * Math.cos(rz), y + AXIS_LEN * Math.sin(rz));
  ctx.stroke();

  // Small dot at the angle endpoint
  ctx.fillStyle = COLOR_ROTATE;
  ctx.beginPath();
  ctx.arc(x + AXIS_LEN * Math.cos(rz), y + AXIS_LEN * Math.sin(rz), 4 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawScaleHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rz: number,
  sx: number,
  sy: number,
  entityWidth: number,
  entityHeight: number,
  hovered: GizmoHandle | null,
  s: number,
) {
  const HANDLE_SIZE = BASE_HANDLE_SIZE * s;
  const hw = entityWidth * Math.abs(sx);
  const hh = entityHeight * Math.abs(sy);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rz);

  // Dashed bounding box
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = COLOR_SCALE;
  ctx.lineWidth = 1 * s;
  ctx.setLineDash([4 * s, 4 * s]);
  ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
  ctx.setLineDash([]);

  // Corner handles
  const corners: Array<{ handle: GizmoHandle; cx: number; cy: number }> = [
    { handle: 'scale-tl', cx: -hw, cy: -hh },
    { handle: 'scale-tr', cx: hw, cy: -hh },
    { handle: 'scale-bl', cx: -hw, cy: hh },
    { handle: 'scale-br', cx: hw, cy: hh },
  ];
  for (const c of corners) {
    ctx.globalAlpha = hovered === c.handle ? 1.0 : 0.7;
    ctx.fillStyle = hovered === c.handle ? COLOR_SCALE : `${COLOR_SCALE}aa`;
    ctx.fillRect(c.cx - HANDLE_SIZE / 2, c.cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeStyle = COLOR_SCALE;
    ctx.lineWidth = 1 * s;
    ctx.strokeRect(c.cx - HANDLE_SIZE / 2, c.cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  }

  // Uniform scale center diamond
  ctx.globalAlpha = hovered === 'scale-uniform' ? 1.0 : 0.6;
  ctx.fillStyle = hovered === 'scale-uniform' ? COLOR_SCALE_UNIFORM : `${COLOR_SCALE_UNIFORM}aa`;
  const ds = HANDLE_SIZE;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, -ds);
  ctx.lineTo(ds, 0);
  ctx.lineTo(0, ds);
  ctx.lineTo(-ds, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = COLOR_SCALE_UNIFORM;
  ctx.lineWidth = 1 * s;
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

// ── Hit Test ──

export function hitTestGizmo2D(
  px: number,
  py: number,
  ex: number,
  ey: number,
  rz: number,
  sx: number,
  sy: number,
  entityWidth: number,
  entityHeight: number,
  mode: 'translate' | 'rotate' | 'scale',
  space: 'world' | 'local',
  screenScale = 1,
): GizmoHandle | null {
  const s = screenScale;
  if (mode === 'translate') {
    return hitTestTranslate(px, py, ex, ey, rz, space, s);
  } else if (mode === 'rotate') {
    return hitTestRotate(px, py, ex, ey, s);
  } else if (mode === 'scale') {
    return hitTestScale(px, py, ex, ey, rz, sx, sy, entityWidth, entityHeight, s);
  }
  return null;
}

/** Rotate a 2D delta INTO entity-local space (undo the entity's rotation by `-rz`).
 *  Centralizes the 2×2 inverse that was open-coded across the translate/scale
 *  hit-tests and the corner-scale apply (F6) — one sign convention, one place. */
export function rotateInverse2D(dx: number, dy: number, rz: number): { x: number; y: number } {
  const c = Math.cos(-rz);
  const s = Math.sin(-rz);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

function hitTestTranslate(
  px: number,
  py: number,
  ex: number,
  ey: number,
  rz: number,
  space: 'world' | 'local',
  s: number,
): GizmoHandle | null {
  const AXIS_LEN = BASE_AXIS_LEN * s;
  const HANDLE_SIZE = BASE_HANDLE_SIZE * s;
  const ARROW_HEAD = BASE_ARROW_HEAD * s;

  // Transform click point into gizmo-local space
  let lx = px - ex;
  let ly = py - ey;
  if (space === 'local') {
    ({ x: lx, y: ly } = rotateInverse2D(lx, ly, rz));
  }

  // X-axis handle (at end of arrow)
  if (Math.abs(lx - AXIS_LEN) < HANDLE_SIZE && Math.abs(ly) < HANDLE_SIZE) return 'x-axis';
  // Y-axis handle (at end of arrow)
  if (Math.abs(lx) < HANDLE_SIZE && Math.abs(ly - AXIS_LEN) < HANDLE_SIZE) return 'y-axis';
  // Free-move center (larger)
  const cs = HANDLE_SIZE * 2;
  if (Math.abs(lx) < cs / 2 && Math.abs(ly) < cs / 2) return 'free';

  // Allow clicking along the full axis lines (both negative and positive sides)
  const axisTol = 8 * s;
  if (Math.abs(lx) < AXIS_LEN + ARROW_HEAD && Math.abs(lx) > cs / 2 && Math.abs(ly) < axisTol) return 'x-axis';
  if (Math.abs(ly) < AXIS_LEN + ARROW_HEAD && Math.abs(ly) > cs / 2 && Math.abs(lx) < axisTol) return 'y-axis';

  return null;
}

function hitTestRotate(
  px: number,
  py: number,
  ex: number,
  ey: number,
  s: number,
): GizmoHandle | null {
  const AXIS_LEN = BASE_AXIS_LEN * s;
  const RING_TOLERANCE = BASE_RING_TOLERANCE * s;
  const dist = Math.sqrt((px - ex) ** 2 + (py - ey) ** 2);
  if (Math.abs(dist - AXIS_LEN) < RING_TOLERANCE) return 'rotate';
  return null;
}

function hitTestScale(
  px: number,
  py: number,
  ex: number,
  ey: number,
  rz: number,
  sx: number,
  sy: number,
  entityWidth: number,
  entityHeight: number,
  s: number,
): GizmoHandle | null {
  const HANDLE_SIZE = BASE_HANDLE_SIZE * s;

  // Transform click into entity-local space (undo rotation)
  const { x: lx, y: ly } = rotateInverse2D(px - ex, py - ey, rz);

  const hw = entityWidth * Math.abs(sx);
  const hh = entityHeight * Math.abs(sy);

  // Corner handles (test first — smaller targets)
  const corners: Array<{ handle: GizmoHandle; cx: number; cy: number }> = [
    { handle: 'scale-tl', cx: -hw, cy: -hh },
    { handle: 'scale-tr', cx: hw, cy: -hh },
    { handle: 'scale-bl', cx: -hw, cy: hh },
    { handle: 'scale-br', cx: hw, cy: hh },
  ];
  for (const c of corners) {
    if (Math.abs(lx - c.cx) < HANDLE_SIZE && Math.abs(ly - c.cy) < HANDLE_SIZE) return c.handle;
  }

  // Uniform scale center diamond
  const ds = HANDLE_SIZE;
  if (Math.abs(lx) + Math.abs(ly) < ds * 1.5) return 'scale-uniform';

  return null;
}

// ── Cursor for Handle ──

export function cursorForHandle(handle: GizmoHandle | null): string {
  if (!handle) return 'default';
  switch (handle) {
    case 'x-axis': return 'ew-resize';
    case 'y-axis': return 'ns-resize';
    case 'free': return 'move';
    case 'rotate': return 'crosshair';
    case 'scale-uniform': return 'nwse-resize';
    case 'scale-tl': return 'nwse-resize';
    case 'scale-br': return 'nwse-resize';
    case 'scale-tr': return 'nesw-resize';
    case 'scale-bl': return 'nesw-resize';
    default: return 'default';
  }
}

// ── Drag math ──

/** Transform values captured when a gizmo drag begins. */
export interface GizmoDragStart {
  x: number;
  y: number;
  rz: number;
  sx: number;
  sy: number;
}

/** Only the Transform fields a given drag changes — caller merges into the entity. */
export interface GizmoDrag2DResult {
  x?: number;
  y?: number;
  rz?: number;
  sx?: number;
  sy?: number;
}

/** Snap increments for a gizmo drag (gizmos F7). Position in world units, rotation in
 *  RADIANS, scale as a unitless step. A field <= 0 / undefined disables snapping for it. */
export interface GizmoSnap { translate?: number; rotateRad?: number; scale?: number }

/** The default Shift-held snap: 0.5-unit grid, 15° rotation, 0.1 scale steps — the
 *  conventional editor increments. Wired to the Shift key in SceneView's gizmo drag. */
export const DEFAULT_GIZMO_SNAP: GizmoSnap = { translate: 0.5, rotateRad: Math.PI / 12, scale: 0.1 };

function snapTo(v: number, step: number | undefined): number {
  return step && step > 0 ? Math.round(v / step) * step : v;
}

/** Round a drag result onto the snap grid (gizmos F7). Each present field is snapped to
 *  its matching increment; absent fields stay absent. Pure — applied by the caller only
 *  while the snap modifier (Shift) is held, so an un-snapped drag is byte-identical to
 *  before. Snaps the ABSOLUTE value (Unity-style: positions land on grid lines, rotation
 *  on 15° multiples), not the delta. */
export function snapDragResult(r: GizmoDrag2DResult, snap: GizmoSnap): GizmoDrag2DResult {
  const out: GizmoDrag2DResult = {};
  if (r.x !== undefined) out.x = snapTo(r.x, snap.translate);
  if (r.y !== undefined) out.y = snapTo(r.y, snap.translate);
  if (r.rz !== undefined) out.rz = snapTo(r.rz, snap.rotateRad);
  if (r.sx !== undefined) out.sx = snapTo(r.sx, snap.scale);
  if (r.sy !== undefined) out.sy = snapTo(r.sy, snap.scale);
  return out;
}

/**
 * Compute the Transform delta for an in-progress 2D gizmo drag. Pure: takes the
 * pointer position (game coords), the start state, and the entity's world center,
 * and returns only the fields that change. Extracted from SceneView's pointer-move
 * handler so the drag math is unit-testable without a canvas.
 *
 * - `free` → move along both axes by the pointer delta
 * - `x-axis`/`y-axis` → constrained move; in `local` space the constraint axis is
 *   rotated by the entity's rz
 * - `rotate` → angle delta about the center, normalized by the engine-wide
 *   `clampAngle` to **[-2π, 2π]** (±360°) — the SAME convention as `rotate3DSystem`
 *   and SceneView's 3D-gizmo apply, so 2D and 3D rotation agree. (NOT a single-turn
 *   [-π, π] wrap: dragging past 180° keeps accumulating up to ±360° rather than
 *   wrapping to the equivalent small angle.)
 * - `scale-uniform` → distance-ratio scale on both axes
 * - corner handles → per-axis scale in the entity's local frame
 */
export function applyGizmoDrag2D(
  handle: GizmoHandle,
  px: number,
  py: number,
  startPx: number,
  startPy: number,
  start: GizmoDragStart,
  center: { x: number; y: number },
  gizmoSpace: 'world' | 'local',
): GizmoDrag2DResult {
  const dx = px - startPx;
  const dy = py - startPy;

  switch (handle) {
    case 'free':
      return { x: start.x + dx, y: start.y + dy };

    case 'x-axis':
      if (gizmoSpace === 'local') {
        const c = Math.cos(start.rz);
        const s = Math.sin(start.rz);
        const proj = dx * c + dy * s;
        return { x: start.x + proj * c, y: start.y + proj * s };
      }
      return { x: start.x + dx };

    case 'y-axis':
      if (gizmoSpace === 'local') {
        const c = Math.cos(start.rz);
        const s = Math.sin(start.rz);
        const proj = -dx * s + dy * c;
        return { x: start.x + proj * -s, y: start.y + proj * c };
      }
      return { y: start.y + dy };

    case 'rotate': {
      const startAngle = Math.atan2(startPy - center.y, startPx - center.x);
      const curAngle = Math.atan2(py - center.y, px - center.x);
      return { rz: clampAngle(start.rz + (curAngle - startAngle)) };
    }

    case 'scale-uniform': {
      const startDist = Math.hypot(startPx - center.x, startPy - center.y);
      const curDist = Math.hypot(px - center.x, py - center.y);
      // F9: require a non-trivial start radius so a near-pivot grab can't divide by a
      // ~1px denominator and shoot the ratio to a huge value.
      if (startDist > SCALE_MIN_START_DIST) {
        const ratio = curDist / startDist;
        return { sx: start.sx * ratio, sy: start.sy * ratio };
      }
      return {};
    }

    default: {
      // Corner scale (scale-tl/tr/bl/br) — non-uniform in entity-local space.
      const sLocal = rotateInverse2D(startPx - center.x, startPy - center.y, start.rz);
      const cLocal = rotateInverse2D(px - center.x, py - center.y, start.rz);
      // F9: clamp each ratio to >= 0 so dragging the pointer ACROSS the pivot stops at
      // 0 instead of flipping the scale negative (an accidental mirror). Negative scale
      // remains available by typing it in the Inspector; gizmo drag never mirrors.
      const ratioX = Math.abs(sLocal.x) > SCALE_MIN_START_DIST ? Math.max(0, cLocal.x / sLocal.x) : 1;
      const ratioY = Math.abs(sLocal.y) > SCALE_MIN_START_DIST ? Math.max(0, cLocal.y / sLocal.y) : 1;
      return { sx: start.sx * ratioX, sy: start.sy * ratioY };
    }
  }
}

/** A 2D transform: translation / rotation (rz) / scale, matching the relevant
 *  `Transform` fields. */
export interface Transform2D { x: number; y: number; rz: number; sx: number; sy: number }

/** Convert a WORLD-space 2D transform into LOCAL space relative to `parentWorld`
 *  (the inverse of the 2D parent→child composition `worldPos = parentPos +
 *  R(parentRz)·(parentScale ⊙ localPos)`, `worldRz = parentRz + localRz`,
 *  `worldScale = parentScale ⊙ localScale`). Mirrors the 3D `worldToLocalTransform`
 *  (gizmoTransform.ts). With no parent (`null`/root) the world transform IS local.
 *  The 2D gizmo computes its drag in world space (consistent frame for translate/
 *  rotate/scale) and converts back through this so a PARENTED 2D entity moves by the
 *  right amount/axis/magnitude (gizmos F1). Degenerate parent scale (0) is guarded to 1
 *  to avoid NaN. Like the 3D case, a rotated + non-uniformly-scaled parent shears and
 *  won't round-trip exactly. */
export function worldToLocal2D(world: Transform2D, parentWorld: Transform2D | null | undefined): Transform2D {
  if (!parentWorld) return { ...world };
  const psx = parentWorld.sx || 1;
  const psy = parentWorld.sy || 1;
  const relX = world.x - parentWorld.x;
  const relY = world.y - parentWorld.y;
  // Un-rotate by the parent's world rotation, then divide out the parent's scale.
  const c = Math.cos(-parentWorld.rz);
  const s = Math.sin(-parentWorld.rz);
  const ux = relX * c - relY * s;
  const uy = relX * s + relY * c;
  return {
    x: ux / psx,
    y: uy / psy,
    rz: world.rz - parentWorld.rz,
    sx: world.sx / psx,
    sy: world.sy / psy,
  };
}
