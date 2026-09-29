/** Which agent ops RECORD an editor undo entry (#1832) — the ones that must not overlap an undo/redo step.
 *
 *  A push made inside a step's window is dropped (`pushAction`, `stepWindow.ts`): the window is TIME, and it cannot
 *  tell the step's own calls from an agent edit that runs during the step's awaits. So `agentStepGate` REFUSES these ops
 *  while a step is queued or running, and holds every new step off while one runs (`beginForwardEdit`), rather than
 *  waiting (docs/scene-loading.md § "Readers of the world": refuse, don't wait).
 *
 *  Every op the editor registers is in exactly one of the two sets — `agentOpStepGate.test.ts` fails on an op in
 *  neither, so a new op is classified by whoever adds it rather than defaulting silently. Classified 2026-09-29 by
 *  reading each handler for a path to `pushAction`, a `*WithUndo` helper, `runAsCompositeAction` or an asset-undo
 *  builder.
 *
 *  ⚠️ `dom-dnd` is held only until it returns (its commit settle); a drop handler whose push lands after an await of
 *  its own (a prefab drop's fetch) pushes outside the hold. */

import { OpRefusal } from '../debug/opRefusal';

/** The refusal an undo-recording agent edit gets while an undo/redo step is queued or running (#1832). */
export function stepRunningRefusal(what: string): OpRefusal {
  return new OpRefusal('REFUSED_BY_OP',
    `${what} refused: an undo/redo step is still running, and an edit made while it runs would lose its undo entry. Nothing was changed.`,
    { options: [
      'retry once the undo/redo step has finished — a step waiting on a backend write clears when the write answers',
      'if it stays refused, a write the step awaits may never have answered: modoki_eval is never refused, to look',
    ] });
}

/** Reaches a push, or runs code that can (`eval`: `modoki.composite`, `modoki.import`). `create-registered-asset`
 *  selects the new asset for some kinds, which pushes a selection entry. `set-traits` pushes through the reparent
 *  hook when it writes `EntityAttributes.parentId`. The asset-document ops push through `pushAssetUndo`. `dom-dnd`
 *  synthesizes a drop that the Hierarchy and the Assets panel turn into undoable edits. */
export const UNDO_RECORDING_OPS: ReadonlySet<string> = new Set([
  'apply-scene-ops', 'create-entity', 'duplicate-entity', 'delete-entities', 'reparent-entity', 'set-traits',
  'prefab', 'create-registered-asset',
  'particle-set', 'anim-set-clip', 'anim-add-key', 'timeline-set', 'timeline-add-clip',
  'dom-dnd',
]);

/** `prefab` records an entry for these actions only. `overrides` reads; `edit-open`/`edit-exit` switch the world, which
 *  WAITS for a running step by design (#1579 — its unsaved-work gate must see the step's dirty mark), and `edit-save`
 *  writes a file. Refusing those would turn #1579's REQUIRES_SAVE into a bare "step still running". */
export const PREFAB_RECORDING_ACTIONS: ReadonlySet<string> = new Set(['instantiate', 'create', 'detach', 'apply', 'revert']);

/** Does this call record an undo entry? The op's class, narrowed by action for `prefab` (its `prefabAction`, or the
 *  relay's `action`, as the op itself reads it). */
export function recordsUndo(op: string, params: unknown): boolean {
  if (!UNDO_RECORDING_OPS.has(op)) return false;
  if (op !== 'prefab') return true;
  const p = (params ?? {}) as { prefabAction?: unknown; action?: unknown };
  const which = p.prefabAction ?? p.action;
  // A dry-run Apply writes and records nothing — the `overrides` reply sends an agent to exactly this call.
  if (which === 'apply' && (params as { dryRun?: unknown }).dryRun === true) return false;
  return typeof which === 'string' && PREFAB_RECORDING_ACTIONS.has(which);
}

/** Reach no push: reads, journal and watch plumbing, plain store/camera/play-state writes, and world swaps (which
 *  swap history rather than push). `eval` is here although its body can push: it is the agent's way to LOOK at an
 *  editor whose step is stalled, so it is never refused. Its `modoki.call`s pass the gate one by one, and
 *  `modoki.composite` asks the same question itself (`evalApi.ts`); a body that imports a `*WithUndo` helper and
 *  calls it directly is not held. `undo`/`redo` are steps themselves and queue behind each other. `game-tool-call`,
 *  `dispatch-action` and `step` run GAME code, and no game in the tree pushes an undo entry. `set-selection` writes
 *  the selection raw (`setSelectionRaw`). */
export const NON_RECORDING_OPS: ReadonlySet<string> = new Set([
  'undo', 'redo',
  'actor-lease', 'apply-asset-path-moves', 'clear-journal', 'console-logs', 'diagnose', 'discard-asset-edits',
  'dispatch-action', 'editor-journal', 'editor-state', 'enact-handles', 'eval', 'eval-api', 'exit-pose-envelope',
  'focus-entity', 'game-introspect', 'game-tool-call', 'game-tools', 'game-view-devices', 'hit-regions',
  'input-deliverability', 'input-watch-clear', 'input-watch-read', 'input-watch-start', 'input-watch-stop',
  'invalidate-assets', 'journal-events', 'layout-bounds', 'layout-settling', 'list-creatable-assets', 'load-scene',
  'new-scene', 'open-animation-editor', 'open-nine-slice-editor', 'open-particle-editor', 'open-skin-editor',
  'open-sprite-editor', 'pause', 'play', 'player-prefs-read', 'player-prefs-write', 'pose-clip', 'probe-key-reach',
  'profiler', 'read-asset-def', 'read-asset-meta', 'render-scene', 'resolve-dom-point', 'resolve-entity',
  'resolve-entity-point', 'resolve-refs', 'resolve-unsaved', 'resume', 'save-all', 'scene-query', 'scene-state',
  'select-sprite-slice', 'set-animation-view-mode', 'set-collider-edit', 'set-focus-scope', 'set-game-view-device',
  'set-gizmo', 'set-playhead', 'set-scene-view-mode', 'set-selection', 'set-skin-mode', 'set-timescale',
  'set-view-camera', 'sim-step', 'step', 'stop', 'wait-for', 'wait-for-edit', 'watch-clear', 'watch-list',
  'watch-read', 'watch-start',
]);
