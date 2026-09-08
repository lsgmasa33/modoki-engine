/** Regression guard for #471: the adb screenshot branch used to stamp `adbScreenInfo.lease` with a
 *  lease key read AFTER `adbScreencap()`'s 1-3s capture, not the key that was live when the pixels
 *  were actually measured. A claim is machine-wide (docs/devices.md), so any sibling clone's
 *  `device_connect` — or the human reconnecting in the AI panel — can take the lease mid-capture.
 *  The late read then stamps the NEW lease's key onto the OLD device's dimensions, and
 *  `currentScreenInfo()`'s staleness guard (`key !== adbScreenInfo.lease`) passes it as fresh: a
 *  later `device_tap`/`device_drag` mis-scales against the wrong device's dimensions, silently.
 *
 *  The fix is two pure, directly-testable functions:
 *    - `statusLeaseKey()` — now keys an adb lease by `adb:<serial>` (the payload really carries
 *      `target.serial`, #149) instead of colliding every adb lease onto the literal string 'adb'.
 *    - `screenInfoIfLeaseHeld()` — compares a PRE-capture key against a POST-capture key and
 *      returns null (not a stamped lease) the moment they differ, so a moved lease drops the
 *      measurement instead of laundering it.
 *
 *  `leaseAdbTarget()` reads `serial` and its `statusLeaseKey` from the SAME status reply, so the
 *  serial handed to `adbScreencap` and the pre-capture key compared here provably describe one
 *  lease read, not two that could disagree.
 */

import { describe, it, expect } from 'vitest';
import { statusLeaseKey, screenInfoIfLeaseHeld } from '../../tools/game-debug-mcp/src/mcp-tools';

// Minimal shape matching DeviceStatusReply — not exported, so mirrored here structurally.
type Status = { state?: string; target?: { host?: string; port?: number; useAdb?: boolean; serial?: string } | null };

describe('statusLeaseKey', () => {
  it('is null when disconnected', () => {
    expect(statusLeaseKey({ state: 'disconnected', target: { useAdb: true, serial: 'A' } } as Status)).toBeNull();
  });

  it('is null when connected but target is missing', () => {
    expect(statusLeaseKey({ state: 'connected', target: null } as Status)).toBeNull();
  });

  it('is null for undefined input', () => {
    expect(statusLeaseKey(undefined)).toBeNull();
  });

  it('keys two adb leases with different serials distinctly (#471)', () => {
    const a = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'SERIAL_A' } } as Status);
    const b = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'SERIAL_B' } } as Status);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toEqual(b);
  });

  it('keys the same serial equally', () => {
    const s = { state: 'connected', target: { useAdb: true, serial: 'SERIAL_A' } } as Status;
    expect(statusLeaseKey(s)).toEqual(statusLeaseKey({ ...s }));
  });

  it('degrades to a constant key for a serial-less adb lease (no worse than pre-#149)', () => {
    expect(statusLeaseKey({ state: 'connected', target: { useAdb: true } } as Status)).toEqual('adb:');
  });

  it('keys a WiFi lease by host:port', () => {
    expect(statusLeaseKey({ state: 'connected', target: { useAdb: false, host: '192.168.1.5', port: 8095 } } as Status))
      .toEqual('192.168.1.5:8095');
  });

  it('an adb lease and a WiFi lease never collide', () => {
    const adb = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'X' } } as Status);
    const wifi = statusLeaseKey({ state: 'connected', target: { useAdb: false, host: 'adb', port: 0 } } as Status);
    expect(adb).not.toEqual(wifi);
  });
});

describe('screenInfoIfLeaseHeld', () => {
  const dims = { imgW: 100, imgH: 200, nativeW: 1000, nativeH: 2000 };

  it('stamps the dims with the key when the lease held (same before/after)', () => {
    expect(screenInfoIfLeaseHeld('adb:SERIAL_A', 'adb:SERIAL_A', dims)).toEqual({ ...dims, lease: 'adb:SERIAL_A' });
  });

  it('drops the dims when the key changed', () => {
    expect(screenInfoIfLeaseHeld('adb:SERIAL_A', 'adb:SERIAL_B', dims)).toBeNull();
  });

  it('drops the dims when the pre-capture key is null (unknown lease before the capture)', () => {
    expect(screenInfoIfLeaseHeld(null, 'adb:SERIAL_A', dims)).toBeNull();
  });

  it('drops the dims when the post-capture key is null (lease dropped during the capture)', () => {
    expect(screenInfoIfLeaseHeld('adb:SERIAL_A', null, dims)).toBeNull();
  });

  it('null-before and null-after is NOT a match — two "unknown"s are not the same lease', () => {
    // A naive `before === after` comparison gets this wrong: `null === null` is true in JS, so it
    // would stamp dims measured under an unresolvable lease as if they were fresh.
    expect(screenInfoIfLeaseHeld(null, null, dims)).toBeNull();
  });
});

describe('#471 regression: the old late-read behaviour would have laundered a moved lease', () => {
  it('a lease that moved during capture is now dropped, where the old code would have passed it', () => {
    // Reproduce the pre-fix sequence: dims measured while `adb:SERIAL_A` was live, but by the time
    // the (late) lease key was read, a sibling clone had taken `adb:SERIAL_B`.
    const measuredUnder = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'SERIAL_A' } } as Status);
    const readAfterCapture = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'SERIAL_B' } } as Status);
    expect(measuredUnder).not.toEqual(readAfterCapture);

    // OLD behaviour: `adbScreenInfo.lease = readAfterCapture` (stamped with the POST-capture key,
    // not what the dims were measured under). `currentScreenInfo()`'s guard is `key !== stampedLease`
    // — reading the status AGAIN right after would return `readAfterCapture` too (nothing moved a
    // third time), so `readAfterCapture !== readAfterCapture` is false: the guard PASSES the stale
    // dims as fresh. Assert both sides against the literal expected key, not against each other —
    // `expect(x).toEqual(x)` can never fail and would prove nothing.
    const oldStampedLease = readAfterCapture;
    const laterCheck = statusLeaseKey({ state: 'connected', target: { useAdb: true, serial: 'SERIAL_B' } } as Status);
    expect(oldStampedLease).toEqual('adb:SERIAL_B');
    expect(laterCheck).toEqual('adb:SERIAL_B'); // old code: guard falsely says "still fresh"

    // NEW behaviour: screenInfoIfLeaseHeld compares the PRE-capture key against the POST-capture
    // key directly, so the mismatch is caught at capture time instead of laundered into the stamp.
    const dims = { imgW: 100, imgH: 200, nativeW: 1000, nativeH: 2000 };
    expect(screenInfoIfLeaseHeld(measuredUnder, readAfterCapture, dims)).toBeNull();
  });
});
