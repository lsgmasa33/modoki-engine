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
import { canonicalPath, samePath } from '../../scripts/pathIdentity.mjs';

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
