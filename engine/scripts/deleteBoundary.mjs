/**
 * "Is this subtree self-contained enough to `rmSync` it?" — the ONE implementation (#990/#989/#1004).
 *
 * Sibling of `pathIdentity.mjs`, and deliberately NOT part of it: that one owns *root derivation +
 * case* for comparing two paths, this one owns *subtree containment before a destructive recurse*.
 * It COMPOSES `isUnderOrSame` rather than re-deriving containment — see `findDeleteBoundaries`.
 *
 * ## The mechanism this exists for
 *
 * `fs.rmSync(p, {recursive: true, force: true})` acts on NAMES, not data, and its report is wrong
 * in two opposite directions when the subtree is not self-contained:
 *
 *   - **A link OUT of the subtree is severed.** `rmSync` unlinks it, the payload it pointed at is
 *     orphaned, and the caller prints success. Multi-GB survive a "wipe". (#883, #990, #1004)
 *   - **A mount point is recursed INTO.** `rmSync` deletes the contents of a volume the caller
 *     never named, then throws part-way on the mount itself. (#989)
 *
 * #883 shipped the first point of this as a local check in `clean-packaged-cache.mjs`: *is the
 * FINAL COMPONENT of a candidate a symlink?* That is one point in a three-axis space, and the three
 * open issues are the three axes it misses — **depth** (a link nested below the final component,
 * #990), **kind** (a mount point, which `lstat` cannot see as a link, #989), and **site** (a second
 * module deleting the same directories with no pre-flight at all, #1004).
 *
 * ## What this module is NOT
 *
 * ⚠️ **Not "refuse on any nested link".** That rule is not viable and it took both platforms to
 * establish (#990): npm's `node_modules/.bin` shims ARE symlinks on POSIX (60 of 60 entries in one
 * `.bin`), and this repo's toolchain installs npm tools into `MODOKI_TOOLCHAIN_DIR` — so the blunt
 * rule refuses on every POSIX run. ⚠️ **The Windows zero does not transfer**: a provision there
 * measured 0 symlinks across 23,303 entries only because npm uses `.cmd` shims, not because
 * provisions are symlink-free.
 *
 * The property that separates an npm shim from #883's shape is whether the link's target **escapes
 * the subtree**: a `.bin` shim points inside (`../is-docker/cli.js`), the failure mode points
 * outside to another drive. That is the predicate here, and the ACCEPT side of it is the load-
 * bearing half — a guard that refuses everything is not this guard.
 *
 * ⚠️ **Not a policy.** This reports; it never deletes, never follows, never repairs. The refusal
 * text, the exemptions a particular caller allows, and whether a finding blocks or merely warns are
 * the CALLER's (`clean-packaged-cache.mjs` has an exemption that this module must not know about —
 * see its `linkedTargets`).
 */

import fs from 'node:fs';
import path from 'node:path';
// The ONE containment comparison (#869/#881) — see engine/scripts/pathIdentity.mjs.
import { isUnderOrSame, pathCaseKey } from './pathIdentity.mjs';

/** A boundary that makes a recursive delete of the root misreport. `kind`:
 *
 *  - `'link'`     — a symlink/junction resolving OUTSIDE the root. `rmSync` severs it and orphans
 *                   `target`. At depth 0 this is #883's original case.
 *  - `'mount'`    — a directory on a different device from the root. `rmSync` recurses INTO it.
 *  - `'unreadable'` — we could not tell. Reported, never skipped: something we cannot read must
 *                   never authorise deleting something else.
 *
 *  @typedef {{ path: string, kind: 'link'|'mount'|'unreadable', target: string|null, code: string|null }} Boundary
 */

/** The `fs` surface this walk needs, injectable so the decision is testable on a host that cannot
 *  create the fixture.
 *
 *  ⚠️ **This exists for ONE case and it is not laziness: a real mount point cannot be created on
 *  POSIX CI without privileges.** On Windows it can, non-elevated — `mklink /J <link>
 *  \\?\Volume{GUID}\` writes the same `IO_REPARSE_TAG_MOUNT_POINT` reparse point `mountvol` does
 *  (verified with `fsutil reparsepoint query`). So the contract is: the injected fake covers the
 *  DECISION on every host, and a `skipIf(!win32)` test drives the REAL thing to prove the fake
 *  models something that exists. A fake alone would be the shape `docs/falsifiable-tests.md` names
 *  — a guard defending behaviour nothing has. Do not delete the win32 test as redundant.
 *
 *  Precedent for the injection itself: `shouldSweepProcesses(dir, platform)` in
 *  `engine/toolchain/index.ts`, which takes an injected platform for exactly this reason.
 *
 *  @typedef {{
 *    lstatSync: (p: string, o: { throwIfNoEntry: false }) => { isSymbolicLink(): boolean, isDirectory(): boolean, dev: number } | undefined,
 *    readdirSync: (p: string, o: { withFileTypes: true }) => Array<{ name: string, isSymbolicLink(): boolean, isDirectory(): boolean }>,
 *    realpathNative: (p: string) => string,
 *  }} FsSurface
 */

