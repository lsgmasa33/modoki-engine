/** Undo/Redo manager — command stack for all editor actions. */

import { editorEmit, type EditorJournalType } from '../editorJournal';
import { sceneStateToken, setSceneStateToken } from '../scene/sceneDirty';
import { mintStateToken, UNREACHABLE_STATE } from './stateToken';
import { reportStepShortfall, reportUndoThrew, UndoRefusedError } from './undoFailure';
import { _resetStepWindow, closeStepWindow, currentStepWindow, openStepWindow } from './stepWindow';
import { notifyListeners } from '../../runtime/core/notifyListeners';
import { notifyUndoRedoStep } from './undoRedoStep';
import { canEdit, getRunMode } from '../../runtime/core/playState';
import { createTeardownToken } from '../../runtime/core/liveness';
import { normScenePath } from '../../runtime/scene/scenePathKey';
import { scenePathMoveKey, type PathMove } from '../utils/assetPaths';
import { markStale } from '../../runtime/prefab/instanceStore';
import { peekCurrentWorld } from '../../runtime/core/ecs/worldRegistry';
import type { StepCheck } from './stepCheck';

/** Structured diff for a trait-field edit — the machine-readable companion to an
 *  action's human `label`, forwarded into the editor journal's `!edit` event so
 *  Claude perceives *exactly* what a human changed (Percept V1). Values are aligned
 *  positional arrays so a single edit and a multi-select edit share one shape:
 *  `entities[i]` went `old[i]` → `new[i]`. Single-entity ⇒ length-1 arrays; a value
 *  broadcast to N entities ⇒ every `new[i]` identical. Entities are GUID-addressed
 *  (stable across hot-reload); an entity with no `EntityAttributes` trait (un-guidable,
 *  rare) falls back to its stringified runtime id, which is NOT hot-reload-stable. */
export interface EditDetail {
  /** Trait name, e.g. `RigidBody2D`. */
  trait: string;
  /** Field name, e.g. `gravityScale` (`''` for a tag toggle). */
  field: string;
  /** Affected entity GUIDs (≥1), aligned with `old`/`new`. */
  entities: string[];
  /** Prior values, aligned with `entities`. */
  old: unknown[];
  /** New values, aligned with `entities`. */
  new: unknown[];
}

/** Freeze a detail into an independent snapshot for a journal event, so a later
 *  mutation of the action's detail (or its captured value objects) can't rewrite an
 *  already-emitted, seq-stamped record. Arrays are copied one level; element values
 *  are shared (trait field values are plain serializable data, captured at edit time). */
function snapshotDetail(d: EditDetail | undefined): EditDetail | undefined {
  if (!d) return undefined;
  return { trait: d.trait, field: d.field, entities: [...d.entities], old: [...d.old], new: [...d.new] };
}

/** Build the editor-journal payload for an action, snapshot-frozen so a later mutation
 *  of the action (or its captured objects) can't rewrite an already-emitted record.
 *  Merges the V1 trait `detail` and any V2 structural `journalPayload`. */
function buildEditorPayload(action: UndoAction): Record<string, unknown> {
  const payload: Record<string, unknown> = { label: action.label };
  if (action.detail) payload.detail = snapshotDetail(action.detail);
  if (action.journalPayload) Object.assign(payload, structuredClone(action.journalPayload));
  return payload;
}

export interface UndoAction {
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
  label: string;
  /** Structured trait-edit diff (Percept V1). Present on trait-field edits; absent
   *  on structural actions (create/delete/reparent) and selection. Forwarded into
   *  the `!edit` journal event so the human's change is machine-readable. */
  detail?: EditDetail;
  /** Explicit editor-journal event type for this action (Percept V2) — e.g.
   *  `!create`, `!delete`, `!duplicate`, `!reparent`, `!transform`. Defaults to
   *  `!edit` (or `!select` when `_isSelection`). Only affects the journal sigil; the
   *  undo/redo of this action still emit `!undo`/`!redo`. */
  kind?: EditorJournalType;
  /** Extra structured journal payload for NON-trait-edit events (structural /
   *  transform) — e.g. `{ entities: [guid] }` for a delete, `{ entity, from, to }`
   *  for a reparent. Merged into the emitted event and snapshot-cloned at emit so the
   *  record is immutable. Plain serializable data only. */
  journalPayload?: Record<string, unknown>;
  /** #2001 S7 (#2046): this action's undo and redo put back the exact instance records they change (rule 8,
   *  `editor/instance/instanceHistory.ts`), so the store stays fresh after them. A step that FAILS still marks it stale:
   *  it may have stopped partway. */
  maintainsRecords?: true;
  /** Internal tag for coalescing consecutive selection-only actions */
  _isSelection?: boolean;
  /** This action's undo/redo/initial-apply writes straight to a FILE (e.g.
   *  SceneAssetView's base-ref edit via /api/scene-mutate), not the live world —
   *  so, unlike a normal trait/entity edit, there is nothing pending a Cmd+S.
   *  Skips the `notifyEdited()` bump `hasUnsavedChanges()` reads, so this
   *  action's own undo/redo doesn't falsely mark the active scene dirty (and
   *  self-block a follow-up file-direct write via the "unsaved live changes"
   *  guard some of those routes carry). A genuinely-pending unrelated
   *  live-world edit is untouched either way — this flag only opts THIS
   *  action out of contributing its own bump.
   *
   *  ⚠️ SECOND ROLE (#1148): `undoRefusedReason` also reads it as "safe to undo inside a
   *  scrub/preview envelope", because a snapshot restore never touches what such an entry edits.
   *  That holds for every producer today (asset documents and the parked/editor-state base-scene
   *  ref) — so a new producer that sets this flag AND writes a scene entity would be let through
   *  inside an envelope and lost on Exit. Such an action is not file-direct: leave the flag off — or, when it edits a
   *  FILE whose undo must outlive a world like any asset edit's but ALSO rebuilds the live world, set
   *  `_rebasesLiveFrames` beside it (#1857).
   *  ⚠️ THIRD ROLE (#1857): Stop keeps it. `truncateUndoTo` removes the entries pushed during Play, since Stop reverts
   *  what they edited, but an asset file keeps its Play-time edit (as Unity's does), so its entry stays undoable. */
  _isFileDirect?: boolean;
  /** Only with `_isFileDirect`: the entry edits a file AND rebuilds the live frames placed from it (#1857 — a model
   *  import's halves are one `commitPrefabWrite`, which rebases every live frame of the prefab). The file half is why it
   *  outlives a world switch and a discard (`runStep`'s `worldGone`, `parkSurvivors`), and why it does not mark the scene
   *  unsaved (#1858: the scene file holds the instance and its overrides, which a rebase does not change). The world
   *  half is why it is treated as a scene edit wherever a world is posed or thrown back: the preview gate refuses it,
   *  Exit drops one pushed in the envelope, and Stop drops one pushed during Play, since each of those restores a world
   *  its rebuild landed on (see {@link worldFree}). */
  _rebasesLiveFrames?: boolean;
  /** Scene guids this action's entities belong to (scene-loading.md
   *  Phase 12, M2) — resolved by the CALLER before the mutation runs (a delete/reparent
   *  can destroy the entity or is otherwise unsafe to re-resolve after the fact, so the
   *  caller captures this once and both directions share it: undo and redo touch the
   *  SAME entities, so the same scenes move either way). Moves every listed scene's state
   *  token on push AND on undo/redo (#1904: an undo puts the scene back at its token from
   *  before, so undoing to the saved state reads clean) — skipped when `_isFileDirect` (that
   *  action's write is already on disk, nothing pending). Omit for actions with no
   *  live-world entity effect (selection). */
  affectedScenes?: string[];
  /** Consecutive actions sharing a non-null `coalesceKey`, pushed within
   *  COALESCE_MS of each other, merge into the existing top entry: its `redo`
   *  (and `label`) advance to the latest edit while its original `undo` — the
   *  state before the chain started — is kept. This collapses a field's
   *  per-keystroke writes ("1" → "1." → "1.2" → "1.25") into ONE undo step
   *  (editor-inspector.md F6). Undefined ⇒ never coalesces; that's the default
   *  for structural actions and the discrete-click coalescing the Particle/
   *  Animation editors do themselves via peekUndo() identity. */
  coalesceKey?: string;
  /** Each half's refusals, askable before the half runs (#2010, `stepCheck.ts`). A composite asks every sub's before it
   *  applies any, so a sub that would refuse refuses the whole entry with nothing changed. Absent: a composite holding
   *  this action cannot pre-check past it. */
  check?: StepCheck;
}

