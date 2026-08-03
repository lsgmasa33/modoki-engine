/** `explainConnectFailure` (#95) — the message a dead-ended `device_connect` leaves behind.
 *
 *  A bare `ECONNREFUSED` on the shared default port points the reader at the wrong conclusion
 *  ("the app isn't running"), when the far more common cause on this surface is that a SECOND
 *  Modoki app holds 9095 and the app you just launched fell back to an OS-assigned port and is
 *  perfectly healthy. Measured on the iPhone Air 2026-08-02; it cost about an hour. */

import { describe, it, expect } from 'vitest';
import { explainConnectFailure, DEVICE_PORT } from '../../plugins/backend/deviceConnection';

describe('explainConnectFailure', () => {
  it('explains the shared-port collision, and names both ways out', () => {
    const out = explainConnectFailure(`connect ECONNREFUSED 192.168.1.181:${DEVICE_PORT}`, DEVICE_PORT)!;
    expect(out).toMatch(/ECONNREFUSED/);              // keeps the original cause, never hides it
    expect(out).toMatch(/another port/i);             // the counter-intuitive part
    expect(out).toMatch(/grep modoki/);               // fix 1: close the squatter
    expect(out).toMatch(/port:<actual>/);             // fix 2: connect explicitly
  });

  it('stays quiet when an EXPLICIT port was given — the advice would be wrong there', () => {
    // Connecting to a deliberate non-default port and being refused means what it says: nothing is
    // there. Blaming the shared default would send the reader chasing a collision that cannot apply.
    const raw = 'connect ECONNREFUSED 192.168.1.181:64309';
    expect(explainConnectFailure(raw, 64309)).toBe(raw);
  });

  it('leaves unrelated failures untouched', () => {
    const raw = 'adb forward failed: device offline';
    expect(explainConnectFailure(raw, DEVICE_PORT)).toBe(raw);
    expect(explainConnectFailure(undefined, DEVICE_PORT)).toBeUndefined();
  });
});
