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
  POSTFX_EFFECTS,
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

// ── The matrix (#403) ──────────────────────────────────────────────────────────────────────
// The editor renders Default / Mid / Low as COLUMNS over one row per setting, replacing the old
// stacked per-tier cards. Two things follow from that and both live here rather than in the .tsx:
// the row TABLE (what is a row, in what order, under which group) and the PATHS the Default column
// reads and writes. Both are decisions, and this module is where decisions are testable.

/** How a row's cell renders, and therefore which setter applies to a tier column. */
export type MatrixRowKind = 'number' | 'checkbox' | 'postfx';

export interface MatrixRow {
  /** `TierRenderOverrides` field for `number`/`checkbox`; `PostFXEffect` for `postfx`. Doubles as
   *  the row's React key and the stem of its `data-ui-id`. */
  field: string;
  label: string;
  kind: MatrixRowKind;
  /** Dot path into the `rendering` block that the DEFAULT column edits, or `null` when this
   *  setting has no project-level default to edit — see {@link MatrixRow.defaultNote}. */
  defaultPath: string | null;
  /** Shown IN PLACE of an input when `defaultPath` is null, saying what governs the default
   *  instead. Never left blank: a cell with nothing in it reads as a field that failed to render,
   *  which is the shape of every "authored but unwired" bug this repo keeps finding. */
  defaultNote?: string;
  /** Wheel-adjust increment for a `number` cell, and — because `applyWheelStep` rounds to the
   *  step's own decimal count — what decides whether this row can hold a FRACTION at all. Omitted
   *  means 1, which is right for a count or a texel size and wrong for every row whose seeded value
   *  has a decimal point: wheeling 1.5 with step 1 gives 3, and 0.15 gives 1 (close-out review).
   *  Typing is unaffected either way; this is the wheel only. */
  step?: number;
  /** The measurement or rule behind the value, shown on hover through the (i) affordance rather
   *  than printed permanently under every cell — the matrix has 20 rows and 3 columns, and the
   *  old always-visible captions made it unreadable at that size. */
  help: string;
}

export interface MatrixGroup {
  title: string;
  /** Optional one-line note under the group title — used where a fact governs the whole group
   *  rather than any single row (the post-FX cost ratio). */
  note?: string;
  rows: readonly MatrixRow[];
}

/** Human labels for the five post-FX effects. Exported so the panel and any test read one list
 *  rather than each spelling them out. */
export const POSTFX_LABELS: Record<PostFXEffect, string> = {
  npr: 'NPR outline', ao: 'GTAO', dof: 'Depth of field', bloom: 'Bloom', vignette: 'Vignette',
};

/** Every row of the matrix, grouped, in render order.
 *
 *  ⚠️ **DEVICE NAMES ARE DELIBERATELY ABSENT from `help` (owner, #403).** These strings are read by
 *  whoever opens Project Settings, and the internal test-fleet model names ("Y6", "A23") mean
 *  nothing outside this repo. The MEASUREMENTS are what transfer, so they are kept in full and the
 *  hardware is described by band instead. The device-by-device provenance lives in
 *  `TIER_SETTINGS`' own comments (runtime/rendering/qualityTier.ts), which is where someone
 *  re-deriving a number should be reading anyway. */
