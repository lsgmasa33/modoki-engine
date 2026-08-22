/** Undo the 9-slice editor's LIVE PREVIEW when its modal closes without saving.
 *
 *  `NineSliceEditor` re-registers the texture's auto whole-image sprite on every guide drag so the
 *  scene previews the border as you author it. Nothing used to undo that. Cancel therefore left the
 *  RUNNING manifest holding the discarded border while the meta file and the Inspector both held
 *  the old one — measured on games/3d-test's "Hello Buton": drag l 34 -> 59, Cancel, then touch any
 *  UIElement field and the button re-renders at the 59 geometry (background-size 472.881% = 279/59
 *  instead of 820.588% = 279/34). File says 34, Inspector says 34, screen shows 59, for the rest of
 *  the session. That three-way divergence is what made the whole thing read as "the editor applied
 *  my change but the Inspector didn't update".
 *
 *  Lives here rather than inline in the .tsx so the three branches are testable against the REAL
 *  manifest instead of a mounted component (repo convention: a panel's decisions belong in a plain
 *  .ts beside it). */

import {
  registerSprite, unregisterAsset, getAssetEntry, deriveGuid, isGuid, type SpriteAssetRef,
} from '../../runtime/loaders/assetManifest';

/** The whole-image sprite guid a texture's preview writes to. */
export function wholeImageSpriteGuid(texGuid: string): string {
  return deriveGuid('sprite:' + texGuid);
}

/** Capture the whole-image sprite EXACTLY as it stands, before the first preview overwrites it.
 *  `null` means the manifest has none — which is a real state worth restoring to, not a miss: a
 *  SLICED sheet never gets a whole-image sprite (docs/textures.md), so inventing one on cancel
 *  would leave behind a ref the scanner would never have produced. */
export function captureSpriteSnapshot(texGuid: string): SpriteAssetRef | null {
  return getAssetEntry(wholeImageSpriteGuid(texGuid))?.sprite ?? null;
}

export type RevertOutcome = 'saved' | 'nothing-to-undo' | 'restored' | 'removed';

/** Put the whole-image sprite back the way `captureSpriteSnapshot` found it.
 *
 *  - `saved` — the edit was persisted, so the preview IS the truth; leave it alone.
 *  - `nothing-to-undo` — the preview never ran (snapshot never captured), or the texture guid is
 *    not usable. Touching the manifest here could only invent state.
 *  - `restored` / `removed` — the two real undo paths. */
export function revertSpritePreview(opts: {
  texGuid: string | undefined;
  path: string;
  snapshot: SpriteAssetRef | null | undefined;
  saved: boolean;
}): RevertOutcome {
  if (opts.saved) return 'saved';
  if (opts.snapshot === undefined) return 'nothing-to-undo';
  if (!opts.texGuid || !isGuid(opts.texGuid)) return 'nothing-to-undo';
  const spriteGuid = wholeImageSpriteGuid(opts.texGuid);
  if (opts.snapshot === null) { unregisterAsset(spriteGuid); return 'removed'; }
  registerSprite(spriteGuid, opts.texGuid, opts.path, opts.snapshot);
  return 'restored';
}
