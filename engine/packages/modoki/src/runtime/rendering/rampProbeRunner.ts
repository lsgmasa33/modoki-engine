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
import { makeHeavyShadeAssets, type HeavyShadeAssets } from './probeHeavyShader';
import { rawNow } from '../core/clock';
import { targetFPS } from './frameDriver';
import { makeGpuClock, type GpuClock } from './gpuClock';
import {
  startRamp, rampNextLoad, recordRampFrame, readRamp, estimateIntervalMs,
  RAMP_BOUNDS, PROBE_BUDGET_MS, ESCAPE_MULTIPLE, ABORT_FRAME_MS,
  type ProbeClockKind, type ProbeMeasurement, type RampKind, type RampReading,
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

/** Longest frame interval that can plausibly be a DISPLAY, ms.
 *
 *  ⚠️ **THE INTERVAL IS THE YARDSTICK FOR EVERYTHING, AND IT IS MEASURED AT THE BUSIEST MOMENT OF
 *  THE BOOT.** Escape is `3 x interval`, the ramp budget is `9 x interval` — so if the warm-up
 *  frames were stretched by the game's own asset loading rather than by the display, every
 *  threshold is stretched with them and the ramp is no longer measuring the GPU at all.
 *
 *  MEASURED on a Galaxy S22, native, three launches (2026-08-11): the warm-up estimated **125.6,
 *  167.4 and 167.4 ms** against a true 16.8 ms — 7-10x out. Both consequences are fatal and neither
 *  announces itself:
 *    - escape needs `3 x 167.4` = 502 ms, which is past {@link ABORT_FRAME_MS} (250), so escape is
 *      **unreachable by construction** and every reading degrades to a floor;
 *    - the ramp budget becomes `9 x 167.4` = 1507 ms, past the whole {@link HARD_DEADLINE_MS}, so
 *      the ramp is cut off mid-flight with `status: 'running'` and yields nothing.
 *  The phone paid ~2.5 s of blocked launch on each of three launches and never classified.
 *
 *  40 ms, which is 30 Hz (33.3) plus jitter: a thermally throttled iPhone 8 really does drop to
 *  30 Hz and that case MUST still measure — it is why the interval is measured rather than assumed.
 *  Nothing above this is a panel; it is contention, and the honest response is to decline the pass.
 *
 *  ⚠️ **DECLINE, DO NOT CLAMP.** Clamping to a plausible value looks like the tidier fix and is
 *  actively dangerous: replaying the S22's real steps against a clamped 35 ms interval, the ramp
 *  "escapes" at load 32 on two boot stalls (167 -> 209 ms) and reports 0.14 Mpx/ms — which is
 *  1.5x clear BELOW every boundary, i.e. it would settle a flagship at `weak` on one pass and
 *  cache it. A refused measurement costs a launch; a confident wrong one costs the device. */
const MAX_PLAUSIBLE_INTERVAL_MS = 40;

/** The yardstick a GPU-CLOCK-paced ramp is measured against, ms.
 *
 *  Not a display interval — nothing waits for the display on that path. It exists only so the escape
 *  rules keep their meaning in absolute terms: escape at `3x` = 50 ms of GPU work, the preceding step
 *  at `1.5x` = 25 ms, growth of `0.5x` = 8.4 ms. Those sit comfortably above the ~9-14 ms floor the
 *  clock itself costs (promise delivery on WebGPU, poll granularity on WebGL2), measured on all three
 *  phones — so a reading that clears them is real work rather than delivery latency. */
const GPU_NOMINAL_INTERVAL_MS = 16.7;

/** Wall clock one GPU-paced ramp may spend, ms. Two ramps fit inside {@link HARD_DEADLINE_MS}.
 *
 *  ⚠️ Generous compared with the presentation path's 150 ms, because a slow device spends it in far
 *  fewer steps: a Huawei Y6's very first fill step measured 114-246 ms. The trade is deliberate — on
 *  that hardware the ramp will exhaust this and report a LOWER bound, which is a true and useful
 *  statement about a device whose first step already costs more than a whole frame. */
const GPU_RAMP_BUDGET_MS = 400;

/** Ceiling on the HEAVY shader's compile, ms. See its call site for why it is bounded at all. */
const SHADE_COMPILE_TIMEOUT_MS = 3_000;

/** Ceiling on THROWAWAY renderer creation, ms (#205 R5.3).
 *
 *  `makeWebGPURenderer` is awaited before the real renderer is ever built, and until it settles
 *  `runBootRampProbe` cannot return — so an unbounded await here does not just lose the probe, it
 *  blocks `Scene3D.bringUp` forever, and `bringUp`'s only failure handling is a `.catch(...)` that
 *  a PENDING promise never reaches. The observable failure is a permanently blank 3D surface with
 *  no error anywhere.
 *
 *  Generous, because cold renderer creation is genuinely slow on real hardware: this module's own
 *  measurements are 600-1700 ms on several phones and 796 ms on an iPhone 13 mini's first run (see
 *  {@link HARD_DEADLINE_MS}'s comment). 5 s — the same order as {@link FRAME_WAIT_TIMEOUT_MS}, the
 *  other "give up on the device entirely" bound in this file — comfortably clears that range while
 *  still firing on a genuinely wedged create (a lost/never-acquired GPU context) instead of hanging
 *  the launch indefinitely. */
const RENDERER_CREATE_TIMEOUT_MS = 5_000;

/** Ceiling on the TRIVIAL material's compile, ms (#205 R5.3) — the first `compileAsync`, which
 *  builds the cheapest program the probe (or the engine) can express: an unlit quad, no lights, no
 *  shadows, no environment, no post-FX (see the module header). It had no timeout at all, unlike
 *  the HEAVY shader's second compile 28 lines below it — the exact asymmetry this constant closes.
 *
 *  Smaller than {@link SHADE_COMPILE_TIMEOUT_MS} on purpose: a program this simple has no business
 *  taking anywhere near as long as a 16-dependent-tap shader, so a bound this generous already
 *  means the compiler pipeline itself is not responding, not that the device is merely slow. */
const TRIVIAL_COMPILE_TIMEOUT_MS = 1_500;

/** Reject if `p` has not settled in `ms`. The timer is CLEARED on the happy path — an uncancelled
 *  one is the bug that made this workstream believe in a phantom 8-second WebGPU timeout for a
 *  whole session (see `gpuDetect.ts`). Same shape as `gpuClock.ts`'s, which is module-private
 *  there.
 *
 *  Exported so a test can assert the timeout MECHANISM rejects a promise that never settles,
 *  rather than only exercising the call sites through a fast mock that proves nothing about a
 *  hang. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** {@link withTimeout}, for a promise whose VALUE OWNS A RESOURCE: if the timeout wins, whatever
 *  the promise eventually hands back is disposed instead of leaked.
 *
 *  ⚠️ **`Promise.race` CANCELS NOTHING, AND THE LOSER HERE HOLDS A GPU CONTEXT** (close-out
 *  2026-08-12). `runBootRampProbe` assigns its `renderer` from the race, so on expiry the variable
 *  stays null, the `finally` disposes NOTHING, and the abandoned `makeWebGPURenderer` keeps going
 *  — very possibly succeeding a moment later with a live WebGPU device nothing holds a reference
 *  to. That is exactly the "a leaked GPU context is a real cost on exactly the low-memory hardware
 *  being characterised" the `finally` block exists to prevent, reached through the one path that
 *  skipped it. And the timeout fires on slow, weak, thermally throttled devices — the population
 *  the probe is FOR, which also re-runs it across three launches.
 *
 *  The flag, not a null check on the caller's variable: this callback is subscribed BEFORE the
 *  `await` resolves, so on the HAPPY path it runs before the caller has stored the renderer
 *  anywhere, and a "has the caller got one yet?" test would dispose the good one. */
export async function awaitOrDispose<T extends { dispose: () => void }>(p: Promise<T>, ms: number): Promise<T> {
  let abandoned = false;
  void p.then((v) => { if (abandoned) v.dispose(); }, () => {});
  try {
    return await withTimeout(p, ms);
  } catch (e) {
    abandoned = true;   // set BEFORE rethrowing — the late resolution is what reads it
    throw e;
  }
}

/** Clamp the interval fed to a presentation-paced ramp's escape threshold so it stays in the
 *  relation every ramp assumes: `ESCAPE_MULTIPLE x interval < ABORT_FRAME_MS` (#205 R5.4).
 *  Nothing enforced this before.
 *
 *  `intervalMs` at the raf-path call site is `Math.max(measuredIntervalMs, cappedIntervalMs)` —
 *  the measured half is already bounded by {@link MAX_PLAUSIBLE_INTERVAL_MS}, but the CAPPED half
 *  is a legitimate, authored project setting (a game that targets 20 fps has a real 50 ms
 *  interval), and the plausibility guard deliberately never inspects it — see its call site's
 *  comment. Push that capped interval low enough (roughly 8 fps or slower, a real setting nothing
 *  stops a project authoring) and `ESCAPE_MULTIPLE x interval` clears `ABORT_FRAME_MS` on its
 *  own: the escape bar sits ABOVE the abort bar, so every ramp on that project aborts on its very
 *  first over-budget step and can never escape — the exact inversion this closes.
 *
 *  This clamps only the ESCAPE YARDSTICK a ramp is measured against, not the reported
 *  `intervalMs` field on `ProbeMeasurement` — the project's real target interval is still
 *  honestly reported; only the internal threshold that decides "has this ramp escaped" is
 *  bounded, the same way {@link RAMP_BOUNDS} already bounds load rather than lying about it. */
export function escapableIntervalMs(intervalMs: number): number {
  // Strictly less than: escape firing in the SAME frame that trips ABORT_FRAME_MS is still the
  // inversion, not a guaranteed escape, hence the small margin off the exact ceiling.
  const ceilingMs = ABORT_FRAME_MS / ESCAPE_MULTIPLE;
  return Math.min(intervalMs, ceilingMs - 0.001);
}

/** Renders used to settle the pipeline on the GPU-clock path. No interval is estimated here — that
 *  is the whole point — so this only has to be enough that the first measured step is not also the
 *  first draw the driver has ever seen. */
const GPU_WARMUP_RENDERS = 3;

/** Side of the SQUARE the heavy-shader ramp shades, in drawing-buffer pixels.
 *
 *  ⚠️ **THE REGION IS FIXED AND THE PANEL IS NOT — that is the whole design.** The fill ramp shades
 *  the whole viewport, so its raw unit is "screens per ms" and a screen is a different number of
 *  pixels on every device; `fillMegapixelsPerMs` exists solely to undo that, and it needs the buffer
 *  size to do it. Hold the region fixed instead and the reading is comparable by construction, with
 *  no normalisation and no dependence on the panel at all.
 *
 *  It is also the safety property. The load is instances OVER THIS REGION, so the worst submit is
 *  `maxLoad x 100 x 100` = 41 M heavy fragments — bounded before any measurement happens, unlike the
 *  190 Mpx full-buffer submit that terminated an iPhone 13 mini's tab. */
const SHADE_REGION_PX = 100;

/** The yardstick the CPU ramp's escape rules are expressed against, ms.
 *
 *  Not a display interval and not the GPU clock's either — `rawNow()` has no quantization, no
 *  presentation and no delivery latency, so its noise floor is ~100 us (the `performance.now`
 *  clamp) rather than the ~10 ms the GPU clock costs. 4 ms puts escape at 12 ms, the preceding step
 *  at 6 ms and the required growth at 2 ms: two orders of magnitude above the clock's resolution,
 *  and comfortably above a young-generation GC pause, while still blocking the main thread for only
 *  ~25 ms across the whole ramp. */
const CPU_NOMINAL_INTERVAL_MS = 4;

/** Wall clock the CPU ramp may spend, ms. Small because it is: the steps double, so a ramp that
 *  escapes at 12 ms has spent ~25 ms in total, and this only has to cover a device slow enough to
 *  need every doubling. */
const CPU_RAMP_BUDGET_MS = 200;

/** How many node transforms the CPU ramp cycles through, and how deep its propagation chain runs
 *  before it restarts from identity.
 *
 *  A power of two, so the index wrap is a mask rather than a modulo — the loop body is the thing
 *  being timed and a division in it would be part of the measurement.
 *
 *  ⚠️ **THE RESTART IS NOT COSMETIC.** Composing world = parent x local without one accumulates
 *  through every iteration, and at half a million of them the translation grows without bound while
 *  the rotation drifts off orthonormal. Denormals and non-finite floats have their own hardware
 *  costs, so a ramp that runs long enough to produce them stops measuring transform propagation and
 *  starts measuring the FPU's slow path. Restarting every 256 levels also happens to be honest about
 *  the thing being modelled: real hierarchies are shallow. */
const CPU_WORKING_SET = 256;

/** Propagations run before the CPU ramp's first timed step.
 *
 *  ⚠️ Not pipeline warm-up — JIT warm-up, and it matters more here than anywhere else in the probe.
 *  A JS loop runs interpreted until the tiering-up threshold, and an un-warmed first step would
 *  measure the interpreter on every device while later steps measured optimised code — i.e. a slope
 *  drawn between two different execution engines. Three passes of 8192 is well past V8's
 *  optimisation threshold and costs a millisecond or two. */
const CPU_WARMUP_ITERATIONS = 8_192;
const CPU_WARMUP_PASSES = 3;

/** One quad, shared by every object in both ramps. `PlaneGeometry(2, 2)` exactly fills the
 *  symmetric ortho frustum below, so a fill quad at unit scale covers the viewport precisely. */
function makeProbeAssets() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  // depthTest/depthWrite OFF is what makes the fill ramp mean anything: with depth on, the first
  // quad would occlude the rest and N quads would shade one screen instead of N.
  //
  // ⚠️ **BUT DEPTH-OFF WAS NEVER ENOUGH, AND THE FILL RAMP HAS THEREFORE NEVER MEASURED FILL.**
  // Turning depth off stops the DEPTH TEST from rejecting the stack; it does not stop a tile-based
  // GPU from resolving, before shading, that only the last coplanar opaque fragment can survive.
  // Measured over CDP on an M-series GPU (2026-08-11): with the same heavy shader, opaque stacked
  // instances are FLAT — 2048 of them cost 0.60 ms against one instance's 0.40 — while additive
  // ones scale 0.50 -> 4.30 ms. What the opaque fill ramp actually prices is RASTERIZATION of N
  // quads, not N screens of shading.
  //
  // **This is the answer to the question this workstream has been stuck on.** "Fill does not rank
  // these GPUs, and cannot" — an A23 whose fill time did not move across an eightfold load, both
  // Samsungs sitting far below their datasheet fill rates, a flagship reading half a budget phone.
  // Every one of those is what you get from measuring raster/setup rate and calling it fill.
  // Blending is what makes the overdraw real, on this material and the heavy one alike.
  const material = new THREE.MeshBasicMaterial({
    color: 0x040404, depthTest: false, depthWrite: false,
    transparent: true, blending: THREE.AdditiveBlending,
  });
  return { geometry, material };
}

