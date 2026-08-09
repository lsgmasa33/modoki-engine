/** #107 — `device_status` reported `Input mechanism: synthetic` while `/api/device/status` said
 *  `trusted-wda` at the same moment, reproducibly, on the `win` clone (2026-08-03).
 *
 *  What the repo already had was `deviceInputMechanismParity.test.ts`, which asserts the four
 *  surfaces DECLARE the same three literals and that each is mentioned in the reporter. Those all
 *  passed, and were passing while the bug was live — because parity of the literals says nothing
 *  about what the reporter DOES with a given value. Rendering was inline in the tool handler, so
 *  the only layer that could be wrong was the only layer nothing could test. This file closes
 *  that: `describeInputFidelity` is pure, and every case is rendered here.
 *
 *  The pair is deliberate — parity guards the VOCABULARY, this guards the SENTENCE. Neither
 *  replaces the other. */

import { describe, it, expect } from 'vitest';
import { describeInputFidelity, type LeaseStatus } from '../../tools/game-debug-mcp/src/reply';

const connected = (over: Partial<LeaseStatus> = {}): LeaseStatus => ({
  state: 'connected',
  target: { host: '192.168.1.181', port: 9095, useAdb: false },
  lastTarget: null,
  ...over,
});

describe('describeInputFidelity — the reported mechanism is the probed one (#107)', () => {
  it('reports trusted-wda when the backend probed trusted-wda — the exact #107 mismatch', () => {
    // The reproduction from the issue: backend `{"inputMechanism":"trusted-wda","trustedOps":[…]}`
    // while the tool printed "synthetic". Anything containing 'synthetic' as the CLAIM here is the
    // bug; note the WDA line legitimately mentions synthetic for the ops it does NOT cover, which
    // is why this asserts the claim rather than the mere absence of the word.
    const line = describeInputFidelity(connected({ inputMechanism: 'trusted-wda', trustedOps: ['tap', 'drag'] }));
    expect(line).toMatch(/^Input mechanism: trusted-wda\b/);
    expect(line).toContain('device_tap/device_drag');
  });

  it('names the trusted ops from the backend, never assuming the whole surface is trusted', () => {
    // iOS routes a NARROWER set than Android. If the backend ever widens or narrows it, the line
    // must follow the data — claiming an op is trusted when it is synthetic is the false-fidelity
    // class #32 exists to close, and it errs in the UNSAFE direction.
    expect(describeInputFidelity(connected({ inputMechanism: 'trusted-wda', trustedOps: ['tap'] })))
      .toContain('trusted-wda for device_tap (');
  });

  it('falls back to tap/drag when a connected WDA lease omits trustedOps', () => {
    expect(describeInputFidelity(connected({ inputMechanism: 'trusted-wda' })))
      .toContain('device_tap/device_drag');
  });

  it('reports trusted-cdp for the Android route, and still names pointer/type_text as synthetic', () => {
    const line = describeInputFidelity(connected({ inputMechanism: 'trusted-cdp' }));
    expect(line).toMatch(/^Input mechanism: trusted-cdp\b/);
    expect(line).toContain('device_pointer/type_text are still synthetic');
  });

  it('reports synthetic when the probe actually found no trusted route', () => {
    expect(describeInputFidelity(connected({ inputMechanism: 'synthetic' })))
      .toMatch(/^Input mechanism: synthetic\b/);
  });

  it('says "no device is connected" ONLY when no device is connected', () => {
    for (const state of ['disconnected', 'error', 'connecting']) {
      expect(describeInputFidelity({ state, target: null, lastTarget: null }))
        .toContain('no device is connected');
    }
  });

  it('never claims "no device is connected" while the lease IS connected', () => {
    // The residual defect #107 exposed. The old chain decided the disconnected case by falling off
    // the end of the mechanism comparisons, so a mechanism it did not recognise printed "no device
    // is connected" — directly contradicting the lease line above it, in exactly the version-skew
    // case (older MCP process, newer backend) this class of bug comes from.
    for (const m of ['trusted-xr', 'trusted-cdp-v2', '', 'SYNTHETIC']) {
      expect(
        describeInputFidelity(connected({ inputMechanism: m })),
        `an unrecognised mechanism '${m}' on a CONNECTED lease must not be reported as disconnected`,
      ).not.toContain('no device is connected');
    }
  });

  it('reports an unrecognised mechanism AS unknown, naming what the backend said', () => {
    // Honest in both directions: it neither downgrades to synthetic (understating fidelity, the
    // #107 complaint) nor guesses trusted (overstating it, the worse error). It also names the
    // cause, because "your MCP is older than your backend" is a fixable thing to be told.
    const line = describeInputFidelity(connected({ inputMechanism: 'trusted-future' }));
    expect(line).toContain('trusted-future');
    expect(line).toContain('unknown to this MCP build');
    expect(line).toMatch(/restart the MCP server/i);
  });

  it('reports a connected lease with NO mechanism as unreported, not as disconnected', () => {
    // An older backend, pre-#32-Phase-1: it has nothing to say. Distinct from both "disconnected"
    // and "synthetic" — the latter would be a claim this build has no evidence for.
    const line = describeInputFidelity(connected());
    expect(line).toContain('unreported');
    expect(line).not.toContain('no device is connected');
  });
});
