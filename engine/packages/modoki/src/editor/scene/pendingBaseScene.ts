/** Pending `baseScene` edits — the manual-save half of the Scene inspector (#831).
 *
 *  `SceneAssetView` sets one field on a `.scene.json`: its `baseScene` ref. That edit used to POST
 *  `/api/scene-mutate` the moment the field changed — no save action, while `get_editor_state`
 *  reported `persistenceMode:'manual'` — which is the same defect the four asset views had, just
 *  down a different route. Now it waits for Cmd+S like everything else.
 *
 *  ## Why this is NOT the dirty-asset registry
 *
 *  That registry parks whole DOCUMENTS and flushes them through `/api/asset-write`. A scene is not
 *  a static asset document: it is also what the live editor world serializes INTO on save, so a
 *  whole-file overwrite would silently destroy unsaved live-world changes. `/api/scene-mutate`
 *  exists precisely to edit one field of a scene FILE without touching the rest, and it carries
 *  the guards that matter here — it refuses while Playing/Paused, and it refuses when the editor
 *  holds unsaved live work that its own write would hot-reload away.
 *
 *  ## The open scene does not come through here at all
 *
 *  When the edited path IS the currently-open scene, there is a better answer than a file
 *  mutation: `setCurrentBaseScene`, the editor module state `serializeScene` already emits from.
 *  The panel applies it live and marks the scene dirty, and Cmd+S writes it with everything else.
 *
 *  ⚠️ **That is also a bug fix, not just tidiness.** `serializeScene` emits `baseScene` from
 *  `_currentBaseScene`, which was only ever set at LOAD — the panel never updated it. So setting a
 *  base on the open scene put the ref in the file, and the next Cmd+S serialised the stale module
 *  value straight back over it. Applying live is what makes the two agree.
 *
 *  ## The flush runs LAST, and takes its entries before it issues anything
 *
 *  Both are forced by the guard above, and neither is arbitrary:
 *
 *   - **Last** (after `flushDirtyAssets` and after the scene writes), because `/api/scene-mutate`
 *     refuses while `hasUnsavedChanges()` is true. Run first, every mutation would 409 against the
 *     very save that is trying to persist it.
 *   - **Taken first**, because `hasUnsavedChanges()` counts THESE entries too (it must — an
 *     unsaved edit the editor cannot see is the silent-loss trap `unsavedChanges` exists to
 *     close), so a flush that left them parked while calling would 409 against itself. Anything
 *     that fails is re-parked, so a failed flush is still pending and still reported. */

import { backendFetch } from '../backend/editorBackend';
import { notifyListeners } from '../../runtime/core/notifyListeners';
import { toOpenProjectScenePath } from './openProjectScenePath';

/** Set (or clear, with `null`) the `baseScene` ref on a scene FILE.
 *
 *  Lives here rather than in `SceneAssetView.tsx` so the flush can call it without a `.tsx`
 *  import — and so it is unit-testable without mounting a panel (docs/editor.md § Panels). */
export async function mutateScene(path: string, baseScene: string | null): Promise<{ ok: boolean; errors: string[] }> {
  // Resolve `{ok:false}` on a THROWN request too, matching every sibling backend wrapper in
  // assetOps (each is `try { … return res.ok } catch { return false }`). Without this the fetch
  // rejection escaped into the panel's undo/redo closures — and a throw from an undo closure is
  // the one failure mode #308 rules out: `undo()` pops the action BEFORE awaiting it, so the
  // rejection skips `redoStack.push` and the `!undo` event and loses the action from BOTH stacks.
  // An HTTP error already resolved false; only a network-level failure could throw, which is
  // exactly when the editor is least able to afford losing an undo entry.
  let res: Response;
  try {
    res = await backendFetch('/api/scene-mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ops: [{ op: 'setBaseScene', baseScene }] }),
    });
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const body = await res.json().catch(() => ({ ok: false, errors: [`HTTP ${res.status}`] }));
  return { ok: res.ok && body.ok !== false, errors: body.errors ?? (res.ok ? [] : [body.error ?? `HTTP ${res.status}`]) };
}

/** path -> the base ref to write (`null` clears it). Last edit to a path wins, exactly like the
 *  dirty-asset registry: a second edit before a save simply supersedes the first. */
const pending = new Map<string, string | null>();

/** Do two spellings name the same scene FILE? The open-project `/@fs/` form folds to `/assets/…`, and case is ignored
 *  as `classifyExplicitSceneSave` already ignores it (#1273). A park is keyed by the manifest's spelling, while the open
 *  scene can carry an agent's (`copy` against `Copy`, #2069 row 6). */
export function sameSceneFile(a: string, b: string): boolean {
  return toOpenProjectScenePath(a).toLowerCase() === toOpenProjectScenePath(b).toLowerCase();
}

