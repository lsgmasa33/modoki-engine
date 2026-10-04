/** Composite (transaction) undo actions — N independent sub-actions collapsed into
 *  ONE undo entry.
 *
 *  WHY THIS EXISTS. One agent tool call (`modoki_mutate_scene` carrying 20 ops) or one
 *  multi-step authoring command must be ONE Cmd-Z, not twenty. `coalesceKey` is NOT a
 *  substitute: it is time-windowed coalescing for repeated edits to the SAME field — it
 *  advances the top entry's `redo` while KEEPING the first action's `undo`. For a
 *  heterogeneous batch (an addEntity + three setTraits on different entities) that
 *  produces an entry whose undo reverts only the first op and silently strands the rest.
 *  A real composite keeps every sub-action and runs them all.
 *
 *  HOW THE SUB-ACTIONS ARE BUILT. Not by hand — by calling the existing `*WithUndo`
 *  helpers (writeTraitFieldWithUndo, createEntityWithUndo, deleteEntitiesWithUndo, …)
 *  inside {@link runAsCompositeAction}, which opens an undoManager CAPTURE frame for the
 *  duration. Each helper pushes as usual; `pushAction` diverts the push into the frame;
 *  the frame's contents become this one composite's sub-actions. This is deliberate:
 *  those helpers carry non-obvious correctness (guid-based re-resolution so undo/redo
 *  survive a Play→Stop world rebuild, prefab-instance override marking, animation
 *  record-mode notification). Re-deriving sub-actions "without the helpers" would fork
 *  that logic and rot.
 *
 *  ORDERING. Undo runs sub-actions in REVERSE order, redo in FORWARD order, each awaited
 *  before the next starts — stack-of-stacks semantics. Sub-undos are async (a prefab
 *  instantiate redo awaits), so sequencing is mandatory: running them concurrently would
 *  let a later op's undo observe a world the earlier op has not finished reverting.
 *
 *  ONE STEP, ALL OR NOTHING (#2010). Before the first sub runs, every sub's CHECK is asked, in run order, against one
 *  pass (`stepCheck.ts`): a sub that would refuse (its target gone, I19 / ruling R) refuses the whole entry with
 *  nothing changed, as one `UndoRefusedError`, and the entry is dropped like any refused step. The pre-pass ends where
 *  it cannot see: a sub with no check (an asset-doc step, a prefab instantiate, an animation-record clip edit), a
 *  detaching reparent, a delete's redo that promotes members, a respawned frame root whose prefab is not cached. A sub
 *  at or after that point that fails mid-run is reported as a `CompositeStepError`, which says it may have applied
 *  partway.
 *
 *  RE-ENTRANCY. A composite's own `undo`/`redo` run INSIDE an already-serialized
 *  `undoManager.undo()`/`redo()` call — `_executing` is true and the `_inFlight` tail is
 *  held. So this file must never call the exported `undo()`/`redo()` and never tries to
 *  re-acquire that lock; it is just a well-behaved single `UndoAction`. (The step window
 *  being open also means a sub-action that itself calls `pushAction` during undo/redo is
 *  refused by the manager, as for any other action.) A sub that REPORTS a shortfall
 *  (`reportUndoFailure`) lands in the same step's window, so the batch's result carries it.
 */

import {
  pushAction, beginActionCapture, endActionCapture, runOnStepChain,
  type UndoAction,
} from './undoManager';
import { UndoRefusedError } from './undoFailure';
import { newCheckPass, type CheckPass } from './stepCheck';
import { buildGuidIndex } from './entityRef';
import type { EditorJournalType } from '../editorJournal';

export interface CompositeActionOptions {
  /** Menu/journal label for the WHOLE batch, e.g. `Mutate Scene (4 ops)`. */
  label: string;
  /** Editor-journal sigil for the batch. Defaults to `!batch`. */
  kind?: EditorJournalType;
  /** Extra journal payload, merged OVER the auto-generated batch summary. */
  journalPayload?: Record<string, unknown>;
  /** Almost always omit: a batched command is its own undo step. Only set this if
   *  repeated invocations of the SAME batch genuinely want the top-entry merge (and
   *  re-read `pushAction`'s coalesce note first — the merge keeps the FIRST undo). */
  coalesceKey?: string;
}

/** How many sub-actions get summarized into the journal event before truncation.
 *  A cap, not a limit on the batch: every sub-action still undoes. */
const MAX_JOURNAL_OPS = 50;

