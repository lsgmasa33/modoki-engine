/** ModelPreview's GPU-context-loss decisions, pulled out of the panel so they carry a test
 *  (editor `.tsx` does not; see `CLAUDE.md` § Tests / § Editor Panels).
 *
 *  Before #795, `teardown` only ran on unmount, when the "load the model" effect could not still
 *  be in flight. #795 made it reachable from a loss handler too, but the load effect had no way to
 *  hear about it: its `cancelled` flag is set only by the effect's OWN cleanup, which does not run
 *  when `teardown` fires mid-load. Two failures followed (finding 3, adversarial review of #795):
 *   (a) a resolved GLB kept attaching/collecting onto a scene the loss teardown had already
 *       disposed — nothing left to sweep it, since the ONE disposal already ran. (A parsed-but-
 *       unattached root in this state is disposed via `convertToGLB.ts`'s `disposeSourceModel` —
 *       the same helper the panel already calls for its OBJ/FBX/DAE path — rather than a second
 *       geometry/material sweep here; see finding 1, second adversarial review of #795, for why an
 *       earlier version of this file grew its own near-copy that leaked every texture.)
 *   (b) the load effect's `if (!s) return;` guard, reached on the NEXT model selection, sat BEFORE
 *       `setLoading(true)` — so it silently left `loading: false, error: null`, reporting a
 *       successfully-loaded, empty box forever.
 */

import { REOPEN_INSPECTOR_HINT } from './previewLossPolicy';

export type LoadGate =
  | { proceed: true }
  /** A GPU-loss teardown already ran before (or during) this effect's mount check — there is no
   *  live renderer/scene left for a load to attach to. `error` is what the panel should show
   *  instead of silently leaving `loading: false, error: null` (finding 3b). */
  | { proceed: false; error: string };

// Single-sourced from `previewLossPolicy.ts`'s `REOPEN_INSPECTOR_HINT` (finding 6, third
// adversarial review of #795) — this used to hardcode its own "Reopen the panel to rebuild it.",
// a second copy of a phrase the DEFAULT hint owns, and the WRONG one for this panel besides (see
// that constant's doc for why "reopen the panel" doesn't apply to ModelPreview).
const LOST_MESSAGE = `3D preview unavailable — GPU context was lost; ${REOPEN_INSPECTOR_HINT}.`;

/** Called at the top of the "load the model" effect. `hasState` is `stateRef.current !== null` —
 *  false means the mount effect's teardown (unmount OR a GPU-context loss, #795) already ran. */
export function gateModelLoad(hasState: boolean): LoadGate {
  return hasState ? { proceed: true } : { proceed: false, error: LOST_MESSAGE };
}

/** Whether a resolved (already-collected) GLB root may be ATTACHED to `modelRoot`/a `THREE.LOD`.
 *  `cancelled` is the load effect's own supersession flag (a new `sourceUrl`/`lodChoice` — the
 *  next `clearModel()` will sweep whatever this run collected).
 *
 *  This used to also take an `aborted` flag (finding 3a) for the mount effect's teardown — but at
 *  its one call site `aborted` is checked by an early `if (s.aborted) { …; return; }` a few lines
 *  above, so by the time this runs it is PROVABLY false; a test pinning that branch would be
 *  asserting on an input production can never produce (finding 7, third adversarial review of
 *  #795). Dropped rather than kept for a symmetry no caller needs. */
export function shouldAttachLoadedModel(cancelled: boolean): boolean {
  return !cancelled;
}
