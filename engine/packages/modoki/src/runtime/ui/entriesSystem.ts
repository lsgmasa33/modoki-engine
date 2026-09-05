/** entriesSystem — drives a `UIScrollView` + `UIEntries` pool.
 *
 *  Per frame, per view: measure, compute the window, make sure the pool exists, assign each
 *  slot a data coordinate, ask the game what that coordinate says, and write the padding that
 *  puts the pooled block where the data says it belongs.
 *
 *  ## ⚠️ It MUST run at priority >= TRANSFORM (200)
 *
 *  `runPipeline` skips every system below `TRANSFORM` while the sim is not running
 *  (`core/pipeline.ts`), and that covers TIME (0) and GAME (100). A settings list, a pause menu
 *  and a level select are exactly the views you scroll while paused — so a GAME-tier pool would
 *  stop RECYCLING, not merely stop animating: the native DOM scroll keeps moving while entries
 *  go stale or blank. `UIElement` UI still projects while stopped, so the mismatch is invisible
 *  until someone scrolls a paused view. `AUDIO` (250) and `MATERIAL` (260) already sit above
 *  TRANSFORM for exactly this reason; this joins them at `UI_ENTRIES` (270), still below
 *  `PROJECTION` (300) so the tree rebuild sees this frame's writes.
 *
 *  ## ⚠️ It must spawn INSIDE the system tick
 *
 *  `spawnEntity` tags `Transient` only when `inSystemTick()`, and the serializer's transient
 *  skip is what stops a runtime entity reaching a saved scene file. Pool growth therefore lives
 *  here — in a system — and never in a DOM handler or a React effect. This repo has already had
 *  a stray runtime entity persisted into a committed scene; the pool spawns entities by
 *  construction, so this is not a hypothetical.
 *
 *  `driveEntriesFromScroll` is the one DOM-handler entry point, and it does not weaken that
 *  rule — it OPENS a system tick around the same system, the way `runPipeline` does, so a pool
 *  grown from a scroll event is tagged `Transient` exactly as one grown from the pipeline is.
 */
import type { World } from 'koota';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { spawnEntity, destroyEntity, findEntityById, findEntityByGuid, onWorldSwap, getCurrentWorld } from '../core/ecs/world';
import { beginSystemTick, endSystemTick } from '../core/systemTick';
import { parseEntryPrefabs } from '../traits/UIEntries';
import { buildChildIndex } from '../core/ecs/memberPath';
import { getEntrySource, planEntryWrites, type EntryContent } from './entrySource';
import { focusedGuid, retargetFocusedGuid } from './focusManager';
import {
  describeMemberPath, resolveMemberPathSegs, pickRetargetEntry,
  type MemberPathSeg, type ResidentEntry, type StepIdOf,
} from './entriesFocus';
import {
  computeAxisWindow, effectiveOverscan, planSlots, resolveEntrySize, EMPTY_WINDOW,
  type AxisWindow,
} from './entriesLayout';
import { markUIDirty } from '../core/uiDirty';
import { POOLED_ROW_PINNED_FIELDS, POOLED_ROW_GENERIC_WARN_FIELDS, buildPooledRowPin } from './uiAuthoring';

/** How this system reaches prefabs — INJECTED, never imported.
 *
 *  `runtime/ui/` is an L2 subsystem and may import L0 core and L1 traits only; the prefab cache,
 *  the asset manifest and the spawner all live in L3 (`loaders/`). The ESLint layer zone fails
 *  the build on a direct import and says to invert the dependency by registration, which is
 *  exactly what this slot does — and it caught the first cut of this file doing it the wrong
 *  way round. `loaders/entryPrefabProvider.ts` supplies the implementation.
 *
 *  It also buys a testable seam: a test can install a fake provider and drive the whole system
 *  without a prefab cache or an asset manifest. */
export interface EntryPrefabProvider {
  /** The prefab root's authored `UIElement` size, for the `entry{Width,Height} = 0` case. */
  rootSize(prefabGuid: string): { width: number; height: number };
  /** Spawn one instance under `parentId`. Returns the root ecs id, or 0 if it cannot yet (the
   *  prefab is not cached) — the caller then tries again next frame rather than guessing. */
  spawnInstance(world: World, prefabGuid: string, opts: { parentId: number; guidSeed: string }): number;
  /** Is the prefab cached and spawnable RIGHT NOW?
   *
   *  ⚠️ This exists so the system can tell a TRANSIENT miss from a PERMANENT one, which nothing
   *  downstream of `spawnInstance` can (#363). Both look identical — `0` — and the retry is
   *  silent, so a prefab that will never cache is retried every frame forever with no throw, no
   *  warn and no log. That is what #344 cost: Court's pooled level selector rendered an EMPTY
   *  grid while `npm run verify` stayed green at 8,462 tests — every one of them reads the prefab
   *  FILE, and the file was well-formed.
   *
   *  ⚠️ #344 was written up as "a `version: 2` made the loader decline to cache it". **That
   *  mechanism does not exist** — `fetchPrefab` never inspects `version`, and the editor's
   *  serializer writes `2` itself for any prefab with nested-instance rows. So what actually
   *  emptied that grid is still unestablished; this warning is what would have said so at the
   *  time, and deliberately does not repeat the theory.
   *
   *  It must NOT be inferred from `rootSize` returning 0: a prefab root with no authored width or
   *  height is a legitimate answer of 0, so that test cannot tell "uncached" from "unsized". The
   *  provider is the only thing that knows, so it is the thing that gets asked. */
  isCached(prefabGuid: string): boolean;
}

let provider: EntryPrefabProvider | null = null;
export function setEntryPrefabProvider(p: EntryPrefabProvider | null): void { provider = p; }
export function getEntryPrefabProvider(): EntryPrefabProvider | null { return provider; }

/** Reserved name for the engine-owned content child that carries the scroll offset as padding.
 *  Named rather than trait-marked to keep the trait count down; the name is reserved and an
 *  authored entity must not use it. */
export const ENTRIES_CONTENT_NAME = '__uiEntriesContent';

/** Reserved name for one engine-owned ROW inside the content child.
 *
 *  ## Why there is a row layer at all — a flat wrapping content box CANNOT work
 *
 *  The offset is carried as padding, and CSS padding eats the box it sits on: a content child
 *  `width: 100%` with `padding-right: 23040px` has a content box of ZERO, so every entry in it
 *  shrinks to nothing and `flex-wrap` has no line to wrap into. Measured live on the pager and
 *  grid scenes of `games/scroll-demo` (2026-08-21): pages came back 0px wide, and grid tiles
 *  authored at 120px rendered at 36px stacked in a single column. The vertical strip survived
 *  only because vertical padding does not touch the horizontal content box — which is exactly
 *  why one axis shipped looking correct.
 *
 *  A column of auto-width rows fixes it because an auto-width box sizes to `padding + children`
 *  instead of being squeezed by its own padding. Verified in the DOM before it was built:
 *  padLeft 256 + 9 x 128 + padRight 1408 measured `scrollWidth` 2816 with tiles at their full
 *  120px. It also makes `UIElement`'s single `gap` field sufficient — the column's gap is the
 *  Y gap and each row's gap is the X gap — where a wrapping flat box needs two.
 *
 *  The row layer is also what makes the 2-D case honest: wrap would have to break every
 *  `pooled` entries, and the only line width that does that is the POOLED width, which is not
 *  the width the scrollbar needs. */
export const ENTRIES_ROW_NAME = '__uiEntriesRow';

