/** Which parts of a skinned 2D rig the SceneView weight overlay draws, and with which
 *  weight set (#180).
 *
 *  The overlay shades a bone's influence over the character AS DRAWN, so it needs two
 *  things per part that live in different places: the DEFORMED positions (the runtime's
 *  `Skin2DBuffer`) and the WEIGHTS (`ParsedRig2D.parts`). It used to read neither per
 *  part — it drew `buffer.parts[0]` with the rig's TOP-LEVEL `skinIndices`/`skinWeights`,
 *  which `normalizeRig2D` fills from `parts[0]` as a back-compat alias. On a multi-part
 *  rig that shaded part 0's weights over part 0's mesh and left every other part
 *  unshaded, while the magenta wireframe beside it outlined the whole rig.
 *
 *  The pairing rule is index-alignment, and it is safe for one specific reason worth
 *  writing down: `skin2DSystem` builds the buffer as `parsed.parts.map(...)` and rebuilds
 *  it whenever the part count or any part's vertex count changes, so `buffer.parts[i]`
 *  and `rig.parts[i]` are the SAME part by construction. Note this does NOT extend to the
 *  authoring def — `normalizeRig2D` SORTS parts by `order`, so `ParsedRig2D.parts[i]` is
 *  not necessarily `Rig2DFile.parts[i]`. Anything pairing the overlay against the def
 *  must map by name, not index.
 *
 *  It is still checked rather than assumed: a vertex-count disagreement means the buffer
 *  is mid-rebuild (a frame can land between the rig edit and the reskin), and drawing
 *  through it would index one part's weights into another part's positions — the exact
 *  silent-wrong-data failure #179 was. Fail closed: skip that part for a frame. */

/** The per-part facts the overlay needs from `ParsedRig2D.parts[i]`. */
export interface OverlayRigPart {
  vertCount: number;
  visible: boolean;
}

/** The per-part facts the overlay needs from `Skin2DBuffer.parts[i]` (deformed positions). */
export interface OverlayBufferPart {
  positions: { length: number };
}

/** Indices of the parts the overlay should draw, in draw order.
 *
 *  Skips a part when it is hidden (`visible === false` — the renderer honours the same
 *  flag, so shading it would paint influence onto something not on screen), when it has
 *  no geometry, or when the buffer and the rig disagree about its vertex count. */
export function overlayPartIndices(
  rigParts: readonly OverlayRigPart[] | undefined,
  bufferParts: readonly OverlayBufferPart[] | undefined,
): number[] {
  if (!rigParts?.length || !bufferParts?.length) return [];
  const out: number[] = [];
  const n = Math.min(rigParts.length, bufferParts.length);
  for (let i = 0; i < n; i++) {
    const rp = rigParts[i], bp = bufferParts[i];
    if (!rp || !bp) continue;
    if (rp.visible === false) continue;
    if (rp.vertCount <= 0 || bp.positions.length === 0) continue;
    if (bp.positions.length !== rp.vertCount * 2) continue; // buffer mid-rebuild — skip a frame
    out.push(i);
  }
  return out;
}