/** The heavy ramp's objects: `maxLoad` instances of a quad scaled to exactly `SHADE_REGION_PX`
 *  square, all stacked at the origin, so load is pure overdraw of the heavy shader over a fixed
 *  area. One draw call, for the same reason the fill ramp is one (see {@link buildRampGroup}).
 *
 *  Returns the region it actually achieved in pixels — `min(SHADE_REGION_PX, buffer)` on each axis,
 *  since a window narrower than the region cannot host it. Reporting it rather than assuming it is
 *  what keeps the reading comparable when that clamp bites. */
function buildShadeGroup(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  cw: number,
  ch: number,
): { group: THREE.InstancedMesh; regionPixels: number } {
  const { maxLoad } = RAMP_BOUNDS.shade;
  // The ortho frustum is [-1,1] on both axes and `PlaneGeometry(2, 2)` fills it, so a scale of
  // `px / bufferSide` covers exactly `px` pixels on that axis.
  const sx = Math.min(1, SHADE_REGION_PX / cw);
  const sy = Math.min(1, SHADE_REGION_PX / ch);
  const group = new THREE.InstancedMesh(geometry, material, maxLoad);
  const m = new THREE.Matrix4().makeScale(sx, sy, 1);
  for (let i = 0; i < maxLoad; i++) group.setMatrixAt(i, m);
  group.instanceMatrix.needsUpdate = true;
  group.frustumCulled = false; // culling would silently drop the whole ramp
  group.count = 0;
  group.visible = false;
  return { group, regionPixels: Math.round(sx * cw) * Math.round(sy * ch) };
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
): THREE.Object3D {
  const { maxLoad } = RAMP_BOUNDS[kind];

  if (kind === 'fill') {
    // ⚠️ ONE DRAW CALL, N INSTANCES — and this is a CORRECTION, not an optimisation.
    //
    // The fill ramp used to be N separate full-screen Meshes, which made it N DRAW CALLS as well as
    // N screens of overdraw. On a GPU with a large fill rate the per-draw cost then dominates and
    // the "fill" number stops being about fill at all. Measured on the GPU clock: a Galaxy S22 read
    // 1.57 Mpx/ms against a Galaxy A23's 3.13 — the flagship reading HALF the budget phone, which
    // is impossible for fill and is the signature of measuring submit. Both sat far below their
    // datasheet fill rates, which is the same tell from the other direction.
    //
    // An InstancedMesh renders `count` copies from ONE submit, so overdraw scales while draw cost
    // does not, and the two ramps finally measure two different things — which is the entire
    // premise of having two of them.
    const instanced = new THREE.InstancedMesh(geometry, material, maxLoad);
    // Every instance is the same full-viewport quad at the origin: N of them is N screens of
    // overdraw, exactly as the stacked meshes were.
    const identity = new THREE.Matrix4();
    for (let i = 0; i < maxLoad; i++) instanced.setMatrixAt(i, identity);
    instanced.instanceMatrix.needsUpdate = true;
    instanced.frustumCulled = false; // culling would silently drop the whole ramp
    instanced.count = 0;
    instanced.visible = false;
    return instanced;
  }

  const group = new THREE.Group();
  // A square-ish lattice, so the draw ramp's quads are spread across the viewport rather than
  // stacked in one spot where a tile-based renderer could treat them as a single region.
  const cols = Math.ceil(Math.sqrt(maxLoad));
  for (let i = 0; i < maxLoad; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    // Tiny and scattered. The fill cost is negligible by construction, so what this ramp
    // prices is the per-object CPU submit — forest-camp's actual bottleneck (0.14 ms/call on
    // the Y6), which a fill-heavy probe would never have predicted.
    const col = i % cols;
    const row = Math.floor(i / cols);
    mesh.position.set((col / cols) * 2 - 1, (row / cols) * 2 - 1, 0);
    mesh.scale.setScalar(0.5 / cols);
    mesh.visible = false;
    mesh.frustumCulled = false; // culling would silently drop draws and flatten the ramp
    group.add(mesh);
  }
  group.visible = false;
  return group;
}

