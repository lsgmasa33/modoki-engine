/** What a modal asset editor tells the human when its **Save** does not write. (#901)
 *
 *  ## Why this exists at all
 *
 *  `SpriteEditor.save` and `NineSliceEditor.save` each have two branches that return without
 *  writing, and both branches reported ONLY to `console.error`. The dialog stays open — deliberately
 *  (owner, 2026-08-18: *"the edit is not thrown away for a reason that has nothing to do with the
 *  edit"*) — so the human does get a signal that something happened. What they never got is a
 *  REASON, which makes a correct, load-bearing refusal indistinguishable from a Save button that is
 *  simply broken.
 *
 *  ⚠️ **The refusals themselves are correct and must not be softened.** `/api/write-meta` replaces
 *  the sidecar wholesale, so writing a document built on a failed read costs the asset its GUID and
 *  every scene/prefab reference to it dangles. This module changes only what the human is TOLD.
 *
 *  ## Why a module and not two inline strings
 *
 *  Both editors have the identical pair of branches with the identical meaning, and #901's whole
 *  point is that this class survived by being fixed one site at a time. Two copies of the wording
 *  drift on the first edit. It is a plain `.ts` beside the panels because that is where a panel's
 *  DECISIONS live and where the unit test can reach them (`docs/editor.md` § Panels — mounting a
 *  modal in jsdom asserts the mock, not the panel).
 *
 *  ## Delivery is INLINE, not a toast (owner, 2026-09-08)
 *
 *  The rule the two existing precedents imply: **deliver a refusal where the human is looking; toast
 *  only when there is nowhere to look.** A toast fits `parkMetaEdit` (#890/#891) because the park
 *  seam fires from anywhere and owns no panel; an in-flow banner fits the batch views (#886/#903)
 *  because the human is looking at the panel the refusal is about. A modal that is deliberately
 *  staying open is the second case — and a toast over an open dialog can be missed entirely by
 *  someone mid-drag in the slicer, which is exactly when a slice set is most expensive to lose. */

/** The two ways a modal editor's Save declines to write.
 *
 *  ⚠️ A union rather than a boolean or a bare string: the two have DIFFERENT remedies (reopen the
 *  dialog vs. press Save again), and a caller that cannot tell them apart cannot say which. */
export type SaveRefusal =
  /** The `.meta.json` was never read successfully, so a write would replace it with a document
   *  missing its GUID. Retrying Save cannot help — the base document is the problem. */
  | { kind: 'meta-never-read' }
  /** The read was fine and the POST failed (dev server down, 500). The edit is intact and pressing
   *  Save again is exactly the right move. */
  | { kind: 'write-failed' };

/** The sentence shown IN the dialog, beside the Save button that did nothing.
 *
 *  Each ends on what to DO, because a refusal that names no remedy just relocates the confusion —
 *  and the two remedies are opposites, which is the whole reason `SaveRefusal` is a union. */
export function saveRefusalMessage(refusal: SaveRefusal): string {
  switch (refusal.kind) {
    case 'meta-never-read':
      return '⚠ Not saved — this asset\'s import settings could not be read, so writing now would '
        + 'strip its ID and break every reference to it. Close and reopen this dialog once the dev '
        + 'server responds; your edit is still here until you do.';
    case 'write-failed':
      return '⚠ Not saved — the write failed (see the console for the server\'s reason). Your edit '
        + 'is intact and the dialog is staying open, so press Save again.';
  }
}

/** The console line, kept alongside the human-facing one so the two cannot drift apart.
 *
 *  ⚠️ **Both channels, not one.** #890/#891's ruling is that a refusal must reach the human — it is
 *  not that the log line was wrong. The log carries the path and the mechanism for whoever is
 *  debugging; the dialog carries the consequence and the remedy for whoever is editing. Dropping
 *  either one loses a reader.
 *
 *  ⚠️ **Do not name the `/api/write-meta` route in these strings.** Two corpus guards
 *  (`wholesaleMetaWriteProvenance`, `metaMergeNotClobber`) detect a sidecar WRITER by looking for
 *  that literal in comment-stripped source — deliberately, because the route is always a literal
 *  and never assembled, which is what caught `scene/modelImport.ts`'s raw POST. This module writes
 *  nothing; naming the route here made both guards classify it as an undeclared writer. Adding it
 *  to their WRITERS lists would have been the cheap fix and the wrong one: a declaration vouching
 *  for writes this file does not make is a false entry in the guard's own record. */
export function saveRefusalConsoleMessage(refusal: SaveRefusal, tag: string, path: string): string {
  switch (refusal.kind) {
    case 'meta-never-read':
      return `[${tag}] refusing to save ${path} — its .meta.json was never read successfully, so `
        + 'writing now would replace it with a document missing its GUID. Close and reopen once the '
        + 'dev server responds.';
    case 'write-failed':
      return `[${tag}] save failed for ${path} — the dialog is staying open so the edit is not lost. `
        + 'See the sidecar write error logged just above for the server\'s reason.';
  }
}
