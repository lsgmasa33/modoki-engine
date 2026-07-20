/** Module-level registry of CPU-skinned 2D vertex buffers, keyed by entity id.
 *
 *  This is the clean seam between the ECS deform system and the renderer:
 *  `skin2DSystem` (an ECS system) writes deformed vertex positions here every
 *  frame, and `Scene2D` (PixiJS) reads them to build/update a `Mesh` — WITHOUT the
 *  system importing PixiJS. That keeps the deform path fully headless-testable
 *  (assert on the `Float32Array`, no renderer) and deterministic.
 *
 *  `version` is bumped only when the deformed positions actually change, so an idle
 *  rig costs the renderer nothing (Scene2D's F1 gate compares versions). */

/** One CPU-skinned part of a rig — its own deformed mesh + sprite. A single-part (v1)
 *  rig has exactly one of these; a multi-part (v2) rig has several sharing the skeleton. */
export interface Skin2DPartBuffer {
  /** Deformed vertex positions, packed [x0,y0,x1,y1,…] in the rig's texture space.
   *  Recomputed in place each frame the pose changes (the array reference is stable
   *  so Scene2D can retain it and only re-upload on a version bump). */
  positions: Float32Array;
  /** Static UVs, packed [u0,v0,…] as 0..1 within the SPRITE region (not the sheet).
   *  For a sliced/atlas sprite the renderer remaps these into `uvRect`. Set once at build. */
  uvs: Float32Array;
  /** Static triangle index buffer. Set once at build. */
  indices: Uint32Array;
  /** Resolved sprite texture URL — the whole sheet for a sliced/atlas sprite. Set once.
   *  This is the GPU variant (KTX2/WebP) the PixiJS renderer loads. */
  url: string;
  /** The part's sprite GUID (unresolved ref). The editor SceneView needs it to resolve a
   *  BROWSER-decodable source image for its Canvas2D preview — Canvas2D/`<img>` can't decode
   *  the KTX2 `url`. Absent for a non-GUID/whole-image ref. */
  sprite?: string;
  /** Normalized sub-rect of `url` the sprite occupies (u0,v0 = top-left; uw,vh = size),
   *  so a vertex's sheet UV = (u0 + uLocal·uw, v0 + vLocal·vh). Absent ⇒ whole image.
   *  Resolution-independent (normalized), so it survives variant downscaling. */
  uvRect?: { u0: number; v0: number; uw: number; vh: number };
  /** Draw order within the entity (lower = behind). */
  order: number;
  /** Part name (for debugging / editor). */
  name: string;
  /** Whether this part draws (editor visibility toggle). */
  visible: boolean;
}

export interface Skin2DBuffer {
  /** Skinned parts in draw order (always ≥1). Scene2D draws one Mesh per part. */
  parts: Skin2DPartBuffer[];
  /** Bumped whenever ANY part's positions change — Scene2D re-uploads only on a change. */
  version: number;
  /** Bind-pose vertical extent across all parts, in the rig's texture space (y-down:
   *  min = topmost, max = bottommost/feet). Measured ONCE at build from the bind-pose
   *  positions (the buffer is always constructed with un-skinned verts), so it's STABLE
   *  across animation. The 2.5D billboard renderer uses it to anchor feet to the ground. */
  bindMinY: number;
  bindMaxY: number;
}

/** Remap sprite-local 0..1 UVs into a sheet sub-rect (returns a NEW packed array). When
 *  `uvRect` is absent the UVs already address the whole image, so a copy is returned. */
export function frameSkin2DUVs(uvs: Float32Array, uvRect?: Skin2DPartBuffer['uvRect']): Float32Array {
  if (!uvRect) return uvs.slice();
  const out = new Float32Array(uvs.length);
  const { u0, v0, uw, vh } = uvRect;
  for (let i = 0; i < uvs.length; i += 2) {
    out[i] = u0 + uvs[i] * uw;
    out[i + 1] = v0 + uvs[i + 1] * vh;
  }
  return out;
}

const buffers = new Map<number, Skin2DBuffer>();

/** Read the buffer for an entity, or undefined if it hasn't been skinned yet. */
export function getSkin2DBuffer(id: number): Skin2DBuffer | undefined {
  return buffers.get(id);
}

/** Deform version for an entity, or -1 if it has no buffer. Scene2D compares this
 *  against its slot's last-seen version to decide whether to re-upload positions. */
export function getSkin2DDeformVersion(id: number): number {
  return buffers.get(id)?.version ?? -1;
}

/** Create or replace an entity's buffer (called when the rig first loads or the
 *  mesh topology/texture changes). Starts at version 0. */
export function putSkin2DBuffer(id: number, buf: Omit<Skin2DBuffer, 'version' | 'bindMinY' | 'bindMaxY'>): Skin2DBuffer {
  // The buffer is always constructed with BIND-pose positions (skin2DSystem re-skins them
  // in place only afterward), so measuring the vertical extent here captures the stable
  // bind pose — not whatever animation frame the rig happens to be on later.
  let bindMinY = Infinity, bindMaxY = -Infinity;
  for (const part of buf.parts) {
    for (let i = 1; i < part.positions.length; i += 2) {
      const y = part.positions[i];
      if (y < bindMinY) bindMinY = y;
      if (y > bindMaxY) bindMaxY = y;
    }
  }
  if (!Number.isFinite(bindMinY)) { bindMinY = 0; bindMaxY = 0; }
  const full: Skin2DBuffer = { ...buf, version: 0, bindMinY, bindMaxY };
  buffers.set(id, full);
  return full;
}

/** Bump the deform version after `positions` was rewritten in place. */
export function bumpSkin2DVersion(buf: Skin2DBuffer): void {
  buf.version++;
}

/** Drop an entity's buffer (entity removed / lost its SkinnedSprite2D). */
export function deleteSkin2DBuffer(id: number): void {
  buffers.delete(id);
}

/** Drop every buffer (scene/world swap). */
export function clearSkin2DBuffers(): void {
  buffers.clear();
}
