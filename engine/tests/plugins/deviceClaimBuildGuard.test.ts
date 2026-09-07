/**
 * `foreignClaimFor` (#285 sibling) — the one check the BUILD path (`vite-asset-scanner.ts`) uses to
 * refuse installing over a sibling clone's claimed phone. See `deviceClaimsStore.mjs` for the
 * rationale; this file exercises the helper directly, the same way `deviceClaims.test.ts` exercises
 * its neighbours.
 *
 * MODOKI_HOME is pointed at a per-test temp dir for every test: a bug here writing to the real
 * `~/.modoki/device-claims.json` could block the developer's own phone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimsDir, listClaims, claimDevice, foreignClaimFor, adbDeviceId, adbSerialOf, wifiDeviceId, ownAdbClaim,
  isFullyQualified,
  canonicalClonePath,
  sameClone,
} from '../../scripts/deviceClaimsStore.mjs';
import type { DeviceClaim } from '../../scripts/deviceClaimsStore.d.mts';

// (#865) Seeds must be FULLY QUALIFIED **for this platform**, so `path.resolve`, never a POSIX
// literal. On win32 a bare `/clones/mine` is not qualified — `path.resolve` would re-root it onto
// whatever drive the cwd is on — so `sameClone` matches nothing and every assertion below would go
// green or red for a reason that has nothing to do with what it claims to test. This is the same
// trap as #798/#847/#849, and `buildClaimsStore.test.ts` already resolves its seeds for it.
const MINE = path.resolve('/clones/mine');
const SIBLING = path.resolve('/clones/sibling');
/** The same directory as `MINE`, spelled with a trailing separator. */
const MINE_SLASH = MINE + path.sep;

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const claimsFilePath = () => path.join(claimsDir(), 'device-claims.json');

const writeClaims = (claims: DeviceClaim[]) => {
  fs.mkdirSync(claimsDir(), { recursive: true });
  fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims }));
};

describe('foreignClaimFor', () => {
  it('returns the claim when held by a DIFFERENT clone', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: SIBLING, branch: 'work-ai2',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    const result = foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE });
    expect(result?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
    expect(result?.clone).toBe(SIBLING);
  });

  it('returns null when held by THIS clone', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: MINE, branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).toBeNull();
  });

  it('compares RESOLVED paths — a trailing slash on the claim does not make it look foreign', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: MINE_SLASH, branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).toBeNull();
  });

  it('a trailing slash on the REQUESTED clone likewise does not make it look foreign', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: MINE, branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE_SLASH })).toBeNull();
  });

  it('returns null for a STALE (dead-pid) claim — it holds nothing', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: SIBLING, branch: 'work-ai2',
      pid: 999_999_999, at: Date.now(),
    };
    writeClaims([held]);
    const result = foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), {
      clone: MINE, alive: () => false,
    });
    expect(result).toBeNull();
  });

  it('returns null when nothing claims the device', () => {
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).toBeNull();
  });

  it('defaults `clone` to process.cwd() when not given', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: process.cwd(), branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'))).toBeNull();
  });

  it('goes through listClaims (staleness applied) rather than a raw file read', () => {
    // Sanity: claimDevice + listClaims agree with foreignClaimFor on the same fixture.
    claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), clone: SIBLING, branch: 'work-ai2' });
    expect(listClaims()).toHaveLength(1);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).not.toBeNull();
  });
});

/** `ownAdbClaim` (#235 cross-process) — the build path's replacement for reading the per-process
 *  `deviceConnection` singleton. The bug it fixes was invisible to every existing test because they
 *  all passed `leaseSerial` INTO `resolveBuildAndroidSerial` as an argument: that pins how the
 *  resolver treats a lease, and says nothing about whether the caller can actually SEE one. The
 *  lease lived in the Electron process and the build ran in the Vite process, so the real answer was
 *  always `undefined`. These tests pin the SOURCE, which is where the defect was. */
