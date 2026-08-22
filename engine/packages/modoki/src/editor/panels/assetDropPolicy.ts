/** Which assets a panel will take from an Assets-panel drag — and how it says no.
 *
 *  ⚠️ **The defect this exists to prevent is accept-then-discard (#306).** A `dragover`
 *  handler that `preventDefault()`s for the `application/editor-asset` MIME type accepts
 *  EVERY asset, because the MIME says nothing about the kind. The drop handler then filters
 *  on the real rule and bails. The user gets a complete "drop here" affordance — copy
 *  cursor, row highlight — followed by no result and no explanation. Two panels shipped
 *  that shape: the Hierarchy (any asset, prefabs only) and the Skin editor's parts list
 *  (any asset, images only).
 *
 *  A refusal has TWO halves and one alone is its own bug:
 *    1. **dragover must not `preventDefault()`** — that is what paints the browser's no-drop
 *       cursor, suppresses the highlight, stops `drop` firing at all, and makes `modoki_dnd`
 *       report an honest `accepted:false` instead of `accepted:true, committed:false` (a
 *       shape `engine/app/debug/domDnd.ts` had to warn about heuristically, because it is
 *       indistinguishable from a drop that legitimately makes no edit).
 *    2. **say why** — via `setDragGhostRefusal`, in the ghost already following the cursor.
 *       A bare 🚫 says "not here" without saying whether you missed the target or picked the
 *       wrong file, so each refusal below names what WOULD work.
 *
 *  **The browser constraint that makes this non-trivial**, and the reason the rule cannot
 *  just be applied to the DataTransfer: **`dataTransfer.getData()` returns `''` during
 *  `dragover`** — the drag data store is in *protected mode* until `drop`, exposing only
 *  `types`. Both panels accepted everything because at decision time they genuinely had
 *  nothing to decide with. The payload comes from `getAssetDragInfo()` instead.
 *
 *  **Each predicate below is the SINGLE copy of its panel's rule** — the dragover and the
 *  drop handler both call it. That matters more than the refusal text: a hand-copied accept
 *  test in the drop handler is exactly how the two drift back apart, and the drift is
 *  invisible (the panel keeps working, it just accepts a little more or less than it acts
 *  on). `dragGhost.acceptMatchesAsset` makes the same point for `data-accept` targets.
 *
 *  Pure and unit-tested on purpose — editor `.ts` logic carries tests, `.tsx` does not
 *  (CLAUDE.md). The panels only wire these into their handlers.
 */

/** What a drop target can know about the in-flight drag at `dragover` time. */
export interface AssetDragInfo {
  /** The manifest asset `type` ('prefab' | 'texture' | 'sprite' | 'mesh' | …), or null when
   *  the payload carried none. */
  type: string | null;
  /** The asset path, for rules that key off an extension rather than a type. */
  path: string;
}

export interface AssetDropDecision {
  /** Call `preventDefault()` on the dragover / let the drop handler act? */
  accept: boolean;
  /** Reason to show in the drag ghost — null when nothing is being refused. */
  refusal: string | null;
}

/** Decide what a drop target should do with the in-flight drag.
 *
 *  `info` comes from `getAssetDragInfo()` (the module-side payload), NOT from the
 *  DataTransfer — see the header. A null `info` during an asset drag means the payload did
 *  not come from this document's Assets panel; refuse it rather than waving it through,
 *  since the drop handler parses the same JSON and would discard it anyway.
 *
 *  Non-asset drags (entity reparent, folder move, an intra-panel reorder) are not this
 *  function's business and come back `accept:true` so the caller's existing branches run
 *  unchanged — the caller has already decided it is looking at an asset drag. */
export function decideAssetDrop(
  isAssetDrag: boolean,
  info: AssetDragInfo | null,
  accepts: (info: AssetDragInfo) => boolean,
  refusal: string,
): AssetDropDecision {
  if (!isAssetDrag) return { accept: true, refusal: null };
  if (info && accepts(info)) return { accept: true, refusal: null };
  return { accept: false, refusal };
}

// ── Hierarchy: prefabs ───────────────────────────────────────────────────────

/** The Hierarchy instantiates PREFABS and nothing else. Every other asset kind is a
 *  *reference* (a mesh, a material, a texture, a clip), not a thing with an entity shape of
 *  its own, so a drop has nothing to create. (Dropping onto the SceneView viewport does
 *  nothing at all — declined on purpose, see `docs/todo.md` § Deferred decisions.) */
export const hierarchyAcceptsAsset = (info: AssetDragInfo): boolean => info.type === 'prefab';

export const HIERARCHY_ASSET_REFUSAL = 'only prefabs can be dropped here';

export function decideHierarchyAssetDrop(
  isAssetDrag: boolean,
  info: AssetDragInfo | null,
): AssetDropDecision {
  return decideAssetDrop(isAssetDrag, info, hierarchyAcceptsAsset, HIERARCHY_ASSET_REFUSAL);
}

// ── Skin editor parts list: images ───────────────────────────────────────────

/** A Skin part's source art is a sprite. A dropped TEXTURE is resolved to its derived
 *  whole-image sprite by the drop handler (`part.sprite` must be a sprite guid, never a raw
 *  texture guid — `assetRefIntegrity` guards it), so both types are accepted here and the
 *  texture→sprite step happens after.
 *
 *  The extension arm catches an image whose manifest `type` is missing or unexpected; it is
 *  the rule the drop handler has always applied, lifted verbatim so the two cannot drift. */
export const skinPartAcceptsAsset = (info: AssetDragInfo): boolean =>
  info.type === 'sprite' || info.type === 'texture' || /\.(png|jpe?g|webp)$/i.test(info.path);

export const SKIN_PART_ASSET_REFUSAL = 'only sprites and textures can be dropped here';

export function decideSkinPartAssetDrop(
  isAssetDrag: boolean,
  info: AssetDragInfo | null,
): AssetDropDecision {
  return decideAssetDrop(isAssetDrag, info, skinPartAcceptsAsset, SKIN_PART_ASSET_REFUSAL);
}
