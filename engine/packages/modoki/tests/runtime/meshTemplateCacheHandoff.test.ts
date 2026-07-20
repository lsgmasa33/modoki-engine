/** loadModelTemplates ⟷ parsed-GLB handoff (F4 — static path, no second parse).
 *  The editor importer parses a GLB once for rig inspection, then offers that parse;
 *  loadModelTemplates must consume it and build templates WITHOUT a second
 *  GLTFLoader.load. The runtime path (no offer) still parses normally. GLTFLoader is
 *  mocked with a load-counter; the offered scene is a real THREE graph so Phase-1
 *  (filter/fixup/dequantize/decompose) runs for real. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('three/examples/jsm/libs/meshopt_decoder.module.js', () => ({ MeshoptDecoder: {} }));

const loadSpy = vi.hoisted(() => ({ count: 0, lastUrl: '' }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setMeshoptDecoder() {}
    // Never resolves — these tests only assert WHETHER the loader was invoked.
    load(url: string) { loadSpy.count++; loadSpy.lastUrl = url; }
  },
}));

import * as THREE from 'three';
import {
  loadModelTemplates, getTemplatesForModel, getModelHierarchy, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { offerParsedGltf, hasPendingGltf } from '../../src/runtime/loaders/parsedGltfHandoff';

function makeStaticScene(meshName: string) {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = meshName;
  scene.add(mesh);
  return scene;
}

beforeEach(() => { loadSpy.count = 0; loadSpy.lastUrl = ''; });
afterEach(() => disposeAllCachedResources());

describe('loadModelTemplates — parsed-GLB handoff (F4)', () => {
  it('consumes the offered parse and builds templates without a second GLTFLoader.load', async () => {
    const scene = makeStaticScene('Body');
    offerParsedGltf('/models/hero.glb', { scene, animations: [] });

    await loadModelTemplates('/models/hero.glb', undefined, 'none', true);

    expect(loadSpy.count).toBe(0);                       // NO second parse
    expect(hasPendingGltf('/models/hero.glb')).toBe(false); // single-use, consumed
    const templates = getTemplatesForModel('/models/hero.glb');
    expect(templates.size).toBe(1);                      // template built from the handoff
    expect(getModelHierarchy('/models/hero.glb')).toHaveLength(1); // hierarchy extracted from it
  });

  it('parses via GLTFLoader when nothing was offered (runtime scene-load path unchanged)', () => {
    // No offer → the loader is invoked (the mock never resolves, so don't await).
    void loadModelTemplates('/models/runtime.glb', undefined, 'none', false);
    expect(loadSpy.count).toBe(1);
    expect(hasPendingGltf('/models/runtime.glb')).toBe(false);
  });

  it('an offer for a different path does not satisfy this load', () => {
    offerParsedGltf('/models/other.glb', { scene: makeStaticScene('X'), animations: [] });
    void loadModelTemplates('/models/wanted.glb', undefined, 'none', false);
    expect(loadSpy.count).toBe(1);                       // mismatched path → real parse
    expect(hasPendingGltf('/models/other.glb')).toBe(true); // the other offer is untouched
  });
});
