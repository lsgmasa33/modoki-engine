// @vitest-environment jsdom
/** getFontTexture (the Three.js atlas-texture cache) — #828: this module had ZERO tests, so its
 *  `${provider.id}:...` cache keys were never proven to actually discriminate between two live
 *  font providers. Every OTHER reference to this module (`text3DMaterialReuse.test.ts`) mocks it
 *  away entirely, so a regression collapsing the per-provider cache to a shared one would pass
 *  every existing gate.
 *
 *  Covers four things, per the module's own comments:
 *   1. two providers with different `id`s get DISTINCT textures for the same page (the cache-key
 *      discriminant this whole file is about).
 *   2. the `uploadedVersion`/`atlasVersion` re-upload path on the dynamic (canvas) branch — a
 *      version bump bumps the texture's `version` (via `needsUpdate = true`) exactly once per
 *      bump, not once per call.
 *   3. baked page 0 is deliberately EXCLUDED from versioning (its key has no atlasVersion — see
 *      fontTextureThree.ts's comment on why).
 *   4. the module registers TWO separate `addDisposable` eviction closures — one in the canvas
 *      branch, one in the baked branch — and each is exercised on its OWN branch: driving the
 *      canvas branch's closure disposes/evicts only that branch's cache entry, and likewise for
 *      the baked branch's. A test that only ever built a canvas provider would leave the baked
 *      branch's closure — and a regression to it — untouched. */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { getFontTexture } from '../../src/runtime/rendering/text/fontTextureThree';
import type { FontProvider } from '../../src/runtime/rendering/text/fontProvider';

/** A dynamic-style fake provider: `atlasCanvasAt` returns a real canvas, so `getFontTexture`
 *  takes the CanvasTexture branch. `addDisposable` just records the last registered closure —
 *  enough for these tests, which never register more than one per provider. */
function canvasProvider(id: string, atlasVersion = 1): FontProvider & { __runDispose: () => void } {
  const canvas = document.createElement('canvas');
  let disposeFn: (() => void) | undefined;
  return {
    id,
    atlasVersion,
    atlasCanvasAt: () => canvas,
    addDisposable: (fn: () => void) => { disposeFn = fn; },
    // test-only accessor
    __runDispose: () => disposeFn?.(),
  } as unknown as FontProvider & { __runDispose: () => void };
}

/** A baked-style fake provider: no `atlasCanvasAt` at all, so page 0 takes the immutable-image
 *  branch (`loader.load(...)`, no version gating at all). `addDisposable` records the closure
 *  (same shape as `canvasProvider`'s, not a `() => {}` stub) so a test can actually drive the
 *  BAKED branch's own eviction path — a stub here would leave that closure untestable and a
 *  regression to it silent. */
function bakedProvider(id: string, atlasVersion = 0): FontProvider & { atlasVersion: number; __runDispose: () => void } {
  let disposeFn: (() => void) | undefined;
  return {
    id,
    atlasVersion,
    atlasImageUrl: `/fonts/${id}~atlas.png`,
    addDisposable: (fn: () => void) => { disposeFn = fn; },
    // test-only accessor
    __runDispose: () => disposeFn?.(),
  } as unknown as FontProvider & { atlasVersion: number; __runDispose: () => void };
}

describe('per-provider discriminant — two providers, same page', () => {
  it('two providers with different ids get DISTINCT textures for the SAME page', () => {
    const a = canvasProvider('font-a');
    const b = canvasProvider('font-b');

    const texA = getFontTexture(a, 0);
    const texB = getFontTexture(b, 0);

    expect(texA).toBeTruthy();
    expect(texB).toBeTruthy();
    expect(texB, 'a shared cache would hand provider B the texture built for A').not.toBe(texA);
  });

  it('building B does not disturb A\'s own cache hit', () => {
    const a = canvasProvider('font-a2');
    const b = canvasProvider('font-b2');

    const firstA = getFontTexture(a, 0);
    getFontTexture(b, 0); // touch the cache for a second provider in between
    const secondA = getFontTexture(a, 0);

    expect(secondA, 'A must still be served from its own cache entry').toBe(firstA);
  });
});

describe('dynamic (canvas) page — uploadedVersion re-upload gating', () => {
  it('bumps the texture version exactly once per atlasVersion bump, not once per call', () => {
    const p = canvasProvider('font-version', 1);

    const tex = getFontTexture(p, 0) as THREE.CanvasTexture;
    const afterBuild = tex.version;

    // Same atlasVersion again — must NOT re-upload.
    getFontTexture(p, 0);
    expect(tex.version, 'no atlasVersion change → no needsUpdate bump').toBe(afterBuild);

    // atlasVersion bumps once — must re-upload exactly once.
    (p as { atlasVersion: number }).atlasVersion = 2;
    getFontTexture(p, 0);
    expect(tex.version, 'one atlasVersion bump → exactly one needsUpdate bump').toBe(afterBuild + 1);

    // Calling again at the SAME (new) atlasVersion must not bump a second time.
    getFontTexture(p, 0);
    expect(tex.version, 'a second call at the same version must not re-bump').toBe(afterBuild + 1);
  });
});

describe('baked page 0 — excluded from versioning', () => {
  it('page 0\'s image texture is unaffected by atlasVersion bumps (key carries no version)', () => {
    const p = bakedProvider('font-baked');

    const tex = getFontTexture(p, 0);
    expect(tex).toBeTruthy();

    // A baked-seeded dynamic font bumps atlasVersion on every generated glyph batch — page 0's
    // IMMUTABLE image must not be affected: same object back, no rebuild.
    (p as { atlasVersion: number }).atlasVersion = 99;
    expect(getFontTexture(p, 0), 'the baked image is cached independently of atlasVersion').toBe(tex);
  });
});

describe('addDisposable eviction — each branch registers, and is exercised on, ITS OWN closure', () => {
  // The canvas branch and the baked branch each register their OWN `addDisposable` closure
  // (fontTextureThree.ts's two `provider.addDisposable(() => { ... })` call sites), over two
  // separate cache entries (`${id}:canvas:${page}` vs `${id}:image`). These two tests must stay
  // INDEPENDENT: deleting either branch's closure in the source must redden only its own test here,
  // never the other one.
  it('the CANVAS branch\'s addDisposable closure disposes the texture and drops its cache entry', () => {
    const p = canvasProvider('font-dispose');
    const tex = getFontTexture(p, 0) as THREE.CanvasTexture;
    const disposeSpy = vi.spyOn(tex, 'dispose');

    p.__runDispose();

    expect(disposeSpy, 'the texture must be disposed').toHaveBeenCalledTimes(1);

    // The cache entry is gone — the next call mints a fresh texture, not the disposed one.
    const rebuilt = getFontTexture(p, 0);
    expect(rebuilt, 'a rebuilt texture after eviction must be a NEW object').not.toBe(tex);
  });

  it('the BAKED branch\'s addDisposable closure disposes the texture and drops its cache entry', () => {
    const p = bakedProvider('font-baked-dispose');
    const tex = getFontTexture(p, 0) as THREE.Texture;
    const disposeSpy = vi.spyOn(tex, 'dispose');

    p.__runDispose();

    expect(disposeSpy, 'the baked texture must be disposed').toHaveBeenCalledTimes(1);

    // The cache entry is gone — the next call mints a fresh texture, not the disposed one.
    const rebuilt = getFontTexture(p, 0);
    expect(rebuilt, 'a rebuilt baked texture after eviction must be a NEW object').not.toBe(tex);
  });
});
