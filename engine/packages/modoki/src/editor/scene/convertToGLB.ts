/** Multi-format model import → GLB normalization.
 *
 *  The engine ingests GLB only (importModel → loadModelTemplates → GLTFLoader,
 *  everything downstream walks a generic THREE.Object3D). To accept OBJ / FBX /
 *  DAE sources we parse them in-browser with Three's per-format example loaders,
 *  normalize their legacy materials to MeshStandardMaterial, then re-export to a
 *  binary GLB written next to the source. The existing GLB import path then runs
 *  unchanged — dedup, hierarchy baking, texture extraction, refcount all stay on
 *  the single battle-tested code path.
 *
 *  Design notes:
 *  - Loaders are heavy (FBXLoader pulls fflate, ColladaLoader is large), so each
 *    is dynamically imported only when its format is actually encountered. None
 *    of this touches the shipped runtime bundle — conversion is editor-only.
 *  - Siblings (.mtl, external textures, .bin) are auto-resolved from the source's
 *    own directory: the dev server serves every file in an assets/ folder, so the
 *    loaders' relative fetches resolve against the source URL with no extra work.
 *  - .glb / .gltf pass through untouched — GLTFLoader handles both directly
 *    downstream, so there's nothing to convert.
 */

import * as THREE from 'three';
import { backendFetch } from '../backend/editorBackend';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { getModelPostprocessor } from '../../runtime/loaders/modelPostprocessorRegistry';

/** Source model extensions that must be converted to GLB before import.
 *  `.gltf` is intentionally excluded — it's already glTF and GLTFLoader loads it
 *  directly in the existing pipeline. */
const CONVERTIBLE_SOURCE_RE = /\.(obj|fbx|dae)$/i;

/** Formats the engine can import (after conversion where needed). Used for
 *  file-picker accept lists and "can this be imported?" checks. */
export const IMPORTABLE_MODEL_EXTS = ['.glb', '.gltf', '.obj', '.fbx', '.dae'] as const;

/** True when `path` is a non-GLB model source that needs a conversion pass. */
export function needsGLBConversion(path: string): boolean {
  return CONVERTIBLE_SOURCE_RE.test(path);
}

/** Convert legacy / loader-specific materials to MeshStandardMaterial so the GLB
 *  export is clean PBR and the downstream importer (which casts every material to
 *  MeshStandardMaterial) gets real standard materials with their maps intact.
 *
 *  OBJ/FBX/DAE typically yield MeshPhong/MeshLambert/MeshBasic. We carry over the
 *  base color + the maps that survive the model (diffuse, normal), and approximate
 *  Phong shininess → roughness. Already-standard materials are returned as-is. */
export function toStandardMaterial(src: THREE.Material): THREE.MeshStandardMaterial {
  if ((src as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    return src as THREE.MeshStandardMaterial;
  }

  const m = src as THREE.MeshPhongMaterial & THREE.MeshLambertMaterial & THREE.MeshBasicMaterial;
  const std = new THREE.MeshStandardMaterial();

  std.name = src.name;
  if (m.color) std.color.copy(m.color);
  if (m.map) std.map = m.map;
  if (m.normalMap) std.normalMap = m.normalMap;
  if (m.aoMap) std.aoMap = m.aoMap;
  if (m.emissive) std.emissive.copy(m.emissive);
  if (m.emissiveMap) std.emissiveMap = m.emissiveMap;

  // Phong shininess → roughness: high shininess = glossy = low roughness.
  // Clamp away from the extremes so converted assets don't read as mirror or
  // dead-flat. Lambert/Basic have no shininess → matte default.
  const shininess = (m as THREE.MeshPhongMaterial).shininess;
  std.roughness = typeof shininess === 'number'
    ? THREE.MathUtils.clamp(1 - shininess / 100, 0.3, 1)
    : 0.85;
  std.metalness = 0;

  std.transparent = m.transparent ?? false;
  std.opacity = m.opacity ?? 1;
  std.alphaTest = m.alphaTest ?? 0;
  std.side = m.side ?? THREE.FrontSide;

  return std;
}

/** Material map fields that hold a Texture and get exported to glTF. */
const TEXTURE_MAP_KEYS = [
  'map', 'normalMap', 'aoMap', 'emissiveMap', 'roughnessMap', 'metalnessMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'lightMap', 'envMap',
] as const;

/** True if a texture has decoded image data the exporter can serialize. A map
 *  whose image failed to load (missing sibling file, undecodable embed) has no
 *  valid image and makes GLTFExporter throw "No valid image data found". */
function hasValidImage(tex: THREE.Texture | null | undefined): boolean {
  const img = tex?.image as { width?: number; naturalWidth?: number; complete?: boolean; data?: ArrayLike<unknown> } | undefined;
  if (!img) return false;
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return img.complete && img.naturalWidth > 0;
  }
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img.width > 0;
  return (img.width ?? 0) > 0 || (img.data?.length ?? 0) > 0;
}

