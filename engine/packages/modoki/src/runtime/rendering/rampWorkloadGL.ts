/** The boot probe's workloads, on a RAW WebGL2 context — no Three, no renderer, no scene (#203).
 *
 *  ── WHY THIS EXISTS: THE PROBE COULD NOT RUN ON A 2D PROJECT AT ALL ───────────────────────
 *  `rampProbeRunner` used to build a `WebGPURenderer` to measure with. That is fatal for exactly
 *  the projects that most needed a classifier:
 *
 *    - **`build.modules.render3d: false` DCEs `three/webgpu`** (~173 KB). `games/space-invader`
 *      drives the playable-ad export and its 5 MB budget; importing the probe would pull the whole
 *      3D renderer back into a bundle that deliberately excluded it.
 *    - **`disable3D: true`** (`games/chess`, `games/audio-demo`) mounts no `Scene3D`, so nothing
 *      ever called `makeWebGPURenderer` and no tier was ever resolved — every authored tier field
 *      on those projects was inert.
 *
 *  A raw WebGL2 context is available in every build regardless of module toggles.
 *  `deviceCaps.readGlFacts` already creates and disposes one on every device, so this is a proven
 *  seam rather than a new dependency.
 *
 *  ⭐ **ONE INSTRUMENT, NOT TWO — this REPLACED the Three path rather than joining it.** The
 *  tempting shape was "keep Three for 3D projects, add this for 2D ones", and it is wrong on this
 *  plan's own stated rule: *a number from a different instrument cannot calibrate this one*. Two
 *  backends would mean a phone could read one band on `sling` and another on `chess`, and the
 *  cross-project acceptance gate could never be satisfied by construction.
 *
 *  What deleting the Three path also removed, none of which was the goal but all of which was
 *  costing something:
 *    - **The renderer construction**, a measured slice of the blocked launch (reported separately
 *      as `rendererMs` precisely because it was large). A GL context costs a fraction of it.
 *    - **The re-entrancy hazard.** The probe built a renderer, renderer creation resolved a tier,
 *      and tier resolution ran the probe — an unbounded recursion that killed an iPhone 13 mini's
 *      tab in ~80 ms (`probeReentrancy.ts`). A probe that constructs no renderer cannot re-enter.
 *    - **The leaked GPU device** on the creation-timeout path (#205 close-out): `Promise.race`
 *      cancels nothing, so an abandoned `makeWebGPURenderer` could hand back a live WebGPU device
 *      that nothing disposed — on exactly the weak hardware the timeout fires for.
 *
 *  ── TWO WAYS THIS INSTRUMENT DIFFERS FROM THE ONE IT REPLACED, both deliberate ────────────
 *  Found by review rather than by writing it down first, so they are recorded here before they
 *  become a mystery in a band campaign:
 *
 *  1. **`antialias` is hardcoded OFF; the Three probe INHERITED the project's setting.** Its
 *     throwaway renderer was built by `makeWebGPURenderer`, which reads
 *     `getEffectiveThreeSettings().antialias` — so on a project authoring AA the old probe measured
 *     with MSAA on, and on one that did not it measured without. MSAA changes ROP and blend cost
 *     per fragment, which is exactly what these ramps price. That made the old readings
 *     PROJECT-DEPENDENT by construction, and the cross-project acceptance gate (§5 of the plan)
 *     unsatisfiable for a reason nobody had named. Hardcoding it off makes the instrument the same
 *     everywhere, which is the property a cross-device ranking needs.
 *  2. **No depth buffer, so no depth clear.** Three's renderer allocates one by default and
 *     `autoClear`/`autoClearDepth` clear it on every `render()`; this context requests
 *     `depth: false` and clears colour only. Every ramp here draws with depth off, so the buffer
 *     was pure cost. It is a CONSTANT per submit, which the slope estimator cancels — but not from
 *     the absolute comparisons (`ESCAPE_MULTIPLE x interval`, `ABORT_FRAME_MS`), so it is one more
 *     reason a v4 reading and a v5 reading are not interchangeable.
 *
 *  (Also checked and inert: Three's `AdditiveBlending` resolves to `blendFuncSeparate(SRC_ALPHA,
 *  ONE, ONE, ONE)` where this sets `blendFunc(SRC_ALPHA, ONE)` — the RGB factors, which are what
 *  the ramp reads, match exactly; the alpha factors differ and cannot matter, since the context
 *  has no alpha channel and both shaders write alpha 1.)
 *
 *  ⚠️ **The bands must be re-anchored against this instrument, and that is expected, not a
 *  regression.** The recorded band figures came from the Three path. They were already known not to
 *  transfer (all seven came from ONE project) and its deciding `shade` axis was measured reading
 *  1.6-3x low on Android, so nothing of value is being discarded. See the plan's § W2.
 *
 *  ── WHAT IS PRESERVED EXACTLY, AND WHY IT MUST BE ─────────────────────────────────────────
 *  Every workload below reproduces a property the Three version paid for in measurement:
 *    - **Additive blending, depth off.** Opaque stacked quads are FLAT on a tile-based GPU — hidden
 *      surface removal drops 2047 of 2048 shader invocations before they run, so an opaque ramp
 *      prices rasterization and calls itself fill. Measured: opaque 0.60 ms at 2048 instances
 *      against 0.40 at one; additive 4.30 against 0.50.
 *    - **One draw call for `fill`/`shade`, N for `draw`.** Instancing is what lets overdraw scale
 *      while submit cost does not — without it a Galaxy S22 read HALF a Galaxy A23 on "fill",
 *      which is impossible for fill and is the signature of measuring submit.
 *    - **A fixed 100 px shading region**, so the reading is comparable with no panel-size
 *      normalisation, and the worst submit is bounded before any measurement happens.
 *    - **16 dependent texture taps** from a 64x64 unmipped repeating texture, the coordinate for
 *      each read coming out of the texel just read. Ported line for line from
 *      `probeHeavyShader.ts`'s TSL — see there for why each of those choices is what it is.
 */

