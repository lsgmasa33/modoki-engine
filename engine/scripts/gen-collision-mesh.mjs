// Decimate a render-mesh GLB into a low-poly COLLISION mesh GLB via vertex clustering.
// Usage: node gen-colmesh.mjs <input.glb> <output.colmesh.glb> [--cells N] [--name meshName]
// Vertex clustering: snap verts to a grid, replace each cell with its centroid, drop triangles
// that collapse. Robust on any mesh, no deps — quality is fine for collision (approx surface).
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const input = args[0], output = args[1];
const cells = Number((args.find((a) => a.startsWith('--cells=')) || '').split('=')[1]) || 28;
const meshName = (args.find((a) => a.startsWith('--name=')) || '--name=collision').split('=')[1];
if (!input || !output) { console.error('usage: gen-colmesh.mjs <in.glb> <out.glb> [--cells=N] [--name=x]'); process.exit(1); }

// ── Parse the input GLB → POSITION + indices ──
const b = readFileSync(input);
if (b.readUInt32LE(0) !== 0x46546c67) { console.error('not a GLB'); process.exit(1); }
const jsonLen = b.readUInt32LE(12);
const gltf = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = b.slice(binStart, binStart + b.readUInt32LE(20 + jsonLen));

const prim = gltf.meshes[0].primitives[0];
function readAccessor(ai) {
  const acc = gltf.accessors[ai];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
  const n = acc.count * numComp;
  if (acc.componentType === 5126) return new Float32Array(bin.buffer, bin.byteOffset + off, n);
  if (acc.componentType === 5125) return new Uint32Array(bin.buffer, bin.byteOffset + off, n);
  if (acc.componentType === 5123) return new Uint16Array(bin.buffer, bin.byteOffset + off, n);
  throw new Error('unsupported componentType ' + acc.componentType);
}
const pos = readAccessor(prim.attributes.POSITION);
const idxRaw = prim.indices != null ? readAccessor(prim.indices) : null;
const nTriVerts = idxRaw ? idxRaw.length : pos.length / 3;
const tri = (t) => (idxRaw ? idxRaw[t] : t);

// ── Vertex-cluster decimation ──
let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
for (let i = 0; i < pos.length; i += 3) {
  if (pos[i] < minx) minx = pos[i]; if (pos[i] > maxx) maxx = pos[i];
  if (pos[i + 1] < miny) miny = pos[i + 1]; if (pos[i + 1] > maxy) maxy = pos[i + 1];
  if (pos[i + 2] < minz) minz = pos[i + 2]; if (pos[i + 2] > maxz) maxz = pos[i + 2];
}
const span = Math.max(maxx - minx, maxy - miny, maxz - minz) || 1;
const cell = span / cells;
const cellKey = (x, y, z) => `${Math.floor((x - minx) / cell)},${Math.floor((y - miny) / cell)},${Math.floor((z - minz) / cell)}`;

// centroid per occupied cell
const acc = new Map(); // key -> {sx,sy,sz,n, index}
for (let i = 0; i < pos.length; i += 3) {
  const k = cellKey(pos[i], pos[i + 1], pos[i + 2]);
  let c = acc.get(k);
  if (!c) { c = { sx: 0, sy: 0, sz: 0, n: 0, index: -1 }; acc.set(k, c); }
  c.sx += pos[i]; c.sy += pos[i + 1]; c.sz += pos[i + 2]; c.n++;
}
const outPos = [];
let vi = 0;
for (const c of acc.values()) { c.index = vi++; outPos.push(c.sx / c.n, c.sy / c.n, c.sz / c.n); }

// map original vertex -> cell index
const vCell = new Int32Array(pos.length / 3);
for (let i = 0; i < pos.length; i += 3) vCell[i / 3] = acc.get(cellKey(pos[i], pos[i + 1], pos[i + 2])).index;

// rebuild triangles, dropping any that collapse (2+ verts share a cell); dedupe duplicate tris
const outIdx = [];
const seen = new Set();
for (let t = 0; t < nTriVerts; t += 3) {
  const a = vCell[tri(t)], bb = vCell[tri(t + 1)], cc = vCell[tri(t + 2)];
  if (a === bb || bb === cc || a === cc) continue;
  const key = [a, bb, cc].sort((x, y) => x - y).join(',');
  if (seen.has(key)) continue;
  seen.add(key);
  outIdx.push(a, bb, cc);
}

const positions = new Float32Array(outPos);
const indices = new Uint32Array(outIdx);

// recompute normals
const normals = new Float32Array(positions.length);
for (let t = 0; t < indices.length; t += 3) {
  const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
  const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
  const ux = positions[i1 * 3] - ax, uy = positions[i1 * 3 + 1] - ay, uz = positions[i1 * 3 + 2] - az;
  const vx = positions[i2 * 3] - ax, vy = positions[i2 * 3 + 1] - ay, vz = positions[i2 * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  for (const idx of [i0, i1, i2]) { normals[idx * 3] += nx; normals[idx * 3 + 1] += ny; normals[idx * 3 + 2] += nz; }
}
for (let v = 0; v < positions.length; v += 3) {
  const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
  normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
}

// ── Write the output GLB (same layout as the terrain generator) ──
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { const val = positions[i + a]; if (val < min[a]) min[a] = val; if (val > max[a]) max[a] = val; }
const pad4 = (n) => (4 - (n % 4)) % 4;
const binBuf = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
const binPadded = Buffer.concat([binBuf, Buffer.alloc(pad4(binBuf.length), 0)]);
const nv = positions.length / 3;
const g = {
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
  buffers: [{ byteLength: binBuf.length }],
};
const jb = Buffer.from(JSON.stringify(g), 'utf8');
const jbPadded = Buffer.concat([jb, Buffer.alloc(pad4(jb.length), 0x20)]);
const total = 12 + 8 + jbPadded.length + 8 + binPadded.length;
const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jbPadded.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(output, Buffer.concat([head, jh, jbPadded, bh, binPadded]));

const inTris = nTriVerts / 3;
console.log(`decimated ${input.split('/').pop()}: ${inTris} tris (${pos.length / 3} verts) → ${output.split('/').pop()}: ${indices.length / 3} tris (${nv} verts) — ${(100 * indices.length / 3 / inTris).toFixed(0)}% (cells=${cells})`);
