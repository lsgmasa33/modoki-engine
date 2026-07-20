/** Node-side adapter that translates a `@gltf-transform/core` Document into
 *  real `THREE.Mesh` instances so the existing `ModelPostprocessor.fixupMesh(mesh)`
 *  interface (browser-shape) runs unchanged inside the server-side converter.
 *
 *  Shape:
 *    loadGlbToThreeMeshes(absPath) → { doc, meshes: { threeMesh, primitive }[] }
 *      Each `threeMesh` carries a real THREE.BufferGeometry built from the
 *      primitive's accessors and a real THREE.MeshStandardMaterial built from
 *      the primitive's Material (factors + alpha mode + double-sided). The
 *      loader hook mutates these THREE objects exactly as it would in the
 *      browser.
 *    applyChangesToDocument(meshes, doc, excludedNames)
 *      Walks the mesh array, syncs material-factor changes + any newly added
 *      geometry attributes back into the gltf-transform primitives, and drops
 *      excluded mesh nodes from the document.
 *
 *  Limits (v1):
 *    - Material textures are NOT round-tripped — the loader only mutates
 *      material factors / flags / colors; texture references survive unchanged
 *      via the gltf-transform primitive itself.
 *    - Only TEXCOORD_0 add-back is supported (the only attribute the island
 *      loader synthesizes). Add more semantics if a future loader writes them.
 */

import * as THREE from 'three';
import { NodeIO, type Document, type Primitive, type Node as GLTFNode, type Material as GLTFMaterial } from '@gltf-transform/core';

export interface AdaptedMesh {
  threeMesh: THREE.Mesh;
  primitive: Primitive;
  /** The glTF Node that referenced the primitive. Multiple Nodes may share a
   *  Mesh+Primitive — we adapt one THREE.Mesh PER NODE so the loader's
   *  name-based dispatch sees the per-instance name (matches the runtime's
   *  GLTFLoader.traverse behavior). Exclusion drops this specific Node. */
  node: GLTFNode;
}

export interface LoadedGlb {
  doc: Document;
  meshes: AdaptedMesh[];
}

/** Mapping glTF semantics ↔ THREE BufferGeometry attribute names. */
const SEMANTIC_TO_THREE: Record<string, string> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  COLOR_0: 'color',
};
const THREE_TO_SEMANTIC: Record<string, string> = Object.fromEntries(
  Object.entries(SEMANTIC_TO_THREE).map(([k, v]) => [v, k]),
);

/** Match Three.js BufferAttribute.getX denormalize semantics so a normalized
 *  integer accessor (KHR_mesh_quantization position/normal, quantized texcoord)
 *  is read back in the same float range the runtime shader sees. Without this,
 *  `new Float32Array(uint16Array)` copies the raw 0..65535 codes verbatim — the
 *  THREE-side fixup math (e.g. the island grass UV bbox) then operates on junk,
 *  and the write-back below emits a FLOAT accessor still carrying integer-range
 *  values flagged `normalized` (no valid WebGPU vertex format → render crash). */
function denormalizerFor(array: ArrayLike<number>, normalized: boolean): (x: number) => number {
  if (!normalized) return (x) => x;
  if (array instanceof Int16Array) return (x) => Math.max(x / 32767, -1);
  if (array instanceof Uint16Array) return (x) => x / 65535;
  if (array instanceof Int8Array) return (x) => Math.max(x / 127, -1);
  if (array instanceof Uint8Array) return (x) => x / 255;
  return (x) => x;
}

function buildGeometry(prim: Primitive): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  for (const sem of prim.listSemantics()) {
    const acc = prim.getAttribute(sem);
    if (!acc) continue;
    const arr = acc.getArray();
    if (!arr) continue;
    const itemSize = acc.getElementSize();
    const threeName = SEMANTIC_TO_THREE[sem];
    if (!threeName) continue;
    // Denormalize quantized integer accessors into a plain (non-normalized)
    // Float32 attribute so fixup math sees real [0,1]/[-1,1] values and the
    // write-back never produces a FLOAT-but-normalized accessor.
    const denorm = denormalizerFor(arr, acc.getNormalized());
    const f32 = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) f32[i] = denorm(arr[i]);
    geom.setAttribute(threeName, new THREE.BufferAttribute(f32, itemSize));
  }
  const idx = prim.getIndices();
  if (idx) {
    const arr = idx.getArray();
    if (arr) geom.setIndex(new THREE.BufferAttribute(new Uint32Array(arr), 1));
  }
  return geom;
}

function buildMaterial(prim: Primitive): THREE.MeshStandardMaterial {
  const matNode = prim.getMaterial();
  const mat = new THREE.MeshStandardMaterial();
  if (!matNode) return mat;
  mat.name = matNode.getName();
  const base = matNode.getBaseColorFactor();
  mat.color.setRGB(base[0], base[1], base[2]);
  mat.opacity = base[3];
  mat.roughness = matNode.getRoughnessFactor();
  mat.metalness = matNode.getMetallicFactor();
  mat.alphaTest = matNode.getAlphaCutoff();
  const alphaMode = matNode.getAlphaMode();
  mat.transparent = alphaMode === 'BLEND';
  mat.side = matNode.getDoubleSided() ? THREE.DoubleSide : THREE.FrontSide;
  return mat;
}

