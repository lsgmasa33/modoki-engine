/** Scene/trait JSON validation — pure, dependency-light so it runs in BOTH the
 *  browser (runtime load path) and Node (Vite dev-server endpoints).
 *
 *  Returns *warnings*, never throws and never blocks: the engine's load path is
 *  deliberately forgiving (warn-but-load), so a single typo surfaces a precise
 *  message instead of blanking the view. Two consumers:
 *    - runtime `loadSceneFile` — console.warn each finding on load.
 *    - dev server `/api/validate-scene` + `/api/scene-mutate` — return findings
 *      in the HTTP response so an agent editing JSON can self-correct.
 *
 *  The trait schema is optional: when no browser has connected to push its live
 *  trait registry, structural + GUID-reference checks still run; trait/field
 *  type checks are skipped (reported once as an info note by the caller). */

import { isGuid, isExternalUrl, isInternalAssetPath } from '../core/assetRefRules';
import { isSizeInert } from '../ui/anchorLayout';
import {
  isElementMarginInert, MARGIN_KEYS,
  POOLED_ROW_GENERIC_WARN_FIELDS, POOLED_ROW_PINNED_GROUPS,
} from '../ui/uiAuthoring';
// The bank parser, NOT `traits/UIEntries` itself — that module calls `trait({...})` at import
// time and this one is deliberately dependency-light (see module docs above).
import { parseEntryPrefabs } from '../traits/entryPrefabBank';

/** Asset-reference fields, keyed by the trait they live on. A value in one of
 *  these fields must be a GUID or an external URL — never a project-internal
 *  asset path (`/games/x/foo.mesh.json`). This is the single source of truth;
 *  `editor/scene/serialize.ts` imports it for its save-time guard. */
export const REF_FIELDS_BY_TRAIT: Record<string, string[]> = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite', 'material'],
  Text3D: ['font'],
  Text2D: ['font'],
  SpriteAnimator: ['clipSet'],
  SkinnedSprite2D: ['rig'],
  // fontFamily joined imageSrc in #231: it holds a font-ASSET GUID now, not a CSS family
  // name, so the validator, `diagnose` and the build tree-shaker can all finally see a UI
  // font reference. A plain CSS family name lives in the separate `systemFont` field, which
  // is NOT a ref and is deliberately absent from this registry.
  UIElement: ['imageSrc', 'fontFamily'],
  // The scene-wide DOM font default (#803). It must be here and not only in
  // `SCALAR_RESOURCE_TYPE_BY_FIELD`: that table is consulted only for fields this registry
  // already lists per trait, so an entry there alone is dead code and the ref is collected by
  // nothing. What this entry buys, specifically — measured by deleting it and watching which
  // suites red, not assumed:
  //   - `collectResourceRefsFromEntities` emits the `{type:'font-family'}` scene resource, which
  //     is what FontFace-registers the face at scene load. Without it a scene whose ONLY font ref
  //     is `UISettings.fontFamily` (Court's, once its per-root author was removed) still renders
  //     today ONLY because `SceneManager` also acquires from the scene's saved `resources` array —
  //     and the next editor save regenerates that array without the entry, so the font dies later,
  //     silently, in a commit that touches nothing to do with fonts.
  //   - the validator's GUID check, and `editor/scene/serialize.ts`'s save-time guard.
  // ⚠️ NOT the build keep-walk: `plugins/asset-tree-shaker.ts` reaches this field through its own
  // dedicated `'font-family'` handler (and skips it here via `DEDICATED_REF_FIELDS`), because the
  // generic `'asset'` push would keep only the one file the GUID names and drop the family's other
  // VARIANTS. Deleting this entry leaves all 65 tree-shaker tests green — so do not read this line
  // as the thing protecting the production build; that lives in the shaker.
  // `systemFont` is a CSS family name, not a ref, and stays out.
  UISettings: ['fontFamily'],
  ModelSource: ['glbPath'],
  SkinnedModel: ['model'],
  SkeletalAnimator: ['animSet'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
  ParticleEmitter: ['effect'],
  // NOTE: Animator has NO scalar ref field — `clip` is the active clip NAME, and the
  // `.anim.json` GUIDs live inside the JSON-string `clips` bank (parsed explicitly in
  // collectResourceRefsFromEntities + the tree-shaker's probeTraitRefs, like AudioSource.clips).
  AudioSource: ['clip'],
  VideoPlayer: ['clip'],
  // Director.timeline is a scalar `.timeline.json` GUID ref. The clip/audio GUIDs the timeline
  // references live INSIDE that JSON asset (walked by SceneManager's transitive loop + the
  // tree-shaker's timeline follower), not in trait fields — same shape as an Animator bank.
  Director: ['timeline'],
};
// NOTE: this registry is the single source of truth for SCALAR asset-ref fields —
// consumed by the validator (above) AND the build tree-shaker's keep-walk
// (plugins/asset-tree-shaker.ts), so a new ref field added here is covered by both.
// Non-scalar refs (AnimationLibrary.animSets = an array of guids) are intentionally NOT
// here and are handled explicitly.

/** The built-in 2D sprite SHAPES — the keywords that draw something on their own. Exported
 *  because `create_entity` validates `shape` against it: an unknown value used to produce an
 *  entity with an unresolvable sprite, reported as a clean success. ONE list, so the tool and
 *  the validator cannot drift. */
export const PRIMITIVE_SPRITE_NAMES = ['circle', 'square', 'triangle'] as const;

/** ⚠️ A copy of `rendering/render2DUtils.ts`'s `COLLIDER_SPRITE`, kept honest by
 *  `tests/assets/spriteKeywords.test.ts` rather than imported: this module is deliberately
 *  dependency-light so it runs in Node (the dev server's `/api/validate-scene`), and
 *  `render2DUtils` reaches the texture provider and PixiJS.
 *
 *  It is a legal AUTHORED value that is not a shape — it draws the entity's own `Collider2D`
 *  outline, which is how a polygon/polyline collider gets a visible body. It was missing from
 *  the list below, so the validator reported both committed uses of it in
 *  `demos/2d-physics-demo` as "'collider' is not a GUID or URL" on every load, and
 *  `/api/validate-scene` / `modoki_validate_scene` reported those scenes as broken when they
 *  are not. Found by #231's close-out sweep for the same class it fixed: a legitimate value a
 *  ref guard cannot recognise. */
const COLLIDER_SPRITE_KEYWORD = 'collider';

/** Every `Renderable2D.sprite` value that is legal without being a GUID or URL. Deliberately
 *  WIDER than `PRIMITIVE_SPRITE_NAMES`: the validator asks "is this legal to author", while
 *  `create_entity` asks "will this draw something by itself" — and `collider` draws nothing
 *  without a `Collider2D` on the same entity, so creating one from the tool would be a
 *  successful-looking call that renders nothing. */
const PRIMITIVE_SPRITES = new Set<string>([...PRIMITIVE_SPRITE_NAMES, COLLIDER_SPRITE_KEYWORD]);

export type FieldType = 'number' | 'string' | 'boolean' | 'color' | 'enum' | 'entityRef' | 'bindings' | 'materialOverrides';

/** Per-trait schema slice the validator needs — a subset of the editor's
 *  TraitMeta, serializable so the browser can push it over the HMR socket.
 *  A field with `type` omitted is *known* (won't be flagged as unknown) but is
 *  not type-checked — used for fields present in the koota schema whose type the
 *  registry can't confidently infer (objects, arrays). */
export interface TraitSchema {
  category: 'component' | 'resource' | 'tag';
  /** `default` is the trait's koota schema default, scalars only. Load-bearing now that
   *  serialize.ts OMITS a field still holding its default: without it a reader of a scene
   *  file cannot tell what an absent field's effective value is. */
  fields: Record<string, { type?: FieldType; options?: string[]; default?: unknown }>;
}

export interface SceneSchema {
  traits: Record<string, TraitSchema>;
}

export interface ValidationResult {
  warnings: string[];
  /** True when a schema was supplied and used for trait/field type checks. */
  schemaApplied: boolean;
}

interface SceneEntityLike {
  id?: number;
  name?: string;
  traits?: Record<string, unknown>;
  /** Prefab-instance field overrides, keyed by prefab `localId` (string) → trait
   *  name → changed field. Sibling of `traits`, not inside it (prefabs.md). */
  overrides?: unknown;
}

