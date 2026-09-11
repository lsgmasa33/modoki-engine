/** The label a dropdown trigger shows while some of its options are on: it NAMES them rather than
 *  counting them. Shared by the SceneView `View ▾` menu (#1003) and the Hierarchy/Assets `Type ▾`
 *  filter (#1021), so the two triggers follow one rule instead of two copies of it.
 *
 *  Why names and not a count: both menus switch on modes that REMOVE content from the surface below
 *  (a collider-only viewport, a filtered tree), and a count cannot say which one is on. `View (1)`
 *  was even the default resting state in 3D, so it read identically with Colliders on or off.
 *
 *  Plain `.ts` so the rule is unit-testable without mounting a menu (docs/editor.md § Panels). */

/** How many names a trigger shows before collapsing the rest into `+N`. Two, by owner decision on
 *  #1021 (2026-09-11), made after a live render at the default 281px column: a named `Type ▾`
 *  moves to the toolbar's second row while a filter is on, and that was accepted as the cost. */
const NAMED_BADGE_MAX_NAMES = 2;

/** `label` when `names` is empty, `label: A` / `label: A, B` for one or two, and `label: A, B +N`
 *  beyond — so at least one name always shows, and the width stays bounded. `names` arrive in the
 *  order they should survive the cap; callers put the one that matters most first. */
export function namedBadgeLabel(label: string, names: readonly string[]): string {
  if (names.length === 0) return label;
  const shown = names.slice(0, NAMED_BADGE_MAX_NAMES).join(', ');
  const rest = names.length - NAMED_BADGE_MAX_NAMES;
  return rest > 0 ? `${label}: ${shown} +${rest}` : `${label}: ${shown}`;
}

/** The `Type ▾` filter's trigger label (#1021).
 *
 *  ⚠️ **A selected type the menu has no row for goes FIRST.** `selected` can outlive the tree it was
 *  picked in — the Assets filter persists globally, across restarts AND projects
 *  (`assetFolderState.ts`, deliberately unscoped per #473) — so it can hold a type that `types`
 *  (what is present now) lacks.
 *  That type still hides rows, and it is the one filter the menu offers no checkbox to untick, so
 *  it is the name the two-name cap must never drop. Present types follow in `types` order, which
 *  the caller passes as the order the dropdown LISTS them (grouped by category in Hierarchy).
 *
 *  Names are capitalised the way the menu's rows show them (`textTransform: capitalize`), so the
 *  badge and the checkbox read as the same word. */
export function typeFilterBadgeLabel(
  label: string,
  types: readonly (readonly [string, number])[],
  selected: ReadonlySet<string>,
): string {
  const present = new Set(types.map(([t]) => t));
  const orphaned = [...selected].filter((t) => !present.has(t));
  const shown = types.map(([t]) => t).filter((t) => selected.has(t));
  return namedBadgeLabel(label, [...orphaned, ...shown].map(capitaliseType));
}

/** What CSS `text-transform: capitalize` does to a type id, as Chromium renders the menu rows —
 *  uppercase the first letter of each word, where a word starts after ANY character that is not a
 *  letter, a digit, `_` or `'`. Measured in headless Chromium across two close-out reviews (#1021):
 *  `court-level` → `Court-Level` (a real asset type — every `.court.json`), `a.b` → `A.B`, `a/b` →
 *  `A/B`, `sprite_anim` → `Sprite_anim`, `rig2d` → `Rig2d`. Uppercasing only the first character made
 *  the badge read `Court-level` beside a checked `Court-Level` row. Known residue: `ß` uppercases to
 *  `SS` here and stays `ß` in CSS — no type id contains it. */
function capitaliseType(type: string): string {
  return type.replace(/(^|[^\p{L}\p{N}_'])(\p{L})/gu, (_m, sep: string, letter: string) => sep + letter.toUpperCase());
}