describe('ownAdbClaim', () => {
  const mine = (deviceId: string, clone = MINE): DeviceClaim => ({
    deviceId, clone, branch: 'work-qa', pid: process.pid, at: Date.now(),
  });

  it('returns THIS clone\'s adb claim — the lease the build must honour', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'))]);
    expect(ownAdbClaim({ clone: MINE })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
  });

  it('ignores a SIBLING clone\'s claim — that phone is not ours to build onto', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'), SIBLING)]);
    expect(ownAdbClaim({ clone: MINE })).toBeNull();
  });

  it('ignores a WiFi lease — an `ip:` claim carries no serial to build with', () => {
    writeClaims([mine(wifiDeviceId('192.168.1.54'))]);
    expect(ownAdbClaim({ clone: MINE })).toBeNull();
  });

  it('returns null when this clone holds TWO handsets, so the caller refuses with both named', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1')), mine(adbDeviceId('RFTESTSERIAL2'))]);
    expect(ownAdbClaim({ clone: MINE })).toBeNull();
  });

  it('applies staleness — a dead-pid claim holds nothing and must not steer a build', () => {
    writeClaims([{ ...mine(adbDeviceId('RFTESTSERIAL1')), pid: 999_999_999 }]);
    expect(ownAdbClaim({ clone: MINE, alive: () => false })).toBeNull();
  });

  it('compares RESOLVED paths, like foreignClaimFor', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'), MINE_SLASH)]);
    expect(ownAdbClaim({ clone: MINE })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
  });

  it('returns null when nothing is claimed at all', () => {
    expect(ownAdbClaim({ clone: MINE })).toBeNull();
  });

  it('sees a claim written by ANOTHER process — the whole point of using the file', () => {
    // `claimDevice` here stands in for the Electron backend opening the lease; the read below
    // stands in for the Vite dev server resolving the build serial. Separate module instances in
    // production, and the file is what makes them agree.
    claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), clone: MINE, branch: 'work-qa' });
    expect(ownAdbClaim({ clone: MINE })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
  });
});

/** `adbSerialOf` — the inverse of `adbDeviceId`, so the build call site does not carry a second copy
 *  of the `adb:` prefix. A hand-rolled `.slice('adb:'.length)` there would survive a prefix change
 *  and yield a MANGLED serial rather than a clean miss. */
describe('adbSerialOf', () => {
  it('round-trips adbDeviceId', () => {
    expect(adbSerialOf(adbDeviceId('RFTESTSERIAL1'))).toBe('RFTESTSERIAL1');
  });

  it('returns undefined for a WiFi id — not a truncated string', () => {
    expect(adbSerialOf(wifiDeviceId('192.168.1.54'))).toBeUndefined();
  });

  it('returns undefined for an iOS id and for junk', () => {
    expect(adbSerialOf('ios:00008150-TESTTESTTESTTEST')).toBeUndefined();
    expect(adbSerialOf('')).toBeUndefined();
  });
});

/** (#865) The qualification gate. These are the cases that made the four comparisons fail OPEN:
 *  a stored `clone` that `path.resolve` cannot finish without consulting `process.cwd()` used to
 *  resolve ONTO this cwd and compare equal, so a sibling clone's claim read as "mine". */
describe('#865 qualification gate', () => {
  const seed = (clone: string) => writeClaims([{
    deviceId: adbDeviceId('RFTESTSERIAL1'), clone, branch: 'work-ai2',
    pid: process.pid, at: Date.now(),
  } as DeviceClaim]);

  // Unqualified on EVERY platform, so these mean the same thing on the Mac clones and on `win`.
  // The win32-only case (a POSIX literal) is separated out below.
  for (const bad of ['.', '', 'rel/path', '..']) {
    it(`treats a stored clone of ${JSON.stringify(bad)} as FOREIGN, never as mine`, () => {
      seed(bad);
      // The own side is WHERE THIS VALUE RESOLVES TO, not merely the cwd. That is what makes each
      // case distinguishing: under the old comparison `path.resolve(bad)` equalled the own side
      // exactly, so the record read as MINE. Using a fixed cwd instead left `rel/path` and `..`
      // resolving somewhere else, so they read as foreign either way and could not fail — caught
      // by mutation-checking this very test.
      const own = path.resolve(bad);
      expect(path.resolve(bad), 'premise: the stored value resolves onto the own side').toBe(own);
      const result = foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: own });
      expect(result, 'an unrecognisable stored path must not read as this clone').not.toBeNull();
      expect(result?.clone).toBe(bad);
    });
  }

  it.runIf(process.platform === 'win32')(
    'treats a POSIX-literal absolute path as FOREIGN on win32 — isAbsolute admits it, resolve re-roots it',
    () => {
      // Premise, so this cannot pass vacuously: the value really is one win32 `isAbsolute` accepts
      // and `resolve` re-roots onto the cwd drive. That combination IS the defect.
      expect(path.isAbsolute('/clones/mine'), 'premise: isAbsolute admits it on win32').toBe(true);
      expect(path.resolve('/clones/mine'), 'premise: and resolve re-roots it onto the cwd drive')
        .toBe(MINE);
      seed('/clones/mine');
      expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).not.toBeNull();
    },
  );

  it('still matches a legitimate claim — the gate must not refuse everything', () => {
    seed(MINE);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: MINE })).toBeNull();
  });
});