// Count-based cap only (review F12). Entries close over their own state: a
// delete/duplicate retains a full subtree EntitySnapshot, a revert/refresh retains
// a cloned PrefabFile + override/structure maps — so 200 large-instance ops could
// retain non-trivial memory. We deliberately do NOT byte-budget the stack: sizing
// arbitrary closures is unreliable (no portable retained-size API), the per-context
// swapHistory stacks would each need their own budget, and for an interactive
// editor a count cap is the predictable, debuggable bound users expect ("last 200
// actions"). If memory ever becomes a real pressure (huge scenes, long sessions),
// the cheaper lever is lowering MAX_STACK_SIZE or dropping the heaviest snapshots
// past N — not a byte budget. Left as count-based by design.
const MAX_STACK_SIZE = 200;
/** Same window the ParticleEditor/AnimationEditor coalescers use. */
const COALESCE_MS = 500;

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];
/** The preview SESSION each entry was pushed during, if any (#1148). A WeakMap rather than a field
 *  on `UndoAction`: callers build those objects, and a mark they could set or copy would be a mark
 *  nobody can trust. */
const _pushedInPreview = new WeakMap<UndoAction, number>();
/** The preview session whose snapshot is held right now (`setPreviewUndoSession`), or null. */
let _previewSession: number | null = null;
function currentPreview(): number | null { return _previewSession; }

/** Tell the undo stack a preview SESSION began (an id) or ended (null) — called only by the session
 *  controller (`editor/scene/timelinePreview.ts`), at the moment it starts taking the snapshot and
 *  when it ends the session.
 *
 *  Keyed to the SESSION, not the run mode, deliberately: the session's snapshot is what Exit
 *  restores, so "pushed while this session was held" is exactly "made obsolete by its restore".
 *  The run mode does not line up with it — the Timeline ▶ begins its session BEFORE entering
 *  `preview`, and the mode can return to `stopped` before or after the restore. */
export function setPreviewUndoSession(id: number | null): void {
  _previewSession = id;
}

/** End preview session `session`'s marking — a no-op if a newer session already took over, or if
 *  that session is mid-restore (a second end's early return must not clear the mark the first end
 *  still needs for its drop). */
export function clearPreviewUndoSession(session: number): void {
  if (_restoringSessions.has(session)) return;
  if (_previewSession === session) _previewSession = null;
}

/** The preview sessions whose snapshot restore is in progress. While any is, EVERY undo/redo step is
 *  refused — see `beginPreviewRestore`. A SET, not one slot: a pose during a restore used to seat a
 *  new session that a second Exit restored while the first was still loading, and a single slot let
 *  the second overwrite the first so the first's drop never ran. `beginTimelinePreviewSession` now
 *  refuses during a restore (#1167), so that path is closed; the set stays as the backstop, because
 *  an overwritten slot would fail silently. */
const _restoringSessions = new Set<number>();

/** A restore of preview session `session` is starting — refuse every undo/redo until
 *  `finishPreviewRestore` (#1148 review).
 *
 *  Waiting for idle alone was racy: a step queued AFTER the restore began could still start before
 *  the swap, outlast it, and push its entry back after the drop (applying its edit to the restored
 *  world); a scene undo in `stopped` could land in the world being thrown away. A refusal decided at
 *  run time closes all of it — nothing new starts, and `whenUndoIdle` then only waits for the step
 *  that was already running. The window is one scene swap long. */
export function beginPreviewRestore(session: number): void {
  _restoringSessions.add(session);
  notifyUndoChanged(); // the Edit menu's enabled state reads the refusal — it must hear it start
}

/** The restore of `session` finished. `drop` (the world WAS reverted) removes that session's scene
 *  edits; either way its mark and the restore refusal are cleared. */
export function finishPreviewRestore(session: number, opts: { drop: boolean }): void {
  if (!_restoringSessions.delete(session)) return;
  if (opts.drop) dropPreviewSceneEdits(session);
  clearPreviewUndoSession(session);
  // Unconditionally — and not only via a drop that removed something: a restore that dropped nothing
  // otherwise left the menu greyed out from `beginPreviewRestore` until some unrelated stack change.
  notifyUndoChanged();
}

/** Resolves once every queued or running undo/redo step has finished.
 *
 *  The session controller awaits this before a restore (#1148). A step pops its entry and then
 *  AWAITS its closure (a prefab re-instantiate respawns asynchronously), so a restore that ran in
 *  between would drop nothing — the entry is off both stacks — and the step would then push it back
 *  and apply its edit to the RESTORED, authored world. ⚠️ Never await this from inside an undo/redo
 *  closure: the closure is part of the chain it waits for. */
export function whenUndoIdle(): Promise<void> {
  return _inFlight.then(() => undefined);
}

/** `whenUndoIdle()` when an undo/redo step is queued or running, else null — so a caller with nothing to wait for
 *  stays synchronous. The unsaved-work gates await it before they read the dirty state (#1579): an undo's
 *  conservative dirty mark (#310) lands at its END, so a gate read during the step answered "clean", and the switch
 *  that then waited for the step discarded the history it had just dirtied without asking. */
export function undoStepPending(): Promise<void> | null {
  const step = _stepsPending > 0 ? whenUndoIdle() : null;
  const held = worldHoldsSettled();
  return step && held ? Promise.all([step, held]).then(() => undefined) : step ?? held;
}

/** Forward operations in flight that must land whole in the world they began in (#1667): a prefab write and the
 *  rebuild and undo entry that follow it (`commitPrefabWrite`, `applyToPrefabWithUndo`). A world switch waits for them
 *  exactly as it waits for an undo step — `undoStepPending` reports both — so a Play, a scene open or entering prefab
 *  edit that lands mid-write no longer runs the refresh and pushes the undo entry into the incoming world. A COUNT:
 *  an Apply holds across its whole run and its commit holds again inside it.
 *
 *  ⚠️ Never start a world switch, and never await `undoStepPending` / `whenUndoIdle`, while holding one: the switch
 *  would wait for the hold, and the hold for the switch. Nothing a prefab rebuild reaches does either
 *  (`tests/editor/prefabCommit.test.ts` § "holding the world cannot deadlock" counts a switch begun under a hold; an
 *  await of the barrier from inside one shows there as a timeout). */
let _worldHolds = 0;
let _holdsDrained: { promise: Promise<void>; resolve: () => void } | null = null;
/** Told each time {@link undoStepPending} goes back to null: the last undo step ended, or the last world hold was
 *  released, with the other already idle (#1750 R3 — the hot reload's deferred replays). */
const _idleListeners = new Set<() => void>();
function notifyIdleIfSo(): void {
  if (_stepsPending > 0 || _worldHolds > 0 || _idleListeners.size === 0) return;
  notifyListeners([..._idleListeners], 'onWorldHoldsSettled', []);
}
/** Call `fn` whenever no undo step runs and no world-bound operation holds the world — {@link undoStepPending} is null
 *  again. Persistent: register once, at startup; the returned function unsubscribes. */
export function onWorldHoldsSettled(fn: () => void): () => void {
  _idleListeners.add(fn);
  return () => { _idleListeners.delete(fn); };
}
/** How many {@link onWorldHoldsSettled} listeners are registered — a test's check that deferrals do not add any. */
export function worldHoldsSettledListenerCount(): number { return _idleListeners.size; }
function worldHoldsSettled(): Promise<void> | null {
  if (_worldHolds === 0) return null;
  if (!_holdsDrained) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    _holdsDrained = { promise, resolve };
  }
  return _holdsDrained.promise;
}
/** Hold every world switch until the returned release is called — see {@link worldHoldsSettled}. Idempotent release. */
export function beginWorldBoundOperation(): () => void {
  _worldHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _worldHolds -= 1;
    if (_worldHolds === 0 && _holdsDrained) {
      const { resolve } = _holdsDrained;
      _holdsDrained = null;
      resolve();
    }
    notifyIdleIfSo();
  };
}
/** An undo/redo step (or a rollback on the step chain) is queued or running NOW — the synchronous question, for a
 *  forward edit that must REFUSE rather than wait (#1832; docs/scene-loading.md § "Readers of the world"). Its entry
 *  would be pushed inside the step's window and dropped (`pushAction`), or the step would open during its await. */
export function isUndoStepInFlight(): boolean {
  return _stepsPending > 0;
}

/** Forward edits in flight that must record their undo entry whole (#1832): an agent op that pushes one. While any
 *  is, every undo/redo step is REFUSED (`undoRefusedReason`), for the mirror of the reason the op refuses during a
 *  step: a step that opened during the op's await would take the op's push into its window, where it is dropped. A
 *  COUNT, since ops can overlap. The HUMAN's forward edits hold nothing (#1833). */
let _forwardEdits = 0;
/** Invalidated by the test reset, so a hold taken before it cannot drive the count below zero when released after. */
const _forwardEditLiveness = createTeardownToken();
/** The longest a forward edit holds undo off. An agent op can outlive its caller — an eval's timeout abandons its
 *  body without cancelling it, and a backend write that never answers never settles — and an unbounded hold then
 *  refused every human undo until a reload (close-out review). Past this the hold lets go, with a warning: undo works
 *  again, at the cost of the protection for an op this slow. */
