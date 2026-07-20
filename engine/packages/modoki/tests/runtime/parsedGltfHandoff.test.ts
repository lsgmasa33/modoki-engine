/** parsedGltfHandoff — the single-use editor-import → loader parse handoff (F4).
 *  Asserts the core contract: offer→take is single-use, an un-taken offer is
 *  disposed (no GPU leak), re-offering disposes the prior one, and clear() drops
 *  everything. Uses real THREE objects so the dispose walk runs for real. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  offerParsedGltf, takeParsedGltf, disposePendingGltf, hasPendingGltf, clearParsedGltfHandoff,
} from '../../src/runtime/loaders/parsedGltfHandoff';

/** A scene with one mesh whose geometry + material + a bound texture expose spies,
 *  so a dispose walk is observable. */
function makeScene() {
  const scene = new THREE.Group();
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  const tex = new THREE.Texture();
  mat.map = tex;
  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);
  const geomDispose = vi.spyOn(geom, 'dispose');
  const matDispose = vi.spyOn(mat, 'dispose');
  const texDispose = vi.spyOn(tex, 'dispose');
  return { scene, geomDispose, matDispose, texDispose };
}

beforeEach(() => clearParsedGltfHandoff());

describe('parsedGltfHandoff', () => {
  it('take returns the offered parse exactly once (single-use), then undefined', () => {
    const { scene } = makeScene();
    const clip = new THREE.AnimationClip('Idle', 1, []);
    offerParsedGltf('/m/a.glb', { scene, animations: [clip] });
    expect(hasPendingGltf('/m/a.glb')).toBe(true);

    const taken = takeParsedGltf('/m/a.glb');
    expect(taken?.scene).toBe(scene);
    expect(taken?.animations).toEqual([clip]);
    expect(hasPendingGltf('/m/a.glb')).toBe(false);
    expect(takeParsedGltf('/m/a.glb')).toBeUndefined(); // already consumed
  });

  it('take returns undefined for a path nobody offered (the runtime path)', () => {
    expect(takeParsedGltf('/m/never-offered.glb')).toBeUndefined();
  });

  it('disposePendingGltf disposes + drops an offer the consumer never took', () => {
    const { scene, geomDispose, matDispose, texDispose } = makeScene();
    offerParsedGltf('/m/b.glb', { scene, animations: [] });
    disposePendingGltf('/m/b.glb');
    expect(hasPendingGltf('/m/b.glb')).toBe(false);
    expect(geomDispose).toHaveBeenCalled();
    expect(matDispose).toHaveBeenCalled();
    expect(texDispose).toHaveBeenCalled(); // texture-valued material prop disposed too
  });

  it('disposePendingGltf is a no-op once the offer was taken (normal flow)', () => {
    const { scene, geomDispose } = makeScene();
    offerParsedGltf('/m/c.glb', { scene, animations: [] });
    takeParsedGltf('/m/c.glb');           // consumer took ownership
    disposePendingGltf('/m/c.glb');       // defensive call by the offerer
    expect(geomDispose).not.toHaveBeenCalled(); // must NOT dispose what the consumer owns
  });

  it('re-offering the same path disposes the prior un-taken parse', () => {
    const first = makeScene();
    offerParsedGltf('/m/d.glb', { scene: first.scene, animations: [] });
    const second = makeScene();
    offerParsedGltf('/m/d.glb', { scene: second.scene, animations: [] });
    expect(first.geomDispose).toHaveBeenCalled();    // earlier parse freed
    expect(takeParsedGltf('/m/d.glb')?.scene).toBe(second.scene); // newest wins
  });

  it('clear disposes every pending offer (full teardown)', () => {
    const a = makeScene();
    const b = makeScene();
    offerParsedGltf('/m/e1.glb', { scene: a.scene, animations: [] });
    offerParsedGltf('/m/e2.glb', { scene: b.scene, animations: [] });
    clearParsedGltfHandoff();
    expect(a.geomDispose).toHaveBeenCalled();
    expect(b.geomDispose).toHaveBeenCalled();
    expect(hasPendingGltf('/m/e1.glb')).toBe(false);
    expect(hasPendingGltf('/m/e2.glb')).toBe(false);
  });
});
