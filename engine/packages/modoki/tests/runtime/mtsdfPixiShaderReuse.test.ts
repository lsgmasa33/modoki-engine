// @vitest-environment jsdom
/** Cover for #690 — reusing a text `Shader` across a geometry rebuild instead of
 *  building a fresh one per page. The Shader depends only on the page TEXTURE and
 *  the ATLAS geometry (`width`/`height`/`distanceRange`/`size`/`type`); fontSize
 *  reaches it solely through the `uScreenPxRange` uniform and style solely through
 *  uniforms `updateMtsdfPixiStyle` already updates in place — see the comments on
 *  `canReuseMtsdfPixiShader`/`updateMtsdfPixiMetrics` in `mtsdfPixiShader.ts`.
 *
 *  This does NOT test the GL/GPU program cache — that's `mtsdfProgramCache.test.ts`
 *  (#590). What's under test here is the `Shader` object + its `UniformGroup`, which
 *  is what #690 saves. */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import {
  makeMtsdfPixiShader, canReuseMtsdfPixiShader, updateMtsdfPixiMetrics,
  type MtsdfPixiAtlas,
} from '../../src/runtime/rendering/text/mtsdfPixiShader';
import type { MtsdfStyle } from '../../src/runtime/rendering/text/mtsdfStyle';

const style: MtsdfStyle = { color: 0xffffff };
const atlas: MtsdfPixiAtlas = { width: 512, height: 512, distanceRange: 8, size: 32, type: 'mtsdf' };

describe('canReuseMtsdfPixiShader (#690)', () => {
  it('returns true for the same texture + an EQUAL-BUT-DISTINCT atlas object (the real calling pattern — Scene2D spreads a fresh atlas object every frame)', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    const freshAtlas: MtsdfPixiAtlas = { ...atlas }; // distinct object, equal fields
    expect(freshAtlas).not.toBe(atlas);
    expect(canReuseMtsdfPixiShader(shader, tex, freshAtlas)).toBe(true);
  });

  it('returns false when the texture source differs', () => {
    const tex = new Texture();
    const otherTex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, otherTex, { ...atlas })).toBe(false);
  });

  it('returns false when width differs', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas, width: 256 })).toBe(false);
  });

  it('returns false when height differs', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas, height: 256 })).toBe(false);
  });

  it('returns false when distanceRange differs', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas, distanceRange: 16 })).toBe(false);
  });

  it('returns false when size differs', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas, size: 64 })).toBe(false);
  });

  it('returns false when type differs (mtsdf vs msdf changes uHasTrueSdf)', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas, type: 'msdf' })).toBe(false);
  });
});

describe('updateMtsdfPixiMetrics (#690)', () => {
  it('sets uScreenPxRange to the SAME value a freshly built shader gets for the same (atlas, fontSize) — asserted against each other, not a hardcoded number, so the two expressions cannot drift apart silently', () => {
    const tex = new Texture();
    const fontSize = 40;
    const reused = makeMtsdfPixiShader(tex, atlas, style, 24); // built at a different fontSize
    updateMtsdfPixiMetrics(reused, atlas, fontSize);
    const fresh = makeMtsdfPixiShader(tex, atlas, style, fontSize);
    const reusedRange = (reused.resources.mtsdfUniforms as { uniforms: { uScreenPxRange: number } }).uniforms.uScreenPxRange;
    const freshRange = (fresh.resources.mtsdfUniforms as { uniforms: { uScreenPxRange: number } }).uniforms.uScreenPxRange;
    expect(reusedRange).toBe(freshRange);
  });

  it('re-stashes the fresh atlas object so a later reuse check compares against the NEW atlas, not the stale one', () => {
    const tex = new Texture();
    const shader = makeMtsdfPixiShader(tex, atlas, style, 24);
    const newAtlas: MtsdfPixiAtlas = { ...atlas, distanceRange: 16 };
    updateMtsdfPixiMetrics(shader, newAtlas, 24);
    // The shader now reuses fine against an atlas equal to newAtlas...
    expect(canReuseMtsdfPixiShader(shader, tex, { ...newAtlas })).toBe(true);
    // ...but NOT against the original atlas (stale distanceRange would wrongly say yes).
    expect(canReuseMtsdfPixiShader(shader, tex, { ...atlas })).toBe(false);
  });
});
