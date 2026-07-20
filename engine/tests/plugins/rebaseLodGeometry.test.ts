/** Converter LOD-geometry rebase — guards the contract:
 *    `LOD.mesh.matrixWorld × LOD.vertices == source.mesh.matrixWorld × source.vertices`
 *  so the runtime entity Transform (saved from the editor's source-GLB
 *  decompose) works for every LOD regardless of encoder.
 *
 *  gltfpack flattens the source's ancestor chain into the mesh node and
 *  bakes a per-mesh dequantization scale/translate alongside it; without
 *  rebasing, the LOD's geometry lives in a different coordinate space from
 *  the source and renders offset/scaled. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as THREE from 'three';
import { rebaseLodGeometry } from '../../plugins/model-convert';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-rebase-'));
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/** Build a minimal source GLB:
 *    Root → Child node (scale = `scaleNode`) → mesh with positions `verts`
 *  The "world transform" of the mesh is `Root × Child = scaleNode`. */
async function buildSourceGlb(absPath: string, scaleNode: [number, number, number], verts: Float32Array): Promise<void> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc.createAccessor()
    .setArray(verts)
    .setType('VEC3')
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', positions);
  const mesh = doc.createMesh().addPrimitive(prim);
  // Name the mesh-bearing node so the rebase's name-pairing has a key to
  // match — real artist-authored GLBs always have node names.
  const child = doc.createNode().setName('Leaf').setMesh(mesh).setScale(scaleNode);
  const root = doc.createNode().addChild(child);
  doc.createScene().addChild(root);
  await new NodeIO().write(absPath, doc);
}

/** Build a "flattened" LOD GLB simulating gltfpack output:
 *    single mesh node (TRS = `nodeT`, `nodeS`) → mesh with the given verts
 *  matrixWorld for the mesh = the single node's local matrix. */
async function buildFlatLodGlb(
  absPath: string,
  nodeT: [number, number, number],
  nodeS: [number, number, number],
  verts: Float32Array,
): Promise<void> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc.createAccessor()
    .setArray(verts)
    .setType('VEC3')
    .setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', positions);
  const mesh = doc.createMesh().addPrimitive(prim);
  // Same node name as the source's mesh-bearing node so the pairing matches.
  const node = doc.createNode().setName('Leaf').setMesh(mesh).setTranslation(nodeT).setScale(nodeS);
  doc.createScene().addChild(node);
  await new NodeIO().write(absPath, doc);
}

/** Read back a GLB and return `mesh.matrixWorld` for its (single) mesh node
 *  plus the first vertex's world-space position. The world position is the
 *  invariant we care about — it should be the same across source and LOD. */
