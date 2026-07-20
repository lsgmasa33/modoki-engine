/** modelImport unit tests — material hashing, deduplication, mesh/material extraction.
 *  Tests the pure functions and import pipeline logic with mocked GLB loader and filesystem. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { isGuid, resolveGuidToPath, clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';

// ── Mocks ──

// importModel now inspects the converted GLB (inspectGLBRig) to route rigged vs
// static models. Mock GLTFLoader to return an empty, non-skinned scene so these
// flatten-path tests take the static branch without a real GLB fetch.
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

function createMockEntity(id: number, traits: Record<string, any> = {}) {
  const entity = {
    id: () => id,
    has: () => false,
    ...traits,
  };
  entityIndex.set(id, entity);
  return entity;
}

vi.mock('../../src/runtime/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  setStructureCallback: vi.fn(),
  registerEntity: (entity: any) => { entityIndex.set(entity.id(), entity); return entity; },
  unregisterEntity: (entity: any) => { entityIndex.delete(entity.id()); },
  onWorldSwap: vi.fn(() => () => {}),
}));

// Track files written via writeAssetFile (uses fetch /api/write-file)
let writtenFiles: { path: string; content: string }[] = [];
let writtenMeta: { path: string; meta: any } | null = null;

// Mock fetch for file writes and meta writes
const mockFetch = vi.fn(async (url: string, opts?: any) => {
  if (url === '/api/write-file') {
    const body = JSON.parse(opts.body);
    writtenFiles.push({ path: body.path, content: body.content });
    return { ok: true };
  }
  if (url === '/api/write-meta') {
    const body = JSON.parse(opts.body);
    writtenMeta = { path: body.path, meta: body.meta };
    return { ok: true };
  }
  return { ok: false };
});
vi.stubGlobal('fetch', mockFetch);

// Mock template cache
let mockTemplates = new Map<string, { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }>();

const invalidateMaterialMock = vi.fn();
const invalidateTextureMock = vi.fn();

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn(async () => {}),
  getTemplatesForModel: vi.fn(() => mockTemplates),
  invalidateModel: vi.fn(),
  invalidateMaterial: (...args: unknown[]) => invalidateMaterialMock(...args),
}));

vi.mock('../../src/runtime/loaders/textureResolver', () => ({
  invalidateTexture: (...args: unknown[]) => invalidateTextureMock(...args),
}));

// Mock loadGLB — returns a map of entityId → meshName
let loadGLBResult = new Map<number, string>();
vi.mock('../../src/runtime/loaders/loadGLB', () => ({
  loadGLB: vi.fn(async () => loadGLBResult),
}));

// Mock model postprocessor registry
let mockPostprocessor: any = {};
vi.mock('../../src/runtime/loaders/modelPostprocessorRegistry', () => ({
  getModelPostprocessor: vi.fn(() => mockPostprocessor),
}));

// Mock traits — need spawn to work
vi.mock('../../src/runtime/traits', () => {
  const transformFn = (data?: any) => ({ _trait: 'Transform', ...data });
  transformFn._name = 'Transform';
  const eaFn = (data?: any) => ({ _trait: 'EntityAttributes', ...data });
  eaFn._name = 'EntityAttributes';
  const msFn = (data?: any) => ({ _trait: 'ModelSource', ...data });
  msFn._name = 'ModelSource';
  return {
    Transform: transformFn,
    EntityAttributes: eaFn,
    ModelSource: msFn,
  };
});

beforeEach(() => {
  writtenFiles = [];
  writtenMeta = null;
  mockTemplates = new Map();
  loadGLBResult = new Map();
  mockPostprocessor = {};
  entityIndex.clear();
  nextEntityId = 1;
  invalidateMaterialMock.mockClear();
  invalidateTextureMock.mockClear();
  clearManifest();

  // Create a mock world with spawn and query
  testWorld = {
    spawn: vi.fn((..._traits: any[]) => {
      const id = nextEntityId++;
      const entity = createMockEntity(id);
      return entity;
    }),
    query: vi.fn(() => ({
      updateEach: vi.fn(),
    })),
  };
});

// Helper: create a mock MeshStandardMaterial
function mockMaterial(opts: {
  name?: string;
  color?: number;
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
  side?: number;
  alphaTest?: number;
  envMapIntensity?: number;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
} = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial();
  if (opts.name !== undefined) mat.name = opts.name;
  if (opts.color !== undefined) mat.color.setHex(opts.color);
  if (opts.roughness !== undefined) mat.roughness = opts.roughness;
  if (opts.metalness !== undefined) mat.metalness = opts.metalness;
  if (opts.transparent !== undefined) mat.transparent = opts.transparent;
  if (opts.opacity !== undefined) mat.opacity = opts.opacity;
  if (opts.side !== undefined) mat.side = opts.side;
  if (opts.alphaTest !== undefined) mat.alphaTest = opts.alphaTest;
  if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity;
  if (opts.map !== undefined) mat.map = opts.map;
  if (opts.normalMap !== undefined) mat.normalMap = opts.normalMap;
  return mat;
}

// Helper: add a template to the mock templates map
function addTemplate(meshName: string, material: THREE.Material) {
  mockTemplates.set(meshName, {
    geometry: new THREE.BufferGeometry(),
    material,
    name: meshName,
  });
}

async function getModule() {
  return import('../../src/editor/scene/modelImport');
}

describe('seedTextureSettings (F6)', () => {
  it('base-color map inherits srgb from the source texture', async () => {
    const { seedTextureSettings } = await getModule();
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    expect(seedTextureSettings(tex, '').colorspace).toBe('srgb');
  });

  it('non-color maps (normal/rough/metal) are forced linear regardless of source colorSpace', async () => {
    const { seedTextureSettings } = await getModule();
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace; // mis-tagged source must NOT leak through
    expect(seedTextureSettings(tex, '_normal').colorspace).toBe('linear');
    expect(seedTextureSettings(tex, '_rough').colorspace).toBe('linear');
    expect(seedTextureSettings(tex, '_metal').colorspace).toBe('linear');
  });

  it('a linear-tagged base map stays linear', async () => {
    const { seedTextureSettings } = await getModule();
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    expect(seedTextureSettings(tex, '').colorspace).toBe('linear');
  });

  it('maps Three wrap constants to the import-settings enum', async () => {
    const { seedTextureSettings } = await getModule();
    const tex = new THREE.Texture();
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.MirroredRepeatWrapping;
    const s = seedTextureSettings(tex, '');
    expect(s.wrapS).toBe('clamp');
    expect(s.wrapT).toBe('mirror');
  });
});

describe('bytesToBase64 (F5 — async texture encode)', () => {
  it('round-trips bytes through base64 (matches btoa for small payloads)', async () => {
    const { bytesToBase64 } = await getModule();
    const bytes = new Uint8Array([0x4d, 0x6f, 0x64, 0x6f, 0x6b, 0x69]); // "Modoki"
    expect(bytesToBase64(bytes)).toBe('TW9kb2tp');
    // decode back to verify byte-equivalence
    const decoded = atob(bytesToBase64(bytes));
    expect(Array.from(decoded, (c) => c.charCodeAt(0))).toEqual(Array.from(bytes));
  });

  it('encodes payloads larger than the 0x8000 chunk without arg-count blowup', async () => {
    const { bytesToBase64 } = await getModule();
    const big = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const b64 = bytesToBase64(big);
    const decoded = atob(b64);
    expect(decoded.length).toBe(big.length);
    for (let i = 0; i < big.length; i++) expect(decoded.charCodeAt(i)).toBe(big[i]);
  });
});

describe('importModel', () => {
  it('creates mesh and material asset files', async () => {
    const { importModel } = await getModule();
    const mat = mockMaterial({ name: 'grass', color: 0x00ff00 });
    addTemplate('ground_mesh', mat);

    await importModel('/assets/models/island.glb', 'island');

    // Should have written a material file and a mesh file
    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    expect(matFile).toBeDefined();
    expect(matFile!.path).toContain('materials/grass.mat.json');

    const meshFile = writtenFiles.find(f => f.path.includes('.mesh.json'));
    expect(meshFile).toBeDefined();
    expect(meshFile!.path).toContain('meshes/ground_mesh.mesh.json');

    // Mesh asset should reference the material + model by guid (resolvable
    // back to their paths via the manifest), not raw paths.
    const meshAsset = JSON.parse(meshFile!.content);
    expect(isGuid(meshAsset.material)).toBe(true);
    expect(resolveGuidToPath(meshAsset.material)).toContain('grass.mat.json');
    expect(isGuid(meshAsset.model)).toBe(true);
    expect(resolveGuidToPath(meshAsset.model)).toBe('/assets/models/island.glb');
    expect(meshAsset.mesh).toBe('ground_mesh');
  });

  it('does not pass the GLB path to resolveRef (no "path reference" error on import)', async () => {
    // Regression: importModel called invalidateRiggedModel(glbPath) with the raw
    // internal PATH, which resolveRef rejects post-GUID-migration — logging
    // "[assetManifest] path reference no longer supported" on EVERY model import.
    // A fresh import has no prior GUID, so the rigged invalidation must be skipped.
    const { importModel } = await getModule();
    addTemplate('hull', mockMaterial({ name: 'hull', color: 0x808080 }));
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try {
      // Unique path so resolveRef's per-path dedupe can't hide a regression.
      await importModel('/assets/models/rigged_regression_guard.glb', 'rg');
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((e) => e.includes('path reference no longer supported'))).toEqual([]);
  });

  it('evicts the runtime material cache for each material it writes', async () => {
    // Re-importing has to invalidate materialCache — otherwise a same-session
    // scene re-open keeps rendering with the pre-import factors / texture,
    // which is the cold-vs-warm asymmetry the Stage A plan flagged.
    const { importModel } = await getModule();
    const mat = mockMaterial({ name: 'grass', color: 0x00ff00 });
    addTemplate('ground_mesh', mat);

    await importModel('/assets/models/island.glb', 'island');

    expect(invalidateMaterialMock).toHaveBeenCalledWith(
      expect.stringContaining('materials/grass.mat.json'),
    );
  });

  it('deduplicates identical materials', async () => {
    const { importModel } = await getModule();
    // Two meshes with same material properties
    const mat1 = mockMaterial({ name: 'stone', color: 0x888888, roughness: 0.9 });
    const mat2 = mockMaterial({ name: 'stone', color: 0x888888, roughness: 0.9 });
    addTemplate('wall_1', mat1);
    addTemplate('wall_2', mat2);

    await importModel('/assets/models/building.glb', 'building');

    // Only one material file should be written (deduped by hash)
    const matFiles = writtenFiles.filter(f => f.path.includes('.mat.json'));
    expect(matFiles).toHaveLength(1);

    // But two mesh files
    const meshFiles = writtenFiles.filter(f => f.path.includes('.mesh.json'));
    expect(meshFiles).toHaveLength(2);
  });

  it('creates separate materials for different properties', async () => {
    const { importModel } = await getModule();
    const mat1 = mockMaterial({ name: 'wood', color: 0x8B4513, roughness: 0.8 });
    const mat2 = mockMaterial({ name: 'metal', color: 0xC0C0C0, metalness: 0.9, roughness: 0.2 });
    addTemplate('floor', mat1);
    addTemplate('railing', mat2);

    await importModel('/assets/models/deck.glb', 'deck');

    const matFiles = writtenFiles.filter(f => f.path.includes('.mat.json'));
    expect(matFiles).toHaveLength(2);
  });

  it('does NOT dedup two materials that share scalars but differ only by texture (F2)', async () => {
    // Regression for the dedup hash-collision: hashMaterial encoded texture
    // PRESENCE (booleans), so two materials with identical color/roughness/etc.
    // but DIFFERENT base maps hashed the same → only the first .mat.json was
    // written and every mesh using the second pointed at the first's texture.
    // jsdom can't extract the maps (bare THREE.Texture has no `.image`), so the
    // hash falls back to texture uuid — distinct instances must still split.
    const { importModel } = await getModule();
    const texA = new THREE.Texture();
    const texB = new THREE.Texture();
    const mat1 = mockMaterial({ name: 'variantA', color: 0x888888, roughness: 0.5, map: texA });
    const mat2 = mockMaterial({ name: 'variantB', color: 0x888888, roughness: 0.5, map: texB });
    addTemplate('panel_1', mat1);
    addTemplate('panel_2', mat2);

    await importModel('/assets/models/variants.glb', 'variants');

    // Two distinct material files, and the two meshes reference distinct materials.
    const matFiles = writtenFiles.filter(f => f.path.includes('.mat.json'));
    expect(matFiles).toHaveLength(2);
    const meshFiles = writtenFiles.filter(f => f.path.includes('.mesh.json'));
    const matRefs = meshFiles.map(f => JSON.parse(f.content).material);
    expect(new Set(matRefs).size).toBe(2);
  });

  it('still dedups two materials with identical scalars AND the same texture instance', async () => {
    // The flip side of F2 — texture identity must collapse, not just split.
    // A single THREE.Texture instance shared by two materials (the GLTFLoader
    // norm) keeps them deduped to one file.
    const { importModel } = await getModule();
    const shared = new THREE.Texture();
    const mat1 = mockMaterial({ name: 'shared', color: 0x444444, roughness: 0.7, map: shared });
    const mat2 = mockMaterial({ name: 'shared', color: 0x444444, roughness: 0.7, map: shared });
    addTemplate('a', mat1);
    addTemplate('b', mat2);

    await importModel('/assets/models/shared.glb', 'shared');

    const matFiles = writtenFiles.filter(f => f.path.includes('.mat.json'));
    expect(matFiles).toHaveLength(1);
  });

  it('excludes meshes specified in importOptions', async () => {
    const { importModel } = await getModule();
    addTemplate('visible_mesh', mockMaterial({ name: 'mat_a' }));
    addTemplate('ground_plane', mockMaterial({ name: 'mat_b' }));

    await importModel('/assets/models/scene.glb', 'scene', 'default', undefined, {
      excludeMeshes: ['ground_plane'],
    });

    const meshFiles = writtenFiles.filter(f => f.path.includes('.mesh.json'));
    expect(meshFiles).toHaveLength(1);
    expect(meshFiles[0].path).toContain('visible_mesh');
  });

  it('merges postprocessor-resolved excludes with explicit excludes', async () => {
    const { importModel } = await getModule();
    mockPostprocessor = {
      resolveImportOptions: vi.fn(() => ({
        excludeMeshes: ['auto_excluded'],
      })),
    };

    addTemplate('keep_me', mockMaterial({ name: 'mat_keep' }));
    addTemplate('auto_excluded', mockMaterial({ name: 'mat_auto' }));
    addTemplate('manual_excluded', mockMaterial({ name: 'mat_manual' }));

    await importModel('/assets/models/test.glb', 'test', 'custom', undefined, {
      excludeMeshes: ['manual_excluded'],
    });

    const meshFiles = writtenFiles.filter(f => f.path.includes('.mesh.json'));
    expect(meshFiles).toHaveLength(1);
    expect(meshFiles[0].path).toContain('keep_me');
  });

  it('applies material overrides from importOptions as a GUID (never a path)', async () => {
    const { importModel } = await getModule();
    addTemplate('tree_trunk', mockMaterial({ name: 'bark' }));

    const overridePath = '/assets/models/forest/materials/custom_bark.mat.json';
    const overrideGuid = 'e2000000-0000-4000-8000-000000000001';
    // Override material already registered (the realistic case).
    registerAsset(overrideGuid, overridePath, 'material');

    await importModel('/assets/models/forest/model.glb', 'forest', 'none', undefined, {
      materialOverrides: { tree_trunk: overridePath },
    });

    // Mesh must reference the override material by GUID — never the literal path
    // (the runtime resolver rejects internal asset paths).
    const meshFile = writtenFiles.find(f => f.path.includes('.mesh.json'));
    const meshAsset = JSON.parse(meshFile!.content);
    expect(meshAsset.material).toBe(overrideGuid);
    expect(isGuid(meshAsset.material)).toBe(true);
  });

  it('mints+registers a GUID for an unregistered material override (never stores a path)', async () => {
    const { importModel } = await getModule();
    addTemplate('tree_trunk', mockMaterial({ name: 'bark' }));

    // Not registered and the file write mock makes the GET 404 → resolveMaterialGuid
    // mints a GUID rather than falling back to the path.
    const overridePath = '/assets/models/forest/materials/unregistered_bark.mat.json';
    await importModel('/assets/models/forest/model.glb', 'forest', 'none', undefined, {
      materialOverrides: { tree_trunk: overridePath },
    });

    const meshFile = writtenFiles.find(f => f.path.includes('.mesh.json'));
    const meshAsset = JSON.parse(meshFile!.content);
    expect(isGuid(meshAsset.material)).toBe(true);
    expect(meshAsset.material).not.toBe(overridePath);
  });

  it('does not overwrite protected material paths', async () => {
    const { importModel } = await getModule();
    // Postprocessor provides a material override pointing to a specific path
    const protectedPath = '/assets/models/test/materials/bark.mat.json';
    mockPostprocessor = {
      resolveImportOptions: vi.fn(() => ({
        materialOverrides: { mesh_a: protectedPath },
      })),
    };

    // mesh_a uses the override, mesh_b has a material that would dedup to the same name
    const matA = mockMaterial({ name: 'bark', color: 0x654321 });
    const matB = mockMaterial({ name: 'bark', color: 0x654321 });
    addTemplate('mesh_a', matA);
    addTemplate('mesh_b', matB);

    await importModel('/assets/models/test/model.glb', 'test');

    // The protected material file should not have been written
    const matWrites = writtenFiles.filter(f => f.path === protectedPath);
    expect(matWrites).toHaveLength(0);
  });

  it('writes model meta with generated file lists', async () => {
    const { importModel } = await getModule();
    addTemplate('mesh_a', mockMaterial({ name: 'mat_a' }));
    addTemplate('mesh_b', mockMaterial({ name: 'mat_b', color: 0xff0000 }));

    await importModel('/assets/models/scene.glb', 'scene');

    expect(writtenMeta).not.toBeNull();
    expect(writtenMeta!.path).toBe('/assets/models/scene.glb');
    expect(writtenMeta!.meta.version).toBe(2);
    expect(writtenMeta!.meta.generated.meshes).toHaveLength(2);
    expect(writtenMeta!.meta.generated.materials.length).toBeGreaterThanOrEqual(1);
  });

  it('spawns a root entity with ModelSource', async () => {
    const { importModel } = await getModule();
    addTemplate('mesh_a', mockMaterial({ name: 'mat_a' }));

    const rootId = await importModel('/assets/models/island.glb', 'island', 'island-loader');

    expect(rootId).toBeGreaterThan(0);
    expect(testWorld.spawn).toHaveBeenCalled();
  });

  it('sanitizes special characters in mesh filenames', async () => {
    const { importModel } = await getModule();
    addTemplate('mesh/with:special*chars', mockMaterial({ name: 'clean_mat' }));

    await importModel('/assets/models/test.glb', 'test');

    const meshFile = writtenFiles.find(f => f.path.includes('.mesh.json'));
    expect(meshFile).toBeDefined();
    // The filename portion should not contain special chars
    const filename = meshFile!.path.split('/').pop()!;
    expect(filename).not.toMatch(/[\\:*?"<>|]/);
    // But the mesh name inside the asset should be the original
    const meshAsset = JSON.parse(meshFile!.content);
    expect(meshAsset.mesh).toBe('mesh/with:special*chars');
  });

  it('handles empty template map gracefully', async () => {
    const { importModel } = await getModule();
    // No templates added — empty model

    const rootId = await importModel('/assets/models/empty.glb', 'empty');

    expect(rootId).toBeGreaterThan(0);
    // No mesh or material files written
    const meshFiles = writtenFiles.filter(f => f.path.includes('.mesh.json'));
    const matFiles = writtenFiles.filter(f => f.path.includes('.mat.json'));
    expect(meshFiles).toHaveLength(0);
    expect(matFiles).toHaveLength(0);
  });

  it('uses material name for filename when available', async () => {
    const { importModel } = await getModule();
    addTemplate('wall', mockMaterial({ name: 'Brick_Wall_01' }));

    await importModel('/assets/models/house.glb', 'house');

    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    expect(matFile!.path).toContain('Brick_Wall_01.mat.json');
  });

  it('derives material filename from color when no name', async () => {
    const { importModel } = await getModule();
    const mat = mockMaterial({ color: 0xff0000 });
    mat.name = ''; // Clear name
    addTemplate('cube', mat);

    await importModel('/assets/models/cube.glb', 'cube');

    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    expect(matFile!.path).toContain('mat_ff0000.mat.json');
  });

  it('appends _trans suffix for transparent unnamed materials', async () => {
    const { importModel } = await getModule();
    const mat = mockMaterial({ color: 0x00ff00, transparent: true });
    mat.name = '';
    addTemplate('glass', mat);

    await importModel('/assets/models/window.glb', 'window');

    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    expect(matFile!.path).toContain('_trans');
  });

  it('appends _dbl suffix for double-sided unnamed materials', async () => {
    const { importModel } = await getModule();
    const mat = mockMaterial({ color: 0x0000ff, side: THREE.DoubleSide });
    mat.name = '';
    addTemplate('leaf', mat);

    await importModel('/assets/models/tree.glb', 'tree');

    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    expect(matFile!.path).toContain('_dbl');
  });

  it('extracts material asset with correct properties', async () => {
    const { importModel } = await getModule();
    const mat = mockMaterial({
      name: 'test_mat',
      color: 0xff8800,
      roughness: 0.6,
      metalness: 0.3,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      alphaTest: 0.5,
      envMapIntensity: 1.2,
    });
    addTemplate('mesh_a', mat);

    await importModel('/assets/models/test.glb', 'test');

    const matFile = writtenFiles.find(f => f.path.includes('.mat.json'));
    const matAsset = JSON.parse(matFile!.content);
    expect(matAsset.version).toBe(1);
    expect(matAsset.color).toBe(0xff8800);
    expect(matAsset.roughness).toBe(0.6);
    expect(matAsset.metalness).toBe(0.3);
    expect(matAsset.transparent).toBe(true);
    expect(matAsset.opacity).toBe(0.8);
    expect(matAsset.side).toBe('double');
    expect(matAsset.alphaTest).toBe(0.5);
    expect(matAsset.envMapIntensity).toBe(1.2);
  });
});