interface ViewState {
  /** False until this view has been driven once. ⚠️ Without it the FIRST update measures travel
   *  against a zeroed origin — a view opened scrolled to entry 99 reports 99 entries of travel
   *  and `effectiveOverscan` inflates the pool to cover it (measured: 8 entries became 204).
   *  A first sighting is not motion. */
  seeded: boolean;
  /** Last window origin, to detect a move and to measure travel for the overscan raise. */
  lastFirstX: number;
  lastFirstY: number;
  lastEpoch: number;
  lastCountX: number;
  lastCountY: number;
  /** Entries the SCROLL has traversed since the last PIPELINE tick — feeds `effectiveOverscan`.
   *
   *  ⚠️ Measured from `scrollX/Y`, never from `first`, and that is not a detail. `first` is
   *  `floor(scroll / stride) - overscan`, so a travel measured on `first` includes the change
   *  in overscan — and overscan is computed FROM travel. The loop that closes is real and was
   *  measured on a Galaxy A23 (2026-08-21): a 20 x 250 grid left completely alone flipped
   *  between a 9x8 and a 13x10 pool forever, re-driving on 102 of 154 frames and holding the
   *  device at ~30fps with no input at all. Scroll is exogenous; `first` is the response.
   *
   *  The baseline moves only on the PIPELINE tick, never on the scroll-event drive. Both paths
   *  then measure the same thing — entries per frame — where an accumulator reset by whichever
   *  drive ran first left the OTHER one reading zero travel and shrinking the window that had
   *  just been grown. Measured in the editor 2026-08-21: the band pinned at 17 rows for every
   *  scroll speed from 8 to 30 entries per frame, because the pipeline tick always ran second.
   *  It is also naturally miss-tolerant: a frame whose update never landed leaves two frames of
   *  travel in the next reading. */
  frameScrollX: number;
  frameScrollY: number;
  /** Last resolved entry size and pooled column count.
   *
   *  ⚠️ These are in the invalidation test, not just here for reading. A `%`-sized entry
   *  resolves against the VIEWPORT, so a window resize (or a device rotation) changes every
   *  padding value while the window ORIGIN stays put — and the cheap `!moved` early-out then
   *  keeps the old geometry forever. Measured live: the pager kept a 640px page size after the
   *  panel settled at 395px, leaving a `contentWidth` 46% too large. `lastCols` matters for the
   *  same reason one step further on — a resize changes which ROW a slot belongs to. */
  lastEntryW: number;
  lastEntryH: number;
  /** Pooled counts per axis. BOTH are in the invalidation test, and the Y one is not symmetry
   *  for its own sake: at `scroll = 0` the origin is CLAMPED to 0, so a travel spike that
   *  raises the overscan and then decays changes `yw.pooled` while `first` never moves. With
   *  only the X count tracked, `moved`/`invalidated`/`poolChanged` are all false and the whole
   *  re-drive is skipped — measured live 2026-08-21 at the top of the 5,000-entry strip, where
   *  the pool went 8 -> 29 rows on a fast scroll and STAYED at 29 through 60 idle frames. */
  lastCols: number;
  lastRows: number;
  /** Consecutive PIPELINE TICKS on which this view's entry prefab was not cached — the counter
   *  behind the "still uncached" warning. Scroll-event drives do not advance it: they are not
   *  frames, and counting them would turn a threshold in frames into a threshold in gestures. */
  uncachedTicks: number;
}
const viewStates = new Map<string, ViewState>();
onWorldSwap(() => { viewStates.clear(); warnedUncached.clear(); warnedOverridden.clear(); });

/** Views already warned about an AUTHORING mistake (see `diagnoseBlankView`), so a per-frame
 *  system does not spam the console.
 *
 *  ⚠️ Cleared by `resetEntriesSystem` only — NOT by the world swap above, unlike `viewStates` and
 *  `warnedUncached`. So a scene swap does not re-warn about a countX/countY or missing-source
 *  mistake within one session. That is a deliberate difference and not an oversight: those two
 *  faults are properties of the AUTHORED trait, which a swap cannot change, whereas whether a
 *  prefab is cached is a property of the loaded scene and is exactly what a swap re-decides. */
const warned = new Set<string>();

/** Views already warned about a permanently-uncached prefab. Deliberately a SEPARATE set from
 *  `warned`: sharing one would let a view that already reported a blank-view authoring mistake
 *  swallow the prefab warning, which is a different fault with a different fix. Unlike `warned`
 *  it is also cleared on a world swap — a scene load is exactly when the answer can change, and
 *  the counter above resets there anyway, so keeping the guard would silence the SECOND
 *  occurrence for good. */
const warnedUncached = new Set<string>();

/** Entity+field pairs already warned about an AUTHORED value the box pin below is about to
 *  overwrite (#651 B1 sibling — margin/min/max on a pooled `UIEntries` root). Keyed on
 *  `${entityId}:${field}` rather than the view, because the fault is per pooled ROOT: the same
 *  view can have some slots authored correctly and others not.
 *
 *  ⚠️ Cleared on a world swap, like `warnedUncached` and unlike `warned`. The reason stated here
 *  used to be "a scene load mints fresh ecs ids, so anything keyed by id is meaningless" — but
 *  this set is NOT keyed by id (see `warnAuthoredOverride`: the key is `viewGuid:slot:field`,
 *  deliberately, because koota recycles ids). The real reason to clear is simpler: the next scene
 *  has different views, so every entry is dead weight that would otherwise grow forever. */
const warnedOverridden = new Set<string>();

/** How many consecutive pipeline ticks a prefab may stay uncached before the system says so.
 *  120 ticks is ~2s at 60fps, and matches the established `Canvas2DMount` precedent for exactly
 *  this shape of diagnostic ("canvas still 0x0 after 120 frames"). It is a WARN, not an error:
 *  a false positive on a very slow load costs one console line, a false negative costs #344. */
const UNCACHED_WARN_TICKS = 120;

/** Reset module state — tests and teardown. */
export function resetEntriesSystem(): void {
  viewStates.clear(); warned.clear(); warnedUncached.clear(); warnedOverridden.clear();
}

/** Say WHY a pooled view is blank when the cause is the PREFAB rather than the authoring.
 *
 *  Returns the tick count to carry forward. See `EntryPrefabProvider.isCached` for why this is
 *  asked of the provider instead of inferred from a zero size or a zero spawn. */
function tickUncachedPrefab(viewGuid: string, prefabGuid: string, isFrameTick: boolean, prior: number): number {
  if (!provider || !isFrameTick) return prior;
  if (provider.isCached(prefabGuid)) return 0;
  const ticks = prior + 1;
  if (ticks >= UNCACHED_WARN_TICKS && !warnedUncached.has(viewGuid)) {
    warnedUncached.add(viewGuid);
    // ⚠️ Names only causes that were VERIFIED against the loader. An earlier draft told the
    // author to check that the prefab's `version` is 1 — inherited from #344's write-up, and
    // wrong: `fetchPrefab` (meshTemplateCache.ts) never inspects `version`, and the editor's own
    // serializer WRITES 2 for a prefab containing nested instances. That advice would have had
    // authors break a legitimate format marker while the real cause went unfound.
    console.warn(`[UIEntries] view ${viewGuid}: entry prefab ${prefabGuid} is STILL not cached after ${UNCACHED_WARN_TICKS} frames, so the pool cannot spawn and the view stays blank. Check, in this order: is that GUID the one the prefab file actually declares as its 'id'; is the prefab reachable from the scene's 'resources' (directly, or through a prefab that is); and did its fetch fail (a 404 or an unparseable file logs '[MeshCache] Failed to load prefab').`);
  }
  return ticks;
}

/** Say WHY a view is blank.
 *
 *  Both of these render nothing and, before this, said nothing — the worst outcome for an
 *  authoring surface, because the author concludes the feature is broken rather than that they
 *  missed a field. Warned once per view per session, not per frame.
 */
function diagnoseBlankView(viewGuid: string, countX: number, countY: number, source: string, hasResolver: boolean): void {
  if (warned.has(viewGuid)) return;
  // A count of 0 on ONE axis while the other has data is always an authoring mistake: the flat
  // index is `y * countX + x`, so it collapses to 0 for every entry. Deliberately warned rather
  // than coerced to 1 — coercing would GUESS which shape was meant, and a genuine "no data yet"
  // state must stay expressible as 0/0.
  if ((countX === 0) !== (countY === 0)) {
    warned.add(viewGuid);
    console.warn(`[UIEntries] view ${viewGuid} has countX=${countX}, countY=${countY} — one axis is 0, so nothing renders. A vertical list wants countX: 1 (and a horizontal one countY: 1).`);
    return;
  }
  if (countX > 0 && countY > 0 && !hasResolver) {
    warned.add(viewGuid);
    console.warn(source
      ? `[UIEntries] view ${viewGuid} names source '${source}', but nothing is registered under that name — every entry is parked and the view renders blank. Register it with registerEntrySource('${source}', …).`
      : `[UIEntries] view ${viewGuid} has no 'source', so nothing can fill its entries and the view renders blank.`);
  }
}

/** The entry prefab's own authored root size, for the `entryWidth/Height = 0` case ("read it
 *  from the prefab"). Returns 0 when the prefab is not cached yet — the caller then has no size
 *  and renders nothing this frame rather than guessing one. */
export function prefabRootSize(prefabGuid: string): { width: number; height: number } {
  return provider?.rootSize(prefabGuid) ?? { width: 0, height: 0 };
}

