/** Cover for #692 — reusing a Text3D page `Material` across a geometry rebuild instead of
 *  building a fresh one (a shader recompile) per page, the direct analogue of #690 on the 2D
 *  (PixiJS) text twin. See `canReuseMtsdfMaterial` in `mtsdfShader.ts` for the full rationale.
 *
 *  `syncText3D` is not exported and no test harness drives it, so this pins the reuse DECISION
 *  ONLY — `canReuseMtsdfMaterial` reads nothing but `mat.userData`, so a plain object literal
 *  shaped like a stashed material stands in for a real TSL `MeshBasicNodeMaterial`, and there is
 *  no need to build one. The `syncText3D` WIRING that consumes this decision (the reclaim-or-build
 *  branch, the `finally` that disposes unreclaimed materials) is not covered here. */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { canReuseMtsdfMaterial, makeMtsdfMaterial, type MtsdfStyle } from '../../src/runtime/rendering/text/mtsdfShader';
import { Text3D } from '../../src/runtime/traits/Text3D';

/** Minimal stand-in for a material stashed by `makeMtsdfMaterial` — only the fields
 *  `canReuseMtsdfMaterial` reads. Cast through `unknown` since this is not a real
 *  `THREE.Material`. */
function stubMaterial(userData: Record<string, unknown>): THREE.Material {
  return { userData } as unknown as THREE.Material;
}

const tex = {} as THREE.Texture;
const atlas = { width: 512, height: 512, distanceRange: 8, size: 32, hasTrueSdf: true };

function stashed(overrides: Partial<typeof atlas> = {}, opts: { uniforms?: boolean; tex?: THREE.Texture } = {}) {
  return stubMaterial({
    mtsdfUniforms: opts.uniforms === false ? undefined : {},
    mtsdfTexture: opts.tex ?? tex,
    mtsdfAtlas: { ...atlas, ...overrides },
  });
}

describe('canReuseMtsdfMaterial (#692)', () => {
  it('returns true for identical inputs', () => {
    const mat = stashed();
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(true);
  });

  it('returns false when the texture object differs — it is closed over by `texNode`, so no uniform write can change it', () => {
    const mat = stashed();
    const otherTex = {} as THREE.Texture;
    expect(canReuseMtsdfMaterial(mat, otherTex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when atlasWidth differs', () => {
    const mat = stashed({ width: 256 });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when atlasHeight differs', () => {
    const mat = stashed({ height: 256 });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when distanceRange differs', () => {
    const mat = stashed({ distanceRange: 16 });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when atlasSize differs', () => {
    const mat = stashed({ size: 64 });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when hasTrueSdf differs — it is a build-time branch baked into the node graph, so a reused material would render an msdf atlas through the mtsdf path (glow and soft shadow as solid rectangles) with nothing failing', () => {
    const mat = stashed({ hasTrueSdf: false });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false when mtsdfUniforms is absent — such a material silently ignores updateMtsdfStyle, so reusing it would freeze the text\'s style', () => {
    const mat = stashed({}, { uniforms: false });
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });

  it('returns false for a material with no mtsdfAtlas stash at all — not a mtsdf material', () => {
    const mat = stubMaterial({});
    expect(canReuseMtsdfMaterial(mat, tex, atlas.width, atlas.height, atlas.distanceRange, atlas.size, atlas.hasTrueSdf)).toBe(false);
  });
});

/** Round-trip coverage: every test above hand-builds the `userData` shape, so NOTHING in
 *  the repo actually runs `makeMtsdfMaterial`'s stamp against `canReuseMtsdfMaterial`'s
 *  read of it. A producer/consumer pair like this can drift silently — dropping a single
 *  stashed field (`store.mtsdfTexture = tex;`, or `width`/`height`/`hasTrueSdf` from the
 *  `mtsdfAtlas` literal) makes `canReuseMtsdfMaterial` return `false` FOREVER in
 *  production, turning the #692 3D reuse fix into a complete no-op (a fresh TSL node
 *  material + shader recompile per page on every layout change) while every hand-built
 *  test above stays green, because none of them exercises the real stamp. This pins the
 *  two functions AGAINST EACH OTHER. */
describe('makeMtsdfMaterial + canReuseMtsdfMaterial round trip (#692)', () => {
  // Derived from the Text3D trait's own defaults rather than invented numbers — see
  // Text3D.ts. `color` is the only required MtsdfStyle field.
  // ⚠️ `.schema`, not `Text3D({})`: CALLING a koota trait returns an INSTANCE TUPLE
  // (`[Trait, Partial<T>]`), not the defaults object, so reading fields off the call result
  // type-errors on every one of them. Same access `mtsdfEffectBudget.test.ts` uses.
  const defaults = (Text3D as unknown as { schema: {
    color: number; opacity: number; weight: number;
    outlineColor: number; outlineWidth: number; outlineOpacity: number;
    glowColor: number; glowSize: number; glowStrength: number;
    shadowColor: number; shadowOpacity: number;
    shadowOffsetX: number; shadowOffsetY: number; shadowSoftness: number;
  } }).schema;
  const style: MtsdfStyle = {
    color: defaults.color,
    opacity: defaults.opacity,
    weight: defaults.weight,
    outlineColor: defaults.outlineColor,
    outlineWidth: defaults.outlineWidth,
    outlineOpacity: defaults.outlineOpacity,
    glowColor: defaults.glowColor,
    glowSize: defaults.glowSize,
    glowStrength: defaults.glowStrength,
    shadowColor: defaults.shadowColor,
    shadowOpacity: defaults.shadowOpacity,
    shadowOffsetX: defaults.shadowOffsetX,
    shadowOffsetY: defaults.shadowOffsetY,
    shadowSoftness: defaults.shadowSoftness,
  };

  it('a material built by the real makeMtsdfMaterial is accepted by canReuseMtsdfMaterial for the same inputs', () => {
    const mat = makeMtsdfMaterial(tex, 512, 512, 8, 32, style, true);
    expect(canReuseMtsdfMaterial(mat, tex, 512, 512, 8, 32, true)).toBe(true);
  });

  it('is rejected for a DIFFERENT texture object — not vacuous in the texture dimension', () => {
    const mat = makeMtsdfMaterial(tex, 512, 512, 8, 32, style, true);
    const otherTex = {} as THREE.Texture;
    expect(canReuseMtsdfMaterial(mat, otherTex, 512, 512, 8, 32, true)).toBe(false);
  });

  it('is rejected when hasTrueSdf differs — not vacuous in the build-time-branch dimension', () => {
    const mat = makeMtsdfMaterial(tex, 512, 512, 8, 32, style, true);
    expect(canReuseMtsdfMaterial(mat, tex, 512, 512, 8, 32, false)).toBe(false);
  });
});
