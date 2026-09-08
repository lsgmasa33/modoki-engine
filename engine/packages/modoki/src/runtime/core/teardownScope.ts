/** A release path that exists BEFORE the first thing is acquired (#858).
 *
 *  THE BUG THIS EXISTS TO MAKE UNWRITABLE. Every long bring-up in this repo used to build one big
 *  teardown closure at the END of setup and only then hand it to the unmount path:
 *
 *      let cleanup: (() => void) | undefined;
 *      const setup = async () => {
 *        setEditorViewportCamera(camera);   // ← taken here
 *        …2,000 lines…                      // ← a throw anywhere in here
 *        cleanup = () => { …release it… };  // ← never reached
 *      };
 *      const teardown = () => { const fn = cleanup; cleanup = undefined; fn?.(); };
 *
 *  So a bring-up that ends early — a throw, a rejected await, an early return — leaves everything
 *  it already took both unreleased AND unreachable: `cleanup` is still `undefined`, so `fn?.()`
 *  releases nothing, and the closure that knew how to release it was never built. The census in
 *  #858 found this in FIVE viewports (SceneView, Scene3D, ParticleEditor, previewScene,
 *  ModelPreview). It is not a guard problem — a release-side identity guard (#811) is inert when
 *  release never runs.
 *
 *  THE SHAPE. Push a release the moment you take the thing, into a scope the teardown path already
 *  holds:
 *
 *      const scope = createTeardownScope('SceneView');
 *      cleanup = scope.dispose;                        // ← reachable before anything is taken
 *      const r = await acquireRenderer(container, …);
 *      scope.add(() => releaseRenderer(container));     // ← pushed at the acquisition site
 *
 *  Whatever was taken gets released, whether bring-up finished or not. This is not a new idea
 *  here — `ShaderPreview.tsx` defines its `teardown` before the async IIFE that acquires anything,
 *  and `App.tsx`'s boot effect claims ownership with the comment "Claim ownership BEFORE the first
 *  registration, not after the last". Those two got it right by hand; this is the same discipline
 *  as an object, for the bring-ups whose teardown references dozens of locals that do not exist
 *  yet and so cannot simply be written first.
 *
 *  Four properties, each because a specific site needs it — none is defensive padding:
 *
 *  1. LIFO. Releases run in reverse acquisition order, so a resource is never released before
 *     something acquired later that depends on it.
 *  2. IDEMPOTENT. `SceneView`'s `teardownViewport()` and `ParticleEditor`'s GPU-loss teardown can
 *     both fire; the second is a no-op rather than a double-free.
 *  3. EVERY STEP INDIVIDUALLY CAUGHT. `Scene3D`'s existing cleanup already carries a comment
 *     explaining why: on the context-loss recovery path the GPU context is ALREADY DEAD and
 *     three's `dispose()` paths touch the GPU, so one throw skipping every later step is a live
 *     failure mode, not a hypothetical.
 *  4. `add()` AFTER DISPOSAL RUNS THE RELEASE IMMEDIATELY. This closes the mirror-image defect
 *     with the same object instead of a second mechanism: a registration that arrives from a
 *     pending promise *after* teardown already ran (`Scene3D.tsx`'s
 *     `prewarmShadersForWorld(...).then(startLoop, startLoop)`) self-releases rather than
 *     re-registering into a viewport that is gone.
 *
 *  WHAT THIS IS NOT. It does not decide WHEN teardown happens — the effect/lease/recovery paths
 *  still own that. It is not an ownership model for GPU resources (#695) and it does not change
 *  who may hold a renderer (#802). It only makes the existing releases reachable earlier. */

/** A growing list of releases, held by the teardown path from before the first acquisition. */
export interface TeardownScope {
  /** Register a release for something just acquired. Called after disposal, it runs the release
   *  immediately (property 4 above) rather than storing it where nothing would ever call it.
   *
   *  `label` names the step in the console error if it throws. Worth passing wherever the drain
   *  runs over an ALREADY-DEAD GPU context (the context-loss rebuild paths), because there
   *  "a teardown step threw" without saying which registry is the difference between a diagnosis
   *  and a shrug — `Scene3D`'s hand-rolled `step(what, fn)` existed for exactly that. */
  add(release: () => void, label?: string): void;
  /** Whether `dispose()` has already run. Read it to skip work that is about to be undone. */
  readonly disposed: boolean;
  /** Run every registered release, LIFO, once. A bound value, so it can be handed straight to a
   *  teardown path (`cleanup = scope.dispose`) without a wrapper that could go stale. */
  readonly dispose: () => void;
}

/** Create a scope. `label` prefixes the console error if a release throws — name the bring-up it
 *  belongs to (`'SceneView'`, `'Scene3D'`), since that is what a reader needs to locate it. */
export function createTeardownScope(label: string): TeardownScope {
  const releases: Array<{ release: () => void; step?: string }> = [];
  let isDisposed = false;

  /** One release, isolated. A throw here is reported and swallowed BY DESIGN (property 3): the
   *  remaining steps are what stop the leak, and skipping them to propagate one failure trades a
   *  reported fault for a silent one. */
  const run = (release: () => void, step?: string): void => {
    try {
      release();
    } catch (e) {
      console.error(
        `[${label}] teardown step ${step ? `"${step}" ` : ''}threw; the remaining steps still ran:`,
        e,
      );
    }
  };

  const dispose = (): void => {
    if (isDisposed) return;
    // Set BEFORE draining, not after: a release that re-enters `dispose()` (a GPU-loss teardown
    // firing while an unmount teardown is mid-drain) must find the scope already closed rather
    // than recurse into a half-emptied list.
    isDisposed = true;
    // Drains destructively rather than iterating a snapshot, so the list is empty the moment the
    // loop ends and nothing can hold a second reference to a release that already ran. A release
    // that itself calls `add()` mid-drain does NOT land here — the scope is already closed, so
    // `add()` takes its run-immediately path (property 4), which is the same outcome one step
    // earlier.
    while (releases.length > 0) { const e = releases.pop()!; run(e.release, e.step); }
  };

  return {
    add(release: () => void, step?: string): void {
      if (isDisposed) {
        run(release, step);
        return;
      }
      releases.push({ release, step });
    },
    get disposed(): boolean {
      return isDisposed;
    },
    dispose,
  };
}
