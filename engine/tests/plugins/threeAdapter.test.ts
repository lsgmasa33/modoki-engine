/** Stage A converter — three-adapter shared-material clone behavior.
 *
 *  Scenario: two glTF Nodes reference different Meshes whose primitives
 *  share the same Material. A divergent fixup (different color on each
 *  Node's adapted THREE mesh) used to be lost — the last write-back into
 *  the shared gltf-transform Material won. The adapter now groups
 *  adapted meshes by post-fixup fingerprint and clones the Material per
 *  divergent group so each Node gets the right factors in the staged GLB. */

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as THREE from 'three';
import { Document, NodeIO } from '@gltf-transform/core';

import {
  applyChangesToDocument, loadGlbToThreeMeshes, writeDocument,
  type LoadedGlb, type AdaptedMesh,
} from '../../plugins/model-convert/threeAdapter';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a Document with two Nodes referencing two Meshes that both point
 *  at one shared Material. Returns the Document plus AdaptedMeshes ready
 *  for the divergent-fixup test. */
function buildSharedMaterialDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const sharedMat = doc.createMaterial('Material.010')
    .setBaseColorFactor([0.5, 0.5, 0.5, 1])
    .setRoughnessFactor(0.5)
    .setMetallicFactor(0)
    .setAlphaMode('OPAQUE');

  const positions = doc.createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]))
    .setBuffer(buffer);

  // Two distinct Meshes (not shared) → distinct Primitives → both pointing
  // at the SAME Material. Two Nodes, one per Mesh.
  const groundPrim = doc.createPrimitive().setAttribute('POSITION', positions).setMaterial(sharedMat);
  const groundMesh = doc.createMesh('GroundMesh').addPrimitive(groundPrim);
  const groundNode = doc.createNode('Ground').setMesh(groundMesh);

  const weedPrim = doc.createPrimitive().setAttribute('POSITION', positions).setMaterial(sharedMat);
  const weedMesh = doc.createMesh('WeedMesh').addPrimitive(weedPrim);
  const weedNode = doc.createNode('Plane001').setMesh(weedMesh);

  doc.createScene().addChild(groundNode).addChild(weedNode);

  // Build matching AdaptedMesh entries (mimicking what loadGlbToThreeMeshes
  // would produce). Each Node gets its own THREE.MeshStandardMaterial so
  // the loader's per-instance fixup can diverge — exactly as the runtime
  // GLTFLoader.traverse behaves.
  const makeThreeMesh = (name: string) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.getArray()!), 3));
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.5, 0.5, 0.5),
      roughness: 0.5,
      metalness: 0,
    });
    mat.name = sharedMat.getName();
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    return m;
  };

  const meshes: AdaptedMesh[] = [
    { threeMesh: makeThreeMesh('Ground'), primitive: groundPrim, node: groundNode },
    { threeMesh: makeThreeMesh('Plane001'), primitive: weedPrim, node: weedNode },
  ];
  return { doc, sharedMat, groundPrim, weedPrim, groundNode, weedNode, meshes };
}

