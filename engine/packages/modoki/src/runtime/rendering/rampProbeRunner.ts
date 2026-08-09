/** Boot ramp probe (#188) — the IMPURE half: the renderer, the geometry, and the clock.
 *
 *  The policy and the maths live in `rampProbe.ts` and are pure. This module owns only the three
 *  things that policy refuses to own: something to draw, somewhere to draw it, and a timestamp.
 *  Same split as `tierCalibration` over `qualityTier`, for the same reason — it keeps every
 *  branch of the decision testable without a GPU.
 *
 *  ── IT BLOCKS THE LAUNCH, AND THAT IS THE POINT (owner, 2026-08-09) ───────────────────────
 *  The plan originally forbade the probe from introducing ANY new shader program, because one
 *  program cost ~1.2 s to compile on a Huawei Y6. That constraint made the probe unable to
 *  inform the launch it runs on: with no material of its own it can only draw once the scene
 *  has compiled one, and by then the real renderer exists — and `antialias` is a CONSTRUCTOR
 *  option baked into the swapchain, so a tier decided after renderer creation can never apply
 *  it (`tierCalibration` documents exactly this limitation for live tier changes).
 *
 *  So the constraint was overridden deliberately: the probe compiles its own material FIRST,
 *  awaits that compile, measures, and only then does the real renderer get created with a tier
 *  that is complete. Note what makes this affordable — the ~1.2 s figure is an average over
 *  postfx-demo's 14 programs, which are heavy PBR + NPR graphs. This material is an unlit quad
 *  with no lights, no shadows, no environment and no post-FX, i.e. the cheapest program the
 *  engine can express, and BOTH ramps share it (one geometry, one material, two groups of
 *  objects) so the whole probe costs exactly one compile.
 *
 *  ── WHY THE PROBE GETS ITS OWN RENDERER ───────────────────────────────────────────────────
 *  Because the answer has to exist before the real renderer is constructed. This one is
 *  throwaway and its own `antialias` is irrelevant, so it can be created immediately. Same
 *  pattern, and the same off-screen container trick, as `capsProbeRenderer`.
 *
 *  ── WHAT IT MEASURES AT — CLAMPED, AND WHY THAT IS NOW SAFE ───────────────────────────────
 *  At device pixel ratio 1, capped further by {@link MAX_PROBE_PIXELS}.
 *
 *  It used to run at the full native buffer, on the reasoning that fill cost is per pixel so the
 *  probe should measure the load it intends to impose. That reasoning KILLED A TAB on an iPhone
 *  13 mini: at DPR 3 the last fill step asked for ~190 megapixels in one submit and WebKit
 *  terminated the process — the #156 failure, reproduced by the instrument built to prevent it.
 *
 *  The clamp costs nothing, because `fillMegapixelsPerMs` normalises the result by the buffer
 *  size: throughput in pixels/ms is a property of the GPU, not of the panel, so a device measured
 *  at a small buffer can still be asked whether it affords a large one. Measuring big was never
 *  necessary — only measuring in KNOWN units was. */

import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { rawNow } from '../core/clock';
import {
  startRamp, rampNextLoad, recordRampFrame, readRamp, estimateIntervalMs,
  RAMP_BOUNDS, PROBE_BUDGET_MS,
  type ProbeMeasurement, type RampKind, type RampReading,
} from './rampProbe';

/** Frames rendered at a trivial load before any ramp, to (a) settle the pipeline and (b) measure
 *  the display interval every ramp threshold is expressed against.
 *
 *  ⚠️ EIGHT, not three. Three was measurably not enough: across three iOS devices — all 60 Hz, so
 *  all expecting ~16.7 ms — the estimate came back anywhere from 6.0 to 18.0 ms. Since every ramp
 *  threshold is a multiple of it, a reading of 6.0 dropped the escape bar to 18 ms and the ramp
 *  escaped on noise, reporting throughput figures that were wrong by orders of magnitude.
 *
 *  `estimateIntervalMs` drops the leading `DISCARDED_WARMUP_FRAMES` and takes the median of the
 *  rest, so this must be large enough to leave a real sample behind: 8 leaves 5. The extra frames
 *  cost ~85 ms against a probe whose cold renderer creation alone measured 600-1700 ms on these
 *  phones — a trivial price for the number that every threshold depends on. */
const WARMUP_FRAMES = 8;

/** Ceiling on the RAMP phase's wall clock, measured from the moment the ramps start.
 *
 *  ⚠️ It deliberately excludes setup. It used to run from the top of the probe, and on an iPhone
 *  13 mini's first ever run the renderer took 796 ms to create (3 ms once warm) — so the whole
 *  allowance was gone before any measuring began, both ramps broke out on their first frame, and
 *  the run reported `status: 'running'` with no reading. Setup cost is real, and it IS reported
 *  (`rendererMs`, `compileMs`), but a slow cold start must not be able to starve the measurement
 *  it exists to enable.
 *
 *  The ramps budget themselves separately; this is only the outer guard that stops a pathological
 *  device turning a blocking probe into a hang. */