/** (#865) `ownAdbClaim`'s ambiguity contract (#149): two candidates means refuse and name both,
 *  never pick one. Adding the qualification gate NAIVELY breaks that — `sameClone` drops the
 *  unqualified record, so two candidates silently become one and the caller gets a confident pick.
 *  That is the one site where hardening the gate introduces a fail-OPEN. */
describe('#865 ownAdbClaim ambiguity is decided before the clone filter', () => {
  it('does not collapse two candidates into one by discarding the unqualified record', () => {
    const cwd = process.cwd();
    // Premise: the unqualified record resolves ONTO the own side, which is what made it a second
    // candidate under the old comparison. Without this the test proves nothing.
    expect(path.resolve('.')).toBe(cwd);
    writeClaims([
      { deviceId: adbDeviceId('SERIALQUALIFIED'), clone: cwd, branch: 'win', pid: process.pid, at: Date.now() },
      { deviceId: adbDeviceId('SERIALUNQUALIFIED'), clone: '.', branch: 'win', pid: process.pid, at: Date.now() },
    ] as DeviceClaim[]);
    expect(
      ownAdbClaim({ clone: cwd }),
      'two claims could be this clone: refuse, do not pick the qualified one',
    ).toBeNull();
  });

  it('still answers when every record is qualified and exactly one is mine', () => {
    writeClaims([
      { deviceId: adbDeviceId('SERIALMINE'), clone: MINE, branch: 'win', pid: process.pid, at: Date.now() },
      { deviceId: adbDeviceId('SERIALTHEIRS'), clone: SIBLING, branch: 'work-ai2', pid: process.pid, at: Date.now() },
    ] as DeviceClaim[]);
    expect(ownAdbClaim({ clone: MINE })?.deviceId).toBe(adbDeviceId('SERIALMINE'));
  });
});

/** (#865) The realpath half — the one that is NOT Windows-only. `device.mjs` records
 *  `clone: repoRoot` with `findRepoRoot` realpathing it, while `vite-asset-scanner.ts` calls
 *  `foreignClaimFor` with no `clone` at all, so the own side was a bare `process.cwd()`. Through a
 *  link the two spell one directory two ways, and the build refused this clone its OWN phone. */
describe('#865 a linked checkout does not make this clone a stranger', () => {
  it('matches when the stored side is the real path and the own side is reached through a link', () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-real-')));
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-link-'));
    const link = path.join(linkDir, 'clone');
    let linked = false;
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch { /* creating a link can need a privilege this machine lacks */ }
    try {
      // Per CLAUDE.md a leg this machine cannot run reports SKIP, never a pass.
      if (!linked) return void console.warn('[#865] SKIP: cannot create a directory link here');
      // Premise: the two spellings differ as strings but name one directory. If a platform ever
      // made them identical this would pass vacuously, so assert the difference first.
      expect(fs.realpathSync(link), 'premise: the link resolves to the real dir').toBe(real);
      expect(link, 'premise: and the two spellings are not already equal').not.toBe(real);
      writeClaims([{
        deviceId: adbDeviceId('RFTESTSERIAL1'), clone: real, branch: 'win',
        pid: process.pid, at: Date.now(),
      } as DeviceClaim]);
      expect(
        foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: link }),
        'this clone wrote the claim under its real path — reaching it through a link is not foreign',
      ).toBeNull();
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });
});

