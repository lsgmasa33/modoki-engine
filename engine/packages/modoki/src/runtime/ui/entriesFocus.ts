/** entriesFocus — keep UI focus pointing at the same ENTRY when a pooled slot recycles.
 *
 *  ## The problem this solves
 *
 *  Focus is addressed by GUID (`focusManager`), and a pooled entry's guid is deterministic at the
 *  **SLOT** — `deriveGuid(`${viewGuid}|entry|${slot}`)`, deliberately, so an agent can address
 *  "the third pooled instance" across a re-drive. The scroll window, meanwhile, moves the DATA
 *  under those slots. So the moment the window shifts, the focused guid still resolves to a live,
 *  visible element — and that element is now showing **different data**. Nothing errors. A
 *  gamepad cursor sitting on level 5 is silently sitting on level 12, and the next Confirm
 *  launches the wrong one.
 *
 *  `uiFocusSystem` cannot fix this itself: it is GAME-tier, so it is dead while the sim is
 *  paused — and a settings list or a level select is exactly what you scroll while paused. That
 *  is the same reason the pool runs at `SYSTEM_PRIORITY.UI_ENTRIES` (270), and the re-target has
 *  to run there with it, inside the drive that caused the recycle.
 *
 *  ## Focus follows the entry, and CLAMPS when the entry leaves the pool
 *
 *  The entry is the thing the player is looking at; the slot is bookkeeping. So focus is captured
 *  as *"entry (x, y), at this member path inside it"* before the slots are re-driven, and
 *  re-pointed at whichever slot holds that entry afterwards.
 *
 *  When the entry is no longer resident at all — a fling or a `scrollToEntry` jump carried it
 *  past `visible + overscan` — focus **clamps to the nearest resident entry** rather than being
 *  cleared (owner, 2026-08-22). Clearing is the simpler rule and it was rejected on feel: with a
 *  gamepad, focus vanishing mid-fling reads as a dropped input, and `uiFocusSystem`'s autofocus
 *  would then drop the cursor at the list's lowest `focusOrder` rather than where the player was
 *  looking. Clamping makes focus ride the leading edge in the direction of travel.
 *
 *  ## Why the path is a `stepId` chain and NOT a name path
 *
 *  ⚠️ **The obvious two designs are both wrong, and the second one is wrong in a way that looks
 *  fine for months.**
 *
 *  A plain NAME path (`resolveMemberPathIn`) cannot be used: that walker treats an ambiguous
 *  segment as an ERROR by design, which is right for an authored resolver key — a silent
 *  multi-write is the failure there — and wrong here, because this path is DERIVED from an
 *  entity that provably exists, so refusing it means declining to re-target focus that is
 *  demonstrably sitting somewhere. `level-tile.prefab.json` alone carries three `Num`s.
 *
 *  Name + **ordinal among siblings** is the tempting fix, and it is unsound. The sibling order
 *  it would count against comes from `buildChildIndex`, which iterates `world.entities` — and
 *  that is koota's `entityIndex.dense` array, which `releaseEntity` maintains by **swap-pop**:
 *  destroying any entity moves the world's LAST alive entity into the freed slot. `releaseViewPool`
 *  destroys hundreds at once when an unrelated scroll view is hidden (measured: 809 entities when
 *  Court's level selector closes), so a destroy elsewhere in the scene can reorder two siblings of
 *  a *live* instance relative to the same two siblings in every other instance. The ordinal would
 *  then name a different member per slot, with no error and no test able to see it.
 *
 *  So a segment is a **`stepId`** — `PrefabInstance.parentLocalId || localId` — which is
 *  authored data, identical across every instance of a prefab, and unique among siblings **by
 *  construction**. That is not a new claim: `deriveInstanceMemberGuids` already builds every
 *  member guid from exactly this chain, for exactly this reason (a nested-instance root shares
 *  its inner `localId` with its siblings, so `parentLocalId` is what distinguishes it). Reusing
 *  its key is what makes this walk order-independent instead of order-dependent.
 *
 *  `name` rides along for two jobs: it is the diagnostic when a resolve misses, and it is the
 *  FALLBACK key for an entity with no `PrefabInstance` at all (`stepId === 0`) — a hand-spawned
 *  child under an entry root, which no production entry has and a test fixture might.
 *
 *  Pure over a prebuilt child index and a key lookup: no world, no wall-clock, no store reads, so
 *  the whole re-target rule is unit-testable without spinning a pool. */

