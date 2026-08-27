/** gpuPoolReveal — WHEN a GPU particle pool may first be DRAWN (#338).
 *
 *  Extracted from `gpuComputeBackend` so the decision is testable without pulling in
 *  `three/webgpu` + TSL: a test that had to mock the whole GPU construction path would mostly be
 *  asserting its own mocks, and this constant is the one thing in that file worth a guard.
 *
 *  ## The defect
 *
 *  A GPU pool is not drawable until its init compute has actually landed. Drawing it earlier
 *  renders `maxParticles` instances against buffers the dispatch has not filled — which on
 *  `demos/particle-demo`'s 40k Nebula is a **full-screen white wash** for the station's opening
 *  frames. (Not zeroed buffers: zeros give `meta.z = 0` → `scaleNode = 0` → nothing drawn. The
 *  readable content is stale/recycled pool memory, drawn additively at 40k instances.)
 *
 *  The reason the first draw is so early is structural: `gpuComputeBackend` can only obtain a
 *  renderer from `onBeforeRender`, i.e. from a DRAW — so the first draw necessarily precedes the
 *  first `update()` that can dispatch anything. The pool therefore starts at `instanceCount = 0`.
 *
 *  ## ⚠️ This counter is the FALLBACK, not the mechanism
 *
 *  The pool is revealed by a real readiness SIGNAL — `queue.onSubmittedWorkDone()`, taken right
 *  after the init dispatch (`revealWhenGpuWorkDone`). `finishCompute` submits each compute group's
 *  own command buffer immediately, so that promise resolves once our dispatch has actually
 *  COMPLETED on the device. That cannot be too early by construction, and it self-tunes across
 *  GPUs instead of encoding one device's pipeline depth as a number.
 *
 *  ⚠️ **Why a signal succeeds where a frame count of the same latency failed**, which is the whole
 *  case for this design: `REVEAL_DELAY_FRAMES = 1` was MEASURED to still flash, yet the signal
 *  reveals about a frame after the dispatch and is clean over repeated takes. Elapsed time is not
 *  the thing that matters — completion is. A counter can only ever approximate that, and the
 *  approximation is what turned out to be flaky. Verified reachable on a Galaxy S22:
 *  `isWebGPUBackend true, backend.device.queue.onSubmittedWorkDone` present and resolving, so the
 *  reveal is genuinely signal-driven there rather than silently falling through to the counter —
 *  a distinction worth re-checking on any new backend, because the fallback hides its own absence.
 *
 *  This counter still runs underneath, because the signal reaches through `backend.device` and
 *  that only exists on the native WebGPU backend: on the WebGL fallback, on a lost device, or in a
 *  browser without `onSubmittedWorkDone`, the counter is the only thing that ever reveals the
 *  pool. Everything below is about choosing THAT number — a backstop, no longer the primary path.
 *
 *  ## ⚠️ BISECTED ON HARDWARE — two GPUs, same answer
 *
 *  Measured as mean frame luma at the station's entry, from a screen recording:
 *
 *  | delay | Galaxy S22 (Adreno 730) | Galaxy A23 (Mali-G57 MC2) |
 *  |-------|-------------------------|---------------------------|
 *  |   0   | 2 frames @ 204          | 2 frames @ 219            |
 *  |   1   | flashes                 | —                         |
 *  |   2   | 1 frame @ 204 (x2 runs) | 1 frame @ 219             |
 *  |   3   | clean, peak 117.6       | clean, peak 129           |
 *  |   5   | clean, peak 117.6       | —                         |
 *  |  10   | clean, peak 117.9       | —                         |
 *
 *  (Steady-state nebula reads ~117 on the S22, ~129 on the A23 — so "clean" means the entry never
 *  exceeds the station's own normal brightness.)
 *
 *  Both GPUs stopped flashing at 3, which is why this is a fixed DEPTH rather than a
 *  performance-dependent latency: a flagship Adreno and a low-end Mali would not agree otherwise.
 *
 *  ⚠️ **3 IS THE MARGINAL VALUE, NOT A SAFE ONE — and the bisect above could not see that,
 *  because it ran ONE take per row and the failure is INTERMITTENT.** Re-running a single build
 *  pinned at 3 four times gave `204.1 / 118.1 / 117.9 / 118.0` — one flash in four. A single-take
 *  bisect of a flaky failure finds where it *usually* stops and reads that as a threshold. The
 *  fallback is therefore DOUBLE the observed edge, verified by REPEATED takes: at 6, five runs of
 *  one build gave `118.2 / 118.1 / 118.1 / 117.9 / 118.0`, 5/5 clean. **If you revisit this number,
 *  repeat every take — one clean run proves nothing here.** (This flakiness is also the best
 *  argument for the signal above: a number tuned against an intermittent failure is a guess with
 *  error bars, and `onSubmittedWorkDone` has none.)
 *
 *  ⚠️ "Fixed pipeline depth" is a HYPOTHESIS, not a measurement — what is measured is the table
 *  and the repeat runs. Until the mechanism is established, treat this as a depth rather than a
 *  tuning knob: **do not change it in either direction without repeated takes on real hardware.**
 *  No unit test can see this class of bug — it needs a device, a screen recording, and per-frame
 *  luma.
 *
 *  ## The cost, counted honestly
 *
 *  **`REVEAL_DELAY_FRAMES + 1` blank frames — seven at the current value, not six and not one.**
 *  The sequence is: frame N `create()` (no renderer yet, `update()` bails); N+1 the first draw
 *  captures the renderer and dispatches `computeInit`; N+2..N+6 count; N+7 reveals. That is
 *  ~117 ms at 60fps in which a fresh pool draws nothing.
 *
 *  On `demos/particle-demo` those frames are genuinely invisible, and that is a MEASUREMENT rather
 *  than an assumption: a station cuts in from black, so the recordings show the entry going
 *  `34 → 34 → 34 → 129` (A23) with the blank frames indistinguishable from the inter-station
 *  darkness they extend. ⚠️ That does NOT generalise. An emitter that appears over a lit scene —
 *  a gameplay VFX on a hit — would show a real 67 ms hole, and `cpuTslBackend`'s texture wait
 *  bounds its own wait for exactly that reason. If a GPU effect ever needs to fire on a gameplay
 *  event, this needs the same treatment; today every GPU-eligible effect is ambient (`fillPool`).
 *
 *  Only a FRESH pool pays it. `restart()` re-seeds buffers that already hold valid data, so it is
 *  deliberately not re-hidden. `seek()` does NOT reveal directly either, though an earlier version
 *  did: it dispatches `computeInit` and would have drawn in the same JS call — a ZERO-frame
 *  boundary, when a one-frame boundary is on the disproved list above. It restarts the countdown
 *  instead and lets `ensurePoolReady` finish the job.
 *
 *  ## ⚠️ There is no readiness SIGNAL to use instead — checked, in three r184
 *
 *  The principled fix would be "reveal when the dispatch has demonstrably completed". That signal
 *  does not exist in the renderer API, and the two things that look like it are traps:
 *
 *    - `Renderer.waitForGPU()` — WAS this signal. It is now a stub that only raises an error
 *      (three r184 `Renderer.js`, see mrdoob/three.js#32012).
 *    - `Renderer.computeAsync()` — its JSDoc says "resolves when the compute has finished". It
 *      does not: the body awaits BACKEND INIT and then dispatches synchronously. Rewriting this
 *      gate as `await computeAsync(...)` would reintroduce the flash with a green gate.
 *
 *  The only true signal is raw `renderer.backend.device.queue.onSubmittedWorkDone()` — private,
 *  WebGPU-only, outside the `ComputeRenderer` seam this backend deliberately narrows to, and
 *  asynchronous onto some later frame anyway. The frame count is the right fix for today.
 */
export const REVEAL_DELAY_FRAMES = 6;

/** Pure gate: may a pool whose `computeInit` was dispatched `framesSinceInit` frames ago be drawn?
 *
 *  A negative / NaN count reads as "not yet" — failing CLOSED costs one invisible frame, while
 *  failing open costs a full-screen white flash, so the asymmetry decides the direction. */
export function poolRevealDue(framesSinceInit: number): boolean {
  return Number.isFinite(framesSinceInit) && framesSinceInit >= REVEAL_DELAY_FRAMES;
}
