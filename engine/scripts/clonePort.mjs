/**
 * Per-clone port derivation — the ONE implementation (#20, #69).
 *
 * Several clones of this repo share one machine (see the Clones section in the root
 * CLAUDE.md). Any harness that binds a FIXED port therefore assumes it is the only
 * clone, and two clones running it at once collide. Deriving the port from the clone's
 * own identity removes the contention instead of recovering from it.
 *
 * Keyed on the REPO PATH, deliberately, and NOT on MODOKI_BACKEND_PORT: that variable is
 * exported by launch-editor.sh for the EDITOR process only, so it is unset in the plain
 * shell that runs a test harness — deriving from it would put every clone back on one
 * port while looking fixed. The repo path is always available and needs no setup.
 *
 * Lives here as `.mjs` (with a hand-written .d.mts sidecar, per the engine/scripts
 * convention) so BOTH the shell harnesses and the TypeScript Playwright config use the
 * same algorithm. A second copy of the hash would drift.
 *
 * CLI:  node engine/scripts/clonePort.mjs <base> [slots] [repoRoot]   → prints the port
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default slot count. 200 is right for a dedicated high-port block (e2e); a harness
 *  living near other services should pass something tight, so its range cannot wander
 *  into a port that means something else. */
export const DEFAULT_SLOTS = 200;

/** One directory, one hash input — whatever SEPARATORS the caller's shell spelled it with.
 *
 *  ⚠️ The hash used to run on the RAW string, so one directory had two keys depending on which
 *  side of the bash→`node` seam you asked. `launch-editor.sh` derives `$REPO` in Git Bash and
 *  passes it to `node` as an argv token; MSYS rewrites the drive in transit
 *  (`/e/Projects/modoki` → `E:/Projects/modoki`) but leaves the separators alone, while every
 *  in-process caller derives `E:\Projects\modoki` from `defaultRepoRoot()`. Measured on the `win`
 *  clone: **9268** from the argv spelling, **9254** from the native one. Invisible on macOS, where
 *  the two are byte-identical — and the guard that catches it (`editorPorts.test.ts`) is skipped on
 *  the public snapshot, which ships no `engine/scripts/`.
 *
 *  ⚠️ **No consumer pair reads both sides TODAY — this hardens a latent divergence rather than
 *  repairing a live one, and an earlier draft of this comment claimed otherwise.** It said the
 *  launch banner advertised a CDP port no tool would aim at. It does not: `unpinnedCdpPort` has
 *  exactly one caller (`launch-editor.sh`'s `cdp-unpinned`), that arm is reached only when
 *  `BACKEND_PORT` is empty — never on a clone whose basename is a `CLONE_BACKEND_PORTS` row, which
 *  `modoki` is — and even in the unpinned case the same `$CDP_PORT` is both handed to Chromium and
 *  printed, so the banner cannot disagree with what binds. The 9268 came from running the CLI by
 *  hand. Every other hashed lane (38600, 38900, 38800, 38173) derives on only ONE side of its seam.
 *  The value here is that the next consumer to read both sides is correct by construction.
 *
 *  `path.normalize` is the whole fix and it is deliberately no more than that: on POSIX it is a
 *  no-op for an already-clean absolute path, so no existing Mac/Linux port moves. It also cannot
 *  and MUST NOT map `/e/…` → `E:\…` — that needs MSYS's mount table, and `/e/Projects` is a
 *  perfectly ordinary directory on a real POSIX box. What reaches this function from the launcher
 *  is already drive-spelled; only the separators were left to reconcile.
 *
 *  The trailing separator is stripped for the same reason — `…/modoki` and `…/modoki/` are one
 *  directory — but never past the root, so `/` and `E:\` still hash as themselves.
 *
 *  ⚠️ **Separator spelling only — CASE is deliberately out of scope.** `e:\Projects\modoki` and
 *  `E:\Projects\modoki` are still two keys (measured: 9266 vs 9250). The sibling lane DOES fold
 *  case, because `backendPortForClone` goes through `pathIdentity.mjs`'s `pathCaseKey` after #881
 *  measured `E:/Projects/MODOKI` as a real miss — and #910 forbids importing that here (below).
 *  Left unfolded rather than hand-rolled: no live caller emits a lowercase drive (MSYS argv
 *  conversion and `defaultRepoRoot()` both yield `E:`), and a second private copy of the
 *  case-folding rule is exactly the drift that helper exists to prevent. If a caller ever does,
 *  fold it THERE, at the caller, and say why.
 *
 *  ⚠️ **Yes, `engine/scripts/pathIdentity.mjs` already owns path identity, and NO, this cannot
 *  import it** — `entryPoint.test.ts` § "clonePort.mjs stays import-free (#910)" asserts this file
 *  imports nothing but `node:` builtins, so reaching for `canonicalPath` here reddens that guard.
 *  The duplication is structural, not an oversight; do not "consolidate" it.
 *
 *  ⚠️ It would also be WRONG on the merits, which is the more interesting half. `canonicalPath`
 *  resolves symlinks, and this hash deliberately does not: `editorPorts.test.ts` pins that the
 *  LOGICAL (symlinked) spelling of a clone hashes DIFFERENTLY from the canonical one, which is the
 *  control that lets the launcher-agreement assertion fail at all. Hence the split between the two
 *  lanes — `backendPortForClone` canonicalises through links (#881) because it CAN import; this
 *  one reconciles spelling only. Normalising separators is not a step toward resolving links.
 */
