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

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  setStructureCallback: vi.fn(),
  registerEntity: (entity: any) => { entityIndex.set(entity.id(), entity); return entity; },
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); entityIndex.set(e.id(), e); return e; },
  unregisterEntity: (entity: any) => { entityIndex.delete(entity.id()); },
  destroyEntity: (e: any) => { ((entity: any) => { entityIndex.delete(entity.id()); })(e); e.destroy(); },
  onWorldSwap: vi.fn(() => () => {}),
}));

// ── Virtual filesystem ──
// path → file content (the JSON string written via /api/write-file or the
// material/mesh JSON body). Meta sidecars live in a separate map keyed by the
// owning asset path (read via /api/read-meta?path=...).
let vfsFiles: Map<string, string>;
let vfsMeta: Map<string, any>;
let deletedPaths: string[];
/** Asset paths whose `/api/read-meta` GET should FAIL (a 500) rather than answer — the dev-server
 *  blip a test cannot otherwise reach. Distinct from "no sidecar", which is a 200 with `{}`. */
let metaReadFails: Set<string>;

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
    // ⚠️ **A MISSING SIDECAR IS A 200 WITH `{}`, NOT A 404** — this fake used to answer 404 for
    // both, and that is not what the route does. `editorBackendRouter.ts`'s `/api/read-meta` 404s
    // only when the ASSET FILE is absent; when the asset exists and merely has no sidecar it
    // returns `readMetaSidecar`'s `{}` at 200. The divergence was invisible while a non-ok read
    // collapsed to `{}` anyway — both paths produced the same empty document. It stopped being
    // invisible in #880, where a non-ok read produces a TAGGED document that aborts the import,
    // so a fake that 404s every first import would have made this suite assert that importing a
    // new model is impossible. Fixed here rather than worked around: a fake modelling behaviour
    // the real dependency does not have makes every test written against it a claim about
    // nothing.
    // ⚠️ Scope: this fake models 200-with-a-body, 200-with-`{}` and (via `metaReadFails`) a 500.
    // It does NOT reproduce the route's 404 (asset gone), 403 (outside root) or 400 (no path).
    // Nothing is untested because of that — all of them are non-ok, so they reach the same tagged
    // fallback the 500 does — but do not read this fake as saying `/api/read-meta` never 404s.
    if (metaReadFails.has(path)) return { ok: false, status: 500, async json() { return {}; } };
    const meta = vfsMeta.get(path);
    return { ok: true, status: 200, async json() { return meta ?? {}; } };
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
  return {
    Transform: mk('Transform'), EntityAttributes: mk('EntityAttributes'), ModelSource: mk('ModelSource'),
    // #784 phase C2b: modelImport.ts stamps these onto every mesh/material asset it writes. A
    // mocked module with no export would silently hand back `undefined`, which JSON.stringify
    // then drops — masking the constant entirely rather than exercising it.
    MESH_FORMAT_VERSION: 1, MATERIAL_FORMAT_VERSION: 1,
  };
});

