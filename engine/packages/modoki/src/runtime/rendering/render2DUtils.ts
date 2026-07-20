/** render2DUtils — shared 2D entity rendering computations used by both
 *  Scene2D (PixiJS runtime) and the editor SceneView's Canvas2DLayer (preview).
 *
 *  Extracts the duplicated logic for pivot offsets, keepAspect scaling,
 *  and shape rendering to Canvas 2D context. */

import { isImagePath, resolveImageUrl, resolveDomImageUrl, resolvePrimitiveShape, type PrimitiveShape } from './renderUtils';
import { colliderOutline2D, colliderGeomSig, type ColliderOutline, type ColliderShapeParams } from './colliderOutline2D';

/** Sentinel Renderable2D.sprite that draws the entity's OWN Collider2D shape as a filled
 *  (open polyline colliders: stroked) graphic — a visible body for polygon/polyline/concave colliders
 *  that have no primitive equivalent. Single source of truth: editing the collider (⬟ Points)
 *  updates the visual. */
export const COLLIDER_SPRITE = 'collider';

/** A signature of the fields that change a collider's outline — for render change-detection.
 *  Aliases the shared {@link colliderGeomSig} so render + physics never drift. */
export const colliderOutlineSig = colliderGeomSig;

const POLYLINE_STROKE_W = 6; // world units — thickness for open (polyline) collider fills

const PIXI_BLEND_MODES = new Set(['normal', 'add', 'multiply', 'screen']);

/** Coerce a `Renderable2D.blendMode` value to a valid PixiJS blend string, defaulting
 *  unknown/legacy values to `normal`. The 2D-material work reuses this. */
export function pixiBlendMode2D(mode: string | undefined): 'normal' | 'add' | 'multiply' | 'screen' {
  return (mode && PIXI_BLEND_MODES.has(mode) ? mode : 'normal') as 'normal' | 'add' | 'multiply' | 'screen';
}

/** Compute the pivot offset for a 2D entity with given width/height and pivot point.
 *  Pivot 0 = left/top edge, 0.5 = center (default), 1 = right/bottom edge.
 *  Returns offset such that the pivot point sits at the local origin. */
export function computePivotOffset(w: number, h: number, pivotX: number, pivotY: number): { ox: number; oy: number } {
  return { ox: -w * 2 * pivotX, oy: -h * 2 * pivotY };
}

/** Compute sprite scale factors, optionally enforcing uniform (keepAspect) scaling. */
export function computeSpriteScale(
  targetW: number, targetH: number,
  texW: number, texH: number,
  keepAspect: boolean,
): { scaleX: number; scaleY: number } {
  let scaleX = (targetW * 2) / texW;
  let scaleY = (targetH * 2) / texH;
  if (keepAspect) {
    const uniform = Math.min(scaleX, scaleY);
    scaleX = uniform;
    scaleY = uniform;
  }
  return { scaleX, scaleY };
}

/** Vertex geometry for a 2D primitive shape, backend-agnostic. The SINGLE source
 *  of shape vertices for both the PixiJS runtime (Scene2D, via drawPrimitiveShapeGfx)
 *  and the editor Canvas2D preview (via drawPrimitiveShape) — so the two paths can't
 *  drift (F7). All coordinates are local, with the pivot offset (ox/oy) already folded in. */
export type ShapeGeometry =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'triangle'; ax: number; ay: number; bx: number; by: number; cx: number; cy: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

/** Resolve a primitive shape + half-extents + pivot offset to concrete vertices.
 *  @param w Half-width of the entity
 *  @param h Half-height of the entity
 *  @param ox Pivot offset X (from computePivotOffset)
 *  @param oy Pivot offset Y (from computePivotOffset) */
export function computeShapeGeometry(
  shape: PrimitiveShape,
  w: number, h: number,
  ox: number, oy: number,
): ShapeGeometry {
  if (shape === 'square') {
    return { kind: 'rect', x: ox, y: oy, w: w * 2, h: h * 2 };
  }
  if (shape === 'triangle') {
    return { kind: 'triangle', ax: w + ox, ay: oy, bx: w * 2 + ox, by: h * 2 + oy, cx: ox, cy: h * 2 + oy };
  }
  return { kind: 'ellipse', cx: w + ox, cy: h + oy, rx: w, ry: h };
}

/** Minimal PixiJS-Graphics path API used by shape drawing — declared structurally so
 *  this otherwise backend-agnostic module needs no `pixi.js` import. A real `Graphics`
 *  is assignable (its methods return `this`, compatible with `unknown`). */
export interface GraphicsLike {
  rect(x: number, y: number, w: number, h: number): unknown;
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  arc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): unknown;
  closePath(): unknown;
  ellipse(x: number, y: number, rw: number, rh: number): unknown;
  fill(color: number): unknown;
  stroke(style: { width: number; color: number; alpha?: number; cap?: 'butt' | 'round' | 'square'; join?: 'round' | 'bevel' | 'miter' }): unknown;
}

/** Draw a Collider2D's outline as a FILLED shape into a PixiJS Graphics (runtime path).
 *  Mirrors {@link drawColliderFill} via the same {@link colliderOutline2D}. */
