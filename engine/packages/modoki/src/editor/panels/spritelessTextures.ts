/** Spriteless textures — pure, so the one decision a reader could get wrong is
 *  testable without mounting a panel: WHICH textures does the SpritePicker leave
 *  with nothing to offer?
 *
 *  A freshly imported PNG defaults to `format: 'ktx2-uastc'`, which resolves to
 *  `textureType: '3d'` (`resolveTextureType`, textureSettings.ts). The asset
 *  scanner only auto-emits the whole-image `#default` sprite for a `2d`/`ui`
 *  texture (`engine/plugins/vite-asset-scanner.ts`), so a 3D-typed texture — the
 *  import default — gets NO sprite at all. The picker used to render nothing for
 *  such a texture: not listed among the groups, no hint that anything was wrong.
 *  This module answers "which textures are in that dead end?" so the picker can
 *  surface them instead of staying silent. Kept pure and free of React so it is
 *  testable without mounting a panel — this repo's stated convention.
 *
 *  The list can be LARGE: a 3D-heavy project has 100+ spriteless textures, e.g.
 *  `demos/forest-camp` (130 images, none typed 2d/ui) or `games/court` (~395) —
 *  measured counts, not a guess. That is why the picker's "NO SPRITE YET" section
 *  is collapsed by default and, when expanded, filtered + capped via
 *  `filterSpriteless` below rather than listing every row: an always-expanded list
 *  would bury the sliced-sprite groups the picker exists for. */

import type { AssetEntry } from '../../runtime/loaders/assetManifest';
import type { TextureType } from '../../runtime/loaders/textureSettings';

export interface SpritelessTexture {
  guid: string;
  path: string;
  name: string;
  textureType: TextureType;
}

/** Every texture asset with no sprite entry pointing at it — sorted by name.
 *
 *  `AssetEntry` (the manifest-map shape, as opposed to the raw
 *  `AssetManifestEntry` the scanner persists) carries no `name` field, so
 *  `name` is always the path's basename here — matching `assetDisplayName`'s
 *  fallback for an unnamed entry. */
export function spritelessTextures(assets: AssetEntry[]): SpritelessTexture[] {
  const spriteTextureGuids = new Set<string>();
  for (const a of assets) {
    if (a.type === 'sprite' && a.sprite?.texture) spriteTextureGuids.add(a.sprite.texture);
  }

  const out: SpritelessTexture[] = [];
  for (const a of assets) {
    if (a.type !== 'texture' || !a.guid) continue;
    if (spriteTextureGuids.has(a.guid)) continue;
    const name = a.path.split('/').pop() || a.path;
    out.push({ guid: a.guid, path: a.path, name, textureType: a.textureType ?? '3d' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Filter + cap a spriteless list for display — pulled out of SpritePicker so the
 *  decision (case-insensitive substring match, how many rows to show) is testable
 *  without mounting the panel. A 3D-heavy project has FAR more spriteless textures
 *  than a picker popup can show a row per: `demos/forest-camp` has 130 images and
 *  ZERO typed 2d/ui (all default to 3d), `games/court` ~395, `games/3d-test` ~147 —
 *  measured counts that are the reason this caps rather than lists everything. */
export function filterSpriteless(
  list: SpritelessTexture[],
  query: string,
  cap: number,
): { shown: SpritelessTexture[]; hidden: number } {
  const q = query.trim().toLowerCase();
  const matched = q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  const shown = matched.slice(0, cap);
  return { shown, hidden: matched.length - shown.length };
}
