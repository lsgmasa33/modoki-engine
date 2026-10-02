/** A step's CHECK: the refusals of an undo or redo half, asked without running it (#2010).
 *
 *  WHY THIS EXISTS. A composite undo entry (one agent call's N ops, `compositeAction.ts`) is ONE step, so it refuses as
 *  a whole, before any change, when any of its sub-actions would refuse (rule 8 "undo restores the exact list it found";
 *  I19 / ruling R "a step re-finds its targets and refuses as a whole"; Unity's undo group). Each sub already asks for
 *  its refs at the top of its own closure, but the composite runs the subs one after another, so a refusal by the
 *  third sub came after the first two had applied: the entry half-applied, and was dropped from both stacks. A check
 *  lets the composite ask every sub first, then apply them all or none.
 *
 *  A CHECK IS PURE. It reads the world and throws `UndoRefusedError` with the words its half would throw; it writes
 *  nothing. It is asked against a {@link CheckPass}, not the live world alone: the subs of one pass run in order, and a
 *  later sub can need an entity an earlier sub brings back (a delete's undo respawns the parent a create's undo then
 *  needs, or a create's redo spawns the entity a field write's redo then edits). So a check also states the guids its
 *  half brings into the world ({@link arrive}), and the next check reads the pass, not the world alone. What a half
 *  takes OUT of the world is not tracked: in a history the stack recorded, no later sub of a pass needs an entity an
 *  earlier one removed (the forward run never had it either), so tracking it could refuse nothing.
 *
 *  WHAT A CHECK CANNOT TELL. A half whose effect on the world it cannot state (a prefab instantiate, a detach that
 *  changes which entities are instance members) marks the pass `blind`, and every check after it is skipped. That is
 *  the safe direction: a skipped check refuses nothing it should not, and the sub still asks its own refs when it runs,
 *  so a refusal there is reported as before (a `CompositeStepError`). A sub with NO check makes the pass blind too,
 *  unless it is a selection change, which touches no entity. */

import { requireWith, type EntityRef, type RefExpect } from './entityRef';

/** One pre-pass over a composite's subs, in the order they will run. */
export interface CheckPass {
  /** guid → live id at the start of the pass. */
  readonly index: Map<string, number>;
  /** Guids an earlier sub in the pass brings into the world (a respawn, a rename taken back). Present when the sub
   *  that needs them runs, so not a miss; their kind is the snapshot's, which no check can read before the respawn. */
  readonly arriving: Set<string>;
  /** An earlier sub's effect could not be stated: every later check is skipped. */
  blind: boolean;
}

export type StepCheckFn = (pass: CheckPass) => void;

/** The checks of an action's two halves. A half without one has no refusal to ask, or none that can be asked apart. */
export interface StepCheck {
  undo?: StepCheckFn;
  redo?: StepCheckFn;
}

export function newCheckPass(index: Map<string, number>): CheckPass {
  return { index, arriving: new Set(), blind: false };
}

/** The half being checked brings `guids` into the world. */
export function arrive(pass: CheckPass, guids: Iterable<string>): void {
  for (const g of guids) if (g) pass.arriving.add(g);
}

/** `requireWith` against the pass: a ref an earlier sub brings back passes, one that is gone now refuses in `require`'s
 *  own words, and a present one is checked for its kind and `expect.check` (I19, I20). */
export function checkRef(pass: CheckPass, ref: EntityRef, expect?: RefExpect, renamed?: ReadonlyMap<string, string>): void {
  let g = ref.guid;
  for (let hops = 0; g && renamed?.has(g) && hops < renamed.size; hops++) g = renamed.get(g)!;
  if (g && pass.arriving.has(g)) return;
  requireWith(ref, pass.index, expect, renamed);
}

/** `checkRef` for each of `refs`. */
export function checkRefs(pass: CheckPass, refs: readonly EntityRef[], expect?: RefExpect): void {
  for (const r of refs) checkRef(pass, r, expect);
}

/** The same check for both halves: a step whose undo and redo need the same refs and change no entity's presence (a
 *  field write, a component add or remove). */
export function refsCheck(refs: () => readonly EntityRef[]): StepCheck {
  const both: StepCheckFn = (pass) => checkRefs(pass, refs());
  return { undo: both, redo: both };
}