export function drawColliderFillGfx(gfx: GraphicsLike, c: ColliderShapeParams, color: number): void {
  const o: ColliderOutline | null = colliderOutline2D(c);
  if (!o) return;
  if (o.kind === 'circle') {
    gfx.ellipse(0, 0, o.radius, o.radius); gfx.fill(color);
  } else if (o.kind === 'capsule') {
    const r = o.radius, hh = o.halfH;
    gfx.rect(-r, -hh, r * 2, hh * 2);
    gfx.ellipse(0, -hh, r, r);
    gfx.ellipse(0, hh, r, r);
    gfx.fill(color);
  } else if (o.kind === 'polygon') {
    if (!o.points.length) return;
    o.points.forEach((p, i) => (i ? gfx.lineTo(p.x, p.y) : gfx.moveTo(p.x, p.y)));
    gfx.closePath(); gfx.fill(color);
  } else {
    if (o.points.length < 2) return;
    o.points.forEach((p, i) => (i ? gfx.lineTo(p.x, p.y) : gfx.moveTo(p.x, p.y)));
    gfx.stroke({ width: POLYLINE_STROKE_W, color, cap: 'round', join: 'round' });
  }
}

/** Draw a Collider2D's outline as a STROKE into a Canvas 2D ctx (editor selection overlay).
 *  Assumes ctx is already at the entity's world transform (translate+rotate, NO scale —
 *  colliders are unscaled). Peer of {@link drawColliderFill}; both source {@link colliderOutline2D},
 *  and the capsule is one agreed STADIUM (side lines + half-arc caps) so the two paths + the
 *  Pixi overlay can't drift. */
export function drawColliderOutline(
  ctx: CanvasRenderingContext2D, c: ColliderShapeParams,
  opts: { color: string; width: number; dash?: number[] },
): void {
  const o = colliderOutline2D(c);
  if (!o) return;
  ctx.strokeStyle = opts.color; ctx.lineWidth = opts.width;
  if (opts.dash) ctx.setLineDash(opts.dash);
  ctx.beginPath();
  if (o.kind === 'circle') {
    ctx.arc(0, 0, o.radius, 0, Math.PI * 2);
  } else if (o.kind === 'capsule') {
    const r = o.radius, hh = o.halfH;
    ctx.moveTo(r, -hh); ctx.lineTo(r, hh);
    ctx.arc(0, hh, r, 0, Math.PI);             // bottom cap
    ctx.lineTo(-r, -hh);
    ctx.arc(0, -hh, r, Math.PI, Math.PI * 2);  // top cap
    ctx.closePath();
  } else {
    o.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (o.kind === 'polygon' && o.points.length > 1) ctx.closePath();
  }
  ctx.stroke();
  if (opts.dash) ctx.setLineDash([]);
}

/** Draw a Collider2D's outline as a STROKE into a PixiJS Graphics (Scene2D debug overlay).
 *  All colliders share one Graphics with no per-object transform, so points are BAKED through
 *  `xf` (world position+rotation, no scale) and cap arcs are rotated by `rot`. Same STADIUM
 *  capsule as {@link drawColliderOutline}. */
export function drawColliderOutlineGfx(
  gfx: GraphicsLike, c: ColliderShapeParams,
  style: { width: number; color: number; alpha?: number },
  xf: (lx: number, ly: number) => { x: number; y: number }, rot: number,
): void {
  const o = colliderOutline2D(c);
  if (!o) return;
  if (o.kind === 'circle') {
    const p = xf(0, 0); gfx.arc(p.x, p.y, o.radius, 0, Math.PI * 2);
  } else if (o.kind === 'capsule') {
    const r = o.radius, hh = o.halfH;
    const a = xf(r, -hh), b = xf(r, hh), d = xf(-r, -hh);
    const cb = xf(0, hh), ct = xf(0, -hh);
    gfx.moveTo(a.x, a.y); gfx.lineTo(b.x, b.y);
    gfx.arc(cb.x, cb.y, r, rot, Math.PI + rot);              // bottom cap
    gfx.lineTo(d.x, d.y);
    gfx.arc(ct.x, ct.y, r, Math.PI + rot, Math.PI * 2 + rot); // top cap
    gfx.closePath();
  } else {
    const p = o.points;
    if (!p.length) return;
    const q0 = xf(p[0].x, p[0].y); gfx.moveTo(q0.x, q0.y);
    for (let i = 1; i < p.length; i++) { const q = xf(p[i].x, p[i].y); gfx.lineTo(q.x, q.y); }
    if (o.kind === 'polygon') gfx.closePath();
  }
  gfx.stroke(style);
}

/** Draw a 2D primitive shape into a PixiJS Graphics (runtime Scene2D path).
 *  Mirrors {@link drawPrimitiveShape} via the same {@link computeShapeGeometry}, so the
 *  runtime (Pixi) and editor preview (Canvas2D) emit identical vertices — guarded by a
 *  parity test (render2DParity.test.ts). NOTE the one unavoidable API gap: Canvas2D's
 *  `ellipse` needs rotation/start/end angle args; Pixi's takes only (x,y,rw,rh). Both
 *  trace the same ellipse — the geometry is identical, only the call arity differs.
 *  @param gfx PixiJS Graphics (already added to its canvas container)
 *  @param color Tint color as a 0xRRGGBB number */
