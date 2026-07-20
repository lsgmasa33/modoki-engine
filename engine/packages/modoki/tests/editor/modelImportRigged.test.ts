/** modelImport rigged-path test (serialize-model-import Missing-Test #5).
 *  The flatten-path suite (modelImport.test.ts) mocks GLTFLoader to a non-skinned
 *  scene, forcing the static branch — so the SkinnedModel path was entirely
 *  untested. Here GLTFLoader returns a SkinnedMesh + clips so importModel takes the
 *  rigged branch: it must spawn a SkinnedModel ROOT with a SkeletalAnimator bound to
 *  the FIRST clip, auto-fit the bind-pose scale, write the rig sidecar (clip list),
 *  spawn one SkinnedMeshRenderer child per mesh node, and warm the rigged cache. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { isGuid } from '../../src/runtime/loaders/assetManifest';

// ── A rigged GLB: one named SkinnedMesh (2-unit box → auto-fit scale 1) bound to a
//    single identity 'Root' bone, plus 2 clips. The skin attributes + one bone are
//    needed so THREE's skinned-bbox (expandByObject → applyBoneTransform) computes
//    rather than throwing on a bare skeleton. ──
function makeRiggedScene() {
  const scene = new THREE.Group();
  const geom = new THREE.BoxGeometry(2, 2, 2); // maxDim 2 → auto-fit scale = 2/2 = 1
  const n = geom.attributes.position.count;
  // every vertex fully weighted to bone 0
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) w[i * 4] = 1;
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  const mat = new THREE.MeshStandardMaterial(); mat.name = 'BodyMat';
  const sm = new THREE.SkinnedMesh(geom, mat);
  sm.name = 'Body';
  const bone = new THREE.Bone(); bone.name = 'Root';
  sm.add(bone);
  sm.bind(new THREE.Skeleton([bone])); // identity bind → bbox = box bbox
  scene.add(sm);
  const animations = [new THREE.AnimationClip('Idle', 1, []), new THREE.AnimationClip('Walk', 1, [])];
  return { scene, animations };
}

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    async loadAsync() { return makeRiggedScene(); }
  },
}));

// Capture rigged-cache calls.
const ensureRiggedModelLoaded = vi.fn();
const invalidateRiggedModel = vi.fn();
vi.mock('../../src/runtime/loaders/riggedModelCache', () => ({
  ensureRiggedModelLoaded: (...a: unknown[]) => ensureRiggedModelLoaded(...a),
  invalidateRiggedModel: (...a: unknown[]) => invalidateRiggedModel(...a),
}));

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn(async () => {}),
  getTemplatesForModel: vi.fn(() => new Map()),
  invalidateModel: vi.fn(),
  invalidateMaterial: vi.fn(),
}));

// ── ECS world: spawn records the trait objects so we can assert on them. ──
interface SpawnedEntity { id(): number; has(): boolean; _traits: Record<string, any>; }
let spawned: SpawnedEntity[] = [];
let nextId = 1;
const entityIndex = new Map<number, SpawnedEntity>();
let testWorld: any;
vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  setStructureCallback: vi.fn(),
  registerEntity: (e: SpawnedEntity) => { entityIndex.set(e.id(), e); return e; },
  unregisterEntity: (e: SpawnedEntity) => { entityIndex.delete(e.id()); },
  onWorldSwap: vi.fn(() => () => {}),
}));

// Traits: factories that tag their data with the trait name so spawn can index them.
function traitFactory(name: string) {
  const fn = (data: any = {}) => ({ _trait: name, ...data });
  (fn as any)._name = name;
  return fn;
}
vi.mock('../../src/runtime/traits', () => ({
  Transform: traitFactory('Transform'),
  EntityAttributes: traitFactory('EntityAttributes'),
  ModelSource: traitFactory('ModelSource'),
  SkinnedModel: traitFactory('SkinnedModel'),
  SkinnedMeshRenderer: traitFactory('SkinnedMeshRenderer'),
  SkeletalAnimator: traitFactory('SkeletalAnimator'),
  Bone: traitFactory('Bone'),
}));

// Backend IO: record meta + file writes; everything else is a soft no-op.
let writtenMeta: any[] = [];
let writtenFiles: any[] = [];
const mockFetch = vi.fn(async (url: string, opts?: any) => {
  if (url.startsWith('/api/read-meta')) return { ok: false } as any;       // no prior sidecar
  if (url === '/api/write-meta') { writtenMeta.push(JSON.parse(opts.body)); return { ok: true } as any; }
  if (url === '/api/write-file') { writtenFiles.push(JSON.parse(opts.body)); return { ok: true } as any; }
  if (url === '/api/reimport') return { ok: true, json: async () => ({}) } as any;
  return { ok: true, json: async () => ({}) } as any;
});
vi.stubGlobal('fetch', mockFetch);

import { importModel } from '../../src/editor/scene/modelImport';

function traitOf(e: SpawnedEntity, name: string) { return e._traits[name]; }

describe('importModel — rigged (SkinnedModel) path', () => {
  beforeEach(() => {
    spawned = []; nextId = 1; entityIndex.clear(); writtenMeta = []; writtenFiles = [];
    ensureRiggedModelLoaded.mockClear(); invalidateRiggedModel.mockClear();
    testWorld = {
      spawn: (...traits: any[]) => {
        const id = nextId++;
        const byName: Record<string, any> = {};
        for (const t of traits) if (t && t._trait) byName[t._trait] = t;
        const e: SpawnedEntity = { id: () => id, has: () => false, _traits: byName };
        spawned.push(e);
        return e;
      },
      query: () => ({ updateEach: () => {} }),
    };
  });

  it('routes a skinned GLB to a SkinnedModel root with a SkeletalAnimator on the first clip', async () => {
    const rootId = await importModel('/games/x/assets/hero.glb', 'hero');

    // The returned id is a real spawned entity carrying SkinnedModel + SkeletalAnimator.
    const root = entityIndex.get(rootId)!;
    expect(root).toBeTruthy();
    const skinned = traitOf(root, 'SkinnedModel');
    const animator = traitOf(root, 'SkeletalAnimator');
    expect(skinned).toBeTruthy();
    expect(animator).toBeTruthy();
    expect(isGuid(skinned.model)).toBe(true);          // model ref is a GUID, not a path
    expect(animator.clip).toBe('Idle');                // FIRST clip auto-bound
    expect(animator.playing).toBe(true);
  });

  it('auto-fits the bind-pose scale (2-unit box → scale 1)', async () => {
    const rootId = await importModel('/games/x/assets/hero.glb', 'hero');
    const tf = traitOf(entityIndex.get(rootId)!, 'Transform');
    expect(tf.sx).toBeCloseTo(1, 5);
    expect(tf.sy).toBeCloseTo(1, 5);
    expect(tf.sz).toBeCloseTo(1, 5);
  });

  it('honors an explicit caller scale over auto-fit', async () => {
    const rootId = await importModel('/games/x/assets/hero.glb', 'hero', 'none', { scale: 0.25 });
    const tf = traitOf(entityIndex.get(rootId)!, 'Transform');
    expect(tf.sx).toBeCloseTo(0.25, 5);
  });

  it('writes the rig sidecar with the clip list and spawns a SkinnedMeshRenderer per node', async () => {
    await importModel('/games/x/assets/hero.glb', 'hero');

    const meta = writtenMeta.find((m) => m.path === '/games/x/assets/hero.glb');
    expect(meta).toBeTruthy();
    expect(meta.meta.rig.clips).toEqual(['Idle', 'Walk']);
    expect(isGuid(meta.meta.id)).toBe(true);

    // One SkinnedMeshRenderer child for the single 'Body' node.
    const renderers = spawned.filter((e) => e._traits.SkinnedMeshRenderer);
    expect(renderers).toHaveLength(1);
    expect(renderers[0]._traits.SkinnedMeshRenderer.node).toBe('Body');
  });

  it('warms the rigged cache with the model GUID', async () => {
    const rootId = await importModel('/games/x/assets/hero.glb', 'hero');
    const guid = traitOf(entityIndex.get(rootId)!, 'SkinnedModel').model;
    expect(ensureRiggedModelLoaded).toHaveBeenCalledWith(guid);
  });

  // ── Per-slot material extraction (Renderable3D convention for skinned meshes) ──

  it('extracts a .mat.json per material slot and wires SkinnedMeshRenderer.materials', async () => {
    await importModel('/games/x/assets/hero.glb', 'hero');

    // A .mat.json was written for the 'BodyMat' slot under the model's materials dir.
    const matWrite = writtenFiles.find((f) => f.path === '/games/x/assets/materials/BodyMat.mat.json');
    expect(matWrite).toBeTruthy();
    const matAsset = JSON.parse(matWrite.content);
    expect(isGuid(matAsset.id)).toBe(true);
    // The extracted .mat.json carries the full MeshStandardMaterial surface, not
    // just base color — emissive + flags are written even when the source is default.
    expect(matAsset.emissive).toBe(0x000000);
    expect(matAsset.emissiveIntensity).toBe(1);
    expect(matAsset).toHaveProperty('flatShading', false);
    expect(matAsset).toHaveProperty('aoMapIntensity', 1);

    // The renderer's `materials` map is keyed by the render-side slot name
    // (`mat.name || mesh.name` = 'BodyMat') and holds the .mat.json GUID — NOT empty.
    const renderer = spawned.find((e) => e._traits.SkinnedMeshRenderer)!;
    const materials = renderer._traits.SkinnedMeshRenderer.materials;
    expect(materials).toEqual({ BodyMat: matAsset.id });
    expect(isGuid(materials.BodyMat)).toBe(true);
  });

  it('records generated materials in the GLB meta for cleanup/prune', async () => {
    await importModel('/games/x/assets/hero.glb', 'hero');
    const meta = writtenMeta.find((m) => m.path === '/games/x/assets/hero.glb');
    expect(meta.meta.generated.materials).toContain('/games/x/assets/materials/BodyMat.mat.json');
  });

  it('preserves the .mat.json stable id across re-import', async () => {
    // First import mints an id; capture it.
    await importModel('/games/x/assets/hero.glb', 'hero');
    const matPath = '/games/x/assets/materials/BodyMat.mat.json';
    const firstId = JSON.parse(writtenFiles.find((f) => f.path === matPath).content).id;

    // Re-import: simulate the .mat.json already on disk carrying `firstId` so
    // readExistingId / readExistingMaterial reuse it instead of minting fresh.
    writtenFiles = []; writtenMeta = [];
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (url.startsWith('/api/read-meta')) return { ok: false } as any;
      if (url === '/api/write-meta') { writtenMeta.push(JSON.parse(opts.body)); return { ok: true } as any; }
      if (url === '/api/write-file') { writtenFiles.push(JSON.parse(opts.body)); return { ok: true } as any; }
      if (url === matPath) return { ok: true, json: async () => ({ id: firstId }) } as any;
      return { ok: true, json: async () => ({}) } as any;
    });

    await importModel('/games/x/assets/hero.glb', 'hero');
    const secondId = JSON.parse(writtenFiles.find((f) => f.path === matPath).content).id;
    expect(secondId).toBe(firstId);
  });
});