export const FORWARD_EDIT_MAX_HOLD_MS = 30_000;
export function beginForwardEdit(): () => void {
  _forwardEdits += 1;
  const alive = _forwardEditLiveness.capture();
  notifyUndoChanged(); // the Edit menu's enabled state reads the refusal
  // Warn at the stall mark, as `beginWorldSwitch` does for a stalled step; let go at the bound.
  const stall = setTimeout(() => {
    console.warn(`[undo] an agent edit has held undo/redo for ${WORLD_SWITCH_STALL_WARN_MS / 1000}s — until it settles `
      + `(or ${FORWARD_EDIT_MAX_HOLD_MS / 1000}s pass), every undo and redo is refused; a backend write it awaits may never have answered`);
  }, WORLD_SWITCH_STALL_WARN_MS);
  const bound = setTimeout(() => {
    console.warn(`[undo] released an agent edit's hold on undo/redo after ${FORWARD_EDIT_MAX_HOLD_MS / 1000}s — it has not settled; `
      + 'an undo now can drop that edit\'s undo entry if it lands later');
    release();
  }, FORWARD_EDIT_MAX_HOLD_MS);
  let released = false;
  const release = () => {
    clearTimeout(stall);
    clearTimeout(bound);
    if (released) return;
    released = true;
    if (!alive()) return;
    _forwardEdits -= 1;
    notifyUndoChanged();
  };
  return release;
}

/** Forward operations in flight whose UNDO restores a scene snapshot taken when they STARTED — Apply to Prefab
 *  (`applyToPrefabWithUndo`: its undo reloads the scene as it was before the Apply). An edit made during one of its
 *  awaits pushes its entry BELOW the Apply's, and undoing the Apply then reloads the snapshot over it: the edit is
 *  erased while its own entry stays on the stack (#1877 L5). An agent edit is REFUSED meanwhile (#1880 W8,
 *  `agentStepGate`); the HUMAN's forward edits are not held (#1833's rule). A COUNT, since an Apply can start inside
 *  another's window only by a route that holds neither — the count stays honest either way. */
let _snapshotOps = 0;

/** Hold {@link isSnapshotOperationInFlight} true until the returned release is called (once; idempotent). */
export function beginSnapshotOperation(): () => void {
  _snapshotOps += 1;
  const alive = _forwardEditLiveness.capture();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (alive()) _snapshotOps -= 1;
  };
}

/** Is a forward operation whose undo restores its start-of-op snapshot in flight? See {@link beginSnapshotOperation}. */
export function isSnapshotOperationInFlight(): boolean {
  return _snapshotOps > 0;
}

/** A world switch is in progress (#1579) — a forward operation that must land in one world refuses to start then. */
export function isWorldSwitchInProgress(): boolean {
  return _worldSwitches > 0;
}
/** How many world-bound operations are held now — for a test that must prove a rebuild started no switch. */
export function worldBoundOperationsHeld(): number {
  return _worldHolds;
}

/** How long a world switch waits for an undo step before `beginWorldSwitch` warns. An Apply undo is one prefab file
 *  write and a scene reload; ten seconds is far past either. */
export const WORLD_SWITCH_STALL_WARN_MS = 10_000;

/** World switches in progress — a scene load, Create Scene, entering prefab edit, a Play startup (#1579). While any
 *  is, every undo/redo step is refused (`undoRefusedReason`), read when the step RUNS, so a step queued behind the
 *  one the switch is waiting for is refused rather than started over the incoming world. A COUNT, since two switches
 *  can overlap (a load superseding another). */
let _worldSwitches = 0;
/** Resolved when `_worldSwitches` next drains to zero — see {@link worldSwitchesSettled}. */
let _switchesDrained: { promise: Promise<void>; resolve: () => void } | null = null;

/** The world switches in progress, as something to wait on: a promise that resolves once none is (a switch that
 *  starts meanwhile holds it), or null when none is now. The editor's boot scene walk waits on this before each
 *  candidate load (#1598) — it is the registry of PENDING switches, which the walk's "did a foreign scene win" check
 *  cannot see: a load still fetching, or a prefab edit-open still reading its file, has installed nothing yet.
 *  Resolves on drain, never rejects, and says nothing about whether any switch SUCCEEDED — ask the world after. */
export function worldSwitchesSettled(): Promise<void> | null {
  if (_worldSwitches === 0) return null;
  if (!_switchesDrained) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    _switchesDrained = { promise, resolve };
  }
  return _switchesDrained.promise;
}

/** Begin a world switch (#1579): refuse every undo/redo step from now until `release`, and report the step that is
 *  already queued or running as `idle` — resolved once it has finished, or null when there is none, so a caller with
 *  nothing to wait for stays synchronous (a load with no envelope and no undo still flips to 'stopped' in the same
 *  run). Call it synchronously at the top of the switch, AFTER the switch's own refusals and in-flight latches
 *  (#887), and await `idle` before the switch touches the world or the editor's scene path.
 *
 *  Why: an undo step awaits across a prefab file write and a world reload (`applyPrefabUndo.restoreSnapshot`), and
 *  a switch landing in that window resumed the step over a world or history that had changed under it. #1575's
 *  close-out guarded the step itself four times and each round found the next window; waiting HERE, where the switch
 *  starts, closes all of them at once. `timelinePreview`'s restore has always done the same with `whenUndoIdle`.
 *
 *  ⚠️ Never call a world switch from inside an undo/redo closure: it would wait for the chain it is part of, forever.
 *  Closures that must replace the world call `sceneManager` directly (`applyPrefabUndo`, `authoredSnapshot`).
 *  `isExecutingUndoRedo()` cannot tell the two apart — it reads true for a concurrent user gesture too. */
export function beginWorldSwitch(): { idle: Promise<void> | null; release: () => void } {
  _worldSwitches += 1;
  notifyUndoChanged(); // the Edit menu's enabled state reads the refusal
  let released = false;
  const idle = undoStepPending();
  // A step that never settles now holds every switch with it — scene opens hang, Play refuses, every undo is refused —
  // and nothing else says why. Warn once, so the hang names its cause (#1579 close-out review).
  const stall = idle ? setTimeout(() => {
    console.warn(`[undo] a scene switch has waited ${WORLD_SWITCH_STALL_WARN_MS / 1000}s for the undo/redo step or prefab write in flight — `
      + 'until it settles, no scene can be opened or created and Play cannot start');
  }, WORLD_SWITCH_STALL_WARN_MS) : null;
  const clearStall = () => { if (stall !== null) clearTimeout(stall); };
  void idle?.then(clearStall);
  return {
    idle,
    release: () => {
      clearStall();
      if (released) return;
      released = true;
      _worldSwitches -= 1;
      notifyUndoChanged();
      if (_worldSwitches === 0 && _switchesDrained) {
        const { resolve } = _switchesDrained;
        _switchesDrained = null;
        resolve();
      }
    },
  };
}
let _truncationWarned = false;

// ── Change subscription ───────────────────────────────────
// A monotonically-bumped version + listener set so React can react to undo/redo
// state (enabled + label) WITHOUT re-reading it every render. `getUndoVersion` is
// a stable snapshot for `useSyncExternalStore`; it changes only when the stacks
// actually mutate. Lets the editor menu memo recompute on undo changes alone
// rather than on every render (editor-core-store-backend.md F3).
let _version = 0;
const _changeListeners = new Set<() => void>();
function notifyUndoChanged() {
  _version++;
  notifyListeners(_changeListeners, 'undoManager', []);
}
/** Subscribe to undo/redo stack changes. Returns an unsubscribe fn. */
export function subscribeUndo(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => { _changeListeners.delete(listener); };
}
/** Stable version snapshot — bumps on every stack mutation. */
export function getUndoVersion(): number { return _version; }

// Re-exported so the undo API stays in one place; the signal itself lives in a leaf module (#1905).
export { subscribeUndoRedoStep } from './undoRedoStep';

// ── "has the WORLD been edited since save?" (C7) ──────────────────────────────
// Distinct from _version, which also bumps on SELECTION (selection deliberately pushes undo
// entries — see CLAUDE.md), so _version would read as "unsaved work" after a mere click.
// This counts only real edits, so load_scene/new_scene can refuse to silently DESTROY
// unsaved live work — the case that used to report {ok:true, entityCount:12} while the
// entity you just made was gone from the world, the file, AND the undo stack.
//
// It counts CHANGES: undo/redo bump it too, since its other readers ask "did anything happen since" (a drop's witness,
// Play's snapshot completeness, the Apply dialog's re-plan key). Whether the world is back at its SAVED state is the
// state token's question below (#1904) — this counter used to answer that too, and so an undo back to the on-disk
// state still read dirty.
let _editVersion = 0;
function notifyEdited() { _editVersion++; }

