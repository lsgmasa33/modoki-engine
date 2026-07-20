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

import { beginSuppressRapierInitWarning, endSuppressRapierInitWarning } from './warnSuppress';

// Type-only import — erased at compile time, so it does NOT statically bundle the WASM.
export type Rapier = (typeof import('@dimforge/rapier2d-compat'))['default'];

let RAPIER: Rapier | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

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
    initPromise = import('@dimforge/rapier2d-compat').then((m) => {
      const mod = m.default;
      // Suppress Rapier's one bogus init deprecation warning (see warnSuppress.ts) —
      // ref-counted so it composes safely with the 3D loader if both init at once.
      beginSuppressRapierInitWarning();
      return mod.init()
        .then(() => { RAPIER = mod; ready = true; })
        .finally(() => { endSuppressRapierInitWarning(); });
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
