import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { decimateMesh, buildCollisionGLB, mergeModelGeometry } from '../../src/editor/scene/collisionMeshGen';

/** A dense subdivided quad in the XZ plane (y=0), N×N cells → 2·N² triangles. */
function grid(n: number): { positions: Float32Array; indices: Uint32Array } {
  const verts: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) verts.push(x / n - 0.5, 0, z / n - 0.5);
  const idx: number[] = [];
  const at = (x: number, z: number) => z * (n + 1) + x;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    idx.push(at(x, z), at(x + 1, z), at(x, z + 1));
    idx.push(at(x + 1, z), at(x + 1, z + 1), at(x, z + 1));
  }
  return { positions: new Float32Array(verts), indices: new Uint32Array(idx) };
}

describe('collisionMeshGen — decimateMesh', () => {
  it('reduces a dense grid to far fewer triangles while preserving bounds', () => {
    const { positions, indices } = grid(40); // 41×41 verts, 3200 tris
    const out = decimateMesh(positions, indices, 8);
    expect(out.indices.length / 3).toBeGreaterThan(0);
    expect(out.indices.length).toBeLessThan(indices.length); // decimated
    expect(out.positions.length).toBeLessThan(positions.length);
    // Bounds are preserved (centroids of corner cells still span ~[-0.5, 0.5] in x/z).
    let minx = Infinity, maxx = -Infinity;
    for (let i = 0; i < out.positions.length; i += 3) { minx = Math.min(minx, out.positions[i]); maxx = Math.max(maxx, out.positions[i]); }
    expect(minx).toBeLessThan(-0.3);
    expect(maxx).toBeGreaterThan(0.3);
    // Normals are unit-length and point along +Y for a flat XZ plane.
    for (let i = 0; i < out.normals.length; i += 3) {
      const l = Math.hypot(out.normals[i], out.normals[i + 1], out.normals[i + 2]);
      expect(l).toBeGreaterThan(0.99);
      expect(Math.abs(out.normals[i + 1])).toBeGreaterThan(0.99);
    }
  });

  it('emits no degenerate or duplicate triangles', () => {
    const out = decimateMesh(grid(30).positions, grid(30).indices, 6);
    const seen = new Set<string>();
    for (let t = 0; t < out.indices.length; t += 3) {
      const a = out.indices[t], b = out.indices[t + 1], c = out.indices[t + 2];
      expect(a).not.toBe(b); expect(b).not.toBe(c); expect(a).not.toBe(c);
      const key = [a, b, c].sort((x, y) => x - y).join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      // Indices stay in range.
      expect(a).toBeLessThan(out.positions.length / 3);
    }
  });
});

describe('collisionMeshGen — mergeModelGeometry', () => {
  /** One triangle at local origin (verts 0,0,0 / 1,0,0 / 0,0,1). */
  function tri(name: string): { geometry: THREE.BufferGeometry; name: string } {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
    g.setIndex([0, 1, 2]);
    return { geometry: g, name };
  }

  it('concatenates meshes and offsets indices', () => {
    const merged = mergeModelGeometry([tri('a'), tri('b')], undefined);
    expect(merged.positions.length).toBe(18);        // 2 tris × 3 verts × 3
    expect(merged.indices.length).toBe(6);
    // Second triangle's indices are offset by the first's vertex count (3).
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('bakes each mesh\'s hierarchy world transform into model space', () => {
    const merged = mergeModelGeometry([tri('a'), tri('b')], [
      { name: 'a', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentName: null },
      { name: 'b', position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentName: null },
    ]);
    // Mesh 'b' is translated +10 in x → its verts land at x≈10,11,10.
    const bx = [merged.positions[9], merged.positions[12], merged.positions[15]];
    expect(bx).toEqual([10, 11, 10]);
  });

  it('composes parent → child transforms along the chain', () => {
    const merged = mergeModelGeometry([tri('child')], [
      { name: 'root', position: [5, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2], parentName: null },
      { name: 'child', position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parentName: 'root' },
    ]);
    // child local (0,0,0) → root.world × child.local: scale 2 then +5 → x = 5 + 2·1 = 7 for the
    // child's own origin offset; vert 0 (local 0,0,0) maps to child origin = root×(1,0,0) = (7,0,0).
    expect(merged.positions[0]).toBeCloseTo(7, 5);
    expect(merged.positions[1]).toBeCloseTo(0, 5);
  });
});

describe('collisionMeshGen — buildCollisionGLB', () => {
  it('emits a valid glTF-2.0 binary with JSON+BIN chunks', () => {
    const out = decimateMesh(grid(20).positions, grid(20).indices, 6);
    const glb = buildCollisionGLB(out.positions, out.normals, out.indices, 'terrain_col');
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    // Header: magic 'glTF', version 2, total length == byte length.
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    // JSON chunk header.
    const jsonLen = dv.getUint32(12, true);
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
    const jsonBytes = glb.subarray(20, 20 + jsonLen);
    const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
    expect(gltf.asset.version).toBe('2.0');
    expect(gltf.meshes[0].name).toBe('terrain_col');
    expect(gltf.accessors[0].type).toBe('VEC3');
    expect(gltf.accessors[0].min).toHaveLength(3);
    expect(gltf.accessors[2].count).toBe(out.indices.length);
    // BIN chunk header follows the (4-byte aligned) JSON chunk.
    const binHeaderOff = 20 + jsonLen;
    expect(dv.getUint32(binHeaderOff + 4, true)).toBe(0x004e4942); // 'BIN\0'
    // Total length is 4-byte aligned.
    expect(glb.byteLength % 4).toBe(0);
  });

  it('produces a GLB the real three GLTFLoader parses into a mesh (the runtime path)', async () => {
    const out = decimateMesh(grid(20).positions, grid(20).indices, 8);
    const glb = buildCollisionGLB(out.positions, out.normals, out.indices, 'terrain_col');
    const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    const loader = new GLTFLoader();
    const gltf = await new Promise<{ scene: { traverse: (f: (o: unknown) => void) => void } }>((res, rej) => loader.parse(ab, '', res as never, rej));
    let mesh: { geometry: { getAttribute: (n: string) => { count: number }; index: { count: number } } } | null = null;
    gltf.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) mesh = o as never; });
    expect(mesh).toBeTruthy();
    expect(mesh!.geometry.getAttribute('position').count).toBe(out.positions.length / 3);
    expect(mesh!.geometry.index.count).toBe(out.indices.length);
  });
});