// ── Where the world is: state tokens (#1904) ──────────────────────────────────
// Each edit mints a token for the state it leaves, recorded on its entry beside the token it started from; an undo
// puts the `before` back and a redo the `after`, for the primary world and for every base scene the entry touched
// (`scene/sceneDirty.ts`). A save records the token it wrote (`serialize.ts markSceneSaved`), so "dirty" is "not at
// that token", and undoing every edit since the save reads clean — Unity clears a scene's dirty mark the same way
// (issue tracker 6559). A save partway down the stack is handled by the same compare: undoing past it lands on a
// token the save did not write.
// ⚠️ A token is a CLAIM that the world is in that state. Only an entry whose step ran whole may move to its own
// before/after; a step that threw partway (#310) or reported a shortfall (#1823) leaves the world somewhere no token
// names, and `forgetRecordedStates` makes every recorded state unreachable — dirty until the next save or load.
interface EntryStates {
  before: number;
  after: number;
  /** Per base scene the entry touched: its token before the entry's FIRST push (a coalesced chain keeps the first). */
  readonly scenesBefore: Map<string, number>;
}
const _entryStates = new WeakMap<UndoAction, EntryStates>();
/** 0 is the boot world, which no minted token equals — and a constant, so `serialize.ts` can start from it without
 *  calling in here at import (several suites mock this module with an explicit export list). */
export const BOOT_WORLD_STATE = 0;
let _worldState = BOOT_WORLD_STATE;
/** The state token the primary world is at now. A save reads it together with the edit version it serializes. */
export function worldStateToken(): number { return _worldState; }
/** What a save wrote, read in ONE synchronous moment before its await: the edit version (for "did an edit land during
 *  the write") and the state token (for "is the world at what the file holds"). */
export interface SavePoint { readonly version: number; readonly state: number }
/** ⚠️ An undo/redo step in flight has changed (or is about to change) the world with its token still the one before it
 *  — `landOn` moves the token only once the step resolves. A save in that window serialized a state no token names, so
 *  it records one nothing reaches: the scene stays unsaved until the next save (#1904 close-out, third review: a save
 *  during an Apply undo's rebase paired the pre-step token with the post-step bytes, and a redo then read clean over a
 *  file without it). */
export function captureSavePoint(): SavePoint {
  return { version: _editVersion, state: _stepsPending > 0 ? UNREACHABLE_STATE : _worldState };
}
/** The same for base scene `guid`, whose bytes Save All writes after the primary's. */
export function captureSceneSavePoint(guid: string): SavePoint {
  return { version: _editVersion, state: _stepsPending > 0 ? UNREACHABLE_STATE : sceneStateToken(guid) };
}
/** Call once the serialize's LAST await is behind it — the bytes are fixed then. The capture sees only a step already
 *  running: an edit, a step that STARTED after it, or a dropped push landing in the serialize's awaits (prefab sources,
 *  nested preloads) may or may not be in the bytes, so the point then names no reachable state (#1904 close-out, fourth
 *  review: an undo during a prefab fetch wrote the undone bytes under the pre-undo token, and the redo read clean). */
export function settleSavePoint(at: SavePoint): SavePoint {
  return worldMovedSince(at, _worldState) ? { version: at.version, state: UNREACHABLE_STATE } : at;
}
/** The same for base scene `guid`: the token Save All clears it at. */
export function settleSceneSavePoint(guid: string, at: SavePoint): number {
  return worldMovedSince(at, sceneStateToken(guid)) ? UNREACHABLE_STATE : at.state;
}
function worldMovedSince(at: SavePoint, stateNow: number): boolean {
  return _stepsPending > 0 || _editVersion !== at.version || stateNow !== at.state;
}
/** Play's undo barrier: the depth Stop cuts back to. It also ends the coalescing chain, or a Play-time edit with the
 *  same key merged into the pre-Play top entry, which survives the cut carrying the Play value — a later redo then wrote
 *  it into the authored world (#1904 close-out, fourth review). */
export function markPlayBarrier(): number {
  _coalesce = null;
  return undoStack.length;
}
/** Stop's restore: the reverted world is back at the state it was in at the Play press, token and all (#1904). */
export function restoreWorldStateToken(token: number): void { _worldState = token; }
/** The world was just replaced wholesale (a load, a new scene, a restore): it is at a state no entry recorded. */
export function beginFreshWorldState(): number {
  _worldState = mintStateToken();
  return _worldState;
}
/** A forward edit: `entry` (just pushed, or the top a coalesced edit merged into) now leaves a new state. */
function recordForward(entry: UndoAction, scenes: readonly string[]) {
  const after = mintStateToken();
  let states = _entryStates.get(entry);
  if (!states) {
    states = { before: _worldState, after, scenesBefore: new Map() };
    _entryStates.set(entry, states);
  }
  states.after = after;
  _worldState = after;
  for (const guid of scenes) {
    if (!guid) continue;
    if (!states.scenesBefore.has(guid)) states.scenesBefore.set(guid, sceneStateToken(guid));
    setSceneStateToken(guid, after);
  }
}
/** A whole undo or redo of `entry`: the world and its scenes are back at the state the entry recorded. */
function landOn(entry: UndoAction, direction: 'Undo' | 'Redo'): boolean {
  const states = _entryStates.get(entry);
  if (!states) return false;
  _worldState = direction === 'Undo' ? states.before : states.after;
  for (const [guid, before] of states.scenesBefore) setSceneStateToken(guid, direction === 'Undo' ? before : states.after);
  return true;
}
/** The live stacks no longer describe the world: every token recorded on them is re-minted, so no later undo or redo
 *  can land on one a save recorded. `moved`: the step also changed the world partway (a throw, a shortfall), so the
 *  world and the step's scenes move to fresh tokens too. A REFUSED step moved nothing, but its entry is dropped with its
 *  edit still applied, so the entries beneath it would otherwise land on states that no longer have that edit. Parked
 *  stacks keep theirs: they belong to worlds this step never touched — a return to one reloads the primary and the
 *  bases it does not keep from disk, and re-mints the bases it keeps (`sceneDirty.ts` `clearSceneDirtyExcept`). */
function forgetRecordedStates(entry: UndoAction, moved: boolean) {
  const fresh = new Map<number, number>();
  const remap = (t: number) => {
    let n = fresh.get(t);
    if (n === undefined) { n = mintStateToken(); fresh.set(t, n); }
    return n;
  };
  for (const a of [...undoStack, ...redoStack]) {
    const states = _entryStates.get(a);
    if (!states) continue;
    states.before = remap(states.before);
    states.after = remap(states.after);
    for (const [guid, t] of states.scenesBefore) states.scenesBefore.set(guid, remap(t));
  }
  if (!moved) return;
  _worldState = mintStateToken();
  const scenes = new Set(entry.affectedScenes ?? []);
  for (const guid of _entryStates.get(entry)?.scenesBefore.keys() ?? []) scenes.add(guid);
  for (const guid of scenes) setSceneStateToken(guid, mintStateToken());
}
/** An entry that leaves the SCENE FILE as it was (#1857, #1858): a selection, or any file-direct edit — a rebase of the
 *  live frames onto a changed prefab included, since the scene file holds the instance and its overrides, not the
 *  prefab's rows. What the edit version and the scene dirty marks ask. */
function leavesSceneFile(action: UndoAction): boolean {
  return !!action._isSelection || !!action._isFileDirect;
}
/** An entry whose steps write no live world (#1857): a selection, or a file-direct edit that rebuilds nothing live. What
 *  the preview gate, Exit's drop and Stop's truncation ask — each restores a posed world, which a rebase would have
 *  landed on. */
function worldFree(action: UndoAction): boolean {
  return !!action._isSelection || (!!action._isFileDirect && !action._rebasesLiveFrames);
}
/** Monotonic count of non-selection edits. Compare against a snapshot to detect unsaved work. */
export function getEditVersion(): number { return _editVersion; }
/** The in-flight coalesce chain: which key, and when it last advanced. Reset by
 *  breakUndoCoalescing() and by any structural stack change (undo/redo/clear/…). */
let _coalesce: { key: string; at: number } | null = null;
/** Wall-clock for the coalesce window. Injectable so tests drive it deterministically. */
let _clock: () => number = () => performance.now();
/** Test-only: override the coalesce-window clock. */
export function _setUndoClock(fn: () => number) { _clock = fn; }

/** Break the current coalesce chain so the next same-key edit starts a fresh
 *  undo entry. Call on a commit boundary (field blur, selection change) — though
 *  the COALESCE_MS window and the per-(entity,trait,field) key already separate
 *  distinct edit sessions on their own. */
export function breakUndoCoalescing() { _coalesce = null; }