/** Remove texture maps whose image never resolved (missing/undecodable source).
 *  Without this the GLB export throws on the first broken texture and the whole
 *  import fails; instead we import the model untextured where its textures are
 *  unavailable (e.g. an FBX shipped without its sibling texture files). Returns
 *  the number of maps stripped. Exported for the convert-pass integration test
 *  (Missing-Test #8) that asserts a broken map is dropped and the model still
 *  exports untextured. */
export function stripUnresolvedTextures(root: THREE.Object3D): number {
  let stripped = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const m = mat as unknown as Record<string, THREE.Texture | null>;
      for (const key of TEXTURE_MAP_KEYS) {
        const tex = m[key];
        if (tex && (tex as THREE.Texture).isTexture && !hasValidImage(tex)) {
          tex.dispose();
          m[key] = null;
          (mat as THREE.Material).needsUpdate = true;
          stripped++;
        }
      }
    }
  });
  return stripped;
}

/** Walk an object graph, swapping every mesh material to MeshStandardMaterial
 *  (handles both single materials and multi-material arrays). Disposes the
 *  replaced source material to free GPU state. */
function normalizeMaterials(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((mat) => {
        const std = toStandardMaterial(mat);
        if (std !== mat) mat.dispose();
        return std;
      });
    } else {
      const std = toStandardMaterial(mesh.material);
      if (std !== mesh.material) mesh.material.dispose();
      mesh.material = std;
    }
  });
}

/** Load an OBJ, applying its companion .mtl if one is referenced/available.
 *  The `mtllib` directive names the material file; we fall back to <base>.mtl. */
async function loadOBJ(url: string, resourcePath: string, baseName: string): Promise<THREE.Object3D> {
  const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
  const objLoader = new OBJLoader();

  // Candidate .mtl names in priority order: the OBJ's own `mtllib` directive
  // first (authoritative), then the conventional <base>.mtl. Real exports often
  // disagree — e.g. an OBJ renamed on disk still references the original
  // mtllib name — so we try the convention as a fallback rather than giving up.
  const candidates: string[] = [];
  try {
    const objText = await (await fetch(url)).text();
    const declared = objText.match(/^\s*mtllib\s+(.+)\s*$/m)?.[1]?.trim();
    if (declared) candidates.push(declared);
  } catch { /* fall through to convention */ }
  if (!candidates.includes(`${baseName}.mtl`)) candidates.push(`${baseName}.mtl`);

  const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
  let loaded = false;
  for (const mtlName of candidates) {
    try {
      // Validate the candidate ourselves before parsing. The dev server's SPA
      // fallback answers a missing file with 200 + index.html — handing that to
      // MTLLoader yields a silently-empty material set that masks the real .mtl
      // further down the candidate list. Require a non-HTML body that actually
      // declares a material.
      const res = await fetch(resourcePath + mtlName);
      if (!res.ok) continue;
      if ((res.headers.get('content-type') ?? '').includes('text/html')) continue;
      const text = await res.text();
      if (!/^\s*newmtl\s/m.test(text)) continue;

      const mtlLoader = new MTLLoader();
      mtlLoader.setResourcePath(resourcePath); // where its textures live
      const materials = mtlLoader.parse(text, resourcePath);
      materials.preload();
      objLoader.setMaterials(materials);
      loaded = true;
      break;
    } catch { /* try next candidate */ }
  }
  if (!loaded) {
    // No usable .mtl — OBJLoader falls back to a default material. The mesh
    // still imports (just untextured) rather than failing the whole convert.
    console.warn(`[convertToGLB] No material library found for "${baseName}" (tried ${candidates.join(', ')}); importing untextured.`);
  }

  return objLoader.loadAsync(url);
}