export function entriesSystem(world: World, opts?: { fromScroll?: boolean }): void {
  const svMeta = getTraitByName('UIScrollView');
  const enMeta = getTraitByName('UIEntries');
  const entryMeta = getTraitByName('UIEntry');
  const uiMeta = getTraitByName('UIElement');
  const attrMeta = getTraitByName('EntityAttributes');
  const renderMeta = getTraitByName('RenderableUI');
  if (!svMeta || !enMeta || !entryMeta || !uiMeta || !attrMeta || !renderMeta) return;

  const views: { id: number; handle: EntityLike }[] = [];
  world.query(svMeta.trait, enMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    const e = entity as EntityLike;
    views.push({ id: e.id(), handle: e });
  });
  if (views.length === 0) return;

  const metas: Metas = { svMeta, enMeta, entryMeta, uiMeta, attrMeta, renderMeta };
  let dirtied = false;
  for (const view of views) {
    // ⚠️ A view nothing can SEE releases its pool instead of being driven. Court's selector took
    // the world from 668 to 1,477 entities on an A23 and gave none of them back on close — see
    // `releaseViewPool`. Checked before `driveView` so a hidden view costs one parent-chain walk
    // per frame rather than a full re-drive, and so the release happens on the frame it is hidden.
    if (!isViewShown(world, view.handle, metas)) {
      if (releaseViewPool(world, view.handle, metas)) {
        // Drop the cached window too, or the rebuilt pool is compared against a `first`/`epoch`
        // from a pool that no longer exists and the first frame back renders un-driven entries.
        const g = (view.handle.get(attrMeta.trait) as { guid?: string } | undefined)?.guid;
        if (g) viewStates.delete(g);
        dirtied = true;
      }
      continue;
    }
    if (driveView(world, view.handle, metas, opts?.fromScroll !== true)) {
      dirtied = true;
    }
  }
  // ONE dirty for the whole frame's worth of views. The scroll READ-BACK never dirties (see
  // scrollViewDom); this does, because content genuinely changed and the projection must
  // re-run — but only when something actually moved.
  if (dirtied) markUIDirty();
}

/** Drive the pool from the DOM scroll event, before the frame paints.
 *
 *  ⚠️ **This exists to remove one frame of latency, and that frame is the difference between
 *  a fast scroll working and going black.** The pipeline path is: DOM scrolls → `scroll` event
 *  writes `scrollX/Y` → the NEXT pipeline tick reads it → the projection rebuilds → paint. So
 *  the pooled band has to cover TWICE the per-frame travel, and the raise is capped at about a
 *  viewport (uncapped, a jump pools the whole data set — see `effectiveOverscan`). Measured in
 *  the editor 2026-08-21 on the 5,000-entry strip: a 13-row / 1560px band survived 600px per
 *  frame and went fully black at 1320px, i.e. at half its own band.
 *
 *  A `scroll` event is dispatched before `requestAnimationFrame` in the same frame, so driving
 *  here lands the new window in the tree the projection is about to rebuild — the same frame
 *  the browser is already painting the new scroll offset in.
 *
 *  It opens a system tick deliberately: the pool SPAWNS, and `spawnEntity` tags `Transient`
 *  only inside one. Without that a pooled entity reaches the saved scene file — the #18 hazard,
 *  and the reason the banner above forbids the naive version of this call.
 *
 *  Cheap when nothing moved: `driveView` early-outs on an unmoved window, which is the common
 *  case for a scroll event that lands inside the current band. */
export function driveEntriesFromScroll(): void {
  const world = getCurrentWorld();
  if (!world) return;
  beginSystemTick();
  try {
    entriesSystem(world, { fromScroll: true });
  } finally {
    endSystemTick();
  }
}

interface EntityLike {
  id(): number;
  has(t: unknown): boolean;
  get(t: unknown): unknown;
  set(t: unknown, v: unknown): void;
  /** ⚠️ `set` does NOT attach a trait the entity lacks — koota silently leaves it absent and the
   *  next `get` returns undefined. A freshly spawned pool instance has no `UIEntry` yet, so it
   *  must be ADDED once and only then written. Caught by the system's own integration test; it
   *  would otherwise have shipped as "the pool spawns but nothing is ever stamped". */
  add(t: unknown): void;
}

// `any` on the trait handles, matching how `uiTreeStore` caches its trait metas: koota's
// generic Trait type does not survive a registry lookup, and threading it through would be
// noise around a lookup that is already dynamic by design.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Metas {
  svMeta: { trait: any }; enMeta: { trait: any }; entryMeta: { trait: any };
  uiMeta: { trait: any }; attrMeta: { trait: any }; renderMeta: { trait: any };
}

