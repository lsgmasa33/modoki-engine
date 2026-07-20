import { describe, it, expect } from 'vitest';
import {
  deviceSummary,
  deviceButtonLabel,
  looksLikeIp,
  type DeviceStatus,
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