/** structuredClone or a placeholder. The journal payload is cloned again inside
 *  `buildEditorPayload`, and a throw there would fire AFTER the stack was already
 *  mutated — corrupting undo to log it. Trait values are meant to be plain data, but a
 *  batch aggregates values from arbitrary traits, so this pre-sanitizes: whatever
 *  survives here is guaranteed to survive the second clone. */
function safeClone<T>(v: T): T | string {
  try { return structuredClone(v); } catch { return '<unserializable>'; }
}

/** One journal line per sub-action: its sigil, label, and whatever structured payload
 *  it carried (`journalPayload` for structural ops, `detail` for trait edits). */
function summarizeSubActions(subs: UndoAction[]): Record<string, unknown> {
  const ops = subs.slice(0, MAX_JOURNAL_OPS).map((a) => {
    const e: Record<string, unknown> = {
      kind: a.kind ?? (a._isSelection ? '!select' : '!edit'),
      label: a.label,
    };
    if (a.journalPayload) Object.assign(e, safeClone(a.journalPayload) as Record<string, unknown>);
    if (a.detail) {
      e.detail = {
        trait: a.detail.trait, field: a.detail.field, entities: [...a.detail.entities],
        old: safeClone(a.detail.old), new: safeClone(a.detail.new),
      };
    }
    return e;
  });
  const payload: Record<string, unknown> = { count: subs.length, ops };
  if (subs.length > ops.length) payload.truncated = subs.length - ops.length;
  return payload;
}

/** A batch whose sub-actions failed, and not all by refusing (#1823): at least one threw, or some refused while
 *  others applied. Its message names each failed sub, its class and its own message — an `AggregateError`'s default
 *  message named only the count, so the agent's reply lost every sub's reason. */
export class CompositeStepError extends AggregateError {
  constructor(errors: unknown[], message: string) {
    super(errors, message);
    this.name = 'CompositeStepError';
  }
}

/** Ask each sub's check for `what`, in the order the subs will run, against one pass (#2010, `stepCheck.ts`). A sub
 *  with no check makes the pass blind (a selection change excepted: it touches no entity), and so does a check that
 *  cannot state its own effect; nothing after a blind point is asked. A refusal throws, before any sub has run. */
function checkSubs(subs: UndoAction[], what: 'undo' | 'redo', pass: CheckPass): void {
  for (const sub of subs) {
    if (pass.blind) return;
    const check = sub.check?.[what];
    if (check) check(pass);
    else if (!sub._isSelection) pass.blind = true;
  }
}

/** The composite's pre-pass (#2010): ONE step refuses as a whole, before any change (rule 8; I19 / ruling R; Unity's undo
 *  group). Without it a sub that refused ran after the subs before it had applied, and the entry half-applied. The
 *  refusal names the sub and keeps its own toast, so the agent reads REFUSED_BY_OP with the sub's reason. A nested
 *  composite is one sub here: its own subs are asked through its `check`, against this same pass. */
function precheck(subs: UndoAction[], what: 'undo' | 'redo'): void {
  const pass = newCheckPass(buildGuidIndex());
  for (const sub of subs) {
    try {
      checkSubs([sub], what, pass);
    } catch (e) {
      if (!(e instanceof UndoRefusedError)) throw e;
      // The sub's own words first, as a single step's refusal reads; then which sub, and that nothing ran.
      throw new UndoRefusedError(
        `${e.message} (sub-action "${sub.label}" of this batch; the batch refuses as a whole, and nothing in it was ${what === 'undo' ? 'undone' : 'redone'})`,
        e.toast,
      );
    }
    if (pass.blind) return;
  }
}

/** Run each sub-action's `undo`/`redo` strictly one at a time, in the given order.
 *  Reached only past {@link precheck}, so a sub fails here when the pre-pass could not ask it (no check, or a blind
 *  point before it), or when its half throws for a reason no check covers.
 *  A failing sub does NOT abort the rest: a half-reverted batch is worse than a fully
 *  attempted one, and the entry has already left its stack by the time this runs.
 *  Failures are collected and rethrown so `undo()`'s promise still rejects visibly (matching a
 *  single action's behaviour: a throwing undo propagates and the entry is dropped rather than
 *  silently pretending to have worked).
 *
 *  What is rethrown keeps each sub's classification (#1823): when EVERY sub refused
 *  (`UndoRefusedError`), nothing in the batch applied, so the batch is refused too — one
 *  `UndoRefusedError` carrying every sub's reason — and the agent reads REFUSED_BY_OP, not PARTIAL.
 *  Anything else (a throw, or refusals beside subs that applied) may have applied partway: a
 *  `CompositeStepError` naming each failed sub. */