/** True while an undo/redo step's window is open (`stepWindow.ts`, the one definition). ⚠️ A TIME window: it reads true
 *  for forward work that runs during a step's awaits too — see that module's note. */
export function isExecutingUndoRedo(): boolean { return currentStepWindow() !== null; }

// ── In-flight serialization (undo/redo mutex) ─────────────
// `undo`/`redo` are async (an action's undo/redo may `await`, e.g. prefab
// instantiate redo). The keyboard handler fires them WITHOUT awaiting, so a rapid
// Cmd+Z, Cmd+Z (or Cmd+Z then Cmd+Shift+Z) could otherwise start a second
// undo/redo while the first is mid-`await`: the second `pop()` runs before the
// first's `await action.undo()` resolves and before its `redoStack.push`,
// corrupting stack order. The step window only blocks PUSHES, not re-entrant
// undo/redo. We chain every undo/redo onto a single tail promise so they run
// strictly one-at-a-time, in call order, and each pops the stack only when it is
// actually its turn (editor-prefab-system.md F6).
let _inFlight: Promise<unknown> = Promise.resolve();
/** Steps queued or running on `_inFlight` — lets `beginWorldSwitch` tell "nothing to wait for" apart without an await. */
let _stepsPending = 0;
/** Serialize `op` after any in-flight undo/redo. The chain never rejects (each
 *  op is isolated) so one failing undo can't wedge the queue. */
function serialize<T>(op: () => Promise<T>): Promise<T> {
  _stepsPending += 1;
  const run = _inFlight.then(op, op);
  // A side branch, not a `.finally` on `run`: that would delay every caller and the chain by a tick.
  const settled = () => { _stepsPending -= 1; notifyIdleIfSo(); };
  run.then(settled, settled);
  _inFlight = run.catch(() => {});
  return run;
}

/** Run `op` on the step chain WITHOUT opening a step window — forward work that must not overlap a step (#1823).
 *
 *  The step window is time, not ownership (`stepWindow.ts`), so forward work that reports or pushes during a step's
 *  awaits is read as the step's. Where that work is ours to schedule, this keeps it out: `op` starts only once every
 *  queued step has finished, and no step starts until it has. `compositeAction`'s rollback runs here, so the undo
 *  closures it replays report with no step open (console-only) and can never land in a step's result. A world switch
 *  waits for it as for a step (`undoStepPending`).
 *
 *  ⚠️ Never call this from inside an undo/redo closure: it would wait for the chain it is part of, forever. */
export function runOnStepChain<T>(op: () => Promise<T>): Promise<T> {
  return serialize(op);
}

// ── Action capture (the composite/transaction primitive's collection half) ────
//
// A batch operation (one `mutate_scene` tool call carrying N ops, a multi-step
// authoring command) must land as ONE undo entry, not N. The natural way to build
// such a batch is to call the existing `*WithUndo` helpers per op — they already
// know how to construct a correct per-op undo/redo closure (guid re-resolution
// across a world rebuild, prefab-override routing, animation-record notification).
// But each of those helpers ends in `pushAction`, so a naive batch pushes N entries.
//
// Capture inverts that: while a capture frame is open, `pushAction` DIVERTS the
// action into the frame instead of the stack, so the helpers stay untouched and the
// batch builder decides what one entry looks like (see compositeAction.ts).
//
// Why here and not in entityActions' `setActionCallback` indirection: that hook only
// covers entityActions.ts. Prefab, gizmo, reorder and asset actions call `pushAction`
// DIRECTLY, so a capture installed there would silently miss them — a batch would
// push some of its ops as separate entries and Cmd-Z would half-revert it. Diverting
// at the single choke point every action must pass through is the only version that
// cannot be bypassed.
//
// A STACK, not a flag, so a composite nested inside another composite folds in
// correctly: the inner one pushes its finished composite action, which the outer
// frame captures as a single sub-action.
//
// Deliberately NOT covered: pushes that arrive during an `await` inside the batch
// body from unrelated code (a debounced React effect committing). Single-threaded JS
// makes this rare, and batch bodies are expected to be short; the alternative
// (attributing pushes by async context) is not available in the browser. Keep batch
// bodies synchronous-ish.
const _captureStack: UndoAction[][] = [];

/** True while a capture frame is open — pushes are being diverted, not stacked. */
export function isCapturingActions(): boolean { return _captureStack.length > 0; }

/** Open a capture frame. Every subsequent `pushAction` lands in the returned array
 *  instead of the undo stack, until the frame is closed with `endActionCapture`.
 *  Callers MUST close it (use `runAsCompositeAction`, which does so even on throw) —
 *  a leaked frame silently swallows the human's edits. */
export function beginActionCapture(): UndoAction[] {
  const frame: UndoAction[] = [];
  _captureStack.push(frame);
  return frame;
}

/** Close the frame opened by `beginActionCapture` and return its captured actions.
 *  Also drops any frames opened ABOVE it that were never closed, so one leaked
 *  nested capture cannot wedge the manager into swallowing every later push. */
export function endActionCapture(frame: UndoAction[]): UndoAction[] {
  const idx = _captureStack.lastIndexOf(frame);
  if (idx === -1) {
    console.error('[undoManager] endActionCapture: frame is not open (double close?)');
    return frame;
  }
  if (idx !== _captureStack.length - 1) {
    console.error(`[undoManager] endActionCapture: ${_captureStack.length - 1 - idx} nested capture frame(s) were never closed; dropping them.`);
  }
  _captureStack.length = idx;
  return frame;
}

/** Push a new action. Clears redo stack. */
export function pushAction(action: UndoAction) {
  // Dropped inside a step's window (a closure's own push must not clear the redo stack it is about to land on). ⚠️ The
  // window is time, so a HUMAN forward edit made while a step awaits is dropped too (#1833); an AGENT one is refused
  // before it applies (#1832, `agentStepGate` in agentEditorOps.ts). When it edits the scene, the world now holds an edit
  // no token names and no undo can take back: every recorded state is forgotten HERE — the world and the push's scenes
  // move to fresh tokens — so no later step, whatever kind (file-direct, refused) or whichever scenes it touches, lands
  // on "saved" over it; and the window counts it, so the step in flight does not land either (#1904 close-out reviews
  // F2 and re-review 2). Before #1904 every step bumped the dirty counter, and this edit read unsaved by accident. A
  // closure's own push would count too — none in production does (re-review Q1) — costing only a clean-on-undo.
  const openWindow = currentStepWindow();
  if (openWindow) {
    if (!leavesSceneFile(action)) { openWindow.droppedEdits += 1; forgetRecordedStates(action, true); }
    return;
  }
  // Divert into the innermost open capture frame (see the block comment above).
  // BEFORE notifyEdited/coalesce/emit: a captured sub-action is not yet a committed
  // edit — the composite that wraps it does all three exactly once, for the batch.
  if (_captureStack.length > 0) { _captureStack[_captureStack.length - 1].push(action); return; }
  const edits = !leavesSceneFile(action);
  if (edits) notifyEdited(); // a real edit → the world has changed
  // Coalesce consecutive same-key edits (opt-in via coalesceKey) into the top
  // entry instead of stacking one per keystroke.
  if (action.coalesceKey != null) {
    const top = undoStack[undoStack.length - 1];
    const now = _clock();
    if (top && top.coalesceKey === action.coalesceKey
        // Never across an envelope boundary: a chain begun before the preview would absorb an edit
        // made inside it, and the merged entry could then be neither kept nor dropped on Exit.
        && (_pushedInPreview.get(top) ?? null) === currentPreview()
        && _coalesce && _coalesce.key === action.coalesceKey
        && now - _coalesce.at <= COALESCE_MS) {
      top.redo = action.redo;     // advance to the latest value…
      // The merged entry maintains the records only when both halves do: its undo is the first's, its redo the latest's.
      if (!action.maintainsRecords) delete top.maintainsRecords;
      top.label = action.label;   // …keep the ORIGINAL undo (pre-chain state)
      if (edits) recordForward(top, action.affectedScenes ?? []); // …and a new state, leaving the chain's `before`
      // NOTE: we deliberately do NOT advance `top.detail` here. The `!edit` journal
      // event was already emitted (with a frozen snapshot) on the first push of this
      // chain, so it reports the value at FIRST commit. Mutating a shared detail to
      // chase the final value is unsafe: (1) it wouldn't reach a since-cursor journal
      // poller (no new seq is emitted on coalesce), and (2) the per-entity helper's
      // filtered entity set can differ between pushes, so overwriting only `new` while
      // keeping the first push's `entities`/`old` misaligns the diff. Discrete Inspector
      // edits (text-blur / checkbox / dropdown) push exactly once → the snapshot is the
      // exact final value. For a continuous drag the `!edit` shows the first frame; the
      // authoritative final value is always live in scene-state / Watch.
      _coalesce.at = now;
      redoStack.length = 0;
      notifyUndoChanged(); // label/redo advanced — menu reflects the new label
      return;
    }
    _coalesce = { key: action.coalesceKey, at: now };
  } else {
    _coalesce = null; // a non-coalescing action ends any chain
  }
  const preview = currentPreview();
  if (preview !== null) _pushedInPreview.set(action, preview);
  if (edits) recordForward(action, action.affectedScenes ?? []);
  undoStack.push(action);
  redoStack.length = 0;
  if (undoStack.length > MAX_STACK_SIZE) {
    undoStack.shift();
    if (!_truncationWarned) {
      _truncationWarned = true;
      console.warn(`[undoManager] undo stack exceeded ${MAX_STACK_SIZE} entries; dropping oldest. This warning is shown once per session.`);
    }
  }
  notifyUndoChanged();
  // Editor Percept (Phase 7 + V1): a committed human edit. Selection vs a value/
  // structure edit. Coalesced keystrokes return early above → one event per edit, not
  // per key. `detail` (trait-field edits) / `journalPayload` (structural events) carry
  // the structured diff so Claude perceives exactly what changed — not just the label.
  // Snapshot into the event so the record is immutable + seq-stable (see the coalesce
  // note above). `kind` overrides the sigil for structural actions (!create/!delete/…).
  editorEmit(action.kind ?? (action._isSelection ? '!select' : '!edit'), buildEditorPayload(action));
}

