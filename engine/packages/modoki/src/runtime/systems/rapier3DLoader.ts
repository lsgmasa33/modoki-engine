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

import { beginSuppressRapierInitWarning, endSuppressRapierInitWarning } from './warnSuppress';

// Type-only import — erased at compile time, so it does NOT statically bundle the WASM.
export type Rapier3D = (typeof import('@dimforge/rapier3d-compat'))['default'];

let RAPIER: Rapier3D | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

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
    initPromise = import('@dimforge/rapier3d-compat').then((m) => {
      const mod = m.default;
      // Suppress Rapier's one bogus init deprecation warning (see warnSuppress.ts) —
      // ref-counted so it composes safely with the 2D loader if both init at once.
      beginSuppressRapierInitWarning();
      return mod.init()
        .then(() => { RAPIER = mod; ready = true; })
        .finally(() => { endSuppressRapierInitWarning(); });
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
