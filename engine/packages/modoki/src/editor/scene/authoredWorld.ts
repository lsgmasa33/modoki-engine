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
const _fallbacks = new Map<string, () => boolean>();
/** What to do about a reason, for a source whose way out is not "stop Play / exit the preview" ({@link notAuthoredExit}). */
const _exits = new Map<string, string>();

/** Register a source that can say "the live world may be posed right now". `label` is the whole
 *  reason clause the refusal text quotes ("a preview session is open"). Re-registering a label
 *  replaces it (a hot-reloaded module re-registers). A `fallback` source is asked only after every
 *  other one: its reason is broader, so a more specific one that is also true names the exit instead
 *  (#1750: "a scene is still loading" is true during a Stop's restore too, which says "retry"). */
export function registerPosedWorldSource(label: string, isPosed: () => boolean, opts: { fallback?: boolean; exit?: string } = {}): void {
  (opts.fallback ? _fallbacks : _sources).set(label, isPosed);
  if (opts.exit) _exits.set(label, opts.exit); else _exits.delete(label);
}

/** The way out of `reason` (a {@link whyWorldNotAuthored} answer) when its source registered one — "try again once it's
 *  open" for a landing scene switch (#1750) — else undefined, and the writer names its own (stop Play, exit the preview).
 *  So a refusal never tells a user waiting for a scene to open to stop a Play that is not running. */
export function notAuthoredExit(reason: string | null): string | undefined {
  return reason === null ? undefined : _exits.get(reason);
}

/** The way out of `reason` for a writer's refusal, or undefined when the reason carries its own: the source's registered
 *  exit ({@link notAuthoredExit}), else "stop Play" or "exit the preview" — whichever is RUNNING, and only while one is (#1873). A restore
 *  still landing, or one that FAILED, reads 'stopped' and says what to do in its own reason; told to stop a Play that is
 *  not running, the user was sent the wrong way. The one wording every writer's refusal uses. */
export function notAuthoredAdvice(reason: string | null): string | undefined {
  if (reason === null) return undefined;
  const own = notAuthoredExit(reason);
  if (own || canEdit()) return own;
  return getRunMode() === 'playing' ? 'stop Play first' : 'exit the preview first';
}

/** Why the live world is NOT authored, or null when it is. The text is for a refusal message. */
export function whyWorldNotAuthored(): string | null {
  if (!canEdit()) return `run-mode is '${getRunMode()}', not 'stopped'`;
  for (const [label, isPosed] of [..._sources, ..._fallbacks]) {
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
