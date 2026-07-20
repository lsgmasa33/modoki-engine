/** Sample a clip's DEFORM channels at a time and publish the per-vertex offsets into
 *  `deform2DBuffers`, where `skin2DSystem` picks them up. This is the deform analogue
 *  of `applyClipAtTime` (scalar tracks) and is called from the SAME sites — the
 *  runtime `animationSystem` and the editor scrub — so authored and played-back
 *  deformation match exactly. Deform tracks bind to the `SkinnedSprite2D` entity by
 *  the clip's relative name-path (reusing `resolveTrackTarget`), plus a part name. */

import type { World } from 'koota';
import { resolveTrackTarget, buildEntityIndex, type EntityIndex } from '../animation/sampleClip';
import { evalDeformTrack } from '../animation/deformEval';
import type { AnimationClipDef } from '../animation/types';
import { setDeform2D } from './deform2DBuffers';

/** Apply `clip`'s deform tracks (if any) at `time` for the animator rooted at
 *  `rootId`. Pass a prebuilt `index` when posing many animators in one frame.
 *  Returns the number of deform tracks applied (0 for a scalar-only clip — the fast
 *  path: no allocation, no entity-index build). */
export function applyClipDeform(
  world: World,
  rootId: number,
  clip: AnimationClipDef,
  time: number,
  index?: EntityIndex,
): number {
  const tracks = clip.deformTracks;
  if (!tracks || tracks.length === 0) return 0;
  const idx = index ?? buildEntityIndex(world);
  let applied = 0;
  for (const tr of tracks) {
    if (tr.keys.length === 0) continue;
    const targetId = resolveTrackTarget(idx, rootId, tr.path);
    if (targetId === null) continue;
    const offsets = evalDeformTrack(tr, time);
    if (!offsets) continue;
    setDeform2D(targetId, tr.part, offsets);
    applied++;
  }
  return applied;
}
