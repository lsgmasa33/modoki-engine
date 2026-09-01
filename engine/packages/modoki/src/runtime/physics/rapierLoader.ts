/** Rapier2D WASM loader — a single async-init gate shared by the physics system.
 *
 *  `@dimforge/rapier2d-compat` inlines the WASM as base64, so it loads identically
 *  in the browser (Vite) and headlessly (Node/vitest) with no per-environment
 *  `.wasm` fetch. `RAPIER.init()` must resolve before any World is created — the
 *  same async-init gating we already use for the PixiJS `<Application> onInit`.
 *
 *  The Rapier module is pulled in via a DYNAMIC import inside `initRapier2D()`, so a
 *  bundler splits the ~1.5 MB WASM payload into a lazily-fetched chunk instead of the
 *  initial bundle — a game with no 2D physics never downloads it. The physics system
 *  calls `initRapier2D()` lazily on its first tick that sees a body and no-ops
 *  (`isRapierReady()`) until the promise resolves. Tests `await initRapier2D()` in
 *  `beforeAll` so stepping is deterministic from tick 0. */

import { beginSuppressRapierInitWarning, endSuppressRapierInitWarning } from '../core/warnSuppress';

// Type-only import — erased at compile time, so it does NOT statically bundle the WASM.
export type Rapier = (typeof import('@dimforge/rapier2d-compat'))['default'];

let RAPIER: Rapier | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

// A retry budget, not a tunable — this is mechanism (how many transient-failure retries
// are worth the cost of a fresh ~1.5 MB dynamic import), not designer-facing feel, so it
// stays a code constant rather than a config-resource field.
const RAPIER_INIT_MAX_ATTEMPTS = 3;
let failedAttempts = 0;

/** Kick (or await) Rapier WASM load + initialization. Idempotent — safe every frame. */
export function initRapier2D(): Promise<void> {
  // Physics2D excluded from this build (build.modules.physics2d=false / auto-detected
  // unused) → this guard always returns first, making the import() below statically
  // unreachable so Rolldown DCEs the ~1.5 MB Rapier2D WASM chunk. Registration in
  // pipeline.ts is gated on the SAME flag, so a stripped build never runs the physics
  // system nor reaches here; a direct game-code call gets a clear error, not an import crash.
  if (!__MODOKI_MODULE_PHYSICS2D__) {
    return Promise.reject(new Error('[physics2D] Rapier2D was excluded from this build (build.modules.physics2d=false)'));
  }
  if (!initPromise) {
    const promise: Promise<void> = import('@dimforge/rapier2d-compat').then((m) => {
      const mod = m.default;
      // Suppress Rapier's one bogus init deprecation warning (see warnSuppress.ts) —
      // ref-counted so it composes safely with the 3D loader if both init at once.
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
          `[physics2D] Rapier2D init failed (attempt ${failedAttempts}/${RAPIER_INIT_MAX_ATTEMPTS}), will retry:`,
          err
        );
        if (initPromise === promise) initPromise = null;
      } else {
        console.error(
          `[physics2D] Rapier2D init failed permanently after ${RAPIER_INIT_MAX_ATTEMPTS} attempts — physics will not start:`,
          err
        );
      }
    });
  }
  return initPromise;
}

/** True once the WASM is instantiated and Worlds/bodies can be created. */
export function isRapierReady(): boolean {
  return ready;
}

/** The Rapier module (World, RigidBodyDesc, ColliderDesc, …). Throws if called
 *  before `isRapierReady()` — the physics system always guards with that check. */
export function getRapier(): Rapier {
  if (!RAPIER) throw new Error('[physics2D] Rapier not initialized — await initRapier2D() first');
  return RAPIER;
}