/** Resolve a `PrefabInstance.source` ref to that prefab's parsed `.prefab.json`, or
 *  undefined when it cannot be resolved. Injected by the caller so this module stays
 *  pure — it does no I/O of its own (see module docs). Absent ⇒ prefab-supplied
 *  anchors are simply not checked (a conservative false negative, never a wrong claim). */
export type PrefabResolver = (sourceRef: string) => unknown;

/** Does this GUID ref name an asset that actually EXISTS in the project's manifest?
 *  Injected by the caller for the same reason `PrefabResolver` is — this module does
 *  no I/O and has no manifest of its own (see module docs).
 *
 *  "Nobody could tell me" is expressed by NOT PASSING a resolver at all, rather than by
 *  a verdict. A caller that cannot answer authoritatively — no manifest loaded, a partial
 *  scan — must omit this rather than supply one that answers `'missing'`, because that
 *  reads as "this asset was deleted" and would send a caller hunting a ref that is fine.
 *
 *  Absent ⇒ ref fields are checked for GUID *shape* only, which is exactly what this
 *  validator did before #292: a scene referencing a well-formed GUID for a
 *  deleted-from-the-manifest asset validated completely clean, and the failure
 *  surfaced later, at load/render time. */
export type AssetRefResolver = (ref: string) => AssetRefVerdict;

/** What a resolver found for a ref. Three states, not a boolean, because the third one
 *  has a completely different fix and a `false` would describe it wrongly:
 *
 *  - `'ok'`          — the manifest has this exact guid.
 *  - `'missing'`     — nothing in the manifest, at any casing. Deleted or never imported.
 *  - `'case-mismatch'` — an asset carries this guid but with different LETTER CASE.
 *
 *  ⚠️ The resolver must answer **case-sensitively**, because that is what decides whether
 *  the ref loads: `resolveRef` (assetManifest.ts) is `guidToEntry.get(ref)`, a plain
 *  case-sensitive `Map.get`, and `registerAsset` stores the guid verbatim with no
 *  normalisation — while `isGuid`'s regex carries `/i` and so ACCEPTS an uppercase guid.
 *  A resolver that lowercased both sides would report "will resolve at load" for a ref
 *  that resolves to `undefined` at load, which is the exact false negative this check
 *  exists to remove. Every generated guid is lowercase (`crypto.randomUUID`, `deriveGuid`),
 *  so this only bites a hand-authored or externally-produced ref — which is precisely the
 *  case where the author is staring at a guid that IS in the manifest and needs to be told
 *  it is the casing, not a deleted asset. */
export type AssetRefVerdict = 'ok' | 'missing' | 'case-mismatch';

/** Build an `AssetRefResolver` from the project's asset guids — ONE implementation of the
 *  three-state rule, shared by every consumer.
 *
 *  It exists because the rule was written twice and the two copies had ALREADY diverged
 *  inside the commit that introduced them: the dev-server resolver folded letter case while
 *  the hot-reload one did not, so the same scene and the same manifest produced different
 *  verdicts depending on which surface asked. Duplicating a predicate is how that happens,
 *  and a second reader changing "the" resolver would have found only the tested copy.
 *
 *  Returns `undefined` — NOT a resolver that answers `'missing'` — when there are no guids
 *  to check against, so an empty or unreadable manifest degrades to "could not check" and
 *  leaves the shape-only pass. A false "this asset was deleted" sends a caller hunting a ref
 *  that is fine, which is worse than the gap the check closes.
 *
 *  Non-string / empty guids are skipped rather than thrown on: a malformed manifest entry
 *  must not turn a validation that always answered into a failed call. */
export function makeAssetRefResolver(guids: Iterable<unknown>): AssetRefResolver | undefined {
  const exact = new Set<string>();
  const foldedCase = new Set<string>();
  for (const g of guids) {
    if (typeof g === 'string' && g) {
      exact.add(g);
      foldedCase.add(g.toLowerCase());
    }
  }
  if (exact.size === 0) return undefined;
  return (ref: string): AssetRefVerdict => {
    if (exact.has(ref)) return 'ok';
    return foldedCase.has(ref.toLowerCase()) ? 'case-mismatch' : 'missing';
  };
}

/** Is an authored `UIElement.${axis}` value a NEUTRAL "unset"/"agrees with stretch"
 *  claim, not a real trap? Shared by the direct-trait path and the prefab-override
 *  path so they cannot drift on the noise budget:
 *    0    — the "unset" default every UIElement carries.
 *    100% — "fill the parent", which AGREES with what stretch does. It is what the
 *           editor itself writes for a stretched element, so warning on it would have
 *           fired 102 times across games/ + demos/ while the real traps numbered 3
 *           (court's NarrationBand 90%, 3d-test's 2D 200%).
 *  Known limit: 100% is let through even under insetting offsets, where the true
 *  extent is smaller. Tightening that needs viewport math this module does not have,
 *  and would reintroduce the 102.
 *
 *  ⚠️ **The "3 real traps" above is HISTORICAL — re-measured 2026-09-05 and the corpus is now at
 *  0.** Both named scenes have since been corrected, so a sweep today reports nothing; the count is
 *  kept because it is the evidence for the noise budget, not a current inventory. Do not read a
 *  quiet sweep as this check being broken — verify by perturbing a value (a `90` under a
 *  `bottom-stretch` anchor still reports), which is what the tests do. */
function isNeutralSize(v: unknown, unit: unknown): boolean {
  return v === 0 || (v === 100 && unitOrDefault(unit) === '%');
}

/** The unit a UIElement length field ACTUALLY has, given what the scene JSON carries.
 *
 *  ⚠️ **An absent unit means `'%'`, not `'px'`.** Every `UIElement` length unit defaults to `'%'`
 *  (`runtime/traits/UIElement.ts`) and a scene save STRIPS any field equal to its trait default, so
 *  the common on-disk shape for a percentage is the number with no unit beside it. Reading that as
 *  `px` was wrong twice over: it made `isNeutralSize` miss `width: 100` (a full-bleed box the
 *  editor itself writes), and it made the message quote a unit the author never chose.
 *
 *  Measured before the fix: six live false positives across two SHIPPING games — `HUD`,
 *  `Chrome Buttons`, `MenuIconBar` and `AdBannerSlot` in `games/court`'s main scene, `HudLine` and
 *  `AdBannerSlot` in `games/wordweave`'s — each reported as "the authored 100px" when the author
 *  wrote 100%. Against a noise budget whose whole point was 3 real findings versus 102 false ones,
 *  six is not a rounding error. */
function unitOrDefault(unit: unknown): string {
  return typeof unit === 'string' && unit ? unit : '%';
}

/**
 * Asset-reference warnings for ONE entity's trait bag — every field in
 * `REF_FIELDS_BY_TRAIT` must be a GUID or an external URL, and (when `assetExists` is
 * injected) that GUID must name an asset the manifest actually has.
 *
 * ONE predicate serves every caller, for the reason `inertLayoutWarnings` below gives: a
 * prefab-instance's OVERRIDE group has the identical `{trait: {field: value}}` shape as a
 * scene entity's `traits`, so restating the rule per call site is how the exemptions
 * (primitive sprite keywords, external URLs) drift apart. They already had: until #292 this
 * rule ran over `entity.traits` ONLY, and the 56 ref fields authored inside `overrides`
 * blocks across `games/` + `demos/` were checked by nothing at all — not for resolution,
 * not even for GUID shape. A literal asset path in an override was as silent as a deleted one.
 *
 * `label` is prefixed to each message; the caller owns what the group is CALLED (a scene
 * entity by name, an override group by `overrides[localId]`).
 */
