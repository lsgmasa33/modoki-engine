/** Test stub for the `three/tsl` subpath.
 *
 *  Same problem as `three-webgpu.ts`: the `three` alias (vitest.config.ts)
 *  rewrites `three/tsl` to a bare `<three>/tsl` path, bypassing three's package
 *  exports map, so the real module (`three/build/three.tsl.js`) is unresolvable
 *  in the node test env. This stub satisfies module resolution with no-op TSL
 *  node factories; tests that assert on TSL nodes override it with
 *  `vi.mock('three/tsl', ...)`. */

const node = () => {
  const n: Record<string, unknown> = {};
  n.toVar = () => n;
  n.rgb = n;
  n.a = n;
  return n;
};

export const wgslFn = () => () => node();
export const glslFn = () => () => node();
export const vec2 = (...a: number[]) => ({ __vec2: a });
export const vec3 = (...a: number[]) => ({ __vec3: a });
export const vec4 = (...a: number[]) => ({ __vec4: a });
export const uv = () => ({ __uv: true });
export const normalView = {};
export const normalWorld = {};
export const positionView = {};
export const positionWorld = {};
export const time = {};
export const texture = (tex: unknown) => ({ __texNode: true, tex });

// Chainable no-op node for the scene-light math nodes (sceneLightUniforms.ts).
// Supports the arithmetic + swizzle methods buildSceneDiffuseNode chains.
const chainNode = (): Record<string, unknown> => {
  const n: Record<string, unknown> = {};
  for (const m of ['mul', 'add', 'sub', 'div']) n[m] = () => n;
  n.x = n; n.y = n; n.z = n; n.rgb = n; n.a = n; n.toVar = () => n;
  return n;
};
// Uniform-group markers. `setGroup` RECORDS the group on the node (as `__group`)
// so tests can assert a scene-global uniform was put in `renderGroup` rather than
// the default per-object group — the distinction that caused the height-fog
// staleness bug (see scene3DSync.ts `HeightFogState`).
export const objectGroup = { name: 'object', shared: false };
export const renderGroup = { name: 'render', shared: true };
export const frameGroup = { name: 'frame', shared: true };

export const uniform = (value: unknown) => {
  const n = chainNode();
  n.value = value;
  n.__group = objectGroup; // three's default
  n.setName = () => n;
  n.onObjectUpdate = () => n;
  n.setGroup = (g: unknown) => { n.__group = g; return n; };
  return n;
};
export const normalize = () => chainNode();
export const max = () => chainNode();
export const dot = () => chainNode();
export const float = () => chainNode();
export const length = () => chainNode();
export const pow = () => chainNode();
export const clamp = () => chainNode();

// Fog nodes (height-mode syncFog / scene3DSync.ts) — each call returns a distinct
// chain node so a rebuild is observably a new identity vs. an unchanged reference.
// The inputs are stashed on the returned node (__color/__factor, __density/__height)
// so tests can assert the uniforms were wired through correctly, not just that SOME
// node exists.
export const fog = (color: unknown, factor: unknown) => ({ ...chainNode(), __color: color, __factor: factor });
export const exponentialHeightFogFactor = (density: unknown, height: unknown) => ({ ...chainNode(), __density: density, __height: height });
