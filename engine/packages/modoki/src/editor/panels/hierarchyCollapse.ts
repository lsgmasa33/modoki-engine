/** Hierarchy entity collapse — the localStorage persistence and the two decisions the
 *  panel makes about it. Extracted from `Hierarchy.tsx` so the decisions carry unit tests
 *  (CLAUDE.md § Editor: a panel's DECISIONS belong in a plain `.ts` module beside it, and
 *  a `.tsx` mounted in jsdom only ever asserts the mock). The panel keeps the wiring.
 *
 *  Expand/collapse is per-user VIEW state, so it lives in localStorage — NOT the scene file
 *  (it would churn the file and isn't scene data). Keyed by `EntityAttributes.guid` so it
 *  survives the runtime-id reassignment on every scene reload / Play→Stop. Per scene path,
 *  mirroring the empty-folders map. A saved (even empty) array = "this scene has been seen"
 *  (all-expanded is remembered); a MISSING entry = never seen → collapse-all default. */

/** The subset of `EntityInfo` these decisions read. Declared structurally so the module
 *  stays free of the panel's imports and a test can hand it plain objects. */
import type { World } from 'koota';
import { durableGuid } from '../../runtime/core/assetRefRules';
import { holdEntity, resolveHeld, type HeldEntity } from '../store/heldEntity';
import { findEntityById } from '../../runtime/core/ecs/world';

export type CollapseNode = { id: number; parentId?: number | null; guid?: string };

/** The guid collapse state may be keyed by: durable only. A runtime guid (#1210) is re-issued to
 *  a different entity next session, so persisting one would collapse the wrong row. */
const durableKey = durableGuid;

export const ENTITY_COLLAPSE_LS_KEY = 'editor:hierarchy:entityCollapsed:v1';

/** A tree this small is always shown fully expanded — collapsing four rows hides more than
 *  it tidies. Deliberately a code constant: it is a UI legibility floor, not a knob the
 *  owner tunes from a screenshot. */
export const COLLAPSE_ALL_MIN_ENTITIES = 5;

function loadCollapseMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ENTITY_COLLAPSE_LS_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

export function loadCollapsedGuids(scenePath: string): string[] | null {
  if (!scenePath) return null;
  const arr = loadCollapseMap()[scenePath];
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : null;
}

