/** #1380 — a `.mesh.json` edited with its GLB untouched reached no invalidator: `meshAssetCache`
 *  was evicted only through the model (`invalidateModel`) and at scene-swap release, so the old
 *  `model`/`mesh` binding kept resolving until the next swap.
 *
 *  `invalidateMeshAsset` re-reads the file STALE-WHILE-REVALIDATE (close-out review): the old entry
 *  keeps serving until the new one is in, a byte-identical write announces nothing, and a failed
 *  re-read keeps the old entry — an eager evict left a Play-mode mesh collider with no geometry for
 *  the refetch's duration, on every write. The renderer half — tearing the entity's object down on
 *  the `'mesh'` event — is `scene3DSyncMeshAssetEdit.test.ts`. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

/** A GLB load the test can hold open — the revalidate awaits the NEW model's templates before it
 *  swaps, and a teardown landing inside that await is what the post-load liveness check refuses. */
const glb = vi.hoisted(() => ({ gate: null as null | Promise<void> }));
vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder(_d: unknown) {}
    load(_p: string, onLoad: (g: unknown) => void) {
      const scene = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      mesh.name = 'Body';
      scene.add(mesh);
      void (glb.gate ?? Promise.resolve()).then(() => onLoad({ scene }));
    }
  },
}));
import { completeResponse } from '../stubs/assetResponse';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { onAssetInvalidated } from '../../src/runtime/core/assetInvalidation';
import {
  resolveMeshTemplate, getMeshAsset, invalidateMeshAsset, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';

const flush = () => new Promise((r) => setTimeout(r, 0));

const MESH_GUID = '33333333-4444-4555-8666-cccccccccccc';
const MESH_PATH = '/games/g/assets/models/meshes/cube.mesh.json';

/** A `.mesh.json` body. `model` is left empty so the fetch caches the definition without loading
 *  a GLB — the binding under test is the definition itself, not the model load behind it. */
const meshDoc = (mesh: string) => ({ id: MESH_GUID, version: 1, model: '', mesh, postprocessor: 'none' });
const ok = (mesh: string) => async () => completeResponse({ ok: true, json: async () => meshDoc(mesh) });

let fetchMock: ReturnType<typeof vi.fn>;
let events: Array<{ kind: string; path: string; cachedAtEmit: string | undefined }>;
let off: () => void;

async function loadOld() {
  fetchMock.mockImplementationOnce(ok('Old'));
  resolveMeshTemplate(MESH_GUID);
  await flush();
  expect(getMeshAsset(MESH_GUID)?.mesh, 'sanity — the pre-edit definition is cached').toBe('Old');
}

beforeEach(() => {
  clearManifest();
  registerAsset(MESH_GUID, MESH_PATH, 'mesh');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  events = [];
  off = onAssetInvalidated((kind, path) => { events.push({ kind, path, cachedAtEmit: getMeshAsset(MESH_GUID)?.mesh }); });
});

afterEach(() => {
  off();
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('invalidateMeshAsset (#1380) — stale-while-revalidate', () => {
  it('keeps serving the old definition while the re-read is in flight, then swaps to the EDITED file', async () => {
    await loadOld();
    let land: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { land = r; }));

    invalidateMeshAsset(MESH_PATH);
    expect(getMeshAsset(MESH_GUID)?.mesh, 'never a gap — an eager evict left a mesh collider with no geometry').toBe('Old');

    land(await completeResponse({ ok: true, json: async () => meshDoc('New') }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getMeshAsset(MESH_GUID)?.mesh).toBe('New');
  });

  it("announces a 'mesh' event once the new definition is in, just before the swap", async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(ok('New'));
    invalidateMeshAsset(MESH_PATH);
    expect(events, 'nothing announced before the re-read lands').toEqual([]);
    await flush();
    expect(events).toEqual([{ kind: 'mesh', path: MESH_PATH, cachedAtEmit: 'Old' }]);
  });

  it('announces NOTHING for a byte-identical write — no teardown, no collider rebuild', async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(ok('Old'));
    invalidateMeshAsset(MESH_PATH);
    await flush();
    expect(fetchMock, 'sanity — it did re-read the file').toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
    expect(getMeshAsset(MESH_GUID)?.mesh).toBe('Old');
  });

  it('announces NOTHING for a material-only edit — no entity draws it (#1385), so a rebuild changes nothing', async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(async () => completeResponse({ ok: true, json: async () => ({ ...meshDoc('Old'), material: 'mat-guid-2' }) }));
    invalidateMeshAsset(MESH_PATH);
    await flush();
    expect(events).toEqual([]);
    expect(getMeshAsset(MESH_GUID)?.material, 'the entry still takes the new bytes').toBe('mat-guid-2');
  });

  it('a FAILED re-read keeps the old entry — a half-typed hand edit must not kill a rendering mesh', async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(async () => completeResponse({ ok: false, status: 404, json: async () => ({}) }));
    invalidateMeshAsset(MESH_PATH);
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'not MESH_FAILED — the old binding keeps rendering').toBe('Old');
    expect(events).toEqual([]);
  });

  it('a MALFORMED re-read (a half-typed hand edit: 200 with broken JSON) keeps the old entry', async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => '{"id": "x", "mesh": ' }));
    invalidateMeshAsset(MESH_PATH);
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'the parse throw must not stamp MESH_FAILED').toBe('Old');
    expect(events).toEqual([]);
  });

  it('a re-read REFUSED by its format version keeps the old entry', async () => {
    await loadOld();
    fetchMock.mockImplementationOnce(async () => completeResponse({ ok: true, json: async () => ({ ...meshDoc('New'), version: 99 }) }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    invalidateMeshAsset(MESH_PATH);
    await flush();
    expect(err, 'sanity — the refusal branch ran').toHaveBeenCalled();
    err.mockRestore();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'too-new must not stamp MESH_FAILED over a rendering mesh').toBe('Old');
  });

  it('a teardown landing while the NEW model loads refuses the swap — no re-seat, no event', async () => {
    const MODEL_GUID = '66666666-7777-4888-8999-ffffffffffff';
    registerAsset(MODEL_GUID, '/games/g/assets/models/other.glb', 'model');
    await loadOld();
    let open: () => void = () => {};
    glb.gate = new Promise<void>((r) => { open = r; });
    fetchMock.mockImplementationOnce(async () => completeResponse({ ok: true, json: async () => ({ ...meshDoc('Body'), model: MODEL_GUID }) }));
    try {
      invalidateMeshAsset(MESH_PATH); // the edit names a model nothing has loaded yet
      await flush(); // fetched + parsed — now parked in the gated template load

      disposeAllCachedResources(); // a full teardown lands inside that await
      open();
      await flush(); await flush();
    } finally { glb.gate = null; }

    expect(getMeshAsset(MESH_GUID), 'a torn-down cache must not be re-seated by the revalidate').toBeUndefined();
    expect(events).toEqual([]);
  });

  it('a re-read superseded by a SECOND edit never lands over it', async () => {
    await loadOld();
    let landFirst: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { landFirst = r; }));
    invalidateMeshAsset(MESH_PATH); // edit #1 — its re-read is gated

    fetchMock.mockImplementationOnce(ok('Second'));
    invalidateMeshAsset(MESH_PATH); // edit #2
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'sanity — the second re-read landed').toBe('Second');

    landFirst(await completeResponse({ ok: true, json: async () => meshDoc('First') }));
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'the superseded re-read must not re-seat its older bytes').toBe('Second');
  });

  it('refuses an in-flight INITIAL fetch of the pre-edit bytes that lands after the fresh one', async () => {
    let resolveStale: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveStale = r; }));
    resolveMeshTemplate(MESH_GUID); // fetch #1 — nothing cached yet, gated

    invalidateMeshAsset(MESH_PATH);

    fetchMock.mockImplementationOnce(ok('New'));
    resolveMeshTemplate(MESH_GUID); // fetch #2 — the fresh one
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'sanity — the fresh fetch landed first').toBe('New');

    resolveStale(await completeResponse({ ok: true, json: async () => meshDoc('Old') }));
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh, 'the late pre-edit fetch must not re-seat the old binding').toBe('New');
  });

  it('drops a permanently-FAILED entry, so the fixed file loads on the next resolve', async () => {
    fetchMock.mockImplementationOnce(async () => completeResponse({ ok: false, status: 404, json: async () => ({}) }));
    resolveMeshTemplate(MESH_GUID);
    await flush();
    resolveMeshTemplate(MESH_GUID);
    expect(fetchMock, 'sanity — MESH_FAILED stops retries').toHaveBeenCalledTimes(1);

    invalidateMeshAsset(MESH_PATH);
    expect(events, "announced even though nothing was cached — the Inspector re-reads on it").toEqual(
      [{ kind: 'mesh', path: MESH_PATH, cachedAtEmit: undefined }]);
    fetchMock.mockImplementationOnce(ok('Fixed'));
    resolveMeshTemplate(MESH_GUID);
    await flush();
    expect(getMeshAsset(MESH_GUID)?.mesh).toBe('Fixed');
  });
});
