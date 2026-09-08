/** Test stub for the `three/webgpu` subpath.
 *
 *  In the package's node test env the `three` alias (vitest.config.ts) rewrites
 *  `three/webgpu` to a bare `<three>/webgpu` path, bypassing three's package
 *  exports map, so the real module is unresolvable. This stub just satisfies
 *  module resolution; tests that actually exercise renderer creation override it
 *  with `vi.mock('three/webgpu', ...)`. */
export class WebGPURenderer {
  domElement = { remove() {} };
  toneMapping: unknown = undefined;
  toneMappingExposure = 1;
  constructor(_opts?: { antialias?: boolean; forceWebGL?: boolean }) {}
  setPixelRatio(_r?: number) {}
  setSize(_w?: number, _h?: number) {}
  init() { return Promise.resolve(); }
  dispose() {}
}

/** Minimal stand-in for the TSL node-material base `makeMtsdfMaterial` (mtsdfShader.ts)
 *  builds on — just enough to let that function run under this package's node test env:
 *  settable render-state fields, `colorNode`/`opacityNode` assignment slots, and a plain
 *  `userData` object (mtsdfShader.ts writes the reuse stamp into it). */
export class MeshBasicNodeMaterial {
  transparent = false;
  depthWrite = true;
  side: unknown = undefined;
  colorNode: unknown = undefined;
  opacityNode: unknown = undefined;
  userData: Record<string, unknown> = {};
  // `disposeTextPageMeshes` (scene3DSync.ts) calls this on every page material. Present so a
  // future test that drives `syncText3D` with the REAL builder — rather than a mocked
  // `makeMtsdfMaterial` — fails on its own assertion instead of on a missing stub method.
  dispose() {}
}
