/** #1065 — `device_connect` carries `useUsb`/`udid` to the backend and reports the USB lease as such. */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';

let device: DeviceSurface | undefined;
afterEach(() => { device?.restore(); device = undefined; });

const CONNECTED = {
  state: 'connected', guid: 'g',
  target: { host: '127.0.0.1', port: 9097, useAdb: false, useUsb: true, udid: 'UDID-IPAD' },
  lastTarget: { ip: '', useAdb: false, useUsb: true, udid: 'UDID-IPAD' },
};

describe('device_connect over USB to iOS', () => {
  it('relays useUsb and udid, and names the go-ios tunnel in the reply', async () => {
    device = await loadDeviceSurface((req) => (req.path === '/api/device/connect' ? { body: CONNECTED } : undefined));
    const r = await device.call('device_connect', { useUsb: true, udid: 'UDID-IPAD' });
    const sent = device.real().find((q) => q.path === '/api/device/connect');
    expect(sent?.body).toEqual({ useUsb: true, udid: 'UDID-IPAD' });
    expect(device.text(r)).toMatch(/connected via USB \(iOS, go-ios forward to UDID-IPAD\)/);
  });

  it('a refused USB connect is described as a USB attempt, with the iOS options', async () => {
    device = await loadDeviceSurface((req) => (req.path === '/api/device/connect'
      ? { body: { state: 'error', guid: 'g', target: null, lastTarget: null, detail: 'usbmuxd does not see UDID-X' } }
      : undefined));
    const r = await device.call('device_connect', { useUsb: true, udid: 'UDID-X' });
    expect(r.isError).toBe(true);
    expect(device.text(r)).toMatch(/open a device lease over USB \(iOS\)/);
    expect(device.text(r)).toMatch(/useUsb:true/);
  });
});
