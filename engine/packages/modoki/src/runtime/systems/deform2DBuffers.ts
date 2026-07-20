/** Module-level registry of per-vertex DEFORM offsets for `SkinnedSprite2D` parts —
 *  the seam between the animation layer (which samples deform timelines) and
 *  `skin2DSystem` (which adds the offsets to the bind vertices before skinning).
 *
 *  Parallels `skin2DBuffers`, but flows the OTHER way: the animation layer WRITES
 *  here each frame, skinning READS. Keyed by `(entityId, partName)`.
 *
 *  FRAME EPOCH — why not a plain clear(): the writers are decentralized (the runtime
 *  `animationSystem` writes all animators; the editor scrub writes one). A shared
 *  `clear()` would race (one writer wiping another's entries). Instead every write is
 *  stamped with the current epoch; `getDeform2D` returns an entry ONLY if it was
 *  written THIS epoch, so a part that stops being deformed (clip switch, scrub to a
 *  different rig) auto-expires without any explicit removal. Bump the epoch once at
 *  the start of each animation pass with `beginDeform2DFrame()`. */

interface DeformEntry {
  offsets: Float32Array;
  /** Frame epoch this entry was written in (stale if < current). */
  epoch: number;
  /** Monotonic write id — lets skinning detect a changed deform even when the bone
   *  pose is identical (mesh flutter with static bones). */
  version: number;
}

const deforms = new Map<number, Map<string, DeformEntry>>();
let currentEpoch = 0;
let versionCounter = 0;

/** Begin a new animation pass — entries written before this call become stale (a
 *  part not re-written this pass reads back as "no deform"). */
export function beginDeform2DFrame(): void {
  currentEpoch++;
}

/** Record a part's deform offsets for this frame. */
export function setDeform2D(entityId: number, part: string, offsets: Float32Array): void {
  let m = deforms.get(entityId);
  if (!m) { m = new Map(); deforms.set(entityId, m); }
  m.set(part, { offsets, epoch: currentEpoch, version: ++versionCounter });
}

/** Read a part's current-frame deform offsets, or undefined if none this frame. */
export function getDeform2D(entityId: number, part: string): Float32Array | undefined {
  const e = deforms.get(entityId)?.get(part);
  return e && e.epoch === currentEpoch ? e.offsets : undefined;
}

/** A monotonic version reflecting this entity's LATEST current-frame deform write,
 *  or 0 if the entity has no deform this frame. `skin2DSystem` compares it against
 *  the last-seen value to decide whether to re-skin an otherwise-idle pose. Because
 *  the counter is global-monotonic and never reset, a re-written deform always yields
 *  a strictly greater value than the prior frame. */
export function getDeform2DVersion(entityId: number): number {
  const m = deforms.get(entityId);
  if (!m) return 0;
  let v = 0;
  for (const e of m.values()) if (e.epoch === currentEpoch && e.version > v) v = e.version;
  return v;
}

/** Drop every entry (world/scene swap). */
export function clearDeform2DBuffers(): void {
  deforms.clear();
}