export const MATRIX_GROUPS: readonly MatrixGroup[] = [
  {
    title: '3D Rendering',
    rows: [
      {
        field: 'pixelRatioCap', label: 'Pixel-ratio cap', kind: 'number',
        step: 0.1,
        defaultPath: 'three.pixelRatioCap',
        help: '0 = uncapped. Low-end device, IBL off: 1x DPR = 22ms/45fps, 1.4x = 72ms/14fps, 2x = 69ms/14fps — a fill-bound mobile GPU pays ~4x for 2x DPR, far more than the headroom covers, so the saving is better spent on frame rate than on resolution. A mid-band device measured the opposite way: 1.5x buys 2.2x the pixels for +1.3ms and still holds 60, where 2x does not.',
      },
      {
        field: 'antialias', label: 'Antialias', kind: 'checkbox',
        defaultPath: 'three.antialias',
        help: 'Baked into the swapchain when the renderer is constructed — it CANNOT change live, so a tier resolved after bring-up catches up on the next one.',
      },
      {
        field: 'shadows', label: 'Shadows', kind: 'checkbox',
        defaultPath: 'three.shadows',
        help: 'A 512 shadow map is measured unusable — a dithered, under-sampled mess whatever the bias, because resolution is the dominant term. So a tier with no room for a bigger map drops shadows rather than shipping acne.',
      },
      {
        field: 'ibl', label: 'IBL (image-based lighting)', kind: 'checkbox',
        defaultPath: 'three.ibl',
        help: 'Low-end device: IBL costs ~26ms of a ~53ms frame, entirely GPU — turning it off nearly doubled frame rate in one measured scene (18.7→36.5 fps). A mid-band device pays only +2.9ms and holds 60, which is the measurement that made a middle tier necessary. Cannot be fixed by shrinking the HDR: the source is converted once into a fixed-size cubemap, so it is the LOOKUP that costs.',
      },
      {
        field: 'iblOffAmbientBoost', label: 'IBL-off ambient boost', kind: 'number',
        step: 0.1,
        defaultPath: 'three.iblOffAmbientBoost',
        help: 'Only applies while IBL above is OFF — puts the fill light back, or the scene goes dark and flat. ⚠️ It MULTIPLIES the scene\'s authored ambient, which is near-zero in exactly the scenes that lean on IBL for fill, so the default ×4 under-compensates them. Tune it against this project\'s own scene: ambient is uniform, so overshooting lifts shadowed surfaces above where IBL had them and flattens the scene the other way.',
      },
      {
        field: 'iblOffExposure', label: 'IBL-off exposure boost', kind: 'number',
        step: 0.1,
        defaultPath: 'three.iblOffExposure',
        help: 'The second half of the IBL-off compensation. Measured together with the ambient boost: 30.4ms/32.9fps compensated, against 27.4/36.5 uncompensated and 53.4/18.7 with IBL left on — i.e. it clears the 33.3ms budget with the look preserved.',
      },
      {
        field: 'shadowMapCeiling', label: 'Shadow-map ceiling', kind: 'number',
        defaultPath: 'three.shadowMapCeiling',
        help: '0 = no ceiling. Caps a shadow map\'s SIZE, not how many are rendered (that is Max shadow casters). 512 is measured unusable and 2048 is what projects author, so 1024 is the step between — the seeded value most likely to want a human eye on it.',
      },
      {
        field: 'maxDirectional', label: 'Max directional lights', kind: 'number',
        defaultPath: 'three.maxDirectional',
        help: '0 = unlimited. Caps how many directional lights may SHADE a fragment. Measured ladder on a mid-band device: 1 directional = 21ms, +3 point = 34ms, +8 point = 165ms — superlinear, with a cliff between 5 and 10 lights, so a cap has to sit below the cliff rather than scale smoothly. Enforced per frame.',
      },
      {
        field: 'maxLocal', label: 'Max point/spot lights', kind: 'number',
        defaultPath: 'three.maxLocal',
        help: '0 = unlimited. The point/spot half of the same per-frame cap — see Max directional lights for the ladder both are anchored on. Forward shading pays the full BRDF per light per fragment; a directional only skips distance attenuation, which is why capping point/spot alone would be a no-op on projects that light with directionals.',
      },
      {
        field: 'hysteresisMargin', label: 'Light-selection hysteresis', kind: 'number',
        step: 0.1,
        defaultPath: 'three.hysteresisMargin',
        help: '0 = off, and inert unless the two caps above actually cap something. The fraction a challenger light must beat the current selection by before it takes over. Without it, an object or light animating near a tie flaps the selection every frame — measured 12 flips over 30 frames at 0, and 0 flips at 0.15. Too large and a light that should take over visibly lags.',
      },
      {
        field: 'maxShadowCasters', label: 'Max shadow casters', kind: 'number',
        defaultPath: 'three.maxShadowCasters',
        help: '0 = unlimited. Caps how many lights RENDER a shadow map this frame — a whole extra submit of the caster set for the entire scene, once per frame each, unlike the two light caps above (which cap how many lights shade a fragment). Measured: one shadow pass was 57 of 103 draw calls, 58k of 87k triangles, ~3.6ms of a 15.7ms CPU frame.',
      },
    ],
  },
  {
    title: '2D Layer & Frame Cap',
    rows: [
      {
        field: 'targetFps', label: 'Target FPS', kind: 'number',
        defaultPath: 'targetFps',
        help: '0 = no cap (display refresh). Capping a weak device to 30 halves per-second GPU and CPU work and cuts thermal throttling — and it buys FEEL: a device that cannot hold 60 judders between 40 and 55, where a 30 cap is a stable 30. This value is also the promotion bar for low→mid.',
      },
      {
        field: 'pixiPixelRatioCap', label: '2D pixel-ratio cap', kind: 'number',
        step: 0.1,
        defaultPath: 'pixi.pixelRatioCap',
        help: '0 = uncapped. The 2D twin of Pixel-ratio cap, carrying the SAME measurement rather than a separate one — ~4x cost for 2x DPR is a fill-rate fact about a tile-based mobile GPU, not a Three.js fact. Note the 2D Resolution field is deliberately NOT here: it is a pin, and capping a pin would make the pin a lie.',
      },
      {
        field: 'pixiAntialias', label: '2D antialias', kind: 'checkbox',
        defaultPath: 'pixi.antialias',
        help: 'Same live-change limitation as its 3D twin: baked into the Pixi application when a canvas slot is created, so a tier change catches up on the next slot rather than applying immediately.',
      },
      {
        field: 'textureMaxSize', label: 'Texture max size', kind: 'number',
        // ⚠️ THE ONE TIER FIELD THAT IS DELIBERATELY *NOT* DEFAULT-AUTHORABLE, and the reason is
        // the build, not the runtime (#403 close-out). This cap does not shrink a texture — it
        // SELECTS an already-emitted smaller variant, and the build emits those by reading
        // `tiers.{mid,low}.textureMaxSize` (`sizesToEmit`, via vite-asset-scanner.ts). A cap on
        // the DEFAULT tier would therefore name a variant nothing built: `resolveTextureVariantUrl`
        // guards that (`settings.sizes?.includes(cap)`), so it is not a 404 — it is worse, a field
        // that stores a number, displays it, and changes nothing. Teaching the build to emit it
        // would be the wrong shape anyway: if EVERY device is capped, shipping the full size
        // alongside is pure waste, and under the default `auto` emit gate it would work on a web
        // build and silently not on a native one.
        //
        // The real knob for "this project never wants textures above N" is the per-texture
        // `maxSize` in its own `.meta.json`, which caps at CONVERSION time — a different mechanism
        // with a different cost, not this one with a different default.
        defaultPath: null,
        defaultNote: 'per-texture maxSize',
        help: '0 = no cap. Selects an already-built smaller variant; it does not shrink anything itself. The build only emits a downscaled file for a cap a MID or LOW tier authors, which is why the Default column cannot set one — a default cap would name a file nothing built, and silently do nothing. To cap a texture everywhere, set `maxSize` on that texture instead. Textures are ~67% of a shipped build, and variant resolution used to be size-blind: a low-end phone downloaded the same full-resolution texture as a flagship.',
      },
    ],
  },
  {
    title: 'Post-FX',
    note: 'Measured on a low-end device: a 27ms frame goes to 56ms with the NPR outline alone — screen-space, so the cost is per-pixel however simple the scene. NPR is ~7x the cost of vignette or bloom, which is why each effect is gated individually rather than by one switch.',
    rows: POSTFX_EFFECTS.map((effect) => ({
      field: effect,
      label: POSTFX_LABELS[effect],
      kind: 'postfx' as const,
      defaultPath: null,
      // Not a missing feature — a project-wide "never run bloom" switch is a different thing from a
      // tier degradation, and inventing one here would silently override every scene that authored
      // the effect on purpose. A tier column only ever takes an effect AWAY from what a scene asked
      // for, which is exactly what a degradation should do.
      defaultNote: 'scene-authored',
      help: 'The default is whatever each SCENE authors on its own PostFX component, so there is no one project-wide value to show here. A tier column can only turn the effect OFF on top of that.',
    })),
  },
];

