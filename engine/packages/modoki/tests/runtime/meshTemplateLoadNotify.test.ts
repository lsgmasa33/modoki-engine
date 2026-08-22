/** QA-ASSET-0008 — a re-import of a model the CURRENT scene renders evicted its live meshes
 *  and then rebuilt nothing until some UNRELATED interaction forced a frame, because the
 *  SceneView renders on demand. The redraw is re-armed on two edges now, and the LOAD edge is
 *  the one that had no signal at all to hang off: a GLB re-parse routinely outlasts the dirty
 *  gate's ~1s grace, so re-arming on invalidation alone would still have left the object gone.
 *
 *  This pins the static-mesh half of the notification (fires once templates are actually in
 *  the cache, and unsubscribes). The RIGGED cache fires the same shared edge and is pinned in
 *  riggedModelCache.test.ts, which already mocks a real loader. The SceneView's subscription is
 *  one line beside the existing onWorldSwap/onTextDirty siblings and needs a live viewport. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { setMeshoptDecoder(_d: unknown) {} load() {} },
}));

import { loadModelTemplates, getMeshTemplate, invalidateModel } from '../../src/runtime/loaders/meshTemplateCache';
import { onModelTemplatesLoaded } from '../../src/runtime/loaders/modelLoadNotify';
import { offerParsedGltf } from '../../src/runtime/loaders/parsedGltfHandoff';

/** A one-mesh GLB, handed straight to the cache so no loader/network is involved. */
function offer(path: string, meshName: string) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = meshName;
  mesh.userData.name = meshName; // deriveTemplateName keys off the GLB's authored node name
  scene.add(mesh);
  offerParsedGltf(path, { scene } as never);
}

describe('onModelTemplatesLoaded', () => {
  beforeEach(() => { invalidateModel('/m/ship.glb'); });

  it('fires with the model path once its templates are in the cache', async () => {
    const seen: string[] = [];
    const off = onModelTemplatesLoaded((p) => seen.push(p));
    offer('/m/ship.glb', 'Hull');
    await loadModelTemplates('/m/ship.glb');
    off();

    expect(seen).toEqual(['/m/ship.glb']);
    // The listener must run AFTER the templates are resolvable — a redraw armed before the
    // cache is populated would draw the same empty frame and settle again.
    expect(getMeshTemplate('/m/ship.glb::Hull')).toBeTruthy();
  });

  it('stops firing once unsubscribed', async () => {
    const fn = vi.fn();
    onModelTemplatesLoaded(fn)();
    offer('/m/ship.glb', 'Hull');
    await loadModelTemplates('/m/ship.glb');
    expect(fn).not.toHaveBeenCalled();
  });

  it('a throwing listener does not break the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    const offA = onModelTemplatesLoaded(() => { throw new Error('boom'); });
    const offB = onModelTemplatesLoaded(after);
    offer('/m/ship.glb', 'Hull');
    await expect(loadModelTemplates('/m/ship.glb')).resolves.toBeUndefined();
    offA(); offB();
    expect(after).toHaveBeenCalled();
    warn.mockRestore();
  });
});