export function drawPrimitiveShapeGfx(
  gfx: GraphicsLike,
  shape: PrimitiveShape,
  w: number, h: number,
  ox: number, oy: number,
  color: number,
): void {
  const geo = computeShapeGeometry(shape, w, h, ox, oy);
  if (geo.kind === 'rect') {
    gfx.rect(geo.x, geo.y, geo.w, geo.h);
  } else if (geo.kind === 'triangle') {
    gfx.moveTo(geo.ax, geo.ay);
    gfx.lineTo(geo.bx, geo.by);
    gfx.lineTo(geo.cx, geo.cy);
    gfx.closePath();
  } else {
    gfx.ellipse(geo.cx, geo.cy, geo.rx, geo.ry);
  }
  gfx.fill(color);
}

/** Fallback for {@link drawSkinnedMesh2D} while the texture is still loading: fill the
 *  deformed triangles with a flat tint + faint wireframe so the deformation is visible
 *  immediately (the textured draw replaces it once the image resolves). */
export function drawSkinnedMeshFlat2D(
  ctx: CanvasRenderingContext2D,
  positions: Float32Array,
  indices: Uint32Array,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.5;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    ctx.beginPath();
    ctx.moveTo(positions[i0 * 2], positions[i0 * 2 + 1]);
    ctx.lineTo(positions[i1 * 2], positions[i1 * 2 + 1]);
    ctx.lineTo(positions[i2 * 2], positions[i2 * 2 + 1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Stroke a skinned mesh's triangle edges (topology wireframe) into a Canvas2D context,
 *  in the SAME local space as {@link drawSkinnedMesh2D}. Editor authoring aid — makes the
 *  tessellation density + deformation visible. `positions` = packed [x,y,…], `indices` =
 *  triangle index buffer. */
export function drawSkinnedMeshWireframe2D(
  ctx: CanvasRenderingContext2D,
  positions: Float32Array,
  indices: Uint32Array,
  color: string,
  lineWidth: number,
): void {
  ctx.save();
  ctx.beginPath();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 2, b = indices[t + 1] * 2, c = indices[t + 2] * 2;
    ctx.moveTo(positions[a], positions[a + 1]);
    ctx.lineTo(positions[b], positions[b + 1]);
    ctx.lineTo(positions[c], positions[c + 1]);
    ctx.closePath();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

/** Fill a skinned mesh's triangles by a per-vertex weight field (averaged per triangle)
 *  as GRAYSCALE (white = full influence → black = none), in the SAME local space as
 *  {@link drawSkinnedMesh2D}. Editor authoring aid — a single-bone influence gradient
 *  reads far more clearly in grayscale than in a color ramp. */
export function drawWeightHeatmap2D(
  ctx: CanvasRenderingContext2D,
  positions: Float32Array,
  indices: Uint32Array,
  weights: ArrayLike<number>,
  alpha = 0.55,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const w = ((weights[i0] ?? 0) + (weights[i1] ?? 0) + (weights[i2] ?? 0)) / 3;
    const g = Math.round(255 * (w < 0 ? 0 : w > 1 ? 1 : w));
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.moveTo(positions[i0 * 2], positions[i0 * 2 + 1]);
    ctx.lineTo(positions[i1 * 2], positions[i1 * 2 + 1]);
    ctx.lineTo(positions[i2 * 2], positions[i2 * 2 + 1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Distinct display color per bone index (cycles) — for the dominant-bone influence
 *  segmentation view. */
const BONE_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [231, 76, 60], [46, 204, 113], [52, 152, 219], [241, 196, 15],
  [155, 89, 182], [26, 188, 156], [230, 126, 34], [236, 240, 241],
];
export function boneColorRGB(boneIndex: number): readonly [number, number, number] {
  const n = BONE_PALETTE.length;
  return BONE_PALETTE[((boneIndex % n) + n) % n];
}

/** Fill a skinned mesh's triangles by each triangle's dominant bone (a whole-rig
 *  influence map), in the SAME local space as {@link drawSkinnedMesh2D}. `dominant` is
 *  the per-vertex dominant bone index (see `dominantBoneField`). */
export function drawDominantBoneMap2D(
  ctx: CanvasRenderingContext2D,
  positions: Float32Array,
  indices: Uint32Array,
  dominant: ArrayLike<number>,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const [r, g, b] = boneColorRGB(dominant[i0] ?? 0);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.moveTo(positions[i0 * 2], positions[i0 * 2 + 1]);
    ctx.lineTo(positions[i1 * 2], positions[i1 * 2 + 1]);
    ctx.lineTo(positions[i2 * 2], positions[i2 * 2 + 1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export { isImagePath, resolveImageUrl, resolveDomImageUrl, resolvePrimitiveShape };
