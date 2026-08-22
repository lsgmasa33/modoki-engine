import { trait } from 'koota';

/** UIEntries — what a `UIScrollView` shows: a recycled pool of prefab instances.
 *
 *  Named for what an AUTHOR is configuring, not for the mechanism. `UIEntryPool` was the
 *  working name and put an implementation word in the Inspector; the recycling is the engine's
 *  business (owner, 2026-08-21).
 *
 *  An **entry** is one pooled prefab instance — the unit of recycling and the unit the game
 *  fills. It is NOT a "row": in the one-at-a-time case an entry is a whole authored grid (a
 *  page of Court's level selector), which is why none of the vocabulary here says row or list.
 *
 *  ## The three cases are ONE model
 *
 *  The content is a `countX x countY` index space. A vertical strip is `countX: 1`; a
 *  horizontal strip is `countY: 1`; a pager is a strip whose entry fills the viewport
 *  (`entryWidth`/`entryHeight` at `100%`); a 2-D grid has both above 1. They differ in authored
 *  numbers, not in code paths — which is the property that made this worth designing whole.
 *
 *  ## Why the kinds are a JSON STRING and not an array field
 *
 *  `prefabs` holds JSON text, not a `UIEntryPrefab[]`. An array field would have to be an AoS
 *  trait and would land on `traitScalarFields.test.ts`'s allowlist — a guard that exists
 *  because a non-scalar trait field is opaque to serialize, prefab-override diffing and
 *  change-tracking, and must be deep-cloned at every boundary. That guard names a JSON-string
 *  scalar as the sanctioned escape hatch, and the engine already banks refs this way
 *  (`Animator.clips`, `AudioSource.clips`).
 *
 *  It also happens to be the only form that is AUTHORABLE today: `FieldType` has no generic
 *  array-of-objects widget, only the bespoke `bindings` and `materialOverrides` ones — so an
 *  array field would have been a trait field the Inspector could not edit. A string is a text
 *  box. Parse with `parseEntryPrefabs`.
 */
export const UIEntries = trait({
  /** The entry KINDS this view can show, each a name the game uses in code paired with the
   *  prefab GUID the scene authors.
   *
   *  ⚠️ **Named, not GUID'd in code, and that is the single-source-of-truth rule rather than a
   *  convenience.** A GUID written in game code is a ref THE BUILD CANNOT SEE (#53), so the
   *  asset is dropped from a production build and it fails only once shipped — dev serves
   *  everything off disk. So the scene owns the GUID and code names a kind. */
  prefabs: '' as string,

  // ── Authored geometry ──
  /** Entry size. `%` resolves against the viewport, which is how a pager is expressed (100%).
   *  **0 means "read it from the prefab root's own UIElement"**, so a fixed-size entry is not a
   *  second copy of a number the prefab already states. */
  entryWidth: 0,
  entryWidthUnit: 'px' as UIEntryLengthUnit,
  entryHeight: 0,
  entryHeightUnit: 'px' as UIEntryLengthUnit,
  gapX: 0,
  gapY: 0,
  /** Entries kept beyond the viewport per edge, ON TOP of the `visible + 1` floor.
   *
   *  ⚠️ **A fixed value is not enough and 1 visibly fails.** Measured on a Galaxy A23
   *  (2026-08-21): a hard fling traverses up to 4.56 entries between two pool updates, and a
   *  shortfall appears exactly when that traversal exceeds overscan — `overscan: 1` blanked
   *  12/1787 frames, and 3 blanked 74/605. This field is the FLOOR; the system raises it with
   *  measured travel. See `entriesLayout.effectiveOverscan`. */
  overscan: 2,

  // ── Game-written data extent ──
  countX: 0,
  countY: 0,
  /** Bump to say "entry content changed even though the window did not."
   *
   *  ⚠️ Without this the resolver is only called when the window moves, and Court has two live
   *  cases that are not window moves: a level gets solved (the tile face changes, the page does
   *  not), and the async-manifest wedge at `games/court/runtime/systems.ts:9447` where the
   *  ladder length goes 0→N and *"the sig would be IDENTICAL and the gate would skip forever"*.
   *  That bug is already written down as shipped once; a pooled view without an invalidation
   *  surface reproduces it exactly. */
  epoch: 0,
  /** Name of the registered entry source (`registerEntrySource`) that fills an entry. */
  source: '' as string,

  // ── Game-written scroll request, in ENTRY coordinates ──
  /** Scroll so this entry coordinate is at the view's leading edge. **-1 = no request**, the
   *  same sentinel `UIScrollView.scrollTo*` uses; the system converts to px and clears it.
   *
   *  ⚠️ Expressed in ENTRIES, not px, and converted by the SYSTEM on purpose. The system already
   *  resolves entry size — the `%`-of-viewport case, and the `0` = "read it from the prefab"
   *  case — so a px-based API would have to duplicate that resolution and would drift from it.
   *  A caller also usually knows which ENTRY it wants ("open on the player's frontier page"),
   *  not which pixel. */
  scrollToEntryX: -1,
  scrollToEntryY: -1,

  // ── Engine-written window state (read freely; do not author) ──
  firstX: 0,
  firstY: 0,
  visibleX: 0,
  visibleY: 0,
  poolSize: 0,
});

/** One entry KIND: the name game code uses, and the prefab GUID the scene authors. */
export interface UIEntryPrefab {
  name: string;
  /** Prefab asset GUID. Surfaced to the resource collector + build tree-shaker explicitly, so
   *  the build can see it — a ref the build cannot see is dropped from production and fails
   *  only once shipped (#53). */
  prefab: string;
}

/** Parse the `prefabs` JSON bank. Never throws: authored JSON is not trusted input, and a
 *  half-written bank must not take the whole scene down with it. Malformed entries are dropped
 *  rather than guessed at. */
export function parseEntryPrefabs(json: string): UIEntryPrefab[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: UIEntryPrefab[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, prefab } = item as { name?: unknown; prefab?: unknown };
    if (typeof name !== 'string' || !name) continue;
    if (typeof prefab !== 'string' || !prefab) continue;
    out.push({ name, prefab });
  }
  return out;
}

export type UIEntryLengthUnit = 'px' | '%';
