/** The "hold the first frame until the new scene's pipelines are compiled" decision (#238).
 *
 *  Extracted from `Scene3D.tsx` because it is a state machine with four ways to go wrong, and a
 *  renderer component is not somewhere they can be tested: a compile that resolves after a SECOND
 *  swap, a compile that rejects, a compile that never settles, and a kick that fires twice.
 *
 *  WHAT IT IS FOR. The pre-swap prewarm compiles a COPY of the incoming scene; the copy has
 *  differed from what the renderer drew six separate times, and for light-mask variants it
 *  provably always will (they are keyed by `THREE.Light` instance and the cache is dropped on
 *  swap). So the renderer also compiles the LIVE scene after the swap — and the only way that
 *  helps is if the first draw waits for it. Otherwise the first draw builds those pipelines
 *  itself, synchronously, which IS the boot stall: measured at 2.1–2.3 s on a Galaxy A23.
 *
 *  WHAT IT COSTS, stated plainly because it is a real behaviour change: between the swap and the
 *  first drawn frame the surface shows the PREVIOUS content (a loading screen, usually) while the
 *  ECS keeps ticking. Before this, the surface drew one frame and then froze mid-draw for the same
 *  duration. Neither is free; this one keeps rAF alive, so animated loading UI, input and audio
 *  keep running instead of the whole app appearing hung.
 *
 *  The hold is normally SHORT — everything the prewarm got right is already in three's pipeline
 *  cache, so the live compile is a walk over cache hits. It costs what the prewarm missed. */

/** Injected so tests drive it without a clock, per the determinism rules. Production passes
 *  `rawNow` — this is a real-time deadline (a compile is wall-clock work), never sim time. */
export interface LiveCompileGateOpts {
  /** Ceiling on the hold. Exceeding it releases the frame WITHOUT cancelling the compile. */
  maxHoldMs: number;
  now: () => number;
  /** Called when a hold ends because its own compile settled — the surface may be idle-gated and
   *  need waking to draw the scene that was just compiled. Not called for a stale generation. */
  onSettled?: () => void;
  onError?: (e: unknown) => void;
}

export interface LiveCompileGate {
  /** A world swap happened: the next `tick` kicks a compile for the newly-live scene. */
  arm(): void;
  /** Call once per frame at the submit point. Returns true when the caller must SKIP its submit.
   *  `kick` is only invoked on the first tick after `arm()` — the caller builds it fresh each
   *  frame because what to compile (plain scene vs post-FX scene pass) is a per-frame decision. */
  tick(kick: () => Promise<void>): boolean;
  /** True while a compile is in flight, for tests and diagnostics. */
  isPending(): boolean;
}

export function createLiveCompileGate(opts: LiveCompileGateOpts): LiveCompileGate {
  let armed = false;
  let pending = false;
  let deadline = 0;
  /** Bumped per kick. A compile still in flight across a SECOND swap must not clear the newer
   *  hold when it lands — its promise closure holds the OLD scene, and releasing the frame on it
   *  would draw the new scene with the old scene's pipelines missing. Same token shape
   *  `frameDriver` and `gpuTimings` use, for the same reason. */
  let generation = 0;

  return {
    arm() { armed = true; },
    isPending() { return pending; },
    tick(kick: () => Promise<void>): boolean {
      if (armed) {
        armed = false;
        const gen = ++generation;
        pending = true;
        deadline = opts.now() + opts.maxHoldMs;
        // `.then(…, …)` rather than `.finally`: a rejected compile must release the frame too.
        // The alternative is a viewport that never draws again because a shader failed to build,
        // which is strictly worse than the stall this is here to remove.
        //
        // The try/catch turns a SYNCHRONOUS throw from `kick` (a missing three API, a null stack)
        // into the same rejection. Left to propagate it would escape `tick` into the frame
        // callback with `pending` set and nothing in flight to clear it, so every swap would hold
        // for the full deadline. Caught rather than routed through an extra `Promise.resolve()`
        // tick, so the settle timing a caller can observe is unchanged.
        let work: Promise<void>;
        try { work = kick(); } catch (e) { work = Promise.reject(e); }
        work.then(
          () => { if (gen === generation) { pending = false; opts.onSettled?.(); } },
          (e) => {
            opts.onError?.(e);
            if (gen === generation) { pending = false; opts.onSettled?.(); }
          },
        );
      }
      if (!pending) return false;
      // The deadline releases the FRAME, not the compile: the work is still useful when it lands,
      // and cancelling a GPU pipeline build is not something the API offers anyway.
      if (opts.now() >= deadline) return false;
      return true;
    },
  };
}