/** Show exactly the first `load` objects of a group. */
function setLoad(target: THREE.Object3D, load: number): void {
  target.visible = load > 0;
  // The fill ramp is an InstancedMesh: `count` IS the load, in O(1) and one draw call.
  if ((target as THREE.InstancedMesh).isInstancedMesh) {
    (target as THREE.InstancedMesh).count = load;
    return;
  }
  for (let i = 0; i < target.children.length; i++) target.children[i].visible = i < load;
}

// ── THE CPU RAMP ───────────────────────────────────────────────────────────────────────────

/** Where the CPU ramp's result goes, so that nothing it computes is dead.
 *
 *  ⚠️ A benchmark whose output is unobservable is a benchmark an optimiser may delete. The
 *  propagation below writes into long-lived `Matrix4` objects, which is already heap-observable and
 *  probably enough on its own — but "probably enough" is how a probe ends up measuring an empty
 *  loop, and this workstream has spent three sessions on instruments that lied. One module-level
 *  store removes the question. */
let cpuRampSink = 0;

/** A shallow chain of node transforms for the CPU ramp to propagate through. */
interface CpuNodes {
  pos: THREE.Vector3[];
  quat: THREE.Quaternion[];
  scale: THREE.Vector3[];
  local: THREE.Matrix4[];
  world: THREE.Matrix4[];
  identity: THREE.Matrix4;
}