/** Load a GLB into a gltf-transform Document plus a parallel array of
 *  adapter-built THREE meshes ready for `loader.fixupMesh` to mutate.
 *
 *  We iterate **Nodes** (not Meshes) and build one `THREE.Mesh` per
 *  Node→Primitive — this matches what `GLTFLoader.traverse` produces at
 *  runtime, where each instantiated mesh carries the parent Node's name
 *  (e.g., "Плоскость_с_травой") rather than the shared Mesh asset name
 *  (often "Mesh" or "Cube"). The runtime loader's name-based dispatch only
 *  works against the per-instance Node name, so we must match. */
export async function loadGlbToThreeMeshes(absPath: string): Promise<LoadedGlb> {
  const io = new NodeIO();
  const doc = await io.read(absPath);
  const meshes: AdaptedMesh[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const meshNode = node.getMesh();
    if (!meshNode) continue;
    const nodeName = node.getName();
    const prims = meshNode.listPrimitives();
    for (let i = 0; i < prims.length; i++) {
      const prim = prims[i];
      const geometry = buildGeometry(prim);
      const material = buildMaterial(prim);
      const threeMesh = new THREE.Mesh(geometry, material);
      // When a Node's Mesh has multiple primitives, suffix so the loader can
      // distinguish — single-primitive case keeps the bare Node name.
      threeMesh.name = prims.length === 1 ? nodeName : `${nodeName}_${i}`;
      meshes.push({ threeMesh, primitive: prim, node });
    }
  }
  return { doc, meshes };
}

/** Stable fingerprint of a fixed-up THREE material's write-back factors.
 *  Two meshes that share a glTF Material but produced different fingerprints
 *  need their own gltf-transform Material clones — otherwise the last
 *  `applyChangesToDocument` write wins (island case: Material.010 ground vs
 *  weed). */
function fingerprintMaterial(mat: THREE.MeshStandardMaterial): string {
  return JSON.stringify([
    mat.color.r, mat.color.g, mat.color.b, mat.opacity,
    mat.roughness, mat.metalness,
    mat.alphaTest,
    mat.transparent ? 'BLEND' : mat.alphaTest > 0 ? 'MASK' : 'OPAQUE',
    mat.side === THREE.DoubleSide ? 'double' : 'front',
  ]);
}

/** Write THREE-side mutations back into the gltf-transform Document and
 *  drop excluded mesh nodes from it. */