function driveView(
  world: World,
  view: EntityLike,
  m: Metas,
  /** True on the once-per-frame pipeline tick, false on the scroll-event drive. It gates ONE
   *  thing: advancing the travel baseline — see ViewState.frameScrollX. */
  isFrameTick: boolean,
): boolean {
  const sv = view.get(m.svMeta.trait) as Record<string, number>;
  const en = view.get(m.enMeta.trait) as Record<string, unknown>;
  const attr = view.get(m.attrMeta.trait) as { guid?: string } | undefined;
  const viewGuid = attr?.guid ?? '';
  if (!viewGuid) return false;

  const kinds = parseEntryPrefabs(en.prefabs as string);
  if (kinds.length === 0) return false;

  const countX = Math.max(0, Math.floor((en.countX as number) ?? 0));
  const countY = Math.max(0, Math.floor((en.countY as number) ?? 0));

  // Entry size. `0` means "read it from the prefab" — the single-source-of-truth rule, so a
  // fixed-size entry is not a second copy of what the prefab root already states.
  const fromPrefab = prefabRootSize(kinds[0].prefab);
  const entryW = resolveEntrySize(en.entryWidth as number, en.entryWidthUnit as 'px' | '%', sv.viewportWidth, fromPrefab.width);
  const entryH = resolveEntrySize(en.entryHeight as number, en.entryHeightUnit as 'px' | '%', sv.viewportHeight, fromPrefab.height);

  // A pending scrollToEntry request, converted here because THIS is where entry size is
  // resolved — the `%`-of-viewport case and the `0` = "read it from the prefab" case both live
  // above. Converting in the API would be a second copy of that resolution.
  // ⚠️ Returns whether it CONVERTED a request, and that answer must reach `markUIDirty`.
  // The px request lands on the trait through a raw `entity.set` (the no-dirty scroll path), so
  // if the window did not also move, nothing rebuilds the UI tree, `UINode`'s one-shot
  // `scrollTo` effect never re-runs, and the request sits on the trait forever. Found by wiring
  // the first real caller of `ui.scrollTo`: `scrollToY` read 480000 while `scrollY` stayed 0.
  const requested = consumeEntryRequest(view, m, en, entryW, entryH);

  // ⚠️ **A JUMP builds this frame's window from the TARGET, not from the scroll we can still
  // observe — and that is the whole fix for "it lands on the wrong page".**
  //
  // The offset is carried as PADDING, so the window and the scroll position are two halves of one
  // statement. Building the window from `sv.scrollX` on the frame a request is converted writes
  // the padding for where the view IS, and the DOM then scrolls to where it was ASKED to go with
  // the wrong content underneath — whereupon `scroll-snap` re-snaps to the nearest entry that
  // actually exists and drags it back. Measured live in Court's level selector (2026-08-21):
  // asking for page 12 landed on 4, page 23 on 6, converging a few pages per attempt because each
  // round could only move the window by its own extent. Suppressing snap in `UINode` while the
  // view moves is the other half of the fix, and on its own it is not enough — it buys time for a
  // walk that should never have been a walk.
  //
  // Writing the padding for the target FIRST means the content is already there when the scroll
  // lands, so there is no mismatch for snap to correct.
  const jumpX = requested?.x;
  const jumpY = requested?.y;
  const windowScrollX = jumpX ?? sv.scrollX;
  const windowScrollY = jumpY ?? sv.scrollY;

  const st = viewStates.get(viewGuid)
    ?? { seeded: false, lastFirstX: 0, lastFirstY: 0, lastEpoch: -1, lastCountX: -1, lastCountY: -1, travel: 0,
         frameScrollX: 0, frameScrollY: 0,
         lastEntryW: -1, lastEntryH: -1, lastCols: -1, lastRows: -1, uncachedTicks: 0 };

  // ⚠️ Runs BEFORE the early-outs below, and that placement is the whole point. A prefab that
  // never caches makes `rootSize` 0, so an authored `entryHeight: 0` ("read it from the prefab")
  // yields stride 0 -> `EMPTY_WINDOW` -> a plan of zero slots, and `ensurePool` is never even
  // asked to spawn. Diagnosing from pool starvation would therefore miss the very case that
  // reads most like "the feature is broken". Asking the provider covers both entrances.
  const uncachedTicks = tickUncachedPrefab(viewGuid, kinds[0].prefab, isFrameTick, st.uncachedTicks);
  const floor = (en.overscan as number) ?? 2;

  // How far the SCROLL has moved since the last pipeline tick, in entries — see
  // ViewState.frameScrollX for why the baseline is per-FRAME and why it must not come from
  // `first`.
  const strideXpx = Math.max(1, entryW + ((en.gapX as number) ?? 0));
  const strideYpx = Math.max(1, entryH + ((en.gapY as number) ?? 0));
  // ⚠️ A jump needs no special case HERE, and one was tried and removed. On the frame a request
  // is converted the scroll has not moved yet, so this is already ~0; the thing that stops a
  // teleport being measured as travel is the BASELINE moving with it (see `frameScrollX` below),
  // which is what a mutation test actually pins. Skipping the measurement on `requested` would
  // additionally suppress a REAL gesture that happened in the same frame as a jump.
  const travel = st.seeded
    ? Math.max(
      Math.abs(sv.scrollX - st.frameScrollX) / strideXpx,
      Math.abs(sv.scrollY - st.frameScrollY) / strideYpx,
    )
    : 0;

  // Cap the travel-driven raise. Without a cap a JUMP (scrollToEntry, a scrollbar drag, a view
  // opened deep in the list) reports thousands of entries of travel and pools every one of them
  // — measured live: a 5,000-entry list went from a 9-entity pool to 5,000.
  //
  // ⚠️ **The cap is three viewports, not one, and the third viewport is not slack.** The window
  // reaches the DOM through event → ECS → projection → React commit, and that chain misses a
  // frame about one time in six: measured in the editor 2026-08-21, 7 of 40 frames of a steady
  // 8-entries-per-frame scroll left the padding exactly where it was, and those frames were
  // 13ms like every other — not a budget problem, a scroll event landing after the pipeline had
  // already run. A one-viewport cap cannot absorb that miss, and the viewport goes BLACK; the
  // owner hit it with a trackpad flick. Driving the pool from the scroll event
  // (`driveEntriesFromScroll`) removed the systematic frame of lag but cannot remove this one.
  // Three, measured rather than picked: on the 5,000-entry strip it clears a steady 15 entries
  // per frame (~108k px/s) with a 29-row band. Five was tried and rejected — 45 rows to buy
  // five more entries per frame, and a 30-per-frame flick still blanked. Covering an unbounded
  // scroll speed with pool size is a losing game; this covers normal wheel and trackpad use.
  const VIEWPORTS_OF_RAISE = 3;
  const capX = Math.max(1, VIEWPORTS_OF_RAISE * Math.ceil(sv.viewportWidth / Math.max(1, entryW + (en.gapX as number))));
  const capY = Math.max(1, VIEWPORTS_OF_RAISE * Math.ceil(sv.viewportHeight / Math.max(1, entryH + (en.gapY as number))));
  const overscanX = effectiveOverscan(floor, travel, capX);
  const overscanY = effectiveOverscan(floor, travel, capY);

  const xw: AxisWindow = countX > 0
    ? computeAxisWindow({ scroll: windowScrollX, viewport: sv.viewportWidth, entrySize: entryW, gap: en.gapX as number, count: countX, overscan: overscanX })
    : EMPTY_WINDOW;
  const yw: AxisWindow = countY > 0
    ? computeAxisWindow({ scroll: windowScrollY, viewport: sv.viewportHeight, entrySize: entryH, gap: en.gapY as number, count: countY, overscan: overscanY })
    : EMPTY_WINDOW;

  const epoch = (en.epoch as number) ?? 0;
  const moved = !st.seeded || xw.first !== st.lastFirstX || yw.first !== st.lastFirstY;
  // ⚠️ Entry size and pooled-column count belong in the invalidation test. A resize moves no
  // window origin, so `moved` stays false and the cheap early-out below would keep a stale
  // padding forever — see ViewState.lastEntryW.
  const resized = entryW !== st.lastEntryW || entryH !== st.lastEntryH
    || xw.pooled !== st.lastCols || yw.pooled !== st.lastRows;
  const invalidated = epoch !== st.lastEpoch || countX !== st.lastCountX || countY !== st.lastCountY || resized;

  viewStates.set(viewGuid, {
    seeded: true,
    lastFirstX: xw.first, lastFirstY: yw.first, lastEpoch: epoch,
    lastCountX: countX, lastCountY: countY,
    // ⚠️ Only the pipeline tick advances the baseline. The scroll-event drive leaves it alone so
    // the tick that follows it in the same frame still sees the frame's real travel.
    // ⚠️ A jump also moves the BASELINE to its target. Leaving it behind makes the very next
    // tick measure the whole teleport as travel and raise the band to its cap for nothing —
    // the same wrong number, one frame later.
    frameScrollX: jumpX ?? (isFrameTick ? sv.scrollX : st.frameScrollX),
    frameScrollY: jumpY ?? (isFrameTick ? sv.scrollY : st.frameScrollY),
    lastEntryW: entryW, lastEntryH: entryH, lastCols: xw.pooled, lastRows: yw.pooled,
    uncachedTicks,
  });

  const content = ensureContentChild(world, view, m);
  if (!content) return false;

  diagnoseBlankView(viewGuid, countX, countY, (en.source as string) ?? '', !!getEntrySource((en.source as string) ?? ''));

  const plan = planSlots(xw, yw, countX, countY);
  const rows = ensureRows(world, content, yw.pooled, m);
  const pool = ensurePool(world, content, viewGuid, kinds[0], plan.length, m);

  // Nothing to re-drive: the window did not move, the data did not change, and the pool is
  // already the right size. This is the cheap path a scroll frame normally takes.
  const poolChanged = pool.grew;
  // A converted request still counts as "this view did something", so the caller dirties the
  // tree — that is what makes `UINode`'s one-shot scrollTo effect re-run at all.
  if (!moved && !invalidated && !poolChanged) return requested !== null;

  // ⚠️ The child index is built HERE — after `ensurePool`, never before. A pool that just grew
  // has brand-new member entities, and an index captured earlier does not contain them: every
  // member path would resolve to nothing and the entries would render empty on exactly the
  // frame they appeared. Caught by this system's integration test.
  const childIndex = buildChildIndex(world);

  // WHERE FOCUS IS SITTING, read BEFORE the slots are re-driven — `applySlots` is what
  // overwrites `UIEntry.x/y`, so afterwards there is no way left to ask which entry the player
  // was on. Costs one `focusedGuid()` read (empty string, an immediate return) in every game
  // that does not use focus nav, which is all of them today.
  const stepIdOf = makeStepIdOf();
  const focusRef = captureFocusedEntry(world, pool.ids, m, childIndex, stepIdOf);

  writeLayout(content, rows, m, xw, yw, en);
  writeWindowState(view, m, xw, yw, plan.length);
  applySlots(world, plan, pool.ids, viewGuid, kinds[0].name, en.source as string, m, childIndex,
    { rows, cols: Math.max(1, xw.pooled), entryW, entryH });
  // ⚠️ The SAME `childIndex` serves both halves, and it is not stale for either. `applySlots`
  // reparents the pooled ROOTS between rows, which changes only the rows' own child buckets —
  // both walks here start AT an entry root and go down, so neither can see that edit. Rebuilding
  // it would be a world scan per re-drive for nothing.
  if (focusRef) retargetFocus(pool.ids, m, childIndex, stepIdOf, focusRef);
  return true;
}

/** Where focus sits inside this view's pool: the ENTRY coordinate, plus the member path within
 *  that entry. Captured before a re-drive so it can be re-pointed after one — see
 *  `entriesFocus.ts` for why focus follows the entry rather than the slot. */
interface FocusRef {
  x: number;
  y: number;
  segs: MemberPathSeg[];
  /** The guid focus was on, so an unchanged target costs no store write. */
  guid: string;
}

/** `PrefabInstance.parentLocalId || localId` for an entity id — the authored, order-independent
 *  key `entriesFocus` addresses members by. 0 when the entity has no `PrefabInstance`. */
function makeStepIdOf(): StepIdOf {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return () => 0;
  return (id: number) => {
    const e = findEntityById(id) as EntityLike | undefined;
    if (!e || !e.has(piMeta.trait)) return 0;
    const pi = e.get(piMeta.trait) as { localId?: number; parentLocalId?: number };
    return (pi.parentLocalId || pi.localId || 0) as number;
  };
}

