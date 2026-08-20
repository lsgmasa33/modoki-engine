/** Bridge-port discovery (#283) — `plugins/backend/androidBridgePort.ts`.
 *
 *  The fixtures are REAL output from a Galaxy A23 on 2026-08-20, taken during the investigation
 *  that produced the issue. That matters more than usual here: every field this parses is a
 *  positional column in a kernel file or a `dumpsys` line, and a hand-written fixture would encode
 *  what I ASSUMED those look like — which is precisely the mistake that made an earlier pass read a
 *  TIME_WAIT row as a listener and conclude the bridge had never started.
 *
 *  Serials/uids are the real ones from that session; they identify hardware in this private repo
 *  only, and nothing here ships publicly (a real device UDID would be a different matter — see
 *  docs/engine-oss-publishing.md § "Device ids"). */

import { describe, it, expect } from 'vitest';
import {
  parseListeningSockets, parseForegroundPackage, parsePackageUid, resolveBridgePort,
  DEFAULT_BRIDGE_PORT,
} from '../../plugins/backend/androidBridgePort';
import { DEVICE_PORT } from '../../plugins/backend/deviceConnection';

// Verbatim `cat /proc/net/tcp /proc/net/tcp6`: one IPv4-loopback listener (the `nc` squatter, uid
// 2000), one dual-stack listener on 0x9F57 = 40791 (skin-test, uid 10406), and — the row that
// matters — a TIME_WAIT (state 06) remnant on 0x2387 = 9095, which is NOT a listener.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2387 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 68850638 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2387 0100007F:A447 06 00000000:00000000 03:00001258 00000000     0        0 0 3 0000000000000000
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:9F57 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10406        0 68246534 1 0000000000000000 100 0 0 10 0
`;

const DUMPSYS_WINDOW = '  mCurrentFocus=Window{886e317 u0 com.modokiengine.skintest/com.modokiengine.skintest.MainActivity}\n';

describe('parseListeningSockets', () => {
  it('returns only LISTEN rows, from both tcp and tcp6', () => {
    expect(parseListeningSockets(PROC_NET_TCP)).toEqual([
      { port: 9095, uid: 2000 },
      { port: 40791, uid: 10406 },
    ]);
  });

  it('does NOT count a TIME_WAIT row as a listener', () => {
    // The distinguishing case, and the one that cost real time: a closed connection leaves a row on
    // the default port that looks like occupancy to any check that ignores the state column.
    const timeWaitOnly = PROC_NET_TCP.split('\n').filter((l) => !/ 0A /.test(l)).join('\n');
    expect(parseListeningSockets(timeWaitOnly)).toEqual([]);
  });

  it('reads the port after the LAST colon, so a 32-hex IPv6 address parses like an IPv4 one', () => {
    const v6 = '   0: 00000000000000000000000000000000:2387 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10412        0 68246534 1 0000000000000000 100 0 0 10 0';
    expect(parseListeningSockets(v6)).toEqual([{ port: 9095, uid: 10412 }]);
  });

  it('collapses a dual-stack listener reported in both files', () => {
    const both = `   0: 00000000:2387 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10406        0 68246534 1 0000000000000000 100 0 0 10 0
   0: 00000000000000000000000000000000:2387 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10406        0 68246534 1 0000000000000000 100 0 0 10 0`;
    expect(parseListeningSockets(both)).toEqual([{ port: 9095, uid: 10406 }]);
  });

  it('survives junk without inventing rows', () => {
    expect(parseListeningSockets('')).toEqual([]);
    expect(parseListeningSockets('error: device offline')).toEqual([]);
  });
});

describe('parseForegroundPackage', () => {
  it('takes the package before the slash', () => {
    expect(parseForegroundPackage(DUMPSYS_WINDOW)).toBe('com.modokiengine.skintest');
  });

  it('handles a package that is not named "modoki"', () => {
    // The whole reason discovery keys off the foreground app rather than a name pattern: Court is
    // `com.apiary.court`, and a `grep modoki` missed it for an entire investigation (#283).
    const court = '  mCurrentFocus=Window{2bba2a2 u0 com.apiary.court/com.apiary.court.MainActivity}';
    expect(parseForegroundPackage(court)).toBe('com.apiary.court');
  });

  it('returns undefined for a locked/empty screen rather than a bogus package', () => {
    expect(parseForegroundPackage('  mCurrentFocus=null')).toBeUndefined();
    expect(parseForegroundPackage('')).toBeUndefined();
  });

  it('prefers mFocusedApp when a SYSTEM window holds focus — the notification-shade case', () => {
    // Measured on the A23 mid-test: with the shade pulled down, `mCurrentFocus` names
    // NotificationShade while the app underneath is still the foreground app. Keying off
    // `mCurrentFocus` alone made discovery answer "no foreground app" for a phone that had one.
    const shadeDown = `  mCurrentFocus=Window{ad45979 u0 NotificationShade}
  mFocusedApp=ActivityRecord{da6654c u0 com.modokiengine.skintest/.MainActivity} t422}`;
    expect(parseForegroundPackage(shadeDown)).toBe('com.modokiengine.skintest');
  });

  it('falls back to mCurrentFocus when mFocusedApp is absent or null', () => {
    expect(parseForegroundPackage(`  mFocusedApp=null\n${DUMPSYS_WINDOW}`)).toBe('com.modokiengine.skintest');
    expect(parseForegroundPackage('  mFocusedApp=null\n  mCurrentFocus=null')).toBeUndefined();
  });
});

describe('parsePackageUid', () => {
  it('reads userId= out of dumpsys package', () => {
    expect(parsePackageUid('    userId=10406\n')).toBe(10406);
  });
  it('returns undefined when the package is not installed (no such line)', () => {
    expect(parsePackageUid('Unable to find package: com.nope')).toBeUndefined();
  });
});

describe('resolveBridgePort', () => {
  const uids: Record<string, number> = { 'com.modokiengine.skintest': 10406, 'com.apiary.court': 10412 };
  const uidOf = (p: string) => uids[p];

  it('returns the port owned by the FOREGROUND app, not whatever is listening', () => {
    // The squatter on 9095 (uid 2000) is listening and is NOT the answer — picking it is #88.
    expect(resolveBridgePort(PROC_NET_TCP, DUMPSYS_WINDOW, uidOf))
      .toEqual({ port: 40791, pkg: 'com.modokiengine.skintest' });
  });

  it('prefers the default port when the foreground app holds it', () => {
    const onDefault = `   0: 00000000000000000000000000000000:2387 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10406        0 68246534 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:9F57 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10406        0 68246535 1 0000000000000000 100 0 0 10 0`;
    expect(resolveBridgePort(onDefault, DUMPSYS_WINDOW, uidOf)?.port).toBe(DEFAULT_BRIDGE_PORT);
  });

  it('is undefined when the foreground app owns no listener — never a guess', () => {
    // Court is foregrounded but every listener belongs to someone else. Answering with the
    // squatter's port would connect the lease to the wrong app, which is worse than refusing.
    const courtFocused = '  mCurrentFocus=Window{2bba2a2 u0 com.apiary.court/com.apiary.court.MainActivity}';
    expect(resolveBridgePort(PROC_NET_TCP, courtFocused, uidOf)).toBeUndefined();
  });

  it('is undefined when nothing has focus, or the package will not resolve', () => {
    expect(resolveBridgePort(PROC_NET_TCP, 'mCurrentFocus=null', uidOf)).toBeUndefined();
    expect(resolveBridgePort(PROC_NET_TCP, DUMPSYS_WINDOW, () => undefined)).toBeUndefined();
  });
});

it('DEFAULT_BRIDGE_PORT agrees with the lease DEVICE_PORT', () => {
  // The constant is duplicated to avoid a circular import between these two modules; this is what
  // makes the duplication safe rather than a second source of truth waiting to drift.
  expect(DEFAULT_BRIDGE_PORT).toBe(DEVICE_PORT);
});