const HARD_DEADLINE_MS = PROBE_BUDGET_MS * 3;

/** Hard cap on the probe's drawing buffer, in pixels (~1.05 MP — roughly 1080x970).
 *
 *  Paired with the lowered `RAMP_BOUNDS.fill`, this bounds the worst single submit at
 *  32 x 1.05 MP ≈ 34 megapixels, against the ~190 MP that killed a 13 mini's tab. A tablet at
 *  native resolution is the case this exists for: an iPad Pro's buffer is ~7x an iPhone 8's, so
 *  an uncapped probe is dramatically more dangerous on exactly the hardware most able to survive
 *  it — right up until it isn't. Comparability is preserved by normalising to pixels/ms. */
const MAX_PROBE_PIXELS = 1_050_000;

/** One quad, shared by every object in both ramps. `PlaneGeometry(2, 2)` exactly fills the
 *  symmetric ortho frustum below, so a fill quad at unit scale covers the viewport precisely. */
function makeProbeAssets() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  // depthTest/depthWrite OFF is what makes the fill ramp mean anything: with depth on, the first
  // quad would occlude the rest and N quads would shade one screen instead of N. Off, every quad
  // shades every pixel, which is the overdraw the ramp is trying to price.
  const material = new THREE.MeshBasicMaterial({ color: 0x808080, depthTest: false, depthWrite: false });
  return { geometry, material };
}

/** Build both ramps' objects up front, ALL of them, and drive load by toggling `visible`.
 *
 *  ⚠️ Creating meshes as the ramp grows would corrupt the very thing being measured: each
 *  doubling would allocate as many objects as already exist, so allocation cost would scale
 *  WITH LOAD and be indistinguishable from the render cost in the slope. Allocating up front
 *  moves it outside the timed section entirely; toggling visibility afterwards is O(load) of
 *  trivial work against O(load) draw calls.
 *
 *  Positions are derived from the index — never `Math.random()`, which the determinism guard
 *  rejects in `runtime/**` and which would also make two probes on one device disagree. */