/** Read focus back to an entry coordinate, or `null` if focus is not inside THIS view's pool.
 *
 *  Returns null for a focused entry that is already PARKED (`live: false`): a parked entry is
 *  hidden, so `uiFocusSystem` has already dropped it as a candidate and re-targeting it would be
 *  answering a question nobody asked. ⚠️ It is therefore NOT repaired while the sim is paused,
 *  when `uiFocusSystem` is not running either — focus set onto parked data by an agent stays
 *  there until play resumes. Deliberate: a parked slot is not a place to put focus, and inventing
 *  a target for a cursor nobody moved is worse than leaving it.
 *
 *  ⚠️ **Walks the parent chain by handle, NOT by inverting the child index.** The index covers
 *  every `EntityAttributes` entity in the world (1,477 in Court's selector), so inverting it
 *  would be a second whole-scene pass on every re-drive of a focused view; the walk is O(depth).
 *  This runs inside the once-per-re-drive path, past `driveView`'s early-out — never per frame. */
function captureFocusedEntry(
  world: World, pool: Map<number, EntityLike>, m: Metas,
  childIndex: Map<number, { id: number; name: string }[]>,
  stepIdOf: StepIdOf,
): FocusRef | null {
  const guid = focusedGuid();
  if (!guid) return null;                       // nothing focused — the universal case today
  const focused = findEntityByGuid(guid, world) as EntityLike | undefined;
  if (!focused || !focused.has(m.attrMeta.trait)) return null;

  const rootsById = new Map<number, EntityLike>();
  for (const [, e] of pool) rootsById.set(e.id(), e);
  if (rootsById.size === 0) return null;

  // Up to the pooled root, collecting the chain on the way. Cycle-guarded on the pool-relative
  // depth rather than the world size — an entry subtree is shallow, and a corrupt `parentId`
  // graph must not spin here.
  const chain: number[] = [];
  let cur: EntityLike | undefined = focused;
  let root: EntityLike | undefined;
  for (let guard = 0; cur && guard < MAX_ENTRY_DEPTH; guard++) {
    const hit = rootsById.get(cur.id());
    if (hit) { root = hit; break; }
    chain.push(cur.id());
    const parentId = (cur.get(m.attrMeta.trait) as { parentId?: number }).parentId ?? 0;
    if (!parentId) break;                       // ran off the top — focus is elsewhere entirely
    cur = findEntityById(parentId) as EntityLike | undefined;
  }
  if (!root || !root.has(m.entryMeta.trait)) return null;

  const entry = root.get(m.entryMeta.trait) as { x: number; y: number; live: boolean };
  if (!entry.live) return null;
  chain.reverse();                              // the walk collected target-first
  const segs = describeMemberPath(childIndex, stepIdOf, root.id(), chain);
  if (!segs) return null;
  return { x: entry.x, y: entry.y, segs, guid };
}

/** How deep inside one pooled entry focus may sit before the walk gives up. An entry is a prefab
 *  a designer authored — Court's page (page > grid > tile > face > label) is five — so this is a
 *  corrupt-graph backstop, not a limit anyone should reach. */
const MAX_ENTRY_DEPTH = 64;

/** Re-point focus at whichever slot now holds the captured entry — or, when that entry is no
 *  longer resident, at the nearest one that is (`pickRetargetEntry`). */
function retargetFocus(
  pool: Map<number, EntityLike>, m: Metas,
  childIndex: Map<number, { id: number; name: string }[]>,
  stepIdOf: StepIdOf,
  ref: FocusRef,
): void {
  const resident: ResidentEntry[] = [];
  for (const [, e] of pool) {
    if (!e.has(m.entryMeta.trait)) continue;
    const en = e.get(m.entryMeta.trait) as { x: number; y: number; live: boolean };
    if (!en.live) continue;                     // a parked slot is not a place to put focus
    resident.push({ x: en.x, y: en.y, rootId: e.id() });
  }
  const pick = pickRetargetEntry({ x: ref.x, y: ref.y }, resident);
  if (!pick) return;                            // nothing resident — leave focus where it is

  const targetId = resolveMemberPathSegs(childIndex, stepIdOf, pick.rootId, ref.segs);
  if (!targetId) return;
  const target = findEntityById(targetId) as EntityLike | undefined;
  if (!target || !target.has(m.attrMeta.trait)) return;
  const guid = (target.get(m.attrMeta.trait) as { guid?: string }).guid;
  // `retargetFocusedGuid`, never `setFocus`: a "confirm" queued for this element is drained by
  // `UIRenderer` AFTER the React commit, and a scroll-event re-drive lands inside that gap — so
  // the queued activation has to move with the focus or it fires on whatever the slot recycled
  // to. See the banner on that function.
  if (guid) retargetFocusedGuid(ref.guid, guid);
}

/** Turn a pending `scrollToEntry*` request into a px `UIScrollView.scrollTo*`, then clear it.
 *
 *  Two traits are involved because they own different things: `UIEntries` speaks entries (it is
 *  what knows how big one is), `UIScrollView` speaks pixels (it is what the DOM consumes). The
 *  hand-off happens once, here, rather than either side learning the other's units. */
function consumeEntryRequest(
  view: EntityLike, m: Metas, en: Record<string, unknown>, entryW: number, entryH: number,
): { x?: number; y?: number } | null {
  const reqX = (en.scrollToEntryX as number) ?? -1;
  const reqY = (en.scrollToEntryY as number) ?? -1;
  if (reqX < 0 && reqY < 0) return null;

  // ⚠️ An axis whose entry size is not known YET must stay pending, not be consumed as 0.
  //
  // Entry size is 0 until the prefab is cached, which is normal for the first frames of a
  // scene — and "open scrolled to the player's frontier page" is issued exactly then. Consuming
  // it early computed `index x 0 = 0`, scrolled to the TOP, and cleared the request, so the
  // view silently opened at the beginning and the ask was gone. That is Court's own use case,
  // which is what makes this worth a guard rather than a comment.
  const strideX = entryW + ((en.gapX as number) ?? 0);
  const strideY = entryH + ((en.gapY as number) ?? 0);
  const canX = reqX < 0 || strideX > 0;
  const canY = reqY < 0 || strideY > 0;
  if (!canX || !canY) return null;    // retry next frame, once the prefab is cached

  const sv = view.get(m.svMeta.trait) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...sv };
  if (reqX >= 0) next.scrollToX = reqX * strideX;
  if (reqY >= 0) next.scrollToY = reqY * strideY;
  view.set(m.svMeta.trait, next);
  // Clear the entry-space request only now that it HAS been handed to the px surface. Leaving
  // it set would re-issue the same scroll every frame and pin the view in place.
  view.set(m.enMeta.trait, { ...en, scrollToEntryX: -1, scrollToEntryY: -1 });
  // ⚠️ **Return the TARGET, because this frame's window must be built for where the view is
  // GOING, not where it still is.** See `driveView`'s use of it.
  return {
    x: reqX >= 0 ? reqX * strideX : undefined,
    y: reqY >= 0 ? reqY * strideY : undefined,
  };
}

/** Find (or spawn) the engine-owned content child. The pooled entries are ITS children, and it
 *  carries the scroll offset as leading/trailing padding.
 *
 *  Why a child rather than padding the scroll box itself: padding-bottom on a scroll container
 *  has a long history of being dropped from the scrollable area, and the device spike validated
 *  the inner-child shape specifically. */
/**
 * Is this view actually being SHOWN — itself and every ancestor?
 *
 * Two different flags, because the engine has two ways to take something off screen and a pooled
 * view must answer to both: `EntityAttributes.isActive` (which cascades) and `UIElement.isVisible`
 * (a per-element hide that keeps the node in the tree). Court's level selector uses the SECOND —
 * `syncLevelSelect` writes `isVisible` on the `LevelSelect` root, an ANCESTOR of the scroll view —
 * so a check on the view's own flags alone would call a closed selector "shown" and never release.
 */
