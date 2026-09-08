/** ModelPreview's owned-resource bookkeeping (#537) — the leak was that
 *  `THREE.Material.dispose()` frees material state but not the textures hanging off it, so
 *  flipping the LOD selector N times leaked N sets of textures. These tests perturb N, not
 *  just assert dispose was called once, and guard the sweep against becoming a blanket one. */

import { describe, it, expect, vi } from 'vitest';
import type * as THREE from 'three';
import {
  collectMaterialResources, disposeOwnedResources,
} from '../../packages/modoki/src/editor/panels/modelPreviewResources';

// Fakes, not the real three.js WebGL stack — this module only touches `.isTexture`/`.dispose()`.
const fakeTexture = () => ({ isTexture: true as const, dispose: vi.fn() });
const fakeMaterial = (textureKeys: string[] = ['map']) => {
  const mat: Record<string, unknown> = { dispose: vi.fn() };
  for (const key of textureKeys) mat[key] = fakeTexture();
  return mat as unknown as THREE.Material;
};

describe('collectMaterialResources / disposeOwnedResources', () => {
  it('is flat, not linear, across repeated collect→dispose cycles', () => {
    const ownedMaterials = new Set<THREE.Material>();
    const ownedGeometries = new Set<THREE.BufferGeometry>();
    const ownedTextures = new Set<THREE.Texture>();

    for (let cycle = 0; cycle < 5; cycle++) {
      const mats = [fakeMaterial(['map']), fakeMaterial(['map', 'normalMap'])];
      for (const m of mats) collectMaterialResources(ownedMaterials, ownedTextures, m);

      // Collect every texture object this cycle handed out, so we can assert each was
      // disposed exactly once (not zero, not twice) after this cycle's dispose call.
      const collectedThisCycle = Array.from(ownedTextures);
      expect(collectedThisCycle).toHaveLength(3); // 1 + 2 texture-valued keys

      disposeOwnedResources(ownedGeometries, ownedMaterials, ownedTextures);

      expect(ownedMaterials.size).toBe(0);
      expect(ownedGeometries.size).toBe(0);
      expect(ownedTextures.size).toBe(0);
      for (const t of collectedThisCycle) {
        expect((t as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('disposes a texture shared between two materials in the same document exactly once', () => {
    const ownedMaterials = new Set<THREE.Material>();
    const ownedGeometries = new Set<THREE.BufferGeometry>();
    const ownedTextures = new Set<THREE.Texture>();

    const shared = fakeTexture();
    const matA = { dispose: vi.fn(), map: shared } as unknown as THREE.Material;
    const matB = { dispose: vi.fn(), map: shared, normalMap: shared } as unknown as THREE.Material;

    collectMaterialResources(ownedMaterials, ownedTextures, matA);
    collectMaterialResources(ownedMaterials, ownedTextures, matB);
    expect(ownedTextures.size).toBe(1); // deduped by the Set

    disposeOwnedResources(ownedGeometries, ownedMaterials, ownedTextures);
    expect(shared.dispose).toHaveBeenCalledTimes(1);
  });

  it('collects and disposes a material with no texture-valued keys without error', () => {
    const ownedMaterials = new Set<THREE.Material>();
    const ownedGeometries = new Set<THREE.BufferGeometry>();
    const ownedTextures = new Set<THREE.Texture>();

    const bare = { color: 0xffffff, roughness: 0.5, dispose: vi.fn() } as unknown as THREE.Material;
    expect(() => collectMaterialResources(ownedMaterials, ownedTextures, bare)).not.toThrow();
    expect(ownedMaterials.has(bare)).toBe(true);
    expect(ownedTextures.size).toBe(0);

    expect(() => disposeOwnedResources(ownedGeometries, ownedMaterials, ownedTextures)).not.toThrow();
  });

  it('does not touch a non-texture property that merely happens to expose dispose()', () => {
    // The guard against the blanket sweep the issue warned about: only values with
    // `isTexture === true` are collected, not anything with a `.dispose` method.
    const ownedMaterials = new Set<THREE.Material>();
    const ownedTextures = new Set<THREE.Texture>();

    const lookalike = { dispose: vi.fn() }; // NOT isTexture
    const mat = { dispose: vi.fn(), map: fakeTexture(), userData: lookalike } as unknown as THREE.Material;

    collectMaterialResources(ownedMaterials, ownedTextures, mat);
    expect(ownedTextures.size).toBe(1);
    for (const t of ownedTextures) expect(t).not.toBe(lookalike);

    disposeOwnedResources(new Set(), ownedMaterials, ownedTextures);
    expect(lookalike.dispose).not.toHaveBeenCalled();
  });
});