export function refFieldWarnings(traits: unknown, label: string, assetExists?: AssetRefResolver): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  for (const [traitName, traitVal] of Object.entries(traits as Record<string, unknown>)) {
    const refFields = REF_FIELDS_BY_TRAIT[traitName];
    // A tag trait serializes as `true` and carries no fields; an unknown trait still gets
    // its refs checked (a typo'd trait name must not also hide a dead asset ref).
    if (!refFields || !traitVal || typeof traitVal !== 'object') continue;
    const fields = traitVal as Record<string, unknown>;
    for (const field of refFields) {
      const v = fields[field];
      if (typeof v !== 'string' || v === '') continue;
      if (traitName === 'Renderable2D' && field === 'sprite' && PRIMITIVE_SPRITES.has(v)) continue;
      if (isExternalUrl(v)) continue;
      if (isGuid(v)) {
        // #292 — GUID SHAPE was the whole check until now, so a ref to an asset that had
        // been deleted from the manifest validated clean and failed later, at load/render
        // time. Only reachable when the caller injected a resolver that can answer
        // authoritatively (see `AssetRefResolver`); without one this stays the shape-only
        // pass it has always been.
        if (assetExists) {
          const verdict = assetExists(v);
          if (verdict === 'missing') {
            out.push(
              `${label}.${traitName}.${field}: '${v}' is a well-formed GUID but no asset in the manifest has it `
              + `— the asset was deleted or never imported, so this reference will not resolve at load`,
            );
          } else if (verdict === 'case-mismatch') {
            // Deliberately NOT the message above: the asset is right there, and telling
            // this author it was "deleted or never imported" sends them hunting a file they
            // are looking at. See `AssetRefVerdict` for why case decides resolution.
            out.push(
              `${label}.${traitName}.${field}: '${v}' matches a manifest asset only when letter case is ignored `
              + `— asset refs resolve through a case-SENSITIVE lookup, so this will not resolve at load. `
              + `Re-author the ref with the manifest's exact casing (guids are minted lowercase).`,
            );
          }
        }
        continue;
      }
      // Every field in this registry holds a manifest-asset GUID — `Text2D.font` /
      // `Text3D.font` / `UIElement.fontFamily` included — so a font PATH is a
      // literal-path violation here like any other (QA-INSP-0004, #231).
      if (isInternalAssetPath(v)) {
        out.push(
          `${label}.${traitName}.${field}: internal asset path '${v}' — references must be a GUID (use the asset's id / .meta.json sidecar)`,
        );
      } else {
        out.push(`${label}.${traitName}.${field}: '${v}' is not a GUID or URL`);
      }
    }
  }
  return out;
}

/**
 * Inert-size warnings for ONE entity's trait bag: a `UIElement.width`/`height` authored on an
 * axis its `UIAnchor` stretches is stored, shown in the Inspector, and never applied, because a
 * stretched axis is sized entirely by its two offsets.
 *
 * The three authoring shapes, which entry point reports each, and the noise budget are owned by
 * **docs/scene-loading.md** (pass 4). What matters here: a prefab entity has the identical `traits`
 * shape as a scene entity, so ONE predicate serves every caller — restating the rule per call site
 * is how the `0` / `100%` exclusions drift, and those exclusions are the difference between 3 real
 * findings and 102 false ones.
 *
 * `label` is prefixed to each message; the caller owns what an entity is CALLED (a scene entity by
 * name, a prefab entity by localId), because that is the only part that differs.
 */
export function inertLayoutWarnings(traits: unknown, label: string): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  const uel = (traits as Record<string, unknown>).UIElement;
  const uan = (traits as Record<string, unknown>).UIAnchor;
  if (!uel || typeof uel !== 'object' || !uan || typeof uan !== 'object') return out;
  const uanObj = uan as Record<string, unknown>;
  // ⚠️ An entity on the DEFAULT anchor mode ('stretch') has no `anchor` key at all: a scene save
  // strips any field equal to its trait default. The size arm below still needs the mode STRING
  // (`isSizeInert` reads it), so it stays gated on `anchor !== undefined` — but margin is
  // mode-INDEPENDENT (see its own comment) and must run off the mere PRESENCE of a
  // `UIAnchor` object, never off whether its `anchor` field happened to survive the strip.
  const anchorRaw = uanObj.anchor;
  const anchor = typeof anchorRaw === 'string' ? anchorRaw : undefined;
  if (anchor !== undefined) {
    for (const axis of ['width', 'height'] as const) {
      const v = (uel as Record<string, unknown>)[axis];
      const unit = (uel as Record<string, unknown>)[`${axis}Unit`];
      if (typeof v === 'number' && !isNeutralSize(v, unit) && isSizeInert(anchor, axis)) {
        // Echo the value WITH its unit — '90%' is what the author sees in the Inspector, so a
        // bare '90' makes them hunt for which field is meant.
        const authored = `${v}${unitOrDefault(unit)}`;
        out.push(
          `${label}.UIElement.${axis} is inert: the '${anchor}' anchor sizes that axis from its `
          + `${axis === 'width' ? 'left/right' : 'top/bottom'} offsets, which overwrite the authored ${authored}`,
        );
      }
    }
  }
  // Margin dies on ANY anchor, not just a stretching one (#757) — `applyAnchorStyle` clears all
  // four unconditionally, and it does so for a DEFAULT-mode anchor exactly as it does for every
  // other mode: the anchor MODE is irrelevant to it. So this arm is
  // mode-independent too — gated on `isElementMarginInert`, which only asks whether a `UIAnchor`
  // is present at all, not on `anchor` being a string (a hole left by #757; closed here).
  // Reported from the same function as size because they are the same class of finding on the
  // same trait pair, and a second entry point is a second place for the "is it actually
  // authored?" exclusions to drift. `isElementMarginInert` is the shared predicate the Inspector
  // gate and `anchorCss` both use.
  //
  // ⚠️ Zero is the neutral value and is NOT reported: `UIElement`'s margin defaults are 0, so
  // warning on them would fire on essentially every anchored element in the repo and bury the
  // three real findings — the same reason `isNeutralSize` exists one loop up.
  //
  // `isElementMarginInert` only asks "is this non-null/undefined", so a default-mode anchor
  // (whose `anchor` field is stripped to `undefined`) must be passed as the mode it actually
  // resolves to ('stretch') rather than as `anchor` itself — otherwise the presence check
  // collapses back to the mode-string gate this arm is meant to escape.
  const marginAnchorMode = anchor ?? 'stretch';
  if (isElementMarginInert(marginAnchorMode)) {
    for (const key of MARGIN_KEYS) {
      const v = (uel as Record<string, unknown>)[key];
      if (typeof v !== 'number' || v === 0) continue;
      const unit = (uel as Record<string, unknown>)[`${key}Unit`];
      const authored = `${v}${unitOrDefault(unit)}`;
      out.push(
        `${label}.UIElement.${key} is inert: the '${marginAnchorMode}' anchor positions this `
        + `element from its own offsets, which overwrite all four margins — the authored ${authored} `
        + `is discarded`,
      );
    }
  }
  return out;
}

/** `UIElement.lineHeight` is emitted in PIXELS (`UINode.tsx` writes `${lineHeight}px`) — React
 *  leaves a bare number unitless and CSS reads THAT as a font-size multiplier, so the px is
 *  deliberate. But the Inspector tooltip said "Line height multiplier. 0 = auto" with `step: 0.1`
 *  for as long as the field existed, and 17 entities across two projects were authored against
 *  it (#809). A 1.4 there is a 1.4px line box: wrapped lines stack into an unreadable overlap,
 *  and where `maxLines` is set it also caps the element at `lineHeight * maxLines` px.
 *
 *  ⚠️ **Why the ceiling and not a comparison against the entity's own `fontSize`** (the shape
 *  #809 originally proposed): that comparison had ~1px of headroom on real content — Court's
 *  `NarrationText` authors 19 against `fontSize` 19 and `RefusalText` 20 against 20, so both pass
 *  only because the comparison is strict `<`, and anyone "tidying" it to `<=` turns two shipping
 *  entities into false positives. It also silently compares a px length against a `fontSize` that
 *  may be authored in `vmin`/`vh` (`fontSizeUnit`, #245), a unit mismatch it cannot see. Every
 *  plausible multiplier is 1.0-3.0 and no plausible px line height is under 4, so a flat ceiling
 *  needs no second field, is immune to `fontSizeUnit`, and has four times the margin.
 *
 *  ⚠️ **Do not rewrite this docblock as a measurement of the corpus.** #809's own fix converted
 *  all 17, so a sweep today finds zero — this is a PREVENTATIVE guard, and a justification phrased
 *  as "it currently catches N" goes stale the moment any branch changes the content (the #549
 *  scar). Verify it by perturbing a value, which is what the tests do. */
export const LINE_HEIGHT_MULTIPLIER_CEILING = 4;

