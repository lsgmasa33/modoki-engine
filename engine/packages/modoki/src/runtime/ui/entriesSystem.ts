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
import { spawnEntity, onWorldSwap, getCurrentWorld } from '../core/ecs/world';
import { beginSystemTick, endSystemTick } from '../core/systemTick';
import { parseEntryPrefabs } from '../traits/UIEntries';
import { buildChildIndex } from '../core/ecs/memberPath';
import { getEntrySource, planEntryWrites, type EntryContent } from './entrySource';
import {
  computeAxisWindow, effectiveOverscan, planSlots, resolveEntrySize, EMPTY_WINDOW,
  type AxisWindow,
} from './entriesLayout';
import { markUIDirty } from '../core/uiDirty';

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
}
const viewStates = new Map<string, ViewState>();
onWorldSwap(() => { viewStates.clear(); });

/** Views already warned about, so a per-frame system does not spam the console. Cleared with
 *  the rest of the module state, so a re-authored scene gets told again. */
const warned = new Set<string>();

/** Reset module state — tests and teardown. */
export function resetEntriesSystem(): void { viewStates.clear(); warned.clear(); }

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

  let dirtied = false;
  for (const view of views) {
    if (driveView(world, view.handle, { svMeta, enMeta, entryMeta, uiMeta, attrMeta, renderMeta }, opts?.fromScroll !== true)) {
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
  consumeEntryRequest(view, m, en, entryW, entryH);

  const st = viewStates.get(viewGuid)
    ?? { seeded: false, lastFirstX: 0, lastFirstY: 0, lastEpoch: -1, lastCountX: -1, lastCountY: -1, travel: 0,
         frameScrollX: 0, frameScrollY: 0,
         lastEntryW: -1, lastEntryH: -1, lastCols: -1, lastRows: -1 };
  const floor = (en.overscan as number) ?? 2;

  // How far the SCROLL has moved since the last pipeline tick, in entries — see
  // ViewState.frameScrollX for why the baseline is per-FRAME and why it must not come from
  // `first`.
  const strideXpx = Math.max(1, entryW + ((en.gapX as number) ?? 0));
  const strideYpx = Math.max(1, entryH + ((en.gapY as number) ?? 0));
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
    ? computeAxisWindow({ scroll: sv.scrollX, viewport: sv.viewportWidth, entrySize: entryW, gap: en.gapX as number, count: countX, overscan: overscanX })
    : EMPTY_WINDOW;
  const yw: AxisWindow = countY > 0
    ? computeAxisWindow({ scroll: sv.scrollY, viewport: sv.viewportHeight, entrySize: entryH, gap: en.gapY as number, count: countY, overscan: overscanY })
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
    frameScrollX: isFrameTick ? sv.scrollX : st.frameScrollX,
    frameScrollY: isFrameTick ? sv.scrollY : st.frameScrollY,
    lastEntryW: entryW, lastEntryH: entryH, lastCols: xw.pooled, lastRows: yw.pooled,
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
  if (!moved && !invalidated && !poolChanged) return false;

  // ⚠️ The child index is built HERE — after `ensurePool`, never before. A pool that just grew
  // has brand-new member entities, and an index captured earlier does not contain them: every
  // member path would resolve to nothing and the entries would render empty on exactly the
  // frame they appeared. Caught by this system's integration test.
  const childIndex = buildChildIndex(world);

  writeLayout(content, rows, m, xw, yw, en);
  writeWindowState(view, m, xw, yw, plan.length);
  applySlots(world, plan, pool.ids, viewGuid, kinds[0].name, en.source as string, m, childIndex,
    { rows, cols: Math.max(1, xw.pooled), entryW, entryH });
  return true;
}

/** Turn a pending `scrollToEntry*` request into a px `UIScrollView.scrollTo*`, then clear it.
 *
 *  Two traits are involved because they own different things: `UIEntries` speaks entries (it is
 *  what knows how big one is), `UIScrollView` speaks pixels (it is what the DOM consumes). The
 *  hand-off happens once, here, rather than either side learning the other's units. */
function consumeEntryRequest(
  view: EntityLike, m: Metas, en: Record<string, unknown>, entryW: number, entryH: number,
): void {
  const reqX = (en.scrollToEntryX as number) ?? -1;
  const reqY = (en.scrollToEntryY as number) ?? -1;
  if (reqX < 0 && reqY < 0) return;

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
  if (!canX || !canY) return;   // retry next frame, once the prefab is cached

  const sv = view.get(m.svMeta.trait) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...sv };
  if (reqX >= 0) next.scrollToX = reqX * strideX;
  if (reqY >= 0) next.scrollToY = reqY * strideY;
  view.set(m.svMeta.trait, next);
  // Clear the entry-space request only now that it HAS been handed to the px surface. Leaving
  // it set would re-issue the same scroll every frame and pin the view in place.
  view.set(m.enMeta.trait, { ...en, scrollToEntryX: -1, scrollToEntryY: -1 });
}

/** Find (or spawn) the engine-owned content child. The pooled entries are ITS children, and it
 *  carries the scroll offset as leading/trailing padding.
 *
 *  Why a child rather than padding the scroll box itself: padding-bottom on a scroll container
 *  has a long history of being dropped from the scrollable area, and the device spike validated
 *  the inner-child shape specifically. */
function ensureContentChild(world: World, view: EntityLike, m: Metas): EntityLike | null {
  const viewId = view.id();
  let found: EntityLike | null = null;
  world.query(m.attrMeta.trait, m.uiMeta.trait).updateEach((_t: unknown[], entity: unknown) => {
    if (found) return;
    const e = entity as EntityLike;
    const a = e.get(m.attrMeta.trait) as { name?: string; parentId?: number };
    if (a.parentId === viewId && a.name === ENTRIES_CONTENT_NAME) found = e as EntityLike;
  });
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
    //  `flexShrink: 0` is the other half: without it the row's own trailing padding squeezes
    //  every entry to nothing, which is exactly how the pager rendered 0px-wide pages.
    const ui = entity.get(m.uiMeta.trait) as Record<string, unknown> | undefined;
    if (ui) {
      const wantW = Math.max(0, grid.entryW);
      const wantH = Math.max(0, grid.entryH);
      if (ui.isVisible !== live || ui.width !== wantW || ui.height !== wantH
        || ui.widthUnit !== 'px' || ui.heightUnit !== 'px' || ui.flexShrink !== 0) {
        entity.set(m.uiMeta.trait, {
          ...ui, isVisible: live, flexShrink: 0,
          width: wantW, widthUnit: 'px', height: wantH, heightUnit: 'px',
        });
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
