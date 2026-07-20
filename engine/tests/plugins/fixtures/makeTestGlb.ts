/** Programmatic GLB fixture builder for pipeline integration tests.
 *
 *  Produces a self-contained GLB in memory via `@gltf-transform/core`:
 *    Root                         (node, non-identity transform)
 *    └─ BoxA     → BoxA mesh       (24-vert cube, translated)
 *       ├─ Terrain → Terrain mesh  (dense grid; sibling of BoxB under BoxA)
 *       └─ BoxB   → BoxB mesh       (cube, nested under BoxA)
 *          └─ BoxC → BoxC mesh      (cube, nested under BoxB — 3 levels deep)
 *  with an embedded PNG texture and a baseColor material shared by every mesh.
 *
 *  This exercises both halves of the import hierarchy fix: Terrain + BoxB are
 *  genuine SIBLINGS under a mesh parent (BoxA) — they must both resolve to BoxA,
 *  not chain — and BoxC is nested three levels deep, so each entity's stored
 *  transform must be LOCAL to its resolved parent (not world-space).
 *
 *  The Terrain mesh is deliberately dense (hundreds of triangles, non-coplanar)
 *  so LOD simplification has something measurable to reduce. The named nodes +
 *  parent-child links let the conversion test assert hierarchy survival, and the
 *  embedded texture lets it assert texture stripping (and the editor-import path
 *  assert texture extraction).
 *
 *  Pure Node — no browser APIs. `sharp` rasterizes the embedded texture.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';

interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

/** Axis-aligned cube, 24 verts (4 per face) so normals + UVs are per-face. */
function makeBox(size: number): MeshData {
  const h = size / 2;
  // Six faces, each: 4 corners + outward normal + a full 0..1 UV quad.
  const faces: { n: [number, number, number]; corners: [number, number, number][] }[] = [
    { n: [0, 0, 1], corners: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
    { n: [0, 0, -1], corners: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
    { n: [1, 0, 0], corners: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
    { n: [-1, 0, 0], corners: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
    { n: [0, 1, 0], corners: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
    { n: [0, -1, 0], corners: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  faces.forEach((f, fi) => {
    const base = fi * 4;
    for (const c of f.corners) { positions.push(...c); normals.push(...f.n); }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/** Subdivided grid in the XZ plane with a gentle sine bump so it is NOT
 *  coplanar — simplification then has to trade error for triangle count
 *  (a flat grid would collapse to two tris and make the reduction assertion
 *  trivially pass). `segments` cells per axis → segments*segments*2 triangles. */
function makeGrid(segments: number, size: number): MeshData {
  const verts = segments + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const u = i / segments;
      const v = j / segments;
      const x = (u - 0.5) * size;
      const z = (v - 0.5) * size;
      const y = Math.sin(u * Math.PI * 3) * Math.cos(v * Math.PI * 3) * (size * 0.08);
      positions.push(x, y, z);
      normals.push(0, 1, 0); // approximate; simplifier recomputes error from positions
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * verts + i;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/** Small RGBA checker PNG, embedded into the GLB as the baseColor texture. */
async function makeCheckerPng(dim = 16): Promise<Uint8Array> {
  const channels = 4;
  const buf = Buffer.alloc(dim * dim * channels);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const on = ((x >> 1) + (y >> 1)) % 2 === 0;
      const o = (y * dim + x) * channels;
      buf[o] = on ? 230 : 40;
      buf[o + 1] = on ? 80 : 60;
      buf[o + 2] = on ? 40 : 200;
      buf[o + 3] = 255;
    }
  }
  return new Uint8Array(await sharp(buf, { raw: { width: dim, height: dim, channels } }).png().toBuffer());
}

export interface TestGlbResult {
  /** Absolute path to the written .glb. */
  glbPath: string;
  /** Temp directory holding it (caller removes when done). */
  dir: string;
  /** Named mesh nodes the GLB contains, with their expected parent. */
  hierarchy: { node: string; parent: string }[];
  /** Total triangle count across both meshes (LOD0 baseline). */
  triangles: number;
}

export interface TestGlbOptions {
  /** Grid subdivisions per axis (more = more triangles). Default 24 → 1152 tris. */
  gridSegments?: number;
  /** Embed a baseColor texture + material. Default true. */
  withTexture?: boolean;
  /** Directory to write into. Default a fresh os.tmpdir() mkdtemp. */
  dir?: string;
  /** File name. Default 'test-model.glb'. */
  fileName?: string;
}

/** Build + write a test GLB. Returns its path and the structure tests assert on. */
export async function makeTestGlb(opts: TestGlbOptions = {}): Promise<TestGlbResult> {
  const { gridSegments = 24, withTexture = true } = opts;
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-glb-'));
  const fileName = opts.fileName ?? 'test-model.glb';
  const glbPath = path.join(dir, fileName);

  // Dynamic import: @gltf-transform/core is ESM-only and restricts subpath
  // exports — import the package entry the same way the converter does.
  const { Document, NodeIO } = await import('@gltf-transform/core');

  const doc = new Document();
  const buffer = doc.createBuffer();

  const material = doc.createMaterial('TestMat')
    .setBaseColorFactor([1, 1, 1, 1])
    .setRoughnessFactor(0.8)
    .setMetallicFactor(0);

  if (withTexture) {
    const png = await makeCheckerPng();
    const tex = doc.createTexture('CheckerTex').setImage(png).setMimeType('image/png');
    material.setBaseColorTexture(tex);
  }

  const addMesh = (name: string, data: MeshData) => {
    const position = doc.createAccessor(`${name}_POSITION`).setType('VEC3').setArray(data.positions).setBuffer(buffer);
    const normal = doc.createAccessor(`${name}_NORMAL`).setType('VEC3').setArray(data.normals).setBuffer(buffer);
    const uv = doc.createAccessor(`${name}_TEXCOORD_0`).setType('VEC2').setArray(data.uvs).setBuffer(buffer);
    const idx = doc.createAccessor(`${name}_indices`).setType('SCALAR').setArray(data.indices).setBuffer(buffer);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('NORMAL', normal)
      .setAttribute('TEXCOORD_0', uv)
      .setIndices(idx)
      .setMaterial(material);
    return doc.createMesh(name).addPrimitive(prim);
  };

  const boxA = makeBox(1.5);
  const boxB = makeBox(1.0);
  const boxC = makeBox(0.7);
  const grid = makeGrid(gridSegments, 8);

  // Root → BoxA → { Terrain, BoxB → BoxC }. Distinct box sizes keep the three
  // cube geometries from deduping. Non-identity transforms at every level so a
  // world-vs-local double-apply would surface as a wrong position.
  const terrainNode = doc.createNode('Terrain').setMesh(addMesh('Terrain', grid)).setTranslation([-2, 0, 1]);
  const boxCNode = doc.createNode('BoxC').setMesh(addMesh('BoxC', boxC)).setTranslation([1, 0, 0]);
  const boxBNode = doc.createNode('BoxB').setMesh(addMesh('BoxB', boxB)).setTranslation([0, 2, 0]).addChild(boxCNode);
  const boxANode = doc.createNode('BoxA').setMesh(addMesh('BoxA', boxA)).setTranslation([3, 0, 0]).addChild(terrainNode).addChild(boxBNode);
  const root = doc.createNode('Root').setTranslation([0, 1, 0]).addChild(boxANode);
  doc.createScene('Scene').addChild(root);

  const io = new NodeIO();
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(glbPath, glb);

  const tris = (m: MeshData) => m.indices.length / 3;

  return {
    glbPath,
    dir,
    hierarchy: [
      { node: 'BoxA', parent: 'Root' },
      { node: 'Terrain', parent: 'BoxA' },
      { node: 'BoxB', parent: 'BoxA' },
      { node: 'BoxC', parent: 'BoxB' },
    ],
    triangles: tris(boxA) + tris(boxB) + tris(boxC) + tris(grid),
  };
}
