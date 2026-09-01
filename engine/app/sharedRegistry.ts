/** OTA Phase 4 — the shared-singleton registry a dynamically-loaded sub-game bundle
 *  resolves its engine/three/react/etc imports against, instead of bundling its own
 *  copies (which would split ECS world/trait registries, TSL node identity, and React
 *  hook state into two live instances). Design: docs/ota-subgame-modules.md §1.
 *
 *  Imported for its side effect as the FIRST import of app/main.tsx, so
 *  `globalThis.__MODOKI_SHARED__` exists before anything (including a sub-game load
 *  triggered from App.tsx) can ask for it.
 *
 *  Keyed by exact SUBPATH, not package — `three` and `three/webgpu` carry distinct
 *  module identities (the TSL node registry lives in `three/webgpu`/`three/tsl`), so
 *  collapsing them to one `three` entry is exactly the silent-double-instance trap
 *  this registry exists to prevent. A sub-game's Rollup build externalizes each of
 *  these same keys to `__MODOKI_SHARED__.modules['<key>']` (see subgameBuild.ts).
 *
 *  Split into two groups:
 *   - EAGER: always part of the shell's own bundle regardless of render-module flags
 *     (react, koota, the ECS runtime, …) — registered synchronously below.
 *   - LAZY: gated behind `__MODOKI_MODULE_RENDER3D__`/`RENDER2D` (three, pixi.js, …) so
 *     eagerly importing them here would defeat that DCE for a shell that never uses
 *     3D/2D rendering. `ensure()` dynamic-imports them on demand; because ES module
 *     dynamic `import()` is idempotent per specifier, this shares the SAME instance
 *     App.tsx's own `lazy(() => import('@modoki/engine/runtime/rendering/Scene3D'))`
 *     resolves — no need to special-case those call sites.
 *
 *  IMPORTANT: the loader map's `() => import('three')` entries are reachable code even
 *  when never CALLED — Rollup treats a dynamic `import()` expression as a chunk root
 *  regardless of whether the closure runs, so an ungated entry ships (and un-DCEs) that
 *  chunk in every build. Each entry below is therefore wrapped in the SAME build-time
 *  `__MODOKI_MODULE_*` constant App.tsx's own lazy imports use, so an unreachable
 *  branch (dead code per that constant) is eliminated before Rollup ever sees the
 *  `import()` call. (Measured: an earlier ungated version of this file reintroduced
 *  `three.webgpu`/`three.core` chunks into a 2D-only game's build that had none before.)
 *  `@modoki/engine/runtime/rendering` (the combined barrel) is deliberately NOT a loader
 *  key here — it re-exports Scene3D (three) AND Scene2D/Game (pixi) together
 *  unconditionally, so importing it always pulls in both renderers regardless of flags;
 *  App.tsx avoids it for the same reason, importing the specific `.../Scene3D` /
 *  `.../Game` subpaths instead. A sub-game has no legitimate reason to import the
 *  barrel directly (game code uses `@modoki/engine/runtime` for traits/systems). */

import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as Koota from 'koota';
import * as Zustand from 'zustand';
import * as ZustandShallow from 'zustand/shallow';
import * as CapacitorCore from '@capacitor/core';
import * as ModokiRuntime from '@modoki/engine/runtime';

type ModuleNamespace = Record<string, unknown>;

// Every key below MUST also appear in `sharedRegistryKeys.ts`'s SUBGAME_SHARED_KEYS
// (the list a sub-game build externalizes against) — pinned by a vitest
// (tests/framework/sharedRegistry.test.ts) rather than generated, since an ES import
// can't be synthesized from an array entry.
const LAZY_LOADERS: Record<string, () => Promise<ModuleNamespace>> = {
  ...(__MODOKI_MODULE_RENDER3D__ ? {
    three: () => import('three'),
    'three/tsl': () => import('three/tsl'),
    'three/webgpu': () => import('three/webgpu'),
  } : {}),
  ...(__MODOKI_MODULE_RENDER2D__ ? {
    'pixi.js': () => import('pixi.js'),
    '@pixi/react': () => import('@pixi/react'),
  } : {}),
};

const modules: Record<string, ModuleNamespace> = {
  react: React,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': ReactJsxRuntime,
  koota: Koota,
  zustand: Zustand,
  'zustand/shallow': ZustandShallow,
  '@capacitor/core': CapacitorCore,
  '@modoki/engine/runtime': ModokiRuntime,
};

/** Exposed for the consistency test only — not for runtime consumers (use the
 *  `globalThis.__MODOKI_SHARED__` registry instead). */
export const __registeredKeysForTest = { modules, LAZY_LOADERS };

const pending = new Map<string, Promise<void>>();

/** Resolve the LAZY entries for `keys`, populating `modules` as each settles. Safe to
 *  call with already-loaded or unknown keys (unknown keys are a no-op, not an error —
 *  the caller's post-check against its own `sharedDeps` list is what should fail loud). */
async function ensure(keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => {
    if (modules[key]) return Promise.resolve();
    const loader = LAZY_LOADERS[key];
    if (!loader) return Promise.resolve();
    let promise = pending.get(key);
    if (!promise) {
      promise = loader()
        .then((ns) => { modules[key] = ns; })
        .finally(() => { pending.delete(key); });
      pending.set(key, promise);
    }
    return promise;
  }));
}

export interface ModokiSharedRegistry {
  registrySchema: 1;
  engineApi: number;
  modules: Record<string, ModuleNamespace>;
  ensure: (keys: string[]) => Promise<void>;
}

declare global {
  // eslint-disable-next-line no-var
  var __MODOKI_SHARED__: ModokiSharedRegistry | undefined;
}

if (!globalThis.__MODOKI_SHARED__) {
  globalThis.__MODOKI_SHARED__ = {
    registrySchema: 1,
    engineApi: ModokiRuntime.ENGINE_API_VERSION,
    modules,
    ensure,
  };
}
