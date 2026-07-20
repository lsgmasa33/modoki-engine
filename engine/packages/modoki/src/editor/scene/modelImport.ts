/** Model import — load a GLB, create deduplicated mesh/material/texture assets.
 *  Tracks generated files in the model's .meta.json for cleanup on delete. */

import * as THREE from 'three';
import { backendFetch } from '../backend/editorBackend';
import { getCurrentWorld, registerEntity } from '../../runtime/ecs/world';
import { Transform, EntityAttributes, ModelSource, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, Bone, type MeshAsset, type MaterialAsset } from '../../runtime/traits';
import { loadModelTemplates, getTemplatesForModel, invalidateModel, invalidateMaterial } from '../../runtime/loaders/meshTemplateCache';
import { ensureRiggedModelLoaded, invalidateRiggedModel } from '../../runtime/loaders/riggedModelCache';
import { offerParsedGltf, disposePendingGltf } from '../../runtime/loaders/parsedGltfHandoff';
import { invalidateTexture } from '../../runtime/loaders/textureResolver';
import { loadGLB } from '../../runtime/loaders/loadGLB';
import { getModelPostprocessor } from '../../runtime/loaders/modelPostprocessorRegistry';
import { newGuid, registerAsset, getGuidForPath, isGuid } from '../../runtime/loaders/assetManifest';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { convertSourceToGLB, needsGLBConversion } from './convertToGLB';
import { extractRigBones, type RigBoneInfo } from './rigBones';

async function writeAssetFile(path: string, content: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return res.ok;
  } catch { return false; }
}

/** SHA-256 hex of a string, via SubtleCrypto. Used to derive stable, content-
 *  addressed filenames for extracted textures so re-imports of the same source
 *  bytes land on the same path — and so the existing `.meta.json` sidecar
 *  (which carries the guid) survives and external material refs don't dangle. */
async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** base64-encode bytes in chunks (avoids arg-count blowups from
 *  `String.fromCharCode(...wholeArray)` on multi-megabyte texture PNGs).
 *  Mirrors `convertToGLB.arrayBufferToBase64`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Encode a canvas to PNG bytes **asynchronously** off the main thread.
 *  `canvas.toBlob` hands the PNG compression to the browser's encoder thread
 *  (vs `toDataURL`, which blocks the main thread and additionally allocates a
 *  base64 string the caller must re-split). Falls back to the synchronous
 *  `toDataURL` only when `toBlob` is unavailable (e.g. older jsdom). (F5) */
async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (blob) return new Uint8Array(await blob.arrayBuffer());
  }
  // Fallback: synchronous data URL (kept so import still works where toBlob isn't
  // implemented). The base64 payload after the comma decodes to the PNG bytes.
  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Read an existing asset JSON file's `id` so re-import can preserve the
 *  stable guid instead of minting a fresh one (which would dangle every
 *  external reference). Returns undefined when the file doesn't exist yet
 *  (first-time import) or doesn't carry a valid guid. */
async function readExistingId(path: string): Promise<string | undefined> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return undefined;
    const json = await res.json();
    return typeof json?.id === 'string' && isGuid(json.id) ? json.id : undefined;
  } catch { return undefined; }
}

/** Read an existing `.mat.json`'s full contents (or null when absent / unparseable).
 *  Used to carry manual material edits across a re-import — a hand-assigned
 *  texture or NPR field the source GLB/DAE can't reproduce would otherwise be
 *  clobbered by the freshly-extracted (textureless) material. */
async function readExistingMaterial(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch { return null; }
}

/** Resolve the stable GUID for a pre-existing material file (an override target
 *  or a protected/dedup material), registering it so downstream resolvers
 *  (loadGLB, the runtime manifest) find it. The GUID-only invariant forbids
 *  storing a literal path — so we never fall back to one:
 *   - manifest GUID if already registered;
 *   - else the file's own `id` (registered now);
 *   - else mint a GUID. If the file exists, persist the minted id into it so the
 *     ref stays stable across sessions/builds; if the file is missing entirely
 *     (a dangling override — a config error), mint + register in-memory and warn.
 *  Either way the returned ref is ALWAYS a GUID. */
async function resolveMaterialGuid(path: string): Promise<string> {
  const known = getGuidForPath(path);
  if (known) return known;
  const existing = await readExistingMaterial(path);
  let id = existing && typeof existing.id === 'string' && isGuid(existing.id) ? existing.id : undefined;
  if (!id) {
    id = newGuid();
    if (existing) {
      await writeAssetFile(path, JSON.stringify({ ...existing, id }, null, 2));
    } else {
      console.error(`[modelImport] material override not found: ${path} — minting a GUID; the reference will dangle until the file exists.`);
    }
  }
  registerAsset(id, path, 'material');
  return id;
}

/** Read a binary asset's sidecar (`<path>.meta.json`) and return its full
 *  contents — used for textures + the GLB itself, both of which carry their
 *  guid in the sidecar (not the file). Empty object when absent. */
