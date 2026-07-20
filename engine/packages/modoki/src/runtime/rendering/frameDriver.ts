/** Frame Driver — single requestAnimationFrame loop with priority-ordered callbacks.
 *  Replaces multiple independent rAF loops to guarantee deterministic execution order:
 *  ECS pipeline (0) → Three.js render (10) → PixiJS render (20). */

type FrameCallback = () => void;

export const PRIORITY_ECS = 0;
export const PRIORITY_RENDER_3D = 10;
export const PRIORITY_RENDER_2D = 20;
export const PRIORITY_EDITOR_3D = 30;
export const PRIORITY_EDITOR_2D = 40;

/** Target FPS cap. Set to 0 for uncapped (uses display refresh rate). */
export let targetFPS = 60;
export function setTargetFPS(fps: number) { targetFPS = fps; }

const callbacks = new Map<string, { cb: FrameCallback; priority: number }>();
let sorted: { key: string; cb: FrameCallback }[] = [];
let dirty = false;
let rafId = 0;
let refCount = 0;
let lastFrameTime = 0;

// Per-callback consecutive-throw counts; after MAX_CONSECUTIVE_ERRORS we drop it
// to stop log floods. Cleared when a callback runs successfully.
const errorCounts = new Map<string, number>();
const MAX_CONSECUTIVE_ERRORS = 10;

// FPS tracking — updated once per second inside the frame loop.
let _currentFPS = 0;
let _fpsFrameCount = 0;
let _fpsLastSample = 0;
/** Current frames-per-second (integer, updated once per second). */
export function getCurrentFPS(): number { return _currentFPS; }

export function registerFrameCallback(key: string, cb: FrameCallback, priority: number) {
  callbacks.set(key, { cb, priority });
  dirty = true;
}

export function unregisterFrameCallback(key: string) {
  callbacks.delete(key);
  dirty = true;
}

function rebuildSorted() {
  sorted = [...callbacks.entries()]
    .map(([key, v]) => ({ key, cb: v.cb, priority: v.priority }))
    .sort((a, b) => a.priority - b.priority)
    .map(r => ({ key: r.key, cb: r.cb }));
  dirty = false;
}

function frame(now: DOMHighResTimeStamp) {
  rafId = requestAnimationFrame(frame);
  if (targetFPS > 0) {
    const interval = 1000 / targetFPS;
    if (now - lastFrameTime < interval) return;
    lastFrameTime = now - ((now - lastFrameTime) % interval);
  }
  _fpsFrameCount++;
  if (now - _fpsLastSample >= 1000) {
    _currentFPS = _fpsFrameCount;
    _fpsFrameCount = 0;
    _fpsLastSample = now;
  }
  if (dirty) rebuildSorted();
  for (const entry of sorted) {
    try {
      entry.cb();
      if (errorCounts.has(entry.key)) errorCounts.delete(entry.key);
    } catch (err) {
      const n = (errorCounts.get(entry.key) ?? 0) + 1;
      errorCounts.set(entry.key, n);
      console.error(`[frameDriver] callback "${entry.key}" threw (${n}/${MAX_CONSECUTIVE_ERRORS}):`, err);
      if (n >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[frameDriver] auto-unregistering "${entry.key}" after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        unregisterFrameCallback(entry.key);
      }
    }
  }
}

/** Start the driver. Ref-counted — multiple callers can start without conflict. */
export function startFrameDriver() {
  if (++refCount === 1) { rafId = requestAnimationFrame(frame); }
}

/** Stop the driver. Only actually stops when all callers have stopped. */
export function stopFrameDriver() {
  if (--refCount <= 0) { refCount = 0; cancelAnimationFrame(rafId); }
}

/** Run all callbacks once synchronously (for editor step button). */
export function stepOneFrame() {
  if (dirty) rebuildSorted();
  for (const entry of sorted) {
    try { entry.cb(); }
    catch (err) { console.error(`[frameDriver] step "${entry.key}" threw:`, err); }
  }
}
