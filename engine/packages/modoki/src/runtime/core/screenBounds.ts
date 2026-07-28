/** Screen-bounds provider registry — the data behind the `layout-bounds` agent op.
 *
 *  Claude is weak at judging pixels, so this turns "is the title centered / are
 *  these overlapping / is anything clipped?" into NUMBERS. Each rendering layer
 *  that can compute on-screen rectangles registers a provider here (Scene3D
 *  projects world AABBs through the live camera; Scene2D maps PixiJS bounds to CSS).
 *  The agent op merges these with UI DOM rects and derives overlap/off-screen flags.
 *
 *  Mirrors `offscreenCapture.ts`'s registration pattern: providers register on
 *  mount, unregister on unmount. Coordinates are viewport CSS pixels (same frame as
 *  `getBoundingClientRect`), so UI/2D/3D rects are directly comparable. */

import * as THREE from 'three';

/** A rectangle in viewport CSS pixels (origin top-left), matching getBoundingClientRect. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

/** The viewport (the renderer's canvas) in viewport CSS px — from getBoundingClientRect. */
export interface ViewportRect { left: number; top: number; width: number; height: number }

const _v = new THREE.Vector3();

/** Project a world-space AABB to a viewport CSS-pixel rect via the live camera.
 *  Pure (no DOM) so it unit-tests with a real THREE camera. Returns null screen
 *  for an empty box. `onScreen` = the rect overlaps the viewport AND at least one
 *  corner is in front of the camera (|ndc.z| ≤ 1, which excludes behind-camera
 *  points whose projection wraps). */
export function projectAABBToScreen(
  box: THREE.Box3, camera: THREE.Camera, vp: ViewportRect,
): { screen: ScreenRect | null; onScreen: boolean } {
  if (box.isEmpty()) return { screen: null, onScreen: false };
  const { min, max } = box;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let anyInFront = false;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(camera);
    if (Math.abs(_v.z) <= 1) anyInFront = true;
    const cssX = vp.left + (_v.x * 0.5 + 0.5) * vp.width;
    const cssY = vp.top + (-_v.y * 0.5 + 0.5) * vp.height;
    if (cssX < minX) minX = cssX; if (cssX > maxX) maxX = cssX;
    if (cssY < minY) minY = cssY; if (cssY > maxY) maxY = cssY;
  }
  const screen = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const overlaps = minX < vp.left + vp.width && maxX > vp.left && minY < vp.top + vp.height && maxY > vp.top;
  return { screen, onScreen: anyInFront && overlaps };
}

export interface EntityScreenBounds {
  id: number;
  layer: '2d' | '3d';
  /** On-screen rect in viewport CSS px, or null when the entity has no projectable
   *  geometry (empty/gizmo-only) or is fully behind the camera. */
  screen: ScreenRect | null;
  onScreen: boolean;
  /** World-space AABB (3D only) — the entity's TRUE geometric extent in world units,
   *  independent of the screen projection and distinct from the authored/resolved
   *  scale: `size` = box dimensions, `center` = box center. Lets Claude reason about
   *  real size ("this mesh is 2.3×1.1×0.8") without a screenshot. Omitted for 2D/UI
   *  and for entities with no projectable geometry. */
  worldAABB?: { size: [number, number, number]; center: [number, number, number] };
}

/** A layer's bounds computer. `ids` (when given) limits the work to those entities. */
export type BoundsProvider = (ids?: Set<number>) => EntityScreenBounds[];

const providers = new Set<BoundsProvider>();

/** A rendering layer registers its bounds computer (returns an unregister fn). */
export function registerBoundsProvider(fn: BoundsProvider): () => void {
  providers.add(fn);
  return () => { providers.delete(fn); };
}

/** Collect screen bounds from every registered layer. A provider that throws is
 *  skipped (one bad layer can't break the whole report). */
export function collectScreenBounds(ids?: number[]): EntityScreenBounds[] {
  const set = ids && ids.length ? new Set(ids) : undefined;
  const out: EntityScreenBounds[] = [];
  for (const p of providers) {
    try { out.push(...p(set)); } catch { /* skip a failing layer */ }
  }
  return out;
}
