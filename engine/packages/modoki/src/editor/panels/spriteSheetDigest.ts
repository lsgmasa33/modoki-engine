/** What a Sprite Editor save would write, as one comparable string — the decision behind "does this
 *  modal hold unsaved edits?" (#1362).
 *
 *  A plain module rather than a closure inside `SpriteEditor.tsx` because it is a DECISION and the
 *  panel is `.tsx` (docs/editor.md § Panels: a panel's decisions live in a `.ts` module beside it,
 *  which is where the unit test goes).
 *
 *  ⚠️ **The guid list is NOT a substitute.** Dragging a slice's edge changes its rect and keeps its
 *  guid, so a guid-only key is identical for an edited sheet — a dirtiness check built on it reports
 *  clean for exactly the edit a human is most likely to have just made, and the move gate would then
 *  destroy it. Everything a save persists per slice goes in here, and the order is normalised so a
 *  re-slice that produces the same set in a different order is not a false positive.
 *
 *  ⚠️ **Unverified, worth knowing:** `rect`/`pivot` are stringified as OBJECTS, so `{x,y,w,h}`
 *  and `{w,h,x,y}` digest differently. Every current path derives both sides from the same loaded
 *  objects and edits them by spread, so I found no way to reach it — but a future code path that
 *  REBUILDS a rect with a different key order would make the modal permanently dirty and block
 *  every move of that texture. Normalise the field order here if that ever happens. */
export interface DigestibleSlice {
  guid: string;
  name?: string;
  rect?: unknown;
  pivot?: unknown;
}

/** The live preview rectangle is not part of the saved document, so it never counts as an edit. */
export const PREVIEW_GUID = '__preview__';

/** The slicing controls the save persists alongside the slices (`spriteGrid`,
 *  `spriteAlphaThreshold`) — sticky import params, editable without ever pressing Slice.
 *
 *  ⚠️ They belong in the digest for the same reason the rects do: a save writes them, so changing
 *  one is unsaved work. Left out, setting Cell W 64 → 32 and walking away read as CLEAN and the move
 *  gate let the edit die with the modal — the same defect as the guid-list check, one field over. */
export interface DigestibleParams {
  grid?: unknown;
  alphaThreshold?: unknown;
}

export function spriteSheetDigest(
  slices: readonly DigestibleSlice[],
  params: DigestibleParams = {},
): string {
  return JSON.stringify({
    s: slices
      .filter((s) => s.guid !== PREVIEW_GUID)
      .map((s) => ({ g: s.guid, n: s.name, r: s.rect, p: s.pivot }))
      .sort((x, y) => (x.g < y.g ? -1 : x.g > y.g ? 1 : 0)),
    g: params.grid ?? null,
    a: params.alphaThreshold ?? null,
  });
}