import { rawNow } from '../core/clock';
import { makeGpuClock, type GpuClock } from './gpuClock';
import type { RampKind } from './rampProbe';
import { noteGpuContextCreated, noteGpuContextDestroyed } from '../core/gpuContextTracking';

/** Dependent texture reads per fragment in the heavy shader. Kept identical to
 *  `probeHeavyShader.SHADE_TAPS` — the number models a tier's worth of per-fragment work (IBL is
 *  2-3 cubemap lookups, a shadow is a 4-9 tap PCF kernel). */
export const SHADE_TAPS = 16;

/** Side of the heavy shader's source texture, texels. 64x64 RGBA8 is 16 KB — small enough to sit
 *  entirely in texture cache on any GPU in range, deliberately: this ramp prices sampler and ALU
 *  throughput, and a texture big enough to thrash would make it a memory-system benchmark. */
const TEX_SIZE = 64;

/** Side of the SQUARE the heavy ramp shades, in drawing-buffer pixels. Fixed while the panel is
 *  not — that is what makes the reading comparable across devices by construction, and what bounds
 *  the worst submit (`maxLoad` x 100 x 100) before any measurement happens. */
export const SHADE_REGION_PX = 100;

/** One ramp's workload: set a load, submit it. The harness (`runRamp`) owns all timing, escape and
 *  deadline logic and knows nothing about how the work is produced. */
export interface RampWorkload {
  setLoad(load: number): void;
  /** Issue the draw(s) for the current load. Returns without waiting for the GPU — the caller
   *  times it, either with the {@link GpuClock} or against presentation. */
  submit(): void;
}

export interface GlProbeSurface {
  readonly workloads: Readonly<Record<RampKind, RampWorkload>>;
  /** `null` when the context offers no fence — the harness then falls back to presentation timing
   *  and says so in the log. */
  readonly clock: GpuClock | null;
  readonly bufferPixels: number;
  /** What the 100 px region actually achieved — `min(SHADE_REGION_PX, buffer)` per axis, since a
   *  window narrower than the region cannot host it. Reported rather than assumed, so the reading
   *  stays interpretable when that clamp bites. */
  readonly shadeRegionPixels: number;
  /** Program link + first-use cost, ms: the trivial program and the heavy one, timed apart. */
  readonly compileMs: number;
  readonly shadeCompileMs: number;
  /** True when the heavy program failed to build. The shade ramp is then absent, which is a
   *  DEGRADED probe, not a failed one — see {@link createGlProbeSurface}. */
  readonly shadeUnavailable: boolean;
  dispose(): void;
}

const VERTEX_SRC = `#version 300 es
precision highp float;
uniform vec2 uScale;
uniform vec2 uOffset;
out vec2 vUv;
// Two triangles from gl_VertexID alone — no vertex buffer, no attribute state, nothing to bind.
// The quad is EXACT (six vertices), not a fullscreen triangle: the shade ramp's area has to be
// precisely the 100 px region it reports, and half of a clipped triangle is not that.
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
void main() {
  vec2 c = CORNERS[gl_VertexID];
  vUv = c;
  gl_Position = vec4((c * 2.0 - 1.0) * uScale + uOffset, 0.0, 1.0);
}`;

/** The cheap fragment shader — the fill and draw ramps. `0x040404` matches the Three material it
 *  replaces; the value is irrelevant to timing and kept only so a captured frame looks the same. */
