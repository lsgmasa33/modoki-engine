/** rendererLossHandling — the shared GPU-context-loss DETECTION contract (#795).
 *
 *  Before this module, detection was wired per renderer construction site rather than by a shared
 *  contract: `canvas2DPool` (this file's original home for the logic below, #213/#794) and the 3D
 *  viewports (`core/activeRenderer.ts`, #121) each had their own copy, and three other live
 *  surfaces — `ShaderPreview.tsx`'s Pixi `Application`, `previewScene.ts`'s and `ModelPreview.tsx`'s
 *  bare `THREE.WebGLRenderer` — had none at all. A lost context leaves a surface permanently
 *  blank: the canvas keeps its size and DOM position, the ECS stays correct, draws keep being
 *  issued and do nothing — there is no error anywhere unless something is listening.
 *
 *  This module is DETECTION only. It does not decide policy (what a surface does about a loss —
 *  rebuild in place, tear down, log and stop) and it does NOT touch `activeRenderer.ts`'s global
 *  recovery budget (`reportRendererLoss` there is module-private on purpose): feeding editor
 *  preview panels into a 3-losses-per-60s global budget shared with the GameView would let a
 *  flapping preview permanently disarm real gameplay recovery. Each caller supplies its own
 *  `onLost` policy; `canvas2DPool.ts` and the editor preview panels each keep their own.
 *
 *  The two halves mirror the two ways a context dies:
 *   - WebGL: the `webglcontextlost` DOM event, fired on the canvas.
 *   - WebGPU: the `GPUDevice.lost` promise, on the renderer's device.
 *  A caller wires whichever halves its renderer actually has via `attachRendererLossHandling`.
 */

export interface RendererLossEvent {
  api: 'WebGL' | 'WebGPU';
  /** WebGPU only — `GPUDeviceLostInfo.reason` (e.g. `'destroyed'` for a deliberate teardown, or
   *  `'unknown'` for a real loss). Absent for WebGL, which carries no such distinction. */
  reason?: string;
  /** WebGPU only — `GPUDeviceLostInfo.message`. */
  message?: string;
}

export interface RendererLossHandlers {
  /** Surface name for the default log line and handler-failure diagnostics. A plain string is
   *  fixed for the life of the listener; pass a thunk when the caller's identity can change
   *  UNDER a live listener — `canvas2DPool` reuses a slot (and its attached listener) across
   *  entities, so a string baked in at attach time can name the WRONG entity by the time a loss
   *  fires (finding 4, adversarial review of #795). Resolved once per use, at fire/catch time. */
  label: string | (() => string);
  /** Return true to IGNORE this event — our own teardown, or a superseded renderer/app.
   *
   *  Checked FIRST, before anything else runs. Our own teardown fires a context loss: Pixi's
   *  `GlContextSystem.destroy()` ends with an explicit `extensions.loseContext?.loseContext()` on
   *  every `app.destroy()`, and three's WebGL backend behaves the same way via
   *  `forceContextLoss()`. Without this guard, a perfectly correct teardown emits a loud false
   *  alarm — which is exactly the misleading diagnostic that made #213 cost what it did. */
  isStale?: () => boolean;
  /** This surface's own log line. Return `null` to suppress the default log entirely (the caller
   *  logs it itself, or chooses not to). Omit to use the default line below. */
  describe?: (e: RendererLossEvent) => string | null;
  /** What this surface DOES about the loss. Detection is uniform across every surface; policy is
   *  not — a game viewport rebuilds, a preview panel tears itself down and asks to be reopened. */
  onLost: (e: RendererLossEvent) => void;
}

/** Resolve `label` at USE time, never at attach time — see the field doc on why. Exported so a
 *  test can assert a lazy label is re-read on every use, not memoized at attach. */
export function resolveLabel(label: RendererLossHandlers['label']): string {
  return typeof label === 'function' ? label() : label;
}

function defaultDescribe(label: string, e: RendererLossEvent): string {
  return (
    `[${label}] ${e.api} context/device LOST${e.reason ? ` (reason: ${e.reason})` : ''} — every ` +
    `draw into it is now a no-op and the surface will stay BLANK until it recovers.`
  );
}

function logLoss(handlers: RendererLossHandlers, e: RendererLossEvent): void {
  const message = handlers.describe ? handlers.describe(e) : defaultDescribe(resolveLabel(handlers.label), e);
  if (message === null) return;
  console.error(message);
}

/** WebGL half: `webglcontextlost` (+ optional restore) on a canvas. Returns a detach fn, idempotent
 *  and safe to call more than once. A `null`/`undefined` canvas is a silent no-op — some callers
 *  (a WebGPU-only surface) have no canvas half to wire. */
export function attachContextLossListeners(
  canvas: HTMLCanvasElement | null | undefined,
  handlers: RendererLossHandlers & { onRestored?: () => void },
): () => void {
  if (!canvas) return () => {};

  const onLost = (e: Event) => {
    if (handlers.isStale?.()) return;
    // preventDefault is what makes the browser willing to restore the context at all — without
    // it, a lost WebGL context is lost forever.
    e.preventDefault();
    logLoss(handlers, { api: 'WebGL' });
    handlers.onLost({ api: 'WebGL' });
  };
  const onRestored = () => {
    if (handlers.isStale?.()) return;
    handlers.onRestored?.();
  };

  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    try {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    } catch { /* never throw out of a teardown path */ }
  };
}

/** WebGPU half: the `GPUDevice.lost` promise. Returns a detach fn, idempotent and safe to call
 *  more than once. Silent no-op when there is no device (the WebGL backend, or a device that
 *  hasn't come up yet) — read defensively, matching `canvas2DPool.ts`'s existing cast pattern. */
export function attachDeviceLostListener(
  device: { lost?: Promise<{ reason?: string; message?: string }> } | null | undefined,
  handlers: RendererLossHandlers,
): () => void {
  if (!device?.lost) return () => {};

  let detached = false;
  void device.lost
    .then((info) => {
      if (detached || handlers.isStale?.()) return;
      logLoss(handlers, { api: 'WebGPU', reason: info?.reason, message: info?.message });
      handlers.onLost({ api: 'WebGPU', reason: info?.reason, message: info?.message });
    })
    .catch((err: unknown) => {
      // `GPUDevice.lost` resolves per spec and never rejects, so what this actually catches in
      // practice is a THROW from the handler body above (the log call, or `onLost` itself) —
      // i.e. the recovery trigger failing. That must not be silent.
      console.error(`[${resolveLabel(handlers.label)}] WebGPU device-lost handler failed — ` +
        'recovery may not have been requested.', err);
    });

  return () => { detached = true; };
}

/** Convenience: wire whichever halves a renderer/app actually has. Returns ONE detach fn covering
 *  both — idempotent, never throws. */
export function attachRendererLossHandling(
  target: {
    canvas?: HTMLCanvasElement | null;
    device?: { lost?: Promise<{ reason?: string; message?: string }> } | null;
  },
  handlers: RendererLossHandlers & { onRestored?: () => void },
): () => void {
  const detachCanvas = attachContextLossListeners(target.canvas, handlers);
  const detachDevice = attachDeviceLostListener(target.device, handlers);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    detachCanvas();
    detachDevice();
  };
}
