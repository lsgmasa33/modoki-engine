/** Whole-image sprite resolution — pure, so the one decision a reader could get wrong is
 *  testable without mounting a panel: WHEN does a texture actually HAVE a whole-image sprite?
 *
 *  A whole-image sprite is not something the picker can conjure. The asset scanner
 *  (`engine/plugins/vite-asset-scanner.ts`) emits a `#default` whole-image sprite ONLY in
 *  the branch that is mutually exclusive with explicit slices — a texture with
 *  `spriteMode:'multiple'` never gets one. The picker used to render "whole" for every
 *  texture group unconditionally and assign `deriveGuid('sprite:' + texGuid)` regardless,
 *  so on a sliced sheet it committed a GUID with NO manifest entry: a dead ref, no console
 *  error, nothing rendered (QA-INSP-0011, measured on games/sling's 200-slice slime sheet).
 *
 *  So the answer is gated on the whole-image sprite ACTUALLY existing, not on a re-derivation
 *  of the scanner's emit rule. Deriving the rule a second time is exactly how the two would
 *  drift; asking "is it there?" cannot.
 *
 *  Two callers ask it, which is why it lives here rather than in the picker: the picker's
 *  "whole" button, and SkinEditor's drag-drop, which converts a dropped TEXTURE to a sprite ref
 *  the same way and had the same dead-ref bug (found by the close-out sweep). One
 *  implementation, so a future change cannot fix one site and leave the other. */

import type { AssetEntry } from '../../runtime/loaders/assetManifest';
import { deriveGuid } from '../../runtime/core/assetRefRules';

/** The whole-image sprite GUID a 2D/UI texture auto-exposes — must match the
 *  scanner's `deriveGuid('sprite:' + textureGuid)`. Assigning THIS (not the raw
 *  texture GUID) is what keeps 2D refs sprites-only. */
export const wholeImageSpriteGuid = (texGuid: string) => deriveGuid('sprite:' + texGuid);

/** The whole-image sprite ref for a texture, or `undefined` when that texture has none — a
 *  sheet with explicit slices never gets one. `entryOf` is the manifest lookup
 *  (`getAssetEntry`), injected so this stays pure and testable.
 *
 *  A caller must treat `undefined` as "there is nothing to assign" and say so, NOT fall back to
 *  the raw texture guid: 2D refs are sprites-only, and a texture guid in a sprite field is a
 *  different invariant violation rather than a fix. */
export function wholeImageSpriteRef(
  textureGuid: string,
  entryOf: (guid: string) => unknown,
): string | undefined {
  const whole = wholeImageSpriteGuid(textureGuid);
  return entryOf(whole) ? whole : undefined;
}

export interface SpriteTextureGroup {
  /** Every sprite entry that names this texture, in listing order. */
  sprites: AssetEntry[];
  /** The whole-image sprite's GUID, or undefined when the manifest has no such entry —
   *  in which case the "whole" shortcut must not be offered (it would be a dead ref). */
  wholeGuid: string | undefined;
}

/** Group sprite assets by their source texture GUID and resolve each group's
 *  whole-image shortcut. Non-sprite / guid-less / texture-less entries are ignored. */
export function groupSpritesByTexture(assets: AssetEntry[]): Map<string, SpriteTextureGroup> {
  const groups = new Map<string, AssetEntry[]>();
  for (const a of assets) {
    if (a.type !== 'sprite' || !a.sprite || !a.guid) continue;
    const texGuid = a.sprite.texture;
    if (!texGuid) continue;
    const g = groups.get(texGuid);
    if (g) g.push(a); else groups.set(texGuid, [a]);
  }
  const out = new Map<string, SpriteTextureGroup>();
  for (const [texGuid, sprites] of groups) {
    const whole = wholeImageSpriteGuid(texGuid);
    out.set(texGuid, { sprites, wholeGuid: sprites.some((s) => s.guid === whole) ? whole : undefined });
  }
  return out;
}

/** Order the picker's texture groups by DISPLAY NAME — pure, so the ordering rule is
 *  testable without mounting the panel. `nameOf` resolves a texture guid to the label
 *  the picker shows (guid → path → basename); groups whose name will not resolve sort
 *  last, in their existing order, rather than jumping the queue with an empty string.
 *
 *  ⚠️ Why this is not "already sorted". `groupSpritesByTexture` walks `getAllAssets()`,
 *  which returns `guidToEntry` in **Map INSERTION order**. On a full editor reload the
 *  manifest is registered in scan order, which is alphabetical, so the picker LOOKS
 *  sorted and nothing suggests an ordering rule is missing. But a live manifest update
 *  re-registers an existing guid in place and APPENDS a new one — so a texture the user
 *  just imported or converted lands at the very END of a 60-group list, roughly 4000px
 *  below the fold in a 350px popup. Reported from a live editor as "I see it but it's at
 *  the end of list", after first reading as the sprite being missing entirely — the
 *  reload that seemed to "fix" it was really just re-sorting it back into place.
 *
 *  So the picker must not inherit map order: where a texture appears cannot depend on
 *  whether you have reloaded since importing it. */
export function sortGroupsByName<T>(
  groups: Map<string, T>,
  nameOf: (texGuid: string) => string | undefined,
): Array<[string, T]> {
  return [...groups.entries()]
    .map((entry, index) => ({ entry, index, name: nameOf(entry[0]) }))
    .sort((a, b) => {
      if (a.name === undefined && b.name === undefined) return a.index - b.index;
      if (a.name === undefined) return 1;
      if (b.name === undefined) return -1;
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      return byName !== 0 ? byName : a.index - b.index;
    })
    .map((x) => x.entry);
}