async function runSequential(subs: UndoAction[], run: (a: UndoAction) => void | Promise<void>, what: string): Promise<void> {
  const failures: { label: string; error: unknown }[] = [];
  // Each step CALLED as the loop element, so `notifyIsShared`'s fan-out detector sees this loop and its EXEMPT row
  // (async-sequential) stays earned; a `run(sub)` call hides the same fan-out from it.
  const steps = subs.map((sub) => () => run(sub));
  let i = 0;
  for (const step of steps) {
    const label = subs[i++].label;
    try { await step(); } catch (error) { failures.push({ label, error }); }
  }
  if (failures.length === 0) return;
  const errors = failures.map((f) => f.error);
  if (failures.length === subs.length && errors.every((e) => e instanceof UndoRefusedError)) {
    const refusals = errors as UndoRefusedError[];
    throw new UndoRefusedError(
      `every sub-action refused during ${what}: ${failures.map((f, i) => `"${f.label}": ${refusals[i].message}`).join(' | ')}`,
      refusals.map((e) => e.toast).join('; '),
    );
  }
  const describe = (e: unknown) => e instanceof UndoRefusedError ? `refused (${e.toast})` : `threw (${e instanceof Error ? e.message : String(e)})`;
  throw new CompositeStepError(
    errors,
    `${failures.length} of ${subs.length} sub-action(s) failed during ${what}: ${failures.map((f) => `"${f.label}" ${describe(f.error)}`).join('; ')}`,
  );
}

/** Wrap `subActions` into ONE `UndoAction`. Returns null for an empty batch — nothing
 *  happened, so nothing should occupy an undo slot.
 *
 *  JOURNAL DECISION (deliberate, see the Percept convention in `undoManager`): the batch
 *  emits exactly ONE editor-journal event, and the sub-actions emit NONE. They cannot:
 *  capture diverts them before `pushAction` reaches `editorEmit`, which is the point — N
 *  `!edit` events for what the human experiences as one Cmd-Z step would make the journal
 *  claim a granularity the undo stack does not have, and a `since`-cursor poller would
 *  see a batch as an indistinguishable burst of individual human edits. Instead every
 *  sub-action's structured payload (`journalPayload` / `detail`, the machine-readable
 *  halves Percept V1/V2 rely on) is folded into the single event's `ops` array — so no
 *  information is lost, it is just correctly nested under one commit. `count` is exact
 *  even when `ops` is truncated.
 *
 *  A single-sub batch is still wrapped, not unwrapped, so "one command = one entry with
 *  the caller's label" holds unconditionally — a caller cannot get a differently-labelled
 *  entry depending on how many ops its input happened to contain.
 *
 *  `_isSelection` / `_isFileDirect` are inherited only when EVERY sub-action carries
 *  them: both flags mean "this entry is not pending live-world work", and one real edit
 *  in the batch makes the batch a real edit. Conservative in the safe direction — the
 *  cost of over-reporting dirty is a spurious save prompt; of under-reporting, data loss.
 *
 *  `affectedScenes` is UNIONED from the sub-actions, and the composite MUST carry it:
 *  `pushAction` diverts a sub-action into the capture frame BEFORE it reaches
 *  `markAffectedScenesDirty`, so a captured sub never marks its own scene dirty. Dropping
 *  the union here made a live edit to a NON-primary loaded scene (a base scene) invisible
 *  to `saveAll`, which writes such a scene only `if (isSceneDirty(guid))` — the edit was
 *  silently never saved. The per-action skip condition is applied per SUB (a selection or
 *  file-direct sub contributes nothing), mirroring what each would have done unbatched.
 */
/** `action`, with `after` run once each of its directions has run: every other field kept, so what the stack reads off
 *  the action (its check, its kind, the scenes it dirties) is the action's own. A panel's Create Prefab re-wrapped its
 *  action as `{ label, undo, redo }` to refresh its listing, which dropped them (#2001 S8b). */
export function followedBy(action: UndoAction, after: () => void): UndoAction {
  return {
    ...action,
    undo: async () => { await action.undo(); after(); },
    redo: async () => { await action.redo(); after(); },
  };
}