const CHEAP_FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = vec4(0.0157, 0.0157, 0.0157, 1.0); }`;

/** The heavy fragment shader. A line-for-line port of `probeHeavyShader.ts`'s TSL graph.
 *
 *  ⚠️ **THE DEPENDENCY IS THE WHOLE POINT.** Each tap's coordinate comes out of the texel just
 *  read, so the sampler cannot prefetch and the loop cannot be unrolled into parallel reads. Write
 *  it as independent taps and a GPU with any latency hiding at all reads as infinitely fast. */
const HEAVY_FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 p = vUv;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${SHADE_TAPS}; i++) {
    vec4 s = texture(uTex, p);
    p = fract(s.xy * 0.97 + p * 0.31);
    acc += s.xyz;
  }
  fragColor = vec4(acc / float(${SHADE_TAPS}), 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader returned null');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  // ⚠️ Checked EAGERLY, and that is a deliberate cost. `COMPILE_STATUS` is a synchronous stall on
  // drivers that compile in parallel — but a silently-unusable program would make the ramp report
  // a device as impossibly fast (it is drawing nothing), which is the one direction that ends in
  // booting a weak phone `high`. A stall of a few ms during boot is the cheaper failure.
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'no log';
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log.slice(0, 200)}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fsSrc: string): WebGLProgram {
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) { gl.deleteShader(fs); throw new Error('createProgram returned null'); }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // The shader objects are reference-counted by the program; deleting them here is the ordinary
  // GL idiom and frees the compiler's copy as soon as the link is done.
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'no log';
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log.slice(0, 200)}`);
  }
  return program;
}

/** The heavy shader's source texture. Derived from the index — never `Math.random()`, which the
 *  determinism guard rejects in `runtime/**` and which would make two probes on one device
 *  disagree. The multipliers are coprime with the texture size so the dependent walk scatters
 *  rather than settling into a short cycle over a handful of texels. */
function makeHeavyTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const x = i % TEX_SIZE;
    const y = (i / TEX_SIZE) | 0;
    data[i * 4 + 0] = (x * 37 + y * 17) & 0xff;
    data[i * 4 + 1] = (x * 11 + y * 53) & 0xff;
    data[i * 4 + 2] = (x * 7 + y * 29) & 0xff;
    data[i * 4 + 3] = 255;
  }
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEX_SIZE, TEX_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // ⚠️ NO MIPMAPS. A sampler picks its level from the screen-space derivative of the coordinate,
  // and this coordinate is a dependent chain whose derivative is meaningless — so with mipmaps the
  // level would vary unpredictably between devices and drivers, and the ramp would time a
  // different amount of memory traffic on each. One level, one answer.
  return tex;
}

/** Stand the probe's GL surface up, or return `null` when WebGL2 is unavailable — which the caller
 *  must treat as "no information", never as a verdict.
 *
 *  ⚠️ **The heavy program is OPTIONAL BY CONSTRUCTION.** A driver that refuses it must still yield
 *  fill/draw/cpu rather than collapsing the whole probe: a probe that answers less is not the same
 *  failure as a probe that answers nothing. Same contract the Three version had for the same
 *  reason.
 *
 *  ⚠️ **The canvas is never added to the DOM.** A canvas renders perfectly well detached, and the
 *  version this replaced appended an off-screen `<div>` to `document.body` during boot — a layout
 *  and a mutation nobody needed. rAF is per-document and still fires, so the presentation fallback
 *  is unaffected. */
