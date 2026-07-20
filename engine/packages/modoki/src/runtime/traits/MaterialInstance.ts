import { trait } from 'koota';
import type { CurvePoint } from '../particles/types';

/** MaterialInstance — Unity `.material` / Unreal Material Instance Dynamic.
 *
 *  Presence gives the entity a private, parameter-overridable view of its material
 *  whose parameters are DRIVEN at runtime from any `MaterialParamSource`
 *  (`constant`/`time`/`store`/`curve`) or tweaked per-instance. Each `override` names a
 *  parameter + the source that feeds it. Driven by `materialInstanceSystem`.
 *
 *  Two target kinds:
 *   - `'uniform'` — a custom-shader TSL uniform. The value is written to each of the
 *     entity's drawable objects' `userData[target]`; the shader's uniform reads it per
 *     draw via `.onObjectUpdate(({object}) => object.userData[target])`. NO clone, NO
 *     recompile, and independent per entity even though the MATERIAL is shared. This is
 *     the path the stripe shader uses.
 *   - `'prop'` — a standard material property (color/opacity/`map*`/…). Requires a
 *     per-entity material CLONE (see `materialInstanceClones.ts`); valid bases are a
 *     `.mat.json` material or a baked multi-material array. */

export type MaterialParamSource =
  /** A fixed value. */
  | { type: 'constant'; value: number }
  /** A session-relative, pause-respecting, wrapped clock (seconds) — reproduces the
   *  stripe-shader lessons engine-wide. `speed` scales it, `wrap` bounds it to dodge
   *  the float32 precision cliff, `base` picks the gameplay (`sim`) or presentation
   *  (`visual`, default) delta. */
  | { type: 'time'; speed?: number; wrap?: number; base?: 'visual' | 'sim' }
  /** A live value read each frame from the read-source registry by `key` (the same
   *  registry UI `readSource` bindings use — `registerReadSource`). A real reading is
   *  coerced to a number and multiplied by `scale`. When the key is absent/non-numeric the
   *  output is the LITERAL `default` (or 0) — `scale` is NOT applied to the fallback. */
  | { type: 'store'; key: string; scale?: number; default?: number }
  /** A piecewise-linear curve (`points`, in the particle-curve shape) sampled by a
   *  `driver` value — e.g. a `time` driver with `wrap:1` loops the curve once per second,
   *  a `store` driver remaps a gameplay value. The driver is any NON-curve source. */
  | { type: 'curve'; points: CurvePoint[]; scale?: number; driver: Exclude<MaterialParamSource, { type: 'curve' }> };

export interface MaterialParamOverride {
  /** Parameter name. For `'uniform'`, the `userData` key the shader reads. For
   *  `'prop'`, the material property name. For `'texture'`, the shader's texture-param name. */
  target: string;
  /** How `target` is applied. Defaults to `'uniform'` when omitted by authored data. */
  kind: 'uniform' | 'prop' | 'texture';
  /** What feeds the parameter each frame (`'uniform'`/`'prop'`). A `'texture'` override has
   *  no source — it's a STATIC per-instance value; omit it. */
  source?: MaterialParamSource;
  /** For `'texture'` (2D custom materials only): a sprite/texture GUID bound to the shader's
   *  `target` texture param (an extra sampler), overriding that param's manifest DEFAULT for
   *  this instance. Static (not driven — MaterialInstance sources are scalar-only). The renderer
   *  (Scene2D) resolves + refcounts it exactly like the manifest-default path. */
  ref?: string;
}

/** Object-field trait (factory form) so each entity gets its own `overrides` array. */
export const MaterialInstance = trait(() => ({
  overrides: [] as MaterialParamOverride[],
}));

/** True if any override targets a standard material PROPERTY (not a uniform). Prop
 *  overrides require a per-entity material clone, so the render sync consults this to
 *  keep `syncMaterial` from resetting that clone to the shared base each frame. */
export function hasPropOverride(mi: { overrides: MaterialParamOverride[] }): boolean {
  return mi.overrides.some((o) => o.kind === 'prop');
}

/** True if `entity` drives a per-entity material clone (has a MaterialInstance with a prop
 *  override). The render sync passes this as `syncMaterial`'s `isInstanced` and uses it to
 *  give MaterialInstance precedence over Tint (both would otherwise claim the material). The
 *  parameter is typed loosely to avoid a koota Entity import cycle from the trait module. */
export function isMaterialInstanced(entity: { has(t: typeof MaterialInstance): boolean; get(t: typeof MaterialInstance): { overrides: MaterialParamOverride[] } | undefined }): boolean {
  if (!entity.has(MaterialInstance)) return false;
  const mi = entity.get(MaterialInstance);
  return !!mi && hasPropOverride(mi);
}
