/**
 * androidDevices tests (#149) — the Android sibling of `wdaLauncher.test.ts`'s `resolveIosDevice`
 * coverage. PURE parse + PURE precedence rule, no hardware, no `child_process` mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAdbDevices, resolveAndroidSerial, adbArgs, describeAndroidDevice, isUsable,
  friendlyName, withFriendlyNames, _clearFriendlyNameCache, androidDevicesExec,
  type AndroidDevice,
} from '../../plugins/backend/androidDevices';

describe('parseAdbDevices', () => {
  it('parses the `-l` long format, pulling model: and transport_id: out of the trailing key-values', () => {
    const out = [
      'List of devices attached',
      'ASJ6R19826001453   device usb:2-1.4.3 model:MRD_LX3 device:HWMRD transport_id:3',
    ].join('\n');
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'ASJ6R19826001453', state: 'device', model: 'MRD_LX3', transportId: '3' },
    ]);
  });

  it('drops the `List of devices attached` header', () => {
    expect(parseAdbDevices('List of devices attached\n')).toEqual([]);
  });

  it('drops the cold-daemon `*` lines rather than reading them as a device whose serial is `*`', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'RFDEADBEEF1   device',
    ].join('\n');
    expect(parseAdbDevices(out)).toEqual([{ serial: 'RFDEADBEEF1', state: 'device' }]);
  });

  it('keeps unauthorized and offline devices, with their raw state (no model on an unauthorized phone)', () => {
    const out = [
      'List of devices attached',
      'RFDEADBEEF2        unauthorized usb:2-1.1',
      'ABCDEF123          offline',
    ].join('\n');
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'RFDEADBEEF2', state: 'unauthorized' },
      { serial: 'ABCDEF123', state: 'offline' },
    ]);
  });

  it('parses an emulator serial like any other device', () => {
    const out = [
      'List of devices attached',
      'emulator-5554      device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64',
    ].join('\n');
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_arm64' },
    ]);
  });

  it('skips blank and whitespace-only lines', () => {
    const out = '\n   \nList of devices attached\n\nRFDEADBEEF1   device\n\n   \n';
    expect(parseAdbDevices(out)).toEqual([{ serial: 'RFDEADBEEF1', state: 'device' }]);
  });

  it('skips garbage lines that carry no state token', () => {
    expect(parseAdbDevices('List of devices attached\nsomejunk\n')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseAdbDevices('')).toEqual([]);
  });
});

describe('isUsable / describeAndroidDevice', () => {
  it('only `device` is usable — unauthorized/offline/anything else is not', () => {
    expect(isUsable({ serial: 'A', state: 'device' })).toBe(true);
    expect(isUsable({ serial: 'A', state: 'unauthorized' })).toBe(false);
    expect(isUsable({ serial: 'A', state: 'offline' })).toBe(false);
    expect(isUsable({ serial: 'A', state: 'bootloader' })).toBe(false);
  });

  it('describes a usable device by serial + model, with no state suffix', () => {
    expect(describeAndroidDevice({ serial: 'RFDEADBEEF1', state: 'device', model: 'SC_56C' }))
      .toBe('RFDEADBEEF1 (SC_56C)');
  });

  it('describes an unusable device with its state, since that IS the fix', () => {
    expect(describeAndroidDevice({ serial: 'RFDEADBEEF2', state: 'unauthorized' }))
      .toBe('RFDEADBEEF2 (unauthorized)');
  });

  it('describes a bare device with neither model nor a usability suffix as just the serial', () => {
    expect(describeAndroidDevice({ serial: 'RFDEADBEEF1', state: 'device' })).toBe('RFDEADBEEF1');
  });
});

describe('adbArgs', () => {
  it('prefixes -s <serial> when a serial is known', () => {
    expect(adbArgs('RFDEADBEEF1', ['shell', 'echo', 'hi'])).toEqual(['-s', 'RFDEADBEEF1', 'shell', 'echo', 'hi']);
  });

  it('is the identity when serial is undefined', () => {
    expect(adbArgs(undefined, ['devices', '-l'])).toEqual(['devices', '-l']);
  });
});

describe('resolveAndroidSerial — precedence order (mirrors resolveIosDevice)', () => {
  const A: AndroidDevice = { serial: 'AAA', state: 'device', model: 'Air' };
  const B: AndroidDevice = { serial: 'BBB', state: 'device', model: 'Mini' };

  it('1. explicit wins over everything, including env pins', () => {
    expect(resolveAndroidSerial([A, B], { explicit: 'BBB', env: { MODOKI_ANDROID_SERIAL: 'AAA' } }))
      .toEqual({ serial: 'BBB' });
  });

  it('an explicit serial matching nothing attached is an ERROR naming the attached candidates', () => {
    const r = resolveAndroidSerial([A, B], { explicit: 'ZZZ', env: {} });
    expect(r).toHaveProperty('error');
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/ZZZ/);
    expect(msg).toMatch(/AAA/);
    expect(msg).toMatch(/BBB/);
  });

  it('2. MODOKI_ANDROID_SERIAL is honoured when there is no explicit pin', () => {
    expect(resolveAndroidSerial([A, B], { env: { MODOKI_ANDROID_SERIAL: 'BBB' } })).toEqual({ serial: 'BBB' });
  });

  it('falls back to adb\'s own ANDROID_SERIAL when MODOKI_ANDROID_SERIAL is unset', () => {
    expect(resolveAndroidSerial([A, B], { env: { ANDROID_SERIAL: 'AAA' } })).toEqual({ serial: 'AAA' });
  });

  it('MODOKI_ANDROID_SERIAL wins over ANDROID_SERIAL when both are set', () => {
    expect(resolveAndroidSerial([A, B], { env: { MODOKI_ANDROID_SERIAL: 'BBB', ANDROID_SERIAL: 'AAA' } }))
      .toEqual({ serial: 'BBB' });
  });

  it('an env pin matching nothing attached is also an ERROR', () => {
    const r = resolveAndroidSerial([A], { env: { MODOKI_ANDROID_SERIAL: 'ZZZ' } });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/environment pin/);
  });

  it('3. a single usable device with no pin is chosen with no configuration at all', () => {
    expect(resolveAndroidSerial([A], { env: {} })).toEqual({ serial: 'AAA' });
  });

  it('4. two usable devices with no pin REFUSES, naming BOTH serials', () => {
    const r = resolveAndroidSerial([A, B], { env: {} });
    expect(r).toHaveProperty('error');
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/AAA/);
    expect(msg).toMatch(/BBB/);
  });

  it('zero devices attached at all', () => {
    const r = resolveAndroidSerial([], { env: {} });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/no Android device is attached/);
  });

  it('devices attached but all unusable — the message carries the on-phone fix', () => {
    const unauthorized: AndroidDevice = { serial: 'AAA', state: 'unauthorized' };
    const offline: AndroidDevice = { serial: 'BBB', state: 'offline' };
    const r = resolveAndroidSerial([unauthorized, offline], { env: {} });
    expect(r).toHaveProperty('error');
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/UNAUTHORIZED/);
    expect(msg).toMatch(/Allow USB debugging/);
    expect(msg).toMatch(/OFFLINE/);
    expect(msg).toMatch(/adb kill-server/);
  });

  it('a pin matching an attached-but-unusable device reports the fix, not "matches none"', () => {
    const unauthorized: AndroidDevice = { serial: 'AAA', state: 'unauthorized' };
    const r = resolveAndroidSerial([unauthorized], { explicit: 'AAA', env: {} });
    expect(r).toHaveProperty('error');
    const msg = (r as { error: string }).error;
    expect(msg).toMatch(/UNAUTHORIZED/);
    expect(msg).not.toMatch(/matches none/);
  });
});

describe('friendlyName / withFriendlyNames / describeAndroidDevice — #149 friendly device names', () => {
  const realDeviceName = androidDevicesExec.deviceName;
  const realList = androidDevicesExec.list;

  beforeEach(() => {
    androidDevicesExec.deviceName = () => '';
    androidDevicesExec.list = () => 'List of devices attached\n';
    _clearFriendlyNameCache();
  });
  afterEach(() => {
    androidDevicesExec.deviceName = realDeviceName;
    androidDevicesExec.list = realList;
    _clearFriendlyNameCache();
  });

  it('takes the first real candidate (Samsung SC-56C: device_name answers, marketing props are empty)', () => {
    androidDevicesExec.deviceName = () => 'Galaxy A23 5G\nnull\n\n\n';
    expect(friendlyName('SERIAL1', 'SC_56C')).toBe('Galaxy A23 5G');
  });

  it('an owner-renamed device_name is still the right label, even though it is not the marketing name', () => {
    androidDevicesExec.deviceName = () => 'Masaki Android\nnull\n\n\n';
    expect(friendlyName('SERIAL2', 'SM_S901U1')).toBe('Masaki Android');
  });

  it('skips a candidate equal to the model code — including -/_/case normalisation — and falls through', () => {
    // Huawei MRD-LX3: device_name answers with the model code itself (hyphenated, adb reports it
    // with an underscore), so it must be skipped in favour of bluetooth_name.
    androidDevicesExec.deviceName = () => 'MRD-LX3\nHUAWEI Y6 2019\n\n\n';
    expect(friendlyName('SERIAL3', 'MRD_LX3')).toBe('HUAWEI Y6 2019');
  });

  it('the literal `null` settings prints for an unset key is not a name', () => {
    androidDevicesExec.deviceName = () => 'null\nnull\n\n\n';
    expect(friendlyName('SERIAL4', 'SC_56C')).toBeUndefined();
  });

  it('returns undefined when every candidate is model-equivalent or the output is empty', () => {
    androidDevicesExec.deviceName = () => 'sdk_gphone64_arm64\n\n\n\n';
    expect(friendlyName('SERIAL5', 'sdk_gphone64_arm64')).toBeUndefined();
  });

  it('a throwing deviceName seam (adb gone, unauthorized device) returns undefined rather than propagating', () => {
    androidDevicesExec.deviceName = () => { throw new Error('device unauthorized'); };
    expect(() => friendlyName('SERIAL6')).not.toThrow();
    expect(friendlyName('SERIAL6')).toBeUndefined();
  });

  describe('caching (load-bearing — the AI panel polls every 2.5s)', () => {
    it('a second call for the same serial does not invoke the seam again', () => {
      const spy = vi.fn(() => 'Galaxy A23 5G\nnull\n\n\n');
      androidDevicesExec.deviceName = spy;
      expect(friendlyName('SERIAL7', 'SC_56C')).toBe('Galaxy A23 5G');
      expect(friendlyName('SERIAL7', 'SC_56C')).toBe('Galaxy A23 5G');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a device that answered NOTHING is also negative-cached — still no second call', () => {
      const spy = vi.fn(() => 'null\nnull\n\n\n');
      androidDevicesExec.deviceName = spy;
      expect(friendlyName('SERIAL8')).toBeUndefined();
      expect(friendlyName('SERIAL8')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('_clearFriendlyNameCache re-enables the lookup', () => {
      const spy = vi.fn(() => 'Galaxy A23 5G\nnull\n\n\n');
      androidDevicesExec.deviceName = spy;
      expect(friendlyName('SERIAL9', 'SC_56C')).toBe('Galaxy A23 5G');
      _clearFriendlyNameCache();
      expect(friendlyName('SERIAL9', 'SC_56C')).toBe('Galaxy A23 5G');
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('withFriendlyNames', () => {
    it('attaches name to usable devices only, and never shells an unauthorized/offline device', () => {
      const spy = vi.fn(() => 'Galaxy A23 5G\nnull\n\n\n');
      androidDevicesExec.deviceName = spy;
      const devices: AndroidDevice[] = [
        { serial: 'USABLE', state: 'device', model: 'SC_56C' },
        { serial: 'UNAUTH', state: 'unauthorized' },
        { serial: 'OFFLINE', state: 'offline' },
      ];
      const out = withFriendlyNames(devices);
      expect(out).toEqual([
        { serial: 'USABLE', state: 'device', model: 'SC_56C', name: 'Galaxy A23 5G' },
        { serial: 'UNAUTH', state: 'unauthorized' },
        { serial: 'OFFLINE', state: 'offline' },
      ]);
      // Only the one usable device was ever asked.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('USABLE');
    });

    it('leaves a device with no learned name untouched (no name field added)', () => {
      androidDevicesExec.deviceName = () => 'null\nnull\n\n\n';
      const devices: AndroidDevice[] = [{ serial: 'S', state: 'device', model: 'SC_56C' }];
      expect(withFriendlyNames(devices)).toEqual([{ serial: 'S', state: 'device', model: 'SC_56C' }]);
    });
  });

  describe('describeAndroidDevice — name vs model precedence', () => {
    it('prefers the name over the model when both are present', () => {
      expect(describeAndroidDevice({ serial: 'S', state: 'device', model: 'SC_56C', name: 'Galaxy A23 5G' }))
        .toBe('S (Galaxy A23 5G)');
    });

    it('falls back to the model when there is no name', () => {
      expect(describeAndroidDevice({ serial: 'S', state: 'device', model: 'SC_56C' }))
        .toBe('S (SC_56C)');
    });

    it('still appends a non-usable state alongside the name', () => {
      expect(describeAndroidDevice({ serial: 'S', state: 'unauthorized', model: 'SC_56C', name: 'Galaxy A23 5G' }))
        .toBe('S (Galaxy A23 5G, unauthorized)');
    });
  });
});