export function applyChangesToDocument(
  loaded: LoadedGlb,
  excludedNames: Set<string>,
): void {
  const { doc, meshes } = loaded;

  const isExcluded = ({ threeMesh, node }: AdaptedMesh) =>
    excludedNames.has(threeMesh.name) || excludedNames.has(node.getName());
  const activeMeshes = meshes.filter((m) => !isExcluded(m));

  // Phase 1 — detect shared gltf-transform Materials whose post-fixup state
  // diverges across the Nodes that reference them. The first observed
  // fingerprint reuses the original Material; each subsequent fingerprint
  // gets its own `Material.clone()` (preserves texture refs by reference).
  // matResolution: originalMaterial → fingerprint → resolvedMaterial.
  const matResolution = new Map<GLTFMaterial, Map<string, GLTFMaterial>>();
  const clonedMaterials = new Set<GLTFMaterial>();
  for (const adapted of activeMeshes) {
    const origMat = adapted.primitive.getMaterial();
    if (!origMat) continue;
    const fp = fingerprintMaterial(adapted.threeMesh.material as THREE.MeshStandardMaterial);
    let perFp = matResolution.get(origMat);
    if (!perFp) {
      perFp = new Map();
      matResolution.set(origMat, perFp);
    }
    if (perFp.has(fp)) continue;
    if (perFp.size === 0) {
      perFp.set(fp, origMat);
    } else {
      const clone = origMat.clone();
      clone.setName(`${origMat.getName() || 'Material'}_v${perFp.size}`);
      perFp.set(fp, clone);
      clonedMaterials.add(clone);
    }
  }

  // Phase 2 — retarget primitives whose resolved Material differs from the
  // original. If a single primitive is referenced by two Nodes with
  // divergent fixups (the same Mesh is shared between Nodes), full
  // resolution would also require cloning the Mesh and re-pointing one
  // Node — keep the first assignment and warn (rare; v1 scope).
  // Record each AdaptedMesh's INTENT for its primitive (whether keeping
  // the original or assigning a clone). If two adapted meshes share a
  // primitive but want different materials, the first wins and we warn —
  // a complete fix would also clone the Mesh and re-point the Node.
  const primitiveAssignment = new Map<Primitive, GLTFMaterial>();
  for (const adapted of activeMeshes) {
    const origMat = adapted.primitive.getMaterial();
    if (!origMat) continue;
    const fp = fingerprintMaterial(adapted.threeMesh.material as THREE.MeshStandardMaterial);
    const resolvedMat = matResolution.get(origMat)!.get(fp)!;
    const prev = primitiveAssignment.get(adapted.primitive);
    if (prev !== undefined && prev !== resolvedMat) {
      // eslint-disable-next-line no-console
      console.warn(
        `[model-convert] Shared primitive carries divergent post-fixup state for material ` +
        `'${origMat.getName()}' — v1 does not clone primitives; keeping first assignment. ` +
        `Affected node: '${adapted.node.getName()}'.`,
      );
      continue;
    }
    primitiveAssignment.set(adapted.primitive, resolvedMat);
    if (resolvedMat !== origMat) adapted.primitive.setMaterial(resolvedMat);
  }

  // Phase 3 — sync material + geometry mutations primitive-by-primitive.
  for (const adapted of activeMeshes) {
    const { threeMesh, primitive } = adapted;
    const matNode = primitive.getMaterial();
    const mat = threeMesh.material as THREE.MeshStandardMaterial;

    if (matNode) {
      // Only rewrite the material name onto the *original* material — clones
      // we created in Phase 1 must keep their `_v<N>` suffix so they remain
      // distinguishable in the staged GLB (helps LOD/validation tooling and
      // debugging). Loaders today don't rename materials, so this is a no-op
      // for the common path.
      if (mat.name && !clonedMaterials.has(matNode)) matNode.setName(mat.name);
      matNode.setBaseColorFactor([mat.color.r, mat.color.g, mat.color.b, mat.opacity]);
      matNode.setRoughnessFactor(mat.roughness);
      matNode.setMetallicFactor(mat.metalness);
      // Set alphaMode BEFORE alphaCutoff — some gltf-transform versions reset
      // cutoff when the mode changes, so the cutoff write has to come last.
      if (mat.transparent) matNode.setAlphaMode('BLEND');
      else if (mat.alphaTest > 0) matNode.setAlphaMode('MASK');
      else matNode.setAlphaMode('OPAQUE');
      matNode.setAlphaCutoff(mat.alphaTest);
      matNode.setDoubleSided(mat.side === THREE.DoubleSide);
    }

    // Synthesized attributes (the island grass UVs are the canonical case):
    // if the THREE geometry now has a UV but the primitive didn't, create
    // a new Accessor and attach it. Other semantics added by future loaders
    // can be wired here the same way. The accessor MUST be assigned to a
    // Buffer or NodeIO writes it as orphaned — the resulting GLB then loads
    // without the attribute (grass UVs come back as undefined and the texture
    // samples the same texel for every pixel).
    // Texcoords a postprocessor may REWRITE in place (vs. add). The planet UV
    // regen overwrites an existing TEXCOORD_0; without this the original
    // (broken) UVs survive the bake. Limited to texcoords on purpose —
    // overwriting POSITION/NORMAL would fight the LOD rebase + quantization.
    const OVERWRITABLE_SEMANTICS = new Set(['TEXCOORD_0', 'TEXCOORD_1']);
    const defaultBuffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
    for (const [threeName, sem] of Object.entries(THREE_TO_SEMANTIC)) {
      const attr = threeMesh.geometry.getAttribute(threeName);
      if (!attr) continue;
      const existing = primitive.getAttribute(sem);
      if (existing) {
        // Replace the existing accessor's data in place (keeps its buffer/type
        // wiring) so a postprocessor's UV edit lands in the staged GLB. The
        // source texcoord may have been a normalized Uint16 (KHR_mesh_quantization);
        // we're writing genuine Float32 values, so clear `normalized` — otherwise
        // the accessor becomes FLOAT-but-normalized, a combo with no valid WebGPU
        // vertex format that crashes the runtime render pipeline.
        if (OVERWRITABLE_SEMANTICS.has(sem)) {
          existing.setArray(new Float32Array(attr.array as ArrayLike<number>));
          existing.setNormalized(false);
        }
        continue;
      }
      const acc = doc.createAccessor()
        // Copy into a fresh ArrayBuffer-backed Float32Array — TS 5.7+ narrows
        // TypedArray generics and gltf-transform's `setArray` rejects the
        // `ArrayBufferLike` shape the THREE BufferAttribute carries.
        .setArray(new Float32Array(attr.array as ArrayLike<number>))
        .setType(attr.itemSize === 2 ? 'VEC2' : attr.itemSize === 3 ? 'VEC3' : 'VEC4')
        .setBuffer(defaultBuffer);
      primitive.setAttribute(sem, acc);
    }
  }

  // Drop excluded Nodes (per-instance, not per-Mesh). Each adapted mesh
  // carries its source Node, so the dispose matches what the loader saw.
  // `_<i>` primitive suffixes map back to the same parent Node.
  if (excludedNames.size > 0) {
    const seen = new Set<GLTFNode>();
    for (const adapted of meshes) {
      if (seen.has(adapted.node)) continue;
      if (isExcluded(adapted)) {
        adapted.node.dispose();
        seen.add(adapted.node);
      }
    }
  }
}

/** Write a Document to a GLB. Convenience pass-through over NodeIO. */
export async function writeDocument(doc: Document, absOutPath: string): Promise<void> {
  await new NodeIO().write(absOutPath, doc);
}