/** Load an FBX. External textures resolve against the source directory. */
async function loadFBX(url: string, resourcePath: string): Promise<THREE.Object3D> {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const loader = new FBXLoader();
  loader.setResourcePath(resourcePath);
  return loader.loadAsync(url);
}

/** Load a Collada (.dae). ColladaLoader resolves textures relative to the URL. */
async function loadDAE(url: string, resourcePath: string): Promise<THREE.Object3D> {
  const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
  const loader = new ColladaLoader();
  loader.setResourcePath(resourcePath);
  const collada = await loader.loadAsync(url);
  if (!collada?.scene) throw new Error('[convertToGLB] Collada file has no scene');
  // ColladaLoader puts clips on the result, not the scene — forward them onto the
  // scene so convertSourceToGLB's sourceAnimations() picks them up.
  const anims = (collada as { animations?: THREE.AnimationClip[] }).animations;
  if (anims?.length) (collada.scene as THREE.Object3D & { animations?: THREE.AnimationClip[] }).animations = anims;
  return collada.scene;
}

/** Collect every Texture bound to a material map key in the graph. */
function collectTextures(root: THREE.Object3D): THREE.Texture[] {
  const texs: THREE.Texture[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const m = mat as unknown as Record<string, THREE.Texture | undefined>;
      for (const key of TEXTURE_MAP_KEYS) {
        const tex = m[key];
        if (tex && (tex as THREE.Texture).isTexture) texs.push(tex);
      }
    }
  });
  return texs;
}

/** Wait for every material texture's backing image to finish loading before
 *  export. The loaders kick off image loads asynchronously and DON'T await them;
 *  worse, FBXLoader assigns `texture.image` only AFTER `loadAsync` resolves, so a
 *  texture briefly has `image === null` — snapshotting once would miss it and the
 *  export (or the unresolved-texture strip) would drop a perfectly good texture.
 *  So we POLL until every texture has settled (loaded or errored), bounded by a
 *  timeout, breaking early once no image is still pending/unassigned. */
async function awaitTextureImages(root: THREE.Object3D): Promise<void> {
  const isErrored = (img: unknown) =>
    typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && img.complete && img.naturalWidth === 0;
  const settled = (t: THREE.Texture) => hasValidImage(t) || isErrored(t.image);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const texs = collectTextures(root);
    if (texs.length === 0 || texs.every(settled)) break;
    // Prefer awaiting in-flight image loads over a busy spin; fall back to a short
    // tick when some textures still have no image assigned (FBX hasn't yet).
    const pending = texs
      .map((t) => t.image)
      .filter((img): img is HTMLImageElement =>
        typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && !img.complete);
    if (pending.length) {
      await Promise.race([
        Promise.all(pending.map((img) => new Promise<void>((res) => {
          img.addEventListener('load', () => res(), { once: true });
          img.addEventListener('error', () => res(), { once: true });
        }))),
        new Promise<void>((res) => setTimeout(res, 1000)),
      ]);
    } else {
      await new Promise<void>((res) => setTimeout(res, 120));
    }
  }

  // Final decode pass for ImageBitmap/canvas/data images.
  await Promise.all(collectTextures(root).map((t) => {
    const img = t.image as { decode?: () => Promise<void> } | undefined;
    return img?.decode ? img.decode().catch(() => {}) : Promise.resolve();
  }));
}

/** Export an object graph to a binary GLB ArrayBuffer.
 *
 *  `animations` MUST be passed explicitly — GLTFExporter does NOT read
 *  `object.animations`, so without this every skeletal clip a rigged FBX/DAE
 *  carries is silently dropped (the whole point of importing an animated model).
 *  The clips' tracks reference nodes inside `object`, so they bind correctly as
 *  long as the same object graph is exported. Exported for the convert-pass
 *  integration test (Missing-Test #8 / F9) that re-parses the GLB and asserts the
 *  clip names survive the export → re-import round trip. */
export async function exportGLB(object: THREE.Object3D, animations: THREE.AnimationClip[] = []): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(object, { binary: true, animations });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('[convertToGLB] GLTFExporter did not return binary GLB');
  }
  return result;
}