/** One record per flush IN FLIGHT: the batch it took out of the map, and the paths in it that have since been
 *  superseded, by a live application or by {@link reconcileBaseScenePark}.
 *
 *  ⚠️ **Why the markers are needed at all.** The re-park's `!pending.has(path)` guard can only see
 *  a newer PARKED claim, and the live branch's `pending.delete` is a no-op during a flush — the map
 *  is already empty — so it leaves no trace. Measured: park OLD on scene B → Cmd+S → B's mutation
 *  fails (a renamed scene 404s) → while it is in flight the human OPENS B and sets NEW → the flush
 *  re-parks OLD → the next Cmd+S writes NEW from `_currentBaseScene` and then this flush mutates
 *  the file back to OLD. Exactly the revert the live branch's discard exists to prevent, restored
 *  through the error path.
 *
 *  ⚠️ **And why it is a record PER FLUSH rather than one shared set.** The save entry points are serialised since
 *  #2069 (`saveQueue.ts`), so two of THEIRS no longer overlap. But a flush can still be called outside that queue, and
 *  one shared set cleared by whichever flush starts next would erase the markers an earlier one is still holding. A
 *  live application marks EVERY record, because each in-flight flush is separately holding a batch that may contain it.
 *
 *  The batch is kept so that a scene OPENED while its park is in flight still gets the edit (#2069): the park is out
 *  of the map by then, and this is the only place its value still lives. */
interface InFlightFlush {
  readonly batch: ReadonlyMap<string, string | null>;
  readonly superseded: Set<string>;
}
const activeFlushes = new Set<InFlightFlush>();

let _version = 0;
const listeners = new Set<() => void>();
function bump(): void { _version += 1; notifyListeners(listeners, 'pendingBaseScene', []); }

