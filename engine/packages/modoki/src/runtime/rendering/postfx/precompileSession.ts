/** The renderer-wide state a post-FX stage precompile borrows, and gives back (#323).
 *
 *  ── Why this is per-RENDERER and not per-`PostFXStack` ───────────────────────────────────────
 *  `compileStagesAsync` mutates renderer-GLOBAL state for the duration of a compile: it stubs
 *  `renderer.render`, flips tone mapping / output colour space / xr, and mirrors depth+stencil
 *  from each target. A `PostFXStack` is NOT the right owner of that, because a stack REBUILD
 *  (an SS-scale settle, `postfx.showOnly`, a camera-object swap) disposes the old instance and
 *  constructs a new one — so the two compiles that can overlap belong to two DIFFERENT stack
 *  objects, and an instance-level guard cannot see the collision at all.
 *
 *  ⚠️ **The bug this exists for was a permanent no-op renderer.** `createLiveCompileGate.tick()`
 *  guards on `armed`, not on `pending`, so a rebuild mid-compile kicks a SECOND overlapping
 *  `compileStagesAsync`. With save/restore held in local `const`s, call B captured **call A's
 *  stub** as its "original"; A finished first and restored the real `render`; B finished and
 *  restored A's stub — and `renderer.render` stayed a no-op for the rest of the session. The same
 *  interleaving corrupted tone mapping, colour space, xr, depth/stencil and the MRT.
 *
 *  Two mechanisms, and both are needed:
 *   - `runExclusivePrecompile` SERIALISES per renderer, so overlap cannot happen. This is the one
 *     that matters, because refcounting alone would still let two compiles interleave their
 *     `setRenderTarget` calls and compile each other's jobs against the wrong attachment state —
 *     silent, and exactly the class of bug this whole workstream keeps producing.
 *   - the session itself is REFCOUNTED anyway, so a future second caller (or a nested one) is
 *     safe by construction rather than by the caller remembering.
 *
 *  ── The recorder ─────────────────────────────────────────────────────────────────────────────
 *  The stub is not a black hole; it RECORDS `(material, render target)` for every draw the graph
 *  attempts. In a post-FX graph `updateBefore` IS the draw, so driving those hooks with this stub
 *  installed yields the exact material→target pairs three itself would use — see
 *  `stageCompileJobsFromDraws`.
 */

/** One draw the stubbed renderer swallowed, with the target that was bound at the time. */
export interface DrawObservation {
  readonly material: object;
  readonly target: object | null;
}

/** Bound to one `beginPrecompile` call. `alive` goes false when the session is torn down early —
 *  by the deadline, or by a caller that needs the real renderer back (an offscreen capture). A
 *  compile MUST check it after every `await` and stop: continuing would issue REAL draws through
 *  a renderer that is no longer stubbed. */
export interface PrecompileSession {
  readonly draws: readonly DrawObservation[];
  readonly alive: boolean;
  end(): void;
}

interface Entry {
  count: number;
  deadline: number;
  alive: boolean;
  draws: DrawObservation[];
  render: unknown;
  toneMapping: unknown;
  outputColorSpace: unknown;
  xrEnabled: boolean | undefined;
  depth: unknown;
  stencil: unknown;
  mrt: unknown;
  renderTarget: unknown;
}

interface RendererLike {
  render?(object: unknown, camera: unknown): void;
  toneMapping?: unknown;
  outputColorSpace?: unknown;
  depth?: unknown;
  stencil?: unknown;
  xr?: { enabled: boolean };
  getMRT?(): unknown;
  setMRT?(mrt: unknown): unknown;
  getRenderTarget?(): unknown;
  setRenderTarget?(rt: unknown): unknown;
}

/** Hard ceiling on how long a precompile may hold the renderer stubbed.
 *
 *  ⚠️ It exists to compose with `liveCompileGate`'s own ceiling, which releases the FRAME without
 *  waiting for the compile — by design. Without this, a compile still mid-`await` when that
 *  ceiling fired would let the next frame "submit" through a stubbed `render`: nothing drawn, and
 *  `markScenePainted()` firing anyway over a blank canvas. That is #334's bug exactly, and it is
 *  reachable — the compile cap times ~130 ms per pipeline on an A23 is seconds, not milliseconds.
 *  Kept BELOW `LIVE_COMPILE_MAX_HOLD_MS` (5 s) so the stub is always gone before the gate lets a
 *  frame past.
 *
 *  ⚠️ **Measured from the gate's KICK, not from when the session begins** (#957). Since every
 *  compile on a renderer queues on one chain, a stage compile can start seconds after its gate
 *  armed; a deadline counted from `beginPrecompile` would then outlive the gate's release and hold
 *  frames AFTER the scene was revealed. So `compileStagesAsync` passes its kick time as `now`, and
 *  skips outright when its queue wait alone used the budget. */
