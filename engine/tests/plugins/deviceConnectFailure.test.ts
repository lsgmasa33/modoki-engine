/** `explainConnectFailure` (#95) — the message a dead-ended `device_connect` leaves behind.
 *
 *  A bare `ECONNREFUSED` on the shared default port points the reader at the wrong conclusion
 *  ("the app isn't running"), when the far more common cause on this surface is that a SECOND
 *  Modoki app holds 9095 and the app you just launched fell back to an OS-assigned port and is
 *  perfectly healthy. Measured on the iPhone Air 2026-08-02; it cost about an hour. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

  // The message ends by telling the reader to `device_connect {ip:"…", port:<actual>}`. That advice
  // was UNACTIONABLE for months: the backend, the lease and this message all supported `port`, but
  // the MCP tool's schema declared only {ip, useAdb}, so following the instruction returned
  // "unrecognized parameter" and the session dead-ended on the very error written to rescue it
  // (#122, found on an iPhone 7 where three consecutive launches fell back off 9095).
  //
  // Asserting the SCHEMA from here — rather than in the MCP package — is deliberate: the advice and
  // the parameter it names live in different packages, and it is the DRIFT between them that broke.
  it('advertises a `port` option the device_connect tool actually accepts', () => {
    const advice = explainConnectFailure('connect ECONNREFUSED 192.168.1.181:9095', DEVICE_PORT)!;
    expect(advice).toContain('port:<actual>');

    const toolSrc = fs.readFileSync(
      path.resolve(__dirname, '../../tools/game-debug-mcp/src/mcp-tools.ts'), 'utf8');
    const schema = toolSrc.slice(toolSrc.indexOf("tool('device_connect'"), toolSrc.indexOf('async ({ ip, useAdb'));
    expect(schema).toMatch(/\bport:\s*z\.number\(\)/);
    // …and that it is threaded through to the backend, not merely declared.
    const body = toolSrc.slice(toolSrc.indexOf("tool('device_connect'"), toolSrc.indexOf("tool('device_disconnect'"));
    expect(body).toContain('port !== undefined ? { port } : {}');
  });
});

/** The USB half (#164). Over `adb forward` the local end ACCEPTS, so nothing ever raises
 *  ECONNREFUSED and every message above is unreachable — the failure arrives as the lease client's
 *  `refused` sentinel instead, which reads as "another Modoki owns it". A session chasing a phantom
 *  lease conflict is the cost; the real cause was that nothing was listening at all. */
describe('explainConnectFailure over adb (#164)', () => {
  it('names BOTH causes of a handshake with no reply, rather than only the lease conflict', () => {
    const out = explainConnectFailure('refused', DEVICE_PORT, true)!;
    expect(out).toMatch(/nothing is listening/i);        // the cause the old message could not reach
    expect(out).toMatch(/another modoki/i);              // …without dropping the one it did
    expect(out).toMatch(/debugBuild/);                   // the actual gate, named
    expect(out).toMatch(/proc\/net\/tcp/);               // the command that settles which it is
  });

  it('states the device port in HEX, because that is what /proc/net/tcp shows', () => {
    // The issue's own A/B was voided by hand-converting 9095 and getting 0x238F (=9103). A grep
    // recipe that makes the reader do that conversion is a recipe for the same void result.
    expect(explainConnectFailure('refused', 9095, true)).toContain('2387');
  });

  it('leaves a GENUINE busy reply alone — the device named its reason, so do not second-guess it', () => {
    // `busy` / `no-lease` / `not-owner` come from the plugin itself (GameDebugPlugin.java/.swift);
    // only `refused` is this end giving up without an answer. Widening the branch to any busy state
    // would bury a real lease conflict under speculation about a gate that is demonstrably fine.
    for (const reason of ['busy', 'no-lease', 'not-owner']) {
      expect(explainConnectFailure(reason, DEVICE_PORT, true)).toBe(reason);
    }
  });

  it('does not fire over WiFi, where a dead port really does raise ECONNREFUSED', () => {
    expect(explainConnectFailure('refused', DEVICE_PORT, false)).toBe('refused');
    expect(explainConnectFailure('refused', DEVICE_PORT)).toBe('refused');
  });
});
