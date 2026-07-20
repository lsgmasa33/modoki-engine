/** collisionMeshGen — turn a render mesh's geometry into a low-poly COLLISION mesh, in the
 *  browser, for the editor's "Generate Collision Mesh" action. Two pure steps:
 *
 *    1. `decimateMesh` — vertex-cluster decimation: snap every vertex to a grid cell, replace
 *       each occupied cell with its centroid, rebuild triangles against the collapsed vertices
 *       (dropping degenerate + duplicate tris). Robust on any mesh, no deps; quality is fine for
 *       collision (it only needs to approximate the surface). This is the exact algorithm the
 *       `engine/scripts/gen-collision-mesh.mjs` CLI uses, ported off Node Buffers.
 *    2. `buildCollisionGLB` — emit a minimal single-mesh glTF-2.0 binary (POSITION + NORMAL +
 *       indices) so the result is a normal model asset the mesh pipeline already understands
 *       (`.mesh.json` → model GUID → this GLB → `resolveMeshTemplate`). Same byte layout as the
 *       terrain/collision generators.
 *
 *  Both functions are pure (typed arrays in → typed arrays / bytes out, no THREE, no DOM), so the
 *  clustering + GLB layout are unit-tested directly. The Inspector button does the IO around them. */

import * as THREE from 'three';

export interface DecimatedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Minimal shape of a mesh-cache hierarchy entry (parent-relative TRS + parent link). */
export interface HierarchyEntryLike {
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  parentName: string | null;
}

/** Compose one mesh's model-space world matrix by walking its parentName chain (parent.world ×
 *  child.local, matching transformPropagationSystem). Missing entries → identity. */
function worldMatrixFor(name: string, byName: Map<string, HierarchyEntryLike>): THREE.Matrix4 {
  const chain: HierarchyEntryLike[] = [];
  let cur: HierarchyEntryLike | undefined = byName.get(name);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.name)) {
    guard.add(cur.name);
    chain.push(cur);
    cur = cur.parentName ? byName.get(cur.parentName) : undefined;
  }
  const world = new THREE.Matrix4();      // identity
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  // chain is child→…→root; multiply from root down so world = root.local × … × child.local.
  for (let i = chain.length - 1; i >= 0; i--) {
    const en = chain[i];
    e.set(en.rotation[0], en.rotation[1], en.rotation[2], 'XYZ');
    q.setFromEuler(e);
    local.compose(new THREE.Vector3(en.position[0], en.position[1], en.position[2]), q, new THREE.Vector3(en.scale[0], en.scale[1], en.scale[2]));
    world.multiply(local);
  }
  return world;
}

/** Merge every mesh of a model into one flat position + index buffer, in MODEL space (each mesh's
 *  geometry is mesh-local, so its hierarchy world matrix is baked in first). This is the
 *  whole-model collision surface a single trimesh collider wants. Pure geometry in → typed arrays
 *  out (normals are recomputed later by `decimateMesh`, so none are produced here). */
export function mergeModelGeometry(
  templates: Iterable<{ geometry: THREE.BufferGeometry; name: string }>,
  hierarchy: HierarchyEntryLike[] | undefined,
): { positions: Float32Array; indices: Uint32Array } {
  const byName = new Map<string, HierarchyEntryLike>();
  for (const h of hierarchy ?? []) byName.set(h.name, h);

  const outPos: number[] = [];
  const outIdx: number[] = [];
  const v = new THREE.Vector3();
  for (const t of templates) {
    const pos = t.geometry.getAttribute('position');
    if (!pos) continue;
    const m = worldMatrixFor(t.name, byName);
    const base = outPos.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      outPos.push(v.x, v.y, v.z);
    }
    const idx = t.geometry.index;
    if (idx) { for (let i = 0; i < idx.count; i++) outIdx.push(base + idx.getX(i)); }
    else { for (let i = 0; i < pos.count; i++) outIdx.push(base + i); } // non-indexed → identity
  }
  return { positions: new Float32Array(outPos), indices: new Uint32Array(outIdx) };
}

/** Vertex-cluster decimation. `positions` is a flat xyz array (mesh-local — apply no scale, the
 *  collider bakes Transform scale at runtime). `indices` is a flat triangle index (use an identity
 *  0..n-1 for non-indexed geometry). `cells` is the grid resolution along the longest bbox axis —
 *  higher = finer/more triangles. Returns fresh positions/normals/indices with recomputed normals. */
