/** fontNaming unit tests — parseFontFilename, WEIGHT_MAP. */

import { describe, it, expect } from 'vitest';
import { parseFontFilename, WEIGHT_MAP } from '../../src/runtime/loaders/fontNaming';

describe('fontNaming', () => {
  describe('WEIGHT_MAP', () => {
    it('maps standard weight names to CSS values', () => {
      expect(WEIGHT_MAP['thin'].weight).toBe('100');
      expect(WEIGHT_MAP['regular'].weight).toBe('400');
      expect(WEIGHT_MAP['bold'].weight).toBe('700');
      expect(WEIGHT_MAP['black'].weight).toBe('900');
    });

    it('maps italic variants with style', () => {
      expect(WEIGHT_MAP['bolditalic']).toEqual({ weight: '700', style: 'italic' });
      expect(WEIGHT_MAP['italic']).toEqual({ weight: '400', style: 'italic' });
      expect(WEIGHT_MAP['lightitalic']).toEqual({ weight: '300', style: 'italic' });
    });

    it('has no style on non-italic entries', () => {
      expect(WEIGHT_MAP['medium'].style).toBeUndefined();
      expect(WEIGHT_MAP['semibold'].style).toBeUndefined();
    });
  });

  describe('parseFontFilename', () => {
    it('parses Roboto-Bold.woff2', () => {
      const info = parseFontFilename('fonts/Roboto-Bold.woff2');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('700');
      expect(info.style).toBe('normal');
      expect(info.path).toBe('fonts/Roboto-Bold.woff2');
    });

    it('parses OpenSans-SemiBoldItalic.ttf with camelCase spacing', () => {
      const info = parseFontFilename('OpenSans-SemiBoldItalic.ttf');
      expect(info.family).toBe('Open Sans');
      expect(info.weight).toBe('600');
      expect(info.style).toBe('italic');
    });

    it('parses hyphen-separated family-weight', () => {
      const info = parseFontFilename('/assets/fonts/Lato-Light.woff2');
      expect(info.family).toBe('Lato');
      expect(info.weight).toBe('300');
      expect(info.style).toBe('normal');
    });

    it('parses underscore-separated family_weight', () => {
      const info = parseFontFilename('Montserrat_ExtraBold.otf');
      expect(info.family).toBe('Montserrat');
      expect(info.weight).toBe('800');
      expect(info.style).toBe('normal');
    });

    it('defaults to weight 400 normal when no variant suffix', () => {
      const info = parseFontFilename('CustomFont.ttf');
      expect(info.family).toBe('Custom Font');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });

    it('treats unknown suffix as part of family name', () => {
      const info = parseFontFilename('MyFont-Display.woff2');
      // "display" is not in WEIGHT_MAP, so entire name is treated as family
      expect(info.family).toBe('My Font Display');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });

    it('handles deep paths correctly', () => {
      const info = parseFontFilename('/a/b/c/d/NotoSans-Medium.woff2');
      expect(info.family).toBe('Noto Sans');
      expect(info.weight).toBe('500');
      expect(info.path).toBe('/a/b/c/d/NotoSans-Medium.woff2');
    });

    it('handles Regular variant', () => {
      const info = parseFontFilename('Inter-Regular.woff2');
      expect(info.family).toBe('Inter');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });

    it('parses thin italic', () => {
      const info = parseFontFilename('Roboto-ThinItalic.ttf');
      expect(info.family).toBe('Roboto');
      expect(info.weight).toBe('100');
      expect(info.style).toBe('italic');
    });

    it('handles single-word filename without separator', () => {
      const info = parseFontFilename('Arial.ttf');
      expect(info.family).toBe('Arial');
      expect(info.weight).toBe('400');
      expect(info.style).toBe('normal');
    });
  });
});