function isViewShown(world: World, view: EntityLike, m: Metas): boolean {
  // ⚠️ **`findEntityById` (O(1) via the world's id index), never a world scan.** This runs for
  // every scroll view on every pipeline tick, BEFORE the moved/invalidated early-out — so it is
  // the one thing here that is unconditionally per-frame. The first cut built a
  // `Map<id, entity>` of every `EntityAttributes` entity per call: on Court's A23 that is 1,477
  // insertions per view per frame to answer a question whose answer is a walk of about four
  // links. Caught in close-out review, not by a test — nothing here would have gone red.
  let cur: EntityLike | undefined = view;
  for (let depth = 0; cur && depth < 64; depth++) {
    const a = cur.get(m.attrMeta.trait) as { parentId?: number; isActive?: boolean } | undefined;
    if (a?.isActive === false) return false;
    const ui = cur.has(m.uiMeta.trait)
      ? cur.get(m.uiMeta.trait) as { isVisible?: boolean } | undefined
      : undefined;
    if (ui?.isVisible === false) return false;
    cur = typeof a?.parentId === 'number' && a.parentId
      ? findEntityById(a.parentId, world) as EntityLike | undefined
      : undefined;
  }
  // ⚠️ Falls through to SHOWN, and that is the safe direction: an undecidable hierarchy (a chain
  // deeper than the bound, or a corrupt one) keeps the pool alive rather than destroying entities
  // the view may still be rendering. Releasing on uncertainty is the expensive mistake.
  return true;
}

/**
 * Destroy this view's whole engine-owned subtree — the content column, its rows, every pooled
 * entry and every member those entries instantiated.
 *
 * ⚠️ **"The pool never shrinks" was never a promise to hold it after the view is HIDDEN.** That
 * rule is about not churning entities mid-scroll, when the device is busiest. Keeping them once
 * nothing can see the view is a different thing, and it was costing real memory during play:
 * measured on a Galaxy A23 (2026-08-22), opening Court's level selector once took the world from
 * 668 entities to 1,477, and CLOSING it released none of them — 809 entities, 55% of the total,
 * carried for the rest of the session behind a screen the player had left. The owner found it by
 * asking why the number was so large.
 *
 * ⚠️ Recursive by hand, because `destroyEntity` destroys exactly ONE entity — it does not cascade.
 * Missing that leaves the pooled members alive with a dead parent, which is worse than not
 * releasing at all: they are unreachable AND still counted.
 */
function releaseViewPool(world: World, view: EntityLike, m: Metas): boolean {
  const content = findContentChild(world, view, m);
  if (!content) return false;
  const childrenOf = new Map<number, EntityLike[]>();
  world.query(m.attrMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    const e = entity as EntityLike;
    const a = e.get(m.attrMeta.trait) as { parentId?: number } | undefined;
    const p = a?.parentId ?? 0;
    const bucket = childrenOf.get(p);
    if (bucket) bucket.push(e); else childrenOf.set(p, [e]);
  });
  // ⚠️ **No dedup guard, unlike `core/ecs/entityUtils.ts`'s subtree deleter — and the difference
  // is the number of ROOTS, not an oversight.** That one dedups "in case of overlapping subtrees"
  // because it deletes a LIST of ids, and two of them can be ancestor and descendant of each
  // other. This walk has exactly one root. Since every entity has exactly one `parentId`, the
  // parent graph is a FOREST: a cycle would form a component disconnected from `content`, so a
  // downward walk rooted there can never enter one. A guard was added during close-out by
  // pattern-matching to that sibling, and removed again when a mutation check showed the test for
  // it could not fail — an unreachable guard with a passing test reads as a live hazard to the
  // next reader.
  const doomed: EntityLike[] = [];
  const walk = (e: EntityLike) => {
    doomed.push(e);
    for (const child of childrenOf.get(e.id()) ?? []) walk(child);
  };
  walk(content);
  // Deepest first, so a parent is never destroyed while this loop still holds live children.
  for (let i = doomed.length - 1; i >= 0; i--) destroyEntity(doomed[i], world);
  return true;
}

/** The content child if it already exists — the read half of `ensureContentChild`, so the release
 *  path can ask without creating one for a view it is about to tear down. */
function findContentChild(world: World, view: EntityLike, m: Metas): EntityLike | null {
  const viewId = view.id();
  let found: EntityLike | null = null;
  world.query(m.attrMeta.trait, m.uiMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    if (found) return;
    const e = entity as EntityLike;
    const a = e.get(m.attrMeta.trait) as { name?: string; parentId?: number };
    if (a.parentId === viewId && a.name === ENTRIES_CONTENT_NAME) found = e as EntityLike;
  });
  return found;
}

function ensureContentChild(world: World, view: EntityLike, m: Metas): EntityLike | null {
  const viewId = view.id();
  const found = findContentChild(world, view, m);
  if (found) return found;

  // Spawned HERE, inside the system tick, so `spawnEntity` tags it Transient and it can never
  // reach a saved scene file.
  const el = m.uiMeta.trait({
    // A flex COLUMN of rows, sized by its content rather than by the viewport. Both halves are
    // load-bearing: `width: 100%` plus a trailing padding is what collapses the content box to
    // zero (see ENTRIES_ROW_NAME), and `alignItems: 'flex-start'` keeps a row at its own width
    // instead of stretching it. The column's own `gap` is the Y gap; each row carries the X gap.
    flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'flex-start',
  });
  const at = m.attrMeta.trait({ name: ENTRIES_CONTENT_NAME, parentId: viewId });
  const tag = m.renderMeta.trait();
  const spawned = spawnEntity(world, el, at, tag) as unknown as EntityLike;
  return spawned ?? null;
}

/** Ensure `want` engine-owned rows exist under the content child, in order.
 *
 *  Rows are never destroyed, for the same reason the entry pool never shrinks: churning
 *  entities exactly when the device is busiest. A row past the window is HIDDEN instead —
 *  an empty row still has padding, so leaving it visible would widen the content box. */
function ensureRows(world: World, content: EntityLike, want: number, m: Metas): EntityLike[] {
  const contentId = content.id();
  const found: { sort: number; e: EntityLike }[] = [];
  world.query(m.attrMeta.trait, m.uiMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    const e = entity as EntityLike;
    const a = e.get(m.attrMeta.trait) as { name?: string; parentId?: number; sortOrder?: number };
    if (a.parentId === contentId && a.name === ENTRIES_ROW_NAME) found.push({ sort: a.sortOrder ?? 0, e });
  });
  found.sort((a, b) => a.sort - b.sort);
  const rows = found.map(f => f.e);

  for (let i = rows.length; i < want; i++) {
    const el = m.uiMeta.trait({
      // Auto width — a row sizes to `padding + entries`, which is the whole point of the row
      // layer. `flexShrink: 0` stops the column from squeezing it back down.
      flexDirection: 'row', flexWrap: 'nowrap', flexShrink: 0, alignItems: 'flex-start',
    });
    const at = m.attrMeta.trait({ name: ENTRIES_ROW_NAME, parentId: contentId, sortOrder: i });
    const spawned = spawnEntity(world, el, at, m.renderMeta.trait()) as unknown as EntityLike;
    if (!spawned) break;
    rows.push(spawned);
  }
  return rows;
}

/** Every pooled instance currently belonging to this view, by slot. Derived from the WORLD
 *  rather than a module-level map: a cache of entity ids can desync across an HMR reload or a
 *  scene swap and then park entities that no longer exist. */
function poolOf(world: World, viewGuid: string, m: Metas): Map<number, EntityLike> {
  const bySlot = new Map<number, EntityLike>();
  world.query(m.entryMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    const e = entity as EntityLike;
    const ue = e.get(m.entryMeta.trait) as { viewGuid?: string; slot?: number };
    if (ue.viewGuid === viewGuid) bySlot.set(ue.slot ?? 0, e);
  });
  return bySlot;
}

/** Grow the pool to `want` instances. It NEVER shrinks: shrinking would churn entities exactly
 *  when the device is busiest (a fling that briefly widens the window), and a parked instance
 *  costs a hidden subtree. */
function ensurePool(
  world: World, content: EntityLike, viewGuid: string, kind: { name: string; prefab: string },
  want: number, m: Metas,
): { ids: Map<number, EntityLike>; grew: boolean } {
  const bySlot = poolOf(world, viewGuid, m);
  if (bySlot.size >= want) return { ids: bySlot, grew: false };

  if (!provider) return { ids: bySlot, grew: false };

  let grew = false;
  for (let slot = 0; slot < want; slot++) {
    if (bySlot.has(slot)) continue;
    // A DETERMINISTIC guid seed, so a pooled entity is addressable across sessions and the
    // determinism guard stays satisfied. The stable address is the SLOT, not the entry — see
    // UIEntry.index for the address a game should actually use.
    const rootId = provider.spawnInstance(world, kind.prefab, {
      parentId: content.id(), guidSeed: `${viewGuid}|entry|${slot}`,
    });
    if (!rootId) break;
    let handle: EntityLike | undefined;
    for (const e of world.entities) if ((e as EntityLike).id() === rootId) { handle = e as EntityLike; break; }
    if (!handle) break;
    handle.add(m.entryMeta.trait({ x: 0, y: 0, index: -1, slot, viewGuid, kind: kind.name, live: false }));
    bySlot.set(slot, handle);
    grew = true;
  }
  return { ids: bySlot, grew };
}

