/** The canonical set of module specifiers a sub-game bundle externalizes against the
 *  shell's `globalThis.__MODOKI_SHARED__` registry (OTA Phase 4). ONE list, used by
 *  both sides so they can't drift apart silently:
 *   - `sharedRegistry.ts` (shell) imports each of these keys eagerly or lazily to
 *     populate the registry.
 *   - `subgameBuild.ts` (the per-sub-game Vite plugin) externalizes exactly these
 *     ids when building a sub-game bundle.
 *  Exact subpaths, not packages — `three` and `three/webgpu` are distinct keys (see
 *  the header comment in sharedRegistry.ts for why collapsing them is unsafe). */
export const SUBGAME_SHARED_KEYS: readonly string[] = [
  'three',
  'three/tsl',
  'three/webgpu',
  'koota',
  'zustand',
  'zustand/shallow',
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  'pixi.js',
  '@pixi/react',
  '@capacitor/core',
  '@modoki/engine/runtime',
];
