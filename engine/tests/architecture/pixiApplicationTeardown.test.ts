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
import { censusRendererSources } from './rendererConstructionCensus';

/** A `destroy` given a bare boolean: `.destroy(true)` / `.destroy(false)`, any whitespace.
 *  Deliberately NOT anchored to a receiver named `app` — the defect is the ARGUMENT, and the next
 *  site will spell its variable something else. */
const BOOLEAN_DESTROY = /\.destroy\s*\(\s*(?:true|false)\s*\)/g;

/** Files whose `.destroy(<boolean>)` calls are a DIFFERENT API with a different parameter —
 *  `Texture.destroy(destroySource)`, `Geometry.destroy(destroyBuffers)`, `Shader.destroy(...)`,
 *  `Container.destroy(options)`. Only `Application.destroy`'s first argument reaches
 *  `AbstractRenderer.destroy`, so those are not this defect and must not be swept in.
 *
 *  ⚠️ Listed by FILE, so this allowlist is honest about being coarse: it says "this file's boolean
 *  destroys were read and are not Applications", not "any boolean destroy here is fine". A file
 *  that later gains an `Application` needs re-reading — which the Application census below is what
 *  actually forces. */
const NON_APPLICATION_DESTROY_FILES = new Set([
  'packages/modoki/src/runtime/rendering/Scene2D.tsx',            // Texture / Geometry / Shader
  'packages/modoki/src/runtime/rendering/videoTextureSync2D.ts',  // Texture
  'packages/modoki/src/runtime/rendering/text/fontTexturePixi.ts',// Texture
  'packages/modoki/src/runtime/particles/pixiParticleObject.ts',  // Texture
]);

// ⚠️ **`ShaderPreview.tsx` was on this list and has been REMOVED.** It contains zero
// `.destroy(<boolean>)` calls (measured), so the entry protected nothing — while excusing the one
// EDITOR file that constructs a Pixi `Application`, i.e. the third live surface this whole guard
// exists for. Adding a file here because it "probably has Texture destroys" is how a guard loses
// its subject; every entry above was counted first.

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
    const offenders: string[] = [];
    for (const { file, stripped } of censusRendererSources()) {
      const r = rel(file);
      if (NON_APPLICATION_DESTROY_FILES.has(r)) continue;
      const hits = stripped.match(BOOLEAN_DESTROY);
      if (hits) offenders.push(`${r}: ${hits.join(', ')}`);
    }

    expect(offenders, 'destroy(true) sweeps Pixi\'s process-global pools for EVERY live surface; '
      + 'destroy(false) is the same call with the sweep off, and neither says which it meant. Pass '
      + 'an options object through destroyPixiApplication instead').toEqual([]);
  });
});