async function readMeta(path: string): Promise<Record<string, unknown>> {
  try {
    const res = await backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`);
    return res.ok ? await res.json() : {};
  } catch { return {}; }
}

// ── Material hashing for dedup ──

function hashMaterial(mat: THREE.MeshStandardMaterial, texturePaths: Map<string, string>): string {
  // Texture IDENTITY (not mere presence): two materials with identical scalar
  // PBR props but DIFFERENT maps must hash differently — otherwise dedup
  // collapses them and every mesh that used the second material renders with
  // the first's textures (F2). Prefer the content-addressed extracted path
  // (stable; also folds byte-identical maps from distinct THREE.Texture
  // instances into one material); fall back to the texture uuid when extraction
  // was skipped/failed so two distinct maps still can't collide.
  const texId = (tex: THREE.Texture | null | undefined): string | null =>
    tex ? (texturePaths.get(tex.uuid) ?? tex.uuid) : null;
  return JSON.stringify({
    color: mat.color?.getHex() ?? 0xffffff,
    roughness: Math.round((mat.roughness ?? 1) * 100),
    metalness: Math.round((mat.metalness ?? 0) * 100),
    emissive: mat.emissive?.getHex() ?? 0x000000,
    emissiveIntensity: Math.round((mat.emissiveIntensity ?? 1) * 100),
    transparent: mat.transparent ?? false,
    opacity: Math.round((mat.opacity ?? 1) * 100),
    side: mat.side,
    alphaTest: Math.round((mat.alphaTest ?? 0) * 100),
    envMapIntensity: Math.round((mat.envMapIntensity ?? 1) * 100),
    flatShading: mat.flatShading ?? false,
    wireframe: mat.wireframe ?? false,
    vertexColors: mat.vertexColors ?? false,
    map: texId(mat.map),
    alphaMap: texId(mat.alphaMap),
    normalMap: texId(mat.normalMap),
    bumpMap: texId(mat.bumpMap),
    displacementMap: texId(mat.displacementMap),
    roughnessMap: texId(mat.roughnessMap),
    metalnessMap: texId(mat.metalnessMap),
    emissiveMap: texId(mat.emissiveMap),
    aoMap: texId(mat.aoMap),
    lightMap: texId(mat.lightMap),
  });
}

function materialFileName(mat: THREE.MeshStandardMaterial): string {
  // Use Three.js material name if available
  if (mat.name) {
    return mat.name.replace(/[/\\:*?"<>|.\s]/g, '_');
  }
  // Derive from color
  const hex = (mat.color?.getHex() ?? 0xffffff).toString(16).padStart(6, '0');
  let name = `mat_${hex}`;
  if (mat.transparent) name += '_trans';
  if (mat.side === THREE.DoubleSide) name += '_dbl';
  return name;
}

function extractMaterialAsset(mat: THREE.MeshStandardMaterial, _textureDir: string, texturePaths: Map<string, string>): MaterialAsset {
  const asset: MaterialAsset = {
    version: 1,
    color: mat.color?.getHex() ?? 0xffffff,
    roughness: mat.roughness ?? 1,
    metalness: mat.metalness ?? 0,
    emissive: mat.emissive?.getHex() ?? 0x000000,
    emissiveIntensity: mat.emissiveIntensity ?? 1,
    transparent: mat.transparent ?? false,
    opacity: mat.opacity ?? 1,
    side: mat.side === THREE.DoubleSide ? 'double' : mat.side === THREE.BackSide ? 'back' : 'front',
    alphaTest: mat.alphaTest ?? 0,
    envMapIntensity: mat.envMapIntensity ?? 1,
    aoMapIntensity: mat.aoMapIntensity ?? 1,
    lightMapIntensity: mat.lightMapIntensity ?? 1,
    bumpScale: mat.bumpScale ?? 1,
    displacementScale: mat.displacementScale ?? 1,
    displacementBias: mat.displacementBias ?? 0,
    normalScale: mat.normalScale?.x ?? 1,
    flatShading: mat.flatShading ?? false,
    wireframe: mat.wireframe ?? false,
    vertexColors: mat.vertexColors ?? false,
  };
  // Reference each extracted PBR map if present. The texture-registration loop
  // runs before this, so the guid always resolves. Texture fields are GUID-only —
  // never store a raw path: on the (regression-only) miss, warn and omit the
  // ref rather than write a path the runtime resolver would reject. `extractTextures`
  // already writes the normal/rough/metal map files (with `_normal`/`_rough`/`_metal`
  // suffixes); here we finally bind them onto the material — previously only the
  // base-color map survived, so a model's normal map was silently dropped.
  const refTexture = (tex: THREE.Texture | null, slot: string): string | undefined => {
    if (!tex) return undefined;
    if (texturePaths.has(tex.uuid)) {
      const texPath = texturePaths.get(tex.uuid)!;
      const guid = getGuidForPath(texPath);
      if (guid) return guid;
      console.error(`[modelImport] texture not registered before material write: ${texPath} — omitting the ref (would otherwise store a literal path).`);
      return undefined;
    }
    // The texture extraction step caught an error and skipped writing this
    // texture (see extractTextures' try/catch). Without this warning the
    // material is silently written without its map ref and renders wrong
    // until the user re-imports — a bug we'd otherwise only notice by
    // looking at the render.
    console.warn(
      `[Import] Material "${mat.name || '(unnamed)'}" references its ${slot} texture ` +
      `"${tex.name || tex.uuid}" that failed to extract — material will be written ` +
      `WITHOUT its ${slot} map. Re-import to retry.`,
    );
    return undefined;
  };
  asset.texture = refTexture(mat.map, 'baseColor');
  asset.alphaTexture = refTexture(mat.alphaMap, 'alpha');
  asset.normalTexture = refTexture(mat.normalMap, 'normal');
  asset.bumpTexture = refTexture(mat.bumpMap, 'bump');
  asset.displacementTexture = refTexture(mat.displacementMap, 'displacement');
  asset.roughnessTexture = refTexture(mat.roughnessMap, 'roughness');
  asset.metalnessTexture = refTexture(mat.metalnessMap, 'metalness');
  asset.emissiveTexture = refTexture(mat.emissiveMap, 'emissive');
  asset.aoTexture = refTexture(mat.aoMap, 'ao');
  asset.lightTexture = refTexture(mat.lightMap, 'light');
  return asset;
}

// ── Texture extraction ──

/** Map a Three wrap constant to the import-settings enum. */
function wrapName(w: number): 'repeat' | 'clamp' | 'mirror' {
  if (w === THREE.ClampToEdgeWrapping) return 'clamp';
  if (w === THREE.MirroredRepeatWrapping) return 'mirror';
  return 'repeat';
}

/** Seed a `.meta.json` `texture` block from a source Three texture. Non-color maps
 *  (normal/rough/metal — `suffix` set) MUST be sampled as linear data regardless of
 *  the source's tagged colorSpace, or the texture pipeline color-manages them wrongly
 *  (washed-out normals, wrong rough/metal response). Base-color maps inherit the
 *  source colorSpace ('srgb' string → srgb, anything else → linear). (F6) */
export function seedTextureSettings(tex: THREE.Texture, suffix: string): { colorspace: 'srgb' | 'linear'; wrapS: 'repeat' | 'clamp' | 'mirror'; wrapT: 'repeat' | 'clamp' | 'mirror' } {
  // Color maps (base/emissive/light) carry sRGB-encoded color; every other slot
  // (normal/rough/metal/ao/bump/displacement/alpha) is linear data.
  const isColorMap = suffix === '' || suffix === '_emissive' || suffix === '_light';
  const colorspace: 'srgb' | 'linear' = isColorMap
    ? (tex.colorSpace === THREE.SRGBColorSpace ? 'srgb' : 'linear')
    : 'linear';
  return { colorspace, wrapS: wrapName(tex.wrapS), wrapT: wrapName(tex.wrapT) };
}

async function extractTextures(
  templates: Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>,
  textureDir: string,
): Promise<{ texturePaths: Map<string, string>; textureFiles: string[]; textureSettings: Map<string, ReturnType<typeof seedTextureSettings>> }> {
  const texturePaths = new Map<string, string>(); // texture.uuid → path
  const textureFiles: string[] = [];
  // texPath → seeded `texture` settings block (colorspace/wrap), used when writing
  // the stub sidecar so the pipeline reads non-color maps as linear (F6).
  const textureSettings = new Map<string, ReturnType<typeof seedTextureSettings>>();
  const seen = new Set<string>();

  for (const [, template] of templates) {
    const mat = template.material as THREE.MeshStandardMaterial;
    const textures: { tex: THREE.Texture; suffix: string }[] = [];
    if (mat.map) textures.push({ tex: mat.map, suffix: '' });
    if (mat.alphaMap) textures.push({ tex: mat.alphaMap, suffix: '_alpha' });
    if (mat.normalMap) textures.push({ tex: mat.normalMap, suffix: '_normal' });
    if (mat.bumpMap) textures.push({ tex: mat.bumpMap, suffix: '_bump' });
    if (mat.displacementMap) textures.push({ tex: mat.displacementMap, suffix: '_disp' });
    if (mat.roughnessMap) textures.push({ tex: mat.roughnessMap, suffix: '_rough' });
    if (mat.metalnessMap) textures.push({ tex: mat.metalnessMap, suffix: '_metal' });
    if (mat.emissiveMap) textures.push({ tex: mat.emissiveMap, suffix: '_emissive' });
    if (mat.aoMap) textures.push({ tex: mat.aoMap, suffix: '_ao' });
    if (mat.lightMap) textures.push({ tex: mat.lightMap, suffix: '_light' });

    for (const { tex, suffix } of textures) {
      if (seen.has(tex.uuid)) continue;
      seen.add(tex.uuid);

      // Extract texture to canvas → async PNG encode (off main thread, F5) →
      // content-addressed filename → write.
      try {
        if (!tex.image) continue;
        const img = tex.image as HTMLImageElement | ImageBitmap;
        const canvas = document.createElement('canvas');
        canvas.width = (img as any).width || 256;
        canvas.height = (img as any).height || 256;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img as CanvasImageSource, 0, 0);
        // `toBlob` encodes PNG on the browser's encoder thread (no main-thread
        // freeze, unlike the old synchronous `toDataURL`); base64 the bytes for
        // the JSON write body. The encoded PNG is byte-equivalent in outcome.
        const pngBytes = await canvasToPngBytes(canvas);
        const base64 = bytesToBase64(pngBytes);

        // Stable filename derived from a content-hash slug of the PNG bytes.
        // Authored `tex.name` is NOT honored as the leading component because
        // Blender stamps generic names like "Image_001" on every map — two
        // distinct textures with the same authored name would write to the
        // same path and the second silently overwrites the first. The hash
        // also makes the path stable across re-imports (so the existing
        // `.meta.json` sidecar — and the guid — survives) without depending
        // on the GLB to name its textures uniquely.
        const contentHash = await sha256Hex(base64);
        const baseName = tex.name
          ? `${tex.name}_${contentHash.slice(0, 8)}`
          : `texture_${contentHash.slice(0, 8)}`;
        const texName = baseName.replace(/[/\\:*?"<>|\s]/g, '_');
        const texPath = `${textureDir}/${texName}${suffix}.png`;

        const writeRes = await backendFetch('/api/write-file', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: texPath, content: base64, encoding: 'base64' }),
        });
        if (!writeRes.ok) {
          console.error(`[Import] /api/write-file failed for ${texPath}: ${writeRes.status}`);
          continue;
        }
        texturePaths.set(tex.uuid, texPath);
        textureFiles.push(texPath);
        textureSettings.set(texPath, seedTextureSettings(tex, suffix));
      } catch (e) {
        console.warn(`[Import] Failed to extract texture ${tex.name || tex.uuid}:`, e);
      }
    }
  }

  return { texturePaths, textureFiles, textureSettings };
}

/** Register every extracted texture in the manifest so subsequent material writes
 *  can store a GUID ref instead of a raw path, and seed a stub `.meta.json` for
 *  newly-minted guids (colorspace/wrap) so non-color maps convert as linear data
 *  (F6). Guid priority: existing sidecar → already-known manifest entry → mint.
 *  Shared by the static and rigged import paths (was inlined in the static path). */
async function registerExtractedTextures(
  texturePaths: Map<string, string>,
  textureSettings: Map<string, ReturnType<typeof seedTextureSettings>>,
): Promise<void> {
  for (const texPath of new Set(texturePaths.values())) {
    const existingMeta = await readMeta(texPath);
    const sidecarGuid = (typeof existingMeta.id === 'string' && isGuid(existingMeta.id))
      ? existingMeta.id
      : undefined;
    const guid = sidecarGuid ?? getGuidForPath(texPath) ?? newGuid();
    registerAsset(guid, texPath, 'texture');
    if (!sidecarGuid) {
      // Seed the `texture` block (colorspace/wrap) from the source Three texture so
      // the conversion pipeline reads non-color maps (normal/rough/metal) as linear
      // data — extracted-as-PNG textures default to srgb otherwise (F6). Only on a
      // freshly-minted sidecar (no existing guid), so we never clobber settings a
      // user already tuned in the Texture Inspector.
      const seeded = textureSettings.get(texPath);
      await backendFetch('/api/write-meta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: texPath,
          meta: {
            ...existingMeta,
            version: (existingMeta.version as number) ?? 2,
            id: guid,
            ...(seeded ? { texture: { ...(existingMeta.texture as object ?? {}), ...seeded } } : {}),
          },
        }),
      }).catch(() => {});
    }
    // Drop any in-memory texture for this path — re-import may have produced
    // fresh bytes (PNG → KTX2 variants) and a stale cache entry would survive
    // the next scene load via the refcount path's "already cached" short-circuit.
    invalidateTexture(texPath);
  }
}

/** Per-material dedup + `.mat.json` write, returning the material's GUID ref.
 *  Hash-dedups (so the same material across meshes/slots writes one file), preserves
 *  the existing file's stable id (external refs don't dangle) and carries over manual
 *  edits the importer doesn't itself write (hand-assigned maps on source-less slots,
 *  NPR fields). Skips writing for protected/override material paths (resolves their
 *  guid instead). Shared by the static and rigged import paths. */
interface MatDedupCtx {
  materialDir: string;
  textureDir: string;
  texturePaths: Map<string, string>;
  matHashToRef: Map<string, string>;
  matHashToPath: Map<string, string>;
  matFiles: string[];
  protectedMatPaths: Set<string>;
}

async function dedupMaterialToFile(mat: THREE.MeshStandardMaterial, ctx: MatDedupCtx): Promise<string> {
  const matHash = hashMaterial(mat, ctx.texturePaths);
  if (!ctx.matHashToRef.has(matHash)) {
    const matName = materialFileName(mat);
    const dedupPath = `${ctx.materialDir}/${matName}.mat.json`;
    // Don't overwrite materials used as override targets (they're manually
    // managed). For those, resolve the ref the same way as the override branch.
    if (!ctx.protectedMatPaths.has(dedupPath)) {
      const matAsset = extractMaterialAsset(mat, ctx.textureDir, ctx.texturePaths);
      // Preserve the existing id from disk so external refs don't dangle.
      const existingId = await readExistingId(dedupPath);
      matAsset.id = existingId ?? newGuid();
      // Carry over manual edits the importer doesn't itself write: a hand-assigned
      // `texture` (kept only when the source has none, so a real source map still
      // wins) and any extra fields like `nprColorPreserve`. `extractMaterialAsset`
      // ALWAYS assigns the map slots, setting them to `undefined` when the source
      // GLB carries no such map — so treat an `undefined`-valued source field as
      // ABSENT so a hand-assigned map on a source-less slot survives, while a real
      // source map (defined) still wins.
      const finalAsset: Record<string, unknown> = { ...matAsset };
      const existingMat = await readExistingMaterial(dedupPath);
      if (existingMat) {
        for (const k of Object.keys(existingMat)) {
          if (finalAsset[k] === undefined) finalAsset[k] = existingMat[k];
        }
      }
      registerAsset(matAsset.id, dedupPath, 'material');
      await writeAssetFile(dedupPath, JSON.stringify(finalAsset, null, 2));
      // Evict the stale in-memory material so the next scene load re-reads from
      // disk — without this, a same-session scene re-open keeps rendering with
      // the pre-import factors / texture.
      invalidateMaterial(dedupPath);
      ctx.matHashToRef.set(matHash, matAsset.id);
    } else {
      ctx.matHashToRef.set(matHash, await resolveMaterialGuid(dedupPath));
    }
    ctx.matHashToPath.set(matHash, dedupPath);
    ctx.matFiles.push(dedupPath);
  }
  return ctx.matHashToRef.get(matHash)!;
}

// ── Main import ──

/** Options for customizing the import pipeline per-model */
export interface ImportOptions {
  /** Mesh names to exclude from import (e.g., ground planes) */
  excludeMeshes?: string[];
  /** Override material assignment: meshName → material asset path.
   *  Use when the GLB shares a material across meshes that need different materials. */
  materialOverrides?: Record<string, string>;
}

/** Import a GLB model: load templates, create deduplicated mesh/material/texture assets.
 *  Returns the root entity ID. */
/** Lightweight one-time inspection of a converted GLB to decide the import path.
 *  A GLB with a skeleton (SkinnedMesh) MUST NOT go through the flatten pipeline —
 *  loadModelTemplates strips the bone hierarchy + bind matrices + clips. We route
 *  those to the SkinnedModel path instead. Also returns the bind-pose bounding box
 *  so the importer can auto-fit the entity scale. */
/** One renderable mesh node of a rigged GLB + the distinct materials it uses —
 *  becomes one SkinnedMeshRenderer entity at import (Unity's per-renderer).
 *  `materials` is the slot-name list (for logging / back-compat); `slotMaterials`
 *  carries the actual Three material per slot so the importer can extract each to a
 *  `.mat.json` and wire `SkinnedMeshRenderer.materials`. The slot key is
 *  `mat.name || mesh.name`, matching the render side (scene3DSync `buildNodes`). */
export interface RigMeshNodeInfo {
  node: string;
  materials: string[];
  slotMaterials?: Map<string, THREE.MeshStandardMaterial>;
}

async function inspectGLBRig(glbPath: string): Promise<{
  hasSkinned: boolean;
  clipNames: string[];
  size: THREE.Vector3;
  meshNodes: RigMeshNodeInfo[];
  bones: RigBoneInfo[];
}> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] };
  try {
    gltf = await loader.loadAsync(assetUrl(glbPath));
  } catch (e) {
    // Inspection failed (unreadable GLB, no dev server in tests) — treat as
    // non-rigged so import falls back to the flatten path, which has its own
    // error handling.
    console.warn(`[Import] Rig inspection failed for ${glbPath}; treating as static:`, e);
    return { hasSkinned: false, clipNames: [], size: new THREE.Vector3(1, 1, 1), meshNodes: [], bones: [] };
  }
  gltf.scene.updateMatrixWorld(true);
  // Auto-fit measures the SKINNED meshes only (the animated character), not the
  // whole scene — rigged exports often bundle giant helper/ground planes (bake
  // setups) whose world scale would otherwise shrink the character to a speck.
  const skinnedBox = new THREE.Box3();
  let hasSkinned = false;
  const skeletons = new Set<THREE.Skeleton>();
  // Mesh-node structure (one SkinnedMeshRenderer per node at import). Group by node
  // the same way scene3DSync's buildNodes does: a named Group parent IS the node
  // (GLTFLoader wraps multi-primitive nodes), else the mesh's own name. Skinned
  // meshes only — non-skinned helper meshes (bake reference Plane) drop out here.
  // Per node: slot-name → Three material (slot key = `mat.name || mesh.name`, the
  // same grouping scene3DSync's buildNodes uses, so the importer can wire each slot
  // to a `.mat.json`). A Set-backed insertion-order map keeps the first material seen
  // for a slot — distinct submeshes sharing a slot name share its material anyway.
  const nodeSlotMats = new Map<string, Map<string, THREE.MeshStandardMaterial>>();
  gltf.scene.traverse((o: THREE.Object3D) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    hasSkinned = true;
    skinnedBox.expandByObject(o);
    if (sm.skeleton) skeletons.add(sm.skeleton);
    const p = sm.parent as (THREE.Object3D & { isGroup?: boolean }) | null;
    const node = (p && p.name && (p.isGroup || p.type === 'Group')) ? p.name : sm.name;
    let slots = nodeSlotMats.get(node);
    if (!slots) { slots = new Map(); nodeSlotMats.set(node, slots); }
    const mats = Array.isArray(sm.material) ? sm.material : [sm.material];
    for (const m of mats) {
      const s = (m?.name) || sm.name;
      if (s && m && !slots.has(s)) slots.set(s, m as THREE.MeshStandardMaterial);
    }
  });
  const meshNodes: RigMeshNodeInfo[] = [...nodeSlotMats].map(([node, slots]) => ({
    node, materials: [...slots.keys()], slotMaterials: slots,
  }));
  // C10: the import collapses everything into ONE SkinnedModel entity with a single
  // animator/clip. Flag multiple independent skeletons so the author knows clips
  // targeting a second rig won't be separately controllable.
  if (skeletons.size > 1) {
    console.warn(`[Import] ${glbPath} has ${skeletons.size} distinct skeletons — importing as one SkinnedModel entity with a single animator; clips targeting separate skeletons won't be independently controllable.`);
  }
  const clipNames = (gltf.animations ?? []).map((c: THREE.AnimationClip) => c.name);

  // Bone hierarchy (for opt-in skeleton expansion). The rig is at BIND pose here
  // (no mixer), so each bone's local TRS IS the bind-pose local a `Bone` entity
  // authors; `parent` is the parent BONE (null = a root bone, parented to the model
  // root entity at import).
  const bones = extractRigBones(skeletons, gltf.scene);

  const box = hasSkinned && !skinnedBox.isEmpty() ? skinnedBox : new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  // Hand the inspection parse to the next loader instead of disposing it (F4).
  // inspection only READ the scene (bbox / clip names / bone tree) — it's pristine,
  // byte-equivalent to what loadModelTemplates / fetchRiggedModel would re-fetch at
  // import time (both resolve to the same raw GLB). The consumer takes ownership and
  // runs its own keep/dispose lifecycle; the importer disposes it defensively after
  // (no-op once taken) so an un-consumed offer can't leak. Without this the GLB was
  // parsed twice per import (inspection + the real load).
  offerParsedGltf(glbPath, { scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] });
  return { hasSkinned, clipNames, size, meshNodes, bones };
}

