/** A clock that measures SUBMITTED GPU WORK, not presentation (#188).
 *
 *  ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *  The boot ramp probe timed its steps with rAF deltas, and rAF is a PRESENTATION signal. During a
 *  game's boot the WebView does not present steadily: measured on three phones, frame deltas back
 *  off in whole multiples of each device's own tick (S22 419 -> 460 -> 502 ms = 50, 55, 60 ticks of
 *  8.37 ms; A23 and Y6 stepping one 16.7 ms tick at a time). Frames are still landing on the panel's
 *  grid — most slots are simply skipped. A saturated CPU does not miss exactly 17 then 18 then 19
 *  slots in a row, so this is a scheduler backing off, and no amount of waiting fixes it: the probe
 *  was reading the backoff's period and calling it a frame time.
 *
 *  So stop using presentation as the clock. Both backends can say when the GPU actually FINISHED the
 *  work that was submitted, which is the quantity the ramp wants and is independent of how often
 *  anything is presented — during boot, while throttled, before anything is drawn.
 *
 *  ── WHAT IT DOES NOT REMOVE ───────────────────────────────────────────────────────────────
 *  ⚠️ Completion is still DELIVERED to the main thread (a resolved promise on WebGPU, a polled fence
 *  on WebGL2), so a busy main thread still adds scheduling latency to the reading. That is why the
 *  ramp keeps estimating throughput from the SLOPE between two loads rather than from one absolute
 *  time: a roughly-constant delivery latency cancels in `(l2 - l1) / (t2 - t1)` exactly as fixed
 *  per-frame overhead always did. This clock removes the QUANTIZATION and the BACKOFF; it does not
 *  claim to remove main-thread latency, and a reading is not a GPU timestamp.
 *
 *  ⚠️ It is also NOT `EXT_disjoint_timer_query_webgl2`. That extension is unsupported on most
 *  low-end Android — the population the tier system exists for — which is why P7's GPU timings
 *  cannot answer this and why the probe was built around rAF in the first place. Fence sync is CORE
 *  WebGL2, so it is present wherever the engine's WebGL2 backend is. */

import { rawNow } from '../core/clock';
import { withTimeout } from '../core/abandonment';

/** How long to wait for one submit to complete before declaring the clock unusable. Generously
 *  above the ramp's own `ABORT_FRAME_MS` (250) — this bounds a WEDGED fence, not a slow one. */
const COMPLETION_TIMEOUT_MS = 2_000;

/** Polling gap for the WebGL2 fence, ms. `setTimeout(0)` is clamped to ~4 ms once nested, which is
 *  the resolution floor of the WebGL2 path — acceptable because the ramp measures loads that take
 *  tens of ms, and because the slope cancels a constant polling bias. */
const FENCE_POLL_MS = 0;

export interface GpuClock {
  /** Which mechanism is timing — reported in the probe log, because a number from a fence and a
   *  number from a queue promise have different noise floors and should never be silently mixed. */
  readonly kind: 'webgpu' | 'webgl2';
  /** Elapsed ms from "now" until the GPU finishes everything submitted so far, or `null` when the
   *  measurement failed. CALL IMMEDIATELY AFTER `renderer.render()`. */
  awaitCompletion(): Promise<number | null>;
}

/** three's backend internals, which are not part of its public types and have moved before — every
 *  hop below is optional-chained for that reason (same discipline as `activeRenderer.ts`). */
interface BackendLike {
  isWebGLBackend?: boolean;
  device?: GPUDevice;
  gl?: WebGL2RenderingContext;
}

/** Build a clock for this renderer, or `null` when neither mechanism is reachable — in which case
 *  the caller must fall back to presentation timing and say so. */
export function makeGpuClock(renderer: unknown): GpuClock | null {
  const backend = (renderer as { backend?: BackendLike } | null)?.backend;
  if (!backend) return null;

  // WebGPU first: one promise, no polling, and the least main-thread work of the two.
  const device = backend.device;
  if (!backend.isWebGLBackend && typeof device?.queue?.onSubmittedWorkDone === 'function') {
    return {
      kind: 'webgpu',
      async awaitCompletion() {
        const started = rawNow();
        try {
          await withTimeout(
            device.queue.onSubmittedWorkDone(),
            COMPLETION_TIMEOUT_MS,
            'GPU clock (WebGPU onSubmittedWorkDone)',
            // A late completion is a stale GPU duration for a measurement this call has already
            // abandoned — it owns nothing (no resource to release) and nothing downstream is
            // still waiting on it, so there is nothing to adopt or dispose of.
            { discard: 'a late GPU duration for an already-abandoned measurement owns nothing' },
          );
        } catch { return null; }
        return rawNow() - started;
      },
    };
  }

  const gl = backend.gl
    ?? (renderer as { getContext?: () => unknown } | null)?.getContext?.() as WebGL2RenderingContext | undefined;
  if (gl && typeof gl.fenceSync === 'function') {
    return {
      kind: 'webgl2',
      async awaitCompletion() {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) return null;
        // ⚠️ FLUSH, OR THE FENCE MAY NEVER BE REACHED. A fence only signals once the commands
        // BEFORE it have been consumed, and a driver is free to sit on an unflushed command buffer
        // indefinitely — the classic way this measurement hangs rather than returns.
        gl.flush();
        const started = rawNow();
        try {
          for (;;) {
            const status = gl.clientWaitSync(sync, 0, 0);
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
              return rawNow() - started;
            }
            if (status === gl.WAIT_FAILED) return null;
            if (rawNow() - started > COMPLETION_TIMEOUT_MS) return null;
            await new Promise((r) => setTimeout(r, FENCE_POLL_MS));
          }
        } finally {
          gl.deleteSync(sync);
        }
      },
    };
  }

  return null;
}
