/** Self-disabling escape hatch for a real GL leak in three's `webgl-fallback` backend (#715).
 *
 *  THE DEFECT THIS PATCHES. `WebGPURenderer` constructed with `forceWebGL:true` (the path the
 *  iPhone 8 runs) never issues a GL delete for a compiled shader/program. Measured on
 *  three@0.185.1: `Pipelines._releaseProgram` fired 12 times in a run that swapped scenes
 *  repeatedly, and `gl.deleteProgram`/`gl.deleteShader`/`gl.deleteVertexArray` were called ZERO
 *  times — while `gl.deleteBuffer` fired 106 times, proving the instrumentation that measured this
 *  was live. `common/Pipelines.js`'s `_releaseProgram`/`_releasePipeline` only ever touch three's
 *  own caches and a stats-only counter (`Info.destroyProgram`); neither calls into
 *  `backend.destroyProgram`. That hook DOES exist — on the base `Backend` class
 *  (`common/Backend.js`, a no-op) and on both concrete backends (`webgl-fallback/WebGLBackend.js`,
 *  `webgpu/WebGPUBackend.js`) — `Pipelines` just never invokes it; the only thing it calls on
 *  release is `this.info.destroyProgram`, a stats object, not the backend. And even if `Pipelines`
 *  were wired to call it, `WebGLBackend.destroyProgram` only drops the DataMap entry — it issues no
 *  GL delete either, so the hook existing is not by itself enough to close this leak.
 *  `_releasePipeline` has no backend hook at all, on either backend. The renderer/GL context
 *  survives a scene swap, so a leaked program is never reclaimed for the life of the app.
 *
 *  `gl.deleteVertexArray` leaks the same way (`WebGLBackend.js` calls `gl.createVertexArray()`
 *  but nowhere under `webgl-fallback/` calls the matching delete) — a real third leak, and
 *  deliberately OUT OF SCOPE here: this hatch closes the shader/program leak only (#715), not VAOs.
 *
 *  ⚠️ This reaches into three's PRIVATE internal shape (`renderer._pipelines`'s prototype, and the
 *  WebGL-fallback backend's per-object DataMap entries) because there is no public hook for it.
 *  That is why every internal is verified at INSTALL TIME (`checkShape` below) before anything is
 *  patched: a three version that renames/removes one of these must disable this hatch LOUDLY (one
 *  `console.warn`, naming the failed check) rather than silently doing nothing or throwing into a
 *  renderer boot path. See `glProgramRelease.test.ts`'s three-source tripwire for what happens
 *  when three actually moves this shape — that test goes red, not this file.
 *
 *  The WebGPU backend is already correct (a WebGPU shader module has no `destroy()`), so this must
 *  never touch it — gated by `backend.isWebGLBackend`. */

/** Result of one `installGlProgramReleaseHatch` call. */
export type GlReleaseInstall =
  | 'installed'
  | 'already-installed'
  | 'not-webgl-backend'
  | 'unsupported-shape';

/** Minimal duck-typed shape of the WebGL-fallback backend's `DataMap.get(obj)` return value for a
 *  compiled program (`shaderGPU`, set by `createProgram`) or a render pipeline (`programGPU`, set
 *  by `createRenderPipeline`). Both live in the SAME map, keyed by different objects, so both
 *  fields are typed optional on one shape rather than declaring two near-identical ones. */
interface GlDataEntry {
  shaderGPU?: unknown;
  programGPU?: unknown;
}

interface GlLike {
  deleteShader(shader: unknown): void;
  deleteProgram(program: unknown): void;
}

interface WebGLFallbackBackendLike {
  isWebGLBackend?: boolean;
  gl: GlLike;
  get(obj: unknown): GlDataEntry | undefined;
}

interface PipelinesLike {
  _releaseProgram(program: unknown): void;
  _releasePipeline(pipeline: unknown): void;
}

interface RendererLike {
  backend: WebGLFallbackBackendLike;
  _pipelines: PipelinesLike;
}

