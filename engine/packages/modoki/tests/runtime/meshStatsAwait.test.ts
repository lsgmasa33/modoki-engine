/** whenMeshTemplate + meshStatsFromTemplate (F9) — the mesh inspector used to
 *  poll resolveMeshTemplate up to 10× at 1s intervals. These cover the awaited
 *  cache-promise replacement: a permanently-failed mesh resolves to undefined
 *  (no spin), and stats derive purely from a resolved template. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function getCache() {
  return import('../../src/runtime/loaders/meshTemplateCache');
}

describe('meshStatsFromTemplate', () => {
  it('counts vertices/triangles from an indexed geometry and lists attributes', async () => {
    const { meshStatsFromTemplate } = await getCache();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3)); // 4 verts
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]); // 2 triangles

    const stats = meshStatsFromTemplate({ geometry: geo, material: new THREE.MeshBasicMaterial(), name: 'm' });
    expect(stats.vertices).toBe(4);
    expect(stats.triangles).toBe(2);
    expect(stats.attributes.sort()).toEqual(['normal', 'position']);
  });

  it('derives triangle count from vertices when geometry is non-indexed', async () => {
    const { meshStatsFromTemplate } = await getCache();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(27), 3)); // 9 verts
    const stats = meshStatsFromTemplate({ geometry: geo, material: new THREE.MeshBasicMaterial(), name: 'm' });
    expect(stats.vertices).toBe(9);
    expect(stats.triangles).toBe(3);
  });

  it('returns zeroes for an empty geometry without throwing', async () => {
    const { meshStatsFromTemplate } = await getCache();
    const geo = new THREE.BufferGeometry();
    const stats = meshStatsFromTemplate({ geometry: geo, material: new THREE.MeshBasicMaterial(), name: 'm' });
    expect(stats.vertices).toBe(0);
    expect(stats.triangles).toBe(0);
    expect(stats.attributes).toEqual([]);
  });
});

describe('whenMeshTemplate', () => {
  it('resolves to undefined for a permanently-failed .mesh.json (no polling)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { whenMeshTemplate } = await getCache();
    const result = await whenMeshTemplate('models/missing.mesh.json');
    expect(result).toBeUndefined();
    // One fetch — the cached failure means no retry storm.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second await reuses the cached failure: still undefined, no new fetch.
    const again = await whenMeshTemplate('models/missing.mesh.json');
    expect(again).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves to undefined for an empty ref', async () => {
    const { whenMeshTemplate } = await getCache();
    expect(await whenMeshTemplate('')).toBeUndefined();
  });

  it('returns a cached legacy (no-extension) sprite template synchronously', async () => {
    const { whenMeshTemplate, getMeshTemplate } = await getCache();
    // Legacy sprite keys are looked up directly in `cache`; an unknown one is undefined.
    expect(await whenMeshTemplate('circle')).toBe(getMeshTemplate('circle'));
  });
});