/** Carry the scroll offset as padding, and the authored gaps as flex `gap`.
 *
 *  The Y half sits on the content child and the X half on every row — which is what lets
 *  `UIElement`'s single `gap` field serve both axes (see ENTRIES_ROW_NAME).
 *
 *  ⚠️ Written in PX with the unit fields set explicitly. `UIElement`'s padding units default to
 *  `'%'`, and CSS percentage padding resolves against the containing block's WIDTH on both
 *  axes — so a `%` vertical padding is not "a share of the height", it is silently wrong.
 */
function writeLayout(
  content: EntityLike, rows: EntityLike[], m: Metas,
  xw: AxisWindow, yw: AxisWindow, en: Record<string, unknown>,
): void {
  const gapX = Math.max(0, (en.gapX as number) ?? 0);
  const gapY = Math.max(0, (en.gapY as number) ?? 0);

  const cur = content.get(m.uiMeta.trait) as Record<string, unknown>;
  const next = {
    ...cur,
    paddingTop: yw.padLeading, paddingTopUnit: 'px',
    paddingBottom: yw.padTrailing, paddingBottomUnit: 'px',
    paddingLeft: 0, paddingLeftUnit: 'px',
    paddingRight: 0, paddingRightUnit: 'px',
    gap: gapY, gapUnit: 'px',
  };
  if (cur.paddingTop !== next.paddingTop || cur.paddingBottom !== next.paddingBottom
    || cur.paddingLeft !== 0 || cur.paddingRight !== 0
    || cur.paddingTopUnit !== 'px' || cur.gap !== gapY || cur.gapUnit !== 'px') {
    content.set(m.uiMeta.trait, next);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rc = row.get(m.uiMeta.trait) as Record<string, unknown>;
    const visible = i < yw.pooled;
    const rn = {
      ...rc,
      paddingLeft: xw.padLeading, paddingLeftUnit: 'px',
      paddingRight: xw.padTrailing, paddingRightUnit: 'px',
      gap: gapX, gapUnit: 'px',
      isVisible: visible,
    };
    if (rc.paddingLeft !== rn.paddingLeft || rc.paddingRight !== rn.paddingRight
      || rc.paddingLeftUnit !== 'px' || rc.gap !== gapX || rc.gapUnit !== 'px'
      || rc.isVisible !== visible) {
      row.set(m.uiMeta.trait, rn);
    }
  }
}

/** Publish the window so game code, tests and Percept can verify BY DATA rather than pixels. */
function writeWindowState(view: EntityLike, m: Metas, xw: AxisWindow, yw: AxisWindow, poolSize: number): void {
  const cur = view.get(m.enMeta.trait) as Record<string, unknown>;
  const next = { ...cur, firstX: xw.first, firstY: yw.first, visibleX: xw.visible, visibleY: yw.visible, poolSize };
  if (cur.firstX === next.firstX && cur.firstY === next.firstY && cur.visibleX === next.visibleX
    && cur.visibleY === next.visibleY && cur.poolSize === next.poolSize) return;
  view.set(m.enMeta.trait, next);
}

/** Does an authored value on a pooled row root deserve a warning?
 *
 *  Only when it differs from BOTH the pin AND the trait's own default (#761). The default means
 *  "the author never touched this field" — the common case, and not worth a line. Checking only
 *  `cur !== pinned` (the pre-#761 rule) is wrong for a field whose pin is NOT its default:
 *  `flexShrink` defaults to 1 but pins to 0, so that alone would warn on every untouched row;
 *  `isVisible` defaults to `true` but pins to the slot's `live` state, so every freshly-spawned
 *  PARKED slot (`live === false`) would warn too. For the eight fields whose pin already equals
 *  their default (margin, min/max — all pinned and defaulted to 0) `pinned === def`, so this
 *  reduces to exactly the old `cur !== pinned` check — no behaviour change there. */
function pooledFieldNeedsWarning(cur: unknown, pinned: unknown, def: unknown): boolean {
  return cur !== pinned && cur !== def;
}

/** Does an authored `width`/`height` on a pooled row root deserve a warning?
 *
 *  A `%`-unit value is NOT a trap — it is the shape `entriesSystem` is designed around. The
 *  standard pager authors `width: 100, widthUnit: '%'` on the entry prefab root (matching
 *  `entryWidth: 100%` on the `UIEntries` view itself), and this system resolves that `%` against
 *  the live viewport into the px pin every tick — the docstring above ("Not a shadow of the
 *  authored value — it IS the authored value resolved") says so directly. Comparing the RAW
 *  percent number against the resolved px pin (the pre-#762-review rule) is therefore comparing
 *  two different units and warns on the canonical shape itself: `cur=100, pinned=390` always
 *  differs, so 5 of the 6 committed entry-prefab roots in the repo tripped it.
 *
 *  So: only a `px`-unit authored value can be a real trap (an author typing `width: 200px` on a
 *  pooled row, expecting it to hold). Any other unit — `%`, `vw`, `vh`, `vmin`, `vmax` — is
 *  resolved by the scroll view and is NEUTRAL here, mirroring `isNeutralSize` in
 *  `sceneValidation.ts`, which exists for exactly the same "don't warn on the documented
 *  contract" reason.
 *
 *  ⚠️ KNOWN FALSE NEGATIVE, not intended behaviour — do not cite this as evidence the `%`-is-
 *  neutral rule is fine as written. The rule above rests on the view actually RESOLVING the `%`,
 *  which happens for a view-authored `entryWidth`/`entryHeight` but NOT for the `entryWidth: 0`
 *  ("read it from the prefab") case: `entryPrefabProvider.ts`'s `rootSize` returns `ui.width` raw
 *  and ignores `widthUnit`, and `resolveEntrySize` (`entriesLayout.ts`) short-circuits on
 *  `authored === 0` and returns it verbatim as px. So a root authored `width: 100, widthUnit:
 *  '%'` under a view with no `entryWidth` is silently pinned to 100px and NOTHING warns here —
 *  this function never even sees it, because the value never resolves to a differing px pin. The
 *  fix belongs in `rootSize`/`resolveEntrySize` (#765), not here — changing the predicate in this
 *  function would duplicate logic #765's fix must change anyway. */
function pooledSizeNeedsWarning(curValue: unknown, curUnit: unknown, wantPx: number, def: unknown): boolean {
  if (curUnit !== 'px') return false;
  return curValue !== wantPx && curValue !== def;
}

/** Warn once per pooled SLOT per field when the box pin below is about to overwrite a value the
 *  author actually authored (per `pooledFieldNeedsWarning` above — the caller has already
 *  decided). Runs in the frame loop, so `warnedOverridden` is what keeps this to one line per
 *  offender rather than one per tick forever.
 *
 *  ⚠️ Keyed on `viewGuid:slot`, NOT on `entity.id()`. koota RECYCLES entity ids, so an id key is
 *  wrong in both directions within a single scene: tearing down one `UIEntries` view and building
 *  another can hand a fresh pooled root a retired id whose field was already warned, silently
 *  swallowing a real authoring mistake. A view's guid plus its slot index names the same seat for
 *  as long as the view exists and can never collide with a different view's.
 *
 *  `field` is the warn-once key AND the name shown; pass `displayField`/`displayValue` to fold a
 *  value and its companion unit into ONE line (`width=50%`) instead of two — see the width/height
 *  call sites, the only ones that need it. */
function warnAuthoredOverride(
  entity: EntityLike, attr: Record<string, unknown>, viewGuid: string, slot: number, field: string,
  cur: unknown, pinnedDisplay: unknown, displayField: string = field, displayValue: unknown = cur,
): void {
  const key = `${viewGuid}:${slot}:${field}`;
  if (warnedOverridden.has(key)) return;
  warnedOverridden.add(key);
  const name = (attr.name as string) || `#${entity.id()}`;
  console.warn(`[UIEntries] entity '${name}' authored UIElement.${displayField}=${String(displayValue)}, but a pooled UIEntries root owns its own box and pins ${displayField} to ${String(pinnedDisplay)} every tick — the authored value never takes effect.`);
}

