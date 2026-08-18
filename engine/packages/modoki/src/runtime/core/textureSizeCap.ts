/** The active tier's texture-size cap (#212 texture LOD by quality tier) — a tiny L0 module, not
 *  a full provider slot, because both ends of this seam already live in the engine: `rendering/`
 *  (L2, `tierCalibration.applyActiveTierToRuntime`) is the writer and `loaders/` (L3,
 *  `textureResolver.resolveTextureVariantUrl`) is the reader. A provider slot exists for when a
 *  LOWER layer needs a capability only a HIGHER one can supply (see `playerTierStore.ts`); here
 *  L3 reading L0 and L2 writing L0 are both already-legal downward edges, so a slot would just be
 *  ceremony.
 *
 *  Lives here rather than being a plain import from `rendering/qualityTier.ts` on purpose:
 *  `textureResolver.ts` documents (see its own header) the house discipline of never adding a
 *  STATIC edge from `runtime/loaders` to `runtime/rendering`, even though L3→L2 is a legal
 *  downward edge — the KTX2 caps probe already dodges this with a dynamic import, and statically
 *  importing `getActiveTierOverrides` (from the rendering-layer settings module) here would be
 *  the same mistake with no dynamic-import excuse (this read has no async story to hide behind).
 *  An L0 module keeps `loaders` and `rendering` mutually unaware, exactly like `playerTierStore.ts`.
 *
 *  `0` is the shared "no cap" sentinel used everywhere else in this pipeline
 *  (`TierRenderOverrides.textureMaxSize`, `TextureImportSettings.maxSize`'s absence, …) — default
 *  here too, so a headless test / a game that never resolves a tier / a DCE'd build that drops
 *  the rendering module all read "uncapped" for free, with no explicit reset needed. */

let activeCap = 0;

/** Set by `tierCalibration.applyActiveTierToRuntime` from the resolved tier's
 *  `TierRenderOverrides.textureMaxSize`. `0` (or any non-positive value) means "no cap". */
export function setActiveTextureSizeCap(cap: number): void {
  activeCap = cap > 0 ? cap : 0;
}

/** The cap in force, or `0` for uncapped. Read by
 *  `textureResolver.resolveTextureVariantUrl` — never guessed at, only ever this value, so a
 *  resolver call before any tier has resolved behaves exactly as it did before this feature
 *  existed. */
export function getActiveTextureSizeCap(): number {
  return activeCap;
}

/** Test seam / fresh-session reset. Mirrors the shape of `resetTierCalibration` and friends. */
export function resetActiveTextureSizeCap(): void {
  activeCap = 0;
}
