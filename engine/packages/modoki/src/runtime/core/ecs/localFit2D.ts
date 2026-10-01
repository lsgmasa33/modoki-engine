/**
 * Local fits — the seam that lets a 2D entity's subtree be fitted to its canvas (`Frame2D`) without writing its
 * authored Transform.
 *
 * `transformPropagationSystem` asks the registered provider, once a pass, for a fit per entity, and composes that
 * entity's world pose from `fit · local` instead of `local`. So every reader of the world-transform cache (the 2D
 * renderer, picking and gizmos, physics, particles, sprite batches) sees the fitted pose, and the scene is never
 * dirtied by it: CameraFrame's rule (the fit is applied, never authored), in 2D.
 *
 * L0 holds only the map and the slot; the provider is rendering's (`rendering/frame2D.ts`), since only the
 * renderer knows what part of a canvas is on screen. No provider (a headless test that never imports it) = no fits.
 */
import type { World } from 'koota';

import { onWorldSwap } from './worldRegistry';

/** Maps the entity's own space into its parent's: `parent = (x + kx * local.x, y + ky * local.y)`. No rotation. */
export interface LocalFit2D { x: number; y: number; kx: number; ky: number }

/** The fits for this pass, keyed by PACKED entity (`entity.valueOf()`: index + generation), so a fit never reaches
 *  an entity that recycled a dead one's index. `parentOf` is this pass's parent map (id → parent id; roots absent). */
export type LocalFit2DProvider = (world: World, parentOf: ReadonlyMap<number, number>) => ReadonlyMap<number, LocalFit2D> | null;

/** A 2D world or local pose (the Transform fields a 2D pose uses). */
export interface Pose2D { x: number; y: number; rz: number; sx: number; sy: number }

/** The frame an entity's LOCAL Transform lives in, as the runtime composes it: its parent's world pose with the
 *  entity's own fit applied first (`fit · local`). A path that turns a 2D world pose back into a Transform inverts
 *  through THIS, not the bare parent (the 2D gizmo, physics2D's write-back) — or, on full 3D TRS, inverts the bare
 *  parent and undoes the fit per axis (agentEditorOps' live world write) — or it writes the FITTED pose into the
 *  authored Transform and the next pass fits it again: a +10 px drag under a 4x fit wrote x -490 for 0, drawn at
 *  -2460. Exact: the fit has no rotation, so `P ∘ F` is `P` moved to `P(fit.x, fit.y)` with its scale times the
 *  fit's. Null parent = a root (or a canvas with no Transform). */
export function localFrame2D(
  parentWorld: Pose2D | null | undefined,
  fit: LocalFit2D | undefined,
): Pose2D | null {
  if (!fit) return parentWorld ?? null;
  if (!parentWorld) return { x: fit.x, y: fit.y, rz: 0, sx: fit.kx, sy: fit.ky };
  const c = Math.cos(parentWorld.rz);
  const s = Math.sin(parentWorld.rz);
  const ax = parentWorld.sx * fit.x;
  const ay = parentWorld.sy * fit.y;
  return {
    x: parentWorld.x + ax * c - ay * s,
    y: parentWorld.y + ax * s + ay * c,
    rz: parentWorld.rz,
    sx: parentWorld.sx * fit.kx,
    sy: parentWorld.sy * fit.ky,
  };
}

const NONE: ReadonlyMap<number, LocalFit2D> = new Map();
let provider: LocalFit2DProvider | null = null;
let last: ReadonlyMap<number, LocalFit2D> = NONE;

export function setLocalFit2DProvider(p: LocalFit2DProvider | null): void {
  provider = p;
  if (!p) last = NONE;
}

/** Called by the propagation pass: this pass's fits (also kept for {@link localFit2DOf}), by packed entity. */
export function takeLocalFits2D(world: World, parentOf: ReadonlyMap<number, number>): ReadonlyMap<number, LocalFit2D> {
  last = provider?.(world, parentOf) ?? NONE;
  return last;
}

/** The fit applied to an entity (packed: `entity.valueOf()`) in the last propagation pass, or undefined. */
export function localFit2DOf(packed: number): LocalFit2D | undefined {
  return last.get(packed);
}

onWorldSwap(() => { last = NONE; });
