/** editorRefLiveness — the editor store's entity pointers follow their entity WITHIN a world (#1221).
 *
 *  `selectedEntityIds`/`selectedEntityId`, `animatorRootEntityId` and `directorRootEntityId` are bare
 *  ids with many readers (Hierarchy, SceneView's outline and gizmo, the Inspector, the Animation and
 *  Timeline panels, agent ops). `selectionRestore.ts` already remaps them across a world SWAP; nothing
 *  looked after them when an entity was destroyed inside one, so a newcomer on the recycled index —
 *  a board rebuilt during Play, an agent's delete-and-respawn — showed up selected, gizmo and
 *  Inspector included, or bound to the Animation panel.
 *
 *  So this module holds each pointer as a {@link HeldEntity} and re-resolves it on every structure
 *  change, writing the store only when something moved. The readers keep reading plain ids and
 *  change nothing: the one seam is here.
 *
 *  Two triggers, both needed:
 *  - **synchronously on every structure change** (`onStructureDirty`). `unregisterEntity` fires it
 *    after the index drops the entity and before `destroy()`, so the pointer is parked or dropped
 *    BEFORE any spawn can reclaim the index. A coalesced-only check would leave a frame in which the
 *    newcomer is selected — and a gizmo drag in that frame writes to it.
 *  - **a frame later** (`onStructureDirtyCoalesced`), for a PARKED pointer. A seeded prefab respawn
 *    writes its guid after its spawn's structure event, so only a later look can find it — and that
 *    look is outside a structure change, so it may rescan (`resolveHeld`'s `rescan`).
 *
 *  ⚠️ **And after a world swap, every STALE pointer is re-taken from its id** — one tick later, and
 *  only the ones still held in another world (or never held); a pointer already held or parked in the
 *  current world is kept (`retakeStale`). A hold belongs to one World, and
 *  `resolveHeld` leaves another World's hold alone. Selection is re-taken anyway, because
 *  `selectionRestore` always writes new arrays — but a root is re-taken only when its VALUE changes,
 *  and the Timeline panel's re-resolve usually lands on the same number (load order is deterministic)
 *  while nothing rewrites the Animator root at all. Without the re-take every root hold kept the
 *  pre-Stop world forever and the newcomer bug came back after the first Stop.
 *  Why a tick later, not inside the swap listener: `stepSimulation`/`createTestWorld` swap OUT and
 *  BACK within one call. Re-taking at the swap held whatever sat at those numbers in the transient
 *  world, a destroy there dropped the root, and the swap back re-took null — an agent's sim step
 *  unbound the Animation panel. Deferred, a round trip is over before the re-take runs and finds the
 *  holds already in the current world. The cost is a one-tick window after a real load in which a
 *  destroy-and-respawn of a bound root is not caught (#1221 close-out reviews).
 *
 *  A write the store receives from anywhere else (a click, `selectionRestore`'s remap, an agent op, an
 *  undo) re-captures from the new ids and forgets any parked pointer — the user has moved on. This
 *  module's own writes are not re-captured, or the parked pointers would be lost the moment they are
 *  hidden. The write goes through `setState`, not a selection action, so it pushes no undo entry. */

import { getCurrentWorld, onWorldSwap } from '../../runtime/core/ecs/world';
import { onStructureDirty, onStructureDirtyCoalesced } from '../../runtime/core/ecs/entityUtils';
import { useEditorStore } from './editorStore';
import type { World } from 'koota';
import { holdEntity, resolveHeld, type HeldEntity } from './heldEntity';

/** One pointer: the id the store shows (null while parked), and its hold (null when the id named no
 *  registered entity when taken — such an id is passed through untouched). */
interface Pointer { readonly id: number | null; readonly held: HeldEntity | null }

let selection: Pointer[] = [];
let primary: Pointer | null = null;
let animatorRoot: Pointer | null = null;
let directorRoot: Pointer | null = null;
let writing = false;
/** The three subscriptions `registerEditorRefLiveness` takes (null when not registered). */
let unsubscribe: { store: () => void; sync: () => void; frame: () => void; swap: () => void } | null = null;

function take(id: number | null): Pointer | null {
  if (id === null) return null;
  return { id, held: holdEntity(id, getCurrentWorld()) };
}

type Snapshot = ReturnType<typeof useEditorStore.getState>;

function captureSelection(s: Snapshot): void {
  selection = s.selectedEntityIds.map((id) => take(id)!);
  primary = s.selectedEntityId === null ? null : (selection.find((p) => p.id === s.selectedEntityId) ?? take(s.selectedEntityId));
}

function onStoreChange(s: Snapshot, prev: Snapshot): void {
  if (writing) return;
  if (s.selectedEntityIds !== prev.selectedEntityIds || s.selectedEntityId !== prev.selectedEntityId) captureSelection(s);
  if (s.animatorRootEntityId !== prev.animatorRootEntityId) animatorRoot = take(s.animatorRootEntityId);
  if (s.directorRootEntityId !== prev.directorRootEntityId) directorRoot = take(s.directorRootEntityId);
}

/** Re-resolve every held pointer against `world` and write the store if any moved. Exported for tests;
 *  in the editor the structure listeners call it. */
