/** scrollApi — the programmatic half of a scroll view: go to an entry, snap to the nearest one.
 *
 *  Requests are written in ENTRY coordinates onto `UIEntries` and converted to px by
 *  `entriesSystem`, which already resolves entry size (the `%`-of-viewport case and the
 *  `0` = "read it from the prefab" case). A px-based API would duplicate that resolution and
 *  drift from it — and a caller usually knows which ENTRY it wants, not which pixel.
 *
 *  ## Motion vocabulary matches the backend
 *
 *  `behavior` is `'instant' | 'smooth'`, both genuinely wired to the browser's own `scrollTo`.
 *  There is deliberately no `duration`/`easing`: smooth duration is UA-defined and untunable,
 *  and an authored field that moves nothing is a lie with a tooltip. They arrive together with
 *  the owned-physics backend, wired on arrival.
 */
import { getTraitByName } from '../core/ecs/traitRegistry';
import { getCurrentWorld, findEntityByGuid } from '../core/ecs/world';
import type { UIScrollBehavior } from '../traits/UIScrollView';

/** Sentinel shared with the trait defaults: "no request pending". */
export const NO_ENTRY_REQUEST = -1;

function viewOf(viewGuid: string) {
  const enMeta = getTraitByName('UIEntries');
  const svMeta = getTraitByName('UIScrollView');
  if (!enMeta || !svMeta || !viewGuid) return null;
  const world = getCurrentWorld();
  if (!world) return null;
  const entity = findEntityByGuid(viewGuid, world);
  if (!entity || !entity.has(enMeta.trait) || !entity.has(svMeta.trait)) return null;
  return { entity, enMeta, svMeta };
}

/** Scroll so entry (x, y) sits at the view's leading edge.
 *
 *  Either axis may be omitted — a vertical list only ever wants `y`, and requesting an axis the
 *  view does not scroll would fight the browser's own clamping. Returns false when the guid
 *  names no scroll view, rather than failing silently.
 */
export function scrollToEntry(
  viewGuid: string,
  at: { x?: number; y?: number },
  opts: { behavior?: UIScrollBehavior } = {},
): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  const en = v.entity.get(v.enMeta.trait) as Record<string, unknown>;
  v.entity.set(v.enMeta.trait, {
    ...en,
    scrollToEntryX: Number.isFinite(at.x) ? Math.max(0, Math.floor(at.x as number)) : NO_ENTRY_REQUEST,
    scrollToEntryY: Number.isFinite(at.y) ? Math.max(0, Math.floor(at.y as number)) : NO_ENTRY_REQUEST,
  });
  const sv = v.entity.get(v.svMeta.trait) as Record<string, unknown>;
  const behavior = opts.behavior ?? 'instant';
  if (sv.scrollBehavior !== behavior) v.entity.set(v.svMeta.trait, { ...sv, scrollBehavior: behavior });
  return true;
}

/** Snap to whichever entry the view is currently nearest.
 *
 *  Reads the LIVE window the system published (`firstX`/`firstY`) rather than recomputing from
 *  `scrollX`/`scrollY`: the system already did that arithmetic this frame, and re-deriving it
 *  here would be a second implementation of the same rounding to keep in sync.
 *
 *  ⚠️ `firstX`/`firstY` are the window ORIGIN, which sits `overscan` entries BEFORE the first
 *  visible one. The entry the viewer is actually looking at is the one at the scroll offset, so
 *  this asks for that, not for the pool's leading edge.
 */
export function snapToNearest(viewGuid: string, opts: { behavior?: UIScrollBehavior } = {}): boolean {
  const v = viewOf(viewGuid);
  if (!v) return false;
  const sv = v.entity.get(v.svMeta.trait) as Record<string, number>;
  const en = v.entity.get(v.enMeta.trait) as Record<string, number>;
  const strideY = entryStride(sv.viewportHeight, en.visibleY);
  const strideX = entryStride(sv.viewportWidth, en.visibleX);
  const y = strideY > 0 ? Math.round(sv.scrollY / strideY) : NO_ENTRY_REQUEST;
  const x = strideX > 0 ? Math.round(sv.scrollX / strideX) : NO_ENTRY_REQUEST;
  return scrollToEntry(viewGuid, {
    x: x === NO_ENTRY_REQUEST ? undefined : x,
    y: y === NO_ENTRY_REQUEST ? undefined : y,
  }, opts);
}

/** Recover one entry's stride from the published window: `visible` counts the straddling entry
 *  too (`ceil(viewport / stride) + 1`), so `visible - 1` is the number of strides the viewport
 *  spans. Returns 0 when the view has no usable window yet — a caller then makes no request
 *  rather than dividing by zero into a bogus one. */
function entryStride(viewport: number, visible: number): number {
  if (!viewport || !visible || visible <= 1) return 0;
  return viewport / (visible - 1);
}
