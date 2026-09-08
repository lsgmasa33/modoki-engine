/** Shared migration step for the removal of `UIAnchor.zIndex` (SCENE_FORMAT_VERSION 12→13).
 *
 *  `UIAnchor.zIndex` and `UIElement.zIndex` used to write the same CSS `z-index` onto the same
 *  DOM node — `applyAnchorStyle` overwrote the element's value whenever the anchor's was truthy
 *  — so the anchor field only ever shadowed the element field. A truthy anchor value is what
 *  actually rendered, so it wins: carry it onto `UIElement.zIndex`, then delete
 *  `UIAnchor.zIndex` unconditionally, truthy or not. Idempotent.
 *
 *  Factored out into its own zero-dependency module (rather than living inside
 *  `loadSceneFile.ts`'s `migrateV12toV13`) because TWO independent load paths carry a raw
 *  `traits` bag that needs the same fix and nothing else ties them together:
 *   - `loadSceneFile.ts` (scenes, versioned via `SCENE_FORMAT_VERSION`)
 *   - `meshTemplateCache.ts`'s `fetchPrefab` and `editor/scene/prefab.ts`'s `getPrefabSource`
 *     (prefabs — which carry NO migration chain at all; `PREFAB_FORMAT_VERSION` is a
 *     writer-only stamp nothing on the loading path inspects, #365/#379). Applying this
 *     unconditionally on every prefab load (it's cheap and idempotent) is the smallest thing
 *     that closes the same data-loss window a versioned migration closes for scenes.
 *  A dedicated module (versus importing `loadSceneFile.ts` from `meshTemplateCache.ts`) also
 *  avoids a cycle: `loadSceneFile.ts` already imports from `meshTemplateCache.ts`.
 *
 *  ── Structured, not generic-recursive (close-out 2026-09-05, replacing an earlier
 *  `migrateUIAnchorZIndexDeep`) ───────────────────────────────────────────────────────────
 *  A shape-agnostic walker that recurses into every object value and treats any bag carrying
 *  `UIAnchor`/`UIElement` as a trait bag has two real defects: it cannot tell an ENTITY's own
 *  `traits` (a full trait bag — every field a trait can have) from an OVERRIDE bag
 *  (`overrides[localId][TraitName]`/`nestedOverrides[path][localId][TraitName]` — a per-FIELD
 *  DIFF, `prefab.ts`'s `applyOverridesByRootInstance`), and the two need OPPOSITE carrier
 *  policies (see `migrateUIAnchorZIndexInOverrideBag` below) — and it will throw a `RangeError`
 *  on a self-referencing node and walk large `points`/tilemap payloads element-by-element for
 *  no reason, since nothing in them can carry a `UIAnchor` key.
 *
 *  So this walks the known shapes explicitly instead — mirrors
 *  `renameRenderableActiveToVisibleDeep` (`loadSceneFile.ts`'s v8→v9 helper), the precedent this
 *  should have followed from the start. `migrateUIAnchorZIndexStructured` covers exactly: an
 *  entity's own `traits`; `overrides[localId][TraitName]`; `added[]` subtrees (recursively,
 *  including their `children`); `nestedOverrides[path][localId][TraitName]`; and — because it is
 *  called on every row unconditionally, not just non-nested ones — a prefab file's OWN nested
 *  rows (a `PrefabEntity.prefab` reference row carries its own `overrides`/`added`/
 *  `nestedOverrides` in the outer localId space, and those are exactly this same shape). */

/** A per-field override bag, keyed by trait name — the shape found in `overrides[localId]` and
 *  `nestedOverrides[path][localId]`. Unlike a full trait bag, only the traits actually DIFFED
 *  are present. */
type TraitFieldOverrides = Record<string, Record<string, unknown>>;

/** The common shape shared by `SceneEntityEntry`, `PrefabEntity` and `AddedEntity` — every
 *  location a `UIAnchor`/`UIElement` bag can live in a scene or prefab document. All fields
 *  optional and loosely typed so callers can pass their own (narrower or wider) row types
 *  structurally, without an import cycle back to `loadSceneFile.ts`/`prefab.ts`. */
export interface MigratableEntry {
  traits?: Record<string, unknown> | null;
  overrides?: Record<number, TraitFieldOverrides>;
  nestedOverrides?: Record<string, Record<number, TraitFieldOverrides>>;
  /** Structural-override subtrees (`AddedEntity[]`) — each one is itself a `MigratableEntry`
   *  (it carries its own `traits`/`overrides`/`added`/`nestedOverrides` when it's a nested
   *  prefab-reference node) plus a `children` tree for the non-reference case. */
  added?: MigratableEntry[];
  children?: MigratableEntry[];
}

