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

/** One marker set per flush IN FLIGHT: the paths whose park that flush's batch is holding, and
 *  which a live application has since superseded.
 *
 *  ⚠️ **Why the markers are needed at all.** The re-park's `!pending.has(path)` guard can only see
 *  a newer PARKED claim, and the live branch's `pending.delete` is a no-op during a flush — the map
 *  is already empty — so it leaves no trace. Measured: park OLD on scene B → Cmd+S → B's mutation
 *  fails (a renamed scene 404s) → while it is in flight the human OPENS B and sets NEW → the flush
 *  re-parks OLD → the next Cmd+S writes NEW from `_currentBaseScene` and then this flush mutates
 *  the file back to OLD. Exactly the revert the live branch's discard exists to prevent, restored
 *  through the error path.
 *
 *  ⚠️ **And why it is a set PER FLUSH rather than one shared set.** Two flushes really can overlap:
 *  a human Cmd+S goes through `runSaveAll`'s `_inFlight` coalescing, but the `save-all` AGENT op
 *  calls `saveAll()` directly, so `modoki_save_all` landing during a human save gives two. A single
 *  module-level set cleared by whichever flush starts next erases the markers the FIRST one is
 *  still holding, and its re-park falls back to `!pending.has(path)` alone — the hole above,
 *  reopened by the very mechanism closing it. A live application adds the path to EVERY set,
 *  because each in-flight flush is separately holding a batch that may contain it. */
const activeFlushMarkers = new Set<Set<string>>();

let _version = 0;
const listeners = new Set<() => void>();
function bump(): void { _version += 1; for (const fn of listeners) fn(); }

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
 *  resolves to nothing and reads as a broken link rather than as "no base" (A3). */
export function applyBaseSceneEdit(
  path: string,
  value: string,
  currentScenePath: string | null,
  setLiveBaseScene: (baseScene: string | undefined) => void,
): 'live' | 'parked' {
  if (currentScenePath === path) {
    setLiveBaseScene(value || undefined);
    // ⚠️ Mark the path SUPERSEDED for every flush in flight, even when nothing is parked for it
    // right now: a flush is holding its batch out of the map, and this is the only record its
    // re-park can read. No flush in flight ⇒ no sets ⇒ the `delete` below is the whole story.
    for (const markers of activeFlushMarkers) markers.add(path);
    // …and DISCARD any park still held for it — it is superseded, and leaving it is silent
    // data loss with the newer value on the losing side. Reachable in the ordinary way: set a base
    // on scene B in the Assets panel (parks), then OPEN B and change it again (live). The scene
    // write puts the NEW ref in the file and `flushPendingBaseScenes`, which runs after it, mutates
    // the file back to the OLD one — the exact revert #831 fixed, reached from the other side. The
    // Cmd+Z variant is the same: undo applies `old` live while the stale park still writes `next`.
    if (pending.delete(path)) bump();
    return 'live';
  }
  markBaseSceneEdit(path, value || null);
  return 'parked';
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
 *  ⚠️ No agent op reaches this yet. `discard_asset_edits` deliberately does NOT — its contract is
 *  asset DOCUMENTS, and quietly widening it would make a caller asking for one thing get another.
 *  So today the only way to back one of these out is to set the field again in the panel. Worth an
 *  op if a second caller ever needs it; not worth inventing one for a hypothetical.
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
  /** THIS flush's markers, registered for the duration so a live application can reach it.
   *
   *  The `finally` below is HYGIENE, not correctness — a leaked set would keep collecting marks
   *  that nothing reads, since every flush reads only its own. Said plainly because a draft of the
   *  test for it asserted a behaviour change that does not exist, and passed against a deliberately
   *  broken unregister; there is no test here because there is nothing observable to assert. */
  const superseded = new Set<string>();
  activeFlushMarkers.add(superseded);
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
      const { ok, errors } = await mutateScene(path, baseScene);
      if (ok) { saved.push(path); continue; }
      failed.push({ path, error: errors.join('; ') || 'the scene mutation was rejected' });
      toRepark.push([path, baseScene]);
    }
    for (const [path, baseScene] of toRepark) {
      // Only if nothing newer claimed the path while the flush was in flight — the same rule
      // `flushDirtyAssets` applies to its own deletes, and for the same reason: an edit made
      // during the save is on screen, is not on disk, and must not be replaced by an older value.
      // "Newer" is BOTH shapes: a newer park (`pending.has`) and a newer LIVE application, which
      // parks nothing and would otherwise be invisible here — see `activeFlushMarkers`.
      if (!pending.has(path) && !superseded.has(path)) pending.set(path, baseScene);
    }
    if (failed.length) bump();
    return { saved, failed };
  } finally {
    activeFlushMarkers.delete(superseded);
  }
}
