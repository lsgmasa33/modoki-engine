/**
 * Tripwire for `helpers/linkFixture.ts` (#949), the same role `repoLayoutGuard.test.ts` plays for
 * `repoLayout.ts`.
 *
 * ⚠️ **The failure this exists to catch was found by a mutation check, not by reasoning.** Break
 * `makeDirLink` and `repoReapSpellings.test.ts` reports *"1 skipped | 9 skipped"* — every case
 * gated on `canMakeDirLink()` quietly stops running, and a suite that never runs looks exactly
 * like a suite that passes. There is no other signal: the skip is the DESIGNED response to a
 * machine that cannot make links, so it cannot also be an error.
 *
 * So the tripwire is here instead, and it is deliberately unconditional: on every platform this
 * repo runs on — POSIX (symlink) and win32 (junction, which needs no privilege) — creating a
 * directory link MUST be possible. If this goes red, the helper is broken or the volume is
 * (FAT, or a sandbox); either way it is a real failure and not a machine's privileges.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeDirLink, canMakeDirLink, cloneRootSpellings, makeFixtureRoot, DIR_LINK_TYPE } from '../helpers/linkFixture';

describe('linkFixture is not silently disabled (#949)', () => {
  it('can make a directory link on THIS machine — the skip that guards every consumer is not permanent', () => {
    expect(
      canMakeDirLink(),
      'canMakeDirLink() is false, so every suite gated on it is now SKIPPING rather than running — '
      + 'which reports as a pass. On win32 this should be impossible: a junction needs no privilege. '
      + 'Suspect the helper, or a volume that cannot hold a reparse point.',
    ).toBe(true);
  });

  it('picks the link type that needs no privilege on win32', () => {
    // ⚠️ The EXPECTED VALUE is a literal on each branch, not the subject's own expression. An
    // earlier version asserted `toBe(process.platform === 'win32' ? 'junction' : 'dir')` — which is
    // `DIR_LINK_TYPE`'s definition character for character, so it agreed by construction on the
    // platform you happened to run — under a comment claiming that tautology had been avoided.
    // Close-out review caught the comment and the code disagreeing.
    if (process.platform === 'win32') expect(DIR_LINK_TYPE).toBe('junction');
    else expect(DIR_LINK_TYPE).toBe('dir');
  });

  it('the link it makes actually RESOLVES to the target — a link nothing follows is not a fixture', () => {
    const base = makeFixtureRoot('linkfix-');
    try {
      const real = path.join(base, 'real');
      const link = path.join(base, 'link');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'probe.txt'), 'x');
      makeDirLink(real, link);

      // The three properties every consumer depends on, and the reason a junction is an
      // acceptable stand-in for a 'dir' symlink in this repo (see the helper's docblock).
      expect(fs.existsSync(path.join(link, 'probe.txt'))).toBe(true);
      expect(fs.realpathSync.native(link)).toBe(fs.realpathSync.native(real));
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  /** The regression this pair exists for, found by close-out review: the fixture's roots come from
   *  bash `pwd -P`, which resolves EVERY symlink in the path — including one in an ancestor the
   *  fixture never created. `os.tmpdir()` has such an ancestor on macOS (`/var` → `/private/var`),
   *  so a fixture rooted there hands a spawned process the unresolved spelling while the reap
   *  computes the resolved one. Green on ubuntu and windows-latest, red on all five Mac clones, and
   *  there was no macOS `check` leg at the time (one was added 2026-09-09).
   *
   *  ⚠️ **This first case is VACUOUS wherever `os.tmpdir()` is already canonical** — which is `win`
   *  and windows-latest. It is kept because it states the invariant plainly; the case below is the
   *  one that can actually fail here. */
  it('makeFixtureRoot is its own realpath', () => {
    const root = makeFixtureRoot('linkfix-canon-');
    try {
      expect(fs.realpathSync.native(root)).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /** ⚠️ **The ancestor alias is MANUFACTURED, and it has to be** — the same reasoning
   *  `repoReapSpellings.test.ts`'s own docblock gives for its symlink. The case above is VACUOUS on
   *  a machine whose `os.tmpdir()` is already canonical (measured: mutating `makeFixtureRoot` back
   *  to the raw `os.tmpdir()` left all five cases green on `win`, where `TEMP=E:\dev-temp` has no
   *  aliased ancestor). macOS is the platform where it is not vacuous, and at the time no CI leg
   *  ran macOS `check` (`macos-14` was added 2026-09-09). So the condition is built here rather
   *  than waited for — which is still the better design now that the leg exists, because it makes
   *  the mechanism falsifiable on EVERY platform rather than only the one that exhibits it. */
  it('a root under an ALIASED ancestor disagrees with its shell spelling — and canonicalising fixes it', () => {
    const realTmp = makeFixtureRoot('linkfix-anc-');
    const aliasTmp = `${realTmp}-alias`;
    try {
      makeDirLink(realTmp, aliasTmp);

      // (a) the DEFECT: a root taken under the alias, uncanonicalised. `pwd -P` resolves the
      //     ancestor we never created, so the shell's spelling names `realTmp` while anything
      //     built from the native path names `aliasTmp`. This is macOS's /var → /private/var.
      const viaAlias = fs.mkdtempSync(path.join(aliasTmp, 'r-'));
      expect(viaAlias).toContain(path.basename(aliasTmp));
      expect(cloneRootSpellings(viaAlias).physical).not.toContain(path.basename(aliasTmp));

      // (b) the FIX, driven through `makeFixtureRoot` ITSELF rather than reimplemented — this is
      //     what makes breaking that function go red on THIS machine instead of only on macOS.
      //     Handed the aliased base, it must hand back a path under the REAL one.
      const viaHelper = makeFixtureRoot('r-', aliasTmp);
      expect(viaHelper).not.toContain(path.basename(aliasTmp));
      // ⚠️ Anchored with the separator, not a bare `startsWith(realTmp)` — and this is LOAD-BEARING
      // here, not hygiene. An earlier comment claimed "mkdtemp's random suffix means it could not
      // bite"; that was false and backwards. `aliasTmp` is `${realTmp}-alias`, constructed two
      // lines above as a deliberate literal prefix sibling of `realTmp` — so under the very
      // mutation this case exists to catch (makeFixtureRoot reverted to a raw `os.tmpdir()`),
      // `viaHelper` becomes `<realTmp>-alias/r-XXXX`, and the UNANCHORED compare PASSED. The suite
      // stayed falsifiable only through the `not.toContain` line above. Same #69 shape as clone
      // names being prefixes of each other, reached by a fixture we build ourselves.
      expect(viaHelper.startsWith(realTmp + path.sep)).toBe(true);
      expect(cloneRootSpellings(viaHelper).physical).toContain(path.basename(viaHelper));
    } finally {
      fs.rmSync(aliasTmp, { recursive: true, force: true });
      fs.rmSync(realTmp, { recursive: true, force: true });
    }
  });

  it('cloneRootSpellings returns TWO different spellings through a link, in the shell own space', () => {
    const base = makeFixtureRoot('linkfix-roots-');
    try {
      const real = path.join(base, 'modoki-qa');
      const link = path.join(base, 'clone-link');
      fs.mkdirSync(real, { recursive: true });
      makeDirLink(real, link);

      const { logical, physical } = cloneRootSpellings(link);

      // ⚠️ The load-bearing assertion. If these were equal, `reap_alt_pattern` would return
      // nothing (its "identical spellings" precondition) and every positive case in
      // repoReapSpellings.test.ts would be testing the un-aliased path while passing.
      expect(logical).not.toBe(physical);

      // Shell space, not native: a `\` here is what silently broke the reap harness on Windows,
      // because `reap_alt_pattern`'s absolute-root test is `case "$PHYS" in /*)`.
      //
      // ⚠️ **Both assertions in this loop are VACUOUS on POSIX** — there, `cloneRootSpellings`
      // hands back the native path unchanged, so `/`-rooted and backslash-free hold by
      // construction and cannot fail however the helper breaks. They encode the MSYS insight and
      // only `win`/windows-latest can falsify them (measured on macOS: 6 green with the mutation
      // in place). A macOS green is NOT cover for this pair — do not read one as such.
      for (const p of [logical, physical]) {
        expect(p.startsWith('/'), `${p} is not in the shell's absolute-path space`).toBe(true);
        expect(p).not.toMatch(/\\/);
      }

      // `physical` resolves the link; `logical` keeps it. Compare on the basename rather than the
      // whole path — under an MSYS mount alias neither equals the native spelling.
      expect(logical.endsWith('/clone-link')).toBe(true);
      expect(physical.endsWith('/modoki-qa')).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
