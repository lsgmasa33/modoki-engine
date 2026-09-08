/** Preview3DShell's "may I populate this handle" decision, extracted to a plain `.ts` so it is
 *  testable without mounting the `.tsx` panel (`CLAUDE.md` § Editor Panels).
 *
 *  Before #795 wired GPU-context-loss detection into `previewScene.ts`, a lost context left the
 *  handle non-null but permanently dead; nothing told this shell. Selecting a different
 *  Mesh/Material asset (which does NOT unmount the shell — only closing the Inspector does)
 *  re-ran the populate effect against that dead handle: no throw, so the box showed the
 *  background with no "Loading…" and no error — success for a surface that will never draw
 *  (finding 2, adversarial review of #795). `PreviewSceneHandle.disposed` (added alongside this)
 *  makes that state observable; this module says what to DO with it. */

/** The one thing this module needs from a `PreviewSceneHandle` — kept minimal so it doesn't need
 *  to import `previewScene.ts`'s full type or `three`. */
export interface DisposableHandle {
  readonly disposed: boolean;
}

export type PopulateGate =
  | { proceed: true }
  /** `error` is `null` when there is nothing to populate for a reason ALREADY surfaced elsewhere
   *  (no handle at all — WebGL unavailable, reported at construction) vs a message this decision
   *  itself must show (a handle that died after construction). */
  | { proceed: false; error: string | null };

const LOST_MESSAGE = '3D preview unavailable — GPU context was lost.';

/** Called both BEFORE populating and again AFTER an async `populate()` resolves — a loss can land
 *  mid-populate, and re-checking only before the await would still report success for content
 *  added onto a scene that died while it was loading. */
export function gatePopulate(handle: DisposableHandle | null): PopulateGate {
  if (!handle) return { proceed: false, error: null };
  if (handle.disposed) return { proceed: false, error: LOST_MESSAGE };
  return { proceed: true };
}