/** Line-height-authored-as-a-multiplier warnings for ONE entity's trait bag. */
export function lineHeightUnitWarnings(traits: unknown, label: string): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  const uel = (traits as Record<string, unknown>).UIElement;
  if (!uel || typeof uel !== 'object') return out;
  const lh = (uel as Record<string, unknown>).lineHeight;
  // `0` is the authored "auto" sentinel and is explicitly fine; only a positive value below the
  // ceiling is suspect. A negative is nonsense but is not THIS check's business.
  if (typeof lh !== 'number' || lh <= 0 || lh >= LINE_HEIGHT_MULTIPLIER_CEILING) return out;
  const fs = (uel as Record<string, unknown>).fontSize;
  const suggestion = typeof fs === 'number' && fs > 0
    ? ` For fontSize ${fs} the equivalent is ${Math.round(lh * fs)}.`
    : '';
  out.push(
    `${label}.UIElement.lineHeight is ${lh}, which looks like a MULTIPLIER — this field is in `
    + `PIXELS (like fontSize), so it renders a ${lh}px line box and wrapped lines overlap.`
    + suggestion,
  );
  return out;
}

/** An authored newline in `UIElement.text` that the DOM will COLLAPSE (#676).
 *
 *  `UINode` sets `white-space` on exactly two branches — `AnimatedText`'s typewriter span and
 *  `AutoFitText`'s span, both `pre-wrap`. Every other path — the plain text path (a bare string
 *  with no autofit and no text animation) AND the `maxLines`-clamp span — sets none, so it
 *  inherits `white-space: normal` and every authored `\n` collapses to a single space. A
 *  four-line credits block renders as one run-on paragraph.
 *
 *  ⚠️ **`maxLines` is NOT a pre-wrap path, despite looking like one.** `UINode.tsx`'s
 *  `maxLines > 0` branch builds a height clamp (`overflow: 'hidden'` plus `-webkit-box`/
 *  `maxHeight` variants) and sets no `white-space` of its own — a newline under `maxLines`
 *  collapses exactly like the plain path. It was wrongly treated as a third pre-wrap escape here
 *  once; do not re-add it.
 *
 *  ⚠️ **The failure is invisible to every instrument except the render.** `textContent` still
 *  holds the newlines, the trait still holds them, and a test comparing the formatted string still
 *  passes — which is exactly why this needs a validator arm rather than a unit test somewhere.
 *
 *  ⚠️ **This deliberately does NOT flag runs of SPACES**, though they collapse by the same
 *  mechanism. Twelve authored space-run sites are accepted content (the owner's call: the `·` and
 *  `──` separators stay legible when they tighten, and Court's shipping rules lines are not worth
 *  restructuring for a few px of indent). Warning on them would print twelve lines every time a dev
 *  hot-reloads a shipping game's scene, or runs `/api/validate-scene` / `modoki_validate_scene`
 *  against it — never a production runtime load, but still a noisy check that gets muted and takes
 *  the useful half with it. The space-run rule is enforced at the GATE instead, by the corpus guard
 *  in `engine/tests/assets/uiAuthoredValues.test.ts`, where an exemption can carry a written reason.
 *  Newlines get no exemptions and are expected to stay at zero, so they can afford to be loud.
 *
 *  Conservative by construction: it skips any entity whose text takes a genuine `pre-wrap` path
 *  (`autoFitText`, or the `TextAnimation` trait), because there the newline is honoured and
 *  authoring one is correct. Skipping a real case is the right failure direction for a new warning
 *  — a false positive on legitimate multi-line text is worse than a miss, since it teaches the
 *  reader to ignore the message. */
export function collapsedNewlineWarnings(traits: unknown, label: string): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  const bag = traits as Record<string, unknown>;
  const uel = bag.UIElement;
  if (!uel || typeof uel !== 'object') return out;
  const el = uel as Record<string, unknown>;
  const text = el.text;
  if (typeof text !== 'string' || !text.includes('\n')) return out;
  // The two ways an entity reaches a `pre-wrap` span instead of the plain path. `maxLines` is
  // deliberately NOT here — it clamps height, not whitespace (see docblock above).
  if (el.autoFitText === true) return out;
  if (bag.TextAnimation) return out;
  const lines = text.split('\n').length;
  out.push(
    `${label}.UIElement.text authors ${lines} lines, but the DOM collapses newlines on this path `
    + `— it will render as one run-on paragraph. Split it into sibling text elements in a column `
    + `with an authored gap (docs/ui-system.md § spacing is layout); do not add white-space, and `
    + `note textContent still reports the newlines, so only the render differs`,
  );
  return out;
}

/** One use of a prefab as a `UIEntries` entry KIND, resolved from a scene.
 *
 *  This edge is the thing nothing recorded (#671). It exists in the scene — `UIEntries.prefabs`
 *  is a JSON bank of `{name, prefab: <guid>}` — but until now it was read only by the runtime
 *  spawner, the resource collector and the build tree-shaker. No AUTHORING surface resolved it,
 *  which is why an author could open an entry prefab, set a margin, and get no signal that the
 *  scroll view overwrites it on the next tick. */
export interface EntryKindUse {
  /** The `UIEntries` view entity, as a reader-actionable label. */
  viewLabel: string;
  /** The kind name game code uses to ask for this prefab. */
  kindName: string;
  /** The entry prefab's asset GUID. */
  prefabGuid: string;
  /** Does the view DELEGATE this axis to the prefab root's own `UIElement`?
   *
   *  `entryWidth`/`entryHeight` of 0 means "read it from the prefab" (and 0 is the trait default,
   *  so an absent field means exactly that — a save strips a field equal to its default). The
   *  distinction matters: on a delegated axis the prefab root's size is genuinely READ, so
   *  warning that it is overwritten would be a lie. On a non-delegated axis it is discarded. */
  delegatesWidth: boolean;
  delegatesHeight: boolean;
}

/** Resolve every view -> entry-prefab edge in a scene. Pure; no I/O.
 *
 *  ⚠️ **Only kind `[0]` of the bank — this is deliberate, not a truncation bug.**
 *  `entriesSystem.ts`'s `driveView` reads `kinds[0]` for `prefabRootSize`, `ensurePool` and
 *  `applySlots` (never any other index), so kinds `[1..]` are parsed but never actually spawned as
 *  a pooled row. Emitting a use per kind, the way this used to, would have every kind past the
 *  first claim its root is pinned every tick when the runtime never touches it at all — a false
 *  claim for a prefab that is only ever kind `[1]` of a bank. */
export function collectEntryKindUses(
  entities: readonly unknown[],
  labelOf: (entity: unknown, idx: number) => string,
): EntryKindUse[] {
  const out: EntryKindUse[] = [];
  entities.forEach((raw, idx) => {
    const traits = (raw as { traits?: unknown } | null)?.traits;
    if (!traits || typeof traits !== 'object') return;
    const en = (traits as Record<string, unknown>).UIEntries;
    // A tag trait serializes as `true`; only a field object can carry a bank.
    if (!en || typeof en !== 'object') return;
    const enObj = en as Record<string, unknown>;
    const bank = enObj.prefabs;
    if (typeof bank !== 'string' || !bank) return;
    const delegates = (field: string): boolean => {
      const v = enObj[field];
      return v === undefined || v === 0;
    };
    const delegatesWidth = delegates('entryWidth');
    const delegatesHeight = delegates('entryHeight');
    const kind = parseEntryPrefabs(bank)[0];
    if (!kind) return;
    out.push({
      viewLabel: labelOf(raw, idx), kindName: kind.name, prefabGuid: kind.prefab,
      delegatesWidth, delegatesHeight,
    });
  });
  return out;
}

/** Integrity of the `UIEntries.prefabs` bank itself, for ONE entity's trait bag.
 *
 *  `REF_FIELDS_BY_TRAIT` is scalar-only and correctly excludes a JSON-string bank, so this is the
 *  explicit parse the same way `Animator.clips` and `AudioSource.clips` are handled elsewhere.
 *
 *  ⚠️ Scope, stated because the obvious wider claim is wrong: the resource manifest
 *  (`loadSceneFile.ts`) and the build tree-shaker (`plugins/asset-tree-shaker.ts`) BOTH already
 *  read this bank, so an entry prefab is not an #53 "ref the build cannot see". What was missing
 *  is only the validator — `parseEntryPrefabs` drops a malformed entry silently, and a dangling
 *  GUID surfaces only as a pool that never spawns. */