/** One step of a derived member path. */
export interface MemberPathSeg {
  /** `PrefabInstance.parentLocalId || localId` — 0 when the entity is not from a prefab. */
  stepId: number;
  /** Child name. The diagnostic, and the fallback key when `stepId` is 0. */
  name: string;
  /** Tie-break among siblings identical in both fields above. Only reachable for non-prefab
   *  entities, where there is no authored key to tell them apart. */
  ordinal: number;
}

/** A resident pooled entry, as the re-target sees it. */
export interface ResidentEntry {
  x: number;
  y: number;
  /** Entity id of the pooled entry ROOT. */
  rootId: number;
}

type ChildIndex = Map<number, { id: number; name: string }[]>;
/** `PrefabInstance.parentLocalId || localId` for an entity id; 0 when it has no PrefabInstance. */
export type StepIdOf = (id: number) => number;

const sameKey = (a: MemberPathSeg, stepId: number, name: string): boolean =>
  stepId !== 0 ? stepId === a.stepId : a.stepId === 0 && a.name === name;

/** Derive the path from `rootId` down to the last id in `chain`.
 *
 *  `chain` is the ids from the child of `rootId` down to the target, in that order — the caller
 *  produces it by walking `EntityAttributes.parentId` up from the focused entity, which costs
 *  O(depth) instead of inverting an index over the whole world.
 *
 *  Returns `[]` for an empty chain (the target IS the root), and `null` when a link is not
 *  actually a child of the one above it — the honest answer rather than a partial path. */
export function describeMemberPath(
  index: ChildIndex,
  stepIdOf: StepIdOf,
  rootId: number,
  chain: readonly number[],
): MemberPathSeg[] | null {
  const segs: MemberPathSeg[] = [];
  let parent = rootId;
  for (const id of chain) {
    const siblings = index.get(parent);
    if (!siblings) return null;
    const self = siblings.find(s => s.id === id);
    if (!self) return null;                    // not a child of `parent` — a corrupt chain
    const stepId = stepIdOf(id);
    let ordinal = 0;
    if (stepId === 0) {
      // Only the no-PrefabInstance fallback needs a positional tie-break, and only among
      // siblings that are ALSO keyless and identically named.
      for (const s of siblings) {
        if (s.id === id) break;
        if (s.name === self.name && stepIdOf(s.id) === 0) ordinal++;
      }
    }
    segs.push({ stepId, name: self.name, ordinal });
    parent = id;
  }
  return segs;
}

/** Walk a derived path back down from a DIFFERENT root. Returns 0 on any miss — a pool whose
 *  instances are not structurally identical is the only way that happens, and re-targeting into
 *  a member that does not exist would be worse than not re-targeting at all. */
export function resolveMemberPathSegs(
  index: ChildIndex,
  stepIdOf: StepIdOf,
  rootId: number,
  segs: readonly MemberPathSeg[],
): number {
  let cur = rootId;
  for (const seg of segs) {
    const children = index.get(cur);
    if (!children) return 0;
    let seen = 0;
    let hit = 0;
    for (const c of children) {
      if (!sameKey(seg, stepIdOf(c.id), c.name)) continue;
      if (seen === seg.ordinal) { hit = c.id; break; }
      seen++;
    }
    if (!hit) return 0;
    cur = hit;
  }
  return cur;
}

/** Which resident entry should hold focus, given where it was.
 *
 *  Exact hit wins. Otherwise CLAMP each axis independently into the resident range and take that
 *  pair — for a strip, a pager and a rectangular grid window (every shape the system produces)
 *  the clamped pair is itself resident, so focus lands on the edge entry in the direction the
 *  view travelled. The squared-distance fallback exists for the case a clamped pair is somehow
 *  absent (a partially-live window at the data's far corner); it is a backstop, not the rule.
 *
 *  `null` when nothing is resident — there is genuinely nowhere to put focus, and the caller
 *  leaves it alone rather than inventing a target. */
export function pickRetargetEntry(
  from: { x: number; y: number },
  resident: readonly ResidentEntry[],
): ResidentEntry | null {
  if (resident.length === 0) return null;
  const exact = resident.find(r => r.x === from.x && r.y === from.y);
  if (exact) return exact;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of resident) {
    if (r.x < minX) minX = r.x;
    if (r.x > maxX) maxX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.y > maxY) maxY = r.y;
  }
  const cx = Math.min(maxX, Math.max(minX, from.x));
  const cy = Math.min(maxY, Math.max(minY, from.y));
  const clamped = resident.find(r => r.x === cx && r.y === cy);
  if (clamped) return clamped;

  let best = resident[0];
  let bestD = Infinity;
  for (const r of resident) {
    const dx = r.x - from.x;
    const dy = r.y - from.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
