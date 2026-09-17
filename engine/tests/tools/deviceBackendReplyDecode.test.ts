/** #1313 — the device MCP DECODES every editor-backend reply instead of casting it (§9-bis).
 *
 *  The editor backend versions independently of this MCP process, so a reply can arrive in a shape
 *  this build does not know — and a host that falls through to the SPA answers 200 with HTML.
 *  A cast turned both into a confident wrong answer: `deviceRequest` handed `undefined` to all the
 *  relay tools (a successful empty answer), a status missing `useAdb` read as "not adb". Each case
 *  below must now be "could not read", never an answer.
 *
 *  ⚠️ Assert on the ENVELOPE's code, not a regex over the text (see deviceRefusalCodeRelay.test.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';
import { decodeLeaseStatus, decodeDeviceRequestReply, decodeIdentity, decodeToolchain } from '../../tools/game-debug-mcp/src/reply';

let s: DeviceSurface | undefined;
afterEach(() => { s?.restore(); s = undefined; });

const envelope = (text: string) => JSON.parse(text.slice(text.indexOf('{'))) as { error: { code: string; why: string } };
const HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

describe('decodeLeaseStatus', () => {
  const target = { host: '10.0.0.5', port: 8095, useAdb: false };
  it('accepts a connected lease, and a disconnected one with the target null or absent', () => {
    expect(decodeLeaseStatus({ state: 'connected', target, lastTarget: null }).ok).toBe(true);
    expect(decodeLeaseStatus({ state: 'disconnected', target: null, lastTarget: { ip: '1.2.3.4', useAdb: false } }).ok).toBe(true);
    const bare = decodeLeaseStatus({ state: 'idle' });
    expect(bare.ok && bare.value.target).toBe(null);
  });
  it('accepts a JSON-string reply and the optional serial/udid', () => {
    const d = decodeLeaseStatus(JSON.stringify({ state: 'connected', target: { ...target, useAdb: true, serial: 'R5C' }, lastTarget: null }));
    expect(d.ok && d.value.target?.serial).toBe('R5C');
  });
  it('refuses every shape a misread would turn into a wrong answer', () => {
    const bad: unknown[] = [
      {}, 'nope', [], null,
      { state: 1, target },
      { state: 'connected', target: null },                                   // read as "no lease"
      { state: 'connected' },
      { state: 'connected', target: { host: 'h', port: 1 } },                 // read as "not adb"
      { state: 'connected', target: { ...target, port: '8095' } },
      { state: 'connected', target: { ...target, serial: 5 } },
      { state: 'connected', target: { ...target, udid: 5 } },
      { state: 'connected', target: 'h:1' },
      { state: 'disconnected', target: null, lastTarget: 'x' },
    ];
    for (const b of bad) expect(decodeLeaseStatus(b).ok, JSON.stringify(b)).toBe(false);
  });
});

describe('decodeDeviceRequestReply', () => {
  it('accepts any object carrying a result KEY, and keeps the sibling fields', () => {
    const d = decodeDeviceRequestReply({ result: null, unverified: 'maybe another phone' });
    expect(d.ok && d.value).toEqual({ result: null, unverified: 'maybe another phone' });
    expect(decodeDeviceRequestReply({ result: 'Error: x' }).ok).toBe(true);
  });
  it('refuses an envelope without result', () => {
    for (const b of [{}, { ok: true }, { results: 1 }, 'x', [], null]) expect(decodeDeviceRequestReply(b).ok, JSON.stringify(b)).toBe(false);
  });
});

describe('decodeIdentity / decodeToolchain', () => {
  it('identity needs a string repoRoot', () => {
    expect(decodeIdentity({ repoRoot: '/r', backendPort: 1 }).ok).toBe(true);
    for (const b of [{}, { repoRoot: 1 }, 'x', null]) expect(decodeIdentity(b).ok).toBe(false);
  });
  it('toolchain needs a boolean adb.present — its absence used to read as "adb not installed"', () => {
    const d = decodeToolchain({ adb: { present: true, path: '/sdk/adb' }, java: {} });
    expect(d.ok && d.value).toEqual({ adb: { present: true, path: '/sdk/adb' } });
    const nullPath = decodeToolchain({ adb: { present: false, path: null } });
    expect(nullPath.ok && nullPath.value).toEqual({ adb: { present: false } });
    for (const b of [{}, { adb: {} }, { adb: { present: 'yes' } }, { adb: { present: true, path: 3 } }, null]) {
      expect(decodeToolchain(b).ok, JSON.stringify(b)).toBe(false);
    }
  });
});

describe('the device tools report an unreadable reply as NOT_AVAILABLE_HERE, never as an answer', () => {
  it('a relay tool whose /api/device/request envelope has no result', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? { body: { ok: true } } : undefined));
    const r = await s.call('device_get_scene_state');
    expect(r.isError).toBe(true);
    const e = envelope(s.text(r)).error;
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.why).toContain('/api/device/request');
    // The shape branch's own wording — the generic transport fallback is ALSO NOT_AVAILABLE_HERE.
    expect(e.why).toContain('NOT an empty answer');
    // A POST that answered JSON RAN — the refusal must not read as "safe to retry".
    expect(e.why).toContain('may already have applied');
  });

  it('a relay tool answered 200 with an HTML page (a host that does not serve the route)', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? { raw: HTML } : undefined));
    const r = await s.call('device_journal');
    expect(r.isError).toBe(true);
    const e = envelope(s.text(r)).error;
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.why).toContain('not JSON');
    // No route answered, so nothing ran — no "may have applied" caveat.
    expect(e.why).not.toContain('may already have applied');
  });

  it('a non-2xx with a non-JSON body is still classified by its status, not as a shape failure', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? { status: 409, raw: 'busy' } : undefined));
    const r = await s.call('device_journal');
    expect(r.isError).toBe(true);
    const e = envelope(s.text(r)).error;
    expect(e.why).toContain('HTTP 409');
    expect(e.why).not.toContain('cannot read');
  });

  it('the control check: the same relay tool with a well-formed envelope succeeds', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply({ ok: true, total: 0, events: [] }) : undefined));
    const r = await s.call('device_journal');
    expect(r.isError, s.text(r)).toBeFalsy();
  });

  it('device_status with a connected lease that lacks useAdb', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/status'
      ? { body: { state: 'connected', target: { host: '10.0.0.5', port: 8095 }, lastTarget: null } } : undefined));
    const r = await s.call('device_status');
    expect(r.isError).toBe(true);
    const e = envelope(s.text(r)).error;
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    // A GET changes nothing.
    expect(e.why).not.toContain('may already have applied');
  });

  it('device_disconnect with a reply that is not a lease status', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/disconnect' ? { body: { ok: true } } : undefined));
    const r = await s.call('device_disconnect');
    expect(r.isError).toBe(true);
    expect(envelope(s.text(r)).error.code).toBe('NOT_AVAILABLE_HERE');
  });

  it('device_list answered with an HTML page is not "no devices attached"', async () => {
    s = await loadDeviceSurface((q) => (q.path === '/api/device/list' ? { raw: HTML } : undefined));
    const r = await s.call('device_list');
    expect(r.isError).toBe(true);
    expect(envelope(s.text(r)).error.code).toBe('NOT_AVAILABLE_HERE');
    expect(s.text(r)).not.toMatch(/no (android|ios|devices)/i);
  });
});