async function probeWorldPosition(absPath: string): Promise<{ matrixWorld: THREE.Matrix4; worldVertex0: THREE.Vector3 }> {
  const { NodeIO } = await import('@gltf-transform/core');
  const doc = await new NodeIO().read(absPath);
  // Walk the default scene, accumulating world matrices.
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0]!;
  let meshWorld: THREE.Matrix4 | null = null;
  let primitive: import('@gltf-transform/core').Primitive | null = null;
  const walk = (node: import('@gltf-transform/core').Node, parentWorld: THREE.Matrix4) => {
    const local = new THREE.Matrix4().fromArray(node.getMatrix());
    const world = new THREE.Matrix4().multiplyMatrices(parentWorld, local);
    const mesh = node.getMesh();
    if (mesh && !meshWorld) {
      meshWorld = world;
      primitive = mesh.listPrimitives()[0]!;
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  for (const child of scene.listChildren()) walk(child, new THREE.Matrix4());
  if (!meshWorld || !primitive) throw new Error('no mesh found in ' + absPath);

  const posArray = (primitive as import('@gltf-transform/core').Primitive).getAttribute('POSITION')!.getArray()!;
  const v0 = new THREE.Vector3(posArray[0], posArray[1], posArray[2]).applyMatrix4(meshWorld);
  return { matrixWorld: meshWorld, worldVertex0: v0 };
}

describe('rebaseLodGeometry', () => {
  it('rebases a flattened-hierarchy LOD into the source\'s coordinate space', async () => {
    // Source: child node scale=[2,2,2], verts (1,0,0),(0,1,0),(0,0,1).
    //   mesh.matrixWorld = scale(2). vertex0 in world = (2,0,0).
    const sourcePath = path.join(tmpRoot, 'source.glb');
    await buildSourceGlb(sourcePath, [2, 2, 2], new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]));

    // LOD: single flat node scale=[0.5,0.5,0.5], verts (4,0,0),(0,4,0),(0,0,4).
    //   mesh.matrixWorld = scale(0.5). vertex0 in world = (2,0,0) — same as source.
    //   But the local matrix is DIFFERENT (0.5 vs 2). If the runtime reads
    //   `mesh.matrixWorld` to derive an entity Transform, it'll get 0.5
    //   instead of 2, and applying it to a different LOD's geometry breaks.
    const lodPath = path.join(tmpRoot, 'lod.glb');
    await buildFlatLodGlb(lodPath, [0, 0, 0], [0.5, 0.5, 0.5],
      new Float32Array([4, 0, 0,  0, 4, 0,  0, 0, 4]));

    const before = await probeWorldPosition(lodPath);
    const sourceProbe = await probeWorldPosition(sourcePath);
    // World position invariant already held by construction.
    expect(before.worldVertex0.x).toBeCloseTo(sourceProbe.worldVertex0.x, 5);

    // But the matrixWorlds disagree — that's the problem the runtime hits.
    expect(before.matrixWorld.elements[0]).not.toBeCloseTo(sourceProbe.matrixWorld.elements[0], 2);

    await rebaseLodGeometry(sourcePath, lodPath);

    const after = await probeWorldPosition(lodPath);

    // After rebase: matrixWorld matches source, vertex0 world position unchanged.
    for (let i = 0; i < 16; i++) {
      expect(after.matrixWorld.elements[i]).toBeCloseTo(sourceProbe.matrixWorld.elements[i], 5);
    }
    expect(after.worldVertex0.x).toBeCloseTo(sourceProbe.worldVertex0.x, 5);
    expect(after.worldVertex0.y).toBeCloseTo(sourceProbe.worldVertex0.y, 5);
    expect(after.worldVertex0.z).toBeCloseTo(sourceProbe.worldVertex0.z, 5);

    // And the LOD's vertex0 in *local* (post-rebase) space should equal the
    // source's local vertex0 — that's the whole point of the rebase.
    const { NodeIO } = await import('@gltf-transform/core');
    const lodDoc = await new NodeIO().read(lodPath);
    const localPos = lodDoc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION')!.getArray()!;
    expect(localPos[0]).toBeCloseTo(1, 5);
    expect(localPos[4]).toBeCloseTo(1, 5);
    expect(localPos[8]).toBeCloseTo(1, 5);
  });

  it('is a no-op when the LOD already has the source\'s matrixWorld (gltf-transform meshopt case)', async () => {
    // Source and LOD with identical hierarchies + verts — gltf-transform
    // meshopt preserves the source's nodes, so the rebase path should
    // detect "matrices already match" and skip without rewriting the file.
    const sourcePath = path.join(tmpRoot, 'source.glb');
    const lodPath = path.join(tmpRoot, 'lod.glb');
    const verts = new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]);
    await buildSourceGlb(sourcePath, [3, 3, 3], verts);
    await buildSourceGlb(lodPath, [3, 3, 3], verts);

    const mtimeBefore = fs.statSync(lodPath).mtimeMs;
    // Sleep 5ms so we'd notice a stray write — fs mtime resolution on macOS
    // is ms-grade; without a pause, a same-millisecond rewrite would alias.
    await new Promise((r) => setTimeout(r, 5));

    await rebaseLodGeometry(sourcePath, lodPath);

    const mtimeAfter = fs.statSync(lodPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore); // no write happened
  });

  it('pairs LOD leaves by name and rebases multi-mesh GLBs (gltfpack pattern)', async () => {
    // Simulates the island case: two source nodes ("Hut", "Palm"), each
    // directly bearing its own mesh. The LOD mimics gltfpack's output —
    // each name is preserved on a *carrier* node, with an unnamed child
    // that actually holds the mesh and a baked dequant scale.
    const { Document, NodeIO } = await import('@gltf-transform/core');
    const sourcePath = path.join(tmpRoot, 'source.glb');
    const lodPath = path.join(tmpRoot, 'lod.glb');

    const buildSource = async () => {
      const doc = new Document();
      const buf = doc.createBuffer();
      const make = (name: string, vx: number, scale: number) => {
        const acc = doc.createAccessor()
          .setArray(new Float32Array([vx, 0, 0,  0, 1, 0,  0, 0, 1]))
          .setType('VEC3').setBuffer(buf);
        const prim = doc.createPrimitive().setAttribute('POSITION', acc);
        const mesh = doc.createMesh().addPrimitive(prim);
        return doc.createNode().setName(name).setMesh(mesh).setScale([scale, scale, scale]);
      };
      doc.createScene()
        .addChild(make('Hut', 1, 2))   // hut world-vert0 = (2, 0, 0)
        .addChild(make('Palm', 1, 3)); // palm world-vert0 = (3, 0, 0)
      await new NodeIO().write(sourcePath, doc);
    };

    const buildLod = async () => {
      const doc = new Document();
      const buf = doc.createBuffer();
      // Mimic gltfpack: named carrier (no mesh) → unnamed leaf (mesh +
      // baked dequant). Vertex data is pre-scaled to compensate, so the
      // pre-rebase world position matches the source's.
      const makePair = (name: string, vx: number, dequantScale: number, srcScale: number) => {
        const acc = doc.createAccessor()
          .setArray(new Float32Array([vx, 0, 0,  0, 1, 0,  0, 0, 1]))
          .setType('VEC3').setBuffer(buf);
        const prim = doc.createPrimitive().setAttribute('POSITION', acc);
        const mesh = doc.createMesh().addPrimitive(prim);
        const carrier = doc.createNode().setName(name).setScale([srcScale, srcScale, srcScale]);
        const leaf = doc.createNode().setMesh(mesh).setScale([dequantScale, dequantScale, dequantScale]);
        carrier.addChild(leaf);
        return carrier;
      };
      // Each pair models gltfpack's quantization split: the carrier keeps
      // the source's world scale, the leaf carries the dequant, and the
      // mesh stores pre-scaled vertices so the WORLD position still equals
      // the source's pre-rebase. matrixWorld disagrees (source=2, LOD =
      // 2 * 0.25 = 0.5), so the runtime entity Transform applied to the
      // LOD geometry would render at 2 * 4 = 8 instead of 2.
      // Hut:  source scale=2, vert=1 -> world=2.
      //       LOD carrier=2, dequant=0.25, vert=4 -> world = 2*0.25*4 = 2.
      // Palm: source scale=3, vert=1 -> world=3.
      //       LOD carrier=3, dequant=0.25, vert=4 -> world = 3*0.25*4 = 3.
      doc.createScene()
        .addChild(makePair('Hut',  4, 0.25, 2))
        .addChild(makePair('Palm', 4, 0.25, 3));
      await new NodeIO().write(lodPath, doc);
    };

    await buildSource();
    await buildLod();

    await rebaseLodGeometry(sourcePath, lodPath);

    // After rebase: matrixWorld matches source, geometry lives in source
    // local space, and the world position is unchanged from before.
    const probeFull = async (absPath: string) => {
      const doc = await new NodeIO().read(absPath);
      const out = new Map<string, { mw: THREE.Matrix4; localPos: number[]; world: THREE.Vector3 }>();
      const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
      const walk = (node: import('@gltf-transform/core').Node, pw: THREE.Matrix4, name: string) => {
        const local = new THREE.Matrix4().fromArray(node.getMatrix());
        const world = new THREE.Matrix4().multiplyMatrices(pw, local);
        const n = node.getName() || name;
        const m = node.getMesh();
        if (m && n) {
          const pos = Array.from(m.listPrimitives()[0].getAttribute('POSITION')!.getArray()!);
          const world0 = new THREE.Vector3(pos[0], pos[1], pos[2]).applyMatrix4(world);
          out.set(n, { mw: world.clone(), localPos: pos.slice(0, 3), world: world0 });
        }
        for (const c of node.listChildren()) walk(c, world, n);
      };
      for (const c of scene.listChildren()) walk(c, new THREE.Matrix4(), '');
      return out;
    };

    const src = await probeFull(sourcePath);
    const lod = await probeFull(lodPath);

    for (const name of ['Hut', 'Palm']) {
      // Geometry rebased into source-local space.
      expect(lod.get(name)!.localPos[0]).toBeCloseTo(src.get(name)!.localPos[0], 5);
      // matrixWorld matches the source's pose.
      for (let i = 0; i < 16; i++) {
        expect(lod.get(name)!.mw.elements[i]).toBeCloseTo(src.get(name)!.mw.elements[i], 5);
      }
      // World position invariant preserved.
      expect(lod.get(name)!.world.x).toBeCloseTo(src.get(name)!.world.x, 5);
    }
  });

  it('un-shares deduped accessors so two meshes sharing geometry each rebase independently', async () => {
    // Regression for the Freeport station: gltf-transform's dedup (run inside
    // weld/meshopt) collapses byte-identical geometry into ONE Accessor that
    // several meshes reference, even though those meshes sit at DIFFERENT
    // transforms. The rebase mutates vertex data in place, so without first
    // un-sharing it transforms the shared accessor once per mesh — the second
    // rebase lands on top of the first and corrupts BOTH (the station rendered
    // 6 of 28 parts 7-21x too large in the wrong place).
    const { Document, NodeIO } = await import('@gltf-transform/core');
    const sourcePath = path.join(tmpRoot, 'source.glb');
    const lodPath = path.join(tmpRoot, 'lod.glb');

    // Source: nodes "A" (scale 2) and "B" (scale 6), each with its OWN accessor,
    // local vert0 = (1,0,0). World vert0: A=(2,0,0), B=(6,0,0).
    {
      const doc = new Document();
      const buf = doc.createBuffer();
      const make = (name: string, scale: number) => {
        const acc = doc.createAccessor()
          .setArray(new Float32Array([1, 0, 0,  0, 1, 0,  0, 0, 1]))
          .setType('VEC3').setBuffer(buf);
        const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc));
        return doc.createNode().setName(name).setMesh(mesh).setScale([scale, scale, scale]);
      };
      doc.createScene().addChild(make('A', 2)).addChild(make('B', 6));
      await new NodeIO().write(sourcePath, doc);
    }

    // LOD: ONE shared accessor (local vert0 = (2,0,0)) referenced by BOTH
    // meshes — this is what dedup produces. Node scales make the pre-rebase
    // world position match the source: A scale=1 -> (2,0,0), B scale=3 -> (6,0,0).
    {
      const doc = new Document();
      const buf = doc.createBuffer();
      const shared = doc.createAccessor()
        .setArray(new Float32Array([2, 0, 0,  0, 2, 0,  0, 0, 2]))
        .setType('VEC3').setBuffer(buf);
      const meshA = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', shared));
      const meshB = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', shared));
      doc.createScene()
        .addChild(doc.createNode().setName('A').setMesh(meshA).setScale([1, 1, 1]))
        .addChild(doc.createNode().setName('B').setMesh(meshB).setScale([3, 3, 3]));
      await new NodeIO().write(lodPath, doc);
    }

    await rebaseLodGeometry(sourcePath, lodPath);

    const probe = async (absPath: string) => {
      const doc = await new NodeIO().read(absPath);
      const out = new Map<string, { local: number[]; world: THREE.Vector3 }>();
      const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
      const walk = (node: import('@gltf-transform/core').Node, pw: THREE.Matrix4) => {
        const w = new THREE.Matrix4().multiplyMatrices(pw, new THREE.Matrix4().fromArray(node.getMatrix()));
        const m = node.getMesh();
        const name = node.getName();
        if (m && name) {
          const pos = Array.from(m.listPrimitives()[0].getAttribute('POSITION')!.getArray()!);
          out.set(name, { local: pos.slice(0, 3), world: new THREE.Vector3(pos[0], pos[1], pos[2]).applyMatrix4(w) });
        }
        for (const c of node.listChildren()) walk(c, w);
      };
      for (const c of scene.listChildren()) walk(c, new THREE.Matrix4());
      return out;
    };

    const lod = await probe(lodPath);
    // Both meshes rebased into their OWN source-local space (vert0 == (1,0,0))
    // and kept their distinct world positions. Pre-fix the shared accessor was
    // transformed twice → local (0.5,…) and worlds 1 / 3 instead of 2 / 6.
    expect(lod.get('A')!.local[0]).toBeCloseTo(1, 5);
    expect(lod.get('B')!.local[0]).toBeCloseTo(1, 5);
    expect(lod.get('A')!.world.x).toBeCloseTo(2, 5);
    expect(lod.get('B')!.world.x).toBeCloseTo(6, 5);
  });
});
