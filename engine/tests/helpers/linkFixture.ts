/**
 * Directory-link fixtures for tests, and the clone-root spellings a shell reap is given (#949).
 *
 * Two jobs, both of which the repo previously answered differently at every call site:
 *
 *  1. **Make a directory link that works on every platform we run on.**
 *  2. **Derive a clone's two root spellings the way the PRODUCTION caller derives them**, so a
 *     test driving `repo-reap.sh` feeds it an input shape the real callers can actually produce.
 *
 * ## 1 — `makeDirLink`: `'junction'` on win32, `'dir'` elsewhere
 *
 * A `'dir'` symlink on Windows needs `SeCreateSymbolicLinkPrivilege` (or Developer Mode); a
 * junction needs nothing. Before this helper the repo spelled that four ways —
 * **9** unconditional `'junction'`, **2** `process.platform === 'win32' ? 'junction' : 'dir'`,
 * several bare `'dir'` (some wrapped in `try`/`ctx.skip`, some not), and **three calls that named
 * no `type` at all** (#949). The next author copies whichever neighbour they happen to read,
 * which is exactly how the bare calls got written.
 *
 * ⚠️ **Two of those three are FILE links, and this helper cannot serve them** — see
 * `canMakeFileLink` below. An earlier draft of this docblock said there was exactly ONE untyped
 * site; close-out review found a second, eighteen lines below the first, in the same suite. A
 * census asserted as complete is what stops the next reader counting, so it is stated here as a
 * count with its exceptions rather than as a single site.
 *
 * ⚠️ **The two link types are NOT interchangeable in general, and this helper's contract is that
 * they are interchangeable for RESOLUTION.** Everything in this repo that cares reaches a path
 * through `canonicalPath` → `fs.realpathSync.native`, which resolves a junction and a directory
 * symlink identically. Measured, rather than argued from the docs:
 *
 *   - `fs.realpathSync.native(<junction>)` returns the target.
 *   - `fs.lstatSync(<junction>).isSymbolicLink()` is `true`.
 *   - bash `pwd -P` through a junction returns the target's spelling (see `cloneRootSpellings`).
 *   - `projectPaths.test.ts` — the suite #949 named as the one that "may care which one it gets",
 *     because it exercises `relativiseUnderProject` through a symlinked ancestor — passes all 17
 *     cases identically with `'junction'` substituted at `:79`.
 *
 * ⚠️ **The narrow exception, and it is real: a test whose SUBJECT is the link type itself must
 * not use this helper.** If the test asserts on the link rather than resolving through it — it is
 * reproducing a specific on-disk shape some other tool created, rather than aliasing a directory
 * — then which reparse point it gets is the thing under test. `vendorPlugins.test.ts` is the
 * live example: it manufactures npm's *old symlink form* on purpose and skips on Windows, and it
 * is deliberately NOT migrated. Say so at the call site when you make that choice, so the next
 * reader can tell a decision from an oversight.
 *
 * ## 2 — `cloneRootSpellings`: ask the shell, do not convert the string
 *
 * `repoReapSpellings.test.ts` registered roots built from `os.tmpdir()` — native `E:\…` on
 * Windows — and drove `repo-reap.sh` with them. No production caller can produce that shape:
 * `launch-editor.sh`'s `REPO`/`REPO_LOGICAL` and `stop-editor.sh`'s `REPO`/`REPO_PHYS` both use
 * bash `pwd` / `pwd -P` (cited by SYMBOL, not line: #961 moved the launcher's pair and renamed its
 * second variable, which a line citation would have silently outlived). The result
 * was a harness that on Windows tested an input the code never receives, went RED for it, and
 * proved nothing about the case it claimed to cover. It was green on macOS only because
 * `os.tmpdir()` happens to yield a POSIX path there.
 *
 * ⚠️ **Converting the string in JS is not good enough, and a naive `E:\ → /e/` is measurably
 * wrong.** MSYS has a mount table: with `TEMP=E:\dev-temp`, `cygpath -u 'E:\dev-temp\x'` is
 * `/tmp/x`, not `/e/dev-temp/x`. `reap_alt_pattern` prefix-matches the pattern against the
 * registered root with a `case` glob, so a root and a marker built by different rules silently
 * stop matching and the second spelling is never tried — which is the very defect this harness
 * exists to catch.
 *
 * So this does not convert anything: it runs **the same two commands production runs**, in the
 * same shell, and returns what they print. There is nothing left to get wrong.
 *
 * ⚠️ **It shells out on BOTH platforms on purpose.** A `process.platform` branch here would mean
 * each CI leg exercises a different code path, so a break in one is invisible to the other — the
 * failure mode `docs/falsifiable-tests.md` is about. The only consumers already require `bash`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The `type` argument for a directory link on this platform.
 *
 *  Exported for the guard test, which asserts the value rather than re-deriving it — a guard that
 *  recomputes the thing it is checking cannot fail. */
