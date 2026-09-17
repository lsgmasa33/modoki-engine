/** Unit tests for the device-MCP reply helpers (code-review T6). These were previously untested —
 *  parseReply's JSON-string fallback, the device 'Error:' convention, and the screenshot decode. */

import { describe, it, expect } from 'vitest';
import { parseReply, isDeviceError, decodeScreenshotReply, describeLease, decodeDeviceListReply, describeClaim } from '../../tools/game-debug-mcp/src/reply';

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

describe('describeLease — iOS over USB (#1065)', () => {
  it('names the go-ios tunnel and its device, not WiFi 127.0.0.1', () => {
    const text = describeLease({ state: 'connected', target: { host: '127.0.0.1', port: 9097, useAdb: false, useUsb: true, udid: 'UDID-IPAD' }, lastTarget: null });
    expect(text).toBe('Device connected via USB (iOS, go-ios forward to UDID-IPAD) — host tunnel 127.0.0.1:9097. device_* tools proxy through Modoki\'s lease.');
    expect(text).not.toMatch(/WiFi/);
  });

  it('a disconnected lease says its last target was USB, and offers useUsb', () => {
    const text = describeLease({ state: 'disconnected', target: null, lastTarget: { ip: '10.0.0.7', useAdb: false, useUsb: true } });
    expect(text).toMatch(/\(last: USB \(iOS\)\)/);
    expect(text).toMatch(/useUsb:true for iOS over USB/);
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

  it('labels the adb port as the HOST tunnel, not the device port (#158)', () => {
    // The two were the same number until #158 derived the host end per clone, and the old string
    // ("adb (USB):9097") read as if 9097 were the app's port. `device_connect {port}` means the
    // DEVICE port, so an agent round-tripping the displayed number would forward
    // `tcp:9097 → tcp:9097` on the phone — nothing listening, and `explainConnectFailure` silent
    // because it only fires on 9095. This asserts the number is never shown unlabelled.
    const t = describeLease({ state: 'connected', target: { host: '127.0.0.1', port: 9097, useAdb: true }, lastTarget: null });
    expect(t).toMatch(/host tunnel 127\.0\.0\.1:9097/);
    expect(t).not.toMatch(/adb \(USB\):9097/);
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

describe('decodeDeviceListReply (#1211 C-21)', () => {
  const base = { adb: { present: true }, android: [], ios: [], otherClaims: [] };
  it('accepts a reply with no self — a backend older than the field', () => {
    const d = decodeDeviceListReply(base);
    expect(d.ok && d.reply.self).toBe(undefined);
  });
  it('keeps a well-formed self', () => {
    const d = decodeDeviceListReply({ ...base, self: { clone: '/r', pid: 1 } });
    expect(d.ok && d.reply.self).toEqual({ clone: '/r', pid: 1 });
  });
  it('refuses each missing required key, describing the shape by keys only', () => {
    for (const k of ['adb', 'android', 'ios', 'otherClaims'] as const) {
      const { [k]: _drop, ...rest } = base;
      const d = decodeDeviceListReply(rest);
      expect(d.ok, `missing ${k} was accepted`).toBe(false);
    }
  });
  it('refuses a row the renderer would dereference blind', () => {
    expect(decodeDeviceListReply({ ...base, android: [{ state: 'device' }] }).ok).toBe(false);
    expect(decodeDeviceListReply({ ...base, ios: [{ name: 'x' }] }).ok).toBe(false);
  });
  it('ONE corrupt claim record does not refuse the whole listing', () => {
    const d = decodeDeviceListReply({ ...base, android: [{ serial: 's', claim: { pid: 1 } }] });
    expect(d.ok).toBe(true);
  });
});

describe('describeClaim (#1211 C-21)', () => {
  const c = { deviceId: 'adb:s', clone: '/r/qa', branch: 'work-qa', pid: 5, at: 0 };
  it('same clone, same pid → this editor', () => {
    expect(describeClaim(c, { clone: '/r/qa/', pid: 5 })).toBe(' — held by THIS editor (your lease)');
  });
  it('same clone, other pid → this clone, another process', () => {
    expect(describeClaim(c, { clone: '/r/qa', pid: 6 })).toBe(' — held by this clone, another process (pid 5)');
  });
  it('a CLI claim from this clone names its owner, not "pid 0"', () => {
    expect(describeClaim({ ...c, pid: 0, owner: 'build-1234' }, { clone: '/r/qa', pid: 5 }))
      .toBe(" — held by this clone's CLI (owner build-1234)");
  });
  it('a claim record with no clone is reported as unreadable', () => {
    expect(describeClaim({ ...c, clone: undefined as unknown as string }, { clone: '/r/qa', pid: 5 })).toMatch(/unreadable claim record/);
  });
  it('other clone, or no self → CLAIMED', () => {
    expect(describeClaim(c, { clone: '/r/ai', pid: 5 })).toBe(' — CLAIMED by /r/qa (work-qa)');
    expect(describeClaim(c, undefined)).toBe(' — CLAIMED by /r/qa (work-qa)');
  });
});