/** Animation clips a parsed source object carries (FBXLoader + ColladaLoader set
 *  `.animations` on their root). Returns [] for static formats (OBJ). */
function sourceAnimations(object: THREE.Object3D): THREE.AnimationClip[] {
  return (object as THREE.Object3D & { animations?: THREE.AnimationClip[] }).animations ?? [];
}

/** FBX exports clips as "ArmatureName|ActionName" (e.g. "Rig-Alien-Animal|Walk-
 *  Cycle"). Strip the armature prefix to the bare action name so the editor +
 *  game show "Walk-Cycle", not the rig-qualified mouthful. Mutates clip names in
 *  place. PER-CLIP (C9): strips only the clips whose bare name is unambiguous, and
 *  KEEPS the rig-qualified name for just the specific clips whose bare name would
 *  collide — so one colliding pair doesn't leave ALL clips prefixed.
 *  Exported for unit tests. */
export function stripClipPrefixes(animations: THREE.AnimationClip[]): void {
  const bare = animations.map((a) => (a.name.includes('|') ? a.name.slice(a.name.lastIndexOf('|') + 1) : a.name));
  const counts = new Map<string, number>();
  for (const b of bare) counts.set(b, (counts.get(b) ?? 0) + 1);
  animations.forEach((a, i) => { if (counts.get(bare[i]) === 1) a.name = bare[i]; });
}

/** base64-encode an ArrayBuffer in chunks (avoids arg-count blowups on large
 *  buffers from String.fromCharCode(...wholeArray)). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Free geometries/materials/textures from a parsed source object once it's been
 *  exported, so the convert pass doesn't leak GPU/CPU resources. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const val = (mat as unknown as Record<string, unknown>)[key];
        if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose();
      }
      mat.dispose();
    }
  });
}

/** Dispose a parsed source object's GPU resources. Exposed so callers that take
 *  a `loadSourceModel()` object (e.g. the inspector preview) can release it. */
export function disposeSourceModel(root: THREE.Object3D): void {
  disposeObject(root);
}

/** Remove meshes the postprocessor's `filterMesh` rejects (e.g. ground/helper
 *  planes a rigged FBX bundles) so they never enter the GLB. Mirrors the flatten
 *  path's filterMesh, but applied at conversion time so it ALSO covers the rigged
 *  (SkinnedModel) path, which renders the GLB whole. Returns the count removed. */
function applyMeshFilter(root: THREE.Object3D, postprocessorId: string): number {
  const pp = getModelPostprocessor(postprocessorId);
  if (!pp.filterMesh) return 0;
  const toRemove: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && !pp.filterMesh!(mesh)) toRemove.push(mesh);
  });
  for (const mesh of toRemove) {
    mesh.removeFromParent();
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m?.dispose();
  }
  return toRemove.length;
}

/** Parse a non-GLB model source (OBJ/FBX/DAE) into a ready-to-render
 *  THREE.Object3D: siblings resolved, textures awaited, materials normalized to
 *  MeshStandardMaterial. This is the shared front-half of the import — both the
 *  GLB conversion and the inspector's live preview build on it, so the preview
 *  shows exactly what will be imported. Throws on unsupported format or no mesh. */
