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

/** Stable offset in `0 .. slots-1` for an absolute repo path. Same clone → same port on
 *  every run (so `lsof -ti :<port>` stays a usable habit); different clones → almost
 *  certainly different ports. */
export function clonePortOffset(repoRoot, slots = DEFAULT_SLOTS) {
  const digest = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
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
// actually means. (sync-agent-configs.mjs documents trap 1-2 and uses pathToFileURL; it
// carries hole 3 in theory, but it is only ever run as an npm script from the repo root.)
const isEntryPoint = () => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false; // argv[1] not a real file (e.g. `node --eval`) — not our entry point
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
