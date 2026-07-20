/** Model conversion service (runs in Node — dev server + build).
 *
 *  Pipeline per source GLB:
 *    Stage A — bake fixups   →  produces processed.glb (LOD0).
 *    Stage B — simplification →  produces lod1.glb, lod2.glb, ... by ratio.
 *
 *  Stage A v1 status: passthrough — the converter does NOT yet run the
 *  postprocessor's fixupMesh / resolveImportOptions server-side; the runtime
 *  continues to apply them at scene load. Baking is a follow-up (needs a
 *  Node-side THREE adapter for the existing postprocessor interface). The
 *  plumbing here keeps the v2 step isolated to this function — everything
 *  else (cache, LOD generation, runtime resolver, inspector) lands now.
 *
 *  Stage B drives gltf-transform CLI ('simplify') by default; gltfpack is the
 *  opt-in single-pass alternative. Both invoked via execFile, with clear
 *  install hints when missing. Tri counts are read in-process via
 *  `@gltf-transform/core` (NodeIO) so we don't depend on CLI output parsing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  type ModelImportSettings,
  getLodEncoder, getLodMeshopt, getLodAggressive,
} from '../packages/modoki/src/runtime/loaders/modelSettings';
import {
  getModelCacheDir, hashKey, cacheDirFor, lodCachePath, cacheHit, pruneStaleCacheDirs,
} from './model-cache';
import {
  loadGlbToThreeMeshes, applyChangesToDocument, writeDocument,
} from './model-convert/threeAdapter';
import { gltfTransformInvocation, gltfpackInvocation, needsWinShell } from '../toolchain';

const GLTF_TRANSFORM_MISSING_MSG =
  '@gltf-transform/cli not found. Install it from the editor\'s Build Support dialog, or `npm i -D @gltf-transform/cli`.';
const GLTFPACK_MISSING_MSG =
  'gltfpack not found. Install it from the editor\'s Build Support dialog, or `brew install meshoptimizer` / `npm i -g gltfpack`.';

let gltfTransformCheck: { ok: boolean; version?: string } | null = null;
let gltfpackCheck: { ok: boolean; version?: string } | null = null;
let meshoptVersion: string | null = null;

/** For tests — forget cached CLI-availability probes. */
export function __resetModelCliChecks(): void {
  gltfTransformCheck = null;
  gltfpackCheck = null;
  meshoptVersion = null;
}

/** Captured version string for the CLIs we conditionally invoke. Empty when
 *  the CLI is not present (or has not been probed yet). Mixed into the model
 *  cache key so a tool upgrade silently invalidates prior cache entries. */
export function getToolVersions(): { gltfpack: string; gltfTransform: string; meshopt: string } {
  return {
    gltfpack: gltfpackCheck?.version ?? '',
    gltfTransform: gltfTransformCheck?.version ?? '',
    meshopt: meshoptVersion ?? '',
  };
}

