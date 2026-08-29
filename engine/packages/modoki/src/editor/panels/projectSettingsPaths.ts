/** The Project Settings dialog's one path DECISION, kept out of the `.tsx` so it carries a unit
 *  test rather than a jsdom mount (CLAUDE.md § Editor — a panel's decisions live in a plain `.ts`
 *  beside it).
 *
 *  #394: `app.iconSource` is committed, so a machine-local value there is dead on every other
 *  clone, dead on the `win` machine, and dead in a copied-out `games/<id>` (#29). `/api/pick-path`
 *  relativises a pick that lands INSIDE the project, but two routes still produce an absolute one:
 *  picking a file outside the project (which has no relative form), and typing/pasting into the
 *  text box. Both are legal to store — the build honours an absolute `iconSource` — so this warns
 *  in place instead of refusing; `tests/architecture/trackedConfigPaths.test.ts` is the backstop
 *  that stops one reaching a commit. */

/** A value that will not survive being read on another machine or in a copied-out project:
 *  absolute (POSIX or Windows), home-relative, UNC, spelled with `\` (dead on macOS/Linux, and the
 *  only route into the field on `win`, where `/api/pick-path` returns `{unsupported:true}` and the
 *  text box is all there is), or escaping the project with a `..` segment (#29).
 *
 *  ⚠️ **This is the ONE definition.** `tests/architecture/trackedConfigPaths.test.ts` — the gate
 *  that fails on a committed offender — imports it rather than restating it: two hand-synced
 *  copies would drift, and the half that drifts is the warning, which then goes quiet on a value
 *  the gate still rejects. */
export function isNonPortableProjectPath(value: string): boolean {
  const v = value.trim();
  return v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[\\/]/.test(v)
    || v.includes('\\') || v.split('/').includes('..');
}

/** The warning to show under a `path` field, or `null` when there is nothing to say.
 *  Only `committedPath` fields warn: an absolute `user.sdk.javaHome` is CORRECT — that subtree
 *  is per-machine by design and gitignored. */
export function committedPathWarning(
  field: { type: string; committedPath?: boolean },
  value: unknown,
): string | null {
  if (field.type !== 'path' || !field.committedPath) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!isNonPortableProjectPath(value)) return null;
  return 'This path is saved to the tracked project.config.json, where a machine-local path is '
    + 'dead on every other clone and in a copied-out project. Move the file inside the project '
    + 'folder and pick it again.';
}

/** Extensions the dialog will try to PREVIEW. Deliberately the same list the backend's
 *  `/api/source-image` will serve — a value this says is an image and that route refuses would
 *  show a permanent "cannot preview" under a perfectly good icon. */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

/** The path a `path` field should show a thumbnail of, or `null` for a field with nothing to
 *  show.
 *
 *  Keyed off the VALUE's extension rather than a schema flag (owner, 2026-08-29: "every path"),
 *  so a preview appears wherever one is meaningful without seven fields having to opt in and an
 *  eighth being forgotten. A field holding a `.jks` or a folder simply never matches, and a field
 *  holding nothing matches nothing — so the widened rule cannot make a non-image field noisier. */
export function imagePreviewPath(field: { type: string }, value: unknown): string | null {
  if (field.type !== 'path') return null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v !== '' && IMAGE_EXT_RE.test(v) ? v : null;
}

/** Whether a `path` field should accept a drag at all.
 *
 *  ⚠️ **A drop is NOT stopped by the thing that makes the rest of this dialog inert.** Both inert
 *  states are `<fieldset disabled>` — the per-field `disabledIf` wrapper and the whole-form one
 *  used when `configErrors` says the config file did not parse. That primitive disables form
 *  CONTROLS natively, which is the whole reason the dialog uses it instead of threading a
 *  `disabled` prop through twelve `case`s; but a `drop` handler on a plain `<div>` is not a form
 *  control, so it stays live. The per-field wrapper happens to also set `pointerEvents:'none'` and
 *  is safe by accident; the whole-form one does not, and a drop there would COPY A FILE INTO THE
 *  PROJECT and edit a draft the user is explicitly forbidden from saving — a disk write in the one
 *  state the dialog exists to declare untrustworthy.
 *
 *  So `disabled` is read from the field's own input at drop time — via `:disabled`, whichever
 *  wrapper supplied it — rather than passed down. Same reasoning as that `Field` docblock: derive
 *  inertness from the ONE native mechanism, so a wrapper nobody has added yet is covered too.
 *
 *  ⚠️ The caller must probe with `el.matches(':disabled')`, NOT `el.disabled`. The IDL property
 *  reflects the element's own content attribute only, and reads `false` for an input disabled by
 *  an ancestor `<fieldset disabled>` — which is every case in this dialog. This function takes the
 *  answer as a boolean precisely so that probe has one place to be right; it was written wrong the
 *  first time and the unit tests could not have caught it. */
export function shouldAcceptSettingsDrop(disabled: boolean, types: readonly string[]): boolean {
  if (disabled) return false;
  // Claim only what this field can consume, so an entity drag over the dialog keeps its own
  // cursor instead of being promised a drop that does nothing.
  return types.includes('Files') || types.includes('application/editor-asset');
}
