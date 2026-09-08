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
// `vec2` is ALSO chainable — mtsdfShader.ts's AA maths does `vec2(1,1).div(fwidth(vUv))` —
// while keeping the `__vec2` marker some tests assert on.
export const vec2 = (...a: number[]) => ({ ...chainNode(), __vec2: a });
export const vec3 = (...a: number[]) => ({ __vec3: a });
export const vec4 = (...a: number[]) => ({ __vec4: a });
// `uv()` is ALSO chainable — mtsdfShader.ts does `vUv.sub(u.shadowOffset)` for the
// shadow-offset sample — while keeping the `__uv` marker some tests assert on.
export const uv = () => ({ ...chainNode(), __uv: true });
export const normalView = {};
export const normalWorld = {};
export const positionView = {};
export const positionWorld = {};
export const time = {};
// Chainable no-op node for the scene-light math nodes (sceneLightUniforms.ts) and the
// mtsdf text graph (mtsdfShader.ts). Supports the arithmetic + swizzle methods those
// graphs chain — `r`/`g`/`b`/`w`/`xyz` were added for mtsdfShader's `median()`, `s.a`
// and `vCol.xyz`/`vCol.w`.
const chainNode = (): Record<string, unknown> => {
  const n: Record<string, unknown> = {};
  for (const m of ['mul', 'add', 'sub', 'div']) n[m] = () => n;
  n.x = n; n.y = n; n.z = n; n.w = n;
  n.r = n; n.g = n; n.b = n; n.rgb = n; n.a = n; n.xyz = n;
  n.toVar = () => n;
  return n;
};

// `texture(tex, uv)` — carries `__texNode`/`tex` (some tests assert on the marker), and
// is ALSO a chain node so the mtsdf graph's `.r`/`.g`/`.b`/`.a` swizzles work on it.
export const texture = (tex: unknown) => ({ ...chainNode(), __texNode: true, tex });
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

// Added for mtsdfShader.ts's node graph (median/AA/effect-band maths).
export const min = () => chainNode();
export const mix = () => chainNode();
export const smoothstep = () => chainNode();
export const fwidth = () => chainNode();
export const step = () => chainNode();
export const attribute = (..._a: unknown[]) => chainNode();

// Fog nodes (height-mode syncFog / scene3DSync.ts) — each call returns a distinct
// chain node so a rebuild is observably a new identity vs. an unchanged reference.
// The inputs are stashed on the returned node (__color/__factor, __density/__height)
// so tests can assert the uniforms were wired through correctly, not just that SOME
// node exists.
export const fog = (color: unknown, factor: unknown) => ({ ...chainNode(), __color: color, __factor: factor });
export const exponentialHeightFogFactor = (density: unknown, height: unknown) => ({ ...chainNode(), __density: density, __height: height });
