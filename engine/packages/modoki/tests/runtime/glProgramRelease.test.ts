/** #715: `installGlProgramReleaseHatch` patches around a real GL leak in three's `webgl-fallback`
 *  backend — see `glProgramRelease.ts`'s doc comment for the measurement and the mechanism.
 *
 *  The fakes below MIRROR three's real `Pipelines._releaseProgram`/`_releasePipeline` bodies
 *  (quoted in the module doc, verified again below against the real dependency) rather than
 *  inventing behaviour three does not have: a program release deletes from `programs[stage]` and
 *  bumps a stats-only `info.destroyProgram`; a pipeline release deletes from `caches`. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installGlProgramReleaseHatch } from '../../src/runtime/rendering/glProgramRelease';

/** A fake `Pipelines` instance whose `_releaseProgram`/`_releasePipeline` mirror three's real
 *  bodies (`programs[stage].delete(code)` + `info.destroyProgram`; `caches.delete(cacheKey)`).
 *  Every renderer's `_pipelines` shares ONE prototype in real three — this fake reproduces that by
 *  building instances from a shared prototype object, exactly like `makeRenderer` below does. */
function makePipelinesProto() {
  return {
    _releaseProgram(this: { programs: Record<string, Map<string, unknown>>; info: { destroyProgram: (p: unknown) => void } }, program: { code: string; stage: string }) {
      this.programs[program.stage].delete(program.code);
      this.info.destroyProgram(program);
    },
    _releasePipeline(this: { caches: Map<string, unknown> }, pipeline: { cacheKey: string }) {
      this.caches.delete(pipeline.cacheKey);
    },
  };
}

// Shared across every fake renderer built in this file — matches three's real singleton-per-module
// prototype, and is exactly the thing the idempotence/no-closure assertions below depend on.
let pipelinesProto = makePipelinesProto();

function makeGl(overrides: Partial<{ deleteShader: (s: unknown) => void; deleteProgram: (p: unknown) => void }> = {}) {
  return {
    deleteShader: overrides.deleteShader ?? (() => {}),
    deleteProgram: overrides.deleteProgram ?? (() => {}),
  };
}

function makeRenderer(opts: {
  isWebGLBackend?: boolean;
  gl?: ReturnType<typeof makeGl>;
  dataMap?: Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>;
  omit?: 'get' | 'gl' | 'deleteShader' | 'deleteProgram' | 'releaseProgram' | 'releasePipeline' | 'pipelinesObject' | 'pipelinesBackend' | 'pipelinesBackendMismatch';
} = {}) {
  const dataMap = opts.dataMap ?? new Map();
  const gl = opts.gl ?? makeGl();
  if (opts.omit === 'deleteShader') delete (gl as Record<string, unknown>).deleteShader;
  if (opts.omit === 'deleteProgram') delete (gl as Record<string, unknown>).deleteProgram;

  const backend: Record<string, unknown> = {
    isWebGLBackend: opts.isWebGLBackend ?? true,
    gl: opts.omit === 'gl' ? undefined : gl,
    get: (obj: unknown) => dataMap.get(obj),
  };
  if (opts.omit === 'get') delete backend.get;

  let proto: object | undefined = pipelinesProto;
  if (opts.omit === 'releaseProgram') proto = { ...pipelinesProto, _releaseProgram: undefined };
  if (opts.omit === 'releasePipeline') proto = { ...pipelinesProto, _releasePipeline: undefined };

  // A SEPARATE, otherwise-valid-shaped backend object — reproduces a `Pipelines` instance whose
  // `this.backend` got REBOUND to a different object than `renderer.backend` (rather than renamed
  // away, which `pipelinesBackend` above covers). Same shape as `backend` above so every check
  // except the identity check would pass.
  const mismatchedBackend: Record<string, unknown> = {
    isWebGLBackend: true,
    gl: makeGl(),
    get: (obj: unknown) => dataMap.get(obj),
  };

  // Real three's `Pipelines` stores `this.backend = backend` itself in its constructor (see
  // `Pipelines.js`) — the wrapper reads `this.backend`, i.e. the CALLING pipelines instance's own
  // field, not something read back through a renderer. Mirrored here the same way. `pipelinesBackend`
  // omits exactly that field (leaving `renderer.backend` below intact), reproducing a `Pipelines`
  // that renamed its own `backend` field while `renderer.backend` stayed put.
  const pipelinesBackendValue = opts.omit === 'pipelinesBackendMismatch' ? mismatchedBackend : backend;
  const pipelines = opts.omit === 'pipelinesObject' ? 'not-an-object' : Object.create(proto as object, {
    ...(opts.omit === 'pipelinesBackend' ? {} : { backend: { value: pipelinesBackendValue, writable: true, configurable: true } }),
    programs: { value: { fragment: new Map(), vertex: new Map() } },
    info: { value: { destroyProgram: () => {} } },
    caches: { value: new Map() },
  });

  return { backend, _pipelines: pipelines, dataMap };
}