// A literal backslash, built rather than escaped: writing '\\x' here has been silently
// halved to '\x' three times while landing this change, which is an invalid escape in TS
// and, in the regex it also hit, would have stopped matching E:\x on Windows entirely.
const BS = String.fromCharCode(92);

/** (#865) `isFullyQualified` itself, BOTH sides. A guard tested only on what it REJECTS never
 *  proves it ACCEPTS anything — and a gate that refused everything would pass such a suite. */
describe('#865 isFullyQualified accepts and rejects', () => {
  const accepted = process.platform === 'win32'
    ? ['E:' + BS + 'x', 'E:/x', '//server/share',
       BS + BS + 'server' + BS + 'share' + BS + 'x',
       BS + BS + '?' + BS + 'C:' + BS + 'x']
    : ['/a', '/a/b'];
  const rejected = process.platform === 'win32'
    ? ['.', '', 'rel/path', '/Projects/modoki', '//a', '///a/b', '//', 'E:']
    : ['.', '', 'rel/path'];

  for (const v of accepted) {
    it(`accepts ${JSON.stringify(v)}`, () => expect(isFullyQualified(v)).toBe(true));
  }
  for (const v of rejected) {
    it(`rejects ${JSON.stringify(v)}`, () => expect(isFullyQualified(v)).toBe(false));
  }
  it('rejects a non-string, rather than throwing on a corrupt record', () => {
    expect(isFullyQualified(undefined as unknown as string)).toBe(false);
    expect(isFullyQualified(null as unknown as string)).toBe(false);
    expect(isFullyQualified(42 as unknown as string)).toBe(false);
  });
});

/** (#865 close-out review) The FIFTH comparison. `isSameHolder`'s owner branch answers the same
 *  "is this claim mine?" question as the other four and was left on a raw `===` — the fix commit
 *  said "four copies". It self-deadlocks: `device.mjs` writes a realpath'd `clone`, the editor
 *  calls `claimDevice` with no `clone` (so `process.cwd()`), and through a junction or a
 *  lower-case drive letter those are two spellings of one directory. */
