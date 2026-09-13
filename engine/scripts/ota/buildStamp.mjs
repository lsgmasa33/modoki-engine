/** Which source tree an OTA-publishable dist was built from (#906).
 *
 *  An OTA manifest is signed and content-addressed, so it proves *this is exactly the bundle we
 *  published*. It says nothing about *which source built it*: "the player is on shell v13" had no
 *  path back to a commit. This module is both halves of closing that:
 *
 *   - **Build side** (`build-web.mjs --target native`, `build-subgame.mjs`): read the git state when
 *     the build STARTS, re-read HEAD when it ends, and write `modoki-build.json` into the dist.
 *   - **Publish side** (`ota-publish.mjs`): {@link otaBuildProvenance} decides from that file whether
 *     the dist may be published, and what `manifest.build` records.
 *
 *  ⚠️ **The stamp is written by the BUILD, never read from the publisher's checkout.** `ota-publish.mjs`
 *  takes a `--dist` somebody else built, possibly earlier and on another machine, so its own cwd says
 *  nothing about that build. Stamping the uploader's tree would record the wrong commit, confidently.
 *
 *  ⚠️ **The stamp lives INSIDE the dist**, not beside it: `vite build` empties the out dir, so a stamp
 *  in there cannot outlive the build that wrote it. A sidecar next to the dist would survive a later
 *  rebuild by anything that does not restamp, and vouch for bytes it never saw.
 *
 *  ⚠️ **Unknown is never clean.** Git missing, not a repository, or a read that did not complete all
 *  record `null` rather than a guess, and {@link otaBuildProvenance} refuses a `null` exactly like a
 *  dirty tree — the null-conflates-absent-with-unknown trap `gitError.mjs` exists for.
 *
 *  **Dirty is measured at build START** (plus HEAD re-checked at the end), not after: the native
 *  build legitimately rewrites tracked files itself (the heals, generated icons), and those are the
 *  build's own output rather than uncommitted source. The residual this accepts: an edit made to a
 *  source file while the build is running, which HEAD does not see. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** The stamp's file name inside a dist. */
export const BUILD_STAMP_FILENAME = 'modoki-build.json';

const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Is `value` a full git object name (SHA-1, or SHA-256 for a repository using it)? */
export function isCommitSha(value) {
  return typeof value === 'string' && COMMIT_RE.test(value);
}

/** Runs one git read. `null` when git did not return a successful answer — never ran, exited
 *  non-zero, died on a signal, or overflowed — because every one of those means "could not tell". */
function gitRead(dir, args) {
  // A generous buffer: a large untracked tree must not overflow into a false "could not tell", the
  // shape #1120 measured. Overflowing still lands on the null side, which is the safe side.
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return res.stdout;
}

/** The current HEAD commit of the repository containing `dir`, or `null` when it cannot be read. */
export function readHeadCommit(dir) {
  const out = gitRead(dir, ['rev-parse', '--verify', 'HEAD']);
  const sha = out?.trim();
  return isCommitSha(sha) ? sha : null;
}

/** What `dirty` looks at: the whole worktree (`:(top)`, so it does not narrow to `dir`), EXCEPT every
 *  `ios/` and `android/` folder. Those are native projects: an OTA bundle is the web dist, and nothing
 *  under them reaches it (checked 2026-09-13: the only tracked non-native-looking files there are
 *  `google-services.json`). They are excluded because a NATIVE BUILD REWRITES THEM ITSELF — measured on
 *  `games/ota-test`, the first `build-web.mjs --target native` stamped clean and left 3 modified and 8
 *  new icon files behind, so the next build, and every editor publish after it, read dirty with no
 *  override the editor can pass (close-out review of #906). */
export const PROVENANCE_PATHSPEC = Object.freeze([':(top)', ':(top,glob,exclude)**/ios/**', ':(top,glob,exclude)**/android/**']);

/** `{ commit, dirty }` for the repository containing `dir`. `dirty` counts tracked changes AND
 *  untracked, non-ignored files anywhere in the worktree outside native project folders
 *  ({@link PROVENANCE_PATHSPEC}): an untracked source file is exactly as able to reach the bundle as a
 *  modified one. Either field is `null` when git could not answer it. */
export function readGitProvenance(dir) {
  const commit = readHeadCommit(dir);
  if (commit === null) return { commit: null, dirty: null };
  const status = gitRead(dir, ['status', '--porcelain', '--untracked-files=normal', '--', ...PROVENANCE_PATHSPEC]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

/** The stamp to write once the build has finished, from the reading taken at its start and HEAD as it
 *  is now. HEAD moving mid-build means the sources vite read may belong to two commits, so the build is
 *  not reproducible from either one: that is recorded as dirty. */
export function settleBuildStamp(start, endCommit) {
  if (start.commit === null) return { commit: null, dirty: null };
  if (endCommit !== start.commit) return { commit: start.commit, dirty: true };
  return { commit: start.commit, dirty: start.dirty };
}

/** Writes the stamp into `distDir`. */
export function writeBuildStamp(distDir, stamp) {
  writeFileSync(path.join(distDir, BUILD_STAMP_FILENAME), `${JSON.stringify({ commit: stamp.commit, dirty: stamp.dirty }, null, 2)}\n`);
}

/** May a dist with this stamp be published, and what does its manifest record? (#906)
 *
 *  - `stampText`: the raw contents of the dist's {@link BUILD_STAMP_FILENAME}, or `null` when the
 *    file does not exist.
 *  - `allowUnclean`: `ota-publish.mjs --allow-unclean-build` — the CLI's only override (owner,
 *    2026-09-13: the editor route and `modoki_ota_publish` deliberately cannot pass it).
 *
 *  Returns `{ build }` when publishable — `build` is what goes into `manifest.build` — or
 *  `{ refusal }`. Only a stamp naming a commit AND saying `dirty: false` publishes unforced. Everything
 *  else refuses, and with `allowUnclean` publishes instead with `forced: true` and whatever the stamp
 *  did establish. `forced` is `false` whenever nothing was overridden, even with the flag passed, so a
 *  retry of a clean publish still hashes identically and resumes. Pure. */
export function otaBuildProvenance({ stampText, allowUnclean }) {
  const decide = (refusal, known) => (allowUnclean
    ? { build: { commit: known.commit, dirty: known.dirty, forced: true } }
    : { refusal });
  if (stampText === null) return decide('no-stamp', { commit: null, dirty: null });
  let stamp;
  try {
    stamp = JSON.parse(stampText);
  } catch {
    return decide('bad-stamp', { commit: null, dirty: null });
  }
  const isObject = stamp !== null && typeof stamp === 'object' && !Array.isArray(stamp);
  const commitOk = isObject && (stamp.commit === null || isCommitSha(stamp.commit));
  const dirtyOk = isObject && (stamp.dirty === null || typeof stamp.dirty === 'boolean');
  if (!commitOk || !dirtyOk) return decide('bad-stamp', { commit: null, dirty: null });
  const known = { commit: stamp.commit, dirty: stamp.dirty };
  if (known.commit === null || known.dirty === null) return decide('unknown-tree', known);
  if (known.dirty) return decide('dirty', known);
  return { build: { commit: known.commit, dirty: false, forced: false } };
}
