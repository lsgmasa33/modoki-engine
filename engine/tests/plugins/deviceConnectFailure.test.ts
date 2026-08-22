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
import { parseBoundBridgePort } from '../../plugins/backend/deviceAndroidDiag';

describe('explainConnectFailure', () => {
  it('explains the shared-port collision, and names both ways out', () => {
    const out = explainConnectFailure(`connect ECONNREFUSED 192.168.1.181:${DEVICE_PORT}`, DEVICE_PORT)!;
    expect(out).toMatch(/ECONNREFUSED/);              // keeps the original cause, never hides it
    expect(out).toMatch(/another port/i);             // the counter-intuitive part
    expect(out).toMatch(/proc\/net\/tcp/);             // fix 1: close the squatter — found by SOCKET
    expect(out).toMatch(/port:<actual>/);             // fix 2: connect explicitly
    // #283: the advice used to be `grep modoki`, which MISSES a Modoki game whose package is not
    // named that. Court (com.apiary.court) held 9095 through a whole investigation for exactly
    // this reason, so the name is pinned here rather than left to drift back.
    expect(out).toMatch(/com\.apiary\.court/);
    expect(out).not.toMatch(/grep modoki/);
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

  it('names the LOST-BIND-RACE cause too — the app is up, just on another port (#283)', () => {
    // Measured on a Galaxy A23: launching a game while another Modoki app was still releasing 9095
    // left the new app on an OS-assigned port for its whole lifetime, and it never reclaims 9095.
    // With only causes 1 and 2, that reads as "nothing is listening" and sends the reader to the
    // debugBuild gate — which is fine, so the trail goes cold exactly where it did in #283.
    const out = explainConnectFailure('refused', DEVICE_PORT, true)!;
    expect(out).toMatch(/DIFFERENT port/);
    expect(out).toMatch(/TCP server listening/);         // how to read the real port off the device
    expect(out).toMatch(/port:<actual>/);                // and what to do with it
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

/** #239 — the flag the message could always have READ.
 *
 *  Six of twenty projects shipped with `build.debugBuild` absent, so `device_connect` dead-ended on
 *  each one. The two branches above are honest about not being able to tell their causes apart, and
 *  the adb one leads with a HEAL problem — but healing a `false` flag writes it off again, so its
 *  single suggested fix could not work. When the router can see the flag is off there is nothing to
 *  guess: no server was compiled in. */
describe('explainConnectFailure when the project is not a debug build (#239)', () => {
  it('names the flag as THE cause, over adb', () => {
    const out = explainConnectFailure('refused', DEVICE_PORT, true, false)!;
    expect(out).toContain('build.debugBuild: false');
  });

  it('names it over WiFi too, where the symptom is an ECONNREFUSED instead', () => {
    const out = explainConnectFailure(`connect ECONNREFUSED 192.168.1.181:${DEVICE_PORT}`, DEVICE_PORT, false, false)!;
    expect(out).toContain('build.debugBuild: false');
  });

  it('says REBUILD, and says reopening alone is not enough', () => {
    // The trap this replaces: the adb advice sends you to heal-on-open, which syncs the flag's
    // CURRENT value — off — into the native project. Following it changes nothing and reads as
    // "I did the fix and it still fails".
    const out = explainConnectFailure('refused', DEVICE_PORT, true, false)!;
    expect(out).toMatch(/REBUILD/i);
    expect(out).toMatch(/not enough/i);
  });

  it('over ECONNREFUSED it may rule the other causes OUT — nothing accepted the socket', () => {
    const out = explainConnectFailure(`connect ECONNREFUSED 10.0.0.5:${DEVICE_PORT}`, DEVICE_PORT, false, false)!;
    expect(out).toMatch(/Nothing about the network, the port, or another Modoki/i);
  });

  it('over `refused` it must NOT rule them out — an accepted socket proves something IS listening', () => {
    // ⚠️ THE FLAG IS THE OPEN PROJECT'S; THE PHONE MAY BE RUNNING A DIFFERENT APP, and which app
    // holds the socket is unknowable until a lease opens (#88). `refused` means the connection was
    // ACCEPTED and then not answered — so "no server was compiled in" cannot be the whole story.
    // Hit for real on a Galaxy A23 (2026-08-19): a backgrounded `sling` answered a connect aimed
    // at `postfx-demo`. Had the open project been debugBuild:false, the old message would have
    // said "there is no TCP server on the device" while sling's server was demonstrably replying.
    const out = explainConnectFailure('refused', DEVICE_PORT, true, false)!;
    expect(out).toContain('build.debugBuild: false');       // still the leading suspect
    expect(out).toMatch(/NOT the only cause/i);             // but not the only one
    expect(out).toMatch(/squatting the shared port|force-stop/i);
  });

  it('stays out of the way when the flag is ON — the old two-cause advice is still the right answer', () => {
    const out = explainConnectFailure('refused', DEVICE_PORT, true, true)!;
    expect(out).not.toContain('build.debugBuild: false');
    expect(out).toContain('/proc/net/tcp');
  });

  it('stays out of the way when the flag is UNKNOWN — an unreadable config must not assert', () => {
    const out = explainConnectFailure('refused', DEVICE_PORT, true, undefined)!;
    expect(out).not.toContain('build.debugBuild: false');
  });

  it('leaves a GENUINE busy reply alone even when the flag is off', () => {
    // The device answered and named its reason. A flag we can see is off does not make that a lie —
    // and overriding it would reintroduce, in the other direction, the confident-and-wrong report
    // this whole message exists to avoid.
    for (const reason of ['busy', 'no-lease', 'not-owner']) {
      expect(explainConnectFailure(reason, DEVICE_PORT, true, false)).toBe(reason);
    }
  });
});

describe('a FALLBACK port is named, not guessed around (#OikQcN8V5NMH0xUr9UnK)', () => {
  // 9095 is shared by every Modoki game, so when a second one still holds it the app under test
  // takes an OS-assigned port exactly as designed — and says so in the log. Measured on a Galaxy
  // A23 carrying 20 Modoki apps: a backgrounded `com.apiary.court` released 9095 0.3s after the
  // app under test had already fallen back, and the refusal named two causes, both false. The
  // first ("the debug gate is off — reopen and rebuild") is the expensive wrong turn.
  it('leads with the real port and outranks every other cause', () => {
    const out = explainConnectFailure('refused', DEVICE_PORT, true, false, 44975)!;
    expect(out).toContain('44975');
    expect(out).toContain(`port: 44975`);
    // Even with debugBuild:false — the strongest competing suspect — a KNOWN port wins, because it
    // is an observation and the flag is an inference.
    expect(out).not.toMatch(/REBUILD and redeploy/);
  });

  it('says nothing when the sniffed port IS the one already tried', () => {
    // A log line naming 9095 tells you nothing you did not already know; reporting it as a
    // fallback would be a confident non-answer.
    const out = explainConnectFailure('refused', DEVICE_PORT, true, undefined, DEVICE_PORT)!;
    expect(out).toContain('the adb tunnel opened');
  });

  it('still offers the fallback as a THIRD cause when no port could be sniffed', () => {
    // adb may be wedged, or the app may have logged before the ring wrapped. The advice must
    // survive that, and must not leave "rebuild" as the reader's first move.
    const out = explainConnectFailure('refused', DEVICE_PORT, true)!;
    expect(out).toContain('listening on port');
    expect(out).toContain('port:<actual>');
    expect(out).toMatch(/3\./);
  });
});

describe('parseBoundBridgePort', () => {
  it('reads the port the app printed', () => {
    expect(parseBoundBridgePort(
      '08-20 12:37:05.682 19065 19100 I Capacitor/Console: [debug-bridge] Native TCP server listening on port 44975\n',
    )).toBe(44975);
  });

  it('ignores a line naming the default port', () => {
    // `foregrounded — TCP server listening on port 9095` is the HOLDER announcing itself, not the
    // app under test finding a home.
    expect(parseBoundBridgePort('[debug-bridge] foregrounded — TCP server listening on port 9095')).toBeNull();
  });

  it('takes the MOST RECENT bind when the buffer holds several launches', () => {
    expect(parseBoundBridgePort([
      '[debug-bridge] Native TCP server listening on port 40001',
      '[debug-bridge] foregrounded — TCP server listening on port 9095',
      '[debug-bridge] Native TCP server listening on port 44975',
    ].join('\n'))).toBe(44975);
  });

  it('answers null on an unrelated dump rather than inventing a port', () => {
    expect(parseBoundBridgePort('08-20 12:37:04.203  5487  5500 I ActivityManager: Start proc 1234\n')).toBeNull();
  });
});