export const PRECOMPILE_MAX_HOLD_MS = 4_000;

const sessions = new WeakMap<object, Entry>();
const chains = new WeakMap<object, Promise<unknown>>();

function forceEnd(renderer: object, entry: Entry): void {
  if (!entry.alive) return;
  entry.alive = false;
  entry.count = 0;
  sessions.delete(renderer);
  const r = renderer as RendererLike;
  try {
    if (typeof entry.render === 'function') r.render = entry.render as RendererLike['render'];
    r.toneMapping = entry.toneMapping;
    r.outputColorSpace = entry.outputColorSpace;
    r.depth = entry.depth;
    r.stencil = entry.stencil;
    if (r.xr && entry.xrEnabled !== undefined) r.xr.enabled = entry.xrEnabled;
    if (typeof r.setMRT === 'function') r.setMRT(entry.mrt ?? null);
    if (typeof r.setRenderTarget === 'function') r.setRenderTarget(entry.renderTarget ?? null);
  } catch {
    // Restoring must never throw into a frame callback; a renderer this fails on is already lost.
  }
}

/** Borrow the renderer: save every field a stage precompile mutates, and swap `render` for a
 *  recorder. Refcounted — a second call while one is open joins it and restores nothing.
 *
 *  Returns `null` when the object is not renderer-shaped, which is the caller's signal to skip the
 *  optimisation entirely rather than proceed unprotected. */
export function beginPrecompile(
  renderer: unknown, now: number, maxHoldMs: number = PRECOMPILE_MAX_HOLD_MS,
): PrecompileSession | null {
  if (!renderer || typeof renderer !== 'object') return null;
  const key = renderer as object;
  const r = renderer as RendererLike;
  if (typeof r.render !== 'function') return null;

  let entry = sessions.get(key);
  if (entry && entry.alive) {
    entry.count++;
    // The joiner's own work extends the ceiling; otherwise a long second compile would be torn
    // down by the first one's deadline.
    entry.deadline = Math.max(entry.deadline, now + maxHoldMs);
  } else {
    entry = {
      count: 1,
      deadline: now + maxHoldMs,
      alive: true,
      draws: [],
      render: r.render,
      toneMapping: r.toneMapping,
      outputColorSpace: r.outputColorSpace,
      xrEnabled: r.xr?.enabled,
      depth: r.depth,
      stencil: r.stencil,
      mrt: typeof r.getMRT === 'function' ? r.getMRT() : null,
      renderTarget: typeof r.getRenderTarget === 'function' ? r.getRenderTarget() : null,
    };
    const open = entry;
    r.render = (object: unknown, _camera?: unknown) => {
      const material = (object as { material?: unknown } | null)?.material;
      if (material && typeof material === 'object' && (material as { isMaterial?: boolean }).isMaterial === true) {
        // Bounded: a runaway graph must not grow this without limit.
        if (open.draws.length < MAX_RECORDED_DRAWS) {
          open.draws.push({
            material: material as object,
            target: (typeof r.getRenderTarget === 'function' ? r.getRenderTarget() : null) ?? null,
          });
        }
      }
    };
    sessions.set(key, entry);
  }

  const open = entry;
  let ended = false;
  return {
    get draws() { return open.draws; },
    get alive() { return open.alive; },
    end() {
      if (ended || !open.alive) return;
      ended = true;
      open.count--;
      if (open.count <= 0) forceEnd(key, open);
    },
  };
}

/** Cap on recorded draws — a stage graph draws a couple of dozen quads per frame, so this is a
 *  runaway guard, not a budget. */
const MAX_RECORDED_DRAWS = 512;

/** Is a precompile currently holding this renderer's `render` stubbed?
 *
 *  ⚠️ NOT a passive query — past the deadline it TEARS THE SESSION DOWN and answers false, which
 *  is what makes the ceiling composable: the caller that asks "may I draw?" is the one that gets
 *  the renderer back. The in-flight compile sees `session.alive === false` after its next `await`
 *  and stops. */
