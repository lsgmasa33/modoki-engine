import { describe, it, expect } from 'vitest';
import {
  deviceSummary,
  deviceButtonLabel,
  looksLikeIp,
  androidRowLabel,
  androidRowNote,
  androidRowSelectable,
  type DeviceStatus,
  type AndroidDeviceRow,
  type DeviceClaim,
} from '../../src/editor/panels/deviceConnectModel';

const mk = (over: Partial<DeviceStatus>): DeviceStatus =>
  ({ state: 'disconnected', guid: 'g', target: null, ...over });

describe('deviceSummary', () => {
  it('is off/disconnected for null or disconnected', () => {
    expect(deviceSummary(null)).toMatchObject({ level: 'off', connected: false });
    expect(deviceSummary(mk({ state: 'disconnected' }))).toMatchObject({ level: 'off', connected: false });
  });

  it('shows the WiFi host when connected over IP', () => {
    const s = deviceSummary(mk({ state: 'connected', target: { host: '192.168.1.42', port: 9095, useAdb: false } }));
    expect(s).toMatchObject({ level: 'ok', connected: true });
    expect(s.message).toContain('192.168.1.42');
  });

  it('shows USB (adb) when connected over adb', () => {
    const s = deviceSummary(mk({ state: 'connected', target: { host: '127.0.0.1', port: 9095, useAdb: true } }));
    expect(s.message).toContain('USB (adb)');
  });

  it('reconnecting stays "connected" (button = Disconnect) but flags the action', () => {
    const s = deviceSummary(mk({ state: 'reconnecting', target: { host: '10.0.0.5', port: 9095, useAdb: false } }));
    expect(s).toMatchObject({ level: 'action', connected: true });
  });

  it('connecting shows an in-progress action, not yet connected (T10)', () => {
    const s = deviceSummary(mk({ state: 'connecting' }));
    expect(s).toMatchObject({ level: 'action', connected: false });
    expect(s.message).toMatch(/connecting/i);
  });

  it('busy points the user at the other editor', () => {
    const s = deviceSummary(mk({ state: 'busy' }));
    expect(s).toMatchObject({ level: 'error', connected: false });
    expect(s.message).toMatch(/another editor|relaunch/i);
  });

  it('error surfaces the backend detail', () => {
    const s = deviceSummary(mk({ state: 'error', detail: 'adb forward failed: no devices' }));
    expect(s.level).toBe('error');
    expect(s.message).toContain('adb forward failed');
  });
});

describe('deviceButtonLabel', () => {
  it('reflects busy / connected / disconnected', () => {
    expect(deviceButtonLabel(null, true)).toBe('Working…');
    expect(deviceButtonLabel(mk({ state: 'connected', target: { host: 'x', port: 9095, useAdb: false } }), false)).toBe('Disconnect');
    expect(deviceButtonLabel(mk({ state: 'reconnecting', target: { host: 'x', port: 9095, useAdb: false } }), false)).toBe('Disconnect');
    expect(deviceButtonLabel(mk({ state: 'disconnected' }), false)).toBe('Connect');
    expect(deviceButtonLabel(mk({ state: 'busy' }), false)).toBe('Connect');
  });
});

describe('looksLikeIp', () => {
  it('accepts valid IPv4 and rejects junk', () => {
    expect(looksLikeIp('192.168.1.42')).toBe(true);
    expect(looksLikeIp(' 10.0.0.1 ')).toBe(true);
    expect(looksLikeIp('256.1.1.1')).toBe(false);
    expect(looksLikeIp('1.2.3')).toBe(false);
    expect(looksLikeIp('hello')).toBe(false);
    expect(looksLikeIp('')).toBe(false);
  });
});

// ── #149 — adb device picker helpers ──────────────────────────────────────────

const mkClaim = (over: Partial<DeviceClaim> = {}): DeviceClaim =>
  ({ deviceId: 'adb:RFDEADBEEF1', clone: 'work-ai', branch: 'work-ai', pid: 8123, at: 0, ...over });

