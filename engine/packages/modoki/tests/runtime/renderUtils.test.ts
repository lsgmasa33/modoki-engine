/** renderUtils unit tests — isImagePath, resolvePrimitiveShape. */

import { describe, it, expect } from 'vitest';

async function getModule() {
  return import('../../../src/runtime/rendering/renderUtils');
}

describe('renderUtils', () => {
  describe('isImagePath', () => {
    it('returns true for .png files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('/textures/hero.png')).toBe(true);
    });

    it('returns true for .jpg files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('background.jpg')).toBe(true);
    });

    it('returns true for .jpeg files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('photo.jpeg')).toBe(true);
    });

    it('returns true for .webp files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('sprite.webp')).toBe(true);
    });

    it('returns true for .gif files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('anim.gif')).toBe(true);
    });

    it('returns true for .svg files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('icon.svg')).toBe(true);
    });

    it('is case-insensitive', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('IMAGE.PNG')).toBe(true);
      expect(isImagePath('photo.JPG')).toBe(true);
    });

    it('returns true for http URLs', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('http://example.com/image')).toBe(true);
      expect(isImagePath('https://cdn.example.com/sprite.png')).toBe(true);
    });

    it('returns false for non-image files', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('model.mesh.json')).toBe(false);
      expect(isImagePath('material.mat.json')).toBe(false);
      expect(isImagePath('scene.json')).toBe(false);
      expect(isImagePath('font.woff2')).toBe(false);
    });

    it('returns false for empty string', async () => {
      const { isImagePath } = await getModule();
      expect(isImagePath('')).toBe(false);
    });

    it('returns true for a texture GUID but false for a material GUID', async () => {
      const { isImagePath } = await getModule();
      const { registerAsset, clearManifest } = await import('../../../src/runtime/loaders/assetManifest');
      clearManifest();
      const texGuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
      const matGuid = '11111111-2222-4333-8444-555555555555';
      registerAsset(texGuid, '/textures/wood.png', 'texture');
      registerAsset(matGuid, '/materials/red.mat.json', 'material');
      // A material guid must NOT be treated as an image — otherwise primitives
      // get routed into the inline-texture path and never receive their material.
      expect(isImagePath(texGuid)).toBe(true);
      expect(isImagePath(matGuid)).toBe(false);
      clearManifest();
    });

    it('returns false for an unknown GUID (not in manifest)', async () => {
      const { isImagePath } = await getModule();
      const { clearManifest } = await import('../../../src/runtime/loaders/assetManifest');
      clearManifest();
      expect(isImagePath('99999999-aaaa-4bbb-8ccc-dddddddddddd')).toBe(false);
    });
  });

  // F13 — the hot-path getWorldTransform2D returns a shared singleton (alias footgun);
  // getWorldTransform2DInto is the alias-free variant for holding two results at once.
  describe('getWorldTransform2D / ...Into (F13)', () => {
    const local = (x: number, y: number) => ({ x, y, rz: 0, sx: 1, sy: 1 });

    it('singleton getWorldTransform2D reflects the latest call (documented aliasing)', async () => {
      const { getWorldTransform2D } = await getModule();
      const a = getWorldTransform2D(1, local(10, 20)); // no propagated transform → local fallback
      const b = getWorldTransform2D(2, local(30, 40));
      // Same object reused → the first reference now reads the SECOND call's data.
      expect(a).toBe(b);
      expect(a.x).toBe(30);
      expect(a.y).toBe(40);
    });

    it('getWorldTransform2DInto writes distinct out-objects — two results never alias', async () => {
      const { getWorldTransform2DInto } = await getModule();
      const outA = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
      const outB = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
      const a = getWorldTransform2DInto(outA, 1, local(10, 20));
      const b = getWorldTransform2DInto(outB, 2, local(30, 40));
      expect(a).toBe(outA);
      expect(b).toBe(outB);
      expect(a).not.toBe(b);
      // Both retain their own values — no clobber.
      expect([a.x, a.y]).toEqual([10, 20]);
      expect([b.x, b.y]).toEqual([30, 40]);
    });

    it('falls back to the local transform when none has been propagated', async () => {
      const { getWorldTransform2DInto } = await getModule();
      const out = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
      getWorldTransform2DInto(out, 999, { x: 5, y: 6, rz: 1.5, sx: 2, sy: 3 });
      expect(out).toEqual({ x: 5, y: 6, rz: 1.5, sx: 2, sy: 3 });
    });
  });

  describe('resolvePrimitiveShape', () => {
    it('returns "square" for "square"', async () => {
      const { resolvePrimitiveShape } = await getModule();
      expect(resolvePrimitiveShape('square')).toBe('square');
    });

    it('returns "triangle" for "triangle"', async () => {
      const { resolvePrimitiveShape } = await getModule();
      expect(resolvePrimitiveShape('triangle')).toBe('triangle');
    });

    it('returns "circle" for "circle"', async () => {
      const { resolvePrimitiveShape } = await getModule();
      expect(resolvePrimitiveShape('circle')).toBe('circle');
    });

    it('returns "circle" for unknown sprite names', async () => {
      const { resolvePrimitiveShape } = await getModule();
      expect(resolvePrimitiveShape('hexagon')).toBe('circle');
      expect(resolvePrimitiveShape('')).toBe('circle');
      expect(resolvePrimitiveShape('custom_shape')).toBe('circle');
    });
  });
});