/** Subscribe to changes (park / flush / discard). Returns an unsubscribe. */
export function subscribePendingBaseScenes(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Monotonic change counter — the `getSnapshot` for a `useSyncExternalStore` subscriber. */
export function getPendingBaseScenesVersion(): number { return _version; }

/** Park a base-scene edit for `path`. */
export function markBaseSceneEdit(path: string, baseScene: string | null): void {
  pending.set(path, baseScene);
  bump();
}

/** Apply a base-scene edit, choosing the route by whether this is the OPEN scene. Returns which
 *  route it took, so a caller (and a test) can tell them apart.
 *
 *  This is the decision `SceneAssetView` used to make inline, extracted for the usual reason: the
 *  panel is a `.tsx` and does not get mounted in a test (docs/editor.md § Panels), so a branch
 *  living inside it is a branch nothing can see. It is the whole of #831's Scene half.
 *
 *  `setLiveBaseScene` is INJECTED rather than imported because `serialize.ts` imports this module
 *  (for the flush and the unsaved-work count) — importing it back would be a cycle. Production
 *  passes `setCurrentBaseScene`.
 *
 *  ⚠️ `undefined`, not `''`, for an unset base on the live path: `serializeScene` emits the field
 *  only when it is truthy, and an empty string would be written as `baseScene: ""` — a ref that
 *  resolves to nothing and reads as a broken link rather than as "no base" (A3).
 *
 *  ⚠️ The open scene is matched by FILE ({@link sameSceneFile}), not by string (#2069). A park made under another
 *  spelling of the open scene is a park ON the open scene, and the flush would write it file-direct for the next save
 *  to overwrite with the stale base. This is the "normalise both sides" the panel's comment asks for. */
export function applyBaseSceneEdit(
  path: string,
  value: string,
  currentScenePath: string | null,
  setLiveBaseScene: (baseScene: string | undefined) => void,
): 'live' | 'parked' {
  if (currentScenePath !== null && sameSceneFile(currentScenePath, path)) {
    setLiveBaseScene(value || undefined);
    // ⚠️ Mark the path SUPERSEDED for every flush in flight, even when nothing is parked for it
    // right now: a flush is holding its batch out of the map, and this is the only record its
    // re-park can read. No flush in flight ⇒ no records ⇒ the `delete` below is the whole story.
    for (const flush of activeFlushes) for (const key of flush.batch.keys()) if (sameSceneFile(key, path)) flush.superseded.add(key);
    // …and DISCARD any park still held for it — it is superseded, and leaving it is silent
    // data loss with the newer value on the losing side. Reachable in the ordinary way: set a base
    // on scene B in the Assets panel (parks), then OPEN B and change it again (live). The scene
    // write puts the NEW ref in the file and `flushPendingBaseScenes`, which runs after it, mutates
    // the file back to the OLD one — the exact revert #831 fixed, reached from the other side. The
    // Cmd+Z variant is the same: undo applies `old` live while the stale park still writes `next`.
    let dropped = false;
    for (const key of [...pending.keys()]) if (sameSceneFile(key, path)) dropped = pending.delete(key) || dropped;
    if (dropped) bump();
    return 'live';
  }
  markBaseSceneEdit(path, value || null);
  return 'parked';
}

/** What {@link reconcileBaseScenePark} did. `applied` carries the ref now live (`null` = cleared). */
export type ParkReconcile = { applied: string | null } | { dropped: true } | null;

/** THE check for a park whose file becomes — or is replaced by — the open scene (#2069). Every route that makes a
 *  path the open scene ends here, so no park can outlive it into the flush, where it would be written file-direct
 *  onto the open scene's file and then overwritten by the stale in-memory base on the next save (reported ok twice).
 *
 *  Two rules, by what happened to the FILE (hub ruling, #2069):
 *   - `'opened'` — the file was READ into the live world (a load, a hot reload). The human's pending edit must
 *     survive, so it is APPLIED to the opened document through `setLive`; the caller marks the scene unsaved.
 *   - `'replaced'` — the live world's bytes were written over the file, or bound to it to be written there (Save As,
 *     an untitled scene saved over it, the dialog's Replace, Create Scene over it). The edit was to bytes that are
 *     gone, so it is DROPPED, as #2050 dropped it; the caller reports the drop.
 *
 *  Both look in the map AND in every flush in flight, matching by FILE: a park keyed under another spelling is the
 *  same park (row 6), and one a flush took out of the map is still pending until its write lands (rows 7–8). An
 *  in-flight entry is marked superseded either way — the flush then skips it if it has not reached it yet, and never
 *  re-parks it. A parked edit is newer than any in-flight one (a flush takes its batch before it starts), so it wins.
 *
 *  ⚠️ An in-flight write that is already on the wire cannot be recalled. For `'opened'` that is harmless — it writes
 *  the same value the world now holds, or the route refuses it because the world is unsaved. For `'replaced'` it is
 *  closed by ORDER rather than here: every replace route runs inside the save queue (`saveQueue.ts`), so no flush is
 *  in flight while it runs. */
export function reconcileBaseScenePark(
  path: string,
  how: 'opened' | 'replaced',
  setLive?: (baseScene: string | undefined) => void,
): ParkReconcile {
  let found: { value: string | null } | null = null;
  for (const flush of activeFlushes) {
    for (const [key, value] of flush.batch) {
      // An entry already superseded is not this flush's to hand out again: a second open of the same file in one flush
      // (a hot reload, a reopen after Discard) would otherwise re-apply the old value over a newer live edit.
      if (!sameSceneFile(key, path) || flush.superseded.has(key)) continue;
      flush.superseded.add(key);
      found = { value };
    }
  }
  let unparked = false;
  for (const [key, value] of [...pending]) {
    if (!sameSceneFile(key, path)) continue;
    pending.delete(key);
    unparked = true;
    found = { value };
  }
  if (unparked) bump();
  if (!found) return null;
  if (how === 'replaced') return { dropped: true };
  setLive?.(found.value || undefined);
  return { applied: found.value };
}

/** The parked base ref for `path`, or `undefined` when nothing is pending for it.
 *
 *  ⚠️ `undefined` means NOT PENDING and `null` means PENDING A CLEAR — a distinction a caller
 *  must not flatten, because "no base" and "no edit" send the panel to different places (its own
 *  loaded value, or the empty string it must now show). */
export function peekBaseSceneEdit(path: string | undefined): string | null | undefined {
  return path ? pending.get(path) : undefined;
}

/** Is a base-scene edit parked for exactly this path? A panel's dirty indicator. */
export function isBaseSceneDirty(path: string | undefined): boolean {
  return !!path && pending.has(path);
}

/** True if any base-scene edit is pending a save. Folded into `hasUnsavedChanges()`. */
export function hasPendingBaseScenes(): boolean { return pending.size > 0; }

/** The pending paths, for `get_editor_state` — an agent must be able to SEE what a discard or a
 *  scene swap would cost, the same way `dirtyAssetPaths` already does for asset docs. */
export function getPendingBaseScenePaths(): string[] { return [...pending.keys()]; }

/** Test-only: drop every pending entry without writing it. */
export function clearPendingBaseScenes(): void { pending.clear(); bump(); }

/** Drop pending base-scene edits WITHOUT writing them. `paths` omitted = drop everything.
 *
 *  ⚠️ `discard_asset_edits` deliberately does NOT reach this — its contract is asset DOCUMENTS, and
 *  quietly widening it would make a caller asking for one thing get another.
 *
 *  ⚠️ **`resolve-unsaved` DOES, since #889** (`DISCARDERS.pendingBaseScene`), so the "no agent op
 *  reaches this yet" that stood here is no longer true. It is reachable only by naming
 *  `discard: ['pendingBaseScene']` explicitly — no Node route passes that today (`/api/write-meta`
 *  passes `['pendingMeta']` and nothing else), so in practice it is `modoki_eval`-only. That is a
 *  deliberately narrow surface, not an oversight: the discard is registry-SCOPED precisely so a
 *  route cannot drop state it never asked about.
 *  Mirrors `discardDirtyAssets`, including telling a caller apart from a typo: "I dropped your
 *  edit" and "there was nothing to drop" are different answers. */
export function discardPendingBaseScenes(paths?: readonly string[]): { discarded: string[]; notPending: string[] } {
  if (!paths) {
    const discarded = [...pending.keys()];
    pending.clear();
    if (discarded.length) bump();
    return { discarded, notPending: [] };
  }
  const discarded: string[] = [];
  const notPending: string[] = [];
  for (const p of paths) (pending.delete(p) ? discarded : notPending).push(p);
  if (discarded.length) bump();
  return { discarded, notPending };
}

export interface BaseSceneFlushResult {
  /** Paths written successfully. */
  saved: string[];
  /** Paths whose mutation was refused or failed — RE-PARKED, so still pending and still counted
   *  by `hasUnsavedChanges()`. A failed flush is never silently dropped. */
  failed: Array<{ path: string; error: string }>;
}

/** Write every pending base-scene edit through `/api/scene-mutate`. Called by `saveAll`, LAST —
 *  see this module's header for why the order and the take-first are both load-bearing.
 *
 *  Independent failures: one refused scene does not block the others. */
export async function flushPendingBaseScenes(): Promise<BaseSceneFlushResult> {
  const saved: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  // Take the whole set out BEFORE issuing anything: the route refuses while the editor reports
  // unsaved work, and these entries are part of that report.
  const batch = [...pending.entries()];
  if (!batch.length) return { saved, failed };
  pending.clear();
  bump();
  /** THIS flush's record, registered for the duration so a live application or an open can reach it.
   *
   *  The `finally` below is HYGIENE, not correctness — a leaked record would keep collecting marks
   *  that nothing reads, since every flush reads only its own. Said plainly because a draft of the
   *  test for it asserted a behaviour change that does not exist, and passed against a deliberately
   *  broken unregister; there is no test here because there is nothing observable to assert. */
  const superseded = new Set<string>();
  const flush: InFlightFlush = { batch: new Map(batch), superseded };
  activeFlushes.add(flush);
  try {
    /** Entries to put back, collected and applied AFTER the loop.
     *
     *  ⚠️ Re-parking INSIDE the loop poisons every later entry in the same flush. The route
     *  refuses while the editor reports unsaved work, `hasUnsavedChanges()` counts these entries,
     *  and the first re-park makes that true again — so with `{A, B}` and A failing for its own
     *  reason (a 404 on a renamed scene, say), B is refused with "the editor has unsaved live
     *  changes" when the only unsaved thing IS A, and B can never be written while A keeps
     *  failing. The take-first above exists precisely to keep the report empty for the duration of
     *  the flush; re-parking mid-loop undid it after the first failure. */
    const toRepark: Array<[string, string | null]> = [];
    for (const [path, baseScene] of batch) {
      // Superseded before its turn — applied live, applied to the scene just opened, or dropped with a replaced file
      // (#2069). Written now it would land on the open scene's file, for the next save to overwrite with the stale
      // base. Whoever superseded it owns it, so it is neither saved nor failed here.
      if (superseded.has(path)) continue;
      const { ok, errors } = await mutateScene(path, baseScene);
      if (ok) { saved.push(path); continue; }
      // Superseded WHILE its mutate was on the wire (the route then refuses it, the world being unsaved): not pending,
      // not re-parked, so reporting it as a failure that "stays pending" would be false (#2069 row 7). Its owner reports it.
      if (superseded.has(path)) continue;
      failed.push({ path, error: errors.join('; ') || 'the scene mutation was rejected' });
      toRepark.push([path, baseScene]);
    }
    for (const [path, baseScene] of toRepark) {
      // Only if nothing newer claimed the path while the flush was in flight — the same rule
      // `flushDirtyAssets` applies to its own deletes, and for the same reason: an edit made
      // during the save is on screen, is not on disk, and must not be replaced by an older value.
      // "Newer" is BOTH shapes: a newer park (`pending.has`) and a newer LIVE application, which
      // parks nothing and would otherwise be invisible here — see `activeFlushes`.
      if (!pending.has(path) && !superseded.has(path)) pending.set(path, baseScene);
    }
    if (failed.length) bump();
    return { saved, failed };
  } finally {
    activeFlushes.delete(flush);
  }
}
