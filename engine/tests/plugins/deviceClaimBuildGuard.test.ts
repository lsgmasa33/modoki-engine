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
  claimsDir, listClaims, claimDevice, foreignClaimFor, adbDeviceId,
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
