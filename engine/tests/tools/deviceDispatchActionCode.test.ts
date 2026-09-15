/** `device_dispatch_action` reports the op's OWN §5 code when it names one (#1223).
 *
 *  The op refuses a stale `targetGuid` as `{ok:false, dispatched:false, code:'NOT_FOUND', stale}` (it
 *  resolves through the shared entity resolver). The device tool used to hard-code `REFUSED_BY_OP` for
 *  every `dispatched:false`, so the code the op knew never reached the envelope. */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

let s: DeviceSurface | undefined;
const codeOf = (text: string) => (JSON.parse(text.slice(text.indexOf('{'))) as { error: { code: string } }).error.code;
afterEach(() => { s?.restore(); s = undefined; });

describe('device_dispatch_action — the op names the code', () => {
  // Mutation: restore the hard-coded `code: 'REFUSED_BY_OP'` in the dispatch_action failure branch.
  it('a stale targetGuid comes back NOT_FOUND, not the generic REFUSED_BY_OP', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, dispatched: false, code: 'NOT_FOUND', stale: 'despawned', reason: "targetGuid 'g' matched no entity in the live world" })
      : undefined);
    const r = await s.call('device_dispatch_action', { name: 'engine.playClip', targetGuid: 'g' });
    expect(r.isError).toBe(true);
    // The ENVELOPE's code — not a regex over the text, which also holds the op body echoed in `got`
    // (carrying the same "code":"NOT_FOUND") and so passed with the hard-coded REFUSED_BY_OP restored.
    expect(codeOf(s.text(r))).toBe('NOT_FOUND');
  });

  // Accept side: an op that names no code keeps the generic refusal.
  it('a refusal with no code stays REFUSED_BY_OP', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, dispatched: false, reason: 'not playing — press Play first' })
      : undefined);
    const r = await s.call('device_dispatch_action', { name: 'engine.playClip' });
    expect(codeOf(s.text(r))).toBe('REFUSED_BY_OP');
  });
});
