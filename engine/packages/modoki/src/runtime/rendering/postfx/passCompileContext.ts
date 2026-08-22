/** Pin the render-context CALL DEPTH a post-FX scene-pass precompile warms (#238).
 *
 *  ── The defect this exists for ───────────────────────────────────────────────────────────────
 *  three caches its `RenderContext` objects by `(attachmentState, mrt, callDepth)`, and
 *  `RenderObject.getMaterialCacheKey()` folds `this.context.id` into the key — so the node-builder
 *  cache (the compiled TSL graph, i.e. the generated WGSL) is per-context-INSTANCE, not just per
 *  material.
 *
 *  `Renderer.compile()` asks for its context WITHOUT a call depth, so it always gets the
 *  depth-0 one — the context a TOP-LEVEL `renderer.render()` uses. With a post-FX stack up the
 *  scene is not drawn top-level: the terminal pipeline renders a full-screen quad, and the scene
 *  pass renders from inside that quad's draw, one level deeper. Different depth → different
 *  context → different `context.id` → a different cache key for every single material.
 *
 *  Measured on `demos/postfx-demo` (2026-08-22, `tools-scratch/boot-stall/nodeprobe.mjs`): the
 *  compile warmed context #4 and the first frame drew through context #5, with every other input
 *  to the key — material, object, lights node, environment node, fog, shadow state, dynamic key —
 *  byte-identical. So not one state `compileSceneAsync` built was reachable, and the first frame
 *  rebuilt all of them SYNCHRONOUSLY: 513 ms of an 807 ms main-thread block on the A23.
 *
 *  ── Why a wrapper and not a flag ─────────────────────────────────────────────────────────────
 *  `compile()` takes no call-depth argument, so the only seam is the lookup itself. The wrapper is
 *  installed for the duration of one compile and removed in a `finally`.
 *
 *  ⚠️ It remaps ONLY a lookup for the pass's own render target. An unrelated top-level render can
 *  land during the compile's awaits (it spans seconds, and other surfaces keep drawing), and
 *  handing THAT render a nested context would be a live rendering bug traded for a boot win.
 */

/** three's `RenderContexts`, reached through the renderer's private field. Private API on purpose:
 *  there is no public way to ask for a context at a given call depth, and the alternative is
 *  reimplementing `Renderer.compile()` — far more surface to drift. `pinPassCallDepth` degrades to
 *  a plain call when the shape is not what this expects, so a three upgrade that moves it costs the
 *  optimisation, never a crash. */
interface RenderContextsLike {
  get(renderTarget: unknown, mrt: unknown, callDepth?: number): unknown;
}

interface RendererWithContexts {
  _renderContexts?: RenderContextsLike;
}

/** The call depth a post-FX scene pass renders at: the terminal pipeline's quad draw is depth 0
 *  and `PassNode.updateBefore` renders the scene from inside it, so depth 1. Measured on the
 *  shipped stack shapes, not assumed — and `observePassCallDepth` re-reads it from the live pass
 *  on the first frame, so a stack that nests deeper (an RTT wrapper that ends up CONTAINING the
 *  pass rather than sampling it) corrects itself instead of silently warming the wrong context
 *  forever. */
export const DEFAULT_PASS_CALL_DEPTH = 1;

/** What the live pass was last seen rendering at; `null` until a frame has been drawn.
 *
 *  Module-level rather than per-`PostFXStack` on purpose: this is a fact about how three nests a
 *  post-FX stack, not about one stack instance. A rebuild (an SS-scale change, a stage set change)
 *  constructs a NEW stack, and making it go back to guessing would re-buy the stall the observed
 *  value exists to prevent. */
let observed: number | null = null;
let warned = false;

/** The depth the next precompile should pin — observed if a frame has been drawn, else the
 *  documented default. */
export function getPassCallDepth(): number {
  return observed ?? DEFAULT_PASS_CALL_DEPTH;
}

/** Read the real call depth off the live pass, ONCE.
 *
 *  three calls `PassNode.updateBefore` from inside the draw of whichever quad samples the pass,
 *  so the renderer's `_callDepth` at that moment is the depth of the draw we are inside — the
 *  pass's own render is one deeper. The wrapper removes itself on the first call: the answer
 *  cannot change within a run, and paying for a hook on every frame is the kind of overhead the
 *  profiler plan's rule forbids.
 *
 *  A mismatch is announced rather than absorbed. The symptom of pinning the wrong depth is a
 *  silently slow first frame, which is exactly the failure this whole line of work keeps
 *  producing — so it gets a console line naming the number instead. */