/** Bind each slot to its coordinate, then fill it from the game's resolver. */
function applySlots(
  world: World, plan: ReturnType<typeof planSlots>, pool: Map<number, EntityLike>,
  viewGuid: string, kindName: string, sourceName: string, m: Metas,
  childIndex: Map<number, { id: number; name: string }[]>,
  grid: { rows: EntityLike[]; cols: number; entryW: number; entryH: number },
): void {
  const resolver = sourceName ? getEntrySource(sourceName) : undefined;

  // ⚠️ Iterate the POOL, not the plan. The pool never shrinks (shrinking would churn entities
  // exactly when the device is busiest), so after the data shrinks — a filter applied, a track
  // switched — there are pooled slots the window no longer covers. Driving only the plan leaves
  // those showing the PREVIOUS content, visible and stale, which is the failure this whole
  // parked/live distinction exists to prevent. Caught by this system's integration test.
  const byPlan = new Map(plan.map(p => [p.slot, p]));
  for (const [slot, entity] of pool) {
    const p = byPlan.get(slot) ?? { slot, x: 0, y: 0, index: -1, live: false };
    if (!entity) continue;

    // sortOrder is the DATA index, and it must be written on every recycle: child order comes
    // from EntityAttributes.sortOrder, every pooled instance inherits the SAME authored value
    // from the prefab, and the tie-break is archetype order fixed at pool-creation time. Without
    // this the entries render in the wrong visual order while every trait value reads correctly.
    // The row a slot belongs to, and its column within that row — `planSlots` numbers slots
    // across then down, so this is the inverse of the one rule it uses. Reparenting happens on
    // every re-drive rather than at spawn because a RESIZE changes `cols`, and with it which
    // row a given slot sits in.
    const ry = grid.cols > 0 ? Math.floor(slot / grid.cols) : 0;
    const parent = grid.rows[ry] ?? grid.rows[grid.rows.length - 1];
    const parentId = parent ? parent.id() : 0;
    const sortWithinRow = grid.cols > 0 ? slot % grid.cols : slot;

    const attr = entity.get(m.attrMeta.trait) as Record<string, unknown>;
    if (attr.sortOrder !== sortWithinRow || attr.parentId !== parentId) {
      entity.set(m.attrMeta.trait, { ...attr, sortOrder: sortWithinRow, parentId });
    }

    const content: EntryContent | null = p.live && resolver
      ? resolver({ x: p.x, y: p.y, index: p.index })
      : null;
    const live = p.live && content !== null;

    const cur = (entity.has(m.entryMeta.trait) ? entity.get(m.entryMeta.trait) : {}) as Record<string, unknown>;
    if (cur.x !== p.x || cur.y !== p.y || cur.index !== p.index || cur.live !== live || cur.kind !== kindName) {
      entity.set(m.entryMeta.trait, { x: p.x, y: p.y, index: p.index, slot, viewGuid, kind: kindName, live });
    }

    // A parked entry is hidden AND flagged not-live. The flag is what makes it read as
    // DESTROYED to Percept/Enact; hiding is only what makes it invisible.
    //  The RESOLVED entry size is written onto the pooled root, in px.
    //
    //  Not a shadow of the authored value — it IS the authored value resolved: `%` against the
    //  live viewport, `0` read back from the prefab root. Writing it is what makes the box
    //  definite, and a definite box is what a `%`-sized prefab root needs once its parent is an
    //  auto-width row (a `%` against an indefinite container silently becomes content-sized).
    //  `flexShrink: 0` is the second half: without it the row's own trailing padding squeezes
    //  every entry to nothing, which is exactly how the pager rendered 0px-wide pages.
    //
    //  `margin*: 0` is the third half (#651, see docs/ui-system.md's "Scroll views" section for
    //  the full derivation): margin sits outside the border box, so an authored margin on the
    //  prefab root would desync the real on-screen stride from `entrySize + gap` — the same
    //  move as pinning width/height/flexShrink above, for the same reason.
    //
    //  `minWidth/maxWidth/minHeight/maxHeight: 0` (each field's own "none", per UIElement.ts) are
    //  the fourth half (#651 B1 sibling): a min/max constraint overrides the definite width/height
    //  above from INSIDE the border box, the same desync as margin from outside it.
    //
    //  `isVisible` (pinned to the slot's live state, not a constant) is the fifth half. Its
    //  warning — and `flexShrink`'s above — stayed SILENT until #761: unlike every field above,
    //  neither field's pin equals its trait DEFAULT, so the naive "warn when authored ≠ 0" rule
    //  would either warn on every untouched row (`flexShrink` defaults to 1, not 0) or on every
    //  freshly-spawned PARKED slot (`isVisible` defaults to `true`, and a parked slot's pin is
    //  `false`). See `pooledFieldNeedsWarning`, which checks against the default too.
    //
    //  Every pinned field lives in ONE place — `uiAuthoring.POOLED_ROW_PINNED_GROUPS`, via
    //  `buildPooledRowPin` — so the equality guard, the `entity.set` below and the Inspector note
    //  can't drift apart again the way the six #761 fields did (pinned in total silence, no
    //  warning, no Inspector mention) — and, per the #764 review, can't drift the OTHER direction
    //  either: a field added to the pin literal without a matching constant entry now fails the
    //  `uiAuthoring.test.ts` bidirectional guard instead of pinning in silence a second time.
    const ui = entity.get(m.uiMeta.trait) as Record<string, unknown> | undefined;
    if (ui) {
      const wantW = Math.max(0, grid.entryW);
      const wantH = Math.max(0, grid.entryH);
      // The trait's OWN defaults, read off its koota schema rather than re-typed here — the one
      // way `pooledFieldNeedsWarning` can tell "authored" from "never touched" without a second,
      // hand-maintained copy of UIElement.ts's defaults that could drift from it.
      const defaults = (m.uiMeta.trait as { schema?: Record<string, unknown> }).schema ?? {};
      const pinned = buildPooledRowPin({ live, wantW, wantH });

      // The nine fields the generic equality guard covers — everything `POOLED_ROW_PINNED_FIELDS`
      // names EXCEPT `isVisible` and `width`/`height` (+ their units), which each need their own
      // comparison below (live-state and folded-unit respectively).
      for (const field of POOLED_ROW_GENERIC_WARN_FIELDS) {
        if (pooledFieldNeedsWarning(ui[field], pinned[field], defaults[field])) {
          warnAuthoredOverride(entity, attr, viewGuid, slot, field, ui[field], pinned[field]);
        }
      }
      if (pooledFieldNeedsWarning(ui.isVisible, live, defaults.isVisible)) {
        warnAuthoredOverride(entity, attr, viewGuid, slot, 'isVisible', ui.isVisible, live);
      }
      // width/height fold their companion unit into ONE warning — an author authors an axis, not
      // two independent fields, and a `width`+`widthUnit` pair that BOTH differ from the pin would
      // otherwise print twice for the same mistake. A `%` (or `vw`/`vh`/`vmin`/`vmax`) authored
      // unit is the documented contract, not a trap — see `pooledSizeNeedsWarning`.
      if (pooledSizeNeedsWarning(ui.width, ui.widthUnit, wantW, defaults.width)) {
        warnAuthoredOverride(entity, attr, viewGuid, slot, 'width', ui.width, `${wantW}px`, 'width', `${ui.width}${ui.widthUnit}`);
      }
      if (pooledSizeNeedsWarning(ui.height, ui.heightUnit, wantH, defaults.height)) {
        warnAuthoredOverride(entity, attr, viewGuid, slot, 'height', ui.height, `${wantH}px`, 'height', `${ui.height}${ui.heightUnit}`);
      }

      if (POOLED_ROW_PINNED_FIELDS.some((field) => ui[field] !== pinned[field])) {
        entity.set(m.uiMeta.trait, { ...ui, ...pinned });
      }
    }
    if (!live || !content) continue;

    const { writes, problems } = planEntryWrites(childIndex, entity.id(), content);
    for (const p2 of problems) {
      console.warn(`[UIEntries] source '${sourceName}' addressed '${p2.path}' — ${p2.reason}${p2.at ? ` at '${p2.at}'` : ''}`);
    }
    for (const w of writes) {
      const meta = getTraitByName(w.trait);
      if (!meta) { console.warn(`[UIEntries] source '${sourceName}' wrote unknown trait '${w.trait}'`); continue; }
      let target: EntityLike | undefined;
      for (const e of world.entities) if ((e as EntityLike).id() === w.entityId) { target = e as EntityLike; break; }
      if (!target || !target.has(meta.trait)) continue;
      const curT = target.get(meta.trait) as Record<string, unknown>;
      let changed = false;
      for (const k in w.fields) if (curT[k] !== w.fields[k]) { changed = true; break; }
      if (changed) target.set(meta.trait, { ...curT, ...w.fields });
    }
  }
}