function makeCpuNodes(): CpuNodes {
  const pos: THREE.Vector3[] = [];
  const quat: THREE.Quaternion[] = [];
  const scale: THREE.Vector3[] = [];
  const local: THREE.Matrix4[] = [];
  const world: THREE.Matrix4[] = [];
  const axis = new THREE.Vector3();
  for (let i = 0; i < CPU_WORKING_SET; i++) {
    const t = i / CPU_WORKING_SET;
    pos.push(new THREE.Vector3(t, 1 - t, t * 2 - 1));
    axis.set(Math.sin(t * 7), Math.cos(t * 5), Math.sin(t * 3) + 2).normalize();
    quat.push(new THREE.Quaternion().setFromAxisAngle(axis, t * Math.PI));
    // ⚠️ EXACTLY 1, on every axis. `Matrix4.compose` multiplies by the scale unconditionally, so a
    // unit scale costs precisely what a varied one costs — while a scale of, say, 1.1 compounds
    // through 256 levels of propagation to 1.1^256 and overflows to Infinity, at which point the
    // ramp is timing the FPU's non-finite path instead of transform propagation.
    scale.push(new THREE.Vector3(1, 1, 1));
    local.push(new THREE.Matrix4());
    world.push(new THREE.Matrix4());
  }
  return { pos, quat, scale, local, world, identity: new THREE.Matrix4() };
}

/** Propagate `iterations` node transforms and return elapsed ms.
 *
 *  ── WHY THIS ARITHMETIC AND NOT A SYNTHETIC BUSY-LOOP ─────────────────────────────────────
 *  `Matrix4.compose` followed by `multiplyMatrices` is LITERALLY what the engine's transform
 *  propagation runs (`core/ecs/transformPropagationSystem.ts` lines 57 and 284) — same three
 *  called methods, same shapes, same allocation-free reuse of preallocated matrices. So the JIT
 *  sees code it has an equivalent of in the real frame, and the number means something about that
 *  frame rather than about a loop nobody runs.
 *
 *  The chain is SERIAL: each world matrix is built from the previous one, so the loop carries a
 *  real data dependency and cannot be reordered, vectorised or hoisted out. That is also what a
 *  hierarchy does. */
function propagate(n: CpuNodes, iterations: number): number {
  const { pos, quat, scale, local, world, identity } = n;
  const mask = CPU_WORKING_SET - 1;
  let prev = identity;
  const started = rawNow();
  for (let k = 0; k < iterations; k++) {
    const i = k & mask;
    // Restart the chain at the top of each pass — see CPU_WORKING_SET for why unbounded
    // accumulation would turn this into an FPU-slow-path benchmark.
    if (i === 0) prev = identity;
    const m = local[i].compose(pos[i], quat[i], scale[i]);
    prev = world[i].multiplyMatrices(prev, m);
  }
  const elapsed = rawNow() - started;
  cpuRampSink += prev.elements[12];
  return elapsed;
}

