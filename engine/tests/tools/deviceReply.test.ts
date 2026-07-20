/** Unit tests for the device-MCP reply helpers (code-review T6). These were previously untested —
 *  parseReply's JSON-string fallback, the device 'Error:' convention, and the screenshot decode. */

import { describe, it, expect } from 'vitest';
import { parseReply, isDeviceError, decodeScreenshotReply, describeLease } from '../../tools/game-debug-mcp/src/reply';

describe('parseReply', () => {
  it('passes an object through unchanged', () => {
    expect(parseReply<{ a: number }>({ a: 1 })).toEqual({ a: 1 });
  });
  it('parses a JSON string (the device safeStringify convention)', () => {
    expect(parseReply<string[]>('["x","y"]')).toEqual(['x', 'y']);
  });
  it('returns a non-JSON string verbatim (no throw)', () => {
    expect(parseReply<string>('not json')).toBe('not json');
  });
});

describe('isDeviceError', () => {
  it('flags the device Error: convention', () => {
    expect(isDeviceError('Error: nope is not defined')).toBe(true);
    expect(isDeviceError('Unknown method: frobnicate')).toBe(true);
  });
  it('does not flag ordinary results', () => {
    expect(isDeviceError('ok (pixi) css(10,20)')).toBe(false);
    expect(isDeviceError({ ok: true })).toBe(false);
    expect(isDeviceError(undefined)).toBe(false);
    expect(isDeviceError('the Error: was mid-string')).toBe(false); // must be a prefix
  });
});

describe('decodeScreenshotReply', () => {
  it('decodes a bare data: URL', () => {
    const r = decodeScreenshotReply('data:image/jpeg;base64,AAAA');
    expect(r).toEqual({ dataUrl: 'data:image/jpeg;base64,AAAA', info: expect.stringContaining('lease') });
  });
  it('decodes the {image, dims} object shape (as a safeStringify string)', () => {
    const raw = JSON.stringify({ image: 'data:image/png;base64,BBBB', imageWidth: 1800, imageHeight: 3900, screenWidth: 1260, screenHeight: 2730 });
    const r = decodeScreenshotReply(raw);
    expect(r).toEqual({ dataUrl: 'data:image/png;base64,BBBB', info: '1800x3900 (from 1260x2730).' });
  });
  it('surfaces a device Error: string as an error', () => {
    expect(decodeScreenshotReply('Error: No canvas element found')).toEqual({ error: 'Error: No canvas element found' });
  });
  it('surfaces a missing image as an error', () => {
    expect(decodeScreenshotReply(JSON.stringify({ imageWidth: 10 }))).toEqual({ error: 'No image data' });
  });
});

describe('describeLease (device_status / device_connect / device_disconnect share it)', () => {
  it('reports a WiFi connection with host + port', () => {
    const t = describeLease({ state: 'connected', target: { host: '192.168.1.5', port: 9095, useAdb: false }, lastTarget: null });
    expect(t).toMatch(/connected via WiFi 192\.168\.1\.5:9095/);
  });
  it('reports an adb (USB) connection', () => {
    const t = describeLease({ state: 'connected', target: { host: '127.0.0.1', port: 9095, useAdb: true }, lastTarget: null });
    expect(t).toMatch(/connected via adb \(USB\)/);
  });
  it('on disconnected, points at device_connect and echoes the last target', () => {
    const t = describeLease({ state: 'disconnected', target: null, lastTarget: { ip: '192.168.1.5', useAdb: false } });
    expect(t).toMatch(/No device connected/);
    expect(t).toMatch(/device_connect/);
    expect(t).toMatch(/last: 192\.168\.1\.5/);
  });
  it('a transient state is reported as in-progress', () => {
    expect(describeLease({ state: 'connecting', target: null, lastTarget: null })).toMatch(/lease is connecting/);
  });
});
