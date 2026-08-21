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
 *  In a 3D project this is essentially the WHOLE texture set, because a GLB's
 *  material maps import as `3d` by definition. Measured off the live manifest
 *  (`/api/rescan-assets`): `demos/forest-camp` 22 of 22 textures — it has no sprite
 *  groups at all — `games/3d-test` 22 of 24, against `games/court` at 1 of 60 (59
 *  explicitly `ui`). ~22 rows already overflow the picker's 350px popup, which is why
 *  the section is collapsed and `filterSpriteless` below caps it.
 *
 *  ⚠️ Count texture ASSETS, not image FILES. `find`-counting `*.png` gave 130/~395/~147
 *  for those same three projects and every figure was wrong — Court has 454 image files
 *  and 60 texture assets. Ask the manifest. */

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
 *  without mounting the panel. The cap exists because a 3D project's spriteless set is
 *  its whole texture set (`demos/forest-camp` 22 of 22, `games/3d-test` 22 of 24), and
 *  ~22 rows already overflow the 350px popup. At those sizes the cap rarely fires — it
 *  is a guard for a larger project, and the FILTER is what makes the list usable. */
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