export const DIR_LINK_TYPE: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * Create a directory link at `linkPath` pointing at `target`.
 *
 * Throws on failure — deliberately. A helper that swallowed the error would turn "this machine
 * cannot make links" into a fixture that silently is not there, and every assertion downstream
 * would then be testing the un-aliased path while reporting a pass. Callers that genuinely want
 * to skip rather than fail gate on `canMakeDirLink()` instead.
 */
export function makeDirLink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, DIR_LINK_TYPE);
}

/**
 * A temp directory for a link fixture, rooted at the CANONICAL temp path.
 *
 * ⚠️ **`os.tmpdir()` is not its own realpath on macOS, and using it raw is a silent cross-platform
 * defect** — found by close-out review, and it is the exact mirror of the Windows bug this helper
 * was written to fix. A fixture built on the raw path hands a SPAWNED process the unresolved
 * spelling in its argv, while `cloneRootSpellings` reports `pwd -P`, which resolves the ancestor
 * too — so the reap's second spelling names a path no process carries and matches nothing.
 *
 * **Measured on a real Mac** (macOS 26.5.2 arm64, by the `win-helper` session — this clone cannot
 * run darwin, and the claim was an inference until it was checked):
 *
 *     os.tmpdir()   /var/folders/nt/…/T
 *     realpath      /private/var/folders/nt/…/T      ← differs; /var is a symlink to /private/var
 *     pwd           /var/folders/nt/…/T/tmp.WCTYRu9r0D
 *     pwd -P        /private/var/folders/nt/…/T/tmp.WCTYRu9r0D
 *
 * ⚠️ **And it is not just bash: `process.cwd()` returns the `/private` spelling too.** Anything
 * derived from the OS `getcwd()` canonicalises — a spawned process reporting its own cwd, a
 * resolved module path, a log line. **`os.tmpdir()` is the single OUTLIER**, because it merely
 * echoes `$TMPDIR` (which on macOS even carries a trailing slash; `os.tmpdir()` strips it, but a
 * hand-built prefix comparison would not). That reframes what this function is for: it is not
 * "canonicalise a path for tidiness", it is **moving the one value that disagrees onto the spelling
 * everything else already uses.**
 *
 * Independently reproduced on win32 before that confirmation, by rooting a fixture under a
 * junctioned temp dir and driving the real `repo-reap.sh` — the alt pattern named the target while
 * the process carried the link, and matched nothing. Driven end to end on macOS afterwards:
 * `reap_repo_alive` returned **1 (not found)** with the raw temp root and **0 (found)** with the
 * canonicalised one.
 *
 * ## ⚠️ What exactly was wrong — it is narrower than "the temp root was not canonical"
 *
 * The pattern and the process's argv differed along **two axes at once**: the symlink the fixture
 * built (`clone-link` → `modoki-qa`) and the `/var` aliasing it did not. `reap_alt_pattern`
 * substitutes only the registered ROOT prefix, so it rewrote the first axis CORRECTLY and produced
 * `/private/var/…/modoki-qa/…` — while the sleeper's argv still read `/var/…/modoki-qa/…`. It
 * missed by exactly the one axis the mechanism is not for.
 *
 * So this **removes a confound, it does not paper over the symlink logic** — and that is
 * mutation-verified rather than asserted: with the canonical root in place, neutering
 * `reap_alt_pattern` still reddens both symlink cases, because `clone-link` vs `modoki-qa` still
 * differs. The fix subtracts the second axis so the first one is what is under test.
 *
 * ⚠️ **This is a HARNESS defect, not a production one, and it must not be read as a shipped bug.**
 * Real clones live under `/Users/…` and `E:\Projects\…`, neither of which has an aliased ancestor,
 * so the second axis cannot arise in a real reap. What was broken was the test's ability to say
 * anything true — on the platform it was not written on.
 *
 * ⚠️ **No CI leg could see this when it was written**: `check` ran ubuntu (real `/tmp`) and
 * windows-latest (`C:\…\Temp`, no aliased ancestor), with NO macOS `check` job — only `package
 * (macos-14)`. **`macos-14` joined the public `check` matrix on 2026-09-09**, so an equivalent
 * regression would now be caught automatically. The manufactured-alias design below stays as it
 * is: it makes the mechanism falsifiable on EVERY leg rather than only the one platform that
 * exhibits it naturally, which is a stronger property than "a leg exists".
 *
 * ⚠️ **But "no CI leg" is NOT "nothing would catch it", and an earlier draft of this docblock said
 * it would have "gone green everywhere the gate runs". That is false** — the HUB runs
 * `npm run verify` on the Mac when it merges a worker branch, and this would have been red there.
 * The precise hazard is narrower and more interesting: **the hub SKIPS `verify` when the merge is a
 * FAST-FORWARD** (CLAUDE.md § Dev Workflow), and a worker branch is a fast-forward candidate
 * exactly when it has just merged `origin/main` in — which the same document REQUIRES before
 * pushing. So the two rules interact: following the merge-first rule is what makes the platform
 * the author cannot run most likely to go unchecked. Worth knowing before assuming the hub is a
 * safety net for a platform-specific change.
 *
 * `killPackagedGuard.test.ts` already canonicalises its temp root by hand for this reason; this is
 * that, made the default. The link the fixture creates is unaffected — `logical` still keeps it
 * and `physical` still resolves it, so the fixture stays meaningful (verified).
 *
 * ⚠️ **`base` exists ONLY so this is falsifiable.** No caller passes it. Without it the
 * canonicalisation cannot be mutation-checked anywhere `os.tmpdir()` is already its own realpath —
 * which is `win`, windows-latest and ubuntu, i.e. every machine that gates this repo. The guard
 * passes a deliberately aliased base so breaking the line below goes red HERE rather than only on
 * the five Mac clones. A seam that exists for the test is worth more than a property nothing on
 * this continent can check.
 */