/** Push a selection change as its own undo entry. */
export function pushSelectionChange(
  label: string,
  undoFn: () => void,
  redoFn: () => void,
) {
  if (currentStepWindow()) return;
  pushAction({ label, undo: undoFn, redo: redoFn, _isSelection: true });
}

/** Run one half of an already-popped action and do its bookkeeping. Shared by `undo` and
 *  `redo` so the two can't drift — before #310 they were duplicated, and both had the same bug.
 *
 *  ⚠️ **A THROWING closure DROPS the action** (#310, policy set by the owner 2026-08-21). It is
 *  already off its own stack and it does NOT go onto the other one, so there is no way back to
 *  that state through the history. That was the behaviour before too — the difference is that it
 *  is now deliberate and REPORTED, where it used to be silent: every statement after the `await`
 *  was skipped, so the entry vanished from the panel while the UI showed it as completed, and
 *  `serialize` handed the rejection to a caller that does not catch it.
 *
 *  Rejected alternatives, so nobody re-litigates them from first principles: putting it back on
 *  its own stack for a retry (a closure that threw PARTWAY has already applied some of its work,
 *  so ⌘Z again re-applies that half), and pushing it to the other stack as if it succeeded
 *  (keeps the stacks symmetric, but that is the original false success in a nicer costume).
 *
 *  Three things must happen on the failure path regardless of the policy, and each was a bug:
 *  - `notifyUndoChanged()` — the stack REALLY changed (the entry is gone), so a panel that skips
 *    this keeps rendering the pre-throw history.
 *  - The journal event still fires, carrying `failed: true`. Emitting nothing would let an entry
 *    disappear with no trace; emitting a bare `!undo` would claim an undo that did not happen.
 *  - The dirty signals fire. A closure that threw halfway HAS moved the world, and we cannot know
 *    how far, so marking dirty is the conservative direction — under-reporting loses the work.
 *
 *  Returns whether the step actually applied and, when it threw, what — as `failed` (#1681). Both reach the MCP
 *  `undo`/`redo` op (agentEditorOps.ts): `did` used to report success for a step that threw, and then, once it did
 *  not, a bare `did:false` that read as "the stack was empty" — the console line and the toast above are the human's,
 *  and an agent reads neither.
 *
 *  Also what the step REPORTED without throwing (#1823): every `reportUndoFailure` made while its window was open, as
 *  `shortfall` — the entry moved across the stacks as usual, but part of the step did not apply — and whether the
 *  entry was `dropped` because the world swapped under it. Each used to answer `did:true`. */
async function runStep(
  direction: 'Undo' | 'Redo',
  action: UndoAction,
  run: () => void | Promise<void>,
  pushTo: UndoAction[],
  event: '!undo' | '!redo',
): Promise<{ ok: boolean; failed: UndoStepFailure | null; shortfall: UndoShortfall | null; dropped: boolean }> {
  const window = openStepWindow(direction, action.label);
  let ok = false;
  let error: unknown;
  const sameHistory = _historyLiveness.capture();
  // Not `catch { }` + a sentinel: a closure may legitimately throw `undefined`, and testing the
  // caught value for one would read that as success.
  try { await run(); ok = true; } catch (e) { error = e; } finally { closeStepWindow(window); }
  const shortfall = window.shortfalls.length > 0
    ? { label: action.label, details: window.shortfalls.map((s) => s.detail) }
    : null;

  // A history swap during the await (a scene load, an Exit from prefab edit, a Create Scene) refilled `pushTo` IN
  // PLACE with the incoming world's stack. Pushed there, the entry would be undone or redone later against a world it
  // was never recorded on: a skipped Apply undo's redo loaded the old world's snapshot under the new scene's key and
  // saved it into that scene's file (#1575 close-out review). So it is DROPPED, as a throwing step's is, since the
  // world it belongs to is gone. An `_isFileDirect` entry edits an asset file, which outlives any world swap
  // (`parkSurvivors` keeps them too), so it stays.
  const worldGone = !sameHistory() && !action._isFileDirect;
  if (ok && !worldGone) pushTo.push(action);
  if (worldGone) console.warn(`[undo] ${direction} of "${action.label}" spanned a scene switch; it is dropped from the history`);

  // The world it moved is no longer the live one, so it dirties neither the incoming world nor the scenes it names:
  // those belong to the world that left, and a dirty mark on a scene that is not loaded makes the incoming world read
  // as unsaved (a load then refuses, and its next switch discards its history) and points Save All at a scene it
  // cannot write.
  // A REFUSED step (#1664) threw before it changed anything, so there is nothing to dirty: marking it would make the
  // world read as unsaved over a change that never happened (an agent's load then refuses on "unsaved work"). A step
  // that threw any other way may have moved the world partway, so it keeps the conservative marks (#310).
  const refused = !ok && error instanceof UndoRefusedError;
  if (!worldGone && !refused && !leavesSceneFile(action)) {
    notifyEdited(); // the world moved
    // Whole → back at the state the entry recorded (#1904), which is how an undo reaches the saved state. Partway →
    // nowhere any token names (#310, #1823).
    if (!(ok && !shortfall && window.droppedEdits === 0 && landOn(action, direction))) forgetRecordedStates(action, true);
  }
  if (!worldGone && refused && !leavesSceneFile(action)) forgetRecordedStates(action, false);
  notifyUndoChanged();
  notifyUndoRedoStep(); // after the step's data moved: a field ending its edit reads the undone value (#1905)
  const payload = buildEditorPayload(action);
  if (!ok) payload.failed = true;
  if (worldGone) payload.dropped = true; // it ran, and it is on neither stack
  if (shortfall) payload.shortfall = [...shortfall.details];
  editorEmit(event, payload);

  // Reported LAST, and guarded. `reportUndoThrew` reaches into the editor store to toast, and
  // this whole function exists because bookkeeping must not be skippable by a throw — leaving
  // the reporter able to skip it, or to reject out through `serialize`, would reproduce #310
  // one level up. A reporter that fails costs a message, never the state.
  if (!ok) {
    try {
      reportUndoThrew({ direction, label: action.label, error });
    } catch (e) {
      console.error('[undo] failed to report a throwing undo/redo closure', e);
    }
  } else if (shortfall) {
    // A throw's toast already says the step failed, so a shortfall it also reported adds nothing on screen.
    try {
      reportStepShortfall({ direction, label: action.label, userFixable: window.shortfalls.some((s) => s.userFixable) });
    } catch (e) {
      console.error('[undo] failed to report a step that did not fully apply', e);
    }
  }
  return { ok, failed: ok ? null : describeStepFailure(action.label, error), shortfall, dropped: worldGone };
}

/** What a throwing step's caller is told (#1681). A REFUSAL (`UndoRefusedError`) says why in its `toast` — the user's
 *  words, and the ones that say nothing was applied; any other throw gives its message. */
function describeStepFailure(label: string, error: unknown): UndoStepFailure {
  if (error instanceof UndoRefusedError) return { label, refused: true, error: error.toast };
  return { label, refused: false, error: error instanceof Error ? error.message : String(error) };
}

