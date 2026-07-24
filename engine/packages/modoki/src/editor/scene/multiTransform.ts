/**
 * multiTransform — pure group-transform math shared by the 3D and 2D SceneView gizmos.
 *
 * When several entities are selected, dragging the transform gizmo must move/rotate/scale
 * ALL of them together, Unity-style. The two Unity toggles decide the behaviour:
 *
 *   • Local/Global  — the gizmo's axis ORIENTATION (handled per-viewport; the pivot frame
 *                     passed in here encodes it).
 *   • Pivot/Center  — WHERE the single rotation/scale pivot sits (the caller places it):
 *       - Center: the selection's shared centre (bbox/average centroid).
 *       - Pivot:  the ACTIVE (last-selected) entity's origin.
 *
 * In BOTH modes rotate/scale is a RIGID group transform around that single pivot point — the
 * members keep their relative arrangement and swing/spread as one cluster (Unity does NOT spin
 * each member about its own origin; the active object simply sits AT the Pivot-mode pivot, so it
 * appears to stay put while the rest orbit it). The only difference between the two modes is the
 * pivot LOCATION, which the caller encodes in `pivotStart`/`pivotNow` (3D) or `pivot` (2D) — so
 * this math takes no pivot-mode flag. Move is identical either way: every member translates by
 * the same world delta; only the handle's drawn position differs.
 *
 * This module is PURE and closure-free so the cluster math is headless-unit-testable, and so
 * the 3D (Three.js TransformControls) and 2D (Canvas) viewports drive the SAME core logic.
 * Each caller converts the returned WORLD transforms back to each member's LOCAL trait via its
 * own parent-inverse (worldToLocalTransform / worldToLocal2D).
 *
 * Shear caveat (inherent, matches gizmoTransform + Unity): non-uniform scale of members rotated
 * relative to the pivot axes produces a sheared world matrix that can't reduce to clean TRS.
 * Uniform scale and axis-aligned members are exact.
 */
import * as THREE from 'three';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type PivotMode = 'pivot' | 'center';

// ─────────────────────────────────────────────────────────────────────────────
// Descendant filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop any id whose ancestor is ALSO in the set. If a parent and its child are both
 * selected, a group drag would otherwise move the child twice (once directly, once dragged
 * by its moved parent). Unity moves each transform exactly once — so we transform only the
 * top-most selected entity of each subtree and let the hierarchy carry the descendants.
 *
 * `parentOf` returns the entity's parent id (0/null/undefined = root). Order is preserved.
 */
