/** `device_eval_api` states the eval surface's BOUNDARY, not just its op list (#101).
 *
 *  WHY THIS EXISTS. The tool used to be `return modoki.ops();` and nothing more, so two things were
 *  undiscoverable: the fixed `call`/`ops` helpers, and — the load-bearing one — that input and
 *  screenshot are NOT ops and cannot be called from eval at all. The device surface has no `api()`
 *  escape hatch either (#83), so there is no way to route around it. Worse, `resolve-dom-point` and
 *  `resolve-entity-point` ARE ops: a script can compute exactly where to tap and then be unable to
 *  tap. That was learned by writing a script and watching it fail.
 *
 *  The guard is deliberately two-directional, because the failure mode is text DRIFT rather than a
 *  crash: it must keep naming the helpers that exist AND keep reporting `api`/`composite` as absent.
 *  A reply that advertised `modoki.api()` on device would be worse than the silence it replaced —
 *  an agent would write the call, and the device would answer `Unknown method:`.
 *
 *  The unreachable list is checked against the DEVICE BRIDGE'S OWN router (`bridge.ts`) rather than
 *  a copy of itself, so a method that later becomes a real agent op cannot keep being advertised as
 *  unreachable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';
import { readScannedSource } from '@modoki/engine/testing';

const BRIDGE_SRC = join(__dirname, '../../app/debug/bridge.ts');

let surface: DeviceSurface | null = null;
afterEach(() => { surface?.restore(); surface = null; });

/** The device's op list, as `modoki.ops()` returns it. */
const OPS = [
  { op: 'scene-state', method: 'modoki.sceneState(params)' },
  { op: 'diagnose', method: 'modoki.diagnose(params)' },
];

async function evalApiText(): Promise<string> {
  surface = await loadDeviceSurface((req) =>
    req.path === '/api/device/request' ? deviceReply(OPS) : undefined,
  );
  return surface.text(await surface.call('device_eval_api'));
}

describe('device_eval_api guidance (#101)', () => {
  it('still returns the device build\'s own op list', async () => {
    const text = await evalApiText();
    expect(text).toContain('scene-state');
    expect(text).toContain('modoki.sceneState(params)');
  });

  it('names the fixed helpers the surface really has', async () => {
    const text = await evalApiText();
    expect(text).toContain('modoki.call(op, params)');
    expect(text).toContain('modoki.ops()');
  });

  it('reports api/composite as ABSENT — never as available', async () => {
    const text = await evalApiText();
    // Present as an absence, with a reason.
    expect(text).toContain('modoki.api(path, init)');
    expect(text).toContain('modoki.composite(label, fn)');
    expect(text).toContain('editor-only');
    // The whole reply must not read as an offer. `notReachable`/`absent` are the only framings
    // these two may appear under; a usage line advertising them would be the drift this catches.
    const guidance = JSON.parse(text) as { usage: string[] };
    for (const line of guidance.usage) {
      expect(line).not.toContain('modoki.api(');
      expect(line).not.toContain('modoki.composite(');
    }
  });

  it('states that input and screenshot cannot be reached from eval', async () => {
    const text = await evalApiText();
    const { notReachable } = JSON.parse(text) as { notReachable: { methods: string[]; why: string } };
    for (const m of ['tap', 'drag', 'press-key', 'screenshot']) expect(notReachable.methods).toContain(m);
    expect(notReachable.why).toContain('Unknown method:');
    // Say what to use INSTEAD — a boundary with no exit is just a complaint.
    expect(notReachable.why).toMatch(/device_\*|device_tap/);
  });

  it('every method it calls unreachable really is a bridge switch case, not an agent op', async () => {
    const text = await evalApiText();
    const { notReachable } = JSON.parse(text) as { notReachable: { methods: string[] } };
    // Comments blanked: a `case 'x':` written in prose used to satisfy the loop below.
    const bridge = readScannedSource(BRIDGE_SRC).code;
    // Non-empty FIRST: a for-loop over [] passes without checking anything, so an empty list would
    // make this guard vacuous exactly when the guidance had been gutted. (Caught by mutation-testing
    // this file during close-out — the mutation that emptied the list left this test green.)
    expect(notReachable.methods.length).toBeGreaterThanOrEqual(8);
    for (const m of notReachable.methods) {
      if (m === 'screenshot') {
        // ⚠️ Asserts the INTERCEPT, not the sentence describing it (#816 review). This read the
        // rationale comment at bridge.ts:1125 until the code anchor was found: delete the
        // intercept block and leave the comment, and `screenshot` falls through to
        // `delegateToAgentOps` while device_eval_api keeps advertising it as unreachable.
        expect(bridge, 'screenshot is no longer intercepted in initNativeBridge, so it DOES reach '
          + 'the agent-op router — device_eval_api must stop calling it unreachable')
          .toContain("if (method === 'screenshot')");
        continue;
      }
      // A `case '<m>':` in handleMessage means the router answers it directly — so it never reaches
      // `delegateToAgentOps` and is therefore NOT callable as `modoki.call('<m>')`.
      expect(bridge).toContain(`case '${m}':`);
    }
  });
});