describe('applyChangesToDocument — shared-material clone', () => {
  it('clones the gltf-transform Material per divergent post-fixup fingerprint', () => {
    const { doc, sharedMat, groundPrim, weedPrim, meshes } = buildSharedMaterialDoc();

    // Mimic loader.fixupMesh dispatching on mesh.name: ground = blue-grey,
    // weed = green + double-sided. Both materials carry the same `mat.name`
    // ('Material.010') because they came from the same gltf-transform Material.
    const groundMat = meshes[0].threeMesh.material as THREE.MeshStandardMaterial;
    groundMat.color.setRGB(0.35, 0.42, 0.6);
    groundMat.roughness = 0.8;

    const weedMat = meshes[1].threeMesh.material as THREE.MeshStandardMaterial;
    weedMat.color.setRGB(0.18, 0.48, 0.12);
    weedMat.roughness = 0.85;
    weedMat.side = THREE.DoubleSide;

    const loaded: LoadedGlb = { doc, meshes };
    applyChangesToDocument(loaded, new Set());

    const groundResolved = groundPrim.getMaterial();
    const weedResolved = weedPrim.getMaterial();
    expect(groundResolved).not.toBeNull();
    expect(weedResolved).not.toBeNull();
    expect(groundResolved).not.toBe(weedResolved);

    // First fingerprint reuses the original Material.
    expect(groundResolved).toBe(sharedMat);
    expect(groundResolved!.getName()).toBe('Material.010');
    const groundFactor = groundResolved!.getBaseColorFactor();
    expect(groundFactor[0]).toBeCloseTo(0.35, 4);
    expect(groundFactor[1]).toBeCloseTo(0.42, 4);
    expect(groundFactor[2]).toBeCloseTo(0.6, 4);
    expect(groundResolved!.getRoughnessFactor()).toBeCloseTo(0.8, 4);
    expect(groundResolved!.getDoubleSided()).toBe(false);

    // Second fingerprint creates a clone with `_v1` suffix.
    expect(weedResolved).not.toBe(sharedMat);
    expect(weedResolved!.getName()).toBe('Material.010_v1');
    const weedFactor = weedResolved!.getBaseColorFactor();
    expect(weedFactor[0]).toBeCloseTo(0.18, 4);
    expect(weedFactor[1]).toBeCloseTo(0.48, 4);
    expect(weedFactor[2]).toBeCloseTo(0.12, 4);
    expect(weedResolved!.getRoughnessFactor()).toBeCloseTo(0.85, 4);
    expect(weedResolved!.getDoubleSided()).toBe(true);
  });

  it('does NOT clone when all fixups produce the same fingerprint', () => {
    const { doc, sharedMat, groundPrim, weedPrim, meshes } = buildSharedMaterialDoc();

    // Both materials get the same change → no divergence → no clone.
    for (const { threeMesh } of meshes) {
      const m = threeMesh.material as THREE.MeshStandardMaterial;
      m.color.setRGB(0.2, 0.2, 0.2);
      m.roughness = 0.9;
    }

    const loaded: LoadedGlb = { doc, meshes };
    applyChangesToDocument(loaded, new Set());

    expect(groundPrim.getMaterial()).toBe(sharedMat);
    expect(weedPrim.getMaterial()).toBe(sharedMat);
    expect(doc.getRoot().listMaterials()).toHaveLength(1);
  });

  it('excluded meshes do not influence material grouping', () => {
    const { doc, sharedMat, groundPrim, weedPrim, meshes } = buildSharedMaterialDoc();

    // Ground mesh stays at the buildMaterial default (no fixup); weed mesh
    // diverges. If excluded meshes still contributed to grouping, the
    // "default" fingerprint would claim the original Material and the weed
    // fixup would land on a clone — but the ground mesh is being dropped,
    // so we want the weed fixup to land on the original.
    const weedMat = meshes[1].threeMesh.material as THREE.MeshStandardMaterial;
    weedMat.color.setRGB(0.18, 0.48, 0.12);
    weedMat.roughness = 0.85;
    weedMat.side = THREE.DoubleSide;

    const loaded: LoadedGlb = { doc, meshes };
    applyChangesToDocument(loaded, new Set(['Ground']));

    expect(doc.getRoot().listMaterials()).toHaveLength(1);
    expect(weedPrim.getMaterial()).toBe(sharedMat);
    const factor = sharedMat.getBaseColorFactor();
    expect(factor[0]).toBeCloseTo(0.18, 4);
    expect(factor[1]).toBeCloseTo(0.48, 4);
    expect(factor[2]).toBeCloseTo(0.12, 4);
    expect(sharedMat.getDoubleSided()).toBe(true);
    // Excluded Node should have been disposed.
    expect(doc.getRoot().listNodes()).toHaveLength(1);
    expect(doc.getRoot().listNodes()[0].getName()).toBe('Plane001');
    // groundPrim was attached to a disposed Mesh; reading from it is
    // intentionally untested (gltf-transform disposes the chain).
    void groundPrim;
  });

  it('preserves texture references on cloned materials (clone is by-ref)', () => {
    const { doc, sharedMat, weedPrim, meshes } = buildSharedMaterialDoc();
    const tex = doc.createTexture('albedo').setImage(new Uint8Array([0, 0, 0, 0]));
    sharedMat.setBaseColorTexture(tex);

    const groundMat = meshes[0].threeMesh.material as THREE.MeshStandardMaterial;
    groundMat.color.setRGB(0.35, 0.42, 0.6);
    const weedMat = meshes[1].threeMesh.material as THREE.MeshStandardMaterial;
    weedMat.color.setRGB(0.18, 0.48, 0.12);
    weedMat.side = THREE.DoubleSide;

    applyChangesToDocument({ doc, meshes }, new Set());

    const cloned = weedPrim.getMaterial()!;
    expect(cloned).not.toBe(sharedMat);
    expect(cloned.getBaseColorTexture()).toBe(tex);
  });

  it('warns and keeps first assignment when one primitive serves divergent fingerprints', () => {
    // Two Nodes sharing the same Mesh → same Primitive. Divergent fixups
    // can't be cleanly resolved by Material cloning alone (would also need
    // Mesh cloning). v1 keeps the first assignment and warns.
    const doc = new Document();
    const buf = doc.createBuffer();
    const sharedMat = doc.createMaterial('Shared')
      .setBaseColorFactor([0.5, 0.5, 0.5, 1])
      .setAlphaMode('OPAQUE');
    const pos = doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(sharedMat);
    const sharedMeshNode = doc.createMesh('Shared').addPrimitive(prim);
    const nodeA = doc.createNode('A').setMesh(sharedMeshNode);
    const nodeB = doc.createNode('B').setMesh(sharedMeshNode);
    doc.createScene().addChild(nodeA).addChild(nodeB);

    const makeMesh = (name: string, color: [number, number, number]) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos.getArray()!), 3));
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(...color) }));
      m.name = name;
      (m.material as THREE.Material).name = sharedMat.getName();
      return m;
    };

    const meshes: AdaptedMesh[] = [
      { threeMesh: makeMesh('A', [0.35, 0.42, 0.6]), primitive: prim, node: nodeA },
      { threeMesh: makeMesh('B', [0.18, 0.48, 0.12]), primitive: prim, node: nodeB },
    ];

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyChangesToDocument({ doc, meshes }, new Set());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Shared primitive carries divergent post-fixup state/);

    // The original Material wins (first-fingerprint assignment).
    expect(prim.getMaterial()).toBe(sharedMat);
    // …but the clone for B was still created in the resolution map, so the
    // Document now has two materials even though only one is referenced.
    // That's acceptable for v1 — the orphan gets pruned by downstream
    // gltfpack/LOD passes anyway.
  });
});

