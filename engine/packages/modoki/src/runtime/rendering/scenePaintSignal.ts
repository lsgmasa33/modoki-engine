/** "The renderer has actually PAINTED a frame of the scene that just swapped in" (#334).
 *
 *  WHY THIS EXISTS. Two mechanisms cover the window between a world swap and the first real
 *  frame, and until this module they were not connected:
 *
 *   - RENDER level — `liveCompileGate` holds `Scene3D`'s submit while the post-swap live compile
 *     is in flight, so the first DRAWN frame is the first frame whose pipelines exist. It is tied
 *     to real completion (with a 5 s ceiling).
 *   - DOM level — `GameShell` (`engine/app/App.tsx`) hides the opaque `LoadingOverlay`, revealing
 *     the game's HUD, after a FIXED two-`requestAnimationFrame` wait past the swap. That is a
 *     heuristic, and on a device where the live compile outruns two frames it is simply wrong:
 *     measured on a Galaxy A23 cold-booting `demos/forest-camp`, the HUD (title + D-pad) was
 *     fully visible over a flat dark canvas with nothing 3D drawn for most of a second.
 *
 *  This is the missing wire: `Scene3D` arms on every world swap and marks each real submit, and
 *  the DOM layer awaits that instead of counting frames. The overlay then stays up until there
 *  is something under it, on any device, regardless of how long the compile takes.
 *
 *  ⚠️ IT IS A ONE-BIT SIGNAL, NOT A GENERATION COUNTER, AND THAT IS DELIBERATE. `liveCompileGate`
 *  needs a generation token because a compile promise from an OLD swap can land after a NEWER one
 *  and would otherwise release the newer hold. Nothing of that shape can happen here: `armScenePaint`
 *  is called synchronously from the swap listener and `markScenePainted` synchronously from the
 *  submit, so a paint can only ever be attributed to the swap that most recently armed. A waiter
 *  parked across a second swap therefore correctly waits for the NEWER scene's paint — which is
 *  what an overlay wants, since the newer scene is the one that will be under it.
 *
 *  ⚠️ A PROJECT WITH NO 3D SURFACE MUST NEVER AWAIT THIS — nothing would ever arm or mark it. The
 *  caller decides (`GameShell` checks the same `disable3D || !Scene3D` condition it already uses to
 *  decide whether to render `Scene3D` at all). Belt and braces: `waitForScenePaint` resolves
 *  `'idle'` immediately when nothing is armed, `abandonScenePaint` releases waiters when the 3D
 *  surface tears down or fails to come up, and the ceiling below bounds every remaining case.
 */

/** Ceiling on the DOM-level wait, mirroring `liveCompileGate`'s `LIVE_COMPILE_MAX_HOLD_MS`.
 *
 *  The render layer gives up holding the frame 5 s after it kicks the compile — which is one frame
 *  after the swap, i.e. STRICTLY EARLIER than a caller can start waiting here (it has a scene load
 *  and an `onSceneReady` hook to get through first). So on the pathological "compile never settles"
 *  path the render layer releases and paints first, and this resolves on that paint rather than on
 *  its own deadline. The deadline is here for the cases the render layer cannot signal at all: a
 *  render loop that never starts, a surface that never becomes visible, a swap with no 3D content.
 *  It must never be possible for a stuck renderer to leave the loading overlay up forever. */
export const SCENE_PAINT_MAX_WAIT_MS = 5000;

export type ScenePaintOutcome =
  /** A frame of the armed scene was submitted. */
  | 'painted'
  /** Nothing was armed (or the armed scene had already painted) — nothing to wait for. */
  | 'idle'
  /** The 3D surface went away (unmount, teardown, or a renderer that never came up). */
  | 'abandoned'
  /** The caller aborted (`GameShell`'s boot-effect cleanup). */
  | 'cancelled'
  /** `SCENE_PAINT_MAX_WAIT_MS` elapsed with no paint. */
  | 'timeout';

interface Waiter {
  resolve: (outcome: ScenePaintOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

/** True while a swapped-in scene is still waiting for its first submitted frame. */
let armed = false;
let waiters: Waiter[] = [];

function settle(outcome: ScenePaintOutcome): void {
  if (waiters.length === 0) return;
  // Swap the list out BEFORE resolving: a `resolve` continuation cannot run synchronously here
  // (promise jobs are microtasks), but a `detach`/abort path could, and mutating the array while
  // iterating it is how the second waiter gets skipped.
  const pending = waiters;
  waiters = [];
  for (const w of pending) {
    clearTimeout(w.timer);
    w.detach();
    w.resolve(outcome);
  }
}

/** A world swap happened: the next submitted frame is this scene's first. Called from
 *  `Scene3D`'s `onWorldSwap` listener, beside `liveCompileGate.arm()`. */
export function armScenePaint(): void {
  armed = true;
}

/** A frame reached the GPU. Called at the END of `Scene3D`'s `renderFrame`, i.e. only on a path
 *  that actually submitted — every early return (idle gate, capture guard, compile hold) skips it.
 *  Cheap enough for the hot path: a boolean test on every frame after the first. */
export function markScenePainted(): void {
  if (!armed) return;
  armed = false;
  settle('painted');
}

/** The 3D surface can no longer produce that frame — it unmounted, its renderer was torn down, or
 *  `createRenderer` failed outright. Releases waiters immediately instead of making them sit out
 *  the ceiling for a frame that is never coming. Does NOT disarm: a rebuild after context loss
 *  re-mounts the loop and the pending scene still wants its paint marked.
 *
 *  Unconditional, not refcounted across surfaces, because the ONLY consumer of the wait is the
 *  runtime `GameShell`, which mounts exactly one `Scene3D`. (The editor mounts two loops — GameView
 *  and SceneView — but renders `EditorApp` INSTEAD of `GameShell`, so there is never a waiter there
 *  for one panel's teardown to release early.) */
export function abandonScenePaint(): void {
  settle('abandoned');
}

/** Resolve once the armed scene has painted. Resolves IMMEDIATELY (`'idle'`) when nothing is
 *  armed — including the ordinary fast case where the paint already happened while the caller was
 *  finishing its own boot work — so a project whose compile is trivial pays nothing at all here.
 *
 *  `signal` is the caller's cancel token: `GameShell` aborts it from the boot effect's cleanup so a
 *  game change mid-load drops the waiter and its timer instead of leaking them for 5 s. */
export function waitForScenePaint(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ScenePaintOutcome> {
  if (!armed) return Promise.resolve<ScenePaintOutcome>('idle');
  if (opts?.signal?.aborted) return Promise.resolve<ScenePaintOutcome>('cancelled');
  const timeoutMs = opts?.timeoutMs ?? SCENE_PAINT_MAX_WAIT_MS;
  return new Promise<ScenePaintOutcome>((resolve) => {
    const signal = opts?.signal;
    const onAbort = () => {
      waiters = waiters.filter(w => w !== waiter);
      clearTimeout(waiter.timer);
      resolve('cancelled');
    };
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        waiters = waiters.filter(w => w !== waiter);
        waiter.detach();
        resolve('timeout');
      }, timeoutMs),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(waiter);
  });
}

/** True while a swapped-in scene has not yet painted — diagnostics and tests. */
export function isScenePaintPending(): boolean {
  return armed;
}

/** Test-only reset. Resolves any parked waiter as `'abandoned'` so a leaked promise from one test
 *  cannot hang the next. */
export function resetScenePaintSignal(): void {
  armed = false;
  settle('abandoned');
}
