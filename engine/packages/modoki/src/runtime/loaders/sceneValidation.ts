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
 *  and would reintroduce the 102. */
function isNeutralSize(v: unknown, unit: unknown): boolean {
  return v === 0 || (v === 100 && unit === '%');
}

/**
 * Asset-reference warnings for ONE entity's trait bag — every field in
 * `REF_FIELDS_BY_TRAIT` must be a GUID or an external URL, and (when `assetExists` is
 * injected) that GUID must name an asset the manifest actually has.
 *
 * ONE predicate serves every caller, for the reason `inertSizeWarnings` below gives: a
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
export function inertSizeWarnings(traits: unknown, label: string): string[] {
  const out: string[] = [];
  if (!traits || typeof traits !== 'object') return out;
  const uel = (traits as Record<string, unknown>).UIElement;
  const uan = (traits as Record<string, unknown>).UIAnchor;
  if (!uel || typeof uel !== 'object' || !uan || typeof uan !== 'object') return out;
  const anchor = (uan as { anchor?: unknown }).anchor;
  if (typeof anchor !== 'string') return out;
  for (const axis of ['width', 'height'] as const) {
    const v = (uel as Record<string, unknown>)[axis];
    const unit = (uel as Record<string, unknown>)[`${axis}Unit`];
    if (typeof v === 'number' && !isNeutralSize(v, unit) && isSizeInert(anchor, axis)) {
      // Echo the value WITH its unit — '90%' is what the author sees in the Inspector, so a
      // bare '90' makes them hunt for which field is meant.
      const authored = `${v}${typeof unit === 'string' && unit ? unit : 'px'}`;
      out.push(
        `${label}.UIElement.${axis} is inert: the '${anchor}' anchor sizes that axis from its `
        + `${axis === 'width' ? 'left/right' : 'top/bottom'} offsets, which overwrite the authored ${authored}`,
      );
    }
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
    warnings.push(...inertSizeWarnings(e.traits, label));

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
          if (typeof anchor !== 'string') continue;

          for (const axis of ['width', 'height'] as const) {
            const unitField = `${axis}Unit`;
            // Only consider an axis the OVERRIDE actually touches — a size authored
            // purely inside the prefab is a different (prefab-side) bug, out of scope
            // here, and warning on it would duplicate across every instance.
            if (!(axis in ovUelObj) && !(unitField in ovUelObj)) continue;
            const v = axis in ovUelObj ? ovUelObj[axis] : prefabUel?.[axis];
            const unit = unitField in ovUelObj ? ovUelObj[unitField] : prefabUel?.[unitField];
            if (typeof v === 'number' && !isNeutralSize(v, unit) && isSizeInert(anchor, axis)) {
              const authored = `${v}${typeof unit === 'string' && unit ? unit : 'px'}`;
              warnings.push(
                `${label}.overrides[${localIdKey}].UIElement.${axis} is inert: the '${anchor}' anchor `
                + `${anchorFromPrefab ? `(from its prefab, localId ${localIdKey}) ` : ''}`
                + `sizes that axis from its ${axis === 'width' ? 'left/right' : 'top/bottom'} offsets, `
                + `which overwrite the overridden ${authored}`,
              );
            }
          }
        }
      }
    }
  });

  return { warnings, schemaApplied };
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
    warnings.push(...inertSizeWarnings(e.traits, `entity[localId=${String(e.localId)}]${named}`));
  }
  // schemaApplied stays false: no trait schema is consulted (see above), and claiming otherwise
  // would tell a caller its type checks ran when they did not.
  return { warnings, schemaApplied: false };
}
