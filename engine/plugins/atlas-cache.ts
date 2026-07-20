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

/** Bump when the packer/compositor pipeline changes so stale atlas caches invalidate. */
export const ATLAS_ENCODER_VERSION = 'atlas-1';

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

function stableOpts(src: AtlasSource): string {
  return [src.pageSize, src.padding, src.extrude, src.maxPages ?? '', src.texture?.format ?? 'webp',
    src.texture?.maxSize ?? '', src.texture?.mipmaps ?? ''].join('|');
}

/** Stable 16-hex content key for (members' bytes + rects + pack options + version).
 *  Members are sorted by GUID so member-list reordering doesn't change the hash. */
export function atlasHashKey(members: AtlasHashMember[], src: AtlasSource): string {
  const h = createHash('sha256');
  h.update(ATLAS_ENCODER_VERSION).update('\0').update(stableOpts(src)).update('\0');
  for (const m of [...members].sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0))) {
    h.update(m.guid).update('\0')
      .update(`${m.rect.x},${m.rect.y},${m.rect.w},${m.rect.h};${m.pivot.x},${m.pivot.y}`).update('\0')
      .update(m.textureBytes).update('\0');
  }
  return h.digest('hex').slice(0, 16);
}