export function makeFixtureRoot(prefix: string, base: string = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(base), prefix));
}

let probed: boolean | undefined;
let fileProbed: boolean | undefined;

/**
 * Can this machine create a directory link at all? Cached after the first call.
 *
 * ⚠️ **A real link in a real temp dir, never a capability guess.** `process.platform` cannot
 * answer this (a POSIX box with a read-only tmpdir fails too, and a Windows box with the
 * privilege succeeds at `'dir'`), and a probe that reasons instead of trying is the thing that
 * makes a skip silently permanent.
 *
 * On win32 this is now expected to be TRUE unconditionally — junctions need no privilege — which
 * is the point: suites that used to skip on an unelevated Windows box now RUN there. If it ever
 * returns false on win32, something is wrong with the volume (FAT, or a sandbox), not with a
 * user's privileges.
 */
export function canMakeDirLink(): boolean {
  if (probed !== undefined) return probed;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'linkcap-'));
  try {
    fs.mkdirSync(path.join(d, 't'));
    makeDirLink(path.join(d, 't'), path.join(d, 'l'));
    probed = true;
  } catch {
    probed = false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  return probed;
}

/**
 * Can this machine create a FILE symlink? Cached after the first call.
 *
 * ⚠️ **There is no privilege-free equivalent for a file link, so this one really can be false and
 * the caller really must skip.** `makeDirLink` escapes the privilege by using a junction, which is
 * a directory-only reparse point; a file symlink needs `SeCreateSymbolicLinkPrivilege` exactly as a
 * `'dir'` symlink does. A hardlink is not a substitute — it has different identity semantics and a
 * test aliasing a file usually cares about precisely that.
 *
 * So a test that links a FILE gates on this and skips; it does not get to be platform-blind the way
 * `makeDirLink`'s callers do. Both sites in the repo that need it are in suites about resolving a
 * path THROUGH a link, not about the link itself.
 */
export function canMakeFileLink(): boolean {
  if (fileProbed !== undefined) return fileProbed;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'filelinkcap-'));
  try {
    fs.writeFileSync(path.join(d, 't'), 'x');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
    fileProbed = true;
  } catch {
    fileProbed = false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  return fileProbed;
}

/**
 * The two root spellings a shell reap is registered with, for a clone rooted at `dir`.
 *
 * `dir` is a NATIVE path (whatever `path.join`/`os.tmpdir()` produced); the return values are in
 * the shell's own spelling — MSYS (`/e/…`, or `/tmp/…` under a mount alias) on Windows, and the
 * same absolute path on POSIX. Feed these to `reap_repo_register_roots`, and build markers by
 * joining onto them with `/`, exactly as `launch-editor.sh` does with `"$REPO/engine/…"`.
 *
 * `logical` keeps the link; `physical` is `pwd -P`, which resolves it.
 *
 * ⚠️ **`physical` equals `logical` for a `subst`ed drive** — measured: bash `pwd` and `pwd -P`
 * both return `/w` for `subst W: E:\…`. That is a real gap in `repo-reap.sh`'s Windows coverage
 * and it is documented rather than fixed (`docs/windows.md` § Paths, and #958): deriving a third
 * spelling by a mechanism different from the other two means widening a reap pattern, which is
 * the #69 blast radius, for a configuration nobody here uses. A junction and a directory symlink
 * DO yield two distinct spellings, which is what the reap harness drives.
 */
export function cloneRootSpellings(dir: string): { logical: string; physical: string } {
  // Forward slashes so the path survives as one argv token on either shell; MSYS accepts a
  // drive-letter path in this form and resolves it through its mount table.
  const arg = dir.replace(/\\/g, '/');
  const out = execFileSync(
    'bash',
    ['-c', 'cd "$1" || exit 3; printf "%s\\n%s\\n" "$(pwd)" "$(pwd -P)"', '_', arg],
    { encoding: 'utf8' },
  );
  const [logical, physical] = out.split('\n').map((s) => s.trim());
  if (!logical || !physical) throw new Error(`cloneRootSpellings: bash produced no roots for ${dir} (got ${JSON.stringify(out)})`);
  return { logical, physical };
}
