/** Content-addressed cache bookkeeping for packed atlas pages.
 *
 *  Atlas page *variant bytes* (WebP/KTX2) are stored in the SAME texture cache as any
 *  other texture (`texture-cache.ts`), keyed on a synthetic per-page url path
 *  `<atlasUrl>~page<N>` — so the page reuses `convertTexture` + `cachePathFor` + the
 *  variant serving path unchanged. This module owns only the atlas-level content hash:
 *  a stable key over every member's source bytes + slice rect + the pack options, so an
 *  edit to any member (re-slice, swap, padding change) re-packs, while an unchanged
 *  atlas is never re-encoded.
 *
 *  Pure-ish Node util (fs only via the caller passing bytes) — no THREE/DOM. */

import { createHash } from 'crypto';
import type { AtlasSource } from '../packages/modoki/src/runtime/loaders/spriteAtlas';
import type { TextureImportSettings } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { textureSettingsKey } from './texture-cache';

/** Bump when the packer/compositor pipeline changes so stale atlas caches invalidate. */
// atlas-2: the pinned toktx (#1327) — evicts atlases an unpinned build converted under the same key.
export const ATLAS_ENCODER_VERSION = 'atlas-2';

/** The synthetic url path a single atlas page is cached/served under. Page variant
 *  bytes live in the texture cache at this key; the served URL appends the variant
 *  suffix (`~page0~webp.webp`). */
export function atlasPageUrlPath(atlasUrlPath: string, pageIndex: number): string {
  return `${atlasUrlPath}~page${pageIndex}`;
}

/** Per-member contribution to the atlas hash. */
export interface AtlasHashMember {
  guid: string;
  /** The member's parent-texture source bytes (deduped by the caller is fine — the
   *  hash includes the rect, so two slices of one texture differ). */
  textureBytes: Buffer;
  rect: { x: number; y: number; w: number; h: number };
  pivot: { x: number; y: number };
}

/** The pack-layout options: every field of the normalized source EXCEPT the ones hashed
 *  some other way — `members` (per member below), `texture` (keyed as the settings the encoder
 *  actually receives), and `id`/`version` (identity, not output). Taken by exclusion rather than
 *  listed, so a pack option added to `readAtlasSource` is keyed without anyone remembering to add
 *  it here (#2065: the list this replaced held three of the ten encoder inputs). */
function packOpts(src: AtlasSource): string {
  const { members: _m, texture: _t, id: _i, version: _v, ...pack } = src;
  return JSON.stringify(Object.keys(pack).sort().map((k) => [k, (pack as Record<string, unknown>)[k]]));
}

/** Stable 16-hex content key for (members' bytes + rects + pack options + page encoder
 *  settings + version). Members are sorted by GUID so member-list reordering doesn't change
 *  the hash.
 *
 *  `pageSettings` is what `reimport-atlas.ts`'s `pageSettings(src)` RETURNS, not the authored
 *  `src.texture` — the encoder is fed the resolved settings plus two build-time rewrites the
 *  authored block never shows (the pageSize-derived `maxSize` floor and the playable WebP
 *  override). Keying the authored block let a playable build reuse a normal build's KTX2 pages
 *  (#2065). It is keyed with the texture cache's own `textureSettingsKey`, the same string each
 *  page's variant hash uses, so the two keys cannot disagree about which settings matter. */
export function atlasHashKey(members: AtlasHashMember[], src: AtlasSource, pageSettings: TextureImportSettings): string {
  const h = createHash('sha256');
  h.update(ATLAS_ENCODER_VERSION).update('\0')
    .update(packOpts(src)).update('\0')
    .update(textureSettingsKey(pageSettings)).update('\0');
  for (const m of [...members].sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0))) {
    h.update(m.guid).update('\0')
      .update(`${m.rect.x},${m.rect.y},${m.rect.w},${m.rect.h};${m.pivot.x},${m.pivot.y}`).update('\0')
      .update(m.textureBytes).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}
