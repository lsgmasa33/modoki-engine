/** buildRig2D — compose a full `.rig2d.json` payload from a sprite + a hand-placed
 *  bone hierarchy, by auto-tessellating the sprite rectangle and auto-weighting each
 *  vertex to the bones. This is the one-call "auto-rig from a sprite" entry the editor
 *  (or an agent op) drives: the user places bones, this fills in the deformable mesh +
 *  weights. Pure + deterministic. */

import { generateGridMesh } from './rig2dTessellate';
import { computeAutoWeights, type AutoWeightOptions } from './rig2dAutoWeights';
import { suggestBones } from './rig2dAutoBones';
import type { Rig2DFile, Rig2DBone } from '../loaders/rig2dCache';

export interface BuildRig2DOptions {
  /** Rig GUID (top-level `id`); omit to leave unset (caller mints on save). */
  id?: string;
  /** Source texture/sprite GUID. */
  sprite: string;
  /** Bind-pose bones (name + parent index + local x/y/rot in texture space). */
  bones: Rig2DBone[];
  /** Sprite dimensions in px. */
  width: number;
  height: number;
  /** Grid divisions. Omit to auto-derive from `cellSize`. */
  cols?: number;
  rows?: number;
  /** Target grid cell size in px when cols/rows are omitted (default 48; grid is
   *  clamped to 1..24 divisions per axis). */
  cellSize?: number;
  pivotX?: number;
  pivotY?: number;
  /** Optional UV-space coverage predicate to cull fully-transparent cells. */
  isInside?: (u: number, v: number) => boolean;
  weights?: AutoWeightOptions;
}

function divisions(size: number, cell: number): number {
  return Math.max(1, Math.min(24, Math.round(size / Math.max(1, cell))));
}

/** Build a rig: auto-tessellate the sprite → grid mesh, then auto-weight each vertex
 *  to the bones. Returns a `Rig2DFile` ready to `JSON.stringify` / feed to `setRig2D`
 *  / `normalizeRig2D`. */
export function buildRig2D(opts: BuildRig2DOptions): Rig2DFile {
  const cell = opts.cellSize ?? 48;
  const cols = opts.cols ?? divisions(opts.width, cell);
  const rows = opts.rows ?? divisions(opts.height, cell);

  const mesh = generateGridMesh({
    width: opts.width, height: opts.height, cols, rows,
    pivotX: opts.pivotX, pivotY: opts.pivotY, isInside: opts.isInside,
  });

  const { skinIndices, skinWeights } = computeAutoWeights(mesh.verts, opts.bones, opts.weights);

  return {
    id: opts.id,
    sprite: opts.sprite,
    bones: opts.bones.map((b) => ({ name: b.name, parent: b.parent, x: b.x, y: b.y, rot: b.rot })),
    mesh: { verts: mesh.verts, uvs: mesh.uvs, tris: mesh.tris },
    skinIndices,
    skinWeights,
  };
}

export interface AutoRig2DOptions {
  id?: string;
  sprite: string;
  width: number;
  height: number;
  /** Bone count for the auto chain (>=2). Omit to derive from the sprite. */
  boneCount?: number;
  axis?: 'auto' | 'x' | 'y';
  cols?: number;
  rows?: number;
  cellSize?: number;
  pivotX?: number;
  pivotY?: number;
  isInside?: (u: number, v: number) => boolean;
  weights?: AutoWeightOptions;
}

/** One-call auto-rig from just a sprite: suggest a default bone chain along the
 *  principal axis, then tessellate + auto-weight. The editor's "Auto-rig" button
 *  entry — the user can then drag/add/remove the suggested bones. */
export function autoRig2D(opts: AutoRig2DOptions): Rig2DFile {
  const bones = suggestBones({
    width: opts.width, height: opts.height, count: opts.boneCount,
    axis: opts.axis, pivotX: opts.pivotX, pivotY: opts.pivotY, isInside: opts.isInside,
  });
  return buildRig2D({
    id: opts.id, sprite: opts.sprite, bones,
    width: opts.width, height: opts.height,
    cols: opts.cols, rows: opts.rows, cellSize: opts.cellSize,
    pivotX: opts.pivotX, pivotY: opts.pivotY, isInside: opts.isInside, weights: opts.weights,
  });
}
