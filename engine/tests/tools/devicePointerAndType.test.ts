/** `device_pointer` / `device_type_text` (#31) — driven through the REAL handlers against a
 *  stub backend (`deviceSurface.ts`), the same harness the rest of the device tool suite uses.
 *  This covers what's testable at the MCP-tool layer: schema validation, aim/scale refusals
 *  BEFORE anything is sent, the request shape relayed to `/api/device/request`, and how a
 *  device-side reply (including the held-pointer refusal strings) is surfaced. The refusal logic
 *  itself is device-side (`app/debug/bridge.ts`) and is unit-tested directly in
 *  `engine/tests/framework/bridgePointerAndType.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

let s: DeviceSurface | undefined;
afterEach(() => { s?.restore(); s = undefined; });

function relayed(surface: DeviceSurface): { method?: string; params?: Record<string, unknown> } {
  const req = surface.real().find((r) => r.path === '/api/device/request');
  return (req?.body ?? {}) as { method?: string; params?: Record<string, unknown> };
}

describe('device_pointer', () => {
  it('relays action:down + selector as the "pointer" op', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request' ? deviceReply('ok (down window+pixi, button left, held:true) @ #play') : undefined);
    await s.call('device_pointer', { action: 'down', selector: '#play' });
    expect(relayed(s).method).toBe('pointer');
    expect(relayed(s).params).toMatchObject({ action: 'down', selector: '#play' });
  });

  it('a down passes `button` through; move/up do NOT need one (the device reuses the held button)', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request' ? deviceReply('ok') : undefined);
    await s.call('device_pointer', { action: 'down', selector: '#a', button: 'right' });
    expect(relayed(s).params).toMatchObject({ button: 'right' });
  });

  it('refuses with no usable aim BEFORE sending anything', async () => {
    s = await loadDeviceSurface();
    const r = await s.call('device_pointer', { action: 'move', x: 5 }); // y missing, no selector
    expect(r.isError).toBe(true);
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(false);
  });

  it('a COORDINATE aim on an adb lease with no measured scale is refused, nothing sent', async () => {
    s = await loadDeviceSurface((req) =>
      req.path === '/api/device/status'
        ? { body: { state: 'connected', target: { host: 'localhost', port: 8095, useAdb: true }, lastTarget: null } }
        : undefined);
    const r = await s.call('device_pointer', { action: 'down', x: 10, y: 20 });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/no screenshot scale/);
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(false);
  });

  it('a selector aim on the same adb lease is unaffected (no scale needed)', async () => {
    s = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') return { body: { state: 'connected', target: { host: 'localhost', port: 8095, useAdb: true }, lastTarget: null } };
      if (req.path === '/api/device/request') return deviceReply('ok');
      return undefined;
    });
    const r = await s.call('device_pointer', { action: 'down', selector: '#play' });
    expect(r.isError).toBeFalsy();
  });

  it('a device "already held" refusal surfaces as a failed tool call, not a phantom success', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply("Error: a pointer is already held (button left down at 10.0,20.0). Release it with action:'up' before pressing again.")
      : undefined);
    const r = await s.call('device_pointer', { action: 'down', selector: '#play' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/already held/);
  });

  it('a device "no pointer held" refusal (move/up with nothing down) surfaces the same way', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply("Error: no pointer is held — send action:'down' first (this move would be a stray event).")
      : undefined);
    const r = await s.call('device_pointer', { action: 'move', selector: '#play' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/no pointer is held/);
  });

  it('every strict schema rejects an unknown key', async () => {
    s = await loadDeviceSurface();
    const v = s.validate('device_pointer', { action: 'down', selector: '#play', bogus: 1 });
    expect(v.ok).toBe(false);
  });

  it('rejects an invalid action before sending anything', async () => {
    s = await loadDeviceSurface();
    const v = s.validate('device_pointer', { action: 'sideways', selector: '#play' });
    expect(v.ok).toBe(false);
  });
});

describe('device_type_text', () => {
  it('relays text/clearFirst/submitKey as the "type-text" op', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: true, typed: 5, activeElement: 'input', valueAfter: 'hello' })
      : undefined);
    await s.call('device_type_text', { text: 'hello', clearFirst: true, submitKey: 'Enter' });
    expect(relayed(s).method).toBe('type-text');
    expect(relayed(s).params).toMatchObject({ text: 'hello', clearFirst: true, submitKey: 'Enter' });
  });

  it('omits clearFirst/submitKey from the payload when not given', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: true, typed: 2, activeElement: 'input' })
      : undefined);
    await s.call('device_type_text', { text: 'hi' });
    const p = relayed(s).params ?? {};
    expect(p).not.toHaveProperty('clearFirst');
    expect(p).not.toHaveProperty('submitKey');
  });

  it('a device {ok:false} reply (nothing focused / not typable) is a FAILED tool call', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, typed: 0, activeElement: null, error: 'no element is focused, so nothing was typed — device_tap the target input first, then type.' })
      : undefined);
    const r = await s.call('device_type_text', { text: 'hi' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/no element is focused/);
  });

  it('a device Error: string reply (transport-level device refusal) is REFUSED_BY_OP', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request' ? deviceReply('Error: something broke') : undefined);
    const r = await s.call('device_type_text', { text: 'hi' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/something broke/);
  });

  it('a successful reply is not an error and echoes the measured `typed` count', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: true, typed: 3, activeElement: 'input', valueAfter: 'abc' })
      : undefined);
    const r = await s.call('device_type_text', { text: 'abc' });
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).toMatch(/"typed":3/);
  });

  it('requires `text` — an unknown key is refused by the strict schema', async () => {
    s = await loadDeviceSurface();
    expect(s.validate('device_type_text', { text: 'hi', bogus: 1 }).ok).toBe(false);
    expect(s.validate('device_type_text', {}).ok).toBe(false); // text is required
  });
});
