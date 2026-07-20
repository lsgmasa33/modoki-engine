/** buildPreviewMaterial — a THREE material from a `.mat.json` data object, for the
 *  Material Inspector's sphere preview.
 *
 *  Reuses the ENGINE's own built-in material builders (materialPresets) so the
 *  preview's color/roughness/metalness/emissive/opacity/side read exactly as the
 *  runtime would build them. Deliberately does NOT build custom (file/NodeMaterial)
 *  shaders — those are WebGPU/TSL NodeMaterials that a WebGL preview renderer can't
 *  render — a `custom` material previews as its PBR approximation instead.
 *
 *  `buildPreviewMaterial` builds the base surface synchronously; texture MAPS load
 *  asynchronously via `loadPreviewMaps` (the same refcounted shared `loadTexture3D`
 *  the runtime uses — KTX2-variant aware), so the preview shows base-color/normal/
 *  roughness/… maps, not just the flat color. The caller owns the returned textures'
 *  lifetime and MUST `releaseTexture3D` each one on teardown (see MaterialPreview). */

import * as THREE from 'three';
import { registerBuiltinMaterialTypes } from '../../runtime/loaders/materialPresets';
import { getMaterialBuilder } from '../../runtime/loaders/materialTypes';
import { isGuid, isExternalUrl } from '../../runtime/loaders/assetManifest';
import { loadTexture3D } from '../../runtime/loaders/textureResolver';

export function buildPreviewMaterial(data: Record<string, unknown>): THREE.Material {
  registerBuiltinMaterialTypes(); // idempotent — ensures pbr/unlit are registered
  // Only the synchronous built-ins: unlit → MeshBasicMaterial, everything else
  // (pbr AND custom) → the PBR builder so we never touch the async NodeMaterial path.
  const type = data.type === 'unlit' ? 'unlit' : 'pbr';
  const builder = getMaterialBuilder(type) ?? getMaterialBuilder('pbr');
  const built = builder?.build(data);
  // pbr/unlit builders are synchronous; guard the type in case a builder is swapped.
  if (!built || built instanceof Promise) return new THREE.MeshStandardMaterial({ color: (data.color as number) ?? 0xffffff });
  return built;
}

/** Resolve `data`'s texture-map GUIDs and assign them onto an already-built preview
 *  `material`, returning every texture loaded (for the caller to `releaseTexture3D`).
 *  Mirrors the runtime map wiring in meshTemplateCache, minus two deliberate cuts:
 *   - **No `textureRepeat`** — `loadTexture3D` hands back a SHARED, refcounted texture
 *     (the very instance the live scene uses); mutating `.repeat` here would retile the
 *     running scene. A preview sphere doesn't need tiling, so we leave the texture be.
 *   - **No envMap** — the preview scene's RoomEnvironment IBL already lights the sphere.
 *  Only slots the material actually has are assigned (MeshBasicMaterial has `map`/
 *  `alphaMap` but no `roughnessMap`/`normalMap`), so unlit previews stay valid. */
export async function loadPreviewMaps(
  material: THREE.Material,
  data: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<THREE.Texture[]> {
  const mat = material as unknown as Record<string, unknown> & THREE.Material;
  // MeshBasicMaterial (unlit) lacks the PBR map slots — the builder only produces
  // MeshBasic or MeshStandard here, so `'roughnessMap' in mat` cleanly gates them out.
  if (!('map' in mat)) return [];
  const flipY = (data.flipY as boolean) ?? false;
  const loaded: THREE.Texture[] = [];
  const jobs: Promise<void>[] = [];
  const loadInto = (ref: unknown, slot: string, after?: (t: THREE.Texture) => void) => {
    if (typeof ref !== 'string' || !ref) return;
    if (!(slot in mat)) return; // material type doesn't support this map — skip
    // Same GUID-or-external-URL guard as the runtime: a bare/malformed ref would
    // 404 a doomed request, so reject it up front and skip just this map.
    if (!isGuid(ref) && !isExternalUrl(ref)) {
      console.warn(`[MaterialPreview] invalid texture ref ${JSON.stringify(ref)} (expected an asset GUID) — skipping this map.`);
      return;
    }
    jobs.push(
      loadTexture3D(ref, { flipY })
        .then((t) => { (mat as Record<string, unknown>)[slot] = t; loaded.push(t); after?.(t); })
        .catch((e) => console.warn(`[MaterialPreview] texture load failed: ${ref}`, e)),
    );
  };
  loadInto(data.texture, 'map');
  loadInto(data.alphaTexture, 'alphaMap');
  loadInto(data.normalTexture, 'normalMap', () => {
    const n = (mat as { normalScale?: THREE.Vector2 }).normalScale;
    if (n && data.normalScale !== undefined) n.set(data.normalScale as number, data.normalScale as number);
  });
  loadInto(data.bumpTexture, 'bumpMap');
  loadInto(data.displacementTexture, 'displacementMap');
  loadInto(data.roughnessTexture, 'roughnessMap');
  loadInto(data.metalnessTexture, 'metalnessMap');
  loadInto(data.emissiveTexture, 'emissiveMap');
  loadInto(data.aoTexture, 'aoMap');
  loadInto(data.lightTexture, 'lightMap');
  await Promise.all(jobs);
  // Adding maps after construction needs a shader recompile to sample them. Skip it
  // if the preview was torn down mid-load (signal aborted) — the material is disposed.
  if (!signal?.aborted && loaded.length > 0) material.needsUpdate = true;
  return loaded;
}