export function saveCollapsedGuids(scenePath: string, guids: string[]) {
  if (!scenePath) return;
  try {
    const map = loadCollapseMap();
    map[scenePath] = guids;
    localStorage.setItem(ENTITY_COLLAPSE_LS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** Which ids the restore should mark collapsed, given the freshly-flattened tree and the
 *  saved guid list for this scene (`null` = never seen). Only nodes that HAVE a child can
 *  read as collapsed, so leaves are never included. */
export function computeRestoredCollapse(
  flat: readonly CollapseNode[],
  saved: readonly string[] | null,
): Set<number> {
  if (flat.length <= COLLAPSE_ALL_MIN_ENTITIES) return new Set();
  const parents = flat.filter((e) => flat.some((c) => c.parentId === e.id));
  if (!saved) return new Set(parents.map((e) => e.id));   // never seen → collapse-all default
  // Seen before → restore exactly (map saved guids → current ids). An entity with no guid,
  // or not in the saved set, renders expanded.
  const wanted = new Set(saved);
  return new Set(parents.filter((e) => { const g = durableKey(e.guid); return g && wanted.has(g); }).map((e) => e.id));
}

/** The inverse, for the save side: the guids of the currently-collapsed ids. Ids with no
 *  guid are dropped — a guid is what survives the next id reassignment. */
export function collapsedIdsToGuids(
  flat: readonly CollapseNode[],
  collapsed: ReadonlySet<number>,
): string[] {
  const idToGuid = new Map(flat.map((e) => [e.id, durableKey(e.guid)]));
  const guids: string[] = [];
  for (const id of collapsed) { const g = idToGuid.get(id); if (g) guids.push(g); }
  return guids;
}

// ── Ownership (#839) ────────────────────────────────────────────────────────────────────
// The collapsed set is owned by a WORLD — the one whose entity ids it holds. `owner` is that
// world (an opaque identity; this module never touches it), `null` before any restore.
//
// ⚠️ Not the scene PATH, which is the obvious wrong answer and was the first fix attempted.
// `saveScene()` changes the path with no swap and no structural change (editor/scene/serialize.ts,
// both the Save-As and known-path branches), so a path-keyed claim reads "needs restore" after a
// plain File → Save As: the next structural change collapses the whole tree — the never-seen-scene
// default — and persists that over the arrangement the user just saved. The ids did not move; only
// the file name did. A world identity says that, a path does not.
//
// This replaced an unkeyed `restoreNeeded` boolean, and that shape is the original defect. The
// boolean could only be cleared by `restoreCollapse`, which runs from a SETTLED refresh — i.e.
// from `onStructureDirtyCoalesced`, a FOREIGN event a world swap does not guarantee will fire.
// `SceneManager` marks nothing structure-dirty after `setCurrentWorld`, and every entity of the
// incoming scene was registered into the staging world BEFORE the swap, so for a scene loaded
// after boot the claim was never consumed: collapse was never restored, never persisted, and the
// first entity the user created finally ran the restore and overwrote what they had collapsed.
//
// An identity also needs no clearing on the swap: a new world simply is not the old one. That
// matters for `stepSimulation`, which swaps the current world out and back — a flag nulled on
// every swap EVENT would demand a spurious restore afterwards; comparing identities does not.

/** Which world the collapsed set was restored for, and under which scene path. The world is what
 *  makes the ids valid; the path is only carried so "the editor now has no scene at all" can be
 *  told apart from a rename. Compared by reference — the concrete World type is not imported. */
export type CollapseOwner = { world: object; path: string } | null;

/** Does the collapsed set need restoring?
 *
 *  Two independent causes, and the second is easy to miss:
 *  - **the world changed** — every entity id was reassigned, so the set describes nothing;
 *  - **the editor crossed between "no scene" and "a scene", in EITHER direction.**
 *
 *  The second cause is ONE-directional, and both halves of that were learned the hard way:
 *  - **`''` ← a real path fires.** The agent's new-scene op clears the editor path and respawns
 *    into the SAME world, so the world test alone would leave the outgoing scene's ids in place —
 *    and koota's `.id()` masks off both generation and world id, so a recycled id collides
 *    exactly and lands collapsed on a new entity with no user action.
 *  - **a real path ← `''` does NOT fire**, and must not. It looks symmetric — `exitPrefabEditing()`
 *    swaps the world while the editor path is still null, so a restore that ran too early would
 *    latch `{world, ''}` and never be re-asked. But the cure for that is to not restore too early
 *    (the panel waits on `aSceneSwapIsHappening()`), after which the WORLD clause already answers
 *    it. Adding the direction instead breaks the opposite case: build a hierarchy in an untitled
 *    world, Save As, and it would restore the target path's entry — collapse-all for a new file —
 *    over the arrangement being saved.
 *
 *  A rename is likewise NOT a cause — both paths are non-empty, so this is false. See the Save As
 *  scar below. */
export function needsCollapseRestore(
  owner: CollapseOwner,
  currentWorld: object,
  currentScenePath: string,
): boolean {
  if (owner === null) return true;
  if (owner.world !== currentWorld) return true;
  return currentScenePath === '' && owner.path !== '';
}

/** May the current collapsed set be written back under `currentScenePath`? Only when it was
 *  restored for the world that is live now — otherwise it holds a dead world's ids (or
 *  pre-restore junk) and saving it would clobber the entry we are about to read. The PATH is
 *  where it gets written, never what decides whether it may be.
 *
 *  ⚠️ This is also false with a perfectly live owner whenever there is no scene path at all
 *  (`newScene()`, prefab-edit mode) — there is simply nowhere to write. */
export function shouldPersistCollapse(
  owner: CollapseOwner,
  currentWorld: object,
  currentScenePath: string,
): boolean {
  return currentScenePath !== '' && owner !== null && owner.world === currentWorld;
}

// ── Following an entity inside ONE world (#1221) ──────────────────────────────────────────
// Everything above handles the set across a world swap. Inside a world the ids are koota's recycled
// index: a collapsed parent that a system destroys and replaces on the same index (a board rebuilt
// during Play) used to show the NEWCOMER collapsed. So each collapsed id is HELD
// (`editor/store/heldEntity.ts`) while it is in the set, and the settled refresh re-resolves the
// holds before it rebuilds the tree: the same entity stays collapsed, a replacement carrying its guid
// takes its place, and anything else leaves the set.
//
// A collapsed entity that is gone but had a guid is PARKED, not forgotten, so a later respawn of that
// guid comes back collapsed — an undo of a delete, a respawn a frame or more later. Parked guids are
// also still PERSISTED (`persistableCollapsedGuids`): otherwise a game system destroying a collapsed
// scene entity during Play would re-save the scene's collapse set without it, and Stop would restore it
// expanded (#1221 close-out review, both).

export interface CollapseHolds {
  /** id → hold, for ids in the collapsed set that name a registered entity. */
  readonly held: ReadonlyMap<number, HeldEntity>;
  /** Collapsed entities that are gone, waiting for their DURABLE guid to come back. */
  readonly parked: readonly HeldEntity[];
}

export const NO_COLLAPSE_HOLDS: CollapseHolds = { held: new Map(), parked: [] };

/** The holds for `collapsed`, recomputed after the set changed (the panel's `[collapsed]` effect).
 *
 *  - an id still naming the SAME entity keeps its hold;
 *  - an id that just entered the set — or whose prior hold names a different entity now (a follow
 *    landed on an index another collapsed entity used to hold) — is held afresh;
 *  - a prior hold that LEFT the set because its entity is gone is parked (if it has a guid); one that
 *    left because the user expanded it is simply forgotten;
 *  - a parked hold whose entity is back in the set, or from another world, stops being parked. */
export function holdCollapsed(collapsed: ReadonlySet<number>, prior: CollapseHolds, world: World): CollapseHolds {
  const held = new Map<number, HeldEntity>();
  for (const id of collapsed) {
    const was = prior.held.get(id);
    const same = was && was.world === world && findEntityById(id, world)?.valueOf() === was.packed;
    const h = same ? was : holdEntity(id, world);
    if (h) held.set(id, h);
  }
  // Sets, not scans: this runs on every collapse change, and a recursive collapse puts every leaf in
  // the set — measured at the review, a scan per parked entry cost 384 ms per toggle at 4,000.
  const heldPacked = new Set<number>();
  const heldGuids = new Set<string>();
  for (const h of held.values()) { heldPacked.add(h.packed); if (h.guid) heldGuids.add(h.guid); }
  const parked: HeldEntity[] = [];
  const parkedGuids = new Set<string>();
  const keepParked = (h: HeldEntity) => {
    // Durable guids only: a runtime guid is never re-issued, so parking one could only ever grow.
    if (h.world !== world || !durableKey(h.guid) || heldPacked.has(h.packed)) return;
    if (heldGuids.has(h.guid) || parkedGuids.has(h.guid)) return; // back in the set, or parked already
    parkedGuids.add(h.guid);
    parked.push(h.id === null ? h : { ...h, id: null });
  };
  for (const [id, was] of prior.held) {
    if (collapsed.has(id)) continue;
    const alive = findEntityById(id, world)?.valueOf() === was.packed;
    if (!alive) keepParked(was); // gone, not expanded
  }
  for (const h of prior.parked) keepParked(h);
  return { held, parked };
}

/** Re-resolve every held collapsed id, and every parked one, in `world`: the new set, or null when
 *  nothing moved. An id that was never held passes through untouched. PURE — the panel re-takes the
 *  holds for the result through {@link holdCollapsed}. ⚠️ It used to hand back the new holds for the
 *  panel to store from inside a `setCollapsed` updater; React runs an updater twice in development and
 *  keeps the SECOND result, which then saw the dropped id as never-held and passed it straight back —
 *  the newcomer stayed collapsed in the running editor with every unit test green (#1221, live check).
 *
 *  Runs from the panel's settled refresh, outside any structure change, so it may rescan for a guid
 *  written without `indexEntityGuid`. */
export function reconcileCollapsed(collapsed: ReadonlySet<number>, holds: CollapseHolds, world: World): Set<number> | null {
  let moved = false;
  const next = new Set<number>();
  for (const id of collapsed) {
    const h = holds.held.get(id);
    if (!h) { next.add(id); continue; }
    const r = resolveHeld(h, world, { rescan: true });
    if (r === h) { next.add(id); continue; }
    moved = true;
    if (r && r.id !== null) next.add(r.id);
  }
  for (const h of holds.parked) {
    const r = resolveHeld(h, world, { rescan: true });
    if (r && r.id !== null && !next.has(r.id)) { next.add(r.id); moved = true; }
  }
  return moved ? next : null;
}

/** The guids to persist for this scene: the collapsed ids' durable guids plus every parked one's. */
export function persistableCollapsedGuids(flat: readonly CollapseNode[], collapsed: ReadonlySet<number>, holds: CollapseHolds): string[] {
  const out = collapsedIdsToGuids(flat, collapsed);
  for (const h of holds.parked) {
    const g = durableKey(h.guid);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}
