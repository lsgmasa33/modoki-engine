/** Golden-vector parity test (code-review T5). Pins the canonical TS DeviceLeaseAuthority to the
 *  shared fixture that the Swift + Kotlin native ports also replay, so a native divergence (or a TS
 *  regression) is caught against ONE contract. The fixture lives with the native plugin so both
 *  sides reference the same file. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';

interface Step {
  op: 'connect' | 'ping' | 'disconnect' | 'socketDropped' | 'status';
  guid?: string;
  now: number;
  expect?: { ok?: boolean; reason?: string; resumed?: boolean; leased?: boolean; live?: boolean };
}
interface Fixture { graceMs: number; steps: Step[] }

const FIXTURE_PATH = path.join(
  __dirname, '../../packages/capacitor-game-debug/test-vectors/lease-golden-vectors.json',
);

describe('device lease golden vectors (TS ⇄ native parity contract)', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

  it('the fixture is well-formed (every op has a valid shape)', () => {
    expect(fixture.graceMs).toBeGreaterThan(0);
    expect(fixture.steps.length).toBeGreaterThan(0);
    for (const s of fixture.steps) {
      expect(['connect', 'ping', 'disconnect', 'socketDropped', 'status']).toContain(s.op);
      if (s.op === 'connect' || s.op === 'ping' || s.op === 'disconnect') {
        expect(typeof s.guid).toBe('string');
        expect(s.expect?.ok).toBeTypeOf('boolean');
      }
    }
  });

  it('DeviceLeaseAuthority replays the fixture exactly', () => {
    const a = new DeviceLeaseAuthority(fixture.graceMs);
    fixture.steps.forEach((s, i) => {
      const where = `step ${i} (${s.op}${s.guid ? ' ' + s.guid : ''} @${s.now})`;
      switch (s.op) {
        case 'connect':
          expect(a.connect(s.guid!, s.now), where).toEqual(cleanReply(s.expect!));
          break;
        case 'ping':
          expect(a.ping(s.guid!, s.now), where).toEqual(cleanReply(s.expect!));
          break;
        case 'disconnect':
          expect(a.disconnect(s.guid!, s.now), where).toEqual(cleanReply(s.expect!));
          break;
        case 'socketDropped':
          a.socketDropped(s.now);
          break;
        case 'status': {
          const st = a.status(s.now);
          expect({ leased: st.leased, live: st.live }, where).toEqual({ leased: s.expect!.leased, live: s.expect!.live });
          break;
        }
      }
    });
  });
});

/** Drop undefined keys so `toEqual` matches the authority's exact reply shape (it omits reason/resumed). */
function cleanReply(e: { ok?: boolean; reason?: string; resumed?: boolean }): Record<string, unknown> {
  const r: Record<string, unknown> = { ok: e.ok };
  if (e.reason !== undefined) r.reason = e.reason;
  if (e.resumed !== undefined) r.resumed = e.resumed;
  return r;
}
