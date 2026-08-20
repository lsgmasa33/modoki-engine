/** Lazy, `render3d`-gated access to three's example loaders (#254).
 *
 *  `three/examples/jsm/loaders/*` are 3D-only consumers, but a *static* import of one is
 *  reachable from the `runtime/index.ts` barrel — which every build keeps alive — so a
 *  `build.modules.render3d: false` game shipped GLTFLoader, the HDR decoders, KTX2Loader and
 *  the meshopt decoder it can never call. Measured on `games/space-invader`: 185.0 kB raw /
 *  58.9 kB gzip of a 2400 kB bundle, on the project that drives the playable-ad export and its
 *  5 MB ceiling (docs/playable-export.md).
 *
 *  The fix is the shape #214 established for the KTX2 caps probe: put the `import()` BEHIND a
 *  `__MODOKI_MODULE_RENDER3D__` check, which Rolldown folds to a literal and DCEs — import and
 *  chunk both. Keep the gate FIRST in every accessor; a dynamic import that a false branch can
 *  still reach is emitted as its own chunk and counts against the same ceiling.
 *
 *  Each accessor is single-flight: the promise is memoised, so N concurrent callers share one
 *  module fetch and one evaluation — but a REJECTED promise is dropped rather than kept, so a
 *  transient chunk-fetch failure costs one load instead of poisoning every later one for the
 *  life of the page. Same rule `textureResolver`'s texture cache states for the same reason.
 *
 *  ⚠️ Do NOT refactor these into a shared `lazyOnce(() => import(…))` helper. That moves the
 *  `import()` into an arrow captured at module scope, which Rolldown can no longer prove
 *  unreachable — the gate stops folding and every chunk comes back. The repetition is the
 *  price of the DCE, and `render3dBoundary.test.ts` asserts the shape.
 */

import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { UltraHDRLoader } from 'three/examples/jsm/loaders/UltraHDRLoader.js';

/** Thrown when a 3D-only loader is requested from a bundle built without `render3d`. There is
 *  no meaningful degrade for a missing constructor, so this fails loudly and names the switch —
 *  unlike `ensureKtx2Caps`, which has a real "no caps needed" answer and resolves instead. */
function noRender3D(what: string): Error {
  return new Error(
    `[threeLoaderModules] ${what} needs build.modules.render3d — this bundle has 3D rendering disabled`,
  );
}

let gltfCtor: Promise<typeof GLTFLoader> | null = null;
/** three's `GLTFLoader` constructor. */
export function gltfLoaderCtor(): Promise<typeof GLTFLoader> {
  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(noRender3D('GLTFLoader'));
  return (gltfCtor ??= import('three/examples/jsm/loaders/GLTFLoader.js')
    .then((m) => m.GLTFLoader).catch((e) => { gltfCtor = null; throw e; }));
}

let hdrCtor: Promise<typeof HDRLoader> | null = null;
/** three's `HDRLoader` (Radiance `.hdr`) constructor. */
export function hdrLoaderCtor(): Promise<typeof HDRLoader> {
  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(noRender3D('HDRLoader'));
  return (hdrCtor ??= import('three/examples/jsm/loaders/HDRLoader.js')
    .then((m) => m.HDRLoader).catch((e) => { hdrCtor = null; throw e; }));
}

let ultraHdrCtor: Promise<typeof UltraHDRLoader> | null = null;
/** three's `UltraHDRLoader` (gainmap JPEG) constructor. */
export function ultraHdrLoaderCtor(): Promise<typeof UltraHDRLoader> {
  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(noRender3D('UltraHDRLoader'));
  return (ultraHdrCtor ??= import('three/examples/jsm/loaders/UltraHDRLoader.js')
    .then((m) => m.UltraHDRLoader).catch((e) => { ultraHdrCtor = null; throw e; }));
}

let ktx2Ctor: Promise<typeof KTX2Loader> | null = null;
/** three's `KTX2Loader` constructor. */
export function ktx2LoaderCtor(): Promise<typeof KTX2Loader> {
  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(noRender3D('KTX2Loader'));
  return (ktx2Ctor ??= import('three/examples/jsm/loaders/KTX2Loader.js')
    .then((m) => m.KTX2Loader).catch((e) => { ktx2Ctor = null; throw e; }));
}

type MeshoptDecoderT = typeof import('three/examples/jsm/libs/meshopt_decoder.module.js').MeshoptDecoder;
let meshopt: Promise<MeshoptDecoderT> | null = null;
/** three's bundled meshopt decoder (a value, not a class) — needed by any GLB carrying
 *  `EXT_meshopt_compression`, which is every gltfpack-produced LOD and optimized rig. */
export function meshoptDecoder(): Promise<MeshoptDecoderT> {
  if (!__MODOKI_MODULE_RENDER3D__) return Promise.reject(noRender3D('MeshoptDecoder'));
  return (meshopt ??= import('three/examples/jsm/libs/meshopt_decoder.module.js')
    .then((m) => m.MeshoptDecoder).catch((e) => { meshopt = null; throw e; }));
}

/** Build a `GLTFLoader` with the meshopt decoder already wired — the combination every call
 *  site in this repo wants, and the one it is easy to half-do (a GLB with meshopt geometry
 *  fails to parse with a bare loader). */
export async function makeGltfLoader(): Promise<GLTFLoader> {
  const [Ctor, decoder] = await Promise.all([gltfLoaderCtor(), meshoptDecoder()]);
  const loader = new Ctor();
  loader.setMeshoptDecoder(decoder);
  return loader;
}

export type { MeshoptDecoderT };

/** Start fetching the GLB loader modules without waiting for them. Called once a 3D renderer
 *  registers, because the alternative is worse: scene load → acquire model → `import()` →
 *  *then* fetch the GLB, one extra serialized round-trip on the critical path of the first
 *  frame. Warming GLTF+meshopt only — an HDR or KTX2 chunk is speculative in a way these two
 *  are not (nearly every 3D scene parses a GLB). Memoised, so this costs one fetch at most,
 *  and swallowing the rejection is right: the real caller reports the failure with its path. */
export function prewarmGlbLoaders(): void {
  if (!__MODOKI_MODULE_RENDER3D__) return;
  void gltfLoaderCtor().catch(() => {});
  void meshoptDecoder().catch(() => {});
}