export function decimateMesh(positions: Float32Array, indices: Uint32Array, cells = 28): DecimatedMesh {
  // Bounding box → cell size along the longest axis.
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minx) minx = positions[i]; if (positions[i] > maxx) maxx = positions[i];
    if (positions[i + 1] < miny) miny = positions[i + 1]; if (positions[i + 1] > maxy) maxy = positions[i + 1];
    if (positions[i + 2] < minz) minz = positions[i + 2]; if (positions[i + 2] > maxz) maxz = positions[i + 2];
  }
  const span = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1;
  const cell = span / Math.max(1, cells);
  const cellKey = (x: number, y: number, z: number) =>
    `${Math.floor((x - minx) / cell)},${Math.floor((y - miny) / cell)},${Math.floor((z - minz) / cell)}`;

  // Centroid per occupied cell → the decimated vertex set.
  const acc = new Map<string, { sx: number; sy: number; sz: number; n: number; index: number }>();
  for (let i = 0; i < positions.length; i += 3) {
    const k = cellKey(positions[i], positions[i + 1], positions[i + 2]);
    let c = acc.get(k);
    if (!c) { c = { sx: 0, sy: 0, sz: 0, n: 0, index: -1 }; acc.set(k, c); }
    c.sx += positions[i]; c.sy += positions[i + 1]; c.sz += positions[i + 2]; c.n++;
  }
  const outPos: number[] = [];
  let vi = 0;
  for (const c of acc.values()) { c.index = vi++; outPos.push(c.sx / c.n, c.sy / c.n, c.sz / c.n); }

  // Original vertex → its cell's new index.
  const vCell = new Int32Array(positions.length / 3);
  for (let i = 0; i < positions.length; i += 3) {
    vCell[i / 3] = acc.get(cellKey(positions[i], positions[i + 1], positions[i + 2]))!.index;
  }

  // Rebuild triangles, dropping collapsed (2+ verts in one cell) + duplicate tris.
  const nTriVerts = indices.length;
  const outIdx: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < nTriVerts; t += 3) {
    const a = vCell[indices[t]], b = vCell[indices[t + 1]], c = vCell[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    outIdx.push(a, b, c);
  }

  const outPositions = new Float32Array(outPos);
  const outIndices = new Uint32Array(outIdx);
  const normals = computeNormals(outPositions, outIndices);
  return { positions: outPositions, normals, indices: outIndices };
}

/** Area-weighted vertex normals from a flat position array + triangle index. */
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const ux = positions[i1 * 3] - ax, uy = positions[i1 * 3 + 1] - ay, uz = positions[i1 * 3 + 2] - az;
    const vx = positions[i2 * 3] - ax, vy = positions[i2 * 3 + 1] - ay, vz = positions[i2 * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const idx of [i0, i1, i2]) { normals[idx * 3] += nx; normals[idx * 3 + 1] += ny; normals[idx * 3 + 2] += nz; }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
  }
  return normals;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** Emit a single-mesh glTF-2.0 binary (.glb) with POSITION + NORMAL + indices — the minimal shape
 *  the mesh pipeline resolves into a template. `meshName` becomes the mesh/node name (the value the
 *  `.mesh.json` references). Pure: bytes in → GLB bytes out. */
export function buildCollisionGLB(positions: Float32Array, normals: Float32Array, indices: Uint32Array, meshName = 'collision'): Uint8Array {
  const nv = positions.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) { const val = positions[i + a]; if (val < min[a]) min[a] = val; if (val > max[a]) max[a] = val; }
  }

  // BIN chunk: positions ‖ normals ‖ indices, each already 4-byte aligned (Float32/Uint32).
  const binLen = positions.byteLength + normals.byteLength + indices.byteLength;
  const bin = new Uint8Array(binLen + pad4(binLen));
  bin.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 0);
  bin.set(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength), positions.byteLength);
  bin.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), positions.byteLength + normals.byteLength);

  const gltf = {
    asset: { version: '2.0', generator: 'modoki-decimate-collision' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: meshName }],
    meshes: [{ name: meshName, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nv, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binLen }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad4(jsonBytes.length);
  const jsonChunkLen = jsonBytes.length + jsonPad;
  const total = 12 + 8 + jsonChunkLen + 8 + bin.length;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  // Header
  dv.setUint32(o, 0x46546c67, true); o += 4;   // 'glTF'
  dv.setUint32(o, 2, true); o += 4;             // version
  dv.setUint32(o, total, true); o += 4;         // total length
  // JSON chunk
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4;    // 'JSON'
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let p = 0; p < jsonPad; p++) out[o++] = 0x20; // space-pad JSON
  // BIN chunk
  dv.setUint32(o, bin.length, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4;    // 'BIN\0'
  out.set(bin, o);
  return out;
}

/** Uint8Array → base64 (chunked, avoids a huge apply spread on large meshes). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
