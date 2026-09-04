// @vitest-environment jsdom
/** Regression cover for the #590 root-cause fix in `mtsdfPixiShader.ts`: an uncapped
 *  WebGL program leak on the 2D text path that killed the WebKit GPU process on an iPhone 8
 *  (measured: a kill at 6m08s before the fix, 380 minutes with no kill after).
 *
 *  Two mechanisms make the fix work, and both need cover here — a mutation check proved
 *  neither had any:
 *
 *   1. The module-level program cache in `getMtsdfPrograms()` — without it, every
 *      `makeMtsdfPixiShader` call ends in a fresh `new GlProgram(...)`, and PixiJS compiles
 *      and links a brand-new `WebGLProgram` that is never freed (the library has no
 *      `gl.deleteProgram` call site).
 *   2. The fixed `#define SHADER_NAME` in `mtsdfBitGl`'s vertex/fragment headers — without
 *      it, Pixi's `setProgramName` stamps an INCREMENTING define into the source before the
 *      program's cache key is computed, so identical source hashes to a different key every
 *      call and the GL program cache (`getMtsdfPrograms`'s own `??=`, and `GlShaderSystem`'s
 *      internal one) always misses.
 *
 *  See the "Program cache (fixes #590)" comment block in `mtsdfPixiShader.ts` for the full
 *  mechanism writeup. */
import { describe, it, expect } from 'vitest';
import { mtsdfShaderBitsForTest, mtsdfProgramsForTest } from '../../src/runtime/rendering/text/mtsdfPixiShader';

describe('mtsdf GLSL programs declare a fixed SHADER_NAME (stops Pixi injecting an incrementing one)', () => {
  const { glsl } = mtsdfShaderBitsForTest();

  // Asserted separately on vertex and fragment — `setProgramName` runs once PER SOURCE, so a
  // define on one side says nothing about the other.
  it('the vertex header declares #define SHADER_NAME', () => {
    expect(glsl.vertex.header).toMatch(/#define\s+SHADER_NAME\b/);
  });

  it('the fragment header declares #define SHADER_NAME', () => {
    expect(glsl.fragment.header).toMatch(/#define\s+SHADER_NAME\b/);
  });
});

describe('mtsdf programs are built once and shared across calls', () => {
  // ⚠️ THIS is the one that guards our own fix. Mutation-checked: reverting
  // `cachedGlProgram ??=` to `=` turns it red ("expected _GlProgram to be _GlProgram //
  // Object.is equality"). The GL path is also the ONLY one that leaked in #590 — the iPhone 8
  // has no WebGPU.
  it('getMtsdfPrograms returns the SAME glProgram instance on repeated calls (the #590 fix itself)', () => {
    const first = mtsdfProgramsForTest();
    const second = mtsdfProgramsForTest();
    expect(second.glProgram).toBe(first.glProgram);
  });

  // ⚠️ This one does NOT guard our `??=` — it CANNOT fail from that regression, and saying so
  // is the point of this comment. Mutation-checked: with `cachedGpuProgram ??=` reverted to `=`
  // it still passes, because `GpuProgram.from()` is content-cached inside PixiJS, so a second
  // construction from identical descriptors hands back the same instance anyway.
  //
  // It is kept because it pins an UPSTREAM property we depend on rather than one we implement:
  // if a future PixiJS drops that internal cache, the WebGPU text path starts minting a program
  // per rebuild — #590's shape on the devices that DO have WebGPU (the owner's iPhone Air,
  // where #380-#384 were found and nothing else reproduces). A pixi upgrade turning this red is
  // the signal, and it would otherwise be silent.
  it('PixiJS still content-caches GpuProgram.from, so the WebGPU path shares one too (upstream contract, not ours)', () => {
    const first = mtsdfProgramsForTest();
    const second = mtsdfProgramsForTest();
    expect(second.gpuProgram).toBe(first.gpuProgram);
  });
});
