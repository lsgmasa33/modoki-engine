/** Unit: `engine/scripts/pathIdentity.mjs` — the shared `canonicalPath`/`samePath` (#869).
 *
 *  This helper exists to end the class where "is this the same directory?" is answered with
 *  `===` on two absolute paths. `path.resolve` normalises separators, `.`/`..` and a trailing
 *  slash; it does NOT normalise drive-letter case, `subst` mappings, or symlinks. A guard built
 *  that way FAILS OPEN — the comparison misses, the early return does not happen, and the thing
 *  the guard existed to prevent proceeds. Two `engine/electron/main.ts` guards were exactly that,
 *  and the editor ran `npm install` into its own checkout.
 *
 *  ⚠️ Most of the interesting cases are win32-only and are gated as such. Do not "simplify" the
 *  gate away by asserting the win32 behaviour everywhere — POSIX is genuinely case-SENSITIVE and
 *  `/a/B` really is a different directory from `/a/b` there. The last block pins that difference
 *  in both directions, because a fold applied on POSIX would make two distinct directories
 *  compare equal, which is the opposite failure and a worse one.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath, samePath, pathCaseKey, isUnderOrSame } from '../../scripts/pathIdentity.mjs';

const onWin = process.platform === 'win32';
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

describe('samePath', () => {
  it('a path equals itself, however it is spelled', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      expect(samePath(d, d)).toBe(true);
      expect(samePath(d, d + path.sep)).toBe(true);          // trailing separator
      expect(samePath(d, path.join(d, 'x', '..'))).toBe(true); // .. round trip
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('distinguishes a CHILD from its parent, and a name-PREFIX sibling', () => {
    // The prefix case is this repo's own hazard: the clones are `modoki`, `modoki-ai`,
    // `modoki-ai2`… so a comparison that reduced to `startsWith` would call them the same.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      const child = path.join(parent, 'games');
      fs.mkdirSync(child);
      expect(samePath(parent, child)).toBe(false);
      expect(samePath(parent, parent + '-ai')).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it.runIf(onWin)('win32: a lower-cased DRIVE LETTER is the same directory — #869 itself', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      const flipped = d[0].toLowerCase() === d[0] ? d[0].toUpperCase() + d.slice(1) : d[0].toLowerCase() + d.slice(1);
      // Premises — if either of these stops holding, this test is no longer about the defect.
      expect(flipped, 'premise: a genuinely different spelling').not.toBe(d);
      expect(path.resolve(flipped), 'premise: resolve does NOT close it').not.toBe(path.resolve(d));
      expect(samePath(flipped, d)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it.runIf(onWin)('win32: …and STILL matches when the directory does not exist', () => {
    // The half #865's fix left open, and the reason the case-fold is not redundant with the
    // realpath: `fs.realpathSync.native` throws for a missing path, so canonicalPath falls back
    // to bare `path.resolve`, which does no folding at all. A stale recents entry or a stale
    // device claim IS a missing path — the case this predicate is most often asked about.
    const gone = path.join(os.tmpdir(), 'modoki-pid-does-not-exist-869', 'nested');
    const flipped = gone[0].toLowerCase() === gone[0] ? gone[0].toUpperCase() + gone.slice(1) : gone[0].toLowerCase() + gone.slice(1);
    expect(fs.existsSync(gone), 'premise: really absent').toBe(false);
    expect(path.resolve(flipped), 'premise: resolve does NOT close it').not.toBe(path.resolve(gone));
    expect(samePath(flipped, gone)).toBe(true);
  });

  it('follows a SYMLINK to its target — the spelling `path.resolve` cannot reach', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      const real = path.join(root, 'real');
      const link = path.join(root, 'link');
      fs.mkdirSync(real);
      try {
        fs.symlinkSync(real, link, 'junction'); // 'junction' needs no elevation on win32
      } catch {
        return; // no symlink privilege (a locked-down CI box) — the other cases still cover us
      }
      expect(path.resolve(link), 'premise: resolve does NOT follow it').not.toBe(path.resolve(real));
      expect(samePath(link, real)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('case-folds ONLY where the platform is case-insensitive', () => {
    // Both directions matter. On POSIX `/a/B` and `/a/b` are genuinely different directories, so
    // a fold there would make two distinct paths compare EQUAL — the opposite defect, and worse
    // than the one #869 fixed, because it makes a guard swallow something it should act on.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      const lower = path.join(root, 'assets');
      const upper = path.join(root, 'ASSETS');
      fs.mkdirSync(lower);
      expect(samePath(lower, upper)).toBe(CASE_INSENSITIVE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('canonicalPath', () => {
  it('returns a USABLE path, not a lowercased comparison key', () => {
    // Deliberate, and pinned because an earlier draft got it wrong: callers keep this value —
    // `deviceClaimsStore.canonicalClonePath` hands it to a refusal message naming the clone
    // that holds a device, which a human reads. The case-fold belongs to `samePath`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-PID-Mixed-'));
    try {
      const out = canonicalPath(root);
      expect(fs.existsSync(out), 'the result still names a real directory').toBe(true);
      // A lowercasing implementation would flatten the mixed-case tail of the mkdtemp name.
      expect(path.basename(out)).toBe(path.basename(fs.realpathSync.native(root)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to resolve for a path that does not exist, rather than throwing', () => {
    // A comparison must never depend on a stat succeeding: "the directory is gone" is an
    // ordinary state for a persisted path, and a throw here would take out every caller's guard.
    const gone = path.join(os.tmpdir(), 'modoki-pid-absent-869', 'deeper');
    expect(fs.existsSync(gone)).toBe(false);
    expect(() => canonicalPath(gone)).not.toThrow();
    expect(canonicalPath(gone)).toBe(path.resolve(gone));
  });

  it('is idempotent', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-'));
    try {
      expect(canonicalPath(canonicalPath(d))).toBe(canonicalPath(d));
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('pathCaseKey (#881)', () => {
  it('folds exactly where the platform does, and nowhere else', () => {
    expect(pathCaseKey('Modoki-AI3')).toBe(CASE_INSENSITIVE ? 'modoki-ai3' : 'Modoki-AI3');
    expect(pathCaseKey('modoki-ai3')).toBe('modoki-ai3');
  });

  it('is the rule samePath applies, on a path no realpath can rescue', () => {
    // ⚠️ An earlier version of this asserted
    //     samePath(d, flipped) === (pathCaseKey(canonicalPath(d)) === pathCaseKey(canonicalPath(flipped)))
    // which is `samePath`'s own definition — X === X, green under every mutation including
    // replacing pathCaseKey with the identity function. Review caught it. It also used EXISTING
    // directories, where `.native` folds the case by itself and the comparison is between two
    // identical strings whatever the fold does.
    //
    // Both operands must therefore NOT EXIST, and the assertion must be against the platform
    // rule rather than against a re-spelling of the subject.
    const a = path.join(os.tmpdir(), 'modoki-pck-nonexistent', 'Clone');
    const b = path.join(os.tmpdir(), 'modoki-pck-nonexistent', 'CLONE');
    expect(fs.existsSync(a)).toBe(false);
    expect(samePath(a, b)).toBe(CASE_INSENSITIVE);
    expect(samePath(a, a)).toBe(true); // control: identical spellings hold on every platform
  });

  it('folds case and NOTHING else — it is not a canonicaliser', () => {
    // Pinned because the name invites misuse: it must not resolve, and must not touch separators.
    expect(pathCaseKey('../x/./y')).toBe(CASE_INSENSITIVE ? '../x/./y' : '../x/./y');
    expect(pathCaseKey('A/../B')).toBe(CASE_INSENSITIVE ? 'a/../b' : 'A/../B');
  });
});

describe('isUnderOrSame (#881)', () => {
  it('a root is under ITSELF — the half `isUnderRepo` deliberately answers false', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      expect(isUnderOrSame(d, d)).toBe(true);
      expect(isUnderOrSame(d, d + path.sep)).toBe(true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('accepts a real descendant and refuses a real ancestor', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      const child = path.join(parent, 'assets', 'deep');
      fs.mkdirSync(child, { recursive: true });
      expect(isUnderOrSame(parent, child)).toBe(true);
      expect(isUnderOrSame(child, parent)).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a name-PREFIX sibling — the defect the `startsWith` form had', () => {
    // `…/modoki-ai3-old`.startsWith(`…/modoki-ai3`) is TRUE, which is how the /api/unused-assets
    // filter could offer a neighbouring project's assets for deletion. This is the assertion that
    // fails if anyone reduces this back to a prefix test.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      const root = path.join(base, 'modoki-ai3');
      const sibling = path.join(base, 'modoki-ai3-old');
      fs.mkdirSync(root);
      fs.mkdirSync(sibling);
      expect(isUnderOrSame(root, sibling)).toBe(false);
      expect(isUnderOrSame(root, path.join(sibling, 'assets', 'x.png'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('folds case where the platform does — the darwin half `path.relative` does NOT do', () => {
    // ⚠️ The reason both sides are folded BEFORE path.relative. On win32 relative() folds by
    // itself; on darwin it is node:path's POSIX implementation and folds nothing, so a raw
    // containment check reports a path as outside a root it is plainly inside.
    //
    // ⚠️⚠️ The paths must NOT EXIST, and that is the whole point of this case. An earlier version
    // of this test made the directories first and **stayed green when the fold was deleted**:
    // `.native` resolves a flipped spelling of an EXISTING directory back to its on-disk name, so
    // it silently supplies what the fold was there to supply. The fold's only load-bearing job is
    // the path that is gone or not yet created — where `.native` throws and the fallback is bare
    // `path.resolve`, which folds nothing. Caught by mutation-checking, not by review.
    const root = path.join(os.tmpdir(), 'modoki-uos-nonexistent', 'Project');
    const child = path.join(os.tmpdir(), 'modoki-uos-nonexistent', 'PROJECT', 'assets');
    expect(fs.existsSync(root)).toBe(false);
    expect(isUnderOrSame(root, child)).toBe(CASE_INSENSITIVE);
    // The same pair spelled identically must hold on EVERY platform, or the assertion above is
    // measuring the platform gate rather than the fold.
    expect(isUnderOrSame(root, path.join(os.tmpdir(), 'modoki-uos-nonexistent', 'Project', 'assets'))).toBe(true);
  });

  it('accepts a flipped spelling of an EXISTING directory (does NOT isolate .native — see below)', () => {
    // ⚠️ **This case cannot fail, and its old title claimed it pinned `.native`.** On a
    // case-insensitive volume the FOLD alone carries it; on a case-sensitive one both arms are
    // false. Review measured it green under `canonicalPath → path.resolve`. It is kept as an
    // end-to-end acceptance case, not as cover for the realpath — that is the symlink test below,
    // which is the only one on this platform that discriminates the two.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      fs.mkdirSync(path.join(base, 'Project', 'assets'), { recursive: true });
      expect(isUnderOrSame(path.join(base, 'PROJECT'), path.join(base, 'Project', 'assets')))
        .toBe(CASE_INSENSITIVE);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts a child whose NAME begins with two dots', () => {
    // ⚠️ Regression: this function shipped `rel.startsWith('..')`, which reads `..bak` — a
    // perfectly ordinary directory INSIDE the root — as an escape. `projectPaths.ts:47` already
    // carried the correct spelling with this same comment and its suite has a case named for it;
    // the SSOT was written with the version that test exists to forbid. Only the `..` SEGMENT
    // means escaped.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      fs.mkdirSync(path.join(base, '..bak'), { recursive: true });
      expect(isUnderOrSame(base, path.join(base, '..bak'))).toBe(true);
      // ⚠️ `old.png` does NOT exist, deliberately. This assertion failed when first written, for
      // a reason entirely separate from the `..` fix: `canonicalPath` falls back to bare
      // `path.resolve` for a missing path, resolving no symlinks — and `os.tmpdir()` on macOS is
      // `/var` → `/private/var`. So the existing parent canonicalised one way and the missing
      // child the other, and containment reported OUTSIDE. `isUnderOrSame` now resolves the
      // longest existing ANCESTOR and re-appends the missing tail.
      expect(fs.existsSync(path.join(base, '..bak', 'old.png'))).toBe(false);
      expect(isUnderOrSame(base, path.join(base, '..bak', 'old.png'))).toBe(true);
      // …and the real escape is still an escape, or the fix has gone too far the other way.
      expect(isUnderOrSame(path.join(base, 'sub'), base)).toBe(false);
      expect(isUnderOrSame(base, path.join(path.dirname(base), 'elsewhere'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a MISSING child under a symlinked ancestor is still inside', (ctx) => {
    // The general form of the trap above, isolated. Both operands must be expressed in the same
    // space or containment is meaningless; a missing child must not fall back to an unresolved
    // spelling while its existing parent gets resolved.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      const real = path.join(base, 'real');
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(base, 'link');
      try {
        fs.symlinkSync(real, link, 'dir');
      } catch {
        ctx.skip('cannot create a directory symlink here (needs a privilege this machine lacks)');
        return;
      }
      const missing = path.join(link, 'not-created-yet', 'x.png');
      expect(fs.existsSync(missing)).toBe(false);
      expect(isUnderOrSame(real, missing)).toBe(true);
      expect(isUnderOrSame(link, missing)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('follows a symlink, so one directory reached two ways is still inside', (ctx) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-uos-'));
    try {
      const real = path.join(base, 'real');
      fs.mkdirSync(path.join(real, 'assets'), { recursive: true });
      const link = path.join(base, 'link');
      try {
        fs.symlinkSync(real, link, 'dir');
      } catch {
        // ⚠️ SKIP, never a silent `return`. This is the ONLY case here that discriminates
        // `.native` from `path.resolve`, and unelevated Windows cannot create a link — so a bare
        // `return` would report a clean green run over the one assertion that matters, on the
        // very platform this whole change exists for. Per CLAUDE.md: a leg this machine cannot
        // run reports SKIP, not a pass.
        ctx.skip('cannot create a directory symlink here (needs a privilege this machine lacks)');
        return;
      }
      expect(isUnderOrSame(real, path.join(link, 'assets'))).toBe(true);
      expect(isUnderOrSame(link, path.join(real, 'assets'))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
