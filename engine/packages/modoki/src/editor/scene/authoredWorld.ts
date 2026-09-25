/** Is the LIVE world authored right now — safe to write to a scene or prefab file? (#1548)
 *
 *  ONE question, asked by every writer that serializes the live world: `saveScene` (and through it
 *  Save All, the agent `save-all`, Create Scene, the save before opening a prefab), `savePrefabEdit`,
 *  Apply to Prefab, Create Prefab. They used to ask `getRunMode() !== 'stopped'` each — or nothing —
 *  and the run mode is the wrong question at exactly the dangerous moment: an envelope's exit sets
 *  'stopped' BEFORE its restore has swapped the posed world out (a panel's ⏹ Exit does not await the
 *  restore; Stop flips the mode, then reloads). A write in that window passed the check and wrote the
 *  pose — the agent `save-all` reported `ok:true` with a posed value in the file, and Apply to Prefab
 *  had no check at all, baking a pose into a template every scene shares.
 *
 *  So the answer is the run mode AND every source that knows the world may still be posed. A LEAF
 *  module on purpose: the sources register themselves (the preview session, the authored restore),
 *  because `serialize.ts` — the first writer — cannot import the session without a cycle.
 *
 *  NOT the world-replacement token (`authoringSettle.ts`): the Cmd+S preview cycle holds that token
 *  across its own suspend → save → resume, so asking it would refuse every save made while previewing.
 *  A source here must mean "the live world may hold non-authored values", nothing broader. */

import { canEdit, getRunMode } from '../../runtime/core/playState';

const _sources = new Map<string, () => boolean>();

/** Register a source that can say "the live world may be posed right now". `label` is the whole
 *  reason clause the refusal text quotes ("a preview session is open"). Re-registering a label
 *  replaces it (a hot-reloaded module re-registers). */
export function registerPosedWorldSource(label: string, isPosed: () => boolean): void {
  _sources.set(label, isPosed);
}

/** Why the live world is NOT authored, or null when it is. The text is for a refusal message. */
export function whyWorldNotAuthored(): string | null {
  if (!canEdit()) return `run-mode is '${getRunMode()}', not 'stopped'`;
  for (const [label, isPosed] of _sources) {
    // FAIL CLOSED: this gates a disk write, so a source that cannot answer counts as posed — the cost
    // is a refused save with a reason, where skipping it could write a pose.
    let posed = true;
    try { posed = isPosed(); } catch (e) { console.error(`[authoredWorld] "${label}" threw — treating the world as not authored`, e); }
    if (posed) return label;
  }
  return null;
}

/** True when the live world holds only authored values — the precondition for writing it to disk. */
export function isWorldAuthored(): boolean {
  return whyWorldNotAuthored() === null;
}