function buildRampGroup(
  kind: RampKind,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const { maxLoad } = RAMP_BOUNDS[kind];
  // A square-ish lattice, so the draw ramp's quads are spread across the viewport rather than
  // stacked in one spot where a tile-based renderer could treat them as a single region.
  const cols = Math.ceil(Math.sqrt(maxLoad));
  for (let i = 0; i < maxLoad; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    if (kind === 'fill') {
      // Full-viewport, stacked. N of these is N screens of overdraw.
      mesh.position.set(0, 0, 0);
    } else {
      // Tiny and scattered. The fill cost is negligible by construction, so what this ramp
      // prices is the per-object CPU submit — forest-camp's actual bottleneck (0.14 ms/call on
      // the Y6), which a fill-heavy probe would never have predicted.
      const col = i % cols;
      const row = Math.floor(i / cols);
      mesh.position.set((col / cols) * 2 - 1, (row / cols) * 2 - 1, 0);
      mesh.scale.setScalar(0.5 / cols);
    }
    mesh.visible = false;
    mesh.frustumCulled = false; // culling would silently drop draws and flatten the ramp
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

/** Show exactly the first `load` objects of a group. */
function setLoad(group: THREE.Group, load: number): void {
  group.visible = load > 0;
  for (let i = 0; i < group.children.length; i++) group.children[i].visible = i < load;
}

/** Resolve on the next animation frame, handing back its timestamp. */
function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Run one ramp to completion. Returns its reading.
 *
 *  Timing is the interval between successive rAF timestamps — the same metric `frameProfiler`
 *  uses, and the one the escape logic is written against. It is NOT the CPU time around
 *  `render()`, which on both backends returns before the GPU has done the work and would report
 *  a fill-bound device as infinitely fast. */
async function runRamp(
  kind: RampKind,
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  group: THREE.Group,
  intervalMs: number,
  deadline: number,
  mark: (stage: string) => void,
): Promise<RampReading> {
  let state = startRamp(kind, intervalMs);
  let last = await nextFrame();

  for (;;) {
    const load = rampNextLoad(state);
    if (load === null) break;
    setLoad(group, load);
    // Marked BEFORE the submit: if this load is the one that kills the process, the last stage
    // reported IS the culprit. A mark after the render would name the last SURVIVED load instead.
    mark(`${kind}:${load}`);
    renderer.render(scene, camera);
    const now = await nextFrame();
    state = recordRampFrame(state, now - last);
    last = now;
    // The outer guard. A ramp that is somehow neither escaping nor exhausting its own budget
    // must still not hold the launch open — this is a BLOCKING probe.
    if (rawNow() > deadline) break;
  }

  setLoad(group, 0);
  return readRamp(state);
}

/** Run the boot probe. Resolves `null` when the probe cannot run at all (no DOM, no renderer),
 *  which callers must treat as "no information" — i.e. today's behaviour — and never as a verdict.
 *
 *  ⚠️ THIS BLOCKS THE LAUNCH BY DESIGN. Everything it costs — one shader compile, a warm-up, two
 *  ramps — happens before the real renderer is created, because a tier decided any later cannot
 *  apply `antialias`. It is first-launch-only; the caller caches the verdict. */
export async function runBootRampProbe(
  onProgress?: (stage: string) => void,
): Promise<ProbeMeasurement | null> {
  const mark = (stage: string) => { try { onProgress?.(stage); } catch { /* never fail the probe */ } };
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return null;
  mark('start');

  const started = rawNow();

  const container = document.createElement('div');
  // Sized from the viewport but CLAMPED to MAX_PROBE_PIXELS — not the 2px of `capsProbeRenderer`
  // (a 2px buffer would report every device on earth as fill-infinite) and not the native buffer
  // either (that killed a tab; see the module header). Aspect is preserved so the shape of the
  // work resembles a real frame.
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  const scale = Math.min(1, Math.sqrt(MAX_PROBE_PIXELS / (vw * vh)));
  const cw = Math.max(1, Math.round(vw * scale));
  const ch = Math.max(1, Math.round(vh * scale));
  container.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none;'
    + `width:${cw}px;height:${ch}px;`;
  document.body.appendChild(container);

  let renderer: WebGPURenderer | null = null;
  const { geometry, material } = makeProbeAssets();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  camera.position.z = 1;
  const fillGroup = buildRampGroup('fill', geometry, material);
  const drawGroup = buildRampGroup('draw', geometry, material);
  scene.add(fillGroup, drawGroup);

  try {
    mark('import-scene3DSync');
    const { makeWebGPURenderer } = await import('./scene3DSync');
    mark('renderer-create');
    const rendererStarted = rawNow();
    renderer = await makeWebGPURenderer(container);
    // DPR 1, explicitly. `makeWebGPURenderer` applies the project's pixelRatioCap, which on an
    // unpinned project is the HIGH tier's 2 — and 2x on a phone is 4x the fragments, which is
    // half of how the 13 mini's tab died. The clamp is safe because the result is normalised by
    // buffer size (fillMegapixelsPerMs), so a small buffer loses no comparability.
    renderer.setPixelRatio(1);
    renderer.setSize(cw, ch, false);
    const rendererMs = rawNow() - rendererStarted;
    const bufferPixels = cw * ch;
    // Name the BACKEND: 'auto' picks WebGPU when the device claims support, and a crash that only
    // happens on one backend is a completely different bug from one that happens on both.
    const be = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
    mark(`renderer-ok ${cw}x${ch} backend=${be?.isWebGPUBackend ? 'webgpu' : be?.isWebGLBackend ? 'webgl2' : '?'}`);

    // THE BLOCKING COMPILE. One material, both ramps — see the module header. Awaiting it here
    // is the whole reason the probe can inform this launch rather than the next one, and it also
    // keeps the compile OUT of the first timed frame, where it would have been charged to the
    // load and wrecked the slope.
    setLoad(fillGroup, 1);
    mark('compile');
    const compileStarted = rawNow();
    await renderer.compileAsync(scene, camera);
    const compileMs = rawNow() - compileStarted;
    mark('compile-ok');
    setLoad(fillGroup, 0);

    const warmup: number[] = [];
    let last = await nextFrame();
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      renderer.render(scene, camera);
      const now = await nextFrame();
      warmup.push(now - last);
      last = now;
    }
    const intervalMs = estimateIntervalMs(warmup);
    mark(`warmup-ok interval=${intervalMs.toFixed(1)}`);
    if (intervalMs <= 0) return null;

    // ⚠️ The ramp deadline starts HERE, after setup — not at the top of the probe. It used to
    // include renderer creation, and on an iPhone 13 mini's FIRST run that took 796 ms (against
    // 3 ms once warm): setup alone consumed the whole allowance, both ramps broke out on their
    // first frame, and the run produced `status: 'running'` with no reading at all. Setup cost is
    // real and is reported (`rendererMs`, `compileMs`), but it must not be able to starve the
    // measurement it exists to enable.
    const deadline = rawNow() + HARD_DEADLINE_MS;
    const fill = await runRamp('fill', renderer, scene, camera, fillGroup, intervalMs, deadline, mark);
    mark(`fill-ok ${fill.status}`);
    const draw = await runRamp('draw', renderer, scene, camera, drawGroup, intervalMs, deadline, mark);
    mark(`draw-ok ${draw.status}`);

    return {
      intervalMs, fill, draw, totalMs: rawNow() - started, rendererMs, compileMs, bufferPixels,
    };
  } catch (e) {
    // A probe failure must never block rendering — the caller falls back to today's behaviour,
    // which starts low. Same policy as a failed `getDeviceCaps()`.
    mark(`threw ${String(e).slice(0, 160)}`);
    return null;
  } finally {
    // Dispose in full: this renderer exists only to answer one question, and a leaked GPU context
    // is a real cost on exactly the low-memory hardware being characterised.
    fillGroup.clear();
    drawGroup.clear();
    geometry.dispose();
    material.dispose();
    renderer?.dispose();
    container.remove();
  }
}