describe('installGlProgramReleaseHatch (#715)', () => {
  beforeEach(() => {
    // Fresh shared prototype per test — otherwise the previous test's installed WRAPPERS are
    // still on it, and the idempotence guard (PATCHED_MARKER on the wrapper functions) would see
    // every later test's renderer as "already patched".
    pipelinesProto = makePipelinesProto();
  });

  it('is not-webgl-backend for a WebGPU-shaped backend and patches nothing', () => {
    const r = makeRenderer({ isWebGLBackend: false });
    const result = installGlProgramReleaseHatch(r);
    expect(result).toBe('not-webgl-backend');
    // Confirm nothing was patched: releasing still runs the untouched original body only.
    const program = { code: 'c1', stage: 'fragment' };
    r._pipelines.programs.fragment.set('c1', {});
    let deleteCalls = 0;
    (r.backend.gl as ReturnType<typeof makeGl>).deleteShader = () => { deleteCalls++; };
    r._pipelines._releaseProgram(program);
    expect(deleteCalls).toBe(0);
  });

  it('installs, deletes the GL shader on program release, and still runs the original delegation', () => {
    const r = makeRenderer();
    const program = { code: 'c1', stage: 'fragment' };
    r.dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    r._pipelines.programs.fragment.set('c1', {});
    let destroyProgramCalls = 0;
    r._pipelines.info.destroyProgram = () => { destroyProgramCalls++; };

    const result = installGlProgramReleaseHatch(r);
    expect(result).toBe('installed');

    const deletedShaders: unknown[] = [];
    (r.backend.gl as ReturnType<typeof makeGl>).deleteShader = (s: unknown) => { deletedShaders.push(s); };

    r._pipelines._releaseProgram(program);

    expect(deletedShaders).toEqual(['shader-handle-1']);
    // Original delegation still happened: the code map entry is gone, the stats hook ran.
    expect(r._pipelines.programs.fragment.has('c1')).toBe(false);
    expect(destroyProgramCalls).toBe(1);
  });

  it('installs, deletes the GL program on pipeline release, and still runs the original delegation', () => {
    const r = makeRenderer();
    const pipeline = { cacheKey: 'k1' };
    r.dataMap.set(pipeline, { programGPU: 'program-handle-1' });
    r._pipelines.caches.set('k1', {});

    installGlProgramReleaseHatch(r);

    const deletedPrograms: unknown[] = [];
    (r.backend.gl as ReturnType<typeof makeGl>).deleteProgram = (p: unknown) => { deletedPrograms.push(p); };

    r._pipelines._releasePipeline(pipeline);

    expect(deletedPrograms).toEqual(['program-handle-1']);
    expect(r._pipelines.caches.has('k1')).toBe(false);
  });

  it.each([
    ['missing backend.get', 'get'],
    ['missing backend.gl', 'gl'],
    ['missing gl.deleteShader', 'deleteShader'],
    ['missing gl.deleteProgram', 'deleteProgram'],
    ['missing _releaseProgram on the prototype', 'releaseProgram'],
    ['missing _releasePipeline on the prototype', 'releasePipeline'],
    ['_pipelines is not an object', 'pipelinesObject'],
    ['missing pipelines instance backend (renderer.backend survives)', 'pipelinesBackend'],
    ['pipelines.backend is a DIFFERENT (but validly-shaped) object than renderer.backend', 'pipelinesBackendMismatch'],
  ] as const)('%s -> unsupported-shape, patches nothing, warns once', async (_label, omit) => {
    // `warnOnce` inside glProgramRelease.ts is a module-level "warned already" flag (deliberately
    // — the loud warning must fire once per PROCESS, not once per install call). That means this
    // test must get its OWN fresh module instance per case, via vi.resetModules() + a dynamic
    // re-import, or every case after the first would see the flag already tripped and wrongly fail
    // the ">=1 warning" assertion.
    vi.resetModules();
    const fresh = await import('../../src/runtime/rendering/glProgramRelease');

    const warnSpy: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };
    try {
      const r = makeRenderer({ omit });
      // Captured BEFORE install(): a mutation moving the shape check to run AFTER the prototype
      // writes would still return 'unsupported-shape' here, but the prototype's own release
      // methods would no longer be these two references — this is what catches that.
      const releaseProgramBefore = (r._pipelines as Record<string, unknown>)._releaseProgram;
      const releasePipelineBefore = (r._pipelines as Record<string, unknown>)._releasePipeline;
      const result = fresh.installGlProgramReleaseHatch(r);
      expect(result).toBe('unsupported-shape');
      expect(warnSpy.length).toBeGreaterThanOrEqual(1);
      // "Patches nothing": the prototype's release methods must be untouched, not just the
      // return value/warning.
      expect((r._pipelines as Record<string, unknown>)._releaseProgram).toBe(releaseProgramBefore);
      expect((r._pipelines as Record<string, unknown>)._releasePipeline).toBe(releasePipelineBefore);

      // A second install with the SAME broken shape (same module instance) must not warn again.
      const before = warnSpy.length;
      fresh.installGlProgramReleaseHatch(makeRenderer({ omit }));
      expect(warnSpy.length).toBe(before);
    } finally {
      console.warn = origWarn;
    }
  });

  it('is idempotent: a second install on the same (shared) prototype does not double-wrap', () => {
    const r1 = makeRenderer();
    const r2 = makeRenderer(); // shares `pipelinesProto`, exactly like real three's renderers do.

    expect(installGlProgramReleaseHatch(r1)).toBe('installed');
    expect(installGlProgramReleaseHatch(r2)).toBe('already-installed');

    const program = { code: 'c1', stage: 'fragment' };
    r2.dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    r2._pipelines.programs.fragment.set('c1', {});
    let deleteCalls = 0;
    (r2.backend.gl as ReturnType<typeof makeGl>).deleteShader = () => { deleteCalls++; };

    r2._pipelines._releaseProgram(program);

    expect(deleteCalls).toBe(1); // not 2 — a double-wrap would call the wrapper twice.
  });

  it('a SUBCLASS that OVERRIDES both methods gets its own overrides patched, not skipped as already-installed', () => {
    // Patch the base prototype first, exactly like the idempotence test above.
    const baseProto = pipelinesProto;
    expect(installGlProgramReleaseHatch(makeRenderer())).toBe('installed');

    // A subclass prototype — created via `Object.create(baseProto)` — carrying its OWN
    // `_releaseProgram`/`_releasePipeline` overrides (mirroring the base's original bodies), the
    // way a real subclass overriding those methods would. Those overrides are NOT our wrappers, so
    // both must be patched even though the base prototype above already was.
    const subclassProto = Object.create(baseProto, {
      _releaseProgram: {
        value(this: { programs: Record<string, Map<string, unknown>>; info: { destroyProgram: (p: unknown) => void } }, program: { code: string; stage: string }) {
          this.programs[program.stage].delete(program.code);
          this.info.destroyProgram(program);
        },
        writable: true,
        configurable: true,
      },
      _releasePipeline: {
        value(this: { caches: Map<string, unknown> }, pipeline: { cacheKey: string }) {
          this.caches.delete(pipeline.cacheKey);
        },
        writable: true,
        configurable: true,
      },
    });
    const subclassOriginalReleaseProgram = (subclassProto as Record<string, unknown>)._releaseProgram;

    const dataMap = new Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>();
    const gl = makeGl();
    const backend = { isWebGLBackend: true, gl, get: (obj: unknown) => dataMap.get(obj) };
    const pipelines = Object.create(subclassProto, {
      backend: { value: backend, writable: true, configurable: true },
      programs: { value: { fragment: new Map(), vertex: new Map() } },
      info: { value: { destroyProgram: () => {} } },
      caches: { value: new Map() },
    });
    const subclassRenderer = { backend, _pipelines: pipelines };

    // Must patch, not short-circuit as 'already-installed' — the functions reached through
    // `subclassProto` are the subclass's own un-wrapped overrides.
    expect(installGlProgramReleaseHatch(subclassRenderer)).toBe('installed');
    expect((subclassProto as Record<string, unknown>)._releaseProgram).not.toBe(subclassOriginalReleaseProgram);

    const program = { code: 'c1', stage: 'fragment' };
    dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    subclassRenderer._pipelines.programs.fragment.set('c1', {});
    const deletedShaders: unknown[] = [];
    gl.deleteShader = (s: unknown) => { deletedShaders.push(s); };

    subclassRenderer._pipelines._releaseProgram(program);

    expect(deletedShaders).toEqual(['shader-handle-1']);
  });

  it('a SUBCLASS that overrides NEITHER method is already-installed — it must not wrap our own wrapper', () => {
    // ⚠️ THE REGRESSION THIS FILE EXISTS FOR, and the one two earlier rounds got wrong in opposite
    // directions. Reading the marker as an OWN property of the prototype, this subclass has none
    // — so install() proceeded, read `_releaseProgram` off the CHAIN (which is the base's
    // already-installed wrapper), and wrapped that. `gl.deleteShader` then fired TWICE on the same
    // handle: `GL_INVALID_VALUE` on every program release, on the WebGL2-fallback path this hatch
    // exists for. Strictly worse than not patching at all.
    const baseProto = pipelinesProto;
    expect(installGlProgramReleaseHatch(makeRenderer())).toBe('installed');

    // Inherits BOTH methods — no overrides of its own, which is the whole point.
    const subclassProto = Object.create(baseProto) as typeof baseProto;

    const dataMap = new Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>();
    const gl = makeGl();
    const backend = { isWebGLBackend: true, gl, get: (obj: unknown) => dataMap.get(obj) };
    const pipelines = Object.create(subclassProto, {
      backend: { value: backend, writable: true, configurable: true },
      programs: { value: { fragment: new Map(), vertex: new Map() } },
      info: { value: { destroyProgram: () => {} } },
      caches: { value: new Map() },
    });
    const subclassRenderer = { backend, _pipelines: pipelines };

    expect(installGlProgramReleaseHatch(subclassRenderer)).toBe('already-installed');
    // Nothing was written onto the subclass prototype — the inherited wrapper already does the job.
    expect(Object.prototype.hasOwnProperty.call(subclassProto, '_releaseProgram')).toBe(false);

    const program = { code: 'c1', stage: 'fragment' };
    dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    subclassRenderer._pipelines.programs.fragment.set('c1', {});
    const deletedShaders: unknown[] = [];
    gl.deleteShader = (sh: unknown) => { deletedShaders.push(sh); };

    subclassRenderer._pipelines._releaseProgram(program);

    // Exactly one — a double-wrap gives ['shader-handle-1', 'shader-handle-1'].
    expect(deletedShaders).toEqual(['shader-handle-1']);
  });

  it('a MIXED subclass — overrides one method, inherits the other — patches only the override', () => {
    // The case no per-PROTOTYPE flag can express in either direction: the override needs wrapping,
    // the inherited wrapper must be left alone. Both halves still delete exactly once.
    const baseProto = pipelinesProto;
    expect(installGlProgramReleaseHatch(makeRenderer())).toBe('installed');
    const baseWrapperPipeline = baseProto._releasePipeline;

    const subclassProto = Object.create(baseProto, {
      _releaseProgram: {
        value(this: { programs: Record<string, Map<string, unknown>>; info: { destroyProgram: (p: unknown) => void } }, program: { code: string; stage: string }) {
          this.programs[program.stage].delete(program.code);
          this.info.destroyProgram(program);
        },
        writable: true,
        configurable: true,
      },
    }) as typeof baseProto;

    const dataMap = new Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>();
    const gl = makeGl();
    const backend = { isWebGLBackend: true, gl, get: (obj: unknown) => dataMap.get(obj) };
    const pipelines = Object.create(subclassProto, {
      backend: { value: backend, writable: true, configurable: true },
      programs: { value: { fragment: new Map(), vertex: new Map() } },
      info: { value: { destroyProgram: () => {} } },
      caches: { value: new Map() },
    });
    const mixedRenderer = { backend, _pipelines: pipelines };

    expect(installGlProgramReleaseHatch(mixedRenderer)).toBe('installed');
    // The inherited half must be untouched — re-assigning it here would wrap our own wrapper.
    expect(Object.prototype.hasOwnProperty.call(subclassProto, '_releasePipeline')).toBe(false);
    expect(subclassProto._releasePipeline).toBe(baseWrapperPipeline);

    const program = { code: 'c1', stage: 'fragment' };
    dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    pipelines.programs.fragment.set('c1', {});
    const pipeline = { cacheKey: 'k1' };
    dataMap.set(pipeline, { programGPU: 'program-handle-1' });

    const deletedShaders: unknown[] = [];
    const deletedPrograms: unknown[] = [];
    gl.deleteShader = (sh: unknown) => { deletedShaders.push(sh); };
    gl.deleteProgram = (pr: unknown) => { deletedPrograms.push(pr); };

    mixedRenderer._pipelines._releaseProgram(program);
    mixedRenderer._pipelines._releasePipeline(pipeline);

    expect(deletedShaders).toEqual(['shader-handle-1']);
    expect(deletedPrograms).toEqual(['program-handle-1']);
  });

  it('a mismatched pipelines.backend with NO isWebGLBackend is refused — the harm, not just the return value', () => {
    // The `pipelinesBackendMismatch` case above carries `isWebGLBackend: true` on the decoy, so
    // dropping the identity check there is caught only through the RETURN VALUE. This is the shape
    // that was actually measured: a second object carrying `get`/`gl` but NOT `isWebGLBackend`.
    // Without the identity check install() reports 'installed' and then every wrapper call takes
    // the `this.backend?.isWebGLBackend !== true` early return, so ZERO deletes are ever issued —
    // a hatch that reports success and does nothing, which is the fail-open shape this file exists
    // to avoid.
    const r = makeRenderer();
    const decoyGl = makeGl();
    const decoyBackend = {
      get: () => ({ shaderGPU: 'never-deleted' }),
      gl: decoyGl,
      // deliberately no `isWebGLBackend`
    };
    (r._pipelines as unknown as Record<string, unknown>).backend = decoyBackend;

    const warnSpy: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };
    try {
      expect(installGlProgramReleaseHatch(r)).toBe('unsupported-shape');
      expect(warnSpy.length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
    // Refused, so the prototype is untouched and no delete path was ever armed.
    expect((pipelinesProto._releaseProgram as unknown as Record<PropertyKey, unknown>)[Symbol.for('modoki.glProgramRelease.patched')]).toBeUndefined();
  });

  it('never throws out of the wrapper when the extra delete fails — the original still runs', () => {
    const r = makeRenderer({
      gl: makeGl({ deleteShader: () => { throw new Error('boom'); } }),
    });
    const program = { code: 'c1', stage: 'fragment' };
    r.dataMap.set(program, { shaderGPU: 'shader-handle-1' });
    r._pipelines.programs.fragment.set('c1', {});

    installGlProgramReleaseHatch(r);

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(() => r._pipelines._releaseProgram(program)).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
    // Original delegation still ran despite the delete throwing.
    expect(r._pipelines.programs.fragment.has('c1')).toBe(false);
  });

  it('a frozen Pipelines prototype fails loudly instead of throwing into the renderer boot path', async () => {
    // `findUnsupportedReason` only catches internals being MISSING. A frozen prototype is
    // HOSTILE, not missing: `_releaseProgram`/`_releasePipeline` are both present and typed
    // correctly, so the shape check passes and the failure only surfaces at the assignment
    // itself. This is the case install() must catch with its own try/catch around the writes.
    vi.resetModules();
    const fresh = await import('../../src/runtime/rendering/glProgramRelease');

    Object.freeze(pipelinesProto);
    const r = makeRenderer();

    const warnSpy: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };
    try {
      let result: string | undefined;
      expect(() => { result = fresh.installGlProgramReleaseHatch(r); }).not.toThrow();
      expect(result).toBe('unsupported-shape');
      expect(warnSpy.length).toBeGreaterThanOrEqual(1);

      // Nothing was patched: the original release still runs, and no GL delete ever fires.
      const program = { code: 'c1', stage: 'fragment' };
      r.dataMap.set(program, { shaderGPU: 'shader-handle-1' });
      r._pipelines.programs.fragment.set('c1', {});
      let deleteCalls = 0;
      (r.backend.gl as ReturnType<typeof makeGl>).deleteShader = () => { deleteCalls++; };
      r._pipelines._releaseProgram(program);
      expect(deleteCalls).toBe(0);
      expect(r._pipelines.programs.fragment.has('c1')).toBe(false);
    } finally {
      console.warn = origWarn;
    }
  });

  it('partial hostility: the SECOND method write throws — both methods are rolled back to their originals, no marker, one warning', async () => {
    // Unlike the frozen-prototype test above (where NEITHER write ever lands), this makes only
    // `_releasePipeline` — the SECOND property install() writes (see the source's write order) —
    // non-writable. `_releaseProgram`, written first, stays a normal writable own property, so its
    // forward write actually lands and its revert actually has something to undo. This is the case
    // the rollback body inside install()'s catch has to handle for real, not just as dead code.
    vi.resetModules();
    const fresh = await import('../../src/runtime/rendering/glProgramRelease');

    const originalReleaseProgram = pipelinesProto._releaseProgram;
    const originalReleasePipeline = pipelinesProto._releasePipeline;
    Object.defineProperty(pipelinesProto, '_releasePipeline', {
      value: originalReleasePipeline,
      writable: false,
      configurable: false,
    });
    const r = makeRenderer();

    const warnSpy: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(args); };
    try {
      const result = fresh.installGlProgramReleaseHatch(r);
      expect(result).toBe('unsupported-shape');
      expect(warnSpy.length).toBe(1);
      expect(pipelinesProto._releaseProgram).toBe(originalReleaseProgram);
      expect(pipelinesProto._releasePipeline).toBe(originalReleasePipeline);
      // Neither method may be left as one of our wrappers — the marker lives on the FUNCTION now.
      expect((pipelinesProto._releaseProgram as unknown as Record<PropertyKey, unknown>)[Symbol.for('modoki.glProgramRelease.patched')]).toBeUndefined();
      expect((pipelinesProto._releasePipeline as unknown as Record<PropertyKey, unknown>)[Symbol.for('modoki.glProgramRelease.patched')]).toBeUndefined();
    } finally {
      console.warn = origWarn;
    }
  });

  // REMOVED: the "marker branch" test (`Object.preventExtensions` blocking the PATCHED_MARKER
  // `defineProperty` while both method writes land). install() no longer writes any new property
  // to the prototype — the marker moved onto the wrapper FUNCTIONS — so there is nothing left
  // after the two method assignments that can throw, and the branch it exercised does not exist.
  // `preventExtensions` now blocks nothing here: both writes are reassignments of EXISTING own
  // properties. The surviving `partial hostility` test above still covers the rollback path.

  it('reads this.backend per call rather than closing over the install-time renderer', () => {
    // Two SEPARATE renderers (own backend, own `_pipelines` instance) sharing the same patched
    // prototype — exactly what real three does (one `Pipelines` class per loaded module, many
    // renderer instances). Installing via r1 must not make r2's releases delete through r1's GL
    // context; each pipelines instance's own `this.backend` must be read at call time.
    const r1 = makeRenderer();
    const r2 = makeRenderer();
    installGlProgramReleaseHatch(r1);

    const r1Deletes: unknown[] = [];
    (r1.backend.gl as ReturnType<typeof makeGl>).deleteShader = (s: unknown) => { r1Deletes.push(s); };
    const r2Deletes: unknown[] = [];
    (r2.backend.gl as ReturnType<typeof makeGl>).deleteShader = (s: unknown) => { r2Deletes.push(s); };

    const program = { code: 'c1', stage: 'fragment' };
    r2.dataMap.set(program, { shaderGPU: 'from-r2' });
    r2._pipelines.programs.fragment.set('c1', {});

    r2._pipelines._releaseProgram(program);

    expect(r2Deletes).toEqual(['from-r2']);
    expect(r1Deletes).toEqual([]); // a closure over r1's backend would have wrongly landed here.
  });
});