/** Import a rigged GLB as a Unity-style hierarchy (keeps skeleton + clips): a
 *  SkinnedModel ROOT (owns clone/skeleton/mixer + SkeletalAnimator) plus one
 *  SkinnedMeshRenderer CHILD per mesh node (its materials + visibility). Parallel
 *  to the flatten path: no `.mesh.json` — the runtime loads the GLB WHOLE via
 *  riggedModelCache and animates it with an AnimationMixer. Per-mesh-node materials
 *  ARE extracted to deduped `.mat.json` (with their textures) and wired into each
 *  `SkinnedMeshRenderer.materials` slot map — the same convention as the static
 *  path's `Renderable3D.material`. Returns the ROOT entity id. */
async function importRiggedModel(
  glbPath: string,
  prefix: string,
  sourcePath: string | undefined,
  rig: { clipNames: string[]; size: THREE.Vector3; meshNodes: RigMeshNodeInfo[]; bones: RigBoneInfo[] },
  rootTransform?: { scale?: number },
): Promise<number> {
  // Resolve / preserve the GLB's guid (re-import keeps it so refs survive).
  const existingMeta = await readMeta(glbPath);
  const glbGuid = (typeof existingMeta.id === 'string' && isGuid(existingMeta.id)) ? existingMeta.id : newGuid();
  registerAsset(glbGuid, glbPath, 'model');

  // Skeleton expansion (P7b): persisted per-model in the meta's rig block, toggled
  // from the Model inspector. When on, the import emits the bone hierarchy as `Bone`
  // entities under the root (Unity's expanded-FBX skeleton). Default ON — a sane rig
  // is small; only an explicit `false` (the user unchecked it) disables it.
  const existingRig = (existingMeta.rig as { expandSkeleton?: boolean } | undefined) ?? undefined;
  const expandSkeleton = existingRig?.expandSkeleton !== false;

  // Extract per-slot materials to deduped `.mat.json` (same convention as the static
  // path's Renderable3D.material) and build each node's slot → `.mat.json` GUID map.
  // The runtime's syncNodeMaterials/loadSceneFile already consume `materials`; this is
  // the only missing piece. Textures are extracted from the GLB's baked materials and
  // referenced by GUID inside the `.mat.json`, exactly like the flatten path.
  const modelDir = glbPath.substring(0, glbPath.lastIndexOf('/'));
  const materialDir = `${modelDir}/materials`;
  const textureDir = `${modelDir}/textures`;
  // Collect every distinct slot material across all nodes for a single texture pass.
  const sharedGeo = new THREE.BufferGeometry(); // extractTextures ignores geometry
  const matTemplates = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>();
  for (const mn of rig.meshNodes) {
    for (const [slot, mat] of mn.slotMaterials ?? []) {
      matTemplates.set(`${mn.node}::${slot}`, { geometry: sharedGeo, material: mat, name: slot });
    }
  }
  const { texturePaths, textureFiles, textureSettings } = await extractTextures(matTemplates, textureDir);
  if (textureFiles.length > 0) console.log(`[Import] Extracted ${textureFiles.length} textures (rigged)`);
  await registerExtractedTextures(texturePaths, textureSettings);

  const matHashToRef = new Map<string, string>();
  const matHashToPath = new Map<string, string>();
  const matFiles: string[] = [];
  const matCtx: MatDedupCtx = { materialDir, textureDir, texturePaths, matHashToRef, matHashToPath, matFiles, protectedMatPaths: new Set() };
  // node → (slot-name → .mat.json GUID), keyed by `mat.name || mesh.name` to match
  // the render side (scene3DSync buildNodes). Deduped across nodes/slots via matCtx.
  const nodeMaterials = new Map<string, Record<string, string>>();
  for (const mn of rig.meshNodes) {
    const slotMap: Record<string, string> = {};
    for (const [slot, mat] of mn.slotMaterials ?? []) {
      slotMap[slot] = await dedupMaterialToFile(mat, matCtx);
    }
    nodeMaterials.set(mn.node, slotMap);
  }
  sharedGeo.dispose();
  console.log(`[Import] Extracted ${matFiles.length} skinned material(s) across ${rig.meshNodes.length} node(s)`);

  // Persist guid + source + clip list in the sidecar so re-import is stable and
  // the Inspector can list clips without parsing the GLB. Preserve expandSkeleton.
  // Record generated `.mat.json` + textures so a delete cleans them up and the
  // re-import orphan-prune (shared with the static path) can run.
  const prevGenerated = (existingMeta.generated as Record<string, unknown> | undefined) ?? {};
  await backendFetch('/api/write-meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: glbPath,
      meta: {
        ...existingMeta,
        version: (existingMeta.version as number) ?? 2,
        id: glbGuid,
        source: sourcePath,
        rig: { clips: rig.clipNames, expandSkeleton },
        generated: { ...prevGenerated, materials: matFiles, textures: textureFiles },
      },
    }),
  }).catch(() => {});

  // Auto-fit: scale the bind-pose bbox to ~2 units tall (FBX is often 100× / cm)
  // unless the caller passed an explicit scale.
  const maxDim = Math.max(rig.size.x, rig.size.y, rig.size.z);
  const scale = rootTransform?.scale ?? (maxDim > 0 ? 2 / maxDim : 1);

  const world = getCurrentWorld();
  const rootName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const root = world.spawn(
    Transform({ x: 0, y: 0, z: 0, sx: scale, sy: scale, sz: scale }),
    SkinnedModel({ model: glbGuid, isVisible: true }),
    SkeletalAnimator({ clip: rig.clipNames[0] ?? '', playing: true, speed: 1, loop: true, fadeDuration: 0 }),
    EntityAttributes({ name: rootName }),
  );
  registerEntity(root);

  // One SkinnedMeshRenderer child per mesh node (Unity's per-renderer materials),
  // pre-wired to the `.mat.json` GUIDs extracted above (slot-name → guid).
  for (const mn of rig.meshNodes) {
    const child = world.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 }),
      SkinnedMeshRenderer({ node: mn.node, materials: nodeMaterials.get(mn.node) ?? {}, visible: true }),
      EntityAttributes({ name: mn.node, parentId: root.id() }),
    );
    registerEntity(child);
  }
  console.log(`[Import] Imported rigged "${prefix}" — ${rig.meshNodes.length} mesh node(s): ${rig.meshNodes.map((n) => n.node).join(', ')}`);

  // Opt-in (P7b): expand the skeleton into `Bone` entities nested to mirror the
  // bone tree (a root bone parents to the model root; a child bone to its parent
  // bone). Each authors its BIND-pose LOCAL transform; the render bridge drives it
  // at play. Two passes — spawn all (so every parent id exists), then set parentId.
  if (expandSkeleton && rig.bones.length) {
    const boneEntityByName = new Map<string, number>();
    for (const b of rig.bones) {
      const e = world.spawn(
        Transform({ x: b.pos[0], y: b.pos[1], z: b.pos[2], rx: b.rot[0], ry: b.rot[1], rz: b.rot[2], sx: b.scale[0], sy: b.scale[1], sz: b.scale[2] }),
        Bone({ name: b.name }),
        EntityAttributes({ name: b.name }),
      );
      registerEntity(e);
      boneEntityByName.set(b.name, e.id());
    }
    const idToParent = new Map<number, number>();
    for (const b of rig.bones) {
      const id = boneEntityByName.get(b.name)!;
      // A root bone (parent null) — or one whose parent bone is somehow absent —
      // parents to the model root. `??` (not `||`) so a valid entity id of 0 sticks.
      const parentBoneId = b.parent != null ? boneEntityByName.get(b.parent) : undefined;
      idToParent.set(id, parentBoneId ?? root.id());
    }
    world.query(EntityAttributes).updateEach(([ea]: any, entity: any) => {
      const p = idToParent.get(entity.id());
      if (p !== undefined) ea.parentId = p;
    });
    console.log(`[Import] Expanded skeleton — ${rig.bones.length} bone entit${rig.bones.length === 1 ? 'y' : 'ies'}`);
  }

  // Warm the rigged cache so the editor preview renders immediately. This loads
  // the RAW committed GLB (the source of truth) — the optimized variant is a
  // derived cache artifact, exactly like a static model's `.processed.glb`.
  // fetchRiggedModel consumes the inspection parse offered above (F4) — its
  // executor runs synchronously, so the handoff is taken before this returns.
  ensureRiggedModelLoaded(glbGuid);
  // Defensive: dispose the offer if the cache short-circuited (already cached) and
  // never took it. No-op in the normal flow (consumed above).
  disposePendingGltf(glbPath);

  // Derive the optimized variant in the background via the generic reimport
  // dispatch (→ modelReimportHandler → convertRiggedModel): resize + KTX2 +
  // meshopt into the gitignored model cache, recording `modelCache` in the
  // meta. NEVER mutates the source GLB. Non-blocking so import stays responsive;
  // the editor preview keeps the raw GLB this session, and the dev middleware +
  // production build both serve the derived variant once it exists.
  void backendFetch('/api/reimport', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: glbPath }),
  })
    .then(async (res) => {
      const r = await res.json().catch(() => ({}));
      if (r.errors?.length) console.warn(`[Import] Rigged GLB derive warnings for ${glbPath}: ${r.errors.join('; ')}`);
      else console.log(`[Import] Derived optimized rigged variant for ${glbPath}`);
    })
    .catch((e) => console.warn(`[Import] Rigged GLB derive request failed: ${e}`));

  console.log(`[Import] Imported rigged "${prefix}" — ${rig.clipNames.length} clip(s), scale ${scale.toFixed(3)}`);
  return root.id();
}