/** Marks a WRAPPER FUNCTION as one of ours, so a second `install` call never wraps a wrapper.
 *
 *  A registry `Symbol.for(...)` — not a module-local `WeakSet` — because the WeakSet only catches
 *  a repeat call THROUGH THIS MODULE INSTANCE. Two loaded copies of this module (Vite HMR handing
 *  out a fresh module instance, or two bundle chunks) each get their own empty `WeakSet` but patch
 *  the SAME shared `Pipelines.prototype`, so the second copy's `install()` sees an unmarked
 *  prototype and double-wraps it — `gl.deleteShader` then fires twice per release (a second call
 *  on an already-deleted shader is `GL_INVALID_VALUE`). `Symbol.for` looks its symbol up in the
 *  global symbol registry by string, so every module instance in the same realm gets the identical
 *  symbol and the marker answers "patched?" regardless of which instance asks.
 *
 *  ⚠️ **On the FUNCTION, and checked PER METHOD — not on the prototype.** Two earlier rounds both
 *  put it on the prototype and both were wrong, in opposite directions, because
 *  `Object.getPrototypeOf(pipelines)` is the SUBCLASS's prototype when three ever subclasses
 *  `Pipelines`:
 *    - Read through the prototype CHAIN, a subclass that OVERRIDES these methods inherits the
 *      base's marker, reports `already-installed`, and its overrides are never wrapped — the leak
 *      stays open. Benign, but the hatch does nothing.
 *    - Read as an OWN property (`hasOwnProperty`), a subclass that does NOT override them has no
 *      marker of its own, so `install()` proceeds and reads `proto._releaseProgram` off the chain
 *      — which is the base's ALREADY-INSTALLED wrapper. It then wraps that wrapper, and
 *      `gl.deleteShader` fires TWICE per release: `GL_INVALID_VALUE` on every program release, on
 *      the WebGL2-fallback path this file exists for. Strictly worse than doing nothing.
 *  Marking the function itself is the only form that is right in both directions, and it is the
 *  only one that can express the MIXED case — a subclass overriding one of the two methods needs
 *  that half wrapped and the other half left alone, which no single per-prototype flag can say. */
const PATCHED_MARKER = Symbol.for('modoki.glProgramRelease.patched');

/** True when `fn` is a wrapper THIS module (or another instance of it, via the registry symbol)
 *  already installed. Reads the marker as an own property OF THE FUNCTION — functions do not
 *  inherit from each other here, so there is no chain to walk and no subclass ambiguity. */
function isOurWrapper(fn: unknown): boolean {
  return typeof fn === 'function'
    && (fn as unknown as Record<symbol, unknown>)[PATCHED_MARKER] === true;
}

/** Stamps a wrapper so a later `install()` — from this module instance or another copy of it —
 *  recognises it and refuses to wrap it again. Non-enumerable so it never shows up in a
 *  `for…in`/`Object.keys` walk of the prototype. */
function markAsOurWrapper<T extends (...args: never[]) => unknown>(fn: T): T {
  Object.defineProperty(fn, PATCHED_MARKER, { value: true, configurable: true, enumerable: false });
  return fn;
}

/** Warned categories, so each DISTINCT failure is reported once per process however many times
 *  install() is retried (e.g. one scene reload after another) — loud, not spammy.
 *
 *  ⚠️ Keyed by CATEGORY rather than a single boolean latch on purpose: a shared latch means the
 *  first warning silences every later one, so an install-time shape mismatch would permanently
 *  hide an unrelated runtime throw (and vice versa). A diagnostic channel that answers "no further
 *  problems" when it was never able to ask is the fail-open shape this file exists to avoid. */
const warnedCategories = new Set<string>();

function warnOnce(category: string, message: string): void {
  if (warnedCategories.has(category)) return;
  warnedCategories.add(category);
  console.warn(`[glProgramRelease] ${message}`);
}

function warnUnsupported(reason: string): void {
  warnOnce(
    'unsupported-shape',
    `three's internal shape has changed (${reason}) — the GL program/shader leak in the `
    + 'webgl-fallback backend is UN-PATCHED on this three version. See glProgramRelease.ts for '
    + 'what this hatch depends on.',
  );
}

/** Verifies every internal this hatch depends on is present and is the expected TYPE, before
 *  touching anything. Returns the first failing check's name, or null when everything checks out. */