/** ⚠️ TRIPWIRE. The internals `glProgramRelease.ts` depends on are three's PRIVATE structure, with
 *  no public replacement. A three bump that renames/removes one of them must fail HERE, loudly,
 *  rather than let the hatch silently disable itself (it self-disables, but SILENT self-disabling
 *  months apart from the bump is exactly the failure mode this whole feature exists to avoid).
 *
 *  ⚠️ Read via a plain `readFileSync`, not `readScannedSource` — same shape as
 *  `stageCompileJobs.test.ts`'s "three r184 tripwire", and for the same reason: this is a version
 *  pin against a VENDORED dependency, not a scan of this repo's own source, and the path is never
 *  spelled as a repo-rooted string literal at the read call (`commentStripperIsShared.test.ts`'s
 *  `REPO_ROOTED` check is a dataflow question this regex-based guard cannot see across the
 *  `threeDir` indirection — the same indirection `stageCompileJobs.test.ts` already uses).
 *
 *  ⚠️ Both `src/**` AND `build/three.webgpu.js` are pinned, not just `src/**`. `scene3DSync.ts`
 *  imports `'three/webgpu'`, which three's `package.json` `exports` map resolves to
 *  `./build/three.webgpu.js` — the pre-bundled file the running code actually loads — not to
 *  anything under `src/`. A change that only touches what the bundler EMITS (a build-config
 *  change, a different minifier pass) leaves the `src/**` assertions green while the code this
 *  hatch patches at runtime has already moved; only a matching assertion against the build output
 *  can catch that.
 *
 *  ⚠️ Do NOT "fix" this by deleting the assertions if it goes red — that is the point. Re-verify
 *  the shape in `node_modules/three`, update `glProgramRelease.ts` to match, and only then update
 *  this pin. */
