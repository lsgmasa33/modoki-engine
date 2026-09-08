/** Rapier3D WASM loader — a single async-init gate shared by the 3D physics system.
 *  A separate module from the 2D loader so a game that uses only one dimension pulls
 *  only that WASM payload.
 *
 *  `@dimforge/rapier3d-compat` inlines the WASM as base64, so it loads identically in
 *  the browser (Vite) and headlessly (Node/vitest) with no per-environment `.wasm`
 *  fetch. `RAPIER.init()` must resolve before any World is created.
 *
 *  The Rapier module is pulled in via a DYNAMIC import inside `initRapier3D()`, so a
 *  bundler splits the WASM payload into a lazily-fetched chunk instead of the initial
 *  bundle — a game with no 3D physics never downloads it. The physics system calls
 *  `initRapier3D()` lazily on its first tick that sees a body and no-ops
 *  (`isRapier3DReady()`) until the promise resolves. Tests `await initRapier3D()` in
 *  `beforeAll` so stepping is deterministic from tick 0. */

import { beginSuppressRapierInitWarning, endSuppressRapierInitWarning } from '../core/warnSuppress';

// Type-only import — erased at compile time, so it does NOT statically bundle the WASM.
export type Rapier3D = (typeof import('@dimforge/rapier3d-compat'))['default'];

let RAPIER: Rapier3D | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

// A retry budget, not a tunable — this is mechanism (how many transient-failure retries
// are worth the cost of a fresh dynamic import), not designer-facing feel, so it stays a
// code constant rather than a config-resource field.
const RAPIER_INIT_MAX_ATTEMPTS = 3;
let failedAttempts = 0;

/** Kick (or await) Rapier3D WASM load + initialization. Idempotent — safe every frame. */
export function initRapier3D(): Promise<void> {
  // Physics3D excluded from this build (build.modules.physics3d=false / auto-detected
  // unused) → this guard always returns first, making the import() below statically
  // unreachable so Rolldown DCEs the Rapier3D WASM chunk. Registration in pipeline.ts is
  // gated on the SAME flag, so a stripped build never runs the physics system nor reaches
  // here; a direct game-code call gets a clear error, not an import crash.
  if (!__MODOKI_MODULE_PHYSICS3D__) {
    return Promise.reject(new Error('[physics3D] Rapier3D was excluded from this build (build.modules.physics3d=false)'));
  }
  if (!initPromise) {
    const promise: Promise<void> = import('@dimforge/rapier3d-compat').then((m) => {
      const mod = m.default;
      // Suppress Rapier's one bogus init deprecation warning (see warnSuppress.ts) —
      // ref-counted so it composes safely with the 2D loader if both init at once.
      beginSuppressRapierInitWarning();
      return mod.init()
        .then(() => { RAPIER = mod; ready = true; failedAttempts = 0; })
        .finally(() => { endSuppressRapierInitWarning(); });
    });
    initPromise = promise;
    // A rejection is memoised as readily as a success, so left alone one transient init
    // failure would leave physics dead for the rest of the session (#541). But clearing it
    // unconditionally re-enters this branch on EVERY tick that sees a body (the caller has
    // no backoff), issuing a fresh attempt at frame rate forever — so retry only up to
    // RAPIER_INIT_MAX_ATTEMPTS, then leave the rejection memoised (fail fast for the rest of
    // the session) and say so loudly, since `.catch` here would otherwise be the only thing
    // that ever saw the error. The `=== promise` guard is registered after assignment so a
    // late rejection from an older attempt can never clear a newer in-flight one.
    //
    // ⚠️ WHICH half the retry can actually rescue — MEASURED, not assumed (see
    // docs/architecture.md § "A memoized promise must be cleared when it rejects"):
    //   - `mod.init()` failing (WASM instantiate) IS retryable — the module is already
    //     resolved in the module map, so a later attempt re-runs init() for real.
    //   - `import(...)` itself failing is NOT. A failed module fetch is cached per specifier
    //     by the module map, and re-calling import() with the SAME specifier never issues
    //     another request — verified in Chromium, WebKit and Firefox. So for the case the
    //     issue actually named (a chunk 404 after a deploy or OTA bundle swap) the retry
    //     buys nothing and the WARNING below is the entire value. Retrying that would need a
    //     cache-busted URL, which is not worth the machinery here.
    promise.catch((err) => {
      failedAttempts++;
      if (failedAttempts < RAPIER_INIT_MAX_ATTEMPTS) {
        console.warn(
          `[physics3D] Rapier3D init failed (attempt ${failedAttempts}/${RAPIER_INIT_MAX_ATTEMPTS}), will retry:`,
          err
        );
        if (initPromise === promise) initPromise = null;
      } else {
        console.error(
          `[physics3D] Rapier3D init failed permanently after ${RAPIER_INIT_MAX_ATTEMPTS} attempts — physics will not start:`,
          err
        );
      }
    });
  }
  return initPromise;
}

/** True once the WASM is instantiated and Worlds/bodies can be created. */
export function isRapier3DReady(): boolean {
  return ready;
}

/** The Rapier3D module (World, RigidBodyDesc, ColliderDesc, …). Throws if called
 *  before `isRapier3DReady()` — the physics system always guards with that check. */
export function getRapier3D(): Rapier3D {
  if (!RAPIER) throw new Error('[physics3D] Rapier not initialized — await initRapier3D() first');
  return RAPIER;
}
