/** Guard: every renderer/app construction site also wires GPU-context-loss DETECTION (#795).
 *
 *  Before this guard, detection was wired per construction site rather than by a shared contract:
 *  `canvas2DPool.ts` and the 3D viewports (`Scene3D.tsx`/`SceneView.tsx`, via
 *  `core/activeRenderer.ts`'s `setActiveRenderer`) had it; `ShaderPreview.tsx`'s Pixi
 *  `Application`, `previewScene.ts`'s and `ModelPreview.tsx`'s bare `THREE.WebGLRenderer` had NONE
 *  — a lost context left those surfaces permanently blank with no error anywhere. See
 *  `runtime/rendering/rendererLossHandling.ts`'s file header for the full mechanism.
 *
 *  This is the sibling of `glContextRelease.test.ts`, sharing its file-walk + comment-strip
 *  census (`rendererConstructionCensus.ts`) but checking a DIFFERENT property over the same
 *  construction sites — release-on-teardown there, detect-on-construction here. Kept as two
 *  files on purpose: a red in one must not be ambiguous with the other.
 *
 *  Accepted evidence a file wires detection for what it constructs: a call into the shared module
 *  (`attachRendererLossHandling`/`attachContextLossListeners`/`attachDeviceLostListener`). That is
 *  the ONLY accepted route.
 *
 *  ⚠️ `setActiveRenderer(` is deliberately NOT accepted as evidence, though the two 3D viewports
 *  do get real detection through it (`core/activeRenderer.ts`'s `attachGpuFaultListeners`). It was
 *  accepted in this guard's first draft, and that made the guard unable to police the one surface
 *  in #795's own family that ALSO calls `setActiveRenderer` — deleting `ParticleEditor.tsx`'s
 *  attach call left this test GREEN. Worse, that route's detection is conditional on winning a
 *  single global slot another renderer can take (#802), so blessing it would let a future panel
 *  pass this guard while holding detection that can be silently disarmed. The two viewports are
 *  allowlisted BY NAME below instead, so the exemption cannot spread to a new call site.
 *
 *  The scan runs on comment-stripped source, so a mention in a comment alone cannot satisfy the
 *  pairing.
 *
 *  ⚠️ The guard is FILE-granular, not construction-SITE-granular: it asks "does this file contain
 *  a construction AND an attach call anywhere in it", not "does this specific construction get
 *  paired with its own attach call". A file that constructs two renderers and wires detection for
 *  only one of them still passes. `canvas2DPool.ts` is already such a file (two constructions —
 *  the WebGL Application and its WebGPU device — sharing one file that clearly attaches both), so
 *  this is a known, accepted shape here, not a hypothetical (adversarial review of #795). */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { censusRendererSources } from './rendererConstructionCensus';

// The three renderer/app classes this family of surfaces constructs, plus the TWO factories that
// wrap them — `makeWebGPURenderer(` and `createRenderer(`. Both wrappers are needed: a call site
// that only ever names the factory constructs a renderer just as surely as one that says `new`,
// and `Scene3D.tsx` (the SHIPPED-GAME 3D surface) reaches its renderer solely through
// `createRenderer`. Omitting that second wrapper left Scene3D matched by nothing — not policed,
// and not allowlisted either, so nobody could tell it was uncovered. Found by the #795 close-out
// sweep. Both factories also match their own declaration sites in `scene3DSync.ts`, which is
// allowlisted by name below.
const CONSTRUCT_RE = /\bnew\s+(?:THREE\.)?WebGLRenderer\s*\(|\bnew\s+WebGPURenderer\s*\(|\bmakeWebGPURenderer\s*\(|\bcreateRenderer\s*\(|\bnew\s+Application\s*\(/;

const ATTACH_RE = /\battach(?:RendererLossHandling|ContextLossListeners|DeviceLostListener)\s*\(/;

// `editor/panels/assetViews/encodeUltraHDR.ts` is documented here for a HUMAN reader, not this
// guard: `@monogrid/gainmap-js`'s `encodeAndCompress` constructs its own throwaway WebGLRenderer
// internally when none is passed, which never appears in this file as a literal `new
// WebGLRenderer(`/`makeWebGPURenderer(`/etc. — so `CONSTRUCT_RE` can never match it and it can
// never reach the offenders list either way. It is NOT in `ALLOWLIST` below (adversarial review
// of #795 found it there, inert — an allowlist entry a construction-site scan can never even
// test is not doing the job an allowlist entry implies). `glContextRelease.test.ts` documents the
// same fact for the same reason.

// Genuinely transient probes — a construction site with no lasting surface to go blank, or one
// invisible to our own tracking:
const ALLOWLIST = new Map<string, string>([
  // `capsProbeRenderer.ts` BUILDS the probe renderer and hands it back — it is the CALLER
  // (`ensureKtx2Caps` in `textureResolver.ts`) that disposes it, immediately after
  // `detectSupport()` returns, within the same call chain. Either way there is no lasting
  // surface for a lost context to leave blank, so wiring detection would have nothing to detect
  // for. Named as an exception in the #795 design brief; reason corrected in the adversarial
  // review of #795 — the original text claimed this file disposes it, which the file's own doc
  // comment ("the returned renderer is the caller's to dispose") contradicts.
  ['runtime/rendering/capsProbeRenderer.ts', 'built here, disposed by the caller right after use — no lasting surface either way'],
  // The two 3D viewport routes, which DO have detection — via `setActiveRenderer` ->
  // `core/activeRenderer.ts`'s `attachGpuFaultListeners`, live since well before this guard.
  // Named individually rather than matched by a `setActiveRenderer(` pattern, so the exemption
  // covers exactly these two files and cannot be inherited by a new construction site. Migrating
  // them onto the shared module would let both entries go, and is the natural follow-up to #802 —
  // that issue is precisely about this route's detection being disarmable.
  ['editor/panels/SceneView.tsx', 'detection via setActiveRenderer -> attachGpuFaultListeners (see #802)'],
  ['runtime/rendering/scene3DSync.ts', 'detection via setActiveRenderer -> attachGpuFaultListeners (see #802)'],
  // The shipped-game 3D viewport. It has the FULLEST coverage of any surface here — detection via
  // `createRenderer` -> `setActiveRenderer`, plus its own `onRendererLost` subscription driving a
  // `createRendererRecovery` rebuild — but it wires that at the VIEWPORT rather than through the
  // shared module, so it needs the same by-name exemption as the other two. Listed rather than
  // matched by an `onRendererLost(` pattern, for the reason in the header: a pattern-shaped
  // exemption gets inherited by the next construction site that happens to contain the token.
  ['runtime/rendering/Scene3D.tsx', 'detection + recovery via onRendererLost/createRendererRecovery, wired at the viewport (see #802)'],
]);

describe('Renderer loss handling — every renderer/app construction site wires loss DETECTION', () => {
  it('every WebGLRenderer / WebGPURenderer / Pixi Application construction site attaches loss handling', () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const { file, stripped } of censusRendererSources()) {
      if (!CONSTRUCT_RE.test(stripped)) continue;
      sites++;
      if (ATTACH_RE.test(stripped)) continue;
      const rel = path.relative(path.resolve(__dirname, '../../packages/modoki/src'), file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      offenders.push(path.relative(process.cwd(), file));
    }
    // The guard is worthless if the query stopped matching anything — pin that it still finds the
    // surfaces it is meant to police (canvas2DPool, the three preview panels, the two 3D
    // viewports' shared factories, and the one allowlisted probe today).
    expect(sites).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
  });
});