/** Entity-level trait bag migration: `traits['UIAnchor'].zIndex` → `traits['UIElement'].zIndex`.
 *  Carries the value ONLY when there is a sibling `UIElement` trait already — `buildTree`
 *  (`uiTreeStore.ts`) requires `UIElement` for a node to exist in the UI tree at all, so an
 *  entity with `UIAnchor` but no `UIElement` has no rendered value to lose, and fabricating a
 *  `UIElement` trait here would give a non-UI entity a UI trait and change what spawns. Deletes
 *  `UIAnchor.zIndex` unconditionally, truthy or not. Idempotent. */
export function migrateUIAnchorZIndexInTraits(traits: Record<string, unknown> | undefined | null): void {
  if (!traits) return;
  const anchor = traits['UIAnchor'];
  if (!anchor || typeof anchor !== 'object') return;
  const a = anchor as Record<string, unknown>;
  if (!('zIndex' in a)) return;
  const anchorZIndex = a.zIndex;
  if (anchorZIndex) {
    const element = traits['UIElement'];
    if (element && typeof element === 'object') {
      (element as Record<string, unknown>).zIndex = anchorZIndex;
    }
  }
  delete a.zIndex;
}

/** Override-bag migration: `bag['UIAnchor'].zIndex` → `bag['UIElement'].zIndex`, for the shape
 *  found in `overrides[localId]`/`nestedOverrides[path][localId]`. Unlike
 *  {@link migrateUIAnchorZIndexInTraits}, this ALWAYS creates the `UIElement` bag when there is
 *  no sibling one and the anchor value is truthy — never silently drops it.
 *
 *  Why the opposite policy from the trait-bag case: an override/added bag is a per-FIELD DIFF,
 *  not a full trait bag, so "no sibling `UIElement` key" here means "this override doesn't touch
 *  `UIElement` YET", not "this entity has no `UIElement` trait." `applyOverridesByRootInstance`
 *  has an added-trait branch — an override can legitimately ADD a trait to a member that had
 *  none — so the entity this bag applies to may well have (or gain) a `UIElement` trait the bag
 *  simply hasn't mentioned. Dropping the value here (the generic walker's bug, #762 follow-up)
 *  silently loses a real authored z-index with nowhere for it to reappear. */
function migrateUIAnchorZIndexInOverrideBag(bag: TraitFieldOverrides | undefined): void {
  if (!bag) return;
  const anchor = bag['UIAnchor'];
  if (!anchor || typeof anchor !== 'object' || !('zIndex' in anchor)) return;
  const anchorZIndex = (anchor as Record<string, unknown>).zIndex;
  if (anchorZIndex) {
    let element = bag['UIElement'];
    if (!element || typeof element !== 'object') {
      element = {};
      bag['UIElement'] = element;
    }
    element.zIndex = anchorZIndex;
  }
  delete (anchor as Record<string, unknown>).zIndex;
}

/** Runs the override-bag migration over every localId in one `overrides` map (or one
 *  `nestedOverrides[path]` map — same shape one level in). */
function migrateUIAnchorZIndexInOverridesMap(overrides: Record<number, TraitFieldOverrides> | undefined): void {
  if (!overrides) return;
  for (const bag of Object.values(overrides)) migrateUIAnchorZIndexInOverrideBag(bag);
}

/** Structured counterpart of {@link migrateUIAnchorZIndexInTraits} — reaches every location a
 *  `UIAnchor`/`UIElement` bag can live in a scene/prefab row (see the module doc above). Call on
 *  every row of `data.entities`/`prefab.entities` unconditionally — including nested-instance
 *  rows (`pe.prefab` truthy), which is the only place `overrides`/`added`/`nestedOverrides`
 *  actually appear. Idempotent — safe to run on every load. */
export function migrateUIAnchorZIndexStructured(entry: MigratableEntry | null | undefined): void {
  if (!entry) return;
  if (entry.traits) migrateUIAnchorZIndexInTraits(entry.traits);
  migrateUIAnchorZIndexInOverridesMap(entry.overrides);
  if (entry.nestedOverrides) {
    for (const perLocalId of Object.values(entry.nestedOverrides)) migrateUIAnchorZIndexInOverridesMap(perLocalId);
  }
  if (entry.added) for (const child of entry.added) migrateUIAnchorZIndexStructured(child);
  if (entry.children) for (const child of entry.children) migrateUIAnchorZIndexStructured(child);
}