export function entryBankWarnings(
  traits: unknown, label: string, assetExists?: AssetRefResolver,
): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  const en = (traits as Record<string, unknown>).UIEntries;
  if (!en || typeof en !== 'object') return out;
  const bank = (en as Record<string, unknown>).prefabs;
  if (bank === undefined || bank === '') return out;
  if (typeof bank !== 'string') {
    out.push(`${label}.UIEntries.prefabs must be a JSON string, got ${typeof bank}`);
    return out;
  }
  let raw: unknown;
  try { raw = JSON.parse(bank); } catch {
    out.push(`${label}.UIEntries.prefabs is not valid JSON — the whole entry bank is dropped, so the view spawns nothing`);
    return out;
  }
  if (!Array.isArray(raw)) {
    out.push(`${label}.UIEntries.prefabs must be a JSON ARRAY of {name, prefab} — the whole entry bank is dropped, so the view spawns nothing`);
    return out;
  }
  raw.forEach((item, i) => {
    const at = `${label}.UIEntries.prefabs[${i}]`;
    if (!item || typeof item !== 'object') { out.push(`${at} is not an object and is silently dropped`); return; }
    const { name, prefab } = item as { name?: unknown; prefab?: unknown };
    if (typeof name !== 'string' || !name) out.push(`${at}.name is missing or empty — the kind is silently dropped`);
    if (typeof prefab !== 'string' || !prefab) { out.push(`${at}.prefab is missing or empty — the kind is silently dropped`); return; }
    if (!isGuid(prefab)) {
      out.push(`${at}.prefab must be a prefab GUID, got '${prefab}'${isInternalAssetPath(prefab) ? ' (an asset PATH — use the prefab\'s GUID)' : ''}`);
      return;
    }
    // ⚠️ Branch on the VERDICT, never on truthiness. `AssetRefResolver` returns
    // `'ok' | 'missing' | 'case-mismatch'` — three non-empty strings, so `!assetExists(prefab)`
    // is false for every possible answer and the check silently never fires. This arm was
    // written that way first and was dead code; it is the repo's dominant defect shape (a
    // mechanism that cannot fire), caught only because the tests asked for the negative case.
    if (assetExists) {
      const verdict = assetExists(prefab);
      if (verdict === 'missing') {
        out.push(
          `${at}.prefab: '${prefab}' is a well-formed GUID but no asset in the manifest has it `
          + `— the entry prefab was deleted or never imported, so this kind's pool never spawns`,
        );
      } else if (verdict === 'case-mismatch') {
        out.push(
          `${at}.prefab: '${prefab}' matches a manifest asset only when letter case is ignored `
          + `— asset refs resolve through a case-SENSITIVE lookup, so this kind's pool never spawns. `
          + `Re-author the ref with the manifest's exact casing (guids are minted lowercase).`,
        );
      }
    }
  });
  return out;
}

/** Warnings for an entry PREFAB's root `UIElement` — the authoring-time half of #671.
 *
 *  `entriesSystem` pins 14 `UIElement` fields onto every pooled row root each tick
 *  (`buildPooledRowPin`), so those authored fields are discarded. The runtime warns about this
 *  since #761, but only on a LIVE pooled instance: the `UIEntry` trait that gates the Inspector's
 *  note is stamped at spawn and is `runtimeOnly`, so it exists in no `.prefab.json`. Open the
 *  entry prefab — the asset you actually author in — and there was no signal at all.
 *
 *  ⚠️ **The size fields are conditional, and that condition is the whole reason this needs the
 *  edge rather than a per-prefab rule.** On an axis the view DELEGATES (`entryWidth`/`entryHeight`
 *  of 0), `entryPrefabProvider.rootSize` genuinely reads the prefab root's `width`/`height` — that
 *  IS the single-source-of-truth path the trait docs prescribe — so warning there would tell the
 *  author to stop doing the correct thing. Only a non-delegated axis is discarded.
 *
 *  `isNeutralSize` suppresses `0` and `100%`, which is what nearly every entry prefab root
 *  authors (a full-bleed page); without it this would fire on shipping content that is behaving
 *  exactly as intended.
 *
 *  ⚠️ **`v === 0` is a PIN check, not a DEFAULT check, and `flexShrink` is where those two split.**
 *  All nine `POOLED_ROW_GENERIC_WARN_FIELDS` are pinned to `0` (`POOLED_ROW_PINNED_GROUPS`'
 *  `forcedTo`), and for eight of them `0` is also the trait default — but `UIElement.ts`'s own
 *  `flexShrink` default is `1`, so an untouched entry prefab root commonly authors `flexShrink: 1`
 *  (the Inspector's own default) and `v === 0` alone never suppresses it. `entriesSystem.ts`'s
 *  runtime twin (`pooledFieldNeedsWarning`) already checks against the field's default for exactly
 *  this reason; here that default is read off the live `schema` (the same `SceneSchema` every
 *  other type-check in this module is BYOD-optional on) rather than re-typed as a second table —
 *  without a schema (no browser connected) this degrades to the pin-only check, same as always. */
export function entryPrefabRootWarnings(
  use: EntryKindUse, rootTraits: unknown, label: string, schema?: SceneSchema,
): string[] {
  const out: string[] = [];
  if (!rootTraits || typeof rootTraits !== 'object') return out;
  const uel = (rootTraits as Record<string, unknown>).UIElement;
  if (!uel || typeof uel !== 'object') return out;
  const el = uel as Record<string, unknown>;
  const via = `used as entry kind '${use.kindName}' by ${use.viewLabel}`;

  // The nine always-discarded fields (margins, min/max, flexShrink), derived from the same
  // constant the pin itself iterates — never a second hand-typed list (#761/#764).
  for (const field of POOLED_ROW_GENERIC_WARN_FIELDS) {
    const v = el[field];
    if (typeof v !== 'number' || v === 0) continue;
    // A value equal to the trait's OWN default (see docblock above) is never "authored" in any
    // sense worth warning about — the author never touched it. `flexShrink`'s default (1) is the
    // one case this matters for today; every other generic field's default is already 0 and is
    // caught by the `v === 0` check above.
    const fieldDefault = schema?.traits?.UIElement?.fields?.[field]?.default;
    if (fieldDefault !== undefined && v === fieldDefault) continue;
    const group = POOLED_ROW_PINNED_GROUPS.find((g) => g.fields.includes(field));
    out.push(
      `${label}.UIElement.${field} is inert: this prefab is ${via}, and a pooled row root has its `
      + `${group?.label ?? field} pinned to ${group?.forcedTo ?? '0'} every tick — the authored `
      + `${v} is discarded`,
    );
  }

  // `isVisible` is pinned to whether the slot is live, so an authored `false` is the case that
  // visibly reverts — #761 called it the most legible of the fourteen to a human.
  if (el.isVisible === false) {
    out.push(
      `${label}.UIElement.isVisible is inert: this prefab is ${via}, and a pooled row root's `
      + `visibility is pinned to whether its slot is live every tick`,
    );
  }

  // Size: discarded ONLY on an axis the view does not delegate.
  for (const axis of ['width', 'height'] as const) {
    const delegated = axis === 'width' ? use.delegatesWidth : use.delegatesHeight;
    if (delegated) continue;
    const v = el[axis];
    const unit = el[`${axis}Unit`];
    if (typeof v !== 'number' || isNeutralSize(v, unit)) continue;
    const entryField = axis === 'width' ? 'entryWidth' : 'entryHeight';
    out.push(
      `${label}.UIElement.${axis} is inert: this prefab is ${via}, and that view authors a `
      + `non-zero ${entryField}, so the row's ${axis} comes from the view — the authored `
      + `${v}${unitOrDefault(unit)} is discarded. Set ${entryField} to 0 if you want the view to `
      + `read this prefab's own size instead.`,
    );
  }
  return out;
}

/** Validate an on-disk scene object. `schema` is optional (see module docs);
 *  `getPrefab` is optional (see `PrefabResolver` docs) — omitted, prefab-instance
 *  overrides are simply not checked for the inert-size trap; `assetExists` is optional
 *  (see `AssetRefResolver` docs) — omitted, an asset ref is checked for GUID SHAPE only
 *  and a ref to a deleted asset validates clean. */
