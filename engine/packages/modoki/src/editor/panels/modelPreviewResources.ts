/** ModelPreview's owned-resource bookkeeping — collection and disposal, pulled out of the
 *  panel so it carries a test (editor .tsx does not; see CLAUDE.md § Tests).
 *
 *  `THREE.Material.dispose()` frees GPU material state but NOT the textures hanging off it
 *  (map, normalMap, emissiveMap, …) — those need their own `.dispose()`. Every LOD level the
 *  panel loads is a separate `loadAsync(url)` call (a separate glTF document), so texture
 *  sharing only ever happens WITHIN one document; the `Set` here dedups that case so a
 *  texture reused by several materials in the same document is freed exactly once.
 *
 *  ⚠️ This is NOT a copy of `meshTemplateCache.ts`'s private `disposeMaterial`, and must not be
 *  "fixed" into one. That one additionally (a) sweeps `mat.userData.textures` — the TSL /
 *  NodeMaterial convention — and (b) RELEASES a refcounted shared texture (`isSharedTexture` →
 *  `releaseTexture3D`) instead of disposing it, because its materials come from `loadTexture3D`'s
 *  shared cache. Neither applies here and both would be wrong: the panel's materials come from
 *  its own `GLTFLoader` / `loadSourceModel`, it never calls `loadTexture3D` (its only
 *  textureResolver import is `getKTX2Loader`), so no texture in these sets is shared or
 *  refcounted — the panel owns them outright and disposing is the correct release.
 */

import type * as THREE from 'three';

/** Minimal shape this module needs from a THREE.Material — just enough to sweep its own
 *  enumerable keys for texture-valued properties without importing the real three.js types. */
type MaterialLike = Record<string, unknown>;

interface TextureLike {
  isTexture: true;
  dispose(): void;
}

function isTextureLike(v: unknown): v is TextureLike {
  return !!v && typeof v === 'object' && (v as { isTexture?: unknown }).isTexture === true;
}

/** Add `mat` to `ownedMaterials`, and sweep its own keys for texture-valued properties
 *  (map, normalMap, emissiveMap, …) into `ownedTextures`. Any key whose value is not a
 *  texture (including one that merely happens to expose its own `dispose()`) is left alone —
 *  this is a targeted sweep of a single material's own fields, not the blanket "dispose
 *  everything with a dispose method" sweep the issue warned against.
 */
export function collectMaterialResources(
  ownedMaterials: Set<THREE.Material>,
  ownedTextures: Set<THREE.Texture>,
  mat: THREE.Material,
): void {
  ownedMaterials.add(mat);
  const rec = mat as unknown as MaterialLike;
  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (isTextureLike(value)) ownedTextures.add(value as unknown as THREE.Texture);
  }
}

/** Dispose every geometry, material and texture in the three sets, then clear all three.
 *  Order (geometries, then materials, then textures) matches the panel's existing dispose
 *  loops — textures are disposed last since a material may still reference them until then. */
export function disposeOwnedResources(
  ownedGeometries: Set<THREE.BufferGeometry>,
  ownedMaterials: Set<THREE.Material>,
  ownedTextures: Set<THREE.Texture>,
): void {
  for (const g of ownedGeometries) g.dispose();
  for (const m of ownedMaterials) m.dispose();
  for (const t of ownedTextures) t.dispose();
  ownedGeometries.clear();
  ownedMaterials.clear();
  ownedTextures.clear();
}