const mkRow = (over: Partial<AndroidDeviceRow> = {}): AndroidDeviceRow =>
  ({ serial: 'RFDEADBEEF1', state: 'device', usable: true, claim: null, ...over });

describe('androidRowLabel', () => {
  it('shows model + serial when adb read a model', () => {
    expect(androidRowLabel(mkRow({ model: 'SC_56C', serial: 'RFDEADBEEF2' }))).toBe('SC_56C — RFDEADBEEF2');
  });

  it('falls back to the serial alone with no model (e.g. unauthorized)', () => {
    expect(androidRowLabel(mkRow({ model: undefined, serial: 'RFDEADBEEF2' }))).toBe('RFDEADBEEF2');
  });
});

describe('androidRowNote', () => {
  it('is null for a free, usable device', () => {
    expect(androidRowNote(mkRow())).toBeNull();
  });

  it('names the holder for a claimed device', () => {
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: 'work-ai2', pid: 555 }) })))
      .toBe('held by work-ai2 (pid 555)');
  });

  it('surfaces the raw adb state for a non-device row (unauthorized/offline)', () => {
    expect(androidRowNote(mkRow({ state: 'unauthorized', usable: false }))).toBe('unauthorized');
    expect(androidRowNote(mkRow({ state: 'offline', usable: false }))).toBe('offline');
  });

  it('a claim takes precedence over an unusable state in the note', () => {
    expect(androidRowNote(mkRow({ state: 'unauthorized', usable: false, claim: mkClaim() })))
      .toBe('held by work-ai (pid 8123)');
  });

  // The common case is that THIS editor holds the device it is connected to. Naming your own clone
  // path back at you reads as a collision that isn't one — and paired with `androidRowSelectable`
  // below, it would refuse to select the very phone you are already using.
  it('says "this editor" rather than naming you, for your OWN claim', () => {
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: '/Users/x/modoki' }) }), '/Users/x/modoki'))
      .toBe('in use by this editor');
  });

  it('still names a SIBLING clone when a thisClone is supplied', () => {
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: '/Users/x/modoki-ai2', pid: 42 }) }), '/Users/x/modoki'))
      .toBe('held by modoki-ai2 (pid 42)');
  });

  // The panel row is a ~250px strip: the absolute path wraps and pushes the device name out of
  // view, and every clone on the machine shares the leading directories anyway.
  it('shortens a clone path to its last segment, on both separators', () => {
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: '/Users/x/Projects/modoki-ai3', pid: 7 }) })))
      .toBe('held by modoki-ai3 (pid 7)');
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: 'C:\\dev\\modoki-win', pid: 7 }) })))
      .toBe('held by modoki-win (pid 7)');
    // A bare name (no separator at all) is left exactly as-is.
    expect(androidRowNote(mkRow({ claim: mkClaim({ clone: 'work-ai', pid: 7 }) })))
      .toBe('held by work-ai (pid 7)');
  });
});

describe('androidRowSelectable', () => {
  it('is selectable when usable and unclaimed', () => {
    expect(androidRowSelectable(mkRow())).toBe(true);
  });

  it('is not selectable when adb reports a non-device state', () => {
    expect(androidRowSelectable(mkRow({ state: 'unauthorized', usable: false }))).toBe(false);
  });

  it('is not selectable when a DIFFERENT clone holds it', () => {
    expect(androidRowSelectable(mkRow({ claim: mkClaim({ clone: 'work-ai2' }) }), 'main')).toBe(false);
  });

  it('is still selectable when THIS clone holds it', () => {
    expect(androidRowSelectable(mkRow({ claim: mkClaim({ clone: 'main' }) }), 'main')).toBe(true);
  });

  it('with no clone name given, any claim blocks selection', () => {
    expect(androidRowSelectable(mkRow({ claim: mkClaim() }))).toBe(false);
  });
});
