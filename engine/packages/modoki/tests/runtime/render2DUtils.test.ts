/** render2DUtils unit tests — pivot offsets, sprite scaling, shape drawing, image drawing. */

import { describe, it, expect, vi } from 'vitest';

async function getModule() {
  return import('../../../src/runtime/rendering/render2DUtils');
}

describe('render2DUtils', () => {
  describe('computePivotOffset', () => {
    it('centers pivot at (0.5, 0.5)', async () => {
      const { computePivotOffset } = await getModule();
      const { ox, oy } = computePivotOffset(50, 30, 0.5, 0.5);
      expect(ox).toBe(-50); // -w * 2 * 0.5 = -w
      expect(oy).toBe(-30); // -h * 2 * 0.5 = -h
    });

    it('returns zero offset for pivot (0, 0) — top-left', async () => {
      const { computePivotOffset } = await getModule();
      const { ox, oy } = computePivotOffset(50, 30, 0, 0);
      expect(ox).toBeCloseTo(0);
      expect(oy).toBeCloseTo(0);
    });

    it('returns full offset for pivot (1, 1) — bottom-right', async () => {
      const { computePivotOffset } = await getModule();
      const { ox, oy } = computePivotOffset(50, 30, 1, 1);
      expect(ox).toBe(-100); // -50 * 2 * 1
      expect(oy).toBe(-60);  // -30 * 2 * 1
    });

    it('handles asymmetric pivot values', async () => {
      const { computePivotOffset } = await getModule();
      const { ox, oy } = computePivotOffset(100, 200, 0.25, 0.75);
      expect(ox).toBe(-50);  // -100 * 2 * 0.25
      expect(oy).toBe(-300); // -200 * 2 * 0.75
    });

    it('handles zero dimensions', async () => {
      const { computePivotOffset } = await getModule();
      const { ox, oy } = computePivotOffset(0, 0, 0.5, 0.5);
      expect(ox).toBeCloseTo(0);
      expect(oy).toBeCloseTo(0);
    });
  });

  describe('computeSpriteScale', () => {
    it('computes independent scales without keepAspect', async () => {
      const { computeSpriteScale } = await getModule();
      const { scaleX, scaleY } = computeSpriteScale(100, 50, 200, 200, false);
      // scaleX = (100 * 2) / 200 = 1.0, scaleY = (50 * 2) / 200 = 0.5
      expect(scaleX).toBe(1);
      expect(scaleY).toBe(0.5);
    });

    it('uses uniform scale with keepAspect', async () => {
      const { computeSpriteScale } = await getModule();
      const { scaleX, scaleY } = computeSpriteScale(100, 50, 200, 200, true);
      // scaleX = 1.0, scaleY = 0.5 → uniform = min(1, 0.5) = 0.5
      expect(scaleX).toBe(0.5);
      expect(scaleY).toBe(0.5);
    });

    it('returns equal scales when aspect ratios match', async () => {
      const { computeSpriteScale } = await getModule();
      const { scaleX, scaleY } = computeSpriteScale(100, 100, 200, 200, false);
      expect(scaleX).toBe(1);
      expect(scaleY).toBe(1);
    });

    it('keepAspect with tall texture favors width', async () => {
      const { computeSpriteScale } = await getModule();
      // target: 100x100 (half-dims), tex: 100x400
      const { scaleX, scaleY } = computeSpriteScale(100, 100, 100, 400, true);
      // non-uniform: scaleX=2, scaleY=0.5 → uniform=0.5
      expect(scaleX).toBe(0.5);
      expect(scaleY).toBe(0.5);
    });
  });

  describe('pixiBlendMode2D', () => {
    it('passes through the four valid Pixi blend strings', async () => {
      const { pixiBlendMode2D } = await getModule();
      expect(pixiBlendMode2D('normal')).toBe('normal');
      expect(pixiBlendMode2D('add')).toBe('add');
      expect(pixiBlendMode2D('multiply')).toBe('multiply');
      expect(pixiBlendMode2D('screen')).toBe('screen');
    });

    it('defaults unknown / legacy / empty values to normal', async () => {
      const { pixiBlendMode2D } = await getModule();
      expect(pixiBlendMode2D('additive')).toBe('normal'); // particle spelling — not a Renderable2D value
      expect(pixiBlendMode2D('overlay')).toBe('normal');
      expect(pixiBlendMode2D('')).toBe('normal');
      expect(pixiBlendMode2D(undefined)).toBe('normal');
    });
  });
});