export function createGlProbeSurface(cw: number, ch: number, mark: (stage: string) => void): GlProbeSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    // No depth or stencil attachment at all: every ramp draws with depth off (see the module
    // header), so allocating them would cost bandwidth on the weakest hardware for nothing.
    depth: false,
    stencil: false,
    antialias: false,
    // The probe's whole job is to characterise the real GPU. A context that quietly landed on an
    // integrated or software path would rank the device as something it is not.
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) { mark('gl-context-failed'); return null; }
  // Phase 3 of #590 (docs/rendering.md): this raw WebGL2 context was
  // invisible to the soft GPU-context budget — noted here, right after creation is confirmed,
  // paired with the one-shot `dispose()` below.
  noteGpuContextCreated();
  let contextLive = true;

  let vs: WebGLShader | null = null;
  let cheapProgram: WebGLProgram | null = null;
  let heavyProgram: WebGLProgram | null = null;
  let heavyTexture: WebGLTexture | null = null;
  let vao: WebGLVertexArrayObject | null = null;

  const dispose = () => {
    if (contextLive) { contextLive = false; noteGpuContextDestroyed(); }
    try {
      if (cheapProgram) gl.deleteProgram(cheapProgram);
      if (heavyProgram) gl.deleteProgram(heavyProgram);
      if (heavyTexture) gl.deleteTexture(heavyTexture);
      if (vao) gl.deleteVertexArray(vao);
      if (vs) gl.deleteShader(vs);
      // ⚠️ EXPLICIT CONTEXT LOSS, not left to GC. A leaked GL context is a real cost on exactly the
      // low-memory devices this probe exists to characterise, and browsers cap how many may exist
      // at once — the same reasoning `deviceCaps.readGlFacts` already applies to its 1x1 context.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* teardown must never fail the launch */ }
  };

  try {
    // A VAO is required in WebGL2 core even when nothing is bound to it: the draws below source
    // their geometry from `gl_VertexID` alone, but a draw call with no VAO bound is an error on
    // some drivers.
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // ADDITIVE — three's `AdditiveBlending` is exactly (SRC_ALPHA, ONE). Without it every GPU in
    // range resolves the stacked quads away before shading and both GPU ramps read flat.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(0, 0, 0, 1);

    vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);

    const compileStarted = rawNow();
    cheapProgram = linkProgram(gl, vs, CHEAP_FRAGMENT_SRC);
    // Force the driver to finish whatever it deferred, so `compileMs` is the real cost rather than
    // a lazy handle returned instantly and paid for inside the first timed step.
    gl.useProgram(cheapProgram);
    gl.getUniformLocation(cheapProgram, 'uScale');
    const compileMs = rawNow() - compileStarted;
    mark(`gl-compile-ok ${compileMs.toFixed(0)}ms`);

    let shadeCompileMs = 0;
    let shadeUnavailable = false;
    const shadeCompileStarted = rawNow();
    try {
      heavyProgram = linkProgram(gl, vs, HEAVY_FRAGMENT_SRC);
      heavyTexture = makeHeavyTexture(gl);
      gl.useProgram(heavyProgram);
      gl.uniform1i(gl.getUniformLocation(heavyProgram, 'uTex'), 0);
      shadeCompileMs = rawNow() - shadeCompileStarted;
      mark(`gl-shade-compile-ok ${shadeCompileMs.toFixed(0)}ms`);
    } catch (e) {
      // A heavy shader that will not build is not a slow device. Drop the axis, keep the probe.
      mark(`gl-shade-compile-failed ${String(e).slice(0, 120)}`);
      if (heavyProgram) { gl.deleteProgram(heavyProgram); heavyProgram = null; }
      shadeUnavailable = true;
      shadeCompileMs = 0;
    }

    const cheapScale = gl.getUniformLocation(cheapProgram, 'uScale');
    const cheapOffset = gl.getUniformLocation(cheapProgram, 'uOffset');
    const heavyScale = heavyProgram ? gl.getUniformLocation(heavyProgram, 'uScale') : null;
    const heavyOffset = heavyProgram ? gl.getUniformLocation(heavyProgram, 'uOffset') : null;

    // The heavy ramp's region, in NDC half-extents, clamped to the buffer.
    const sx = Math.min(1, SHADE_REGION_PX / cw);
    const sy = Math.min(1, SHADE_REGION_PX / ch);
    const shadeRegionPixels = Math.round(sx * cw) * Math.round(sy * ch);

    let fillLoad = 0;
    let shadeLoad = 0;

    const workloads: Record<RampKind, RampWorkload> = {
      // ONE draw call, N instances: overdraw scales while submit cost does not.
      fill: {
        setLoad: (n) => { fillLoad = n; },
        submit: () => {
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (fillLoad <= 0) return;
          gl.useProgram(cheapProgram);
          gl.uniform2f(cheapScale, 1, 1);       // full viewport
          gl.uniform2f(cheapOffset, 0, 0);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, fillLoad);
        },
      },
      // Instanced overdraw of the heavy shader over the FIXED region. A no-op when the program
      // failed to build; the caller drops the axis rather than recording zeros.
      shade: {
        setLoad: (n) => { shadeLoad = n; },
        submit: () => {
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (shadeLoad <= 0 || !heavyProgram) return;
          gl.useProgram(heavyProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, heavyTexture);
          gl.uniform2f(heavyScale, sx, sy);
          gl.uniform2f(heavyOffset, 0, 0);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, shadeLoad);
        },
      },
      // The CPU ramp submits nothing — it is pure JS arithmetic and never touches this surface.
      // Present so the record is total over `RampKind` and a new kind cannot be forgotten here.
      cpu: { setLoad: () => {}, submit: () => {} },
    };

    return {
      workloads,
      // `makeGpuClock` reads `renderer.backend.gl`, so a two-field adapter is the whole of the
      // integration — the WebGL2 fence path it already had is exactly what this needs.
      clock: makeGpuClock({ backend: { isWebGLBackend: true, gl } }),
      bufferPixels: cw * ch,
      shadeRegionPixels: shadeUnavailable ? 0 : shadeRegionPixels,
      compileMs,
      shadeCompileMs,
      shadeUnavailable,
      dispose,
    };
  } catch (e) {
    mark(`gl-setup-failed ${String(e).slice(0, 120)}`);
    dispose();
    return null;
  }
}