describe('applyChangesToDocument — geometry attribute sync', () => {
  // Build a primitive that ALREADY has TEXCOORD_0 + a THREE mesh whose geometry
  // has DIFFERENT uv/position (mimicking a postprocessor rewrite, e.g. the planet
  // equirect UV regen on a sphere that already had UVs).
  function buildRewrittenUVDoc() {
    const doc = new Document();
    const buf = doc.createBuffer();
    const pos = doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const origUV = doc.createAccessor().setType('VEC2')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', origUV);
    const node = doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim));
    doc.createScene().addChild(node);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([9, 9, 9, 9, 9, 9, 9, 9, 9]), 3)); // tampered
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0.25, 0.5, 0.75, 0.5, 0.5, 0]), 2));   // rewritten
    const threeMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    threeMesh.name = 'N';
    return { doc, prim, pos, meshes: [{ threeMesh, primitive: prim, node }] as AdaptedMesh[] };
  }

  it('overwrites an existing TEXCOORD_0 with the postprocessor-rewritten UVs', () => {
    const { doc, prim, meshes } = buildRewrittenUVDoc();
    applyChangesToDocument({ doc, meshes }, new Set());
    expect(Array.from(prim.getAttribute('TEXCOORD_0')!.getArray()!))
      .toEqual([0.25, 0.5, 0.75, 0.5, 0.5, 0]);
  });

  it('does NOT overwrite POSITION (guards the LOD rebase + quantization)', () => {
    const { doc, prim, pos, meshes } = buildRewrittenUVDoc();
    applyChangesToDocument({ doc, meshes }, new Set());
    // POSITION accessor is untouched despite the tampered THREE geometry.
    expect(prim.getAttribute('POSITION')).toBe(pos);
    expect(Array.from(pos.getArray()!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('clears the normalized flag when overwriting a quantized TEXCOORD_0', () => {
    // Source had a quantized (normalized Uint16) UV; the postprocessor writes
    // genuine Float32 values. Without clearing `normalized`, the accessor
    // becomes FLOAT-but-normalized — a combo WebGPU has no vertex format for,
    // which crashed createRenderPipeline every frame and froze the editor
    // (tropical island regression).
    const doc = new Document();
    const buf = doc.createBuffer();
    const pos = doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const origUV = doc.createAccessor().setType('VEC2')
      .setArray(new Uint16Array([0, 0, 65535, 0, 0, 65535])).setNormalized(true).setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', origUV);
    const node = doc.createNode('N').setMesh(doc.createMesh('M').addPrimitive(prim));
    doc.createScene().addChild(node);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    const threeMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    threeMesh.name = 'N';

    applyChangesToDocument({ doc, meshes: [{ threeMesh, primitive: prim, node }] }, new Set());

    const uv = prim.getAttribute('TEXCOORD_0')!;
    expect(uv.getNormalized()).toBe(false);
    // 5126 === GL_FLOAT — the array constructor drives componentType inference.
    expect(uv.getComponentType()).toBe(5126);
    expect(Array.from(uv.getArray()!)).toEqual([0, 0, 1, 0, 0, 1]);
  });
});

describe('Stage A round-trip — quantized UV source never bakes a FLOAT+normalized accessor', () => {
  // The tropical-island freeze in miniature: a source whose TEXCOORD_0 is a
  // normalized Uint16 (KHR_mesh_quantization) must survive the full Stage A
  // path — loadGlbToThreeMeshes → applyChangesToDocument → writeDocument —
  // as a plain Float32 UV. A FLOAT-but-normalized accessor has no WebGPU
  // vertex format and crashed createRenderPipeline every frame. This exercises
  // the real adapter end-to-end (the unit tests above only hit one hop).
  let tmpDir: string;
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-adapter-')); });
  afterAll(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('denormalizes on load and writes a plain Float32 UV back out', async () => {
    // Build a source GLB whose TEXCOORD_0 is a normalized Uint16 [0,0,1,0,0,1].
    const srcDoc = new Document();
    const buf = srcDoc.createBuffer();
    const pos = srcDoc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const uvQuant = srcDoc.createAccessor().setType('VEC2')
      .setArray(new Uint16Array([0, 0, 65535, 0, 0, 65535])).setNormalized(true).setBuffer(buf);
    const prim = srcDoc.createPrimitive().setAttribute('POSITION', pos).setAttribute('TEXCOORD_0', uvQuant);
    srcDoc.createScene().addChild(srcDoc.createNode('N').setMesh(srcDoc.createMesh('M').addPrimitive(prim)));
    const srcPath = path.join(tmpDir, 'src.glb');
    await new NodeIO().write(srcPath, srcDoc);

    // Load via the adapter — buildGeometry must denormalize the Uint16 codes
    // into real [0,1] floats, not copy raw 0..65535 values.
    const loaded = await loadGlbToThreeMeshes(srcPath);
    const meshN = loaded.meshes.find((m) => m.threeMesh.name === 'N')!;
    const uvAttr = meshN.threeMesh.geometry.getAttribute('uv');
    expect(uvAttr.array).toBeInstanceOf(Float32Array);
    expect(uvAttr.normalized).toBe(false);
    expect(Array.from(uvAttr.array as Float32Array)).toEqual([0, 0, 1, 0, 0, 1]);

    // Write the (unmutated) doc back out and re-read: the staged accessor must
    // be FLOAT and NOT normalized — the invariant the runtime depends on.
    applyChangesToDocument(loaded, new Set());
    const outPath = path.join(tmpDir, 'staged.glb');
    await writeDocument(loaded.doc, outPath);

    const outDoc = await new NodeIO().read(outPath);
    let checked = 0;
    for (const mesh of outDoc.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const uv = p.getAttribute('TEXCOORD_0');
        if (!uv) continue;
        checked++;
        // The forbidden combo: componentType FLOAT (5126) AND normalized.
        expect(uv.getComponentType() === 5126 && uv.getNormalized()).toBe(false);
        expect(Array.from(uv.getArray()!)).toEqual([0, 0, 1, 0, 0, 1]);
      }
    }
    expect(checked).toBe(1);
  });
});