/** Run the CPU ramp to completion. No renderer, no clock, no frames — just JS and `rawNow()`.
 *
 *  ⚠️ **DURING BOOT THIS MEASURES AVAILABLE CPU, NOT PEAK CPU, and that is the caveat to carry.**
 *  The main thread is contended at boot; a synchronous loop cannot be preempted by other JS, but it
 *  can be descheduled by the OS and interrupted by GC. Unlike rAF — which does not degrade under
 *  contention so much as stop meaning anything, backing off in whole multiples of the panel tick —
 *  this degrades MONOTONICALLY: a busier device reads slower, which is the direction a tier
 *  decision wants anyway. Validate it the same way everything else here was validated, though:
 *  a boot reading against a quiet reading, on the same device. */
function runCpuRamp(mark: (stage: string) => void, deadline: number): RampReading {
  const nodes = makeCpuNodes();
  for (let i = 0; i < CPU_WARMUP_PASSES; i++) propagate(nodes, CPU_WARMUP_ITERATIONS);
  mark('cpu:warm');

  let state = startRamp('cpu', CPU_NOMINAL_INTERVAL_MS, CPU_RAMP_BUDGET_MS);
  for (;;) {
    const load = rampNextLoad(state);
    if (load === null) break;
    // Marked BEFORE the work, so that if this load is the one that wedges the device, the last
    // stage reported IS the culprit rather than the last one survived.
    mark(`cpu:${load}`);
    state = recordRampFrame(state, propagate(nodes, load));
    if (rawNow() > deadline) break;
  }
  return readRamp(state);
}

/** How long to wait for one animation frame before giving up on the probe entirely.
 *
 *  Generous on purpose — a boot-stalled frame on a Huawei Y6 has been measured past 200 ms and a
 *  cold first frame far beyond that, so this must not fire on a device that is merely slow. It
 *  exists for the case where frames stop arriving ALTOGETHER. */
const FRAME_WAIT_TIMEOUT_MS = 5_000;

/** Resolve on the next animation frame, handing back its timestamp — or `null` if none arrives.
 *
 *  ⚠️ **rAF DOES NOT FIRE WHILE THE PAGE IS NOT VISIBLE, AND THIS PROBE BLOCKS RENDERER CREATION.**
 *  An unconditional `new Promise((resolve) => requestAnimationFrame(resolve))` therefore never
 *  settles when the screen goes off or the app is backgrounded during boot — so `resolveActiveTier`
 *  never returns, the real renderer is never created, and the game shows nothing until the user
 *  comes back. That is the same observable failure as #156 (black for the process lifetime), from
 *  the opposite cause, in the very mechanism built to prevent it.
 *
 *  ⚠️ It is NOT a hypothetical. Hit while measuring (2026-08-11): two of the three phones had their
 *  screens off, and both hung here indefinitely on every launch — the probe emitted no log, took no
 *  deadline, and simply never finished. Note what the existing guard could not do: `HARD_DEADLINE_MS`
 *  is checked AFTER a frame arrives, so a ramp waiting on a frame that never comes cannot consult
 *  it. A wall-clock bound has to live at the wait itself.
 *
 *  Resolving `null` rather than throwing keeps the failure on the ordinary "no measurement" path,
 *  which the caller already handles by falling back to today's behaviour and trying again next
 *  launch. */
function nextFrame(): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FRAME_WAIT_TIMEOUT_MS);
    requestAnimationFrame((t) => finish(t));
  });
}

/** Run one ramp to completion. Returns its reading.
 *
 *  Timing is the interval between successive rAF timestamps — the same metric `frameProfiler`
 *  uses, and the one the escape logic is written against. It is NOT the CPU time around
 *  `render()`, which on both backends returns before the GPU has done the work and would report
 *  a fill-bound device as infinitely fast.
 *
 *  Exported so a test can drive one ramp directly against fakes, without standing up the whole
 *  probe — needed to prove the warm-up-load cleanup on the `no-frames` exit (#205 R5.4). */