export function filterOutDescendants(
  ids: number[],
  parentOf: (id: number) => number | null | undefined,
): number[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let p = parentOf(id);
    const seen = new Set<number>();
    while (p != null && p !== 0 && !seen.has(p)) {
      if (set.has(p)) return false; // an ancestor is selected → this is a descendant
      seen.add(p);
      p = parentOf(p);
    }
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D — world-matrix cluster transform
// ─────────────────────────────────────────────────────────────────────────────

const _dInv = new THREE.Matrix4();
const _delta = new THREE.Matrix4();
const _dPos = new THREE.Vector3();
const _mPos = new THREE.Vector3();
const _mQuat = new THREE.Quaternion();
const _mScale = new THREE.Vector3();

export interface GroupTransform3DInput {
  /** Each selected (top-level) member's WORLD matrix captured at drag start. */
  memberStartWorld: THREE.Matrix4[];
  /** The gizmo pivot frame at drag start. Its POSITION is the single rotation/scale pivot
   *  (centroid for Center mode, active-entity origin for Pivot mode — the caller decides);
   *  its rotation = the axis orientation for Local space; scale should be 1. */
  pivotStart: THREE.Matrix4;
  /** The gizmo pivot frame NOW (after the drag). */
  pivotNow: THREE.Matrix4;
  mode: GizmoMode;
}

/**
 * Compute each member's new WORLD matrix for a group drag. Returns a fresh Matrix4 per member
 * (safe to keep). The caller converts each back to a local Transform trait.
 *
 * Rotate/scale is a RIGID group transform around the pivot point (`out = D · memberStart`, where
 * D = pivotNow·pivotStart⁻¹ is the world-space delta about that pivot) — so the member at the
 * pivot stays put and the rest orbit/spread around it. Center vs Pivot differ ONLY in where the
 * caller placed the pivot; the math is the same. Move translates every member by the same delta.
 */
export function applyGroupTransform3D(input: GroupTransform3DInput): THREE.Matrix4[] {
  const { memberStartWorld, pivotStart, pivotNow, mode } = input;
  // World-space delta that carries pivotStart onto pivotNow: D = pivotNow · pivotStart⁻¹.
  _dInv.copy(pivotStart).invert();
  _delta.copy(pivotNow).multiply(_dInv);
  _dPos.setFromMatrixPosition(_delta);

  return memberStartWorld.map((start) => {
    const out = new THREE.Matrix4();
    if (mode === 'translate') {
      // Translate every member by the same world delta; keep its own rotation + scale.
      start.decompose(_mPos, _mQuat, _mScale);
      out.compose(_mPos.clone().add(_dPos), _mQuat.clone(), _mScale.clone());
    } else {
      // rotate + scale: rigid group transform about the pivot (orbit/spread + reorient/resize).
      out.copy(_delta).multiply(start);
    }
    return out;
  });
}

/** Average of the member origins (a simple pivot point for Center mode). The caller may pass
 *  a bounding-box centre instead if it has world bounds — this is just the cheap default. */
export function selectionCentroid3D(memberWorld: THREE.Matrix4[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  if (memberWorld.length === 0) return c;
  const p = new THREE.Vector3();
  for (const m of memberWorld) { p.setFromMatrixPosition(m); c.add(p); }
  return c.multiplyScalar(1 / memberWorld.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D — canvas cluster transform
// ─────────────────────────────────────────────────────────────────────────────

export interface Transform2D { x: number; y: number; rz: number; sx: number; sy: number }

export interface GroupTransform2DInput {
  /** Each member's WORLD 2D transform at drag start. */
  memberStart: Transform2D[];
  /** The single rotation/scale pivot point. Center: bbox/average centre; Pivot: active entity's
   *  world origin — the caller decides, the math is the same either way. */
  pivot: { x: number; y: number };
  mode: GizmoMode;
  /** Gizmo delta this drag: translation (dx,dy), added rotation dRz (radians), scale FACTORS
   *  (dSx,dSy — 1 = no change). Rotation/scale are expressed about the pivot. */
  delta: { dx: number; dy: number; dRz: number; dSx: number; dSy: number };
}

/** Compute each member's new WORLD 2D transform for a group drag. Returns fresh objects.
 *  Rotate/scale is a rigid group transform about `pivot` (members orbit/spread around it — the
 *  member at the pivot stays put), matching the 3D path. */
export function applyGroupTransform2D(input: GroupTransform2DInput): Transform2D[] {
  const { memberStart, pivot, mode, delta } = input;
  const cos = Math.cos(delta.dRz), sin = Math.sin(delta.dRz);
  return memberStart.map((s) => {
    if (mode === 'translate') {
      return { ...s, x: s.x + delta.dx, y: s.y + delta.dy };
    }
    if (mode === 'rotate') {
      // Orbit the member around the pivot AND add the rotation to its own heading.
      const ox = s.x - pivot.x, oy = s.y - pivot.y;
      return {
        x: pivot.x + (cos * ox - sin * oy),
        y: pivot.y + (sin * ox + cos * oy),
        rz: s.rz + delta.dRz, sx: s.sx, sy: s.sy,
      };
    }
    // scale: spread the member's offset from the pivot AND scale its own size.
    return {
      x: pivot.x + (s.x - pivot.x) * delta.dSx,
      y: pivot.y + (s.y - pivot.y) * delta.dSy,
      rz: s.rz, sx: s.sx * delta.dSx, sy: s.sy * delta.dSy,
    };
  });
}

/** Average of the member origins — the cheap default pivot for 2D Center mode. */
export function selectionCentroid2D(members: Transform2D[]): { x: number; y: number } {
  if (members.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const m of members) { x += m.x; y += m.y; }
  return { x: x / members.length, y: y / members.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D — group-gizmo pivot/orientation/framing resolution
// ─────────────────────────────────────────────────────────────────────────────

/** A 2D multi-select member's WORLD transform + box half-extents, as needed to place the
 *  group gizmo (a subset of SceneView's `Group2DMember` — no local/parent fields, since this
 *  is pure geometry, not the undo/write-back bookkeeping). */
export interface Group2DPivotMember { id: number; x: number; y: number; rz: number; sx: number; sy: number; halfW: number; halfH: number }

export interface Group2DPivotResult { pivotX: number; pivotY: number; pivotRz: number; gw: number; gh: number }

/** Resolve the 2D group gizmo's pivot point, axis orientation, and framing box from a
 *  multi-selection's world-space members. Pulled out of SceneView's `computeGroup2DGizmo` so the
 *  Pivot/Center + Local/Global decision is unit-testable without a live ECS world — this is
 *  exactly where a prior bug shipped (the gizmo's orientation ignored Local space entirely,
 *  always drawing/hit-testing axis-aligned).
 *
 *  - Pivot mode + a resolvable active entity: gizmo sits ON the active entity, boxed to it alone.
 *  - Center mode, OR Pivot mode with no resolvable active entity (it may have been dropped by
 *    filterOutDescendants, or belong to a different canvas): gizmo frames the whole selection's
 *    bounding-box centre — a more legible fallback than an arbitrary member's origin.
 *  - Local space orients the gizmo by the active entity's world rz (independent of Pivot/Center,
 *    mirroring the 3D group proxy's `groupProxy.rotation`); World space (or no resolvable active
 *    entity) draws/hit-tests axis-aligned. */
export function resolveGroupPivot2D(
  members: Group2DPivotMember[],
  activeId: number | null,
  pivotMode: PivotMode,
  gizmoSpace: 'world' | 'local',
): Group2DPivotResult {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of members) {
    const hw = m.halfW * Math.abs(m.sx), hh = m.halfH * Math.abs(m.sy);
    minX = Math.min(minX, m.x - hw); maxX = Math.max(maxX, m.x + hw);
    minY = Math.min(minY, m.y - hh); maxY = Math.max(maxY, m.y + hh);
  }
  const active = activeId != null ? members.find((m) => m.id === activeId) : undefined;
  let pivotX: number, pivotY: number, gw: number, gh: number;
  if (pivotMode === 'pivot' && active) {
    pivotX = active.x; pivotY = active.y;
    gw = Math.max(active.halfW * Math.abs(active.sx), 6);
    gh = Math.max(active.halfH * Math.abs(active.sy), 6);
  } else {
    pivotX = (minX + maxX) / 2; pivotY = (minY + maxY) / 2;
    gw = Math.max((maxX - minX) / 2, 10);
    gh = Math.max((maxY - minY) / 2, 10);
  }
  const pivotRz = gizmoSpace === 'local' && active ? active.rz : 0;
  return { pivotX, pivotY, pivotRz, gw, gh };
}
