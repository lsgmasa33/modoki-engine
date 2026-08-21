/** scrollViewDom — the DOM half of `UIScrollView`: CSS mapping, the no-dirty scroll
 *  read-back, and one-shot `scrollTo*` requests.
 *
 *  Lives in a `.ts` beside `UINode.tsx` rather than inside it, per the repo's rule that a
 *  panel/component holds JSX while its DECISIONS live in a plain module that a unit test can
 *  import.
 */
import { getCurrentWorld, findEntityByGuid } from '../core/ecs/world';
import { markUIDirty } from '../core/uiDirty';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { NO_SCROLL_REQUEST } from '../traits/UIScrollView';

export interface ScrollViewNodeData {
  axis: string; snap: string; snapStop: string; overscroll: string;
  scrollToX: number; scrollToY: number; scrollBehavior: string;
}

/** CSS for the scroll BOX itself. `UIElement.overflow` is a separate authored field and is
 *  applied by UINode; this only adds what the scroll view owns, so an element that is a scroll
 *  view but was never given `overflow:'scroll'` still does not scroll — which is deliberate:
 *  two fields, one visible consequence, and the one the author already knows wins. */
export function scrollViewStyle(s: ScrollViewNodeData): Record<string, string> {
  const css: Record<string, string> = {};
  css.overscrollBehavior = s.overscroll === 'auto' ? 'auto' : s.overscroll;
  if (s.snap !== 'none') {
    css.scrollSnapType = (s.axis === 'both' ? 'both' : s.axis === 'x' ? 'x' : 'y') + ' mandatory';
  }
  return css;
}

/** CSS for one snap TARGET (an entry). Separate from the box's style because the two live on
 *  different elements, and because `scroll-snap-stop` is a property of the target, not the box. */
export function scrollSnapChildStyle(s: ScrollViewNodeData): Record<string, string> {
  if (s.snap === 'none') return {};
  return { scrollSnapAlign: s.snap, scrollSnapStop: s.snapStop };
}

/** Raw trait write — NO `markUIDirty`.
 *
 *  ⚠️ This is the whole point of the design and is the opposite of every other UI write in the
 *  engine. `entity.set` bypasses the `addDirtyListener(markUIDirty)` hook that `writeTraitField`
 *  goes through (the same bypass hot per-frame game code already relies on), so a scroll event
 *  costs a field write and nothing else. Route this through a dirtying helper and the feature
 *  rebuilds the entire UI tree at fling frequency — the stutter mechanism #251 predicted.
 */
export function writeScrollState(guid: string, state: Partial<{
  scrollX: number; scrollY: number;
  viewportWidth: number; viewportHeight: number; contentWidth: number; contentHeight: number;
}>): boolean {
  const meta = getTraitByName('UIScrollView');
  if (!meta || !guid) return false;
  const world = getCurrentWorld();
  if (!world) return false;
  const entity = findEntityByGuid(guid, world);
  if (!entity || !entity.has(meta.trait)) return false;
  const cur = entity.get(meta.trait) as Record<string, unknown>;
  // Diff before writing: a scroll event that lands on the same rounded pixel is common at the
  // ends of a fling, and a no-op write still costs an archetype touch.
  let changed = false;
  for (const k in state) if (cur[k] !== (state as Record<string, unknown>)[k]) { changed = true; break; }
  if (!changed) return false;
  entity.set(meta.trait, { ...cur, ...state });
  return true;
}

/** Clear a consumed `scrollTo*` request back to the sentinel. Same no-dirty write. */
export function clearScrollRequest(guid: string, axis: 'x' | 'y' | 'both'): void {
  const meta = getTraitByName('UIScrollView');
  if (!meta || !guid) return;
  const world = getCurrentWorld();
  if (!world) return;
  const entity = findEntityByGuid(guid, world);
  if (!entity || !entity.has(meta.trait)) return;
  const cur = entity.get(meta.trait) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (axis !== 'y' && cur.scrollToX !== NO_SCROLL_REQUEST) patch.scrollToX = NO_SCROLL_REQUEST;
  if (axis !== 'x' && cur.scrollToY !== NO_SCROLL_REQUEST) patch.scrollToY = NO_SCROLL_REQUEST;
  if (Object.keys(patch).length === 0) return;
  entity.set(meta.trait, { ...cur, ...patch });
  // ⚠️ This one DOES dirty, unlike its siblings in this file, and the asymmetry is the point.
  //
  // `UINode`'s one-shot effect is keyed on the request VALUES, so a second request for the SAME
  // offset only re-fires if the tree observed the `-1` in between. A raw clear never reaches the
  // tree, and the stale value then compares equal — the request is swallowed, silently.
  //
  // The declarative `ui.scrollTo` path hides this: `bindings.ts` dirties after applying a
  // binding, so the tree happens to see the cleared value before the system converts the next
  // request. A game calling `scrollToEntry()` directly has no such binding and gets no such
  // rescue — so "re-request the same offset" would work from a button and not from code, which
  // is exactly the kind of difference nobody would think to test.
  //
  // Cost is one tree rebuild per CONSUMED request, and a request is user- or game-initiated,
  // never per-frame. The scroll READ-BACK above must stay dirty-free; this is not that.
  markUIDirty();
}

/** What a pending request means for `Element.scrollTo`, or null when nothing is pending.
 *  Pure, so the request semantics (the -1 sentinel, per-axis independence) are unit-testable
 *  without a DOM. */
export function pendingScrollTo(s: ScrollViewNodeData): { left?: number; top?: number; behavior: ScrollBehavior } | null {
  const hasX = s.scrollToX !== NO_SCROLL_REQUEST;
  const hasY = s.scrollToY !== NO_SCROLL_REQUEST;
  if (!hasX && !hasY) return null;
  const out: { left?: number; top?: number; behavior: ScrollBehavior } = {
    behavior: s.scrollBehavior === 'smooth' ? 'smooth' : 'instant',
  };
  if (hasX) out.left = s.scrollToX;
  if (hasY) out.top = s.scrollToY;
  return out;
}