export function reconcileEditorRefs(world = getCurrentWorld(), opts: { rescan?: boolean } = {}): void {
  if (selection.length === 0 && !primary && !animatorRoot && !directorRoot) return;
  let selectionMoved = false;
  let rootsMoved = false;
  const resolved = new Map<Pointer, Pointer | null>();
  const resolve = (p: Pointer): Pointer | null => {
    const hit = resolved.get(p);
    if (hit !== undefined || resolved.has(p)) return hit ?? null;
    let out: Pointer | null = p;
    if (p.held) {
      const r = resolveHeld(p.held, world, opts);
      if (r !== p.held) out = r ? { id: r.id, held: r } : null;
    }
    resolved.set(p, out);
    return out;
  };

  const nextSelection: Pointer[] = [];
  for (const p of selection) {
    const r = resolve(p);
    if (r !== p) selectionMoved = true;
    if (r) nextSelection.push(r);
  }
  const nextPrimary = primary ? resolve(primary) : null;
  if (nextPrimary !== primary) selectionMoved = true;
  const nextAnimator = animatorRoot ? resolve(animatorRoot) : null;
  const nextDirector = directorRoot ? resolve(directorRoot) : null;
  if (nextAnimator !== animatorRoot || nextDirector !== directorRoot) rootsMoved = true;
  if (!selectionMoved && !rootsMoved) return;

  selection = nextSelection;
  primary = nextPrimary;
  animatorRoot = nextAnimator;
  directorRoot = nextDirector;

  const patch: Partial<Snapshot> = {};
  if (selectionMoved) {
    const ids = [...new Set(selection.flatMap((p) => (p.id === null ? [] : [p.id])))];
    const primaryId = primary?.id ?? null;
    // Keep the primary inside the set; fall back to the last remaining member (selectionRestore's rule).
    patch.selectedEntityIds = ids;
    patch.selectedEntityId = primaryId !== null && (ids.includes(primaryId) || ids.length === 0) ? primaryId : (ids[ids.length - 1] ?? null);
  }
  if (rootsMoved) {
    patch.animatorRootEntityId = animatorRoot?.id ?? null;
    patch.directorRootEntityId = directorRoot?.id ?? null;
  }
  writing = true;
  try { useEditorStore.setState(patch); } finally { writing = false; }
}

let retakeTimer: ReturnType<typeof setTimeout> | null = null;

/** After a swap: re-take every pointer next tick, unless its holds already belong to the current world
 *  (a swap out and back). See the module header. */
function scheduleRetake(): void {
  if (retakeTimer !== null) return;
  retakeTimer = setTimeout(() => {
    retakeTimer = null;
    if (unsubscribe) retakeStale(getCurrentWorld());
  }, 0);
}

/** A pointer the swap left behind: held in another world, or an id that named nothing when taken. */
function isStale(p: Pointer | null, world: World): p is Pointer {
  return p !== null && (p.held ? p.held.world !== world : p.id !== null);
}

/** Re-take ONLY the stale pointers, keeping every pointer already held in `world` — including one
 *  PARKED there since the swap. Re-taking everything from the store (the first cut) forgot such a park,
 *  so a seeded respawn in the first tick after a load was never followed (final close-out review). */
function retakeStale(world: World): void {
  const retake = (p: Pointer): Pointer | null => (p.id === null ? null : { id: p.id, held: holdEntity(p.id, world) });
  const mapped = new Map<Pointer, Pointer | null>();
  const map = (p: Pointer | null): Pointer | null => {
    if (!isStale(p, world)) return p;
    if (!mapped.has(p)) mapped.set(p, retake(p));
    return mapped.get(p)!;
  };
  selection = selection.map(map).filter((p): p is Pointer => p !== null);
  primary = map(primary);
  animatorRoot = map(animatorRoot);
  directorRoot = map(directorRoot);
}

/** Hold every pointer afresh from the store's current ids, in the current world. Parked pointers are
 *  forgotten: their guid belonged to the outgoing world's session. */
function retakeAll(): void {
  const s = useEditorStore.getState();
  captureSelection(s);
  animatorRoot = take(s.animatorRootEntityId);
  directorRoot = take(s.directorRootEntityId);
}

/** Start following. Idempotent — call once at editor startup, beside `registerSelectionRestore`. */
export function registerEditorRefLiveness(): void {
  if (unsubscribe) return;
  retakeAll();
  unsubscribe = {
    store: useEditorStore.subscribe(onStoreChange),
    sync: onStructureDirty(() => reconcileEditorRefs()),
    frame: onStructureDirtyCoalesced(() => reconcileEditorRefs(undefined, { rescan: true })),
    swap: onWorldSwap(() => scheduleRetake()),
  };
}

/** Stop following and forget every pointer (tests; HMR). */
export function unregisterEditorRefLiveness(): void {
  if (unsubscribe) { unsubscribe.store(); unsubscribe.sync(); unsubscribe.frame(); unsubscribe.swap(); }
  if (retakeTimer !== null) { clearTimeout(retakeTimer); retakeTimer = null; }
  unsubscribe = null;
  selection = [];
  primary = null;
  animatorRoot = null;
  directorRoot = null;
}

// HMR: the replacement module re-registers if this one was live, or an edit here would silently stop
// the following for the rest of the session (createEditor registers only once, at boot).
if (import.meta.hot) {
  if ((import.meta.hot.data as { wasRegistered?: boolean } | undefined)?.wasRegistered) registerEditorRefLiveness(); // no `data` under vitest
  import.meta.hot.dispose((data: { wasRegistered?: boolean } | undefined) => {
    if (data) data.wasRegistered = unsubscribe !== null;
    unregisterEditorRefLiveness();
  });
}
