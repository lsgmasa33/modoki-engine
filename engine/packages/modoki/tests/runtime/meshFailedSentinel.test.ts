/** MESH_FAILED sentinel — a failed .mesh.json fetch must be cached as a
 *  permanent failure so the runtime does NOT re-fetch it every frame (commit
 *  b48e983 added the sentinel; this range hardened its read sites). The refcount
 *  test only mocks successful fetches, so the failure path was uncovered. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

describe('MESH_FAILED sentinel', () => {
  it('caches a failed .mesh.json fetch and does NOT re-fetch on subsequent access', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { acquireMesh, getMeshAsset } = await getCache();

    // First acquire — triggers a fetch that 404s.
    await acquireMesh(1, 'models/missing.mesh.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // getMeshAsset must report "not available" (undefined), never the sentinel.
    expect(getMeshAsset('models/missing.mesh.json')).toBeUndefined();

    // Second acquire (e.g. another scene / a later frame) must reuse the cached
    // failure and issue NO new fetch.
    await acquireMesh(2, 'models/missing.mesh.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getMeshAsset('models/missing.mesh.json')).toBeUndefined();
  });

  it('returns undefined from resolveMeshTemplate for a permanently-failed mesh without re-fetching', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { acquireMesh, resolveMeshTemplate } = await getCache();

    await acquireMesh(1, 'models/broken.mesh.json');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // resolveMeshTemplate sees MESH_FAILED and returns undefined — and must not
    // kick off another background fetch (the bug the sentinel guards against).
    expect(resolveMeshTemplate('models/broken.mesh.json')).toBeUndefined();
    expect(resolveMeshTemplate('models/broken.mesh.json')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
