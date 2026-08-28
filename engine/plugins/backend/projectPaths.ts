/** Path shaping for values the editor writes into a project's config.
 *
 *  `POST /api/pick-path` hands the Project Settings dialog whatever the native chooser returned,
 *  and that is always ABSOLUTE. Some of those fields are per-machine and gitignored
 *  (`user.sdk.javaHome`, `user.sdk.androidHome`, `user.sdk.gcloudPath` → `project.user.json`), so
 *  an absolute path there is correct. One of them is not: `app.iconSource` lives in the TRACKED
 *  `project.config.json`, where `/Users/<name>/Projects/modoki/games/court/art/…` is dead on every
 *  other clone, dead on the `win` machine, dead in a copied-out `games/<id>` (#29), and is a real
 *  home path in a tracked file (#394).
 *
 *  So a picked path that lives inside the project is stored PROJECT-RELATIVE, and only one that
 *  genuinely escapes stays absolute. This is the whole of that decision, extracted from the route
 *  because the route itself cannot be unit-tested: it blocks on a modal `osascript` panel that
 *  only a human can dismiss (see `routeCoverage.test.ts`). */
import fs from 'node:fs';
import path from 'node:path';

/** Resolve symlinks in the CONTAINING directory only, keeping the leaf name as chosen.
 *  Resolving the leaf too would follow a symlink that lives inside the project out to its
 *  target and store the target's absolute path — the opposite of what the caller wants.
 *  Falls back to the input when the path does not exist (a synthetic path in a test). */
function realDir(p: string): string {
  const dir = path.dirname(p);
  try {
    return path.join(fs.realpathSync(dir), path.basename(p));
  } catch {
    return p;
  }
}

/** The project-relative form of `chosenAbs` when it resolves under `projectRoot`, else
 *  `chosenAbs` unchanged. Separators in the relative form are always POSIX `/` — the value is
 *  written into JSON that other machines read, and `path.join` accepts `/` on every platform. */
export function relativiseUnderProject(projectRoot: string, chosenAbs: string): string {
  // The chooser returns folders with a trailing slash; `path.relative` treats `a/b/` and `a/b`
  // alike, but the stored string should not carry it.
  const chosen = chosenAbs.length > 1 ? chosenAbs.replace(/\/+$/, '') : chosenAbs;
  const rel = path.relative(realDir(projectRoot), realDir(chosen));
  // `rel === ''` means the project root itself was picked. There is no relative spelling of that
  // an asset field could use, so it stays absolute rather than becoming an empty value that reads
  // as "unset".
  // `startsWith('..')` — the spelling this replaced — also rejects a directory whose NAME starts
  // with two dots (`..art/icon.png` is inside the project and has a perfectly good relative form).
  // Only the `..` segment itself means "escaped".
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`);
  const inside = rel !== '' && !escapes && !path.isAbsolute(rel);
  return inside ? rel.split(path.sep).join('/') : chosen;
}
