/** Guard: no Pixi `Application` is torn down with the BOOLEAN `destroy` form (#1000).
 *
 *  `app.destroy(true)` does not merely destroy that Application. `AbstractRenderer.destroy` tests
 *  `options === true || (typeof options === 'object' && options.releaseGlobalResources)`, so the
 *  boolean form ALWAYS trips `GlobalResourceRegistry.release()` — clearing Pixi's process-global
 *  pools, `TexturePool` among them, which is keyed by packed dimensions with no renderer identity.
 *  One surface's slot teardown therefore reached into a pool every other live surface draws from,
 *  and the surface that WARNED was not the one that did it. Three live Applications make that
 *  reachable in the editor (GameView's pool, SceneView's own pool, the ShaderPreview panel).
 *
 *  ⚠️ Cited by SYMBOL, not by line (#966) — a dependency's line numbers move on every bump and
 *  nothing watches them.
 *
 *  ## Why a guard, and not just the rule written down
 *
 *  It was written down. `pixiGlobalResources.ts` says "Never call `app.destroy(true)` directly" in
 *  bold, and a rule stated in a doc comment is exactly what this repo has already watched fail:
 *  `glContextRelease.test.ts` records that `forceContextLoss` was "documented TWICE and guarded
 *  nowhere, which is how `ModelPreview.tsx` shipped without the call (#776)". The fourth Pixi
 *  surface someone adds is the one that writes `destroy(true)` and reopens #1000 with `verify`
 *  green.
 *
 *  This is the THIRD property over the same construction census as `glContextRelease.test.ts`
 *  (release on teardown) and `rendererLossHandling.test.ts` (detect on construction). Kept as its
 *  own file for the same reason those two are: a red must never be ambiguous about which property
 *  broke.
 *
 *  The scan runs on comment-stripped source, so `destroy(true)` written in a comment — this file's
 *  own prose included — cannot trip it. */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { censusRendererSources } from './rendererConstructionCensus';

/** A `destroy` given a bare boolean: `.destroy(true)` / `.destroy(false)`, any whitespace.
 *  Deliberately NOT anchored to a receiver named `app` — the defect is the ARGUMENT, and the next
 *  site will spell its variable something else. */
const BOOLEAN_DESTROY = /\.destroy\s*\(\s*(?:true|false)\s*\)/g;

/** Boolean destroys that are a DIFFERENT API with a different parameter — `Texture.destroy
 *  (destroySource)`, `Geometry.destroy(destroyBuffers)`. Only `Application.destroy`'s first
 *  argument reaches `AbstractRenderer.destroy`, so those are not this defect.
 *
 *  ⚠️ **Keyed by `file::receiver.destroy(arg)` and SPENT, not by file (#1140).** This was a
 *  `Set<file>` that skipped every hit in the file, so an `app.destroy(true)` written into
 *  `Scene2D.tsx` — a file that holds a Pixi surface's whole render loop — was invisible to the guard
 *  whose subject it is. Each row below is one call site that was read; a second `tex.destroy(false)`
 *  needs its row's `count` raised and a sentence saying what that receiver is.
 *
 *  ⚠️ `ShaderPreview.tsx` was once a file row here while holding zero boolean destroys — excusing
 *  the one EDITOR file that constructs an `Application`. The ledger's over-blessed arm now reports
 *  that shape instead of relying on somebody measuring it. */