/** Why the next undo (or redo) is refused right now, or `null` when it may run (#1148).
 *
 *  Undo edits the AUTHORED scene, and outside `stopped` the live world is not that scene: Play
 *  reverts it on Stop, and a scrub/preview envelope reverts it on Exit. An undo of a scene edit there
 *  applies to a world that is about to be thrown away, pops its entry for good, and leaves the
 *  history one step past an edit the authored world never saw.
 *
 *  - **Play / Pause: every entry is refused**, as the Cmd+Z chord always did (Stop truncates the
 *    during-Play entries anyway — `truncateUndoTo`).
 *  - **Inside a scrub/preview envelope, it depends on the entry on top** (owner's rulings,
 *    2026-09-13). Allowed: an `_isFileDirect` entry — it edits an asset DOCUMENT (a clip, a
 *    timeline, a rig, a material — parked in the dirty-asset registry) that a snapshot restore
 *    never touches; a selection entry, which moves no world state; and a scene edit pushed INSIDE
 *    THIS preview session, whose before/after both belong to the posed world. Refused: a scene edit from
 *    before the envelope, which would apply to a world about to be reverted. When Exit restores
 *    the snapshot, `dropPreviewSceneEdits` removes the envelope's own scene entries, since the
 *    restore already threw their edits away and undoing one afterwards would write a preview value
 *    into the authored scene.
 *    The first ruling refused everything, and it cost more than it said: an Animation or Timeline
 *    clip undo RE-POSES, and a pose re-opens the envelope, so each ⏹ Exit bought exactly one undo
 *    (measured on #709: "exit → 'stopped'; first undo → 'scrub' again").
 *
 *  An EMPTY stack returns `null` — "nothing to undo" is not a refusal, and `undo()` says so itself.
 *
 *  ⚠️ Read `canEdit()`, NOT `getPlayState()`: the 3-value shim calls a preview `'stopped'`, which is
 *  how every Undo gate — and the panel buttons and agent ops, which were never gated at all — said
 *  "safe" inside an envelope. The gate lives HERE so every caller shares it. */
/** Authored restores still landing — Stop's included — registered by `authoredSnapshot.ts` rather than
 *  imported, so this module stays free of the scene-loading graph (#1572). Stop sets 'stopped' before
 *  its restore, so `canEdit()` reads true while the world is mid-reload: an undo there wrote a
 *  Play-time value into the reloaded world (the during-Play entries are truncated right after, so
 *  nothing reverted it), or undid a Persistent root that the restore's replay then overwrote. */
const _restoreBarriers: Array<() => boolean> = [];
export function registerUndoRestoreBarrier(isRestoring: () => boolean): void {
  _restoreBarriers.push(isRestoring);
}

export function undoRefusedReason(direction: 'undo' | 'redo' = 'undo'): string | null {
  const top = direction === 'undo' ? undoStack[undoStack.length - 1] : redoStack[redoStack.length - 1];
  if (!top) return null; // nothing to undo is never a refusal, whatever the mode
  if (_worldSwitches > 0) return `A scene switch is in progress — ${direction} again once it has landed.`;
  if (_forwardEdits > 0) return `An agent edit is still landing — ${direction} again once it has.`;
  if (_restoringSessions.size > 0) return `The preview is closing — ${direction} again once the scene has been restored.`;
  if (_restoreBarriers.some((isRestoring) => isRestoring())) return `The scene is being restored after Stop — ${direction} again once it has landed.`;
  if (canEdit()) return null;
  const mode = getRunMode();
  if (mode === 'playing') return `Stop the game to ${direction} — disabled during Play.`;
  if (worldFree(top)) return null;
  if (_previewSession !== null && _pushedInPreview.get(top) === _previewSession) return null;
  return `Exit the preview to ${direction} "${top.label}" — it is a scene edit from before this ${mode} preview, and the previewed world reverts on Exit.`;
}

/** Remove, from both stacks, the scene edits pushed during preview session `session` (#1148).
 *
 *  Called by the session controller right after it restores that envelope's snapshot
 *  (`endTimelinePreviewSession`). The restore has already discarded those edits, so their entries
 *  no longer describe the world: undoing one afterwards writes the posed world's `before` value
 *  into the authored scene (a recorded key's field edit), or respawns an entity the restore brought
 *  back, duplicating its guid. Asset-document and selection entries from the envelope are KEPT —
 *  the restore does not touch what they edit. Returns how many entries were removed. */
export function dropPreviewSceneEdits(session: number): number {
  const dropped = (a: UndoAction) => _pushedInPreview.get(a) === session && !worldFree(a);
  let removed = 0;
  for (const stack of [undoStack, redoStack]) {
    const kept = stack.filter((a) => !dropped(a));
    removed += stack.length - kept.length;
    stack.length = 0;
    stack.push(...kept);
  }
  if (removed > 0) {
    _coalesce = null;
    notifyUndoChanged();
  }
  return removed;
}

/** What one undo/redo step did: `did` — an entry was popped and its closure ran; `refused` — the
 *  gate's reason when it refused (`did` is then false and neither stack moved); `failed` — the entry was popped and its
 *  closure THREW (#310), so it was DROPPED from both stacks. `did:false` with both null is an empty stack, and only
 *  that (#1681: a throwing step used to answer the same bare `did:false`).
 *
 *  Two ways a step that did not throw still fell short (#1823), both of which used to be a bare `did:true`:
 *  `shortfall` — the closure REPORTED part of itself as not applied (`reportUndoFailure`); its entry moved to the other
 *  stack as usual. `dropped` — the world swapped under the step, so its entry is on NEITHER stack (`runStep`). A
 *  throwing step's entry is on neither stack too; `dropped` says it only for the step that did not throw. */
export interface UndoStepResult {
  did: boolean;
  /** The popped entry's label, or null when nothing was popped (a refusal, an empty stack). */
  label: string | null;
  refused: string | null;
  failed: UndoStepFailure | null;
  shortfall: UndoShortfall | null;
  dropped: boolean;
}

/** What a step reported as not applied (#1823): one `detail` per `reportUndoFailure` made inside its window. */
export interface UndoShortfall { label: string; details: string[] }

/** A step whose closure threw (#1681). `refused`: an `UndoRefusedError` — nothing was applied, and `error` is its
 *  user-facing reason; otherwise the step may have applied partway, and `error` is the thrown message. Either way the
 *  entry is gone from both stacks (`runStep`). */
export interface UndoStepFailure { label: string; refused: boolean; error: string }

/** Undo or redo one step, reporting a refusal as DATA. Serialized: if another undo/redo is in
 *  flight, this one waits its turn and pops only when it actually runs.
 *
 *  The gate is read when the step RUNS, not when it was called — a step queued behind an in-flight
 *  one can be refused by what that step did (a clip undo re-poses and opens an envelope, a Play
 *  pressed meanwhile). So a caller that must say WHY reads `refused` from here; checking
 *  `undoRefusedReason()` before calling races exactly that window and reports a refusal as an empty
 *  stack.
 *
 *  A THROWING closure drops the action, loudly (#310) — see `runStep` for why that is the
 *  chosen policy and what still has to happen on the failure path. */
export function undoStep(direction: 'undo' | 'redo'): Promise<UndoStepResult> {
  return serialize(async () => {
    const refused = undoRefusedReason(direction);
    if (refused !== null) return { did: false, label: null, refused, failed: null, shortfall: null, dropped: false };
    _coalesce = null; // any explicit undo/redo ends the current edit chain
    const action = (direction === 'undo' ? undoStack : redoStack).pop();
    if (!action) return { did: false, label: null, refused: null, failed: null, shortfall: null, dropped: false };
    // …and stale BEFORE it runs too: a rebase inside the step reads the store (#2046 S7.3), and a record this step is
    // about to leave behind must send it to the capture instead of reprojecting the step's work away.
    const at = peekCurrentWorld();
    if (at && !action.maintainsRecords) markStale(at, direction);
    const { ok, failed, shortfall, dropped } = direction === 'undo'
      ? await runStep('Undo', action, () => action.undo(), redoStack, '!undo')
      : await runStep('Redo', action, () => action.redo(), undoStack, '!redo');
    // #2001 S4: a step that does not maintain the instance list (S7 moves each onto records: "undo restores the exact
    // list", rule 8) leaves every record stale, whatever it touched or refused (`runtime/prefab/instanceStore.ts`). One
    // that does (`maintainsRecords`) leaves them fresh, unless it failed. The world current NOW (an undo can swap it),
    // and none is made: no world, no records.
    const world = peekCurrentWorld();
    if (world && (!action.maintainsRecords || failed)) markStale(world, direction);
    return { did: ok, label: action.label, refused: null, failed, shortfall, dropped };
  });
}

/** Undo the last action — `undoStep('undo')` as a boolean. `false` covers a refusal too; use
 *  `undoStep` when the caller has to tell the two apart. */
export function undo(): Promise<boolean> {
  return undoStep('undo').then((r) => r.did);
}

/** Redo the last undone action — `undoStep('redo')` as a boolean. */
export function redo(): Promise<boolean> {
  return undoStep('redo').then((r) => r.did);
}

/** The action currently at the top of the undo stack (next to be undone), if any.
 *  Lets a caller coalesce consecutive edits only while its own action is still on top. */
