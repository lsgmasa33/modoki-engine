/** The editor's ONE adoption owner (#1698): the only writer of the editor's scene state, and the one place that decides
 *  whether a world a route loaded is still the world to adopt.
 *
 *  `SceneManager` owns the world; the editor ADOPTS it afterwards. That state is the scene path (and its persisted
 *  last-scene key), the base scene, the undo-history key, the dirty baseline, the prefab-edit flag and the
 *  `!scene-load` journal entry. It used to be written at six sites, each with its own rule, and the one guarded site
 *  (`serialize.loadScene`, #495) decided "superseded" by REQUEST order: a newer request that then installed nothing
 *  still silenced the load whose world was on screen (#1688). Here supersession is decided by the WORLD
 *  (docs/scene-loading.md § "Load supersession: states and invariants", S5–S8):
 *
 *  - **Adopt iff the world is current.** A route offers the world `SceneManager` PROMOTED for it
 *    (`SceneLoadResult.world`, never `getCurrentWorld()` read after the await, which names a newer world). A world
 *    that is no longer current is not adopted, and nothing is written.
 *  - **A restore is the adopter** (hub, 2026-09-28): a Stop, a preview exit or an undo restore that replaces the world
 *    under the SAME key writes nothing, and every older pending record is then dropped by the rule above.
 *  - **The leave debt (S7) is derived from `lastAdopted`**, the owner's own record of what it adopted last — not from
 *    the edit flag, which `isEditingPrefab` clears on any swap. Debts are a SET, not one slot (#1690). One is cleared
 *    only by a repair that completes in the world it started in.
 *  - **The debts are run by the last world switch to END**, whatever its outcome ({@link settleLeaveDebts}): while
 *    another route is still pending, or a scene load is still in flight, a repair would be cut in half by its swap.
 *
 *  `serialize.ts` owns the state these writes land in, and imports this module, so it BINDS its writers here
 *  ({@link bindEditorSceneState}) instead of this module importing it back — the same reason `prefabEditWorld.ts` is
 *  a leaf. */