/** @type {FsSurface} */
const NODE_FS = {
  lstatSync: (p, o) => fs.lstatSync(p, o),
  readdirSync: (p, o) => fs.readdirSync(p, o),
  // `.native`, never the JS `realpathSync` walk: the JS implementation does not fold a case-flipped
  // path component and has already dropped a clone's pinned port that way (#881).
  realpathNative: (p) => fs.realpathSync.native(p),
};

/** Resolve a link's target, distinguishing DANGLING from unreadable.
 *  @returns {{ target: string|null, code: string|null }} */
function resolveLink(p, fsi) {
  try {
    return { target: fsi.realpathNative(p), code: null };
  } catch (e) {
    const code = e?.code ?? String(e);
    // ⚠️ Only ENOENT means DANGLING, and a DANGLING link is SAFE here — it points at nothing, so
    // `rmSync` unlinking it orphans nothing. Reporting it as unreadable would refuse on every
    // stale npm `.bin` shim, which is the blunt rule this module exists to avoid. Reporting it as
    // an escaping link would be a false statement about a target that does not exist.
    // (Depth 0 is different and the CALLER handles it: `clean-packaged-cache.mjs` reports a
    // dangling CANDIDATE because `existsSync` follows links and would otherwise skip it in
    // silence — see its delete loop. That is a report, not a refusal-worthy escape.)
    return { target: null, code: code === 'ENOENT' ? null : code };
  }
}

/** Every boundary at or inside `root` that would make `rmSync(root, {recursive:true})` misreport.
 *  An empty array means the subtree is self-contained and the delete says what it does.
 *
 *  Walks with `lstat` and **never follows a link** — following one would walk a foreign tree and
 *  can loop. A link is resolved only to ask where it points.
 *
 *  ⚠️ **The containment comparison resolves BOTH sides, and that is correct HERE for the exact
 *  reason it was wrong in #883.** `isUnderOrSame` canonicalises through links; using `samePath`
 *  that way re-opened #883, because two candidates each linking to one target then exempted each
 *  other — the resolution destroyed the very fact being tested. Here link-ness is already
 *  established by `lstat` before we ask anything, and the remaining question is purely "do these
 *  two REAL paths contain one another", which is what `isUnderOrSame` is for. Both operands are
 *  `.native`-resolved before the call, so its own canonicalisation is idempotent — what it adds is
 *  the case fold, which win32 and darwin both need.
 *
 *  ⚠️ **`lstat` is the AUTHORITY for link-ness, never the `Dirent` — they disagree, and trusting
 *  the Dirent misclassified a nested mount as a link (found by driving the real fixture, not by
 *  review).** Measured on Windows against a volume mounted at a directory: `Dirent.isSymbolicLink()`
 *  is **true** while `lstatSync().isSymbolicLink()` is **false**, because the directory enumeration
 *  only sees `FILE_ATTRIBUTE_REPARSE_POINT` while `lstat` reads the substitute name and finds a
 *  volume rather than a path. Both refuse either way — but the two kinds carry different remedies
 *  (#989), so a misclassification hands the reader an instruction that does not work.
 *
 *  That disagreement is then USED, not merely avoided: a Dirent that says link where `lstat` says
 *  otherwise IS a mount, exactly and for free, with no `dev` comparison. On POSIX the two agree and
 *  the `dev` comparison is what fires instead; both paths are covered by tests.
 *
 *  ⚠️ **Only entries the Dirent flags as a directory OR a link are stat'd — complete, not a
 *  shortcut.** A mount point is always one of those, so a per-file stat would find nothing this
 *  misses, and it keeps a plain file to zero syscalls beyond the `readdir` that already listed it.
 *
 *  ⚠️ **Remaining blind spot, stated because the guard's text must not over-claim: a POSIX
 *  same-device bind mount NESTED inside the tree.** It produces no Dirent disagreement and an
 *  identical `dev`, so nothing here sees it. The depth-0 check below does not share this gap — it
 *  is exact — and no caller has such a mount; it is recorded rather than defended against.
 *  ⚠️ And the consequence is worse than "missed" for one shape of it: a bind mount of an ANCESTOR
 *  into its own subtree is a cycle, and this walk keeps no visited set, so it would not terminate
 *  rather than merely returning `[]`. The Windows equivalents cannot reach that — a junction is a
 *  link and is never followed, and a mount is detected and never entered — which is why no visited
 *  set is carried; a `realpath` per directory would cost more than the case is worth. If a caller
 *  ever points this at a tree that can contain a POSIX bind mount, that trade has to be re-made.
 *
 *  @param {string} root
 *  @param {FsSurface} [fsi]
 *  @returns {Boundary[]} */