function findUnsupportedReason(renderer: RendererLike): string | null {
  const pipelines: unknown = renderer._pipelines;
  if (typeof pipelines !== 'object' || pipelines === null) return 'renderer._pipelines is not an object';
  const proto: unknown = Object.getPrototypeOf(pipelines);
  if (typeof proto !== 'object' || proto === null) return 'renderer._pipelines has no prototype';
  const protoObj = proto as Record<string, unknown>;
  if (typeof protoObj._releaseProgram !== 'function') return '_releaseProgram is not a function';
  if (typeof protoObj._releasePipeline !== 'function') return '_releasePipeline is not a function';
  // Both wrappers below gate on `this.backend` — the PIPELINES INSTANCE's own field
  // (`common/Pipelines.js` does `this.backend = backend` in its constructor), never
  // `renderer.backend` checked further down. Nothing else pins that field, so a rename
  // (`Pipelines.backend` -> `_backend`) would leave every other check here green and make both
  // wrappers silently take their `this.backend?.isWebGLBackend !== true` early return forever —
  // the leak comes back with `install()` still reporting 'installed'. Catch it here instead.
  const pipelinesBackend: unknown = (pipelines as Record<string, unknown>).backend;
  if (typeof pipelinesBackend !== 'object' || pipelinesBackend === null) return 'pipelines.backend is not an object';
  const backend: unknown = renderer.backend;
  if (typeof backend !== 'object' || backend === null) return 'renderer.backend is not an object';
  // Not just "is an object" — it must be the SAME object as `renderer.backend` (the one validated
  // below), or the wrappers' `this.backend?.isWebGLBackend !== true` gate reads a different backend
  // than the one this function just proved has `.get`/`.gl`/`.deleteShader`/`.deleteProgram`, and
  // would wrongly report 'installed' while silently no-opping forever. A guard against a FUTURE
  // divergence, not today's behavior: in three@0.185.1, `Renderer.js` passes `this.backend` into
  // `new Pipelines(...)`, so `pipelines.backend` and `renderer.backend` are the same object today.
  if (pipelinesBackend !== backend) return 'pipelines.backend is not the renderer backend';
  if (typeof (backend as WebGLFallbackBackendLike).get !== 'function') return 'backend.get is not a function';
  const gl: unknown = (backend as WebGLFallbackBackendLike).gl;
  if (typeof gl !== 'object' || gl === null) return 'backend.gl is not an object';
  if (typeof (gl as GlLike).deleteShader !== 'function') return 'backend.gl.deleteShader is not a function';
  if (typeof (gl as GlLike).deleteProgram !== 'function') return 'backend.gl.deleteProgram is not a function';
  return null;
}

/** Installs the extra GL deletes onto `renderer`'s (shared) Pipelines prototype. Safe to call once
 *  per renderer — see module doc for exactly what this patches and why, and see `PATCHED_MARKER`
 *  (a marker on the wrapper FUNCTIONS, checked per method) for why a repeat call is a no-op, and
 *  the wrapper bodies below for why a WebGPU backend is a no-op. */