export function composeUndoActions(
  subActions: UndoAction[],
  opts: CompositeActionOptions,
): UndoAction | null {
  if (subActions.length === 0) return null;
  const subs = [...subActions]; // frozen: the frame array must not mutate under us
  const reversed = subs.slice().reverse();
  const action: UndoAction = {
    label: opts.label,
    kind: opts.kind ?? '!batch',
    // Reverse order: later ops undo first (an op that depends on an earlier op's
    // result must be reverted before that result is taken away).
    // Every sub's check first (#2010): a sub that would refuse refuses the whole entry, before any sub has run.
    undo: async () => { precheck(reversed, 'undo'); await runSequential(reversed, (a) => a.undo(), 'undo'); },
    redo: async () => { precheck(subs, 'redo'); await runSequential(subs, (a) => a.redo(), 'redo'); },
    // Nested in another composite, this batch is one of its subs: the outer pass asks these subs, in this order.
    check: {
      undo: (pass) => checkSubs(reversed, 'undo', pass),
      redo: (pass) => checkSubs(subs, 'redo', pass),
    },
    journalPayload: { ...summarizeSubActions(subs), ...(opts.journalPayload ?? {}) },
  };
  if (opts.coalesceKey != null) action.coalesceKey = opts.coalesceKey;
  if (subs.every((a) => a._isSelection)) action._isSelection = true;
  if (subs.every((a) => a._isFileDirect)) action._isFileDirect = true;
  // One sub that rebuilt the live world makes the batch one that did (#1857).
  if (action._isFileDirect && subs.some((a) => a._rebasesLiveFrames)) action._rebasesLiveFrames = true;
  const scenes = new Set<string>();
  for (const a of subs) {
    if (a._isSelection || a._isFileDirect) continue; // that sub would not have marked either
    for (const guid of a.affectedScenes ?? []) scenes.add(guid);
  }
  if (scenes.size) action.affectedScenes = [...scenes];
  return action;
}

/** Roll a partially-applied batch back: undo the captured sub-actions in reverse,
 *  sequentially, isolating failures (this is already the error path — a second throw
 *  must not mask the first).
 *
 *  ⚠️ **On the step chain, not beside it** (#1823, `runOnStepChain`). These are undo closures, and
 *  some report a shortfall through `reportUndoFailure`, which records into whichever step's window
 *  is open — a TIME window (`stepWindow.ts`). Run beside a step that is awaiting, the rollback's
 *  reports would land in THAT step's result and a human's unrelated Cmd+Z would read as partial.
 *  On the chain, no step is open while it runs and none starts under it, so its reports stay
 *  console-only, as a forward path's always were. */
async function rollback(subs: UndoAction[]): Promise<void> {
  await runOnStepChain(async () => {
    for (let i = subs.length - 1; i >= 0; i--) {
      try { await subs[i].undo(); } catch (err) {
        console.error('[compositeAction] rollback of a sub-action failed; the world may be partially mutated', err);
      }
    }
  });
}

/**
 * Run `body` as ONE undo entry. Every `*WithUndo` helper (or raw `pushAction`) called
 * inside it is captured instead of stacked, and the captured actions are wrapped into a
 * single composite that is pushed once, after `body` resolves. Returns `body`'s result.
 *
 * ```ts
 * await runAsCompositeAction({ label: `Mutate Scene (${ops.length} ops)` }, () => {
 *   for (const op of ops) applyOneOp(op);   // each calls a *WithUndo helper
 * });
 * // → exactly one entry on the undo stack, one `!batch` journal event,
 * //   one `getEditVersion()` bump.
 * ```
 *
 * FAILURE = NOTHING HAPPENED. If `body` throws, the already-applied sub-actions are
 * rolled back (reverse order) and NO entry is pushed, then the error is rethrown. A
 * half-applied batch whose undo entry only covers the applied half is the worst outcome
 * available: the human sees a broken scene and Cmd-Z cannot fully fix it. Rolling back
 * is best-effort — a sub-undo that itself fails is logged, not swallowed into the
 * rethrown error, because the original failure is the one the caller must see.
 *
 * An empty batch (no op pushed anything — e.g. every op was a no-op) pushes nothing and
 * leaves the stacks, the edit version, and the journal untouched.
 */
export async function runAsCompositeAction<T>(
  opts: CompositeActionOptions,
  body: () => T | Promise<T>,
): Promise<T> {
  const frame = beginActionCapture();
  let result: T;
  try {
    result = await body();
  } catch (err) {
    // Roll back with the frame STILL OPEN, so an undo closure that itself pushes
    // (none do today) is discarded rather than landing a stray entry on the stack.
    await rollback(frame.slice());
    endActionCapture(frame);
    throw err;
  }
  const captured = endActionCapture(frame);
  const action = composeUndoActions(captured, opts);
  if (action) pushAction(action);
  return result;
}
