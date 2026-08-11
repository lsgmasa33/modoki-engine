/** Pure logic behind `QualityTiersEditor.tsx` — the widget for the 'quality-tiers' Project
 *  Settings field (docs/rendering.md § "Quality tiers"). Kept in a plain module
 *  beside the panel so it is unit-testable without mounting JSX; this repo does not unit-test
 *  editor `.tsx` (CLAUDE.md § Editor `.ts` logic is expected to carry tests) — the panel's
 *  DECISIONS (seed a tier, remove a tier, flip an effect) live here, the panel only renders them.
 *
 *  ⚠️ `removeTier` OMITS the `mid`/`low` key rather than nulling it. Presence of THOSE keys is the
 *  signal `configCount()` (runtime/rendering/qualityTier.ts) and A2's boot-probe gate read, and a
 *  `null` would count as authored while carrying no fields.
 *
 *  Removing the last one leaves an empty `{}`, and that is correct rather than sloppy:
 *  `configCount({})` is 1, exactly as for an absent `tiers`, so the probe stays off. An empty
 *  object is also what has to reach the backend — `undefined` is treated as ABSENT by
 *  `deepMergeConfigPatch`, which means "leave the file alone", i.e. the removal would silently not
 *  happen. (`rendering.three.tiers` is in that merge's `REPLACE_WHOLESALE` set for the same
 *  reason; see its comment.) */

import {
  TIER_SETTINGS,
  type AuthoredTiers,
  type TierRenderOverrides,
  type PostFXEffect,
} from '../../runtime/rendering/qualityTier';

/** The two tiers a project may add on top of the (unstored) default. `high`/the default is
 *  never a key here — see the module header. */
export type TieredKey = 'mid' | 'low';

/** `value` off the wire is `unknown` (JSON from project.config.json) — narrow it to the two
 *  keys this editor understands, and only accept an object for each. Defensive rather than
 *  trusting the file: a hand-edited config is exactly the case that reaches this code untyped. */
export function normalizeAuthoredTiers(value: unknown): AuthoredTiers {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const out: AuthoredTiers = {};
  if (v.mid && typeof v.mid === 'object') out.mid = v.mid as TierRenderOverrides;
  if (v.low && typeof v.low === 'object') out.low = v.low as TierRenderOverrides;
  return out;
}

/** Seed a tier's starting content from the engine's measured `TIER_SETTINGS` — the owner
 *  requirement that "Add low" gives a project today's measured behaviour, never ten blank
 *  fields (plan §3). `structuredClone`d so editing the project's config can never mutate the
 *  engine's own table, which every other project open this session would then inherit. */
export function seedTier(tier: TieredKey): TierRenderOverrides {
  return structuredClone(TIER_SETTINGS[tier]);
}

/** Add `tier` to `authored`, seeded from `TIER_SETTINGS`. A no-op overwrite if the tier is
 *  somehow already present (the panel only shows "Add" when it is absent). Never mutates
 *  `authored`. */
export function addTier(authored: AuthoredTiers | undefined, tier: TieredKey): AuthoredTiers {
  return { ...authored, [tier]: seedTier(tier) };
}

/** Remove `tier` from `authored` by OMITTING the key — see the module header. Never mutates
 *  `authored`. Removing the only tier present yields `{}`, not `undefined`; the caller (the
 *  Project Settings field) is fine writing `{}` back through `onChange` since `configCount({})`
 *  is already 1 (no `mid`/`low` present) — the ABSENT-KEY rule is about `mid`/`low`
 *  individually, not about the wrapper object existing. */
export function removeTier(authored: AuthoredTiers | undefined, tier: TieredKey): AuthoredTiers {
  if (!authored) return {};
  const rest: AuthoredTiers = { ...authored };
  delete rest[tier];
  return rest;
}

/** Set one non-`postFX` field on a tier's config. Returns a NEW `TierRenderOverrides`; `cfg` is
 *  never mutated. Generic over the field so a new field on `TierRenderOverrides` needs no new
 *  setter written here. */
export function withField<K extends keyof Omit<TierRenderOverrides, 'postFX'>>(
  cfg: TierRenderOverrides,
  field: K,
  value: TierRenderOverrides[K],
): TierRenderOverrides {
  return { ...cfg, [field]: value };
}

/** Flip one post-FX effect on a tier's config (owner, 2026-08-11: per-effect, not one switch —
 *  plan §3). Returns a NEW `TierRenderOverrides`; `cfg` (and its `postFX`, which may be the
 *  engine's shared `NO_POSTFX`/`ALL_POSTFX` constant) is never mutated. */
export function withPostFX(cfg: TierRenderOverrides, effect: PostFXEffect, on: boolean): TierRenderOverrides {
  return { ...cfg, postFX: { ...cfg.postFX, [effect]: on } };
}
