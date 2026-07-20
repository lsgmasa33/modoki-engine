import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  root: __dirname,
  // Editor source references the __MODOKI_EDITOR__ build flag (ELECTRON_PLAN
  // Phase 1). Define it for the engine test bundle so any module touching it
  // resolves to a literal instead of a ReferenceError. Editor features are
  // present in the (jsdom) test env.
  define: {
    __MODOKI_EDITOR__: 'true',
    // Engine-module toggles — all SDKs present in the test env (physics tests load
    // Rapier, renderer tests use three/pixi). Mirrors the host Vite `define`.
    __MODOKI_MODULE_RENDER3D__: 'true',
    __MODOKI_MODULE_RENDER2D__: 'true',
    __MODOKI_MODULE_PHYSICS2D__: 'true',
    __MODOKI_MODULE_PHYSICS3D__: 'true',
    __MODOKI_MODULE_NPR__: 'true',
    __MODOKI_MODULE_GPU_PARTICLES__: 'true',
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    // The first test in a file cold-importing three.js / PixiJS + the engine can exceed the 5s
    // default on Windows under full-suite parallel load, so renderer tests (Scene2D, scene3DSync,
    // syncSceneRenderables3D) timed out intermittently — and a mid-test timeout left the shared
    // canvas pool dirty, cascading into a sibling assertion. Mirrors engine/vite.config.ts; Mac/Linux
    // finish these in milliseconds so the higher ceiling never triggers there.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
  resolve: {
    // Deps are hoisted to the repo-root node_modules. This package now lives at
    // engine/packages/modoki, so the root is three levels up (../../..).
    alias: {
      'koota': path.resolve(__dirname, '../../../node_modules/koota'),
      // Must precede the bare `three` alias: that alias rewrites `three/webgpu`
      // past three's package exports map, making the real subpath unresolvable in
      // the node test env. Point it at a stub so renderer-creation code can load
      // (tests that exercise it override further with vi.mock).
      'three/webgpu': path.resolve(__dirname, 'tests/stubs/three-webgpu.ts'),
      // Same reasoning as `three/webgpu`: the bare `three` alias below shadows
      // three's exports map, so the real `three/tsl` subpath is unresolvable in
      // the node test env. Point it at a stub; tests that assert on the TSL nodes
      // override with `vi.mock('three/tsl', ...)`.
      'three/tsl': path.resolve(__dirname, 'tests/stubs/three-tsl.ts'),
      'three': path.resolve(__dirname, '../../../node_modules/three'),
      'react': path.resolve(__dirname, '../../../node_modules/react'),
      'zustand': path.resolve(__dirname, '../../../node_modules/zustand'),
    },
  },
});
