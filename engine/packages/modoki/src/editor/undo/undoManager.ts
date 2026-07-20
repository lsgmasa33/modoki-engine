/** Undo/Redo manager — command stack for all editor actions. */

import { editorEmit } from '../editorJournal';

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
  kind?: string;
  /** Extra structured journal payload for NON-trait-edit events (structural /
   *  transform) — e.g. `{ entities: [guid] }` for a delete, `{ entity, from, to }`
   *  for a reparent. Merged into the emitted event and snapshot-cloned at emit so the
   *  record is immutable. Plain serializable data only. */
  journalPayload?: Record<string, unknown>;
  /** Internal tag for coalescing consecutive selection-only actions */
  _isSelection?: boolean;
  /** Consecutive actions sharing a non-null `coalesceKey`, pushed within
   *  COALESCE_MS of each other, merge into the existing top entry: its `redo`
   *  (and `label`) advance to the latest edit while its original `undo` — the
   *  state before the chain started — is kept. This collapses a field's
   *  per-keystroke writes ("1" → "1." → "1.2" → "1.25") into ONE undo step
   *  (editor-inspector.md F6). Undefined ⇒ never coalesces; that's the default
   *  for structural actions and the discrete-click coalescing the Particle/
   *  Animation editors do themselves via peekUndo() identity. */
  coalesceKey?: string;
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
  for (const l of _changeListeners) l();
}
/** Subscribe to undo/redo stack changes. Returns an unsubscribe fn. */
export function subscribeUndo(listener: () => void): () => void {
  _changeListeners.add(listener);
  return () => { _changeListeners.delete(listener); };
}
/** Stable version snapshot — bumps on every stack mutation. */
export function getUndoVersion(): number { return _version; }

// ── "has the WORLD been edited since save?" (C7) ──────────────────────────────
// Distinct from _version, which also bumps on SELECTION (selection deliberately pushes undo
// entries — see CLAUDE.md), so _version would read as "unsaved work" after a mere click.
// This counts only real edits, so load_scene/new_scene can refuse to silently DESTROY
// unsaved live work — the case that used to report {ok:true, entityCount:12} while the
// entity you just made was gone from the world, the file, AND the undo stack.
//
// Conservative by design: undo/redo bump it too, so undoing back to the on-disk state still
// reads as dirty. A spurious "save or pass force" is a nuisance; the reverse is data loss.
let _editVersion = 0;
function notifyEdited() { _editVersion++; }
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

/** Guard: true while executing undo/redo to prevent re-entrant pushes */
let _executing = false;
export function isExecutingUndoRedo(): boolean { return _executing; }

// ── In-flight serialization (undo/redo mutex) ─────────────
// `undo`/`redo` are async (an action's undo/redo may `await`, e.g. prefab
// instantiate redo). The keyboard handler fires them WITHOUT awaiting, so a rapid
// Cmd+Z, Cmd+Z (or Cmd+Z then Cmd+Shift+Z) could otherwise start a second
// undo/redo while the first is mid-`await`: the second `pop()` runs before the
// first's `await action.undo()` resolves and before its `redoStack.push`,
// corrupting stack order. `_executing` only blocks PUSHES, not re-entrant
// undo/redo. We chain every undo/redo onto a single tail promise so they run
// strictly one-at-a-time, in call order, and each pops the stack only when it is
// actually its turn (editor-prefab-system.md F6).
let _inFlight: Promise<unknown> = Promise.resolve();
/** Serialize `op` after any in-flight undo/redo. The chain never rejects (each
 *  op is isolated) so one failing undo can't wedge the queue. */
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = _inFlight.then(op, op);
  _inFlight = run.catch(() => {});
  return run;
}

/** Push a new action. Clears redo stack. */
export function pushAction(action: UndoAction) {
  if (_executing) return; // don't push during undo/redo execution
  if (!action._isSelection) notifyEdited(); // a real edit → the world now differs from disk
  // Coalesce consecutive same-key edits (opt-in via coalesceKey) into the top
  // entry instead of stacking one per keystroke.
  if (action.coalesceKey != null) {
    const top = undoStack[undoStack.length - 1];
    const now = _clock();
    if (top && top.coalesceKey === action.coalesceKey
        && _coalesce && _coalesce.key === action.coalesceKey
        && now - _coalesce.at <= COALESCE_MS) {
      top.redo = action.redo;     // advance to the latest value…
      top.label = action.label;   // …keep the ORIGINAL undo (pre-chain state)
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
  if (_executing) return;
  pushAction({ label, undo: undoFn, redo: redoFn, _isSelection: true });
}

/** Undo the last action. Serialized: if another undo/redo is in flight, this
 *  one waits its turn (it pops the stack only when it actually runs). */
export function undo(): Promise<boolean> {
  return serialize(async () => {
    _coalesce = null; // any explicit undo ends the current edit chain
    const action = undoStack.pop();
    if (!action) return false;
    _executing = true;
    try { await action.undo(); } finally { _executing = false; }
    redoStack.push(action);
    if (!action._isSelection) notifyEdited(); // the world moved relative to disk
    notifyUndoChanged();
    editorEmit('!undo', buildEditorPayload(action));
    return true;
  });
}

/** Redo the last undone action. Serialized like `undo`. */
export function redo(): Promise<boolean> {
  return serialize(async () => {
    _coalesce = null;
    const action = redoStack.pop();
    if (!action) return false;
    _executing = true;
    try { await action.redo(); } finally { _executing = false; }
    undoStack.push(action);
    if (!action._isSelection) notifyEdited(); // the world moved relative to disk
    notifyUndoChanged();
    editorEmit('!redo', buildEditorPayload(action));
    return true;
  });
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
  undoStack.length = d;
  redoStack.length = 0;
  _coalesce = null;
  notifyUndoChanged();
}

// ── Per-context (scene-keyed) history ─────────────────────
// Each logical scene (incl. the synthetic prefab-edit world) keeps its OWN undo
// history. Navigating to a scene swaps in its stacks instead of dropping undo;
// returning restores them. Play→Stop does NOT swap (same scene), so its history
// is preserved + barrier-truncated. Keyed by scene path.

let _activeKey = '';
const _histories = new Map<string, { undo: UndoAction[]; redo: UndoAction[] }>();

/** Save the active stacks under the current key and load `key`'s stacks (empty
 *  on first visit). Used at genuine scene/context switches in place of
 *  clearHistory — so a returning scene restores its history. No-op if already
 *  on `key`. */
export function swapHistory(key: string) {
  if (key === _activeKey) return;
  _coalesce = null; // a context switch ends any in-flight edit chain
  _histories.set(_activeKey, { undo: [...undoStack], redo: [...redoStack] });
  _activeKey = key;
  const next = _histories.get(key);
  undoStack.length = 0;
  redoStack.length = 0;
  if (next) {
    undoStack.push(...next.undo);
    redoStack.push(...next.redo);
  }
  notifyUndoChanged();
}

/** Test-only: reset the context map + active key. */
export function _resetHistoryContexts() {
  _histories.clear();
  _activeKey = '';
  undoStack.length = 0;
  redoStack.length = 0;
  _coalesce = null;
  notifyUndoChanged();
}
