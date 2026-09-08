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

  it.runIf(onWin)('win32: an 8.3 SHORT path is the same directory — the row only `.native` closes (#893)', (ctx) => {
    // ⚠️ This is the row that would have SHIPPED. #878 was red on the hosted runner and invisible
    // on real Windows hardware, because the runner's `%TEMP%` arrives 8.3-shortened
    // (`C:\Users\RUNNER~1\…`, the account name exceeding 8 characters) while a dev box whose
    // account name fits does not. So this test deliberately takes its input from `os.tmpdir()`
    // rather than constructing one: on the machine where the shape occurs NATURALLY it runs with
    // no setup, and that machine is the one that found #878.
    //
    // It therefore SKIPS on most dev boxes, which is honest rather than convenient — see the
    // premise assertions below, which are what stop a skip from being mistaken for a pass. On the
    // `win` clone it skips for a second, structural reason worth knowing: that clone sits on a Dev
    // Drive (ReFS), where 8.3 creation is disabled outright, so nothing under it or its `%TEMP%`
    // can ever carry a short form (docs/windows.md § Paths).
    const short = os.tmpdir();
    if (!/~\d/.test(short)) {
      // ⚠️ **NON-VACUITY, pinned in the same commit** — docs/windows.md § Paths requires it, and
      // this test is exactly the shape the rule is about: a skip is GREEN, so without this line a
      // test whose only venue is the Windows CI leg could stop running there and say nothing.
      // On CI it MUST have found a short `%TEMP%`; if it did not, the runner image changed and the
      // 8.3 row has silently lost its only behavioural cover — which is how #878 stayed invisible
      // in the first place. Fail loudly there, skip quietly on a dev box.
      expect(process.env.CI, `non-vacuity: on CI this must RUN, but os.tmpdir() (${short}) has no 8.3 component`)
        .toBeFalsy();
      ctx.skip(`no 8.3 component in os.tmpdir() (${short}) — this volume does not generate short names`);
      return;
    }
    const long = fs.realpathSync.native(short);
    // Premises. Without the first two this asserts nothing; without the THIRD it would pass just
    // as happily against the bare JS walk, and the whole point of #881 is that the walk is not
    // enough here.
    expect(long, 'premise: `.native` really expands the short form').not.toBe(short);
    expect(path.resolve(short), 'premise: resolve does NOT expand it').toBe(short);
    expect(fs.realpathSync(short), 'premise: the JS lstat-walk does NOT expand it either').toBe(short);
    expect(samePath(short, long)).toBe(true);
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

  /** (#892) The SYMLINK half of #865's hole — the case-fold above closed only the CASE half.
   *
   *  ⚠️ These are the cases `canonicalPath` cannot answer, and the reason `samePath` compares in
   *  `canonicalWithMissingTail` instead: `.native` throws on a path that does not exist, and the
   *  `path.resolve` fallback follows no links. Every assertion here is on a path that is ABSENT —
   *  an existing one is rescued by `.native` alone and cannot tell the two canonicalisers apart,
   *  which is the same trap docs/windows.md § Paths records for the case-fold. */
  describe('#892 a path that does not exist', () => {
    it('matches its own spelling through a symlinked ancestor', (ctx) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-892-'));
      try {
        const real = path.join(base, 'real');
        fs.mkdirSync(real);
        const link = path.join(base, 'link');
        try {
          fs.symlinkSync(real, link, 'junction'); // 'junction' needs no elevation on win32
        } catch {
          // SKIP, never a silent return: unelevated Windows cannot make a link, and this is the
          // assertion the whole change exists for. A bare return would report a clean green.
          ctx.skip('cannot create a directory symlink here (needs a privilege this machine lacks)');
          return;
        }
        const viaLink = path.join(link, 'gone');
        const viaReal = path.join(real, 'gone');
        expect(fs.existsSync(viaReal), 'premise: really absent').toBe(false);
        expect(path.resolve(viaLink), 'premise: resolve does NOT follow it')
          .not.toBe(path.resolve(viaReal));
        expect(samePath(viaLink, viaReal)).toBe(true);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it("matches across os.tmpdir()'s OWN symlink — the case that is not exotic", (ctx) => {
      // On macOS `os.tmpdir()` is `/var/…`, itself a symlink to `/private/var/…`, so this needs no
      // fixture at all — it is the spelling any code touching a temp path already has.
      //
      // ⚠️ The expected side is seeded with `fs.realpathSync.native` DIRECTLY, never with the
      // subject's own canonicaliser (#878's lesson: seeding a baseline with the thing under test
      // asserts `X === X` and survives every mutation).
      const tmpReal = fs.realpathSync.native(os.tmpdir());
      if (tmpReal === path.resolve(os.tmpdir())) {
        ctx.skip('os.tmpdir() is not itself a symlink on this platform — nothing to discriminate');
        return;
      }
      const viaTmp = path.join(os.tmpdir(), 'modoki-892-never-created', 'x.png');
      const viaReal = path.join(tmpReal, 'modoki-892-never-created', 'x.png');
      expect(fs.existsSync(viaTmp), 'premise: really absent').toBe(false);
      expect(path.resolve(viaTmp), 'premise: resolve leaves the two spellings apart')
        .not.toBe(viaReal);
      expect(samePath(viaTmp, viaReal)).toBe(true);
    });

    it('still says NO to two different missing paths under one real ancestor', () => {
      // The reject side. Proving the predicate now matches more pairs proves nothing on its own —
      // resolving the ancestor and DISCARDING the missing tail would pass every case above and
      // make these two equal, which is the mutation this exists to catch.
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-892-'));
      try {
        expect(samePath(path.join(base, 'gone-a'), path.join(base, 'gone-b'))).toBe(false);
        expect(samePath(path.join(base, 'gone', 'deep'), path.join(base, 'gone'))).toBe(false);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('agrees with the PRE-#892 comparison on these one-side-exists pairs', (ctx) => {
      // Agreement with the pre-#892 body on the pairs listed below — no more than that.
      //
      // ⚠️ **This is NOT a general "one operand exists ⇒ inert" guarantee, and both this test's
      // NAME and this comment claimed it was** (close-out review round 2). That claim reasons
      // about the raw canonicaliser strings and never applies `pathCaseKey`, which `samePath`
      // does — so on a case-SENSITIVE volume `samePath('<vol>/target/ABC', '<vol>/link/abc')` is
      // `true` where the oracle is `false`, with one side existing. This test stays green only
      // because no such pair is in the list. The retraction, and why the residue is accepted, are
      // in `pathIdentity.mjs`'s `samePath` and `CASE_INSENSITIVE` docblocks — read those, not the
      // reassurance a green test name used to offer here.
      //
      // ⚠️ It also named `sameProjectRoot` and `isEditorsOwnTree` as fail-OPEN. They are
      // fail-CLOSED; `pathIdentity.mjs` says so, and a green test outranks a comment for the next
      // reader, which is what made this copy the worst of the four.
      //
      // ⚠️ **Structurally, M2 is the only mutation this can catch**, and that is not an oversight
      // to fix. It asserts two implementations AGREE where they should, so it can only catch a
      // mutation that makes them disagree on one of these exact pairs: M1 (reverting `samePath`
      // to `canonicalPath`) makes them agree by construction, and M3 (dropping the fold) is
      // carried by the `case-folds ONLY where the platform is case-insensitive` test instead.
      //
      // ⚠️ The version before THIS one asserted `samePath(existing, missingSibling)` is `false`
      // and was green under all three mutations — it could not fail at all. Two reshapes; the
      // mutation check is the only thing that revealed either.
      const pre892 = (a: string, b: string) =>
        pathCaseKey(canonicalPath(a)) === pathCaseKey(canonicalPath(b));
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pid-892-'));
      try {
        const real = path.join(base, 'real');
        fs.mkdirSync(real);
        const link = path.join(base, 'link');
        let linked = true;
        try {
          fs.symlinkSync(real, link, 'junction');
        } catch {
          linked = false;
        }
        const pairs: [string, string][] = [
          // ⚠️ The DISCRIMINATING row, and the reason this list is not just plausible-looking
          // pairs (close-out review). Every other one-side-exists row here is green under M2 —
          // `cwmt` dropping the missing tail — because their tails differ anyway. This pair is
          // the one M2 actually changes: `samePath(base, base/gone)` becomes TRUE where the
          // oracle still says false, so the disagreement is caught. Without it the ONLY row that
          // could ever fail was `[link, real]`, a both-exist pair already covered above, and this
          // test would have been the second version in a row that pinned nothing.
          [base, path.join(base, 'gone')],            // parent vs a missing child of it
          [real, path.join(base, 'gone')],            // existing vs missing sibling
          [path.join(base, 'gone'), real],            // …and symmetrically
          [real, real],                               // both exist, identical
          [real, base],                               // both exist, different
          [real, path.join(base, 'gone', 'deeper')],  // existing vs a missing DEEP path
          ...(linked ? [[link, real] as [string, string]] : []),
        ];
        for (const [a, b] of pairs) {
          expect(fs.existsSync(a) || fs.existsSync(b), 'premise: one side exists').toBe(true);
          expect(samePath(a, b), `${a} vs ${b}`).toBe(pre892(a, b));
        }
        if (!linked) {
          ctx.skip('no symlink privilege — the both-exist symlink pair could not be included');
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
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