export function isPrecompileActive(renderer: unknown, now: number): boolean {
  if (!renderer || typeof renderer !== 'object') return false;
  const key = renderer as object;
  const entry = sessions.get(key);
  if (!entry || !entry.alive) return false;
  if (now >= entry.deadline) { forceEnd(key, entry); return false; }
  return true;
}

/** Give the renderer back NOW, whatever is in flight. For a caller that needs real pixels — an
 *  offscreen capture — where costing the optimisation is obviously the right trade. */
export function endAllPrecompiles(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') return;
  const key = renderer as object;
  const entry = sessions.get(key);
  if (entry) forceEnd(key, entry);
}

/** Run `fn` with no other exclusive precompile in flight on this renderer.
 *
 *  ⚠️ **EVERY async compile on a renderer goes through here, not only the stage compile** (#957):
 *  the pre-swap prewarm (`prewarmShadersForWorld`), the live-scene compile (`compileLiveScene`,
 *  which carries `PostFXStack.compileSceneAsync`) and `PostFXStack.compileStagesAsync`. The
 *  reason is a fact about three, measured: `Renderer.compileAsync` fixes its render context
 *  synchronously and then builds each object's node graph after `await`s, reading
 *  `renderer.getRenderTarget()`/`getMRT()` AT THAT MOMENT. Two compiles that each bind their own
 *  target across an `await` therefore build against each other's. The scene compile used to run
 *  outside this chain, and `liveCompileGate` releases the frame at its ceiling without cancelling
 *  the compile — so a cold pipeline cache (a clean-install first launch) let the stage compile
 *  start on top of it, bind bloom's targets, and leave the scene's materials with pipelines that
 *  fail validation (`writeMask`, `GPUColorTargetState.format`): #956's black screen. Forcing that
 *  overlap on desktop Chromium broke 5/5 loads on BOTH three 0.184 and 0.185.1; serialising it
 *  here took both to 0/5. `docs/rendering.md` § "Every async compile on a renderer is serialised".
 *
 *  ⚠️ **Never call this from inside `fn`** on the same renderer — the inner call waits for the
 *  outer one to finish, which waits for the inner one. There is no way to detect that from here.
 *  So `compileSceneAsync` does NOT lock itself; its one caller, `compileLiveScene`, holds the lock.
 *
 *  ⚠️ **A long or never-settling compile holds everything queued behind it**, and a caller whose
 *  WAIT has no ceiling of its own inherits that. The two gated compiles are fine — their gates
 *  release frames at 5 s whatever the queue does. The pre-swap prewarm is NOT gated: the scene swap
 *  awaits it, so it queues through `runExclusivePrecompileWithin` and skips its compile rather than
 *  stall a scene load behind the previous scene's compile. A new ungated caller needs the same.
 *
 *  Rejections are absorbed into the CHAIN (so one failure cannot wedge every later compile) but
 *  are still delivered to this caller.
 */
export function runExclusivePrecompile<T>(renderer: unknown, fn: () => Promise<T>): Promise<T> {
  if (!renderer || typeof renderer !== 'object') return fn();
  const key = renderer as object;
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/** What `runExclusivePrecompileWithin` did: ran `fn` (with its value), or gave up waiting. */
export type QueuedPrecompile<T> = { ran: true; value: T } | { ran: false };

/** `runExclusivePrecompile` for a caller that must not wait without bound — the pre-swap prewarm,
 *  which a scene load awaits. If the queue has not reached this call within `maxWaitMs`, it resolves
 *  `{ ran: false }` and `fn` NEVER runs, not even later: running it unlocked would reintroduce the
 *  overlap the queue exists to prevent (#957), and running it once its turn finally comes would
 *  compile for a scene the caller has already moved past.
 *
 *  A rejection from `fn` is delivered to this caller, as with `runExclusivePrecompile`. */
export function runExclusivePrecompileWithin<T>(
  renderer: unknown, maxWaitMs: number, fn: () => Promise<T>,
): Promise<QueuedPrecompile<T>> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<QueuedPrecompile<T>>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve({ ran: false }); }, maxWaitMs);
  });
  const turn = runExclusivePrecompile(renderer, async (): Promise<QueuedPrecompile<T>> => {
    if (expired) return { ran: false };
    clearTimeout(timer);
    return { ran: true, value: await fn() };
  });
  return Promise.race([turn, gaveUp]);
}

/** Test seam: forget everything for one renderer. */
export function resetPrecompileSession(renderer: unknown): void {
  if (!renderer || typeof renderer !== 'object') return;
  endAllPrecompiles(renderer);
  chains.delete(renderer as object);
}