export function findDeleteBoundaries(root, fsi = NODE_FS) {
  /** @type {Boundary[]} */
  const out = [];
  const add = (p, kind, target = null, code = null) => out.push({ path: p, kind, target, code });

  let rootStat;
  try {
    rootStat = fsi.lstatSync(root, { throwIfNoEntry: false });
  } catch (e) {
    // `throwIfNoEntry:false` suppresses ENOENT only (libuv folds Windows ENOTDIR in there too).
    // EACCES/EPERM/ELOOP still throw, and an unguarded throw here would abort the caller with a
    // raw stack where `existsSync` used to return false and skip. Fail closed, but say which.
    add(root, 'unreadable', null, e?.code ?? String(e));
    return out;
  }
  // Absent is SAFE, not unreadable: there is nothing for `rmSync` to get wrong. (A dangling link is
  // NOT absent — `lstat` sees it and it is handled as a link below.)
  if (!rootStat) return out;

  if (rootStat.isSymbolicLink()) {
    // #883's original case, preserved verbatim: the candidate ITSELF is a link, so `rmSync` removes
    // the link and leaves the payload. Do not walk into it — that would be following it.
    const { target, code } = resolveLink(root, fsi);
    add(root, 'link', target, code);
    return out;
  }

  let realRoot;
  try {
    realRoot = fsi.realpathNative(root);
  } catch (e) {
    add(root, 'unreadable', null, e?.code ?? String(e));
    return out;
  }

  // Is the root ITSELF a mount root? Resolve the PARENT and re-append this component: anything but
  // an exact match means the final component redirected somewhere, and `lstat` has already said it
  // is not a symlink — so it is a mount. Measured to catch both a cross-volume and a same-volume
  // mount, which a `dev` comparison against the parent cannot (the same-volume one has an identical
  // `dev`).
  //
  // ⚠️ **This is NOT the `realpathSync(p) !== p` predicate #883 rejected, and the difference is the
  // whole point.** That one is true whenever ANY ancestor is aliased — on macOS `os.tmpdir()` is
  // `/var/…` → `/private/var/…`, so it refuses on a clean machine for a reason that has nothing to
  // do with this defect. Resolving the parent FIRST puts both sides in the same space, so an
  // aliased ancestor cancels out and only the final component's own redirection survives.
  //
  // ⚠️ **`pathCaseKey`, deliberately NOT `samePath`.** `samePath` canonicalises both sides through
  // links, and `expected`'s tail is joined on unresolved — so it would resolve the very redirection
  // being tested and always compare equal. That is #883's re-opening mistake exactly (two links to
  // one target exempting each other); this comparison must stay a raw case-folded string equality
  // between two paths that were resolved by us, on purpose, at the point we chose.
  const parent = path.dirname(root);
  if (parent === root) {
    // ⚠️ **A filesystem ROOT — `E:\`, `\\server\share`, `/`. There is no parent to compare against,
    // so the mount check below cannot run at all, and an earlier version simply skipped it and
    // walked in.** That is the one path this guard most obviously should not be silent about: a
    // root IS a volume, so `MODOKI_TOOLCHAIN_DIR=D:\` reaching `clean-packaged-cache.mjs` as a
    // candidate would have been reported clean and then recursively deleted. Report it as a mount
    // and stop.
    //
    // ⚠️ **Both delete sites now ALSO have their own "is this ours?" check, and this parenthetical
    // used to name one that no longer exists** (#1005 close-out). It read: "`uninstallAll`'s
    // `basename !== 'toolchain'` guard happens to cover the toolchain site; nothing covered the
    // cache-cleaner one." That guard is gone — it asked about the NAME, which rejected every
    // renamed `MODOKI_TOOLCHAIN_DIR` — and the cache cleaner is no longer uncovered either. Both
    // now call `toolchainRoot.mjs`'s `toolchainRootRefusal`, which asks about CONTENTS.
    // That check and this one are independent and BOTH run, answering different questions: this
    // walk asks "would a recursive delete MISREPORT this subtree?", the other asks "is this a
    // toolchain at all?".
    //
    // ⚠️ **Neither can be dropped on the grounds that the other exists, and a drive root is the
    // case that shows it.** Measured on this clone: the contents check DOES catch a populated root
    // (`E:\` -> 5 foreign entries, `C:\` -> 26), so for the ordinary case the two overlap. But it
    // catches it for a reason that is incidental — the root happens to have children we do not own
    // — and an EMPTY volume handed in as `MODOKI_TOOLCHAIN_DIR` yields no foreign entries at all
    // and sails straight through it. This mount check is the only thing that stops that one.
    add(root, 'mount', realRoot, null);
    return out;
  }
  {
    let expected;
    try {
      expected = path.join(fsi.realpathNative(parent), path.basename(root));
    } catch (e) {
      add(root, 'unreadable', null, e?.code ?? String(e));
      return out;
    }
    // ⚠️ **No `path.resolve` here, and its absence is deliberate — an earlier draft had one on both
    // sides.** Both operands are already native-spelled: `realRoot` came from
    // `realpathSync.native`, and `expected` is `path.join` over another `.native` result, so on
    // win32 both are backslashed and on POSIX both are not. The `resolve` was defending against a
    // separator mismatch that only a TEST FAKE using POSIX literals could produce — a defensive line
    // inventing its own justification, and the fake was the thing that needed fixing (it builds its
    // paths with `path.join` now). It also tripped `pathIdentityIsShared.test.ts`, whose whole
    // subject is `resolve(...) !== resolve(...)`.
    //
    // ⚠️ And the fix that guard SUGGESTS — `samePath` — would be wrong here: it canonicalises
    // through links, so it would resolve the very redirection under test and always compare equal.
    // That is #883's re-opening mistake. `pathCaseKey` on two already-resolved paths is the
    // comparison this needs.
    if (pathCaseKey(expected) !== pathCaseKey(realRoot)) {
      add(root, 'mount', realRoot, null);
      return out; // walking INTO it is walking the other volume
    }
  }

  if (!rootStat.isDirectory()) return out; // a plain file candidate has no subtree
  const rootDev = rootStat.dev;

  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fsi.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      add(dir, 'unreadable', null, e?.code ?? String(e));
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const direntSaysLink = ent.isSymbolicLink();
      // A plain file is neither a mount nor a link — the `readdir` already told us, so it costs
      // nothing further.
      if (!direntSaysLink && !ent.isDirectory()) continue;

      let st;
      try {
        st = fsi.lstatSync(full, { throwIfNoEntry: false });
      } catch (e) {
        add(full, 'unreadable', null, e?.code ?? String(e));
        continue;
      }
      if (!st) continue;                            // vanished between readdir and lstat

      if (st.isSymbolicLink()) {
        const { target, code } = resolveLink(full, fsi);
        if (code !== null) { add(full, 'unreadable', null, code); continue; }
        if (target === null) continue;              // dangling — orphans nothing, see resolveLink
        if (isUnderOrSame(realRoot, target)) continue; // points INSIDE: the npm `.bin` shim case
        add(full, 'link', target, null);
        continue;
      }

      // `lstat` says NOT a link. If the Dirent said otherwise, this is a reparse point whose
      // substitute name is a VOLUME — a mount. See the docblock: measured on Windows, and it is
      // why classification never trusts the Dirent. Never recurse into it, whatever `dev` says:
      // a same-volume mount would otherwise be walked, and that can loop.
      if (direntSaysLink) {
        const { target } = resolveLink(full, fsi);
        add(full, 'mount', target, null);
        continue;
      }
      if (st.dev !== rootDev) {                     // the POSIX half: a mount with no disagreement
        const { target } = resolveLink(full, fsi);
        add(full, 'mount', target, null);
        continue;
      }
      if (st.isDirectory()) stack.push(full);
    }
  }
  return out;
}

/** One line describing a boundary, for a refusal a human has to act on.
 *
 *  ⚠️ **The three kinds need three different remedies and must not share one sentence** (#989 is
 *  explicit about this). Removing a link clears a `link`; it does nothing for a `mount`, where the
 *  answer is to unmount or point the setting elsewhere. A refusal that names the wrong remedy sends
 *  the reader to hand-delete something, which is how #883's own remedy text lost a user their
 *  provision AND left them still blocked. */
export function describeBoundary(b) {
  if (b.kind === 'mount') {
    return `${b.path}\n    -> a MOUNTED VOLUME${b.target ? ` (${b.target})` : ''}`
      + '\n    a recursive delete would remove the contents of that volume, then fail part-way';
  }
  if (b.kind === 'unreadable') {
    return `${b.path}\n    -> CANNOT BE READ (${b.code}); whatever it points at may well exist`;
  }
  return `${b.path}\n    -> ${b.target ?? '(DANGLING — resolves to nothing)'}`
    + '\n    a recursive delete would remove the link and leave that behind';
}