/** Every row across every group, flattened — the form most callers and assertions want. */
export const MATRIX_ROWS: readonly MatrixRow[] = MATRIX_GROUPS.flatMap((g) => g.rows);

// ── Reading and writing the `rendering` block ──────────────────────────────────────────────
// The widget is bound to the WHOLE `rendering` subtree (like `physics-layers` is to `physics`),
// because the Default column edits fields spread across `rendering.three`, `rendering.pixi` and
// `rendering`'s own root while the tier columns edit `rendering.three.tiers`. One binding keeps
// that a single value the dialog can diff, rather than six sibling fields that must agree.

/** The `rendering` block as it arrives from the config — every key optional, because a
 *  hand-edited or older `project.config.json` is exactly what reaches this code. */
export type RenderingDraft = Record<string, unknown>;

/** Read a dot path out of the rendering block. `undefined` for anything absent — the caller
 *  decides what an absent value means, which is never the same as `0`/`false`. */
export function readRenderingPath(rendering: unknown, path: string): unknown {
  if (!rendering || typeof rendering !== 'object') return undefined;
  return path.split('.').reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as RenderingDraft)[k] : undefined),
    rendering,
  );
}

/** Write a dot path into the rendering block, returning a NEW object the whole way down the
 *  touched spine. Never mutates — the dialog holds the draft in React state and compares by
 *  reference, so an in-place write is an edit that does not re-render. */
export function writeRenderingPath(rendering: unknown, path: string, value: unknown): RenderingDraft {
  const keys = path.split('.');
  const root: RenderingDraft =
    rendering && typeof rendering === 'object' ? { ...(rendering as RenderingDraft) } : {};
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    cur[k] = next && typeof next === 'object' ? { ...(next as RenderingDraft) } : {};
    cur = cur[k] as RenderingDraft;
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

/** The project's authored `mid`/`low` configs, out of the rendering block. */
export function authoredTiersOf(rendering: unknown): AuthoredTiers {
  return normalizeAuthoredTiers(readRenderingPath(rendering, 'three.tiers'));
}

/** Put `tiers` back into the rendering block. Always writes the key — even as `{}`, which is what
 *  has to reach the backend for a REMOVAL to happen at all (see the module header). */
export function withAuthoredTiers(rendering: unknown, tiers: AuthoredTiers): RenderingDraft {
  return writeRenderingPath(rendering, 'three.tiers', tiers);
}