export function peekUndo(): UndoAction | undefined {
  return undoStack[undoStack.length - 1];
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Get the label of the next undo/redo action (for menu display). */
export function undoLabel(): string {
  return undoStack.length > 0 ? undoStack[undoStack.length - 1].label : '';
}

export function redoLabel(): string {
  return redoStack.length > 0 ? redoStack[redoStack.length - 1].label : '';
}

/** Clear all history. */
export function clearHistory() {
  _historyLiveness.invalidateAll();
  undoStack.length = 0;
  redoStack.length = 0;
  _coalesce = null;
  notifyUndoChanged();
}

// ── Play barrier ──────────────────────────────────────────
// During Play, editor edits mutate the play world; Stop reverts them by
// reloading the pre-Play snapshot. Those during-Play edits' undo entries would
// be incoherent after the revert, so Stop truncates the stack back to the depth
// recorded at Play-enter — preserving all PRE-Play history.

/** Current undo-stack depth (the barrier marker captured at Play-enter). */
export function undoDepth(): number { return undoStack.length; }

/** Drop every undo entry pushed after `depth` (truncate to it) and clear redo.
 *  Clamped to [0, length]; a depth ≥ length is a no-op for undo. */
export function truncateUndoTo(depth: number) {
  const d = Math.max(0, Math.min(depth, undoStack.length));
  // An asset file's edit survives Stop (#1857), so its entry does too, in order, above the barrier. Not a selection
  // (Stop's restore re-selects), and not an entry whose rebuild landed on the Play world (`_rebasesLiveFrames`).
  const kept = undoStack.slice(d).filter((a) => a._isFileDirect && !a._rebasesLiveFrames);
  undoStack.length = d;
  undoStack.push(...kept);
  redoStack.length = 0;
  _coalesce = null;
  notifyUndoChanged();
}

// ── Per-context (scene-keyed) history ─────────────────────
// Each logical scene (incl. the synthetic prefab-edit world) keeps its OWN undo
// history. Navigating to a scene swaps in its stacks instead of dropping undo;
// returning restores them. Play→Stop does NOT swap (same scene), so its history
// is preserved + barrier-truncated. Keyed by the scene's `normScenePath` key, not its raw path (#1786): the
// scene-file debt that retires a stack is keyed that way, and a raw key parked `Empty.scene.json`'s stack beside
// `empty.scene.json`'s — the same file on Windows/macOS — where the debt paid by one never reached the other.
// Every entry point below takes the key through it, so a caller hands any path form.

let _activeKey = '';
/** Invalidated each time the live stacks are refilled or emptied for another world — every effective
 *  `swapHistory`, and `clearHistory`. `runStep` captures it across its await: the stacks are the SAME arrays before
 *  and after a swap, so it is the only way a step can tell its entry's world has gone (#1575 close-out review). */
const _historyLiveness = createTeardownToken();
const _histories = new Map<string, { undo: UndoAction[]; redo: UndoAction[] }>();

/** Save the active stacks under the current key and load `key`'s stacks (empty
 *  on first visit). Used at genuine scene/context switches in place of
 *  clearHistory — so a returning scene restores its history. No-op if already
 *  on `key`, unless one of the options below says the stacks are stale.
 *
 *  ⚠️ A parked stack is only valid on a world that matches the one it was recorded against
 *  (#1409). A scene reloads FROM DISK, so that holds only when the outgoing world was CLEAN:
 *  - `discardOutgoing` — the outgoing world had unsaved edits that this swap throws away, so its
 *    stacks describe a state that no longer exists anywhere. They are DROPPED, not parked (except
 *    `_isFileDirect` asset edits, which the swap does not touch — `parkSurvivors`) — and
 *    that applies on a same-key reload too, which is exactly the case the early return used to
 *    skip: one undo after a discard-reload replayed the discarded work onto the fresh world.
 *  - `freshIncoming` — the incoming world is built from nothing (Create Scene's starter), so no
 *    world entry recorded under `key` can match it (asset edits again survive). */
export function swapHistory(
  key: string,
  { discardOutgoing = false, freshIncoming = false }: { discardOutgoing?: boolean; freshIncoming?: boolean } = {},
) {
  key = normScenePath(key);
  if (key === _activeKey && !discardOutgoing && !freshIncoming) return;
  _historyLiveness.invalidateAll();
  _coalesce = null; // a context switch ends any in-flight edit chain
  if (discardOutgoing) parkSurvivors(_activeKey, undoStack, redoStack);
  else _histories.set(_activeKey, { undo: [...undoStack], redo: [...redoStack] });
  _activeKey = key;
  if (freshIncoming) {
    const parked = _histories.get(key);
    if (parked) parkSurvivors(key, parked.undo, parked.redo);
  }
  const next = _histories.get(key);
  undoStack.length = 0;
  redoStack.length = 0;
  if (next) {
    undoStack.push(...next.undo);
    redoStack.push(...next.redo);
  }
  notifyUndoChanged();
}

/** The key the live stacks belong to: the last {@link swapHistory}'s. */
export function activeHistoryKey(): string { return _activeKey; }

/** The UNTITLED world just got a file (#1712): its live stacks now belong to `key`. Not a swap: the world and its
 *  stacks are unchanged, only their name moves, so nothing is parked or invalidated. A stack parked under `key`
 *  named that file's OLD content, which the save just replaced, so it is dropped (as {@link forgetHistory} does).
 *
 *  Without this the stacks stayed under '' while the world was bound to `key`, and the first hot reload of that
 *  file (which adopts under `key`) swapped them out for `key`'s empty stack: Cmd+Z emptied by an outside write,
 *  where a loaded scene keeps its stack through the same reload. Only from '' — no other context is untitled. */
export function rekeyUntitledHistory(key: string): void {
  key = normScenePath(key);
  if (_activeKey !== '' || key === '') return;
  _histories.delete(key);
  _histories.delete('');
  _activeKey = key;
}

/** A scene FILE moved or was renamed (#2078, B3 rule 12): its stacks follow it, as every other path-keyed record does.
 *  A parked pair moves with its own key. The LIVE pair moves only with the open scene (`openSceneTo`, the new path
 *  `applyMovesToOpenScene` confirmed by guid): two files can share a key (`normScenePath` folds case and decodes), and
 *  moving the live key on the key alone would leave the stacks under another file's name while the scene stays put.
 *  Left at the old key, the moved scene's next reload (it adopts under the new path) swapped its live stacks out for an
 *  empty pair, and a file created later at the old path inherited stacks recorded against another world (#1409). A
 *  delete (`to: null`) leaves them: the swap away from a deleted scene decides what survives. Called by
 *  `applyAssetPathMoves`. */
export function applyMovesToHistory(moves: readonly PathMove[], openSceneTo: string | undefined): void {
  const target = scenePathMoveKey(moves);
  // Every source out first, then every destination in: a chained `[A→B, B→C]` resolves against the original keys.
  const planned: Array<[string, { undo: UndoAction[]; redo: UndoAction[] }]> = [];
  for (const [key, pair] of _histories) {
    const to = target(key);
    if (to === undefined) continue;
    _histories.delete(key);
    planned.push([to, pair]);
  }
  for (const [to, pair] of planned) _histories.set(to, pair);
  if (openSceneTo !== undefined) _activeKey = normScenePath(openSceneTo);
}

/** Park only the entries that outlive a discarded world: `_isFileDirect` ones (material, clip,
 *  particle, skin, timeline… edits), whose target is a file the swap does not touch. Dropping them
 *  with the world's entries would strand an asset edit with no undo (#1409 review). Relative order
 *  is kept, and an empty result parks nothing. */
function parkSurvivors(key: string, undo: readonly UndoAction[], redo: readonly UndoAction[]) {
  const u = undo.filter((a) => a._isFileDirect);
  const r = redo.filter((a) => a._isFileDirect);
  if (u.length || r.length) _histories.set(key, { undo: u, redo: r });
  else _histories.delete(key);
}

/** Drop the stacks kept for `key`, so the next visit starts empty. For a file whose content was
 *  replaced wholesale (an agent Save As over it, #1414): its old entries name guids the new
 *  content does not have. No-op for the active key — that history is the live one. */
export function forgetHistory(key: string): void {
  key = normScenePath(key);
  if (key !== _activeKey) _histories.delete(key);
}

/** Test-only: reset the context map + active key. */
export function _resetHistoryContexts() {
  _historyLiveness.invalidateAll();
  _histories.clear();
  _activeKey = '';
  _captureStack.length = 0; // a test that threw mid-batch must not leak a capture frame
  _resetStepWindow(); // …nor a step window
  _forwardEdits = 0;
  _snapshotOps = 0;
  _forwardEditLiveness.invalidateAll();
  undoStack.length = 0;
  redoStack.length = 0;
  _coalesce = null;
  notifyUndoChanged();
}