async function loadMeshoptVersion(): Promise<string> {
  if (meshoptVersion !== null) return meshoptVersion;
  try {
    // meshoptimizer's npm package version isn't exposed by the module itself, and
    // its `exports` map blocks a `./package.json` subpath import — so resolve the
    // module's main entry, then read the sibling package.json off disk. This works
    // both in dev (node_modules) and in a packaged app (the module is bundled into
    // the asar; Electron's fs reads package.json transparently). Mixed into the
    // cache key so a `npm i meshoptimizer@next` invalidates prior cache entries.
    const { createRequire } = await import('node:module');
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const req = createRequire(import.meta.url);
    const mainEntry = req.resolve('meshoptimizer'); // .../meshoptimizer/index.js
    const pkgPath = path2.join(path2.dirname(mainEntry), 'package.json');
    const pkg = JSON.parse(fs2.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    meshoptVersion = pkg.version ?? '';
  } catch {
    meshoptVersion = '';
  }
  return meshoptVersion;
}

/** Ensure `npx @gltf-transform/cli` is callable. Throws with install hint otherwise. */
export function ensureGltfTransformCli(): void {
  if (gltfTransformCheck) {
    if (!gltfTransformCheck.ok) throw new Error(GLTF_TRANSFORM_MISSING_MSG);
    return;
  }
  try {
    const inv = gltfTransformInvocation();
    const out = execFileSync(inv.command, [...inv.prefixArgs, '--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: needsWinShell(inv.command) });
    gltfTransformCheck = { ok: true, version: out.toString().trim() };
  } catch {
    gltfTransformCheck = { ok: false };
    throw new Error(GLTF_TRANSFORM_MISSING_MSG);
  }
}

/** Ensure `gltfpack` is on PATH. Throws with install hint otherwise.
 *  Probes with `-v` (prints version) because `-h` exits non-zero — gltfpack's
 *  help is meant to be read after the user typo'd a flag. */
export function ensureGltfpackCli(): void {
  if (gltfpackCheck) {
    if (!gltfpackCheck.ok) throw new Error(GLTFPACK_MISSING_MSG);
    return;
  }
  const inv = gltfpackInvocation();
  try {
    // gltfpack -v prints version (npm build → stdout exit 0; some native builds → stderr). Capture both.
    const out = execFileSync(inv.command, [...inv.prefixArgs, '-v'], { stdio: ['ignore', 'pipe', 'pipe'], shell: needsWinShell(inv.command) });
    gltfpackCheck = { ok: true, version: out.toString().trim() };
  } catch (e) {
    // Some gltfpack builds print version then exit non-zero. Try to recover
    // it from stderr/stdout before declaring missing.
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    const stdout = (e as { stdout?: Buffer }).stdout?.toString().trim() ?? '';
    const version = stderr || stdout;
    if (version) {
      gltfpackCheck = { ok: true, version };
      return;
    }
    gltfpackCheck = { ok: false };
    throw new Error(GLTFPACK_MISSING_MSG);
  }
}

/** Build the gltf-transform `simplify` argument vector. Pure — unit tested.
 *  `--lock-border` is the conservative-vs-aggressive knob: `1` (default) keeps
 *  topological borders intact (preserves UV/material seams, may stall around
 *  50% reduction on Blender hard-edge exports); `0` drops the guarantee and
 *  hits the ratio at the cost of visible seams. Mirrors gltfpack's
 *  `-slb` / `-sa` pair. */
export function buildGltfTransformSimplifyArgs(
  inPath: string,
  outPath: string,
  ratio: number,
  error: number,
  lockBorder: boolean,
): string[] {
  return [
    'simplify',
    inPath, outPath,
    '--ratio', String(ratio),
    '--error', String(error),
    '--lock-border', lockBorder ? '1' : '0',
  ];
}

/** Build the gltf-transform `meshopt` post-pass argument vector. Compresses
 *  geometry + morph targets + animation tracks with EXT_meshopt_compression,
 *  the same compression gltfpack `-cc` produces. Pure — unit tested. */
export function buildGltfTransformMeshoptArgs(inPath: string, outPath: string): string[] {
  return [
    'meshopt',
    inPath, outPath,
  ];
}

/** Build the gltfpack argument vector for a single LOD pass. Pure — unit tested.
 *  `-si <ratio>` drives simplification; `-slb` preserves UV/material borders
 *  (default = safe); `-sa` ignores quality to hit the target ratio (use when
 *  the mesh has heavy attribute splits and conservative mode stalls at ~50%
 *  reduction); `-cc` enables meshopt compression on the output; `-kn`
 *  preserves named source nodes so the parent-chain transforms (e.g. a
 *  containing `SpaceShip.fbx` scale=0.01) stay split from the leaf mesh's
 *  dequantization scale. Without `-kn`, gltfpack flattens the entire chain
 *  into one Mesh-node matrix and our runtime bake puts geometry in WORLD
 *  space — which then renders 1/N× too small because the existing ECS
 *  entity Transform (captured pre-flattening) ALSO applies that scale. */
export function buildGltfpackArgs(
  inPath: string,
  outPath: string,
  ratio: number,
  meshopt: boolean,
  aggressive: boolean,
): string[] {
  // -kv keeps source vertex attributes even when no material samples them.
  // We strip embedded textures up-pipeline so materials have no texture refs
  // anymore; without -kv, gltfpack treats TEXCOORD_0 / TANGENT as unused and
  // drops them from the output, then the WebGPU shader warns
  // `AttributeNode: Vertex attribute "uv" not found on geometry` once a
  // sidecar material binds a baseColorMap.
  // -km disables named-material merging — without it gltfpack collapses
  // primitives sharing a material across nodes into a single Mesh node, which
  // erases the per-mesh names the runtime's lookupTemplate() keys on. On the
  // island (multi-mesh source: palms, terrain, hut, ...) the collapse made
  // every .mesh.json miss its template and the whole model rendered nothing.
  //
  // -vtf keeps texcoords as Float32. Default gltfpack quantizes UVs to Uint16
  // and remaps them to each primitive's UV bounding box, storing the dequant
  // offset+scale as a KHR_texture_transform on the material's baseColor
  // texture binding. We strip embedded textures pre-gltfpack (geometry-only
  // input → drops image bytes), which removes the binding gltfpack would have
  // hung the dequant on. Without -vtf the dequant gets silently dropped: at
  // runtime the .mat.json rebinds the texture and THREE reads uv/65535 ≈
  // [0,1] (full atlas), but the LOD's UVs were rescaled to fill that range
  // from a small window — palm leaves end up sampling palm.png's transparent
  // border and alphaTest=0.4 discards every pixel.
  const args = ['-i', inPath, '-o', outPath, '-si', String(ratio), '-kn', '-km', '-kv', '-vtf'];
  // -sa replaces -slb's preservation guarantees with "hit the ratio at all
  // costs"; mutually exclusive — pass one or the other, not both.
  args.push(aggressive ? '-sa' : '-slb');
  if (meshopt) args.push('-cc');
  return args;
}

/** Minimal shape the converter consumes from a `ModelPostprocessor`. Mirrors
 *  the runtime interface; kept loose so the converter doesn't bind to the
 *  engine package's full export surface. */
export interface FixupPostprocessor {
  recipeVersion?: number;
  fixupMesh: (mesh: import('three').Mesh) => void;
  filterMesh?: (mesh: import('three').Mesh) => boolean;
  resolveImportOptions?: (
    templates: Map<string, { geometry: import('three').BufferGeometry; material: import('three').Material; name: string }>,
    materialDir: string,
  ) => { excludeMeshes?: string[]; materialOverrides?: Record<string, string> };
}

export interface ConvertModelOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/3d-test/assets/models/tropical-island/island.glb */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source GLB. */
  absSource: string;
  settings: ModelImportSettings;
  /** Postprocessor id from the model meta. Mixed into the cache hash. */
  postprocessorId: string;
  /** Postprocessor recipe version. Mixed into the cache hash so fixup recipe
   *  changes invalidate. Passed in by the caller because the converter doesn't
   *  import the postprocessor registry directly (Node side has no THREE). */
  recipeVersion: number;
  /** Resolver for the actual postprocessor implementation. Returns null when
   *  the caller has no postprocessor to run (test harness, missing source
   *  file) — Stage A then becomes a passthrough copy. The dev server wires
   *  this to its SSR module loader; the build path wires it to the same
   *  registry preloaded at configResolved. */
  resolvePostprocessor?: (postprocessorId: string) => Promise<FixupPostprocessor | null>;
}

export interface ConvertModelResult {
  hash: string;
  /** Whether all outputs were already on disk (no work done). */
  cached: boolean;
  /** Absolute path of the LOD0 (processed) GLB in cache. */
  processedPath: string;
  /** Absolute paths of all LOD GLBs in distance order. lodPaths[0] === processedPath. */
  lodPaths: string[];
  /** Mirrored from settings.lodDistances — convenient for the caller. */
  lodDistances: number[];
  /** Triangle count per LOD (parallel to lodPaths). */
  triCounts: number[];
  /** On-disk byte size per LOD (parallel to lodPaths). */
  lodBytes: number[];
}

/** Build a NodeIO with the extensions + meshopt codec registered. Needed for
 *  reading any LOD GLB after gltfpack -cc (KHR_mesh_quantization +
 *  EXT_meshopt_compression) and for writing back stripped variants. */
async function makeNodeIO() {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
}

/** Rebase a LOD GLB's geometry so every mesh's `matrixWorld` matches the
 *  source's, putting the geometry in the same local space as the source.
 *
 *  Background: gltfpack (-cc) flattens the source's ancestor node chain into
 *  one mesh-node matrix AND adds a per-mesh dequantization scale/translate.
 *  Both end up multiplied together on the LOD mesh's node, while the source's
 *  ancestors are intact in the source GLB. The editor saves the entity
 *  Transform from the source's `mesh.matrixWorld` decompose; if the runtime
 *  then loads a LOD where `mesh.matrixWorld` differs, render =
 *  `entity.Transform × LOD_geom` no longer matches `entity.Transform ×
 *  source_geom`, because LOD_geom lives in a different space.
 *
 *  Strategy (works for single- AND multi-mesh; encoders that preserve the
 *  source's matrixWorld per node hit the matricesApproxEqual skip path and
 *  return untouched):
 *
 *    1. Build name → sourceWorld map by walking the source scene, keying on
 *       each named node that bears a mesh. The runtime's mesh-template
 *       resolver matches LOD nodes back to source by the same name (with the
 *       walk-up-to-named-ancestor fallback in deriveTemplateName), so
 *       pairing by name here aligns with how the runtime will key them.
 *    2. Group the LOD's mesh-bearing leaves by the gltf-transform Mesh they
 *       reference. Multiple leaves can share one Mesh (instancing); we
 *       transform vertex data once per Mesh using a representative leaf.
 *    3. For each leaf, overwrite its local matrix so the leaf's `matrixWorld`
 *       equals its source counterpart's. After that the runtime's
 *       Transform-extraction from `mesh.matrixWorld` lands on the same pose
 *       as the source. */
export async function rebaseLodGeometry(absSource: string, absLod: string): Promise<void> {
  const THREE = await import('three');
  const io = await makeNodeIO();
  const sourceDoc = await io.read(absSource);
  const lodDoc = await io.read(absLod);

  // Pairing key: name of the named node (or named ancestor) bearing each mesh.
  // Mirrors the runtime's deriveTemplateName lookup.
  const sourceByName = collectNamedMeshNodes(sourceDoc, THREE);
  const lodLeaves = collectLodMeshLeaves(lodDoc, THREE);
  if (lodLeaves.length === 0 || sourceByName.size === 0) return;

  // Quick skip: if every LOD leaf already matches its source counterpart's
  // worldMatrix, the encoder preserved the hierarchy (gltf-transform meshopt
  // / simplify) and there's nothing to rebase.
  const allMatch = lodLeaves.every((leaf) => {
    const src = sourceByName.get(leaf.name);
    return src && matricesApproxEqual(src.world, leaf.world, 1e-6);
  });
  if (allMatch) return;

  // Group leaves by gltf-transform Mesh — multiple leaves often share a
  // single Mesh (gltfpack reuses meshes across instances). The vertex
  // transform must run exactly once per Mesh.
  const byMesh = new Map<import('@gltf-transform/core').Mesh, LodLeaf[]>();
  for (const leaf of lodLeaves) {
    const arr = byMesh.get(leaf.mesh);
    if (arr) arr.push(leaf); else byMesh.set(leaf.mesh, [leaf]);
  }

  // Un-share attribute accessors before the in-place vertex transform below.
  // gltf-transform's dedup (run inside weld/meshopt) collapses byte-identical
  // geometry into ONE Accessor referenced by several Meshes. Each of those
  // Meshes rebases into a DIFFERENT source-local space, but replaceAttributeAccessor
  // mutates the accessor in place — so transforming the shared accessor once per
  // Mesh double-applies (mesh B's rebase lands on top of mesh A's), corrupting
  // both (they render 7-21x too large in the wrong place). Give every Mesh we're
  // about to transform private copies of its POSITION/NORMAL/TANGENT accessors so
  // each mutation is isolated. (True instancing — one Mesh under several nodes —
  // is unaffected: byMesh already transforms that single Mesh exactly once.)
  const claimedAccessors = new Set<import('@gltf-transform/core').Accessor>();
  const REBASED_ATTRS = ['POSITION', 'NORMAL', 'TANGENT'] as const;
  for (const [mesh, leaves] of byMesh) {
    if (!leaves.some((l) => sourceByName.has(l.name))) continue; // not transformed below
    for (const prim of mesh.listPrimitives()) {
      for (const attr of REBASED_ATTRS) {
        const acc = prim.getAttribute(attr);
        if (!acc) continue;
        if (claimedAccessors.has(acc)) prim.setAttribute(attr, acc.clone());
        else claimedAccessors.add(acc);
      }
    }
  }

  // Step 1: rebase vertex data once per mesh, using a representative leaf
  // (pick the first one whose name pairs with a source node).
  for (const [mesh, leaves] of byMesh) {
    const rep = leaves.find((l) => sourceByName.has(l.name));
    if (!rep) continue; // no source counterpart — leave geometry alone
    const srcWorld = sourceByName.get(rep.name)!.world;
    const rebase = new THREE.Matrix4().copy(srcWorld).invert().multiply(rep.world);
    if (matricesApproxEqual(rebase, new THREE.Matrix4(), 1e-6)) continue;
    transformPrimitivePositions(mesh, rebase, THREE);
    transformPrimitiveDirection(mesh, 'NORMAL', rebase, THREE);
    transformPrimitiveDirection(mesh, 'TANGENT', rebase, THREE);
  }

  // Step 2: park each leaf's worldMatrix on its source counterpart. After
  // this, leaf.matrixWorld × rebasedGeom = sourceWorld × geomInSourceLocal,
  // which is what the runtime expects.
  for (const leaf of lodLeaves) {
    const src = sourceByName.get(leaf.name);
    if (!src) continue;
    const local = new THREE.Matrix4().copy(leaf.parentWorld).invert().multiply(src.world);
    // Matrix4.toArray() always yields 16 elements; setMatrix wants a mat4 tuple.
    leaf.node.setMatrix(local.toArray() as Parameters<typeof leaf.node.setMatrix>[0]);
  }

  await io.write(absLod, lodDoc);
}

interface LodLeaf {
  /** The named ancestor's name (or own name if the leaf itself is named) —
   *  matches the source map's key. */
  name: string;
  node: import('@gltf-transform/core').Node;
  mesh: import('@gltf-transform/core').Mesh;
  world: import('three').Matrix4;
  parentWorld: import('three').Matrix4;
}

/** Walk the default scene; for every node with a mesh whose path back to the
 *  scene root contains at least one named node, record name → (mesh, world).
 *  The name picked is the closest named ancestor (the node itself if it's
 *  named), matching the runtime's deriveTemplateName lookup. */
function collectNamedMeshNodes(
  doc: import('@gltf-transform/core').Document,
  THREE: typeof import('three'),
): Map<string, { mesh: import('@gltf-transform/core').Mesh; world: import('three').Matrix4 }> {
  const out = new Map<string, { mesh: import('@gltf-transform/core').Mesh; world: import('three').Matrix4 }>();
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return out;
  // De-collide duplicate names so multi-mesh artist groups don't make every
  // leaf overwrite the same key (and end up pairing every LOD leaf against
  // the LAST source world matrix). Matches the runtime's de-collision in
  // loadModelTemplates (`<name>__<idx>` when the bare name is already used).
  let leafIdx = 0;
  const walk = (
    node: import('@gltf-transform/core').Node,
    parentWorld: import('three').Matrix4,
    nearestName: string,
  ) => {
    const local = new THREE.Matrix4().fromArray(node.getMatrix());
    const world = new THREE.Matrix4().multiplyMatrices(parentWorld, local);
    const nodeName = node.getName();
    const name = nodeName || nearestName;
    const mesh = node.getMesh();
    if (mesh && name) {
      const key = out.has(name) ? `${name}__${leafIdx}` : name;
      out.set(key, { mesh, world });
      leafIdx++;
    }
    for (const child of node.listChildren()) walk(child, world, name);
  };
  for (const child of scene.listChildren()) walk(child, new THREE.Matrix4(), '');
  return out;
}

/** Walk the default scene; for every node that bears a mesh, return a
 *  LodLeaf describing it. `name` is the leaf's nearest named ancestor (the
 *  pairing key with the source map). */
function collectLodMeshLeaves(
  doc: import('@gltf-transform/core').Document,
  THREE: typeof import('three'),
): LodLeaf[] {
  const out: LodLeaf[] = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return out;
  const seenNames = new Set<string>(); // mirror collectNamedMeshNodes de-collision
  let leafIdx = 0;
  const walk = (
    node: import('@gltf-transform/core').Node,
    parentWorld: import('three').Matrix4,
    nearestName: string,
  ) => {
    const local = new THREE.Matrix4().fromArray(node.getMatrix());
    const world = new THREE.Matrix4().multiplyMatrices(parentWorld, local);
    const nodeName = node.getName();
    const name = nodeName || nearestName;
    const mesh = node.getMesh();
    if (mesh) {
      const key = seenNames.has(name) ? `${name}__${leafIdx}` : name;
      seenNames.add(key);
      out.push({ name: key, node, mesh, world, parentWorld: parentWorld.clone() });
      leafIdx++;
    }
    for (const child of node.listChildren()) walk(child, world, name);
  };
  for (const child of scene.listChildren()) walk(child, new THREE.Matrix4(), '');
  return out;
}

function matricesApproxEqual(a: import('three').Matrix4, b: import('three').Matrix4, tol: number): boolean {
  const ae = a.elements, be = b.elements;
  for (let i = 0; i < 16; i++) {
    if (Math.abs(ae[i] - be[i]) > tol) return false;
  }
  return true;
}

/** Apply a Matrix4 to every vertex of every primitive in `mesh` and write
 *  the result as a fresh Float32 accessor. Mutates the primitive in place. */
function transformPrimitivePositions(mesh: import('@gltf-transform/core').Mesh, m: import('three').Matrix4, THREE: typeof import('three')): void {
  for (const prim of mesh.listPrimitives()) {
    const acc = prim.getAttribute('POSITION');
    if (!acc) continue;
    const out = transformVec3Attribute(acc, (v) => v.applyMatrix4(m), THREE);
    replaceAttributeAccessor(prim, 'POSITION', out);
  }
}

/** Apply the normal matrix of `m` to every entry of `attrName` (NORMAL or
 *  TANGENT). For TANGENT (vec4) the handedness in `w` is preserved. */
function transformPrimitiveDirection(mesh: import('@gltf-transform/core').Mesh, attrName: 'NORMAL' | 'TANGENT', m: import('three').Matrix4, THREE: typeof import('three')): void {
  const normalMat = new THREE.Matrix3().getNormalMatrix(m);
  for (const prim of mesh.listPrimitives()) {
    const acc = prim.getAttribute(attrName);
    if (!acc) continue;
    const out = transformVec3Attribute(acc, (v) => { v.applyMatrix3(normalMat).normalize(); }, THREE);
    replaceAttributeAccessor(prim, attrName, out);
  }
}

/** Read each vec3 (with normalization handled), transform with `apply`, and
 *  return a fresh Float32 accessor of matching size. Handles vec4 tangent
 *  (extra `w` for handedness). */
function transformVec3Attribute(acc: import('@gltf-transform/core').Accessor, apply: (v: import('three').Vector3) => void, THREE: typeof import('three')): { array: Float32Array; itemSize: number } {
  const itemSize = acc.getElementSize(); // 3 for POSITION/NORMAL, 4 for TANGENT
  const count = acc.getCount();
  const src = acc.getArray()!;
  const isNormalized = acc.getNormalized();
  const denorm = denormalizerFor(src, isNormalized);
  const out = new Float32Array(count * itemSize);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const o = i * itemSize;
    v.set(denorm(src[o]), denorm(src[o + 1]), denorm(src[o + 2]));
    apply(v);
    out[o]     = v.x;
    out[o + 1] = v.y;
    out[o + 2] = v.z;
    if (itemSize === 4) out[o + 3] = src[o + 3]; // tangent w (handedness)
  }
  return { array: out, itemSize };
}

/** Match Three.js BufferAttribute.getX denormalize semantics so we read
 *  values in the same range the shader/runtime would see. */
function denormalizerFor(array: ArrayLike<number>, normalized: boolean): (x: number) => number {
  if (!normalized) return (x) => x;
  if (array instanceof Int16Array) return (x) => Math.max(x / 32767, -1);
  if (array instanceof Uint16Array) return (x) => x / 65535;
  if (array instanceof Int8Array)  return (x) => Math.max(x / 127, -1);
  if (array instanceof Uint8Array) return (x) => x / 255;
  return (x) => x;
}

function replaceAttributeAccessor(prim: import('@gltf-transform/core').Primitive, attrName: string, out: { array: Float32Array; itemSize: number }): void {
  // Mutate the existing accessor in place. gltf-transform infers
  // componentType from the array's typed-array constructor, so writing a
  // Float32Array flips the accessor to GL_FLOAT (5126). normalized is
  // forced false since we just baked the dequant into the values. The
  // min/max bounds in the GLB spec are derived on serialize, so we don't
  // hand-update them here.
  const acc = prim.getAttribute(attrName)!;
  // out.array is a freshly-allocated Float32Array (non-shared ArrayBuffer); the
  // cast satisfies setArray's stricter Float32Array<ArrayBuffer> param type.
  acc.setArray(out.array as Float32Array<ArrayBuffer>);
  acc.setType((out.itemSize === 4 ? 'VEC4' : 'VEC3') as 'VEC3' | 'VEC4');
  acc.setNormalized(false);
}

/** Count triangles across all primitives in a GLB. */
async function countTriangles(glbPath: string): Promise<number> {
  const io = await makeNodeIO();
  const doc = await io.read(glbPath);
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      if (indices) total += indices.getCount() / 3;
      else {
        const pos = prim.getAttribute('POSITION');
        if (pos) total += pos.getCount() / 3;
      }
    }
  }
  return Math.round(total);
}