const NON_APPLICATION_DESTROYS: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  { item: 'packages/modoki/src/runtime/rendering/Scene2D.tsx::g.destroy(true)',
    reason: '`releaseGeometry(g: Geometry)` — `destroyBuffers`, not an Application' },
  { item: 'packages/modoki/src/runtime/rendering/Scene2D.tsx::tex.destroy(false)', count: 2,
    reason: 'Texture wrappers over a kept source — `destroySource: false`' },
  { item: 'packages/modoki/src/runtime/rendering/Scene2D.tsx::p.tex.destroy(true)',
    reason: '`flushPendingMaskDestroy` — the mask RenderTexture queued in `pendingMaskDestroy` (#455)' },
  { item: 'packages/modoki/src/runtime/rendering/Scene2D.tsx::oldTex.destroy(false)', count: 2,
    reason: 'a replaced Texture wrapper whose source is still referenced — `destroySource: false`' },
  { item: 'packages/modoki/src/runtime/rendering/videoTextureSync2D.ts::tex.destroy(true)', count: 2,
    reason: 'the `pendingDestroy` queue of video Textures — their VideoSource is this module\'s alone' },
  { item: 'packages/modoki/src/runtime/rendering/videoTextureSync2D.ts::b.texture.destroy(true)',
    reason: '`disposeVideoTextures2D` — the same per-binding video Texture' },
  { item: 'packages/modoki/src/runtime/rendering/text/fontTexturePixi.ts::created.destroy(true)',
    reason: 'the atlas Texture this module constructed over its own CanvasSource' },
  { item: 'packages/modoki/src/runtime/rendering/text/fontTexturePixi.ts::tex.destroy(true)',
    reason: 'a cached atlas Texture dropped when its font is invalidated (re-bake / axis flip)' },
  { item: 'packages/modoki/src/runtime/particles/pixiParticleObject.ts::f.destroy(false)',
    reason: 'per-frame sub-Texture wrappers; the shared source belongs to the Assets cache' },
];

/** The receiver text before `.destroy` — the thing that tells two boolean destroys in one file
 *  apart. Anchored at the END of the text preceding the match, so `p.tex` is taken whole. */
function destroyReceiver(before: string): string {
  return /([\w$]+(?:\??\.[\w$]+)*\??)\s*$/.exec(before)?.[1] ?? '?';
}

const rel = (file: string) => path.relative(path.resolve(__dirname, '../..'), file).replace(/\\/g, '/');

describe('Pixi Application teardown (#1000)', () => {
  it('no file constructs a Pixi Application without importing the teardown helper', () => {
    const offenders = censusRendererSources()
      .filter(({ stripped }) => /new\s+Application\s*\(/.test(stripped))
      // ⚠️ `\(` is load-bearing: without it the bare `import { destroyPixiApplication }` line
      // satisfies this filter, so a file that imports the helper and then calls `app.destroy(true)`
      // anyway reads as compliant. That is the called-symbol trap, and it is exactly how the
      // ShaderPreview hole below stayed invisible.
      .filter(({ stripped }) => !/destroyPixiApplication\s*\(/.test(stripped))
      .map(({ file }) => rel(file));

    expect(offenders, 'a Pixi Application must be torn down via destroyPixiApplication — see '
      + 'runtime/rendering/pixiGlobalResources.ts').toEqual([]);
  });

  // The census must actually be finding the Applications, or the assertion above passes because it
  // looked at nothing. Publish the contrast, not the count: this names the sites, so a producer
  // that silently stops matching reads as an empty list rather than as a pass.
  it('and the census still SEES all of them, so the guard above cannot pass vacuously', () => {
    const sites = censusRendererSources()
      .filter(({ stripped }) => /new\s+Application\s*\(/.test(stripped))
      .map(({ file }) => rel(file))
      .sort();

    expect(sites).toEqual([
      'packages/modoki/src/editor/panels/ShaderPreview.tsx',
      'packages/modoki/src/runtime/rendering/canvas2DPool.ts',
    ]);
  });

  it('no Application is destroyed with the boolean form anywhere in the census', () => {
    const population: Array<{ item: string; site: string }> = [];
    for (const { file, stripped } of censusRendererSources()) {
      const r = rel(file);
      for (const m of stripped.matchAll(BOOLEAN_DESTROY)) {
        const call = m[0].replace(/^\.destroy\s*\(\s*/, '.destroy(').replace(/\s*\)$/, ')');
        population.push({
          item: `${r}::${destroyReceiver(stripped.slice(0, m.index))}${call}`,
          site: `${r}:${stripped.slice(0, m.index).split('\n').length}`,
        });
      }
    }

    assertExemptionLedger({
      label: 'NON_APPLICATION_DESTROYS in pixiApplicationTeardown',
      population,
      exempt: NON_APPLICATION_DESTROYS,
      floor: 1,
      fix: 'destroy(true) sweeps Pixi\'s process-global pools for EVERY live surface; destroy(false) '
        + 'is the same call with the sweep off, and neither says which it meant. Pass an options '
        + 'object through destroyPixiApplication instead',
    });
  });
});
