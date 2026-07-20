/** modelImport re-import tests — orphan prune (Missing-Test #6) + re-import id
 *  stability (Missing-Test #7).
 *
 *  Unlike modelImport.test.ts (which mocks fetch with a write-only stub and never
 *  reads anything back), these tests back the import pipeline with a small VIRTUAL
 *  FILESYSTEM so a SECOND import sees the first import's `.meta.json` (with its
 *  `generated` block + stable `id`) and its `.mesh.json` / `.mat.json` files on
 *  disk. That's the only way to exercise:
 *    - the orphan-prune branch (needs a prior `generated` list to diff against), and
 *    - the readExistingId / readMeta re-import-stability paths (need the prior
 *      `id`s to be readable).
 *  Delete-asset calls are captured so the prune assertions can inspect them. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { isGuid, clearManifest } from '../../src/runtime/loaders/assetManifest';

// ── Mocks ──

// Static branch: an empty, non-skinned GLTF scene routes through the flatten path.
vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    async loadAsync() { return { scene: new THREE.Group(), animations: [] }; }
  },
}));

let testWorld: any;
const entityIndex = new Map<number, any>();
let nextEntityId = 1;

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  setStructureCallback: vi.fn(),
  registerEntity: (entity: any) => { entityIndex.set(entity.id(), entity); return entity; },
  unregisterEntity: (entity: any) => { entityIndex.delete(entity.id()); },
  onWorldSwap: vi.fn(() => () => {}),
}));

// ── Virtual filesystem ──
// path → file content (the JSON string written via /api/write-file or the
// material/mesh JSON body). Meta sidecars live in a separate map keyed by the
// owning asset path (read via /api/read-meta?path=...).
let vfsFiles: Map<string, string>;
let vfsMeta: Map<string, any>;
let deletedPaths: string[];

function url(u: string | URL): string {
  return typeof u === 'string' ? u : u.toString();
}

const mockFetch = vi.fn(async (u: string | URL, opts?: any) => {
  const target = url(u);

  if (target === '/api/write-file') {
    const body = JSON.parse(opts.body);
    vfsFiles.set(body.path, body.content);
    return { ok: true, status: 200, async json() { return {}; } };
  }
  if (target === '/api/write-meta') {
    const body = JSON.parse(opts.body);
    vfsMeta.set(body.path, body.meta);
    return { ok: true, status: 200, async json() { return {}; } };
  }
  if (target.startsWith('/api/read-meta')) {
    const q = target.slice(target.indexOf('?') + 1);
    const params = new URLSearchParams(q);
    const path = params.get('path') ?? '';
    const meta = vfsMeta.get(path);
    return meta
      ? { ok: true, status: 200, async json() { return meta; } }
      : { ok: false, status: 404, async json() { return {}; } };
  }
  if (target === '/api/delete-asset') {
    const body = JSON.parse(opts.body);
    deletedPaths.push(body.path);
    return { ok: true, status: 200, async json() { return {}; } };
  }
  if (target === '/api/reimport') {
    return { ok: true, status: 200, async json() { return { errors: [] }; } };
  }
  // Raw GET of an asset file (readExistingId / readExistingMaterial fetch the
  // path directly, not through /api). Serve from the vfs if present.
  if (vfsFiles.has(target)) {
    const content = vfsFiles.get(target)!;
    return { ok: true, status: 200, async json() { return JSON.parse(content); }, async text() { return content; } };
  }
  return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
});
vi.stubGlobal('fetch', mockFetch);

// Mock template cache
let mockTemplates = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>();
vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn(async () => {}),
  getTemplatesForModel: vi.fn(() => mockTemplates),
  invalidateModel: vi.fn(),
  invalidateMaterial: vi.fn(),
}));

vi.mock('../../src/runtime/loaders/textureResolver', () => ({
  invalidateTexture: vi.fn(),
}));

// loadGLB — returns a map of entityId → meshName (empty is fine for these tests).
vi.mock('../../src/runtime/loaders/loadGLB', () => ({
  loadGLB: vi.fn(async () => new Map<number, string>()),
}));

let mockPostprocessor: any = {};
vi.mock('../../src/runtime/loaders/modelPostprocessorRegistry', () => ({
  getModelPostprocessor: vi.fn(() => mockPostprocessor),
}));

vi.mock('../../src/runtime/traits', () => {
  const mk = (name: string) => { const f = (d?: any) => ({ _trait: name, ...d }); (f as any)._name = name; return f; };
  return { Transform: mk('Transform'), EntityAttributes: mk('EntityAttributes'), ModelSource: mk('ModelSource') };
});

beforeEach(() => {
  vfsFiles = new Map();
  vfsMeta = new Map();
  deletedPaths = [];
  mockTemplates = new Map();
  mockPostprocessor = {};
  entityIndex.clear();
  nextEntityId = 1;
  clearManifest();

  testWorld = {
    spawn: vi.fn((..._traits: any[]) => {
      const id = nextEntityId++;
      const entity = { id: () => id, has: () => false };
      entityIndex.set(id, entity);
      return entity;
    }),
    query: vi.fn(() => ({ updateEach: vi.fn() })),
  };
});

function mat(name: string, color = 0x808080): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial();
  m.name = name;
  m.color.setHex(color);
  return m;
}

function addTemplate(meshName: string, material: THREE.Material) {
  mockTemplates.set(meshName, { geometry: new THREE.BufferGeometry(), material, name: meshName });
}

async function getModule() {
  return import('../../src/editor/scene/modelImport');
}

const GLB = '/assets/models/level.glb';

describe('re-import id stability (Missing-Test #7)', () => {
  it('preserves the GLB / mesh / material guids across a re-import', async () => {
    const { importModel } = await getModule();

    // First import.
    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');

    const glbId1 = vfsMeta.get(GLB)?.id as string;
    const meshFile1 = [...vfsFiles.keys()].find((p) => p.endsWith('.mesh.json'))!;
    const matFile1 = [...vfsFiles.keys()].find((p) => p.endsWith('.mat.json'))!;
    const meshId1 = JSON.parse(vfsFiles.get(meshFile1)!).id as string;
    const matId1 = JSON.parse(vfsFiles.get(matFile1)!).id as string;
    expect(isGuid(glbId1)).toBe(true);
    expect(isGuid(meshId1)).toBe(true);
    expect(isGuid(matId1)).toBe(true);

    // Second import — fresh manifest (simulating a new editor session that
    // discovers ids only from disk), same template shape on disk.
    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');

    const glbId2 = vfsMeta.get(GLB)?.id as string;
    const meshId2 = JSON.parse(vfsFiles.get(meshFile1)!).id as string;
    const matId2 = JSON.parse(vfsFiles.get(matFile1)!).id as string;

    // Every guid is the one read back from the prior on-disk sidecar/file —
    // a fresh guid would dangle every external scene/prefab ref.
    expect(glbId2).toBe(glbId1);
    expect(meshId2).toBe(meshId1);
    expect(matId2).toBe(matId1);
  });
});

describe('manual material edits survive re-import (texture-loss regression)', () => {
  it('preserves a hand-assigned texture + custom fields when the source carries no map', async () => {
    const { importModel } = await getModule();

    // First import writes a plain material (the source GLB has no base-color map).
    addTemplate('planet', mat('planet'));
    await importModel(GLB, 'level');

    const matFile = [...vfsFiles.keys()].find((p) => p.endsWith('.mat.json'))!;
    // The user then hand-authors it into a custom shader material with a texture the
    // DAE/GLB source can't reproduce (exactly the Mars-planet case): a custom shader,
    // an assigned texture guid, and an NPR field.
    const authored = {
      ...JSON.parse(vfsFiles.get(matFile)!),
      type: 'custom',
      shader: 'space-console/planet',
      texture: '68bb7cfc-fa2f-46cb-a2d6-32960105fb6a',
      nprColorPreserve: 0.1,
    };
    vfsFiles.set(matFile, JSON.stringify(authored, null, 2));

    // Re-import — same template, the material STILL carries no base map. The
    // extractor assigns `texture: undefined`; the merge must treat that as ABSENT
    // and restore the hand-assigned value (the bug left `texture` undefined, which
    // JSON.stringify then dropped — losing the texture entirely).
    clearManifest();
    mockTemplates = new Map();
    addTemplate('planet', mat('planet'));
    await importModel(GLB, 'level');

    const after = JSON.parse(vfsFiles.get(matFile)!);
    expect(after.texture).toBe('68bb7cfc-fa2f-46cb-a2d6-32960105fb6a'); // survived
    expect(after.type).toBe('custom');
    expect(after.shader).toBe('space-console/planet');
    expect(after.nprColorPreserve).toBe(0.1);
  });
});

describe('orphan prune (Missing-Test #6)', () => {
  it('trashes a mesh + material the new import no longer generates', async () => {
    const { importModel } = await getModule();

    // First import: two meshes (each its own distinct material).
    addTemplate('wall', mat('brick', 0x884422));
    addTemplate('door', mat('wood', 0x223344));
    await importModel(GLB, 'level');

    const meshFilesBefore = [...vfsFiles.keys()].filter((p) => p.endsWith('.mesh.json'));
    const matFilesBefore = [...vfsFiles.keys()].filter((p) => p.endsWith('.mat.json'));
    expect(meshFilesBefore).toHaveLength(2);
    expect(matFilesBefore).toHaveLength(2);
    const doorMesh = meshFilesBefore.find((p) => p.includes('door'))!;
    const woodMat = matFilesBefore.find((p) => p.includes('wood'))!;

    // Second import: the "door" mesh is gone (and with it its wood material).
    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick', 0x884422));
    deletedPaths.length = 0;
    await importModel(GLB, 'level');

    // The orphaned mesh + material were sent to /api/delete-asset.
    expect(deletedPaths).toContain(doorMesh);
    expect(deletedPaths).toContain(woodMat);
    // The surviving wall mesh/material were NOT deleted.
    expect(deletedPaths.some((p) => p.includes('wall'))).toBe(false);
    expect(deletedPaths.some((p) => p.includes('brick'))).toBe(false);
  });

  it('does NOT prune on a first import (no prior generated block)', async () => {
    const { importModel } = await getModule();
    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    expect(deletedPaths).toHaveLength(0);
  });

  it('the ownsPath guard refuses to prune a file outside the model dir', async () => {
    const { importModel } = await getModule();

    // First import writes its own generated files...
    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');

    // ...then we poison the on-disk meta's `generated` list with a foreign path
    // (a shared/hand-authored asset that lives OUTSIDE the model's own sub-tree —
    // e.g. left there by bad data from a long-gone import). On re-import it would
    // be an "orphan" by the set-diff, but ownsPath must keep the prune from
    // deleting a file in an unrelated tree.
    const foreign = '/assets/shared/foreign.mat.json';
    const meta = vfsMeta.get(GLB)!;
    meta.generated = { ...meta.generated, materials: [...meta.generated.materials, foreign] };
    vfsMeta.set(GLB, meta);

    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    deletedPaths.length = 0;
    await importModel(GLB, 'level');

    // The foreign material lives outside /assets/models/ → never trashed.
    expect(deletedPaths).not.toContain(foreign);
  });
});
