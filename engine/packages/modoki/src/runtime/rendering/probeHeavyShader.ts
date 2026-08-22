// HMR: this module's TSL nodes bake into compiled WGSL pipelines, so an edit here needs a full
// RELOAD, not a hot patch — same rule as `npr/**` and `postfx/**`. Note the dev server does NOT
// force one by path here (`isShaderGraphFile` only covers those two directories), so after editing
// this file, reload the editor by hand before believing a measurement from it.

/** The boot probe's HEAVY fragment shader (#188) — the axis the quality tiers actually gate.
 *
 *  ── WHY THIS EXISTS AS ITS OWN MODULE ─────────────────────────────────────────────────────
 *  Two reasons, and the second is the one that earned it. It keeps a TSL graph out of
 *  `rampProbeRunner.ts` (see the HMR note above — a hot-patched node graph leaves the OLD shader
 *  rendering and makes a correct fix look broken). And it makes the material reachable on its own,
 *  which is what lets `renderer.debug.getShaderAsync` be pointed at it: on a node-graph question
 *  the generated WGSL is the primary evidence, and a graph buried inside a probe that disposes its
 *  renderer in a `finally` is a graph nobody can read.
 *
 *  ── WHAT IT MEASURES, AND WHY NOT FILL ────────────────────────────────────────────────────
 *  ⚠️ **RAW FILL DOES NOT RANK MODERN MOBILE GPUs.** Timed on the GPU clock during boot, a Galaxy
 *  A23's fill time does not move with load at all — eight times the work, the same ~11 ms — because
 *  297 Mpx of dumb overdraw costs it less than the clock's own floor. Every phone in range is
 *  adequate at fill. And fill is not what the tiers gate: `TIER_SETTINGS` turns off IBL lookups,
 *  NPR post-FX and shadow sampling, which are texture-sampling and ALU. This shader prices that.
 *
 *  ── THE DEPENDENCY IS THE WHOLE DESIGN ────────────────────────────────────────────────────
 *  Each tap samples at a coordinate computed from the PREVIOUS tap's result, so tap N+1 cannot
 *  begin until tap N returns. A compiler may unroll the loop — that changes nothing — but it can
 *  neither hoist nor constant-fold the samples, because it cannot know a texel's value. A
 *  uniform-trip-count ARITHMETIC loop offers no such guarantee, which is exactly why this is not
 *  one, and why the accumulator is returned rather than dropped: an unread result is dead code and
 *  a shader compiler is entitled to delete the chain that produced it. */

import * as THREE from 'three/webgpu';
import { Fn, Loop, texture as tslTexture, uv, vec3, vec4 } from 'three/tsl';

/** Dependent texture reads per fragment.
 *
 *  16 because that is roughly what a tier drop removes per lit fragment — IBL is 2-3 cubemap
 *  lookups and a shadow is a 4-9 tap PCF kernel — so the probe's unit of work resembles the
 *  decision it informs. */
export const SHADE_TAPS = 16;

/** Side of the source texture, texels. 64x64 RGBA8 is 16 KB: small enough to sit entirely in the
 *  texture cache on any GPU in range, which is deliberate. This ramp prices SAMPLER AND ALU
 *  throughput; a texture big enough to thrash would make the reading about the memory system and
 *  would reintroduce the unbounded-traffic hazard the fixed shading region exists to remove. */
const TEX_SIZE = 64;

export interface HeavyShadeAssets {
  material: THREE.NodeMaterial;
  texture: THREE.DataTexture;
}

export function makeHeavyShadeAssets(): HeavyShadeAssets {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const x = i % TEX_SIZE;
    const y = (i / TEX_SIZE) | 0;
    // Derived from the index — never `Math.random()`, which the determinism guard rejects in
    // `runtime/**` and which would also make two probes on one device disagree. The multipliers are
    // coprime with the texture size so the walk below scatters rather than settling into a short
    // cycle over a handful of texels.
    data[i * 4 + 0] = (x * 37 + y * 17) & 0xff;
    data[i * 4 + 1] = (x * 11 + y * 53) & 0xff;
    data[i * 4 + 2] = (x * 7 + y * 29) & 0xff;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, TEX_SIZE, TEX_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // ⚠️ NO MIPMAPS. A sampler picks its level from the SCREEN-SPACE DERIVATIVE of the coordinate,
  // and this coordinate is a dependent chain whose derivative is meaningless — so with mipmaps the
  // level would vary unpredictably between devices and drivers, and the ramp would be timing a
  // different amount of memory traffic on each. One level, one answer.
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const sampler = tslTexture(texture);
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  // ⚠️ **ADDITIVE, AND WITHOUT IT THIS RAMP MEASURES NOTHING AT ALL.** Measured on an M-series GPU
  // over CDP: opaque, the ramp is FLAT — 2048 stacked instances cost 0.60 ms against one instance's
  // 0.40, and 256 dependent taps cost exactly what 1 tap costs. That is tile-based HIDDEN SURFACE
  // REMOVAL: the quads are coplanar and opaque, so the GPU resolves which fragment survives BEFORE
  // running the fragment shader, and 2047 of every 2048 shader invocations never happen. Every
  // mobile GPU in range is tile-based, so this is the target hardware's normal behaviour, not an
  // Apple curiosity.
  //
  // A BLENDED fragment contributes to the result, so no HSR may drop it. The same A/B, additive:
  // 0.50 ms at one instance, 4.30 ms at 2048 — real, load-proportional work. The blend itself costs
  // a constant per fragment, which the slope estimator cancels exactly as it cancels every other
  // fixed per-fragment cost.
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  (material as unknown as { colorNode: unknown }).colorNode = Fn(() => {
    const p = uv().toVar();
    const acc = vec3(0).toVar();
    Loop(SHADE_TAPS, () => {
      const s = sampler.sample(p);
      // THE DEPENDENCY: the next coordinate comes out of the texel just read.
      p.assign(s.xy.mul(0.97).add(p.mul(0.31)).fract());
      acc.addAssign(s.xyz);
    });
    return vec4(acc.div(SHADE_TAPS), 1);
  })();

  return { material, texture };
}