describe('#865 isSameHolder recognises an owner-claim through a different spelling', () => {
  it('re-claims a CLI owner-claim when the requester spells the same clone differently', () => {
    // A real directory, so `realpathSync.native` has something to canonicalise.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-clone-')));
    try {
      claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), clone: dir, owner: 'cli:test', label: 'cli' });
      // Premise: a genuinely different STRING for the same directory. Without this the test would
      // pass on plain string equality and prove nothing.
      const spelled = dir + path.sep;
      expect(spelled, 'premise: a different spelling').not.toBe(dir);
      const again = claimDevice({
        deviceId: adbDeviceId('RFTESTSERIAL1'), clone: spelled, owner: 'cli:other', label: 'editor',
      });
      expect(
        again.ok,
        'the same clone spelled differently must not be refused its own claim',
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** (#865 close-out review) `canonicalClonePath` uses `realpathSync.native`, not the JS lstat walk.
 *  The JS walk resolves junctions and symlinks but neither `subst` mappings nor drive-letter CASE,
 *  and an earlier version of the docblock claimed `subst` coverage it did not have. */
describe('#865 canonicalClonePath normalisation', () => {
  it.runIf(process.platform === 'win32')('normalises drive-letter case for a path that EXISTS', () => {
    // `.native`, matching `canonicalClonePath` itself. The JS walk is NOT the same canonicaliser,
    // and they disagree on an 8.3 SHORT path: on the hosted Windows runner the temp dir arrives
    // with a tilde-suffixed profile segment, because the account name is too long for 8.3. The JS
    // walk leaves it short; only `.native` expands it. Seeding the baseline with the JS walk left
    // `dir` short while the subject returned long, so the assertion failed on short-vs-long — not
    // on the drive-letter case this test exists to pin. (Spelled out rather than quoted: a literal
    // profile path trips `scan-publish-safety`'s home-dir-username rule.)
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-case-')));
    try {
      const drive = dir.slice(0, 1);
      const flipped = (drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()) + dir.slice(1);
      // Premise: the flip really did produce a different string, and plain `resolve` does NOT
      // repair it — that is the whole reason `.native` is required here.
      expect(flipped, 'premise: a different spelling').not.toBe(dir);
      expect(path.resolve(flipped), 'premise: resolve does not normalise drive case').not.toBe(dir);
      expect(canonicalClonePath(flipped)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to resolve for a path that does not exist, rather than throwing', () => {
    const missing = path.join(os.tmpdir(), 'modoki-does-not-exist-abcdef', 'x');
    expect(canonicalClonePath(missing)).toBe(path.resolve(missing));
  });

  /** ⚠️ #869: the half #865 left OPEN, and it had no test — a mutation check reverting
   *  `sameClone` to `===` on two `canonicalClonePath` results stayed green, because every case
   *  above uses a path that EXISTS, where `.native` already repairs the drive letter.
   *
   *  The residue lives in the fallback. `.native` THROWS for a missing path, so
   *  `canonicalClonePath` returns bare `path.resolve` output, which does no case folding at all —
   *  and a stale `~/.modoki/device-claims.json` entry naming a directory that has since been
   *  deleted is exactly a missing path. `sameClone` now folds at the COMPARISON, which is what
   *  covers it. Reverting that comparison turns this red. */
  it.runIf(process.platform === 'win32')(
    'sameClone matches two spellings of a MISSING path — #865 closed the existing half only', () => {
      const missing = path.join(os.tmpdir(), 'modoki-869-missing-clone', 'nested');
      const drive = missing.slice(0, 1);
      const flipped = (drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()) + missing.slice(1);

      expect(fs.existsSync(missing), 'premise: genuinely absent').toBe(false);
      expect(flipped, 'premise: a different spelling').not.toBe(missing);
      expect(canonicalClonePath(flipped), 'premise: canonicalising CANNOT repair a missing path')
        .not.toBe(canonicalClonePath(missing));

      // …and yet they name the same clone, so the comparison must say so.
      expect(sameClone(flipped, missing)).toBe(true);
    });

  /** The same residue, asserted on a platform the HUB can fail on.
   *
   *  ⚠️ The test above flips a DRIVE LETTER, so it is win32-only — and #869's other
   *  discriminating cases are too. That leaves the Mac hub unable to fail if someone reverts
   *  `sameClone` to `===` (close-out review). The fold is live on darwin as well, so flipping a
   *  path SEGMENT instead exercises the same mechanism there. Asserted in both directions:
   *  on linux these are genuinely different directories and must NOT match. */
  it('folds a case-flipped SEGMENT exactly on the case-insensitive platforms', () => {
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    const base = path.join(os.tmpdir(), 'modoki-869-Missing-Segment', 'nested');
    const flipped = path.join(os.tmpdir(), 'modoki-869-missing-segment', 'nested');

    expect(fs.existsSync(base), 'premise: genuinely absent').toBe(false);
    expect(flipped, 'premise: a different spelling').not.toBe(base);
    expect(sameClone(flipped, base)).toBe(caseInsensitive);
  });
});

/** (#865 close-out review) `ownAdbClaim` refusing on an unqualified record is correct, but it was
 *  the one path that degraded with NO diagnostic: `resolveBuildAndroidSerial` never mentions the
 *  claims file, so the developer saw a plain "name a device" refusal with no hint that one junk
 *  record removed the answer. */
describe('#865 ownAdbClaim says WHY it declined to answer', () => {
  it('warns naming the offending record and the file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeClaims([
        { deviceId: adbDeviceId('SERIALMINE'), clone: MINE, branch: 'win', pid: process.pid, at: Date.now() },
        { deviceId: adbDeviceId('SERIALJUNK'), clone: '.', branch: 'win', pid: process.pid, at: Date.now() },
      ] as DeviceClaim[]);
      expect(ownAdbClaim({ clone: MINE })).toBeNull();
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said, 'the warning must name the device whose record is bad').toContain('SERIALJUNK');
      expect(said, 'and the file to fix').toContain('device-claims.json');
    } finally {
      warn.mockRestore();
    }
  });
});