export function canonicalRepoKey(repoRoot) {
  const normalized = path.normalize(repoRoot);
  const { root } = path.parse(normalized);
  if (normalized.length <= root.length) return normalized;
  return normalized.replace(/[\\/]+$/, '');
}

/** Stable offset in `0 .. slots-1` for an absolute repo path. Same clone → same port on
 *  every run (so `lsof -ti :<port>` stays a usable habit); different clones → almost
 *  certainly different ports. */
export function clonePortOffset(repoRoot, slots = DEFAULT_SLOTS) {
  const digest = createHash('sha256').update(canonicalRepoKey(repoRoot)).digest('hex').slice(0, 8);
  return parseInt(digest, 16) % slots;
}

/** The derived port for a clone rooted at `repoRoot`, in `base .. base+slots-1`. */
export function clonePort(repoRoot, base, slots = DEFAULT_SLOTS) {
  return base + clonePortOffset(repoRoot, slots);
}

/** This repo's root (parent of engine/) — the default identity when none is passed. */
export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// CLI: print the port so a shell harness can capture it in a $(...).
//
// Compare RESOLVED REAL PATHS, never a `file://${process.argv[1]}` template. argv[1] is a
// raw OS path as typed; import.meta.url is a URL of the REALPATH. String-concatenating them
// matches only by luck, and every mismatch fails the same catastrophic way — the guard is
// false, the CLI prints NOTHING and exits 0, so `PORT=$(node clonePort.mjs …)` in
// smoke-packaged.sh / assert-app-renders.sh pins an EMPTY port with no error to show for it.
//
// Three independent ways it mismatched, all measured, not theorised:
//   1. Windows — backslashes + a `D:` drive letter (this is what reddened CI run
//      30695413747; every one of clonePortCli.test.ts's assertions failed at once).
//   2. Any platform — a repo path with a space/non-ASCII, which import.meta.url
//      percent-encodes and the raw argv does not.
//   3. Any platform — invocation through a SYMLINKED path (on macOS `/tmp` and
//      `/var` are symlinks), where the URL is already resolved and argv[1] is not.
// pathToFileURL fixes 1 and 2 but NOT 3, so it is not enough on its own. realpath both
// sides and the comparison is about file identity, which is what "am I the entry point?"
// actually means.
// ⚠️ **This file must import NOTHING but `node:` builtins, so it cannot reach the shared
// `pathIdentity.mjs`.** `clonePortCli.test.ts` COPIES it, alone, into a directory whose name
// contains a space — that copy is the whole apparatus proving the CLI still works from such a
// path, and an import of a sibling module makes the copy unrunnable. (Measured: it did. #881's
// first attempt migrated this to `samePath` and reddened that test with ERR_MODULE_NOT_FOUND.)
//
// So this is the ONE place a local canonicalisation is correct rather than copy #9 of the recipe.
// #881: the walk here was `fs.realpathSync`, which fixes reason 3 above but not a `subst`ed or
// case-flipped drive; `.native` fixes all three and is deliberately NOT banned by
// `pathIdentityIsShared.test.ts`. No case-fold is needed to go with it, unlike `samePath`: both
// operands name a file that EXISTS by construction — this module is running and `argv[1]` is what
// started it — so `.native` normalises the case itself and the fallback below is unreachable for
// any path that could make this true.
const canonicalHere = (p) => {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p); // not a real file (e.g. `node --eval`) — the spellings then differ anyway
  }
};
const isEntryPoint = () => {
  if (!process.argv[1]) return false;
  try {
    return canonicalHere(fileURLToPath(import.meta.url)) === canonicalHere(process.argv[1]);
  } catch {
    // `fileURLToPath` throws on a non-`file:` `import.meta.url` (a bundler shim, a custom loader).
    // It sat inside the old try/catch and must stay guarded: this runs at module load, so an
    // unguarded throw here stops `editorPorts.mjs`, `playwright.config.ts` and
    // `migrate-legacy-scenes.mjs` importing the module at all, rather than declining CLI mode.
    return false;
  }
};
if (isEntryPoint()) {
  const base = Number(process.argv[2]);
  if (!Number.isInteger(base) || base < 1 || base > 65535) {
    console.error('usage: clonePort.mjs <base> [slots] [repoRoot]   (base must be 1..65535)');
    process.exit(2);
  }
  const slots = process.argv[3] ? Number(process.argv[3]) : DEFAULT_SLOTS;
  if (!Number.isInteger(slots) || slots < 1) {
    console.error(`clonePort.mjs: slots must be a positive integer, got ${JSON.stringify(process.argv[3])}`);
    process.exit(2);
  }
  const root = process.argv[4] || defaultRepoRoot();
  console.log(String(clonePort(root, base, slots)));
}
