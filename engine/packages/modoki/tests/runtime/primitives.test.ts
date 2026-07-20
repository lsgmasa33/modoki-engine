/** primitives unit tests — primitive mesh creation and validation. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

async function getPrimitives() {
  return import('../../../src/runtime/loaders/primitives');
}

describe('primitives', () => {
  describe('PRIMITIVE_NAMES', () => {
    it('includes all expected primitives', async () => {
      const { PRIMITIVE_NAMES } = await getPrimitives();
      expect(PRIMITIVE_NAMES).toContain('cube');
      expect(PRIMITIVE_NAMES).toContain('box');
      expect(PRIMITIVE_NAMES).toContain('sphere');
      expect(PRIMITIVE_NAMES).toContain('cylinder');
      expect(PRIMITIVE_NAMES).toContain('cone');
      expect(PRIMITIVE_NAMES).toContain('plane');
      expect(PRIMITIVE_NAMES).toContain('torus');
      expect(PRIMITIVE_NAMES).toContain('capsule');
    });

    it('has 8 primitives', async () => {
      const { PRIMITIVE_NAMES } = await getPrimitives();
      expect(PRIMITIVE_NAMES).toHaveLength(8);
    });
  });

  describe('isPrimitive', () => {
    it('returns true for valid primitive names', async () => {
      const { isPrimitive, PRIMITIVE_NAMES } = await getPrimitives();
      for (const name of PRIMITIVE_NAMES) {
        expect(isPrimitive(name)).toBe(true);
      }
    });

    it('returns false for unknown names', async () => {
      const { isPrimitive } = await getPrimitives();
      expect(isPrimitive('custom_mesh')).toBe(false);
      expect(isPrimitive('')).toBe(false);
      expect(isPrimitive('model/ground')).toBe(false);
    });
  });

  describe('createPrimitiveMesh', () => {
    it('creates a Mesh for each primitive type', async () => {
      const { createPrimitiveMesh, PRIMITIVE_NAMES } = await getPrimitives();
      for (const name of PRIMITIVE_NAMES) {
        const mesh = createPrimitiveMesh(name, 2, 0xff0000);
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        expect(mesh!.geometry).toBeDefined();
        expect(mesh!.material).toBeDefined();
      }
    });

    it('sets material color correctly', async () => {
      const { createPrimitiveMesh } = await getPrimitives();
      const mesh = createPrimitiveMesh('cube', 1, 0x00ff00);
      const mat = mesh!.material as THREE.MeshStandardMaterial;
      expect(mat.color.getHex()).toBe(0x00ff00);
    });

    it('scales geometry with size parameter', async () => {
      const { createPrimitiveMesh } = await getPrimitives();
      const small = createPrimitiveMesh('cube', 1, 0xffffff)!;
      const large = createPrimitiveMesh('cube', 10, 0xffffff)!;

      const smallSize = new THREE.Box3().setFromObject(small).getSize(new THREE.Vector3());
      const largeSize = new THREE.Box3().setFromObject(large).getSize(new THREE.Vector3());

      expect(largeSize.x).toBeGreaterThan(smallSize.x);
    });

    it('returns null for unknown primitive name', async () => {
      const { createPrimitiveMesh } = await getPrimitives();
      expect(createPrimitiveMesh('unknown', 1, 0xffffff)).toBeNull();
    });

    it('creates standard material with expected defaults', async () => {
      const { createPrimitiveMesh } = await getPrimitives();
      const mesh = createPrimitiveMesh('sphere', 1, 0xffffff);
      const mat = mesh!.material as THREE.MeshStandardMaterial;

      expect(mat.roughness).toBe(0.4);
      expect(mat.metalness).toBe(0.3);
    });
  });
});