/** Strip every embedded image + texture from a GLB. The engine rebuilds
 *  materials from sidecar `.mat.json` files (which reference textures via the
 *  asset manifest), so the LOD GLBs only need geometry + node hierarchy at
 *  runtime — without this, a 219-tri LOD of a textured asset still drags
 *  along the source's ~26 MB of embedded JPEGs because the simplifier just
 *  carries images through. Run in-place after the encoder writes its output.
 *
 *  Note: when the input is meshopt-compressed (gltfpack -cc), re-writing
 *  decodes back to plain accessors — we don't re-apply EXT_meshopt_compression
 *  here. That's fine because the geometry is already tiny by this point and
 *  the texture savings dwarf any meshopt re-encode benefit. */
async function stripEmbeddedTextures(glbPath: string): Promise<void> {
  const io = await makeNodeIO();
  const { prune } = await import('@gltf-transform/functions');
  const doc = await io.read(glbPath);
  const textures = doc.getRoot().listTextures();
  if (textures.length === 0) return;
  for (const tex of textures) tex.dispose();
  // keepAttributes — without this, prune drops TEXCOORD_0/TANGENT/etc because
  // no material samples them anymore (we just disposed every texture), and
  // the runtime then warns `THREE.AttributeNode: Vertex attribute "uv" not
  // found on geometry` when it applies a sidecar material that DOES want a
  // texture. keepLeaves — protects the parent-chain transform nodes we asked
  // gltfpack to preserve with `-kn`.
  await doc.transform(prune({ keepAttributes: true, keepLeaves: true }));
  await io.write(glbPath, doc);
}

