/** Shared migration step for the removal of `UIAnchor.zIndex` (SCENE_FORMAT_VERSION 12→13).
 *
 *  `UIAnchor.zIndex` and `UIElement.zIndex` used to write the same CSS `z-index` onto the same
 *  DOM node — `applyAnchorStyle` overwrote the element's value whenever the anchor's was truthy
 *  — so the anchor field only ever shadowed the element field. A truthy anchor value is what
 *  actually rendered, so it wins: copy it onto `UIElement.zIndex` (only when there IS a
 *  `UIElement` trait — an entity with a `UIAnchor` but no `UIElement` is skipped rather than
 *  inventing one), then delete `UIAnchor.zIndex` unconditionally, truthy or not. Idempotent.
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
 *  avoids a cycle: `loadSceneFile.ts` already imports from `meshTemplateCache.ts`. */
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