export function observePassCallDepth(
  scenePass: { updateBefore(frame: unknown): void },
  renderer: unknown,
): void {
  if (typeof scenePass?.updateBefore !== 'function') return;
  const original = scenePass.updateBefore.bind(scenePass);
  scenePass.updateBefore = (frame: unknown) => {
    scenePass.updateBefore = original;
    const depth = (renderer as { _callDepth?: number } | null)?._callDepth;
    if (typeof depth === 'number') {
      const actual = depth + 1;
      if (actual !== getPassCallDepth() && !warned) {
        warned = true;
        console.warn(
          `[PostFXStack] the scene pass renders at call depth ${actual}, precompiled for `
          + `${getPassCallDepth()} — this stack's first frame rebuilt its shader graphs `
          + 'synchronously. Later compiles will use the observed depth.',
        );
      }
      observed = actual;
    }
    return original(frame);
  };
}

/** Test seam: forget what was observed, so a case starts from the documented default. */
export function resetPassCallDepth(): void {
  observed = null;
  warned = false;
}

interface ActivePin {
  target: unknown;
  depth: number;
}

/** ⚠️ Two compiles CAN be in flight on one renderer, so this is a pin STACK behind a single
 *  wrapper — not a save/restore pair.
 *
 *  `liveCompileGate` arms on every swap and kicks on the next frame whether or not the previous
 *  compile has settled (it says so: "a compile still in flight across a SECOND swap"), and a swap
 *  can rebuild the stack, so the second compile may pin a DIFFERENT render target. Under
 *  save/restore, the compile that settles first restores the pre-pin lookup — silently switching
 *  the other compile's pin off, which is the exact stall this module exists to remove — and the
 *  second then restores the FIRST one's wrapper, leaving it installed forever over a disposed
 *  render target. One wrapper plus a stack has neither failure mode, in any settle order. */
const activePins = new WeakMap<RenderContextsLike, ActivePin[]>();
const originalGet = new WeakMap<RenderContextsLike, RenderContextsLike['get']>();

/** Run `compile` with three's context lookup for `target` pinned to `callDepth`.
 *
 *  @param renderer three's `Renderer` (its `_renderContexts` field is what gets wrapped).
 *  @param target   the scene pass's render target — the ONLY target whose lookup is remapped.
 *  @param callDepth the depth the pass is really drawn at.
 *  @param compile  the precompile to run.
 */
export async function pinPassCallDepth<T>(
  renderer: unknown,
  target: unknown,
  callDepth: number,
  compile: () => Promise<T>,
): Promise<T> {
  const contexts = (renderer as RendererWithContexts | null)?._renderContexts;
  if (!contexts || typeof contexts.get !== 'function') return compile();

  let pins = activePins.get(contexts);
  if (pins === undefined) {
    const stack: ActivePin[] = [];
    const original = contexts.get;
    originalGet.set(contexts, original);
    activePins.set(contexts, stack);
    contexts.get = function pinned(this: RenderContextsLike, rt: unknown, mrt: unknown, depth?: number) {
      // Only the default depth: a caller that asked for a specific one (three's clear path uses
      // -1) means it. And only a pinned target — a compile spans seconds of awaits, other
      // surfaces keep drawing, and handing a genuine top-level render a nested context would
      // trade a boot win for a live rendering bug.
      if (depth === undefined || depth === 0) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].target === rt) return original.call(this, rt, mrt, stack[i].depth);
        }
      }
      return original.call(this, rt, mrt, depth);
    };
    pins = stack;
  }

  const pin: ActivePin = { target, depth: callDepth };
  pins.push(pin);
  try {
    return await compile();
  } finally {
    const at = pins.indexOf(pin);
    if (at >= 0) pins.splice(at, 1);
    // The LAST pin out uninstalls — an inner compile settling first must leave the outer one's
    // wrapper in place.
    if (pins.length === 0) {
      const original = originalGet.get(contexts);
      if (original) contexts.get = original;
      originalGet.delete(contexts);
      activePins.delete(contexts);
    }
  }
}