/** Convert one source GLB into its LOD set. Cache-aware — a hit short-circuits
 *  the encoder calls and just gathers stats from disk. */
export async function convertModel(opts: ConvertModelOptions): Promise<ConvertModelResult> {
  const { projectRoot, sourceUrlPath, absSource, settings, postprocessorId, recipeVersion } = opts;
  const srcBytes = fs.readFileSync(absSource);

  // Determine which CLIs we'll need so we can probe (and capture) their
  // versions BEFORE hashing — otherwise a tool upgrade silently re-uses stale
  // cache entries. Probes are idempotent (cached per-process), so doing this
  // ahead of the cacheHit check costs nothing on subsequent calls.
  const lodCount = settings.lodCount;
  const lodEncoders = Array.from({ length: lodCount }, (_, i) => getLodEncoder(settings, i));
  const needsGltfTransform = lodEncoders.some((e) => e === 'gltf-transform');
  const needsGltfpack = lodEncoders.some((e) => e === 'gltfpack');
  if (needsGltfTransform) ensureGltfTransformCli();
  if (needsGltfpack) ensureGltfpackCli();
  // meshopt is the npm package version (encoders use it through @gltf-transform
  // / gltfpack but the encoder logic also lives partly in the npm package).
  await loadMeshoptVersion();
  const toolVersions = getToolVersions();

  const hash = hashKey(srcBytes, settings, postprocessorId, recipeVersion, toolVersions);
  const cacheDir = getModelCacheDir(projectRoot);

  const lodPaths: string[] = [];
  for (let i = 0; i < lodCount; i++) {
    lodPaths.push(lodCachePath(cacheDir, sourceUrlPath, hash, i));
  }
  const processedPath = lodPaths[0];

  const gatherStats = async (): Promise<Pick<ConvertModelResult, 'triCounts' | 'lodBytes'>> => {
    const triCounts: number[] = [];
    const lodBytes: number[] = [];
    for (const p of lodPaths) {
      if (fs.existsSync(p)) {
        lodBytes.push(fs.statSync(p).size);
        triCounts.push(await countTriangles(p));
      } else {
        lodBytes.push(0);
        triCounts.push(0);
      }
    }
    return { triCounts, lodBytes };
  };

  if (cacheHit(cacheDir, sourceUrlPath, hash, lodCount)) {
    const stats = await gatherStats();
    return {
      hash, cached: true, processedPath, lodPaths,
      lodDistances: settings.lodDistances.slice(0, lodCount),
      ...stats,
    };
  }

  // Atomic-cache pattern: write to a sibling staging dir, then renameSync the
  // whole dir into place once every LOD has been encoded and rebased. Two
  // concurrent `/api/reimport` requests for the same asset would otherwise
  // race on the same `<hash>/` directory and produce torn LOD GLBs. Each
  // builder picks its own staging dir (pid+rand suffix), so they collide only
  // at the final rename — last writer wins atomically, no torn output.
  const finalDir = cacheDirFor(cacheDir, sourceUrlPath, hash);
  const parentDir = path.dirname(finalDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const stagingDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(stagingDir, { recursive: true });
  // Map cache-relative paths (`processed.glb`, `lod1.glb`, …) into the
  // staging dir; encoders + rebase write there. After the final rename we
  // return `lodPaths` (which already point at finalDir) to the caller.
  const stagingLodPaths = lodPaths.map((p) => path.join(stagingDir, path.basename(p)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mdl-'));
  let renamed = false;
  try {
    // Stage A — bake fixups into a staged GLB. The postprocessor's filterMesh
    // / resolveImportOptions decides what to drop; fixupMesh mutates material
    // factors + geometry attributes via the THREE adapter; the resulting
    // Document is written out as the staged source for the LOD simplifier.
    // When no postprocessor is resolvable (no resolvePostprocessor supplied,
    // or the postprocessor is the no-op 'none'), Stage A is a verbatim copy.
    const stagedSource = path.join(tmpDir, 'staged.glb');
    const postprocessor = opts.resolvePostprocessor ? await opts.resolvePostprocessor(postprocessorId) : null;
    if (postprocessor && (postprocessor.fixupMesh || postprocessor.filterMesh || postprocessor.resolveImportOptions)) {
      const loaded = await loadGlbToThreeMeshes(absSource);
      const excluded = new Set<string>();

      if (postprocessor.resolveImportOptions) {
        const templates = new Map<string, { geometry: import('three').BufferGeometry; material: import('three').Material; name: string }>();
        for (const { threeMesh } of loaded.meshes) {
          templates.set(threeMesh.name, { geometry: threeMesh.geometry, material: threeMesh.material as import('three').Material, name: threeMesh.name });
        }
        // materialDir is meaningful to modelImport (spawn time); the converter
        // doesn't apply material overrides — those live on the spawn path. We
        // pass a stable string so postprocessors that ignore it (most) work,
        // and the ones that build paths get something deterministic for inspection.
        const opts2 = postprocessor.resolveImportOptions(templates, '/.synthetic/materials') ?? {};
        for (const n of opts2.excludeMeshes ?? []) excluded.add(n);
      }
      if (postprocessor.filterMesh) {
        for (const { threeMesh } of loaded.meshes) {
          if (postprocessor.filterMesh(threeMesh) === false) excluded.add(threeMesh.name);
        }
      }
      if (postprocessor.fixupMesh) {
        for (const { threeMesh } of loaded.meshes) {
          if (excluded.has(threeMesh.name)) continue;
          postprocessor.fixupMesh(threeMesh);
        }
      }
      applyChangesToDocument(loaded, excluded);
      await writeDocument(loaded.doc, stagedSource);
    } else {
      fs.copyFileSync(absSource, stagedSource);
    }

    // CLI presence was probed up front (so versions could be mixed into the
    // hash). `lodEncoders` / `needsGltfTransform` / `needsGltfpack` are
    // still in scope here from the pre-hash setup.

    // Drop embedded textures from the staged source ONCE up front, so every
    // LOD encoder reads geometry-only input. The runtime pulls materials from
    // sidecar `.mat.json` files (which reference textures via the asset
    // manifest), so embedded image bytes here are pure dead weight — a 219-
    // tri LOD of a textured asset drops from ~26 MB to ~3 KB. Pre-stripping
    // (rather than post-stripping each LOD) also avoids re-encoding away the
    // meshopt compression that gltfpack `-cc` and `gltf-transform meshopt`
    // apply, since we never read those compressed buffers back. The editor
    // Inspector ModelPreview loses its baked textures and renders the
    // default standard material until it learns to load sidecars.
    const strippedSource = path.join(tmpDir, 'stripped.glb');
    fs.copyFileSync(stagedSource, strippedSource);
    await stripEmbeddedTextures(strippedSource);

    // Optional weld pass — only meaningful for gltf-transform LODs (gltfpack
    // does its own internal weld). Merges bitwise-identical vertices so
    // simplify can collapse across former UV/normal splits. Without this, a
    // typical Blender-exported GLB has one vertex per face per seam and
    // gltf-transform simplify can barely reduce anything regardless of ratio.
    let weldedSource = strippedSource;
    if (settings.weld && needsGltfTransform) {
      const welded = path.join(tmpDir, 'welded.glb');
      try {
        const gt = gltfTransformInvocation();
        execFileSync(gt.command, [...gt.prefixArgs, 'weld', strippedSource, welded], { stdio: 'pipe', shell: needsWinShell(gt.command) });
        weldedSource = welded;
      } catch (e) {
        const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
        throw new Error(`gltf-transform weld failed for ${sourceUrlPath}: ${stderr}`);
      }
    }

    for (let i = 0; i < lodCount; i++) {
      const ratio = settings.lodRatios[i];
      const enc = lodEncoders[i];
      // meshopt + aggressive resolve per-LOD so e.g. LOD0 can stay
      // conservative + uncompressed while LOD2 ships compressed + aggressive.
      const meshoptForLod = getLodMeshopt(settings, i);
      const aggressiveForLod = getLodAggressive(settings, i);
      if (enc === 'gltfpack') {
        try {
          const gp = gltfpackInvocation();
          execFileSync(gp.command, [...gp.prefixArgs, ...buildGltfpackArgs(strippedSource, stagingLodPaths[i], ratio, meshoptForLod, aggressiveForLod)], { stdio: 'pipe', shell: needsWinShell(gp.command) });
        } catch (e) {
          const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
          throw new Error(`gltfpack failed for ${sourceUrlPath} (lod${i}, ratio=${ratio}): ${stderr}`);
        }
      } else {
        // gltf-transform: aggressive flips --lock-border to 0; meshopt runs
        // as a post-pass that compresses geometry/morph/anim with
        // EXT_meshopt_compression (the same extension gltfpack -cc produces).
        // When meshopt is on we write simplify's output to a tmp file so the
        // post-pass can land on the staging LOD path.
        const intermediate = meshoptForLod ? path.join(tmpDir, `lod${i}.simplify.glb`) : stagingLodPaths[i];
        if (ratio >= 1.0) {
          fs.copyFileSync(weldedSource, intermediate);
        } else {
          try {
            const gt = gltfTransformInvocation();
            execFileSync(gt.command, [...gt.prefixArgs, ...buildGltfTransformSimplifyArgs(weldedSource, intermediate, ratio, settings.simplifyError, !aggressiveForLod)], { stdio: 'pipe', shell: needsWinShell(gt.command) });
          } catch (e) {
            const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
            throw new Error(`gltf-transform simplify failed for ${sourceUrlPath} (lod${i}, ratio=${ratio}): ${stderr}`);
          }
        }
        if (meshoptForLod) {
          try {
            const gt = gltfTransformInvocation();
            execFileSync(gt.command, [...gt.prefixArgs, ...buildGltfTransformMeshoptArgs(intermediate, stagingLodPaths[i])], { stdio: 'pipe', shell: needsWinShell(gt.command) });
          } catch (e) {
            const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
            throw new Error(`gltf-transform meshopt failed for ${sourceUrlPath} (lod${i}): ${stderr}`);
          }
        }
      }

      // Rebase the LOD's geometry into the source's local coordinate space.
      // No-op for encoders that already preserve the source hierarchy
      // (gltf-transform meshopt / simplify hit the matricesApproxEqual skip
      // path). Required for gltfpack, which flattens the source's ancestor
      // chain into the mesh-node matrix and additionally bakes a per-mesh
      // dequantization scale/translate there — without this, the runtime
      // entity Transform from the source's matrixWorld decompose no longer
      // maps the LOD's vertices to the same world coordinates as the source.
      //
      // Read the STAGED source (post-Stage-A) not absSource so postprocessors
      // that reshape the node graph (filterMesh drops, decompose) pair against
      // the same hierarchy the LOD encoder saw — otherwise rebase pairs LOD
      // leaves against a source mesh that no longer exists.
      try {
        await rebaseLodGeometry(stagedSource, stagingLodPaths[i]);
      } catch (e) {
        // Fail the whole conversion — silently shipping mis-rebased LODs
        // renders the wrong scale/offset on that level only, which is the
        // worst-of-both-worlds failure mode. Build-time failure surfaces it.
        throw new Error(`rebaseLodGeometry failed for ${sourceUrlPath} (lod${i}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Stats from the staging dir BEFORE the rename so we don't observe a
    // racing-other-writer's `<hash>/` contents.
    const triCounts: number[] = [];
    const lodBytes: number[] = [];
    for (const p of stagingLodPaths) {
      if (fs.existsSync(p)) {
        lodBytes.push(fs.statSync(p).size);
        triCounts.push(await countTriangles(p));
      } else {
        lodBytes.push(0);
        triCounts.push(0);
      }
    }

    // Atomic publish: rename staging dir into the final hash dir. If a
    // concurrent writer already published the same hash, drop ours and
    // accept theirs — both contain equivalent bytes (same source + settings
    // + tool versions hashed to the same key) so either is correct.
    try {
      if (fs.existsSync(finalDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } else {
        fs.renameSync(stagingDir, finalDir);
      }
      renamed = true;
    } catch (e) {
      // Lost the rename race or the FS denied the move — fall back to a
      // copy-then-cleanup; the cache hit on subsequent calls will read the
      // winner's bytes.
      console.warn(`[model-convert] atomic rename failed for ${sourceUrlPath}; falling back to copy:`, e);
      fs.mkdirSync(finalDir, { recursive: true });
      for (let i = 0; i < stagingLodPaths.length; i++) {
        if (!fs.existsSync(lodPaths[i])) fs.copyFileSync(stagingLodPaths[i], lodPaths[i]);
      }
      renamed = true;
    }

    // A fresh hash just landed → drop the source's now-superseded `<hash>/` dirs
    // (prior recipeVersion / settings / tool versions) so the per-source cache
    // doesn't grow without bound. Best-effort; never blocks the result.
    try {
      const dropped = pruneStaleCacheDirs(cacheDir, sourceUrlPath, hash);
      if (dropped > 0) console.log(`[model-convert] pruned ${dropped} stale cache dir(s) for ${sourceUrlPath}`);
    } catch { /* non-fatal */ }

    return {
      hash, cached: false, processedPath, lodPaths,
      lodDistances: settings.lodDistances.slice(0, lodCount),
      triCounts, lodBytes,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // If we threw before the rename, sweep the staging dir so the cache
    // directory doesn't accumulate orphaned `<hash>.tmp-*` siblings.
    if (!renamed) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