beforeEach(() => {
  vfsFiles = new Map();
  vfsMeta = new Map();
  deletedPaths = [];
  metaReadFails = new Set();
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

describe('format-version REFUSAL on re-import (#784 phase C2b, items 3+4)', () => {
  it('a too-new .mesh.json is NOT overwritten — the import aborts instead of minting a fresh guid', async () => {
    const { importModel } = await getModule();

    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    const meshFile = [...vfsFiles.keys()].find((p) => p.endsWith('.mesh.json'))!;
    const before = vfsFiles.get(meshFile)!;
    const beforeParsed = JSON.parse(before);

    // A future build wrote this file with a format version this build does not understand.
    const tooNew = { ...beforeParsed, version: (beforeParsed.version ?? 1) + 1 };
    vfsFiles.set(meshFile, JSON.stringify(tooNew, null, 2));

    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    const result = await importModel(GLB, 'level');

    // The falsy/aborted return every caller already checks (`if (!rootId) return;`).
    expect(result).toBe(0);
    // The bytes on disk are UNCHANGED — item 4's REFUSE, not merely "the call failed".
    expect(vfsFiles.get(meshFile)).toBe(JSON.stringify(tooNew, null, 2));
  });

  it('an UNREADABLE .mesh.json (conflict markers) does NOT mint a fresh guid — the mesh dies with its scene/prefab refs intact', async () => {
    // This is item 3's regression guard and the most important test in this phase: before the
    // fix, ANY read failure (missing file, corrupt bytes, too-new) collapsed to "absent", so a
    // conflict-markered `.mesh.json` was treated as a brand-new asset and got a FRESH guid —
    // dangling every scene/prefab that referenced the old one, even though the file (and its
    // real id) was still sitting right there on disk.
    const { importModel } = await getModule();

    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    const meshFile = [...vfsFiles.keys()].find((p) => p.endsWith('.mesh.json'))!;
    const meshId1 = JSON.parse(vfsFiles.get(meshFile)!).id as string;

    // Simulate a merge conflict landing on disk — unparsable JSON.
    const corrupt = '<<<<<<< HEAD\n{"id":"' + meshId1 + '"}\n=======\n{"id":"' + meshId1 + '","x":1}\n>>>>>>> branch\n';
    vfsFiles.set(meshFile, corrupt);

    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    const result = await importModel(GLB, 'level');

    expect(result).toBe(0); // aborted, not a fresh entity tree
    expect(vfsFiles.get(meshFile)).toBe(corrupt); // bytes untouched — no fresh guid was minted over them
  });

  /** #880 close-out review, finding 2 — THE THIRD DOOR, and the sharpest shape of this defect.
   *
   *  `pendingMeta`'s two refusals (`parkMetaEdit`, `writeMetaWholesale`) cover the PANELS. This
   *  file POSTs `/api/write-meta` directly at three sites and routes through neither — and its
   *  hazard is not the id-less write those guards refuse. This read exists precisely to PRESERVE
   *  the guid (`existingGlbMeta.id ?? newGuid()`), so a failed read does not write a document with
   *  no `id`: it writes one with a **DIFFERENT** id. Every scene/prefab ref to the model dangles,
   *  and the scanner's heal pass never even flags it, because the sidecar it finds looks complete.
   *
   *  The tag was already on that document and nothing read it — this file's own dominant defect
   *  class, a producer whose consumer was never wired. `readMeta` now consumes it and joins the
   *  `ImportWriteAborted` policy this file already applied to every OTHER document it reads. */
  it('a FAILED sidecar read aborts the re-import — it does not mint a fresh guid over the old one', async () => {
    const { importModel } = await getModule();

    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    const guidBefore = vfsMeta.get(GLB)?.id as string;
    expect(guidBefore, 'positive control: the first import established a guid').toBeTruthy();
    const metaBefore = JSON.stringify(vfsMeta.get(GLB));

    // The dev server blips on THIS path's sidecar read. Everything else still answers.
    metaReadFails.add(GLB);
    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    const result = await importModel(GLB, 'level');

    expect(result, 'the falsy return every caller checks').toBe(0);
    expect(
      JSON.stringify(vfsMeta.get(GLB)),
      'the sidecar is UNTOUCHED — a re-import that cannot read the guid must not replace it',
    ).toBe(metaBefore);
    expect(vfsMeta.get(GLB)?.id, 'and the guid is the SAME one, not a fresh mint').toBe(guidBefore);
  });

  /** ⚠️ THE ACCEPT SIDE, and the one that decides whether the abort above is usable at all: a
   *  first import has NO sidecar to preserve a guid from, and the route answers that with a 200
   *  and `{}` (only a missing ASSET 404s — see the fake's own note). If the abort fired on that,
   *  importing any new model would be impossible, and every "does it refuse?" test above would
   *  still pass. */
  it('...but an ABSENT sidecar is not a failed read — a first import still mints and writes', async () => {
    const { importModel } = await getModule();

    addTemplate('wall', mat('brick'));
    expect(vfsMeta.has(GLB), 'precondition: nothing has written this sidecar yet').toBe(false);

    const result = await importModel(GLB, 'level');

    expect(result, 'a first import must still succeed').not.toBe(0);
    expect(vfsMeta.get(GLB)?.id, 'and it minted a guid into the sidecar').toBeTruthy();
  });

  it('a too-new .mat.json is NOT overwritten either — same REFUSE, on the material path', async () => {
    const { importModel } = await getModule();

    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    const matFile = [...vfsFiles.keys()].find((p) => p.endsWith('.mat.json'))!;
    const beforeParsed = JSON.parse(vfsFiles.get(matFile)!);
    const tooNew = { ...beforeParsed, version: (beforeParsed.version ?? 1) + 1 };
    vfsFiles.set(matFile, JSON.stringify(tooNew, null, 2));

    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    const result = await importModel(GLB, 'level');

    expect(result).toBe(0);
    expect(vfsFiles.get(matFile)).toBe(JSON.stringify(tooNew, null, 2));
  });

  // #784 phase C adversarial review, finding 4. Before this fix, `importModel`'s abort boundary
  // hard-coded the toast text to "a file could not be written" — true for the ORIGINAL #311
  // write-failure case, but false since phase C2b started throwing `ImportWriteAborted` for a
  // READ-side refusal too (this exact too-new-mesh case never reaches a write at all). The
  // console.error one line above already used the real `e.message`; the toast now must too.
  it('the abort toast carries the REAL reason, not the hard-coded "could not be written"', async () => {
    const { importModel } = await getModule();
    const { useEditorStore } = await import('../../src/editor/store/editorStore');

    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');
    const meshFile = [...vfsFiles.keys()].find((p) => p.endsWith('.mesh.json'))!;
    const beforeParsed = JSON.parse(vfsFiles.get(meshFile)!);
    const tooNew = { ...beforeParsed, version: (beforeParsed.version ?? 1) + 1 };
    vfsFiles.set(meshFile, JSON.stringify(tooNew, null, 2));

    clearManifest();
    mockTemplates = new Map();
    addTemplate('wall', mat('brick'));
    await importModel(GLB, 'level');

    const toast = useEditorStore.getState().toast;
    expect(toast?.message).toMatch(/newer than this engine|refusing to read/i);
    expect(toast?.message).not.toMatch(/a file could not be written/i);
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