export async function loadSourceModel(sourcePath: string, postprocessorId = 'none'): Promise<THREE.Object3D> {
  const slash = sourcePath.lastIndexOf('/');
  const dir = sourcePath.substring(0, slash);
  const fileName = sourcePath.substring(slash + 1);
  const dot = fileName.lastIndexOf('.');
  const baseName = fileName.substring(0, dot);
  const ext = fileName.substring(dot).toLowerCase();

  const sourceUrl = assetUrl(sourcePath);
  // Trailing-slash directory URL so the loaders' relative fetches (textures,
  // .mtl) resolve as siblings of the source file.
  const resourcePath = assetUrl(`${dir}/`);

  let object: THREE.Object3D;
  try {
    if (ext === '.obj') object = await loadOBJ(sourceUrl, resourcePath, baseName);
    else if (ext === '.fbx') object = await loadFBX(sourceUrl, resourcePath);
    else if (ext === '.dae') object = await loadDAE(sourceUrl, resourcePath);
    else throw new Error(`Unsupported source format: ${ext}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Turn the loaders' terse errors into something actionable. Pre-7.x FBX
    // files fail in two ways depending on ASCII vs binary: "FBX version not
    // supported, FileVersion: 6100" or "Cannot find the version number" — both
    // mean the same thing to a user who just wants their model in.
    if (ext === '.fbx' && /version/i.test(msg)) {
      throw new Error(`${fileName}: this is an old FBX (6.x) format three.js can't read. Re-export it as FBX 7.x (binary), or import the OBJ/DAE version instead.`);
    }
    throw new Error(`${fileName}: could not be loaded — ${msg}`);
  }

  // Drop postprocessor-filtered meshes (ground/helper planes) before anything
  // else touches them — covers both the flatten and rigged import paths.
  const removed = applyMeshFilter(object, postprocessorId);
  if (removed > 0) console.log(`[convertToGLB] "${fileName}": filtered out ${removed} mesh(es) via "${postprocessorId}" postprocessor.`);

  // Strip embedded lights/cameras — an imported model shouldn't bring the
  // artist's scene lights (FBX often bundles a huge PointLight that blows out the
  // whole model) or cameras; the scene owns lighting + camera.
  const extras: THREE.Object3D[] = [];
  object.traverse((o) => { if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) extras.push(o); });
  for (const o of extras) o.removeFromParent();
  if (extras.length) console.log(`[convertToGLB] "${fileName}": stripped ${extras.length} embedded light(s)/camera(s).`);

  let hasMesh = false;
  object.traverse((c) => { if ((c as THREE.Mesh).isMesh) hasMesh = true; });
  if (!hasMesh) {
    disposeObject(object);
    throw new Error(`[convertToGLB] "${fileName}" contains no importable meshes`);
  }

  // Textures load asynchronously after the loader resolves — wait for them so
  // the export (or preview) sees complete image data, not blank/partial textures.
  await awaitTextureImages(object);
  // Drop any maps that still failed to resolve (missing sibling files, undecodable
  // embeds) so GLTFExporter doesn't throw "No valid image data found" — the model
  // imports untextured where its textures are unavailable.
  const stripped = stripUnresolvedTextures(object);
  if (stripped > 0) {
    console.warn(`[convertToGLB] "${fileName}": ${stripped} texture map(s) had no resolvable image and were dropped (imported untextured).`);
  }
  normalizeMaterials(object);
  return object;
}

/** Convert a non-GLB model source (OBJ/FBX/DAE) to a binary GLB written next to
 *  the source, returning the GLB asset path. `.glb` / `.gltf` are returned
 *  unchanged. Throws if the source has no importable meshes or the write fails. */
export async function convertSourceToGLB(sourcePath: string, postprocessorId = 'none'): Promise<string> {
  if (!needsGLBConversion(sourcePath)) return sourcePath;

  const slash = sourcePath.lastIndexOf('/');
  const dir = sourcePath.substring(0, slash);
  const fileName = sourcePath.substring(slash + 1);
  const baseName = fileName.substring(0, fileName.lastIndexOf('.'));

  const object = await loadSourceModel(sourcePath, postprocessorId);
  const animations = sourceAnimations(object);
  stripClipPrefixes(animations);
  const glb = await exportGLB(object, animations);
  // Free the parsed THREE scene BEFORE base64-encoding the GLB so peak memory
  // doesn't hold both at once (C8 — large rigged characters). Keep this dispose
  // above arrayBufferToBase64 below.
  disposeObject(object);
  if (animations.length) {
    console.log(`[convertToGLB] ${baseName}: preserved ${animations.length} animation clip(s): ${animations.map((c) => c.name).join(', ')}`);
  }

  const glbPath = `${dir}/${baseName}.glb`;
  const res = await backendFetch('/api/write-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: glbPath, content: arrayBufferToBase64(glb), encoding: 'base64' }),
  });
  if (!res.ok) {
    throw new Error(`[convertToGLB] Failed to write ${glbPath}: ${res.status}`);
  }

  console.log(`[convertToGLB] ${fileName} → ${baseName}.glb (${(glb.byteLength / 1024).toFixed(0)} KB)`);
  return glbPath;
}