export async function importModel(
  modelPath: string,
  prefix: string,
  postprocessorId: string = 'none',
  rootTransform?: { position?: [number, number, number]; rotation?: [number, number, number]; scale?: number },
  importOptions?: ImportOptions,
): Promise<number> {
  // Normalize non-GLB sources (OBJ/FBX/DAE) to a sibling GLB first; the rest of
  // the pipeline only ever speaks GLB. `.glb`/`.gltf` pass through unchanged.
  // The original source path is recorded in the GLB's meta below so a re-import
  // (and orphan cleanup) can trace back to it.
  const sourcePath = needsGLBConversion(modelPath) ? modelPath : undefined;
  const glbPath = await convertSourceToGLB(modelPath, postprocessorId);

  // Invalidate caches for this model (re-import gets fresh data). invalidateModel
  // fires onModelInvalidated synchronously → the render listener evicts in-scene
  // static meshes AND skinned clones; THEN invalidateRiggedModel disposes the
  // rigged prototype (now that its clones are gone) so the next render reloads
  // the freshly-derived variant — without this, a rigged re-import keeps showing
  // the stale cached prototype (e.g. a Plane that the postprocessor just removed).
  invalidateModel(glbPath);
  // invalidateRiggedModel is PATH-TOLERANT (riggedModelCache): the import pipeline
  // hands it the raw GLB path BEFORE the GUID is read from the meta, so it detects
  // an internal asset path and clears the cache keys directly instead of routing
  // through resolveRef (which would reject a path post GUID-only migration). A first
  // import has nothing cached → harmless no-op; a re-import drops the stale prototype.
  invalidateRiggedModel(glbPath);

  // Rigged (skeletal) models can't go through the flatten pipeline — it strips
  // the skeleton + clips. Route them to the SkinnedModel import instead.
  const rig = await inspectGLBRig(glbPath);
  if (rig.hasSkinned) {
    return importRiggedModel(glbPath, prefix, sourcePath, rig, rootTransform);
  }

  // Load mesh templates into shared cache. Editor-time import opts in to the
  // postprocessor hooks so the derived `.mesh.json` / `.mat.json` files
  // reflect the post-fixup state; the runtime never runs hooks (Stage A is
  // the only place fixups apply for production loads).
  await loadModelTemplates(glbPath, rootTransform, postprocessorId, true);
  // loadModelTemplates consumed the inspection parse (F4); dispose any offer it
  // didn't take (it short-circuited on an in-flight/cached entry). No-op normally.
  disposePendingGltf(glbPath);

  // Determine asset directories
  const modelDir = glbPath.substring(0, glbPath.lastIndexOf('/'));
  const meshDir = `${modelDir}/meshes`;
  const materialDir = `${modelDir}/materials`;
  const textureDir = `${modelDir}/textures`;

  // Resolve / register the GLB's guid BEFORE anything writes refs to it.
  // Re-import preserves the prior id (sidecar `.meta.json`) so external
  // scene/prefab refs survive — a fresh guid would dangle every consumer.
  const existingGlbMeta = await readMeta(glbPath);
  const glbGuid = (typeof existingGlbMeta.id === 'string' && isGuid(existingGlbMeta.id))
    ? existingGlbMeta.id
    : newGuid();
  registerAsset(glbGuid, glbPath, 'model');

  const templateMap = getTemplatesForModel(glbPath);
  console.log(`[Import] Found ${templateMap.size} templates for prefix "${prefix}"`);

  // Let the postprocessor resolve import options (excludes, material overrides) from templates
  const postprocessor = getModelPostprocessor(postprocessorId);
  const postprocessorOptions = postprocessor.resolveImportOptions?.(templateMap, materialDir) ?? {};

  // Merge: explicit importOptions take priority over postprocessor-resolved options
  const mergedExcludes = [...(postprocessorOptions.excludeMeshes ?? []), ...(importOptions?.excludeMeshes ?? [])];
  const mergedOverrides = { ...(postprocessorOptions.materialOverrides ?? {}), ...(importOptions?.materialOverrides ?? {}) };

  // Extract textures first (needed for material texture references)
  const { texturePaths, textureFiles, textureSettings } = await extractTextures(templateMap, textureDir);
  if (textureFiles.length > 0) {
    console.log(`[Import] Extracted ${textureFiles.length} textures`);
  }

  // Register each extracted texture so subsequent material writes can store a
  // guid ref instead of a raw path (seeds stub sidecars for fresh guids).
  await registerExtractedTextures(texturePaths, textureSettings);

  // Dedup meshes: track by meshName (same geometry in GLB = same mesh file)
  const meshFileMap = new Map<string, string>(); // meshName → meshFilePath
  const meshFiles: string[] = [];

  // Dedup materials: hash → material guid (or path fallback when the guid
  // can't be resolved). Stored as the ref-form that .mesh.json carries.
  const matHashToRef = new Map<string, string>();
  // Hash → material file path, used for the meta.generated cleanup list.
  const matHashToPath = new Map<string, string>();
  const matFiles: string[] = [];

  // Map template meshName → material ref (guid or path) for loadGLB entity spawning
  const meshToMatRef = new Map<string, string>();

  const excludeSet = new Set(mergedExcludes);
  const matOverrides = mergedOverrides;
  // Material paths used as overrides — don't overwrite these during dedup
  const protectedMatPaths = new Set(Object.values(matOverrides));
  const matCtx: MatDedupCtx = { materialDir, textureDir, texturePaths, matHashToRef, matHashToPath, matFiles, protectedMatPaths };

  for (const [meshName, template] of templateMap) {
    // Skip excluded meshes
    if (excludeSet.has(meshName)) continue;

    const safeMeshName = meshName.replace(/[/\\:*?"<>|]/g, '_');

    // Resolve the material ref (guid form preferred) for this mesh.
    let matRef: string;
    if (matOverrides[meshName]) {
      // Pre-existing manually-authored material file. Always resolves to a GUID
      // (registered), never a literal path.
      matRef = await resolveMaterialGuid(matOverrides[meshName]);
    } else {
      // Dedup material — write the .mat.json if this hash is new.
      matRef = await dedupMaterialToFile(template.material as THREE.MeshStandardMaterial, matCtx);
    }

    meshToMatRef.set(meshName, matRef);

    // Dedup mesh: same meshName = same geometry. Include material reference.
    if (!meshFileMap.has(meshName)) {
      const meshPath = `${meshDir}/${safeMeshName}.mesh.json`;
      // Preserve existing id so external refs (prefabs, scenes) don't dangle.
      const existingMeshId = await readExistingId(meshPath);
      const meshAsset: MeshAsset = {
        id: existingMeshId ?? newGuid(),
        version: 1,
        model: glbGuid,
        mesh: meshName,
        postprocessor: postprocessorId,
        material: matRef,
      };
      registerAsset(meshAsset.id!, meshPath, 'mesh');
      await writeAssetFile(meshPath, JSON.stringify(meshAsset, null, 2));
      meshFileMap.set(meshName, meshPath);
      meshFiles.push(meshPath);
    }
  }

  console.log(`[Import] Created ${meshFiles.length} meshes, ${matFiles.length} materials (deduped from ${templateMap.size})`);

  // Write model meta (sidecar for the binary GLB) with stable id + generated file list.
  // glbGuid was resolved/registered at the top of importModel.
  const meta = {
    ...existingGlbMeta,
    id: glbGuid,
    version: 2,
    postprocessor: postprocessorId,
    // Record the original source for converted models (OBJ/FBX/DAE → GLB) so the
    // GLB is traceable back to its authoring file. Omitted for native GLB imports.
    ...(sourcePath ? { source: sourcePath } : {}),
    generated: {
      meshes: meshFiles,
      materials: matFiles,
      textures: textureFiles,
    },
  };
  await backendFetch('/api/write-meta', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: glbPath, meta }),
  });

  // Prune orphans: files the previous import wrote into `generated.*` but
  // the current import didn't regenerate (source GLB changed shape, a mesh
  // was removed, a texture's content hash flipped, etc.). Without this, every
  // re-import leaves dead `.mesh.json` / `.mat.json` / texture files on disk
  // forever. `/api/delete-asset` moves them to OS Trash (recoverable), not
  // unlinks. Skip the prune when there's no previous generated block (first
  // import) or when nothing actually disappeared.
  const oldGen = (existingGlbMeta as { generated?: { meshes?: string[]; materials?: string[]; textures?: string[] } })
    .generated;
  if (oldGen) {
    const newMeshSet = new Set(meshFiles);
    const newMatSet = new Set(matFiles);
    const newTexSet = new Set(textureFiles);
    // Cross-asset safety: only prune files that live under THIS model's own
    // sub-tree (`modelDir/`). Anything outside is either a hand-authored asset
    // that happened to land in this model's prior `generated` list (bad data
    // from a long-gone import) or a shared file another model also writes —
    // either way, deleting it from this prune step would orphan refs in
    // unrelated scenes/prefabs. The model-import pipeline always writes under
    // `meshDir` / `materialDir` / `textureDir` (all rooted at `modelDir`), so
    // this prefix check is also a no-op for any normal import.
    const ownsPath = (p: string) => p.startsWith(modelDir + '/');
    const orphanMeshes = (oldGen.meshes ?? []).filter((p) => !newMeshSet.has(p) && ownsPath(p));
    const orphanMaterials = (oldGen.materials ?? []).filter((p) => !newMatSet.has(p) && ownsPath(p));
    const orphanTextures = (oldGen.textures ?? []).filter((p) => !newTexSet.has(p) && ownsPath(p));
    const trashOne = (p: string) => backendFetch('/api/delete-asset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    }).catch(() => {});
    await Promise.all([
      ...orphanMeshes.map(trashOne),
      ...orphanMaterials.map(trashOne),
      // Textures carry a sidecar `.meta.json` with their guid — drop both.
      ...orphanTextures.flatMap((p) => [trashOne(p), trashOne(`${p}.meta.json`)]),
    ]);
    const total = orphanMeshes.length + orphanMaterials.length + orphanTextures.length;
    if (total > 0) {
      console.log(`[Import] Pruned ${total} orphan files (${orphanMeshes.length} meshes, ${orphanMaterials.length} materials, ${orphanTextures.length} textures) → OS Trash`);
    }
  }

  // Spawn ECS entities from GLB. loadGLB sets Renderable3D mesh/material refs
  // in guid form (registered above), as required by the GUID-only invariant —
  // serialize only collects refs that are already guids/URLs.
  const entityMap = await loadGLB(glbPath, prefix, rootTransform, { meshDir, materialDir, materialMap: meshToMatRef, postprocessorId });

  // Create root group entity with ModelSource. Store the GUID (not the raw
  // path): every ref field is GUID-only, and the runtime resolves glbPath via
  // resolveRef (loadSceneFile) which rejects literal asset paths. Storing the
  // path here baked a literal into both entities[] and resources[] on save,
  // failing the GUID-only resolver on the next load.
  const world = getCurrentWorld();
  const rootEntity = world.spawn(
    Transform({ x: 0, y: 0, z: 0 }),
    EntityAttributes({ name: prefix.charAt(0).toUpperCase() + prefix.slice(1) }),
    ModelSource({ glbPath: glbGuid, postprocessor: postprocessorId, prefix }),
  );
  registerEntity(rootEntity);
  const rootId = rootEntity.id();

  // Parent all mesh entities under the root (parentId is in EntityAttributes).
  // Single updateEach pass that mutates inside the callback — that's the
  // koota-blessed path: it triggers change detection so the editor hierarchy
  // / UI projections see the new parentage. Mutating an `ea` reference
  // captured outside the callback persists (AoS) but skips change notification
  // and the children render as un-parented for a tick.
  const targetIds = new Set<number>(entityMap.keys());
  world.query(EntityAttributes).updateEach(([ea]: any, entity: any) => {
    if (targetIds.has(entity.id()) && ea.parentId === 0) {
      ea.parentId = rootId;
    }
  });

  console.log(`[Import] Imported "${prefix}" (${entityMap.size} meshes) with "${postprocessorId}" postprocessor`);
  return rootId;
}

/** Open file picker and import a GLB model. */
export async function importModelFromFile(postprocessorId: string = 'none'): Promise<number | null> {
  try {
    // GLB/GLTF only here: these are self-contained (or the picker can't resolve
    // their siblings). OBJ/FBX/DAE conversion runs through the Assets panel
    // "Import Model" flow, where sibling .mtl/textures resolve from the source
    // directory on disk.
    const [handle] = await (window as any).showOpenFilePicker({
      types: [{ description: 'GLB/GLTF Model', accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] } }],
    });
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    const prefix = handle.name.replace(/\.(glb|gltf)$/i, '').toLowerCase();
    const rootId = await importModel(url, prefix, postprocessorId);
    URL.revokeObjectURL(url);
    return rootId;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') console.error('[Import] Failed:', e);
    return null;
  }
}
