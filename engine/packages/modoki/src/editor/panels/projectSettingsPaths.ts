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
