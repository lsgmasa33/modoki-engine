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