export function installGlProgramReleaseHatch(renderer: unknown): GlReleaseInstall {
  const r = renderer as Partial<RendererLike> | null | undefined;
  const backend = r?.backend as WebGLFallbackBackendLike | undefined;
  if (!backend || backend.isWebGLBackend !== true) return 'not-webgl-backend';

  const reason = findUnsupportedReason(r as RendererLike);
  if (reason) {
    warnUnsupported(reason);
    return 'unsupported-shape';
  }

  const proto = Object.getPrototypeOf((r as RendererLike)._pipelines) as PipelinesLike & object;

  // Read each method the way a CALL would — through the prototype chain — and ask whether that
  // exact function is already one of ours. See `PATCHED_MARKER` for why this is per method and on
  // the function rather than on the prototype.
  //
  // NOT bound — `this` must stay whatever the CALL SITE passes (the per-renderer pipelines
  // instance that owns `programs`/`caches`/`info`, not this shared prototype), so both are
  // invoked below via `.call(this, ...)` inside the wrapper.
  const originalReleaseProgram = proto._releaseProgram as (this: PipelinesLike, program: unknown) => void;
  const originalReleasePipeline = proto._releasePipeline as (this: PipelinesLike, pipeline: unknown) => void;
  const programAlreadyPatched = isOurWrapper(originalReleaseProgram);
  const pipelineAlreadyPatched = isOurWrapper(originalReleasePipeline);
  if (programAlreadyPatched && pipelineAlreadyPatched) return 'already-installed';

  // The prototype is SHARED across every renderer three constructs, so both wrappers read
  // `this.backend`/`this.backend.gl` PER CALL — never close over the renderer passed to install().
  //
  // ⚠️ That sharing also means `isWebGLBackend` at the top of install() is an INSTALL-time gate
  // only: once a WebGL renderer patches this prototype, these wrappers also run for any WebGPU
  // renderer built from the same three module. Today that is harmless by construction —
  // `WebGPUBackend.createProgram` stores `{ module }` on its DataMap entry and never a
  // `shaderGPU`/`programGPU` field, so the reads below come back undefined and the wrapper is a
  // no-op. But that is a property of three's CURRENT field names, not a guarantee, and if it ever
  // changed we would call `gl.*` on a backend that has no `gl`. So each wrapper re-checks the
  // backend it is actually running against, making the gate real rather than incidental.
  const releaseProgramWrapper = markAsOurWrapper(function (this: PipelinesLike & { backend: WebGLFallbackBackendLike }, program: unknown) {
    if (this.backend?.isWebGLBackend !== true) { originalReleaseProgram.call(this, program); return; }
    // Read the GL shader handle BEFORE delegating: a future three that wires up
    // `backend.destroyProgram` from inside the original method would drop the DataMap entry,
    // and reading after would then find nothing.
    let shaderGPU: unknown;
    try {
      shaderGPU = this.backend.get(program)?.shaderGPU;
    } catch (e) {
      warnOnce('read-program-threw', `reading the DataMap entry for a released program threw: ${String(e)}`);
    }
    originalReleaseProgram.call(this, program);
    if (shaderGPU === undefined) return;
    try {
      this.backend.gl.deleteShader(shaderGPU);
    } catch (e) {
      // Never let the extra cleanup break a teardown path — the original release already ran.
      warnOnce('delete-shader-threw', `gl.deleteShader threw: ${String(e)}`);
    }
  });

  const releasePipelineWrapper = markAsOurWrapper(function (this: PipelinesLike & { backend: WebGLFallbackBackendLike }, pipeline: unknown) {
    if (this.backend?.isWebGLBackend !== true) { originalReleasePipeline.call(this, pipeline); return; }
    let programGPU: unknown;
    try {
      programGPU = this.backend.get(pipeline)?.programGPU;
    } catch (e) {
      warnOnce('read-pipeline-threw', `reading the DataMap entry for a released pipeline threw: ${String(e)}`);
    }
    originalReleasePipeline.call(this, pipeline);
    if (programGPU === undefined) return;
    try {
      this.backend.gl.deleteProgram(programGPU);
    } catch (e) {
      warnOnce('delete-program-threw', `gl.deleteProgram threw: ${String(e)}`);
    }
  });

  // `findUnsupportedReason` only catches internals being MISSING. A three build where
  // `Pipelines.prototype` is frozen, or one of these two properties non-writable (ESM modules run
  // in strict mode), is HOSTILE rather than missing: the assignment below THROWS instead of quietly
  // doing nothing. Uncaught, that throw would propagate out of `install()` into the renderer boot
  // path this hatch promises never to disturb — on WebGL/fallback devices only (the iPhone 8) — and
  // leave the GPU-context tracker permanently inflated (its matching `noteGpuContextDestroyed()`
  // never runs because `makeWebGPURenderer` never returns). Guard both writes together so a partial
  // failure can never leave one wrapper installed without its twin: on any throw, put back
  // whichever original already landed and report the same 'unsupported-shape' a missing internal
  // would.
  //
  // ⚠️ Each half is written only if it is not ALREADY one of our wrappers. In the mixed subclass
  // case — an override on one method, the base's installed wrapper inherited for the other — the
  // already-patched half must be left exactly as it is: re-assigning it onto this prototype would
  // wrap our own wrapper and double the GL delete (see `PATCHED_MARKER`). The revert below is
  // symmetric for the same reason: it only puts back what this call actually wrote.
  try {
    if (!programAlreadyPatched) {
      (proto as unknown as Record<string, unknown>)._releaseProgram = releaseProgramWrapper;
    }
    if (!pipelineAlreadyPatched) {
      (proto as unknown as Record<string, unknown>)._releasePipeline = releasePipelineWrapper;
    }
  } catch (e) {
    try {
      if (!programAlreadyPatched) {
        (proto as unknown as Record<string, unknown>)._releaseProgram = originalReleaseProgram;
      }
      if (!pipelineAlreadyPatched) {
        (proto as unknown as Record<string, unknown>)._releasePipeline = originalReleasePipeline;
      }
    } catch {
      // Reached only when a REVERT write itself throws — e.g. one of the two properties is
      // non-writable, so its forward write above never actually landed and this reassignment to
      // its original value throws the exact same way. That does not mean nothing changed overall:
      // the OTHER property may well have been forward-patched above and already reverted
      // successfully by the earlier statement in this same try, before this one threw. Swallowing
      // the throw is safe either way — install() reports 'unsupported-shape' below regardless of
      // which revert succeeded.
    }
    warnOnce(
      'install-threw',
      `patching the Pipelines prototype threw (${String(e)}) — the GL program/shader leak in the `
      + 'webgl-fallback backend is UN-PATCHED on this three version. See glProgramRelease.ts for '
      + 'what this hatch depends on.',
    );
    return 'unsupported-shape';
  }

  return 'installed';
}
