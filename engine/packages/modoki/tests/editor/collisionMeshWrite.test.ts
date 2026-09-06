/** `ModelAssetView`'s "Generate Collision Mesh" write+register sequence
 *  (`collisionMeshWrite.ts`), unit-tested without mounting the component (CLAUDE.md § Panels).
 *
 *  #784 phase C2b item 5 — the exact mechanism #311 fixed on `modelImport.ts`, found again here:
 *  `registerAsset` used to run BEFORE either file was written, and the `.mesh.json` write's
 *  response was discarded (unlike the sibling GLB write, which was already checked). A GUID
 *  pointing at a path with no file behind it resolves for the rest of the session and only
 *  surfaces on a later scene load or the next editor launch — far from this call. */

import { describe, it, expect, vi } from 'vitest';
import { writeCollisionMeshAssets, type CollisionMeshWriteDeps } from '../../src/editor/panels/assetViews/collisionMeshWrite';

const INPUT = {
  glbPath: '/assets/models/rock/rock_col.colmesh.glb',
  glbBase64: 'AAAA',
  meshJsonPath: '/assets/models/rock/meshes/rock_col.mesh.json',
  meshName: 'rock_col',
  modelGuid: 'model-guid',
  meshGuid: 'mesh-guid',
};

function makeDeps(overrides: Partial<CollisionMeshWriteDeps> = {}): CollisionMeshWriteDeps & { registerCalls: [string, string, string][] } {
  const registerCalls: [string, string, string][] = [];
  return {
    post: vi.fn(async () => ({ ok: true, status: 200 })),
    registerAsset: (id, path, type) => { registerCalls.push([id, path, type]); },
    registerCalls,
    ...overrides,
  };
}

const noopWriteMeta = vi.fn(async () => ({}));

describe('writeCollisionMeshAssets', () => {
  it('registers both guids after their writes succeed', async () => {
    const deps = makeDeps();
    await writeCollisionMeshAssets(INPUT, deps, noopWriteMeta);
    expect(deps.registerCalls).toEqual([
      ['model-guid', INPUT.glbPath, 'model'],
      ['mesh-guid', INPUT.meshJsonPath, 'mesh'],
    ]);
  });

  it('does NOT register the model guid when the GLB write fails', async () => {
    const deps = makeDeps({ post: vi.fn(async () => ({ ok: false, status: 500 })) });
    await expect(writeCollisionMeshAssets(INPUT, deps, noopWriteMeta)).rejects.toThrow(/write GLB failed/);
    expect(deps.registerCalls).toEqual([]);
  });

  it('does NOT register the mesh guid when the .mesh.json write fails — the regression this item guards', async () => {
    // GLB write succeeds, .mesh.json write fails. Before the fix, `registerAsset(meshGuid, …)`
    // ran unconditionally before either write, so this exact case left a guid pointing at a
    // `.mesh.json` that was never written.
    let call = 0;
    const deps = makeDeps({
      post: vi.fn(async () => {
        call++;
        return call === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 };
      }),
    });
    await expect(writeCollisionMeshAssets(INPUT, deps, noopWriteMeta)).rejects.toThrow(/write \.mesh\.json failed/);
    // The model guid (whose write DID succeed) is registered; the mesh guid (whose write
    // failed) must NOT be.
    expect(deps.registerCalls).toEqual([['model-guid', INPUT.glbPath, 'model']]);
  });

  it('runs writeMeta between the GLB registration and the .mesh.json write', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      post: vi.fn(async (p: string) => { order.push(`post:${p}`); return { ok: true, status: 200 }; }),
      registerAsset: (id, path) => { order.push(`register:${path}`); },
    });
    await writeCollisionMeshAssets(INPUT, deps, async () => { order.push('writeMeta'); });
    expect(order).toEqual([
      `post:${INPUT.glbPath}`,
      `register:${INPUT.glbPath}`,
      'writeMeta',
      `post:${INPUT.meshJsonPath}`,
      `register:${INPUT.meshJsonPath}`,
    ]);
  });

  it('stamps the mesh asset with MESH_FORMAT_VERSION', async () => {
    const deps = makeDeps();
    await writeCollisionMeshAssets(INPUT, deps, noopWriteMeta);
    const meshWriteCall = (deps.post as ReturnType<typeof vi.fn>).mock.calls.find(([p]) => p === INPUT.meshJsonPath)!;
    const written = JSON.parse(meshWriteCall[1] as string);
    expect(typeof written.version).toBe('number');
  });
});