import { installAdoptionGate } from './adoptionGate';
import type { World } from 'koota';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { notifyListeners } from '../../runtime/core/notifyListeners';
import { createTeardownToken, createSupersessionToken, type LivenessCheck } from '../../runtime/core/liveness';
import { getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { swapHistory, activeHistoryKey } from '../undo/undoManager';
import { PREFAB_EDIT_SCENE_PREFIX } from '../../runtime/core/ecs/sceneLoaded';
import { useEditorStore } from '../store/editorStore';
import { editorEmit } from '../editorJournal';
import { clearSceneDirtyExcept, dirtySceneGuidsSnapshot, hasDirtySceneOutside } from './sceneDirty';
import { refreshPrefabSourceForPath, rebaseStaleInstances } from './prefab';
import { registerPosedWorldSource } from './authoredWorld';
import { normScenePath } from '../../runtime/scene/scenePathKey';

/** The editor scene state `serialize.ts` owns, bound at its module load. */
export interface EditorSceneStateBinding {
  setScenePath(path: string | null): void;
  setBaseScene(baseScene: string | undefined): void;
  /** The live world is the new clean baseline (`markSceneSaved`). */
  markSaved(): void;
  /** The PRIMARY world has edits since the baseline (`CAUSE_SPECS.sceneDirty`). */
  worldEdited(): boolean;
  /** How many `serialize.loadScene` calls are still COMING: past their entry (waiting included) and not yet in their
   *  `finally`. A load in its `finally` is settling itself, so it does not hold another settle off. */
  sceneLoadsComing(): number;
  /** Of those, the ones PAST their wait for the undo step in flight (#1579). Only these hold `adoptionsSettled` —
   *  a load still waiting for an undo step must not, or a writer inside that step waits for the load that waits for it
   *  (close-out re-review of #1698). */
  sceneLoadsSwappingComing(): number;
}

let binding: EditorSceneStateBinding | null = null;
export function bindEditorSceneState(b: EditorSceneStateBinding): void { binding = b; }
function state(): EditorSceneStateBinding {
  if (!binding) throw new Error('[sceneAdoption] serialize.ts has not bound the editor scene state');
  return binding;
}

/** Which route replaced the world — what a pending entry names. */
export type AdoptionRoute = 'scene-load' | 'hot-reload' | 'prefab-edit-open' | 'prefab-undo-restore' | 'new-scene' | 'boot-fallback' | 'restore';

type EditedPrefab = { path: string; guid: string; name: string };

/** What a route adopts. Absent fields are left as they are — each route writes exactly what it owns. */
export interface AdoptionRecord {
  /** The world `SceneManager` promoted for this route. */
  readonly world: World;
  /** The editor scene path (persisted as the last-scene key when non-null). Absent: left alone — Create Scene wrote it
   *  BEFORE its await (#887), and a hot reload keeps it. */
  readonly path?: string | null;
  /** `'loaded'`: the base `SceneManager` recorded for this world. `'none'`: no base. Absent: left alone. */
  readonly baseScene?: 'loaded' | 'none';
  /** The undo-history key and the dirty baseline (S8). Absent: left alone — an undo restore runs INSIDE the history. */
  readonly history?: {
    readonly key: string;
    /** The bases the swap KEPT (`SceneLoadResult.keptBaseGuids`): their edits survived live. */
    readonly keptBaseGuids: ReadonlySet<string>;
    /** The incoming world is built from nothing (Create Scene), so no stack recorded under `key` matches it. */
    readonly freshIncoming?: boolean;
  };
  /** The world is the edit world of this prefab. Absent: it is not an edit world, and the flag is cleared. */
  readonly prefabEdit?: { readonly prefab: EditedPrefab; readonly returnScene: string | null };
  /** Journal `!scene-load` for this path. */
  readonly journal?: { readonly path: string };
}

/** A restore's world switch: it replaced the world under the SAME key ({@link withRestore}). */
export interface RestoreTicket {
  /** Adopt the restored world, writing nothing. False when it is no longer current. At most once per ticket. */
  restored(world: World): boolean;
}

/** One route's world switch, between the moment it is about to replace the world and its adopt ({@link withAdoption}). */
export interface AdoptionTicket extends RestoreTicket {
  readonly route: AdoptionRoute;
  /** The route is about to write editor state AHEAD of its swap (Create Scene's path, #887): until its offer or its end,
   *  that state describes a world that is not on screen yet, so {@link editorStateCurrent} is false (#1750 R1). */
  writingAhead(): void;
  /** Adopt `record` iff its world is current. Synchronous: every write lands in one run, so nothing can observe half an
   *  adoption. At most once per ticket — a second offer (or `restored`) throws. */
  offer(record: AdoptionRecord): boolean;
}

/** The world the owner adopted last, and — when it was an edit world whose session is still open — which prefab. */
let lastAdopted: { world: World | null; edit: EditedPrefab | null } = { world: null, edit: null };
/** Bumped by every adoption that writes (not by a restore). Exit's flag write compares it ({@link adoptionCount}). */
let adoptions = 0;
/** Bumped when the dirty BASELINE moves. A pre-swap dirt read counts only while it still matches (S8). */
let baselineSeq = 0;
/** Prefabs whose leave repair is owed — a set, so a second debt cannot replace the first (#1690). */
const owed = new Set<string | null>();
const pending = new Set<object>();
const pendingRoutes = new Map<object, AdoptionRoute>();
/** The routes that wrote editor state ahead of their swap and have not offered yet ({@link AdoptionTicket.writingAhead}). */
const ahead = new Set<object>();
/** The world each pending route registered in: once the world on screen differs, that route (or a newer one) has
 *  swapped, and until an adopt the editor state still describes the world it left ({@link editorStateCurrent}). */
const registeredIn = new Map<object, World>();
/** Invalidated by every adoption that writes — what {@link captureAdoption}'s check compares. */
const adoptionEpoch = createTeardownToken();
/** Scene FILES that changed on disk under a recorded undo stack (#1744's debt, moved here by #1750 S7): by
 *  {@link normScenePath} key, each change with its sequence number. Paid by the next adopt whose history swap goes TO
 *  that key, from any route — so a scene open that supersedes the hot reload still pays it, and a reload whose offer LOST
 *  pays nothing — and only by a route registered AFTER the change was raised: a route already loading read bytes older
 *  than it (a newer write raised during its load stays owed to that write's own reload). */
const sceneFileDebts = new Map<string, number[]>();
let sceneChangeSeq = 0;
/** The change sequence each pending route registered at. */
const registeredAtChange = new Map<object, number>();
/** Called whenever {@link adoptionsSettled} would resolve — the hot reload's deferred replays (#1750 R3). */
const settledListeners = new Set<() => void>();
let repairing: Promise<void> | null = null;
/** Settles queued behind the running repair: its world can change under it, keeping its debts for them to re-run, so a
 *  waiter released between the two would resume into the re-run (close-out re-review of #1698). */
let chainedSettles = 0;
/** Invalidated by the test reset, so a continuation queued before it cannot drive the counter below zero. */
const chainReset = createTeardownToken();
let settledWaiters: (() => void)[] = [];

/** The REQUEST order of the world switches a user or agent asks for — a scene load, Create Scene, a prefab edit-open
 *  (#1700). Not the adopt rule: that one is by world (S5), and it cannot see this race, because an edit-open's world IS
 *  current after its own swap. What it cannot see is an edit-open that waited — on the human `confirmDiscard` dialog, or
 *  its fetches — while a NEWER request landed, and then swapped over it: the older request won. A hot reload and a
 *  restore are not requests (they follow the disk and the undo stack), so they do not bump it. */
const worldRequests = createSupersessionToken();

/** Record a new world-switch request; the check goes false once a newer one is made. Only the edit-open consults it, right
 *  before its swap — `serialize.loadScene` keeps its own `loadEpoch`, which also owns the progress modal, and `newScene`
 *  refuses while a load is in flight. */
export function beginWorldRequest(): LivenessCheck { return worldRequests.begin(); }

/** A pre-swap dirt read, tagged with the adopts so far. ⚠️ Deliberately NOT with the saved edit version: dirt a save
 *  clears between the read and the adopt still counts as discarded (#1409's "cleared mid-load" case), so a save must
 *  not make the read stale — a close-out review proposed it, and it reverses that ruling. */
type TaggedDirt = { readonly edited: boolean; readonly scenes: ReadonlySet<string>; readonly baselineSeq: number };

/** The routes between their world call and their adopt — what a prefab write serialized against world switches reads
 *  (#1692). A route registers only around its own world call ({@link withAdoption}), never across a prefab write of
 *  its own, so a write that waits for {@link adoptionsSettled} cannot wait for itself. */
export function pendingAdoptions(): readonly AdoptionRoute[] { return [...pendingRoutes.values()]; }

/** No route pending, no leave repair running or queued to re-run, and no debt waiting on a scene load (past its wait)
 *  to pay it. A debt alone is NOT unsettled: one whose repair threw stays owed until the next switch ends, and counting
 *  it would hang every writer waiting here. */
function isSettled(): boolean {
  return pending.size === 0 && !repairing && chainedSettles === 0
    && !(owed.size > 0 && state().sceneLoadsSwappingComing() > 0);
}

/** Resolves once no route is pending, no leave repair is running or queued to re-run, and no owed repair waits on a
 *  scene load past its wait for the undo step in flight (a load still waiting does not count: a writer inside that
 *  step would wait for it); `null` when that is already so — the same shape as `worldSwitchesSettled`, so an idle caller continues
 *  synchronously. */
export function adoptionsSettled(): Promise<void> | null {
  if (isSettled()) return null;
  return new Promise<void>((resolve) => { settledWaiters.push(resolve); });
}


/** Does the editor's scene state describe the world on screen? False while a route's world is installed but not yet
 *  adopted, and while a world replaced by no editor route (a runtime navigation during Play) is live. */
export function isWorldAdopted(): boolean { return lastAdopted.world !== null && lastAdopted.world === getCurrentWorld(); }

/** Do the editor's scene state (the path, the prefab-edit flag, the history key) and the world on screen describe each
 *  other? The question every reader that PAIRS them asks (#1750 R1): a disk writer pairs the path or the edit flag with
 *  the world's bytes. False in a route's States 4 to 6 — a pending route registered in another world than the one on
 *  screen, which is not the one adopted last: swapped, not yet adopted — and while a route has written its state AHEAD
 *  of its swap (Create Scene: the new path, the old world). `isWorldAdopted()` alone misses the second, because the OLD
 *  world is still the adopted one there.
 *
 *  ⚠️ Keyed on a PENDING route's swap, not on `isWorldAdopted()`. Before a route swaps, the state still describes the
 *  world it will leave, so a save of that pair is right (it is the outgoing scene, to its own file). And a world no route
 *  replaced (a runtime navigation during Play, a harness, a boot that never adopted) is not this question — the run mode
 *  and the restore sources answer for Play — while failing closed on it would refuse every save until some later
 *  adopt, with a "still loading" reason that is false: nothing is loading. */
export function editorStateCurrent(): boolean {
  if (ahead.size > 0) return false;
  const world = getCurrentWorld();
  if (world === lastAdopted.world) return true;
  for (const leftWorld of registeredIn.values()) if (leftWorld !== world) return false;
  return true;
}

/** A reader that CARRIES something across an await (a world, an entity id, a target path, a snapshot) captures here
 *  before it, and asks the check after its LAST await, before it acts (#1750 R2): still the same world, no adoption
 *  since, and the editor state still describes it. Null when the state is not current now: a capture taken in State 4
 *  would pass a same-world check all the way to that world's adopt (#1747), so the caller refuses instead.
 *
 *  ⚠️ The WORLD, not the reader's own entities: a prefab frame rebuilt in place (`refreshInstances` — a leave repair,
 *  another Apply's fan-out) re-mints entity ids inside the same world. A reader that carries an entity id re-checks THAT
 *  id against its guid as well (`entityRef(id).resolve() === id`). A global "frames rebuilt" epoch was tried and
 *  reverted in the close-out reviews: any Apply of an unrelated prefab then invalidated every capture, half-landing a
 *  concurrent Apply and dropping an undo step. */
export function captureAdoption(): LivenessCheck | null {
  if (!editorStateCurrent()) return null;
  const world = getCurrentWorld();
  const noAdoptionSince = adoptionEpoch.capture();
  return () => getCurrentWorld() === world && noAdoptionSince() && editorStateCurrent();
}

/** The refusal every disk writer quotes while {@link editorStateCurrent} is false — `saveScene` maps it to its own
 *  `'switching'` reason, so the human reads "save again once it's open" rather than Play's advice. */
export const SCENE_SWITCH_LANDING = 'a scene is still loading';

/** The world the owner adopted last (a restore's included), or null before the first. A caller that loaded a world asks
 *  whether it is still THE adopted one — `serialize.loadSceneReporting`'s `adopted`. */
export function adoptedWorld(): World | null { return lastAdopted.world; }

/** A scene FILE changed on disk (#1744, #1750 S7): the undo stack recorded against it — open, or parked because the
 *  scene is not — is stale, so the next adopt that swaps history under this file's key drops it (owner fork 4: a
 *  parked clean stack too). Keyed by {@link normScenePath}, so every spelling it folds reaches it. */
export function recordSceneFileChanged(path: string): void {
  const key = normScenePath(path);
  sceneFileDebts.set(key, [...(sceneFileDebts.get(key) ?? []), ++sceneChangeSeq]);
}

/** The scene-file debts still owed — for tests and diagnostics. */
export function owedSceneFileChanges(): readonly string[] { return [...sceneFileDebts.keys()]; }

/** Pay `key`'s changes raised at or before `through`. True when one was paid. */
function paySceneFileDebt(key: string, through: number): boolean {
  const k = normScenePath(key);
  const seqs = sceneFileDebts.get(k);
  if (!seqs) return false;
  const left = seqs.filter((s) => s > through);
  if (left.length === seqs.length) return false;
  if (left.length) sceneFileDebts.set(k, left); else sceneFileDebts.delete(k);
  return true;
}

/** Call `fn` whenever no route is pending and no leave repair runs ({@link adoptionsSettled}'s condition). Persistent:
 *  a caller registers once, at startup; the returned function unsubscribes. */
export function onAdoptionsSettled(fn: () => void): () => void {
  settledListeners.add(fn);
  return () => { settledListeners.delete(fn); };
}

/** How many {@link onAdoptionsSettled} listeners are registered — a test's check that deferrals do not add any. */
export function adoptionsSettledListenerCount(): number { return settledListeners.size; }

/** How many adoptions have written so far — Exit captures it before its load ({@link endPrefabEditInPlace}). */
export function adoptionCount(): number { return adoptions; }

function notifySettled(): void {
  if (!isSettled()) return;
  if (settledWaiters.length > 0) {
    const waiters = settledWaiters;
    settledWaiters = [];
    notifyListeners(waiters, 'adoptionsSettled', []);
  }
  if (settledListeners.size > 0) notifyListeners([...settledListeners], 'onAdoptionsSettled', []);
}

/** Run `body` as one route's world switch: registered as pending for exactly its duration, however it ends — the
 *  registration and the `finally` that drops it are one statement apart, with nothing between that can throw, so an
 *  entry cannot be stranded (a stranded one would hang every prefab write waiting on {@link adoptionsSettled}).
 *
 *  The pre-swap dirt is read HERE, at registration (#1409): the outgoing world stays live and editable while the new
 *  one loads, so the adopt takes the union with a re-read — but only while the baseline it was read against is still
 *  the current one. A newer route's read that predates an older route's adopt describes a world that adopt already
 *  settled; used anyway, it made the newer adopt drop the older scene's CLEAN parked stack (#1689 review). */
export function withAdoption<T>(route: AdoptionRoute, body: (ticket: AdoptionTicket) => Promise<T>): Promise<T> {
  return runSwitch(route, true, body);
}

/** {@link withAdoption} for a RESTORE — a Stop, a preview exit: the world reloaded under the same key, so it writes no
 *  scene state and reads no dirt. It is the adopter (hub, 2026-09-28): an older route whose world it replaced adopts
 *  nothing. */
export function withRestore<T>(body: (ticket: RestoreTicket) => Promise<T>): Promise<T> {
  return runSwitch('restore', false, body);
}

async function runSwitch<T>(route: AdoptionRoute, readDirt: boolean, body: (ticket: AdoptionTicket) => Promise<T>): Promise<T> {
  const key = {};
  pending.add(key);
  pendingRoutes.set(key, route);
  registeredIn.set(key, getCurrentWorld());
  registeredAtChange.set(key, sceneChangeSeq);
  try {
    const dirt: TaggedDirt | null = readDirt ? { edited: state().worldEdited(), scenes: dirtySceneGuidsSnapshot(), baselineSeq } : null;
    let spent = false;
    const spend = () => {
      if (spent) throw new Error(`[sceneAdoption] a '${route}' ticket was offered twice`);
      spent = true;
    };
    return await body({
      route,
      writingAhead: () => { if (!spent) ahead.add(key); },
      offer: (record) => {
        spend();
        ahead.delete(key);
        if (!dirt) throw new Error(`[sceneAdoption] a '${route}' restore cannot adopt a record`);
        return adopt(record, dirt, registeredAtChange.get(key) ?? sceneChangeSeq);
      },
      restored: (world) => {
        spend();
        ahead.delete(key);
        if (world !== getCurrentWorld()) return false;
        lastAdopted = { world, edit: lastAdopted.edit };
        return true;
      },
    });
  } finally {
    pending.delete(key);
    pendingRoutes.delete(key);
    registeredIn.delete(key);
    registeredAtChange.delete(key);
    ahead.delete(key);
    // The settle STARTS (marking the repair running) before any waiter is told: told first, a waiter resumed into the
    // repair it was waiting for (close-out review of #1698). It notifies itself when there is nothing to run.
    await settleLeaveDebts();
  }
}

function adopt(record: AdoptionRecord, dirt: TaggedDirt, changesSeen: number): boolean {
  if (record.world !== getCurrentWorld()) return false;
  const s = state();
  if (record.path !== undefined) s.setScenePath(record.path);
  if (record.baseScene !== undefined) s.setBaseScene(record.baseScene === 'loaded' ? sceneManager.getCurrentBaseScene() : undefined);
  if (record.history) {
    // S8, the ONE rule (#1409, #1417). The undo stack drops iff work was DISCARDED: a primary edit since the baseline,
    // or a dirty base the swap did not keep. A kept base's edits survive live. ⚠️ The edit version is one global
    // counter that a base edit bumps too, so a kept base edit usually still drops the stack — the lesser loss next to
    // a stack replaying discarded primary work. Only a kept base keeps its dirty flag (#1417).
    // ⚠️ A prefab-edit world's stack drops too, clean or not (U27, owner 2026-09-28, #1704): leaving prefab edit ends
    // its history, as leaving Prefab Mode does in Unity. Parked, it replayed onto whatever the prefab had become by the
    // re-open: an Apply between two visits refilled a number an undone delete then brought back. Read off the stack's
    // KEY, not the edit flag: Exit with no return scene clears the flag and leaves the edit world and its stack live.
    // A same-key swap (re-opening the prefab from inside its own edit world) drops it as well.
    // ⚠️ So does a stack whose scene FILE changed on disk (#1744), the scene analogue of #1704. A hot reload of a clean
    // world kept it: a `git checkout` restored a deleted entity, and undoing the delete then made a second one with the
    // same guid. Unity reloads an externally changed scene and its undo ends. A PREFAB change leaves the scene file
    // alone, so it records no debt, as Unity's prefab reimport keeps scene undo. The debt is the owner's (#1750 S7), so
    // WHICHEVER route adopts next pays it — a scene open that superseded the reload included.
    // Paid by the swap TO that scene's key: its stack — live (a reload: the same key) or parked (the scene was left, or
    // never open) — comes back through `freshIncoming`. Leaving the scene pays nothing; its stack parks and drops on return.
    const { key, keptBaseGuids, freshIncoming } = record.history;
    const incomingChanged = paySceneFileDebt(key, changesSeen);
    const before = dirt.baselineSeq === baselineSeq ? dirt : null;
    const discarded = s.worldEdited() || hasDirtySceneOutside(keptBaseGuids)
      || (before !== null && (before.edited || [...before.scenes].some((g) => !keptBaseGuids.has(g))));
    const leavingPrefabEdit = activeHistoryKey().startsWith(PREFAB_EDIT_SCENE_PREFIX);
    // A changed file retires the stack PARKED under the incoming key too: a hot reload can overtake an adopted prefab
    // edit-open, and the scene's clean stack parked by that open was recorded against the old bytes as well — and a
    // scene that changed while it was not open at all comes back with no history (owner fork 4, #1750).
    swapHistory(key, {
      discardOutgoing: discarded || leavingPrefabEdit,
      ...(freshIncoming || incomingChanged ? { freshIncoming: true } : {}),
    });
    s.markSaved();
    clearSceneDirtyExcept(keptBaseGuids);
    baselineSeq += 1;
  }
  // Leaving an edit world whose session is still open owes its repair (#1666) — whatever this world is, another edit
  // world included. Recorded from the owner's own record: the flag cannot say what was left (#1690).
  if (lastAdopted.edit) owed.add(lastAdopted.edit.path);
  // The flag BEFORE any repair runs: the refresh skips the prefab it names.
  if (record.prefabEdit) useEditorStore.getState().openPrefabEditor(record.prefabEdit.prefab, record.prefabEdit.returnScene);
  else useEditorStore.getState().closePrefabEditor();
  lastAdopted = { world: record.world, edit: record.prefabEdit?.prefab ?? null };
  adoptions += 1;
  adoptionEpoch.invalidateAll();
  // Editor Percept (V2): correlate later game/edit events to the scene opened. `worldEntityTotal`, the editor state's
  // name for the same count (§2, #1223 D3). Read here, in the adopt's own run, so it counts the adopted world.
  if (record.journal) editorEmit('!scene-load', { path: record.journal.path, worldEntityTotal: getAllEntities().length });
  return true;
}

/** Exit's flag write (#1690, Exit variant): end the edit session IN PLACE — no return scene, or a load that installed
 *  nothing — iff no adoption has happened since `since` ({@link adoptionCount}, captured before Exit's load). An
 *  adoption since then owns the flag: a scene Exit's load adopted already cleared it and recorded the debt, and an edit
 *  world another route adopted in Exit's tail must keep its session. Returns whether it ended the session. */
export async function endPrefabEditInPlace(since: number): Promise<boolean> {
  if (adoptions !== since) return false;
  const edit = lastAdopted.edit;
  useEditorStore.getState().closePrefabEditor();
  lastAdopted = { world: lastAdopted.world, edit: null };
  if (edit) owed.add(edit.path);
  await settleLeaveDebts();
  return true;
}

/** Run every owed leave repair, unless a world switch is still coming — then the last one to END runs them
 *  ({@link withAdoption}'s `finally`, and `serialize.loadScene`'s). Whatever that switch's outcome: landed, failed,
 *  refused, cancelled or superseded, so a debt handed on is paid exactly once (#1690 review, hub). Running now, a
 *  repair would be cut in half by that switch's swap and run again in its world.
 *
 *  One repair covers every debt: the editor copy of each prefab left is re-read (`refreshPrefabSourceForPath`, which
 *  skips the prefab the edit flag names), then the carried instances are rebuilt from it (`rebaseStaleInstances`) —
 *  refresh FIRST, since the rebase builds from that copy. The debts it ran are cleared only if the world did not change
 *  under it: a switch landing in its awaits makes the rebase rebuild nothing (its ids were the world that is gone), and
 *  that switch runs it again. A repair that throws is reported and stays owed. Never rejects. */
export function settleLeaveDebts(): Promise<void> {
  if (repairing) {
    chainedSettles += 1;
    const live = chainReset.capture();
    return repairing.then(() => { if (live()) chainedSettles -= 1; return settleLeaveDebts(); });
  }
  if (owed.size === 0 || pending.size > 0 || state().sceneLoadsComing() > 0) {
    notifySettled();
    return Promise.resolve();
  }
  const run = [...owed];
  const world = getCurrentWorld();
  repairing = (async () => {
    try {
      for (const path of run) if (path) await refreshPrefabSourceForPath(path);
      await rebaseStaleInstances();
      if (getCurrentWorld() === world) for (const path of run) owed.delete(path);
    } catch (e) {
      console.error('[Editor] the repair owed for leaving prefab edit failed:', e);
    }
  })().finally(() => {
    repairing = null;
    notifySettled();
  });
  return repairing;
}

/** The debts still owed — for tests and diagnostics. */
export function owedLeaveRepairs(): readonly (string | null)[] { return [...owed]; }

/** Test-only: forget every record, as a fresh editor would start. */
export function _resetSceneAdoptionForTests(): void {
  lastAdopted = { world: null, edit: null };
  adoptions = 0;
  baselineSeq = 0;
  owed.clear();
  pending.clear();
  pendingRoutes.clear();
  ahead.clear();
  registeredIn.clear();
  registeredAtChange.clear();
  sceneFileDebts.clear();
  sceneChangeSeq = 0;
  adoptionEpoch.invalidateAll();
  repairing = null;
  chainedSettles = 0;
  chainReset.invalidateAll();
  settledWaiters = [];
}

// The two answers a prefab write needs, installed where it can read them without importing this module (#1692,
// `adoptionGate.ts`: a direct import closes a load-time cycle through `./prefab`).
installAdoptionGate({ settled: adoptionsSettled, pending: () => pendingRoutes.size, capture: captureAdoption });
// Every writer that asks `whyWorldNotAuthored` refuses while the editor state does not describe the world (#1750 R1;
// owner, 2026-09-28: when the world is not savable, REFUSE — never wait, never re-target).
// A FALLBACK: a Stop or preview restore in flight is also a pending route, and its own source says what to do there.
registerPosedWorldSource(SCENE_SWITCH_LANDING, () => !editorStateCurrent(), { fallback: true, exit: "try again once it's open" });