export function validateSceneData(
  data: unknown,
  schema?: SceneSchema,
  getPrefab?: PrefabResolver,
  assetExists?: AssetRefResolver,
): ValidationResult {
  const warnings: string[] = [];
  const schemaApplied = !!schema;

  const scene = data as { entities?: unknown };
  if (!scene || typeof scene !== 'object') {
    return { warnings: ['scene is not an object'], schemaApplied };
  }
  if (!Array.isArray(scene.entities)) {
    return { warnings: ['scene.entities is missing or not an array'], schemaApplied };
  }

  scene.entities.forEach((raw, idx) => {
    const entity = raw as SceneEntityLike;
    const label = entityLabel(entity, idx);

    if (entity == null || typeof entity !== 'object') {
      warnings.push(`${label}: entity is not an object`);
      return;
    }
    if (entity.traits == null || typeof entity.traits !== 'object') {
      warnings.push(`${label}: missing or invalid 'traits' object`);
      return;
    }

    for (const [traitName, traitVal] of Object.entries(entity.traits)) {
      const traitSchema = schema?.traits[traitName];
      if (schema && !traitSchema) {
        warnings.push(`${label}: unknown trait '${traitName}'`);
        // Still run ref checks below even for unknown traits.
      }

      // Tag traits serialize as `true`; component/resource as a field object.
      if (typeof traitVal === 'boolean') {
        if (traitSchema && traitSchema.category !== 'tag') {
          warnings.push(`${label}.${traitName}: expected a field object, got boolean (tag) `);
        }
        continue;
      }
      if (traitVal == null || typeof traitVal !== 'object') {
        warnings.push(`${label}.${traitName}: trait value must be an object or boolean`);
        continue;
      }

      const fields = traitVal as Record<string, unknown>;

      // Field-level type checks (only when a schema is available).
      if (traitSchema) {
        for (const [field, value] of Object.entries(fields)) {
          const hint = traitSchema.fields[field];
          if (!hint) {
            warnings.push(`${label}.${traitName}: unknown field '${field}'`);
            continue;
          }
          if (!hint.type) continue; // known field, but no confident type to check
          // EntityAttributes.parentId and PrefabInstance.rootInstanceId are numbers in
          // the live trait schema (the runtime koota-id handle) but are SERIALIZED as a
          // GUID string ('' / the referenced entity's guid — Phase 2, scene-loading.md)
          // or, in a legacy file, a raw numeric id. Don't flag the on-disk guid form.
          if (((traitName === 'EntityAttributes' && field === 'parentId')
              || (traitName === 'PrefabInstance' && field === 'rootInstanceId'))
              && (typeof value === 'string' || typeof value === 'number')) continue;
          const mismatch = typeMismatch(hint.type, value);
          if (mismatch) {
            warnings.push(`${label}.${traitName}.${field}: ${mismatch}`);
          } else if (hint.type === 'enum' && hint.options && typeof value === 'string' && !hint.options.includes(value)) {
            warnings.push(`${label}.${traitName}.${field}: '${value}' not in [${hint.options.join(', ')}]`);
          }
        }
      }

      // Asset-reference rule — delegated to `refFieldWarnings` so the identical rule serves
      // the prefab-instance OVERRIDE groups in the structural pass below (#292). It is a
      // per-TRAIT-BAG predicate, so it is invoked once per entity outside this loop.
      //
      // NOT a pure extraction, in one respect worth knowing: the ref check used to run
      // INSIDE this loop, so an entity's warnings interleaved per trait
      // ([A-schema, A-ref, B-schema, B-ref]); they now group ([A-schema, B-schema,
      // A-ref, B-ref]). Nothing observes that — every `warnings[N]` assertion in the
      // suites is a single-warning scenario, and all three consumers pass or print the
      // array wholesale rather than indexing it — but the order IS different, so do not
      // build an order-dependent assertion on top of it.
    }

    warnings.push(...refFieldWarnings(entity.traits, label, assetExists));
  });

  // ── Structural / referential-integrity pass (schema-independent) — catches the
  //    most common agent-edit mistakes BEFORE a confusing render: duplicate ids,
  //    dangling/self parentId, dangling entity-ref targets, prefab self-reference. (F4)
  const ids = new Set<number>();
  const guids = new Set<string>();
  const dupIds = new Set<number>();
  for (const raw of scene.entities) {
    const e = raw as SceneEntityLike;
    if (e == null || typeof e !== 'object') continue;
    if (typeof e.id === 'number') { if (ids.has(e.id)) dupIds.add(e.id); ids.add(e.id); }
    const g = entAttrs(e)?.guid;
    if (typeof g === 'string' && g) guids.add(g);
  }
  for (const id of dupIds) warnings.push(`duplicate entity id #${id} — ids must be unique`);

  scene.entities.forEach((raw, idx) => {
    const e = raw as SceneEntityLike;
    if (e == null || typeof e !== 'object') return;
    const label = entityLabel(e, idx);
    const attrs = entAttrs(e);
    const ownGuid = typeof attrs?.guid === 'string' ? attrs.guid : undefined;

    // parentId: GUID (current) or numeric file id (legacy); '' / 0 = root.
    const pid = attrs?.parentId;
    if (typeof pid === 'string' && pid !== '') {
      if (pid === ownGuid) warnings.push(`${label}: parentId references itself`);
      else if (!guids.has(pid)) warnings.push(`${label}: parentId '${pid}' references no entity in the scene (orphan/re-root at load)`);
    } else if (typeof pid === 'number' && pid !== 0) {
      if (typeof e.id === 'number' && pid === e.id) warnings.push(`${label}: parentId references itself`);
      else if (!ids.has(pid)) warnings.push(`${label}: parentId #${pid} references no entity in the scene (orphan/re-root at load)`);
    }

    // Entity→entity refs: UIAction.bindings[].target must resolve to a scene guid.
    const ua = e.traits?.UIAction;
    if (ua && typeof ua === 'object') {
      const bindings = (ua as { bindings?: unknown }).bindings;
      if (Array.isArray(bindings)) {
        for (const b of bindings) {
          const t = b && typeof b === 'object' ? (b as { target?: unknown }).target : undefined;
          if (typeof t === 'string' && t !== '' && !guids.has(t)) {
            warnings.push(`${label}.UIAction.target '${t}' references no entity in the scene (dangling)`);
          }
        }
      }
    }

    // UIElement size vs UIAnchor stretch: a stretched axis is sized by its offsets, so
    // an authored width/height on that axis is stored, shown, and never applied. It
    // reads as intentional — games/court's NarrationBand carries width:90% under
    // L=5% R=5% offsets that happen to produce the same 90%, so it looks deliberate and
    // correct. Warn rather than stay silent: the Inspector greys the field out, but
    // someone reading the JSON gets no such signal. Axes are independent.
    warnings.push(...inertLayoutWarnings(e.traits, label));

    // #809 — a lineHeight authored as a multiplier. Per-entity and independent of any anchor,
    // so it sits beside the inert-size check rather than inside it.
    warnings.push(...lineHeightUnitWarnings(e.traits, label));

    // #676 — authored newlines the DOM collapses. Newlines only; the space-run half of the same
    // mechanism is enforced at the gate instead (see this function's docblock).
    warnings.push(...collapsedNewlineWarnings(e.traits, label));

    // #671 — the `UIEntries.prefabs` bank's own integrity. The edge it names is walked once,
    // scene-wide, after this loop.
    warnings.push(...entryBankWarnings(e.traits, label, assetExists));

    // Prefab self-reference: an instance whose source is its OWN guid would recurse.
    const pi = e.traits?.PrefabInstance;
    if (pi && typeof pi === 'object' && ownGuid) {
      const src = (pi as { source?: unknown }).source;
      if (typeof src === 'string' && src === ownGuid) warnings.push(`${label}.PrefabInstance.source references its own entity (self-reference)`);
    }

    // UIElement size vs UIAnchor stretch — the prefab-instance twin of the direct
    // check above (#35). A prefab instance's overridden fields live in the SIBLING
    // `overrides` object (keyed by prefab localId → trait → field), not in `traits`
    // (which for an instance carries only PrefabInstance/EntityAttributes) — so the
    // direct check above never sees an instance's size or anchor. Resolving the
    // prefab needs I/O this module deliberately doesn't do (module docs), so it's
    // BYOD: `getPrefab` is caller-injected and optional; without it this stays silent
    // (a conservative false negative, never a wrong claim).
    if (pi && typeof pi === 'object') {
      const overrides = e.overrides;
      if (overrides && typeof overrides === 'object') {
        const src = (pi as { source?: unknown }).source;
        let prefab: unknown;
        if (typeof src === 'string' && src && getPrefab) {
          try { prefab = getPrefab(src); } catch { prefab = undefined; }
        }
        // Build a localId → traits lookup from the resolved prefab, tolerating any
        // malformed shape by falling back to "unresolved" (no throw).
        let prefabTraitsByLocalId: Map<number, Record<string, unknown>> | undefined;
        try {
          const entities = (prefab as { entities?: unknown } | undefined)?.entities;
          if (Array.isArray(entities)) {
            prefabTraitsByLocalId = new Map();
            for (const pe of entities) {
              const localId = (pe as { localId?: unknown } | null)?.localId;
              const traits = (pe as { traits?: unknown } | null)?.traits;
              if (typeof localId === 'number' && traits && typeof traits === 'object') {
                prefabTraitsByLocalId.set(localId, traits as Record<string, unknown>);
              }
            }
          }
        } catch { prefabTraitsByLocalId = undefined; }

        for (const [localIdKey, traitOverridesRaw] of Object.entries(overrides as Record<string, unknown>)) {
          if (!traitOverridesRaw || typeof traitOverridesRaw !== 'object') continue;
          const traitOverrides = traitOverridesRaw as Record<string, unknown>;

          // #292 — an override group has the same `{trait: {field: value}}` shape as
          // `traits`, and 56 ref fields across `games/` + `demos/` are authored in one, so
          // the ref rule belongs here too. Runs BEFORE the UIElement early-continue below:
          // most override groups touch no UIElement at all, and the ref check must not be
          // hostage to a size check it has nothing to do with.
          warnings.push(...refFieldWarnings(traitOverrides, `${label}.overrides[${localIdKey}]`, assetExists));

          const ovUel = traitOverrides.UIElement;
          const ovUelObj = ovUel && typeof ovUel === 'object' ? (ovUel as Record<string, unknown>) : undefined;
          if (!ovUelObj) continue; // this group doesn't touch UIElement at all
          const ovUan = traitOverrides.UIAnchor;
          const ovUanObj = ovUan && typeof ovUan === 'object' ? (ovUan as Record<string, unknown>) : undefined;

          const prefabTraits = prefabTraitsByLocalId?.get(Number(localIdKey));
          const prefabUel = prefabTraits?.UIElement as Record<string, unknown> | undefined;
          const prefabUan = prefabTraits?.UIAnchor as Record<string, unknown> | undefined;

          const ovAnchorRaw = ovUanObj?.anchor;
          const anchorFromPrefab = typeof ovAnchorRaw !== 'string';
          const anchor = typeof ovAnchorRaw === 'string'
            ? ovAnchorRaw
            : (typeof prefabUan?.anchor === 'string' ? prefabUan.anchor : undefined);
          // ⚠️ NOT `if (typeof anchor !== 'string') continue;` any more — that used to skip the
          // margin mirror below too, for the exact reason the scene-side arm above was gated
          // wrong (#757's fix here): a default ('stretch') anchor mode has no `anchor` key once
          // either the override or its prefab is saved, but `anchorCss.ts` clears margin for it
          // exactly as for any other mode. The size loop still needs the mode STRING, so it
          // alone stays gated on `anchor` being defined.
          if (typeof anchor === 'string') {
            for (const axis of ['width', 'height'] as const) {
              const unitField = `${axis}Unit`;
              // Only consider an axis the OVERRIDE actually touches — a size authored
              // purely inside the prefab is a different (prefab-side) bug, out of scope
              // here, and warning on it would duplicate across every instance.
              if (!(axis in ovUelObj) && !(unitField in ovUelObj)) continue;
              const v = axis in ovUelObj ? ovUelObj[axis] : prefabUel?.[axis];
              const unit = unitField in ovUelObj ? ovUelObj[unitField] : prefabUel?.[unitField];
              if (typeof v === 'number' && !isNeutralSize(v, unit) && isSizeInert(anchor, axis)) {
                const authored = `${v}${unitOrDefault(unit)}`;
                warnings.push(
                  `${label}.overrides[${localIdKey}].UIElement.${axis} is inert: the '${anchor}' anchor `
                  + `${anchorFromPrefab ? `(from its prefab, localId ${localIdKey}) ` : ''}`
                  + `sizes that axis from its ${axis === 'width' ? 'left/right' : 'top/bottom'} offsets, `
                  + `which overwrite the overridden ${authored}`,
                );
              }
            }
          }
          // The margin mirror (#757), same override-only rule: report a margin this OVERRIDE
          // touches, not one authored purely inside the prefab. Mode-independent (this fix):
          // `marginAnchorMode` falls back to 'stretch' — the resolved default — so
          // `isElementMarginInert` sees "anchored at all" rather than "anchor field survived
          // the strip", matching the scene-side arm above.
          //
          // ⚠️ That fallback is only correct once a `UIAnchor` object is known to exist somewhere
          // (the override or its prefab) — an instance with NEITHER carries no anchor at all, is
          // laid out in normal flow, and must stay silent exactly like the un-anchored case
          // always has (`hasAnchorTrait` guards that; `anchor ?? 'stretch'` alone cannot tell the
          // two apart, since a missing string means either "unauthored default" or "no anchor").
          const hasAnchorTrait = !!ovUanObj || !!prefabUan;
          const marginAnchorMode = anchor ?? 'stretch';
          if (hasAnchorTrait && isElementMarginInert(marginAnchorMode)) {
            for (const key of MARGIN_KEYS) {
              const unitField = `${key}Unit`;
              if (!(key in ovUelObj) && !(unitField in ovUelObj)) continue;
              const v = key in ovUelObj ? ovUelObj[key] : prefabUel?.[key];
              if (typeof v !== 'number' || v === 0) continue;
              const unit = unitField in ovUelObj ? ovUelObj[unitField] : prefabUel?.[unitField];
              const authored = `${v}${unitOrDefault(unit)}`;
              warnings.push(
                `${label}.overrides[${localIdKey}].UIElement.${key} is inert: the '${marginAnchorMode}' anchor `
                + `${anchorFromPrefab ? `(from its prefab, localId ${localIdKey}) ` : ''}`
                + `positions this element from its own offsets, which overwrite all four margins — `
                + `the overridden ${authored} is discarded`,
              );
            }
          }
        }
      }
    }
  });

  // ── Entry-kind pass (#671): resolve every `UIEntries` view -> entry-prefab edge and check the
  //    prefab ROOT's authored box against what the pooled-row pin will do to it.
  //
  //    Scene-level rather than per-entity because the edge is a JOIN: the rule about the prefab
  //    root depends on the VIEW's `entryWidth`/`entryHeight`, which lives on a different entity.
  //
  //    BYOD, exactly like the prefab-instance twin above: `getPrefab` is caller-injected and
  //    optional, and without it this stays silent — a conservative false negative rather than a
  //    wrong claim. All three real callers (`agentBridge`'s `modoki_validate_scene` and the two
  //    `editorBackendRouter` routes) do pass one.
  if (getPrefab) {
    // De-dupe: one prefab used by several views, or listed twice in a bank, must not multiply the
    // same warning. Keyed by guid + the delegation flags, because those change what is reported.
    const seen = new Set<string>();
    for (const use of collectEntryKindUses(scene.entities, (e, i) => entityLabel(e as SceneEntityLike, i))) {
      const key = `${use.prefabGuid}:${use.delegatesWidth}:${use.delegatesHeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let prefab: unknown;
      try { prefab = getPrefab(use.prefabGuid); } catch { prefab = undefined; }
      const root = prefabRootTraits(prefab);
      if (!root) continue; // unresolved — the bank check above already reports a dangling GUID
      warnings.push(...entryPrefabRootWarnings(use, root, `entry prefab '${use.prefabGuid}'`, schema));
    }
  }

  return { warnings, schemaApplied };
}

/** The traits bag of a resolved prefab's ROOT entity, or undefined for any malformed shape.
 *
 *  Mirrors `entryPrefabProvider.rootSize`'s own root resolution (`rootLocalId`, falling back to
 *  the first entity) deliberately: if these two disagreed about which entity is the root, the
 *  validator would warn about a different element than the one the runtime pins. */
function prefabRootTraits(prefab: unknown): Record<string, unknown> | undefined {
  const entities = (prefab as { entities?: unknown } | undefined)?.entities;
  if (!Array.isArray(entities) || entities.length === 0) return undefined;
  const rootLocal = (prefab as { rootLocalId?: unknown }).rootLocalId
    ?? (entities[0] as { localId?: unknown } | null)?.localId;
  const root = entities.find((e) => (e as { localId?: unknown } | null)?.localId === rootLocal) ?? entities[0];
  const traits = (root as { traits?: unknown } | null)?.traits;
  return traits && typeof traits === 'object' ? traits as Record<string, unknown> : undefined;
}

/** Read an entity's serialized EntityAttributes object, or undefined. */
function entAttrs(e: SceneEntityLike | undefined): { guid?: unknown; parentId?: unknown } | undefined {
  const a = e?.traits ? (e.traits as { EntityAttributes?: unknown }).EntityAttributes : undefined;
  return a && typeof a === 'object' ? (a as { guid?: unknown; parentId?: unknown }) : undefined;
}

function entityLabel(entity: SceneEntityLike | undefined, idx: number): string {
  const name = entity?.name || (entity?.traits as { EntityAttributes?: { name?: string } } | undefined)?.EntityAttributes?.name;
  const id = entity?.id;
  if (name) return `entity '${name}'${id != null ? ` (#${id})` : ''}`;
  if (id != null) return `entity #${id}`;
  return `entity[${idx}]`;
}

/** Returns a human-readable mismatch message, or null if the value fits the type. */
/** Exported so the scene-mutate PRE-FLIGHT can run the same type check the file-path validator
 *  runs (independent review, 2026-07-30). The live branch — which `canGoLive` made the path almost
 *  every agent edit takes — never called `validateSceneData`, so a field written with the wrong
 *  TYPE came back `{ok:true, changed:1, warnings:[]}` while the file branch warned about it. One
 *  primitive, both branches, so they cannot answer differently about the same op. */
export function typeMismatch(type: FieldType, value: unknown): string | null {
  switch (type) {
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value) ? null : `expected number, got ${describe(value)}`;
    case 'string':
      return typeof value === 'string' ? null : `expected string, got ${describe(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `expected boolean, got ${describe(value)}`;
    case 'enum':
      return typeof value === 'string' ? null : `expected string (enum), got ${describe(value)}`;
    case 'entityRef':
      return typeof value === 'string' ? null : `expected entity GUID string, got ${describe(value)}`;
    case 'bindings': {
      if (!Array.isArray(value)) return `expected binding array, got ${describe(value)}`;
      for (let i = 0; i < value.length; i++) {
        const b = value[i] as Record<string, unknown> | null;
        if (!b || typeof b !== 'object') return `binding[${i}] must be an object`;
        if (b.event !== undefined) {
          if (typeof b.event !== 'string') return `binding[${i}].event must be a string`;
          if (!['click', 'change', 'submit'].includes(b.event)) return `binding[${i}].event "${b.event}" is not one of click/change/submit`;
        }
        if (b.kind !== 'set' && b.kind !== 'call') return `binding[${i}].kind must be 'set' or 'call' (got ${describe(b.kind)})`;
        if (b.kind === 'set') {
          for (const k of ['component', 'property'] as const) {
            if (typeof b[k] !== 'string') return `binding[${i}].${k} must be a string`;
          }
        } else if (b.kind === 'call') {
          if (typeof b.action !== 'string') return `binding[${i}].action must be a string`;
        }
      }
      return null;
    }
    case 'materialOverrides': {
      if (!Array.isArray(value)) return `expected override array, got ${describe(value)}`;
      const KINDS = ['uniform', 'prop', 'texture'];
      const SOURCES = ['constant', 'time', 'store', 'curve'];
      for (let i = 0; i < value.length; i++) {
        const o = value[i] as Record<string, unknown> | null;
        if (!o || typeof o !== 'object') return `override[${i}] must be an object`;
        // `target` may be '' — a freshly-added, not-yet-configured override (the runtime
        // ignores it). Only reject a non-string.
        if (typeof o.target !== 'string') return `override[${i}].target must be a string`;
        if (o.kind !== undefined && !KINDS.includes(o.kind as string)) return `override[${i}].kind must be 'uniform', 'prop', or 'texture'`;
        // A `texture` override (2D extra-sampler swap) has NO source — it carries a static
        // sprite/texture GUID `ref` instead. Validate the ref and skip the source checks.
        if (o.kind === 'texture') {
          if (o.ref !== undefined && typeof o.ref !== 'string') return `override[${i}].ref must be a string (a sprite/texture GUID)`;
          continue;
        }
        const src = o.source as Record<string, unknown> | undefined;
        if (!src || typeof src !== 'object') return `override[${i}].source must be an object`;
        if (!SOURCES.includes(src.type as string)) return `override[${i}].source.type "${describe(src.type)}" is not one of ${SOURCES.join('/')}`;
        // A curve source is authored as JSON — validate its nested shape so a malformed one is
        // caught here instead of throwing every frame in materialInstanceSystem.
        if (src.type === 'curve') {
          if (!Array.isArray(src.points)) return `override[${i}].source (curve) must have a points array`;
          const drv = src.driver as Record<string, unknown> | undefined;
          if (!drv || typeof drv !== 'object') return `override[${i}].source (curve) must have a driver`;
          if (drv.type === 'curve' || !SOURCES.includes(drv.type as string)) return `override[${i}].source.driver.type must be a non-curve source`;
        }
      }
      return null;
    }
    case 'color':
      // Colors are stored as a packed number (0xRRGGBB) or a CSS string (#fff).
      return typeof value === 'number' || typeof value === 'string' ? null : `expected color number or string, got ${describe(value)}`;
    default:
      return null;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate an on-disk `.prefab.json` (#42) — the THIRD and last place the inert-size trap can be
 * authored, and the only one nothing checked.
 *
 * A separate entry point rather than a branch inside `validateSceneData`, because reporting a
 * prefab-authored size from the scene side gets both the FILE and the COUNT wrong — see
 * docs/scene-loading.md (pass 4) for the reasoning and the numbers.
 *
 * Deliberately narrow: this checks the inert-size rule only, not the whole schema. A prefab's
 * traits are already type-checked wherever it is instantiated, so widening this would duplicate
 * that; the gap being closed is specifically the one no caller existed for.
 *
 * Returns warnings — never throws, matching this module's warn-but-load contract. An unparseable
 * or unexpected shape yields no warnings rather than a complaint, because a prefab that fails to
 * PARSE is a different (and much louder) failure that the loader already reports.
 */
export function validatePrefabData(data: unknown): ValidationResult {
  const warnings: string[] = [];
  const entities = (data as { entities?: unknown })?.entities;
  if (!Array.isArray(entities)) return { warnings, schemaApplied: false };
  for (const entry of entities) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { localId?: unknown; name?: unknown; traits?: unknown };
    // Prefab entities are keyed by `localId` (EntityAttributes.parentId inside a prefab addresses
    // localIds, not ECS ids), so that is the address a reader can act on. The name is included
    // when present because it is what they see in the Hierarchy, but the localId is the identity.
    const named = typeof e.name === 'string' && e.name ? ` "${e.name}"` : '';
    const prefabLabel = `entity[localId=${String(e.localId)}]${named}`;
    warnings.push(...inertLayoutWarnings(e.traits, prefabLabel));
    // #809 — a prefab can author a multiplier-shaped lineHeight exactly as a scene can, and the
    // prefab is the harder one to notice: the value renders wherever the prefab is instantiated,
    // not where it is authored.
    warnings.push(...lineHeightUnitWarnings(e.traits, prefabLabel));
    warnings.push(...collapsedNewlineWarnings(e.traits, prefabLabel));
  }
  // schemaApplied stays false: no trait schema is consulted (see above), and claiming otherwise
  // would tell a caller its type checks ran when they did not.
  return { warnings, schemaApplied: false };
}