export async function runRamp(
  kind: RampKind,
  renderer: WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  group: THREE.Object3D,
  intervalMs: number,
  deadline: number,
  mark: (stage: string) => void,
  clock: GpuClock | null,
): Promise<RampReading> {
  // ⚠️ ONE UNRECORDED RENDER AT THE START LOAD, BEFORE EVERY RAMP — the fix for a defect that was
  // costing whole devices their verdict.
  //
  // MEASURED, campaign of 2026-08-11, three phones x three launches: EVERY GPU ramp's first step
  // was a 3-6x outlier over its second (Y6 draw `32:272.8` then `64:39.4`; A23 shade `4:140.2` then
  // `8:33.4`; S22 draw `32:15.8` then `64:2.6`). It is a pipeline switch, not a device: each ramp is
  // the first draw of a different geometry and blend state, and the driver pays for that once.
  //
  // It is not cosmetic, because `readRamp` spans from the EARLIEST supra-pin step to the last — so
  // an inflated first step makes the slope flat or NEGATIVE and the reading comes back `'none'`.
  // That is what produced 4 of the 9 unusable readings, and on the Y6 the outlier was large enough
  // (272 ms) to trip `ABORT_FRAME_MS` outright and end the ramp on step one. That phone classified
  // on ZERO of three launches while being perfectly measurable.
  //
  // The corroboration is that the CPU ramp — the ONLY ramp that already warmed up — is the only one
  // with no first-step outlier anywhere, and it read `escaped/measured` 9 times out of 9.
  //
  // A warm-up RENDER rather than a discarded step: a discarded step still costs its (large) time and
  // can still abort the ramp before anything is recorded.
  // ⚠️ CHECK THE DEADLINE BEFORE THE WARM-UP, not only inside the loop. The warm-up render is
  // bounded only by the clock's own 2 s completion timeout (or `nextFrame`'s 5 s), neither of which
  // `HARD_DEADLINE_MS` can see — so with three GPU ramps a probe that is already out of time could
  // still spend seconds warming up ramps it will not measure. Found in close-out review.
  if (rawNow() > deadline) { mark(`${kind}:deadline-before-start`); return readRamp(startRamp(kind, intervalMs)); }
  const warmLoad = RAMP_BOUNDS[kind].startLoad;
  setLoad(group, warmLoad);
  mark(`${kind}:warm`);
  renderer.render(scene, camera);
  if (clock) {
    if (await clock.awaitCompletion() === null) mark(`${kind}:warm-clock-failed`);
  } else if (await nextFrame() === null) {
    mark(`${kind}:warm-no-frames`);
  }

  // ── GPU-PACED: no presentation in the loop at all ──────────────────────────────────────
  // Submit, wait for the GPU to finish it, submit the next load. rAF never appears, so the
  // WebView's boot-time backoff cannot reach this measurement.
  if (clock) {
    let gpuState = startRamp(kind, GPU_NOMINAL_INTERVAL_MS, GPU_RAMP_BUDGET_MS);
    for (;;) {
      const load = rampNextLoad(gpuState);
      if (load === null) break;
      setLoad(group, load);
      mark(`${kind}:${load}`);
      renderer.render(scene, camera);
      const gpuMs = await clock.awaitCompletion();
      // The clock failing mid-ramp is not a slow device — it is no measurement. Stop and report
      // whatever the earlier steps already established rather than recording a fabricated time.
      if (gpuMs === null) { mark(`${kind}:gpu-clock-failed`); break; }
      gpuState = recordRampFrame(gpuState, gpuMs, gpuMs);
      if (rawNow() > deadline) break;
    }
    setLoad(group, 0);
    return readRamp(gpuState);
  }

  let state = startRamp(kind, intervalMs);
  let last = await nextFrame();
  // ⚠️ CLEAR THE LOAD ON THIS EXIT TOO (#205 R5.4). `setLoad(group, warmLoad)` above already made
  // this ramp's warm-up load VISIBLE in the scene, and this early return used to leave it that way
  // — the next ramp's warm-up render (and its first timed frame) would then be contaminated by a
  // load that belongs to a ramp which never got a single measured step. Every other exit from this
  // function already zeroes the load (the GPU-paced path above, and the bottom of the loop below);
  // this was the one that didn't.
  if (last === null) { mark(`${kind}:no-frames`); setLoad(group, 0); return readRamp(state); }

  for (;;) {
    const load = rampNextLoad(state);
    if (load === null) break;
    setLoad(group, load);
    // Marked BEFORE the submit: if this load is the one that kills the process, the last stage
    // reported IS the culprit. A mark after the render would name the last SURVIVED load instead.
    mark(`${kind}:${load}`);
    renderer.render(scene, camera);
    const now = await nextFrame();
    // Frames stopped arriving (the page went invisible mid-ramp). Whatever was recorded stands —
    // `readRamp` reports it as the bound it is — but do not wait forever for the next one.
    if (now === null) { mark(`${kind}:frames-stopped`); break; }
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

  // ⚠️ THE HEAVY RAMP IS OPTIONAL BY CONSTRUCTION. Building its material is the only part of the
  // probe that runs engine shader-graph code, and a backend or a three version that refuses it must
  // still yield the fill/draw/cpu measurement rather than collapsing the whole probe to `null`. A
  // probe that answers less is not the same failure as a probe that answers nothing.
  let heavy: HeavyShadeAssets | null = null;
  let shadeGroup: THREE.InstancedMesh | null = null;
  let shadeRegionPixels = 0;
  try {
    heavy = makeHeavyShadeAssets();
    const built = buildShadeGroup(geometry, heavy.material, cw, ch);
    shadeGroup = built.group;
    shadeRegionPixels = built.regionPixels;
    scene.add(shadeGroup);
  } catch (e) {
    mark(`shade-assets-failed ${String(e).slice(0, 120)}`);
  }

  try {
    mark('import-scene3DSync');
    const { makeWebGPURenderer } = await import('./scene3DSync');
    mark('renderer-create');
    const rendererStarted = rawNow();
    // ⚠️ BOUNDED (#205 R5.3) — see {@link RENDERER_CREATE_TIMEOUT_MS}. This used to be a bare
    // `await` with no timeout at all: every OTHER step in this function bounds itself, but a
    // renderer that never resolves hangs `resolveActiveTier` forever, and `Scene3D.bringUp`'s only
    // failure handling is a `.catch(...)` that a pending promise never reaches — a permanently
    // blank surface with no error. On expiry this throws into the `try` below, which is the SAME
    // degrade path an ordinary creation failure already takes: mark it, dispose what exists, and
    // return `null` so the caller falls back to today's behaviour rather than the tier decision
    // ever seeing a rejection.
    renderer = await awaitOrDispose(makeWebGPURenderer(container), RENDERER_CREATE_TIMEOUT_MS);
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
    // ⚠️ BOUNDED (#205 R5.3) — see {@link TRIVIAL_COMPILE_TIMEOUT_MS}. The SECOND compile 28 lines
    // below already learned this lesson ("an unbounded second compile is exactly the 'boot must
    // never be hostage to the probe' rule being broken by the probe"); this, the FIRST compile, had
    // the same unbounded shape and is the other half of the same defect. Same degrade on expiry:
    // the rejection propagates to the outer `catch`, which marks it and returns `null` rather than
    // throwing into renderer bring-up.
    await withTimeout(renderer.compileAsync(scene, camera), TRIVIAL_COMPILE_TIMEOUT_MS);
    const compileMs = rawNow() - compileStarted;
    mark('compile-ok');
    setLoad(fillGroup, 0);

    // ── THE CPU RAMP RUNS FIRST, AND THE ORDER IS DELIBERATE ──────────────────────────────
    // It needs no GPU, so no GPU ramp's deadline can starve it (which is exactly how the Y6's draw
    // ramp came back empty, twice, before each ramp got its own); nothing has been submitted yet,
    // so it is not being timed against a queue draining underneath it; and it is the cheapest of the
    // four, so paying for it first guarantees every launch yields at least one axis even when the
    // GPU side produces nothing at all.
    const cpu = runCpuRamp(mark, rawNow() + HARD_DEADLINE_MS);
    mark(`cpu-ok ${cpu.status}/${cpu.bound}`);

    // THE SECOND COMPILE, timed apart from the first — see `probeHeavyShader.ts` for why the
    // number is reported rather than assumed. Compiling it here, after the trivial material, is
    // what keeps the two costs separable: `compileAsync` only builds what it has not built already.
    let shadeCompileMs = 0;
    if (shadeGroup) {
      try {
        setLoad(shadeGroup, 1);
        const shadeCompileStarted = rawNow();
        // ⚠️ BOUNDED. This is a genuinely new, non-trivial program (16 dependent taps in a loop) and
        // `compileAsync` had no timeout, no deadline and no budget — on hardware where one program
        // has measured ~1.2 s, an unbounded second compile is exactly the "boot must never be
        // hostage to the probe" rule being broken by the probe. 3 s is ~7x the worst compile
        // actually measured (420-425 ms on an iPhone 7), so no real device should reach it; a
        // device that does loses the shade ramp, not its launch.
        await withTimeout(renderer.compileAsync(scene, camera), SHADE_COMPILE_TIMEOUT_MS);
        shadeCompileMs = rawNow() - shadeCompileStarted;
        setLoad(shadeGroup, 0);
        mark(`shade-compile-ok ${shadeCompileMs.toFixed(0)}ms`);
      } catch (e) {
        // A heavy material that will not compile is not a slow device. Drop the ramp and keep the
        // rest of the probe, rather than letting one optional axis fail the launch's measurement.
        mark(`shade-compile-failed ${String(e).slice(0, 120)}`);
        scene.remove(shadeGroup);
        // Dispose BEFORE dropping the reference — `finally`'s `shadeGroup?.dispose()` cannot reach
        // it once this is null, and this is the one path where the group is fully constructed. No
        // live leak today (the throwaway renderer's own `dispose()` destroys the device and with it
        // every buffer), but that is a property of the renderer being throwaway, not of this code.
        shadeGroup.dispose();
        shadeGroup = null;
        shadeRegionPixels = 0;
      }
    }

    // ── THE GPU-CLOCK PATH, PREFERRED WHENEVER IT IS AVAILABLE (#188 (ii)) ────────────────
    // It waits for the GPU, never for the display, so the WebView's boot-time rAF backoff cannot
    // touch it — and there is consequently no interval to estimate and nothing to declare
    // implausible. The presentation path below stays as the fallback for a backend that offers
    // neither `onSubmittedWorkDone` nor `fenceSync`.
    const clock = makeGpuClock(renderer);
    mark(`gpu-clock ${clock ? clock.kind : 'unavailable'}`);
    if (clock) {
      for (let i = 0; i < GPU_WARMUP_RENDERS; i++) {
        renderer.render(scene, camera);
        if (await clock.awaitCompletion() === null) { mark(`gpu-warmup-failed at ${i}`); break; }
      }
      // ⚠️ A DEADLINE EACH, not one shared between them. Shared, a GPU-paced fill ramp consumed the
      // whole allowance and the draw ramp reported `running` with no reading — measured on the Y6,
      // twice. Each ramp's own `GPU_RAMP_BUDGET_MS` normally stops it long before this fires; this
      // is only the guard against a pathological device, and a guard one ramp can spend on behalf
      // of the other is not a guard for the second one at all.
      const gpuFill = await runRamp('fill', renderer, scene, camera, fillGroup, GPU_NOMINAL_INTERVAL_MS, rawNow() + HARD_DEADLINE_MS, mark, clock);
      mark(`fill-ok ${gpuFill.status}/${gpuFill.bound}`);
      const gpuDraw = await runRamp('draw', renderer, scene, camera, drawGroup, GPU_NOMINAL_INTERVAL_MS, rawNow() + HARD_DEADLINE_MS, mark, clock);
      mark(`draw-ok ${gpuDraw.status}/${gpuDraw.bound}`);
      let gpuShade: RampReading | undefined;
      if (shadeGroup) {
        gpuShade = await runRamp('shade', renderer, scene, camera, shadeGroup, GPU_NOMINAL_INTERVAL_MS, rawNow() + HARD_DEADLINE_MS, mark, clock);
        mark(`shade-ok ${gpuShade.status}/${gpuShade.bound}`);
      }
      return {
        intervalMs: GPU_NOMINAL_INTERVAL_MS, clockKind: clock.kind,
        fill: gpuFill, draw: gpuDraw, shade: gpuShade, cpu,
        totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
        bufferPixels, shadeRegionPixels,
      };
    }

    const warmup: number[] = [];
    let last = await nextFrame();
    if (last === null) { mark('no-frames — the page is not visible'); return null; }
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      renderer.render(scene, camera);
      const now = await nextFrame();
      if (now === null) { mark(`warmup-frames-stopped after ${i}`); return null; }
      warmup.push(now - last);
      last = now;
    }
    // ⚠️ THE GAME'S FRAME INTERVAL, NOT THE rAF CADENCE — they are not the same number, and the
    // probe must measure at the cadence the game will actually run at.
    //
    // `frameDriver` caps rendering at `targetFPS` (60 by default) by SKIPPING rAF callbacks, while
    // this runner drives its own rAF loop and so sees every tick. Measured natively on a Galaxy
    // S22: rAF ticks every 8.4 ms (~119 Hz) and the game renders every other one at 16.8 ms / 60
    // fps. Feeding 8.4 into the ramp halves both derived thresholds — escape becomes 25 ms instead
    // of 50, the budget 75 ms instead of 150 — so that phone was pushed to a different operating
    // point on its load curve than a 60 Hz phone, ran out of budget before escaping, and produced
    // nothing but lower bounds. It never settled on a tier at all.
    //
    // MAX, not the target outright: the measured value still has to win when the DISPLAY is the
    // slower of the two. A thermally throttled iPhone 8 really does drop to 30 Hz, and the probe
    // has to see 33 ms there rather than assume 16.7 — that case is why the interval is measured
    // in the first place (see `estimateIntervalMs`). A game cannot render faster than either its
    // own cap or the display, so the effective interval is whichever is longer.
    const measuredIntervalMs = estimateIntervalMs(warmup);
    const cappedIntervalMs = targetFPS > 0 ? 1000 / targetFPS : 0;
    const intervalMs = Math.max(measuredIntervalMs, cappedIntervalMs);
    mark(`warmup-ok interval=${intervalMs.toFixed(1)} (rAF ${measuredIntervalMs.toFixed(1)}, cap ${cappedIntervalMs.toFixed(1)})`);
    if (intervalMs <= 0) return null;
    // ⚠️ THE PLAUSIBILITY TEST IS ON THE MEASURED VALUE ONLY, never on `intervalMs`. The cap is a
    // deliberate project choice and a game that targets 20 fps has a legitimate 50 ms interval;
    // it is the MEASUREMENT that can be contaminated, and only the measurement is being doubted.
    const intervalImplausible = measuredIntervalMs > MAX_PLAUSIBLE_INTERVAL_MS;
    if (intervalImplausible) {
      mark(`interval-implausible ${measuredIntervalMs.toFixed(1)}ms `
        + `[${warmup.map((f) => f.toFixed(0)).join(' ')}] — the warm-up timed the boot, not the display`);
    }

    // ⚠️ The ramp deadline starts HERE, after setup — not at the top of the probe. It used to
    // include renderer creation, and on an iPhone 13 mini's FIRST run that took 796 ms (against
    // 3 ms once warm): setup alone consumed the whole allowance, both ramps broke out on their
    // first frame, and the run produced `status: 'running'` with no reading at all. Setup cost is
    // real and is reported (`rendererMs`, `compileMs`), but it must not be able to starve the
    // measurement it exists to enable.
    // ⚠️ RETURN THE CPU AXIS EVEN HERE, and note this is NOT a softening of the decline. The
    // plausibility guard exists because every PRESENTATION-paced threshold is a multiple of the
    // interval, so a contaminated interval poisons the fill and draw ramps — it says nothing about a
    // ramp that never consulted the display. Those two are reported as the empty readings they are
    // (`bound: 'none'`, which `classifyDevice` already refuses to classify), so the verdict is
    // exactly as declined as it was before; what changes is that the launch stops throwing away the
    // one measurement it did legitimately take.
    if (intervalImplausible) {
      const declined = (kind: RampKind) => readRamp(startRamp(kind, 0));
      return {
        intervalMs, clockKind: 'raf' satisfies ProbeClockKind,
        fill: declined('fill'), draw: declined('draw'), cpu,
        totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
        // The real region, not 0: `shadeCompileMs` above is non-zero whenever the heavy material
        // compiled, and a log that charges a launch for "compile" while claiming no shade ramp
        // exists reads as a run where the material was never built.
        bufferPixels, shadeRegionPixels,
      };
    }
    // ⚠️ A DEADLINE EACH HERE TOO. The GPU-clock path above was given per-ramp deadlines after a
    // shared one starved the Y6's draw ramp twice — and this fallback was left sharing one, then
    // had a THIRD ramp added in front of it. Shared, fill and draw can consume up to 360 ms each of
    // their own budgets and leave `shade` entering `runRamp` already past the deadline: its loop
    // body runs once regardless, so it renders one frame and breaks with `status: 'running'`, which
    // reads as `bound: 'none'`. Silently starved, on the fallback path that exists precisely for
    // the oldest hardware. Found in close-out review.
    //
    // ⚠️ `escapableIntervalMs(intervalMs)`, NOT the raw `intervalMs` — see its doc (#205 R5.4). A
    // large enough authored `targetFPS` pushes `intervalMs` past `ABORT_FRAME_MS / ESCAPE_MULTIPLE`,
    // at which point escape becomes unreachable before abort. `intervalMs` itself is still what
    // gets reported below; only the ramps' own escape yardstick is bounded.
    const rampIntervalMs = escapableIntervalMs(intervalMs);
    const fill = await runRamp('fill', renderer, scene, camera, fillGroup, rampIntervalMs, rawNow() + HARD_DEADLINE_MS, mark, null);
    mark(`fill-ok ${fill.status}`);
    const draw = await runRamp('draw', renderer, scene, camera, drawGroup, rampIntervalMs, rawNow() + HARD_DEADLINE_MS, mark, null);
    mark(`draw-ok ${draw.status}`);
    let shade: RampReading | undefined;
    if (shadeGroup) {
      shade = await runRamp('shade', renderer, scene, camera, shadeGroup, rampIntervalMs, rawNow() + HARD_DEADLINE_MS, mark, null);
      mark(`shade-ok ${shade.status}`);
    }

    return {
      intervalMs, clockKind: 'raf' satisfies ProbeClockKind,
      fill, draw, shade, cpu,
      totalMs: rawNow() - started, rendererMs, compileMs, shadeCompileMs,
      bufferPixels, shadeRegionPixels,
    };
  } catch (e) {
    // A probe failure must never block rendering — the caller falls back to today's behaviour,
    // which starts low. Same policy as a failed `getDeviceCaps()`.
    mark(`threw ${String(e).slice(0, 160)}`);
    return null;
  } finally {
    // Dispose in full: this renderer exists only to answer one question, and a leaked GPU context
    // is a real cost on exactly the low-memory hardware being characterised.
    (fillGroup as THREE.InstancedMesh).dispose?.();
    drawGroup.clear();
    shadeGroup?.dispose();
    // The heavy material and its texture are the probe's largest GPU residents after the renderer
    // itself, and they are disposed whether or not the ramp ever ran — `shadeGroup` is null on a
    // compile failure, but `heavy` was already built by then.
    heavy?.material.dispose();
    heavy?.texture.dispose();
    geometry.dispose();
    material.dispose();
    renderer?.dispose();
    container.remove();
  }
}