describe('three internals tripwire — the private surface #715 depends on', () => {
  const threeDir = path.resolve(__dirname, '../../../../../node_modules/three');
  const read = (rel: string) => readFileSync(path.join(threeDir, rel), 'utf8');

  it('is pinned to the three this was measured against', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    // Not an equality assert: a patch bump must not go red. A MINOR bump is exactly when the
    // internals below are worth re-reading.
    expect(version.startsWith('0.18')).toBe(true);
  });

  it('Pipelines._releaseProgram still deletes from programs[stage] and only STATS-decrements via info.destroyProgram', () => {
    const src = read('src/renderers/common/Pipelines.js');
    expect(src).toMatch(/_releaseProgram\(\s*program\s*\)\s*\{/);
    expect(src).toContain('this.programs[ stage ].delete( code )');
    expect(src).toContain('this.info.destroyProgram( program )');
    // The mis-wire this whole feature exists to patch around: no backend hook is called here.
    expect(src).not.toContain('this.backend.destroyProgram');
  });

  it('Pipelines._releasePipeline is still a bare cache delete with no backend hook', () => {
    const src = read('src/renderers/common/Pipelines.js');
    expect(src).toMatch(/_releasePipeline\(\s*pipeline\s*\)\s*\{/);
    expect(src).toContain('this.caches.delete( pipeline.cacheKey )');
    expect(src).not.toContain('this.backend.destroyProgram');
  });

  it('Pipelines still assigns this.backend = backend on the instance — the field both wrappers gate on', () => {
    const src = read('src/renderers/common/Pipelines.js');
    expect(src).toContain('this.backend = backend;');
  });

  it('WebGLBackend still stores the GL shader as shaderGPU and the GL program as programGPU, reachable via this.get', () => {
    const src = read('src/renderers/webgl-fallback/WebGLBackend.js');
    expect(src).toContain('shaderGPU: shader');
    expect(src).toContain('const programGPU = gl.createProgram();');
    // Confirms `isWebGLBackend` is still the discriminator this hatch gates on.
    expect(src).toContain('this.isWebGLBackend = true;');
  });

  it('the pre-bundled `three/webgpu` build (what scene3DSync.ts actually imports) still carries the same markers', () => {
    // three's package.json `exports["./webgpu"]` resolves to this file, not to anything under
    // `src/**` — see the block comment above for why the `src/**` assertions alone can't catch a
    // bundler-only regression.
    const build = read('build/three.webgpu.js');

    // The bundle is ONE file holding every renderer class, so `this.backend = backend;` alone
    // matches ~18 places across it (Bindings, Textures, Attributes, NodeManager, Renderer, and
    // various *Utils classes all assign it too) — asserting that string against the WHOLE bundle
    // would not actually detect a Pipelines-only rename, which is the entire point of this test.
    // Slice out just the `Pipelines` class body (from its `class Pipelines extends DataMap {`
    // declaration to the next top-level `class ` declaration) and assert against that instead.
    const classStart = build.indexOf('class Pipelines extends DataMap {');
    expect(classStart, '`class Pipelines extends DataMap {` must still open the class in the bundle').toBeGreaterThanOrEqual(0);
    const nextClassStart = build.indexOf('\nclass ', classStart + 1);
    expect(nextClassStart, 'a following top-level class declaration bounds the Pipelines class body').toBeGreaterThan(classStart);
    const pipelinesClass = build.slice(classStart, nextClassStart);

    expect(pipelinesClass).toMatch(/_releaseProgram\(\s*program\s*\)\s*\{/);
    expect(pipelinesClass).toContain('this.programs[ stage ].delete( code )');
    expect(pipelinesClass).toContain('this.info.destroyProgram( program )');
    expect(pipelinesClass).toMatch(/_releasePipeline\(\s*pipeline\s*\)\s*\{/);
    expect(pipelinesClass).toContain('this.caches.delete( pipeline.cacheKey )');
    // Scoped to the Pipelines class body, so this actually detects the mis-wire this hatch exists
    // to patch around — an unrelated class elsewhere in the bundle calling this exact method can no
    // longer trip it.
    expect(pipelinesClass).not.toContain('this.backend.destroyProgram');
    expect(pipelinesClass).toContain('this.backend = backend;');

    expect(build).toContain('shaderGPU: shader');
    expect(build).toContain('const programGPU = gl.createProgram();');
    expect(build).toContain('this.isWebGLBackend = true;');
  });
});

describe('the patched prototype is SHARED, so the backend gate has to hold at CALL time (#715)', () => {
  // install()'s `isWebGLBackend` check gates INSTALLATION. But three uses one `Pipelines` class for
  // both backends, so once a WebGL renderer patches that prototype the wrappers also run for a
  // WebGPU renderer built from the same three module. These pin that the wrapper re-checks the
  // backend it is ACTUALLY running against.
  //
  // Today three makes this harmless by accident — `WebGPUBackend.createProgram` stores `{ module }`
  // and never a `shaderGPU`/`programGPU` field, so the read would come back undefined anyway. That
  // is why both tests below deliberately PLANT those fields on a WebGPU-shaped backend: a test
  // relying on the field being absent would pass just as well with no gate at all, and would stop
  // protecting us the moment three renamed something.
  beforeEach(() => {
    // Same reason as the first describe's reset: the idempotence guard is PATCHED_MARKER on the
    // wrapper functions, so without a fresh prototype every test here inherits already-wrapped
    // methods and install() reports 'already-installed'.
    pipelinesProto = makePipelinesProto();
  });

  it('a WebGPU-backed pipelines sharing the patched prototype still delegates, and issues NO gl call', () => {
    expect(installGlProgramReleaseHatch(makeRenderer())).toBe('installed');

    const deleteShader = vi.fn();
    const deleteProgram = vi.fn();
    const dataMap = new Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>();
    const webgpu = makeRenderer({
      isWebGLBackend: false,
      gl: makeGl({ deleteShader, deleteProgram }),
      dataMap,
    });

    const program = { code: 'src-a', stage: 'fragment' as const };
    // Planted on purpose — see the block comment: this is what makes the assertion about the GATE
    // rather than about three's current field names.
    dataMap.set(program, { shaderGPU: 'a-gl-shader' });
    webgpu._pipelines.programs.fragment.set(program.code, program);

    webgpu._pipelines._releaseProgram(program);

    expect(webgpu._pipelines.programs.fragment.has(program.code), 'the original release must still run').toBe(false);
    expect(deleteShader, 'a non-WebGL backend must never reach gl.deleteShader').not.toHaveBeenCalled();
  });

  it('the same holds for a pipeline release on a non-WebGL backend', () => {
    expect(installGlProgramReleaseHatch(makeRenderer())).toBe('installed');

    const deleteProgram = vi.fn();
    const dataMap = new Map<unknown, { shaderGPU?: unknown; programGPU?: unknown }>();
    const webgpu = makeRenderer({
      isWebGLBackend: false,
      gl: makeGl({ deleteProgram }),
      dataMap,
    });

    const pipeline = { cacheKey: 'pipe-a' };
    dataMap.set(pipeline, { programGPU: 'a-gl-program' });
    webgpu._pipelines.caches.set(pipeline.cacheKey, pipeline);

    webgpu._pipelines._releasePipeline(pipeline);

    expect(webgpu._pipelines.caches.has(pipeline.cacheKey), 'the original release must still run').toBe(false);
    expect(deleteProgram).not.toHaveBeenCalled();
  });

  it('each distinct failure warns on its own latch — one warning cannot silence an unrelated one', async () => {
    // A FRESH module instance: `warnedCategories` is module-level by design (warn once per
    // PROCESS, not per call), so asserting counts against the module the other tests already
    // warned through would be measuring their latches, not this behaviour.
    vi.resetModules();
    const { installGlProgramReleaseHatch: freshInstall } =
      await import('../../src/runtime/rendering/glProgramRelease');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // An install-time shape mismatch warns...
    expect(freshInstall(makeRenderer({ omit: 'get' }))).toBe('unsupported-shape');
    expect(warn.mock.calls.length, 'the shape mismatch warns once').toBe(1);
    // ...and repeating it does NOT warn again (the latch works within its own category).
    expect(freshInstall(makeRenderer({ omit: 'get' }))).toBe('unsupported-shape');
    expect(warn.mock.calls.length, 'the same category is latched').toBe(1);

    // ...but a LATER, unrelated runtime throw must still be reported rather than swallowed. With a
    // single shared boolean latch this assertion fails, which is the regression it exists to catch.
    const dataMap = new Map<unknown, { shaderGPU?: unknown }>();
    const r = makeRenderer({
      gl: makeGl({ deleteShader: () => { throw new Error('context lost'); } }),
      dataMap,
    });
    expect(freshInstall(r)).toBe('installed');
    const program = { code: 'src-b', stage: 'vertex' as const };
    dataMap.set(program, { shaderGPU: 'shader-b' });
    r._pipelines.programs.vertex.set(program.code, program);

    expect(() => r._pipelines._releaseProgram(program)).not.toThrow();
    expect(r._pipelines.programs.vertex.has(program.code), 'the original release still ran').toBe(false);
    expect(warn.mock.calls.length, 'the delete-threw warning must not be latched out by the shape warning').toBe(2);
    warn.mockRestore();
  });
});
