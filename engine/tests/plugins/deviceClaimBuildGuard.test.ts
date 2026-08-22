/**
 * `foreignClaimFor` (#285 sibling) — the one check the BUILD path (`vite-asset-scanner.ts`) uses to
 * refuse installing over a sibling clone's claimed phone. See `deviceClaimsStore.mjs` for the
 * rationale; this file exercises the helper directly, the same way `deviceClaims.test.ts` exercises
 * its neighbours.
 *
 * MODOKI_HOME is pointed at a per-test temp dir for every test: a bug here writing to the real
 * `~/.modoki/device-claims.json` could block the developer's own phone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimsDir, listClaims, claimDevice, foreignClaimFor, adbDeviceId, adbSerialOf, wifiDeviceId, ownAdbClaim,
} from '../../scripts/deviceClaimsStore.mjs';
import type { DeviceClaim } from '../../scripts/deviceClaimsStore.d.mts';

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
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/sibling', branch: 'work-ai2',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    const result = foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine' });
    expect(result?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
    expect(result?.clone).toBe('/clones/sibling');
  });

  it('returns null when held by THIS clone', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/mine', branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine' })).toBeNull();
  });

  it('compares RESOLVED paths — a trailing slash on the claim does not make it look foreign', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/mine/', branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine' })).toBeNull();
  });

  it('a trailing slash on the REQUESTED clone likewise does not make it look foreign', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/mine', branch: 'work-ai3',
      pid: process.pid, at: Date.now(),
    };
    writeClaims([held]);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine/' })).toBeNull();
  });

  it('returns null for a STALE (dead-pid) claim — it holds nothing', () => {
    const held: DeviceClaim = {
      deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/sibling', branch: 'work-ai2',
      pid: 999_999_999, at: Date.now(),
    };
    writeClaims([held]);
    const result = foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), {
      clone: '/clones/mine', alive: () => false,
    });
    expect(result).toBeNull();
  });

  it('returns null when nothing claims the device', () => {
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine' })).toBeNull();
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
    claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/sibling', branch: 'work-ai2' });
    expect(listClaims()).toHaveLength(1);
    expect(foreignClaimFor(adbDeviceId('RFTESTSERIAL1'), { clone: '/clones/mine' })).not.toBeNull();
  });
});

/** `ownAdbClaim` (#235 cross-process) — the build path's replacement for reading the per-process
 *  `deviceConnection` singleton. The bug it fixes was invisible to every existing test because they
 *  all passed `leaseSerial` INTO `resolveBuildAndroidSerial` as an argument: that pins how the
 *  resolver treats a lease, and says nothing about whether the caller can actually SEE one. The
 *  lease lived in the Electron process and the build ran in the Vite process, so the real answer was
 *  always `undefined`. These tests pin the SOURCE, which is where the defect was. */
describe('ownAdbClaim', () => {
  const mine = (deviceId: string, clone = '/clones/mine'): DeviceClaim => ({
    deviceId, clone, branch: 'work-qa', pid: process.pid, at: Date.now(),
  });

  it('returns THIS clone\'s adb claim — the lease the build must honour', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'))]);
    expect(ownAdbClaim({ clone: '/clones/mine' })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
  });

  it('ignores a SIBLING clone\'s claim — that phone is not ours to build onto', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'), '/clones/sibling')]);
    expect(ownAdbClaim({ clone: '/clones/mine' })).toBeNull();
  });

  it('ignores a WiFi lease — an `ip:` claim carries no serial to build with', () => {
    writeClaims([mine(wifiDeviceId('192.168.1.54'))]);
    expect(ownAdbClaim({ clone: '/clones/mine' })).toBeNull();
  });

  it('returns null when this clone holds TWO handsets, so the caller refuses with both named', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1')), mine(adbDeviceId('RFTESTSERIAL2'))]);
    expect(ownAdbClaim({ clone: '/clones/mine' })).toBeNull();
  });

  it('applies staleness — a dead-pid claim holds nothing and must not steer a build', () => {
    writeClaims([{ ...mine(adbDeviceId('RFTESTSERIAL1')), pid: 999_999_999 }]);
    expect(ownAdbClaim({ clone: '/clones/mine', alive: () => false })).toBeNull();
  });

  it('compares RESOLVED paths, like foreignClaimFor', () => {
    writeClaims([mine(adbDeviceId('RFTESTSERIAL1'), '/clones/mine/')]);
    expect(ownAdbClaim({ clone: '/clones/mine' })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
  });

  it('returns null when nothing is claimed at all', () => {
    expect(ownAdbClaim({ clone: '/clones/mine' })).toBeNull();
  });

  it('sees a claim written by ANOTHER process — the whole point of using the file', () => {
    // `claimDevice` here stands in for the Electron backend opening the lease; the read below
    // stands in for the Vite dev server resolving the build serial. Separate module instances in
    // production, and the file is what makes them agree.
    claimDevice({ deviceId: adbDeviceId('RFTESTSERIAL1'), clone: '/clones/mine', branch: 'work-qa' });
    expect(ownAdbClaim({ clone: '/clones/mine' })?.deviceId).toBe(adbDeviceId('RFTESTSERIAL1'));
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
