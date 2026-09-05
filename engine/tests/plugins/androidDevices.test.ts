/**
 * androidDevices tests (#149) — the Android sibling of `wdaLauncher.test.ts`'s `resolveIosDevice`
 * coverage. PURE parse + PURE precedence rule, no hardware, no `child_process` mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAdbDevices, resolveAndroidSerial, resolveBuildAndroidSerial, adbArgs, describeAndroidDevice, isUsable,
  friendlyName, withFriendlyNames, _clearFriendlyNameCache, androidDevicesExec,
  leaseForAndroidOps, pickHostSideAndroidSerial,
  type AndroidDevice,
} from '../../plugins/backend/androidDevices';

describe('parseAdbDevices', () => {
  it('parses the `-l` long format, pulling model: and transport_id: out of the trailing key-values', () => {
    const out = [
      'List of devices attached',
      'FAKESERIAL0Y6001   device usb:2-1.4.3 model:MRD_LX3 device:HWMRD transport_id:3',
    ].join('\n');
    expect(parseAdbDevices(out)).toEqual([
      { serial: 'FAKESERIAL0Y6001', state: 'device', model: 'MRD_LX3', transportId: '3' },
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

describe('resolveBuildAndroidSerial — the BUILD path also honours the held lease (#235)', () => {
  const A = { serial: 'AAA', state: 'device', model: 'SM_S901U1' };
  const B = { serial: 'BBB', state: 'device', model: 'SC_56C' };

  it('uses the lease serial when the project has no pin — the refusal names device_connect, so it must work', () => {
    // The bug: with three phones attached the build refused and told the caller to run
    // `device_connect {useAdb:true, serial}`. Doing exactly that produced the IDENTICAL
    // refusal on the next build, because the build path passed only the project pin —
    // costing a full build-and-refuse cycle to discover the advice was inert.
    expect(resolveBuildAndroidSerial([A, B], { leaseSerial: 'BBB', env: {} })).toEqual({ serial: 'BBB' });
  });

  it('the project pin still wins over the lease — durable config beats session state', () => {
    expect(resolveBuildAndroidSerial([A, B], { projectPin: 'AAA', leaseSerial: 'BBB', env: {} })).toEqual({ serial: 'AAA' });
  });

  it('the lease beats the environment pin', () => {
    expect(resolveBuildAndroidSerial([A, B], { leaseSerial: 'BBB', env: { MODOKI_ANDROID_SERIAL: 'AAA' } }))
      .toEqual({ serial: 'BBB' });
  });

  it('a lease whose phone was UNPLUGGED degrades to the ordinary rule — a preference, not a pin', () => {
    // A lease outlives the cable. Treated as a pin, an unplugged leased handset would hard-fail
    // the build naming a serial the human never typed; as a preference the one remaining phone
    // just builds. Same rule deviceConnection.ts states for its remembered target.
    expect(resolveBuildAndroidSerial([A], { leaseSerial: 'BBB', env: {} })).toEqual({ serial: 'AAA' });
  });

  it('an UNUSABLE leased device is ignored too, and the refusal names the real candidates', () => {
    const unauthorized = { serial: 'BBB', state: 'unauthorized' };
    const r = resolveBuildAndroidSerial([A, unauthorized], { leaseSerial: 'BBB', env: {} });
    // A is the only usable one, so it wins rather than the build dying on an unauthorized phone.
    expect(r).toEqual({ serial: 'AAA' });
  });

  it('no pin, no lease, several phones — still refuses with every candidate named', () => {
    const r = resolveBuildAndroidSerial([A, B], { env: {} });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toContain('AAA');
      expect(r.error).toContain('BBB');
    }
  });
});


/**
 * #732 — the Android mirror of #670. `deviceHardware()` is platform-agnostic, so before
 * `leaseForAndroidOps` existed an iOS lease's `ProductType` reached the adb model comparison,
 * matched nothing, and made the host-side ops refuse about an Android that was plugged in and
 * answering. Pure decision, no hardware — the reason this half was untestable before is that it
 * lived inline in an I/O-shaped router closure.
 */
describe('androidDevices — leaseForAndroidOps (#732)', () => {
  it('passes the model through for a confirmed Android lease', () => {
    expect(leaseForAndroidOps('android', 'SM-S901B')).toBe('SM-S901B');
  });

  it('DROPS an iOS lease — the whole point: a ProductType can never match an adb model', () => {
    expect(leaseForAndroidOps('ios', 'iPhone18,4')).toBeUndefined();
  });

  it('treats a null/unresolved platform as NOT Android — "not confirmed" is never "assume"', () => {
    // devicePlatform() swallows its own errors and returns null, so null conflates "an old bridge
    // with no platform" with "the ask failed". Neither is evidence, and the iOS half reads it the
    // same strict way.
    expect(leaseForAndroidOps(null, 'SM-S901B')).toBeUndefined();
    expect(leaseForAndroidOps(undefined, 'SM-S901B')).toBeUndefined();
  });

  it('⭐ null and undefined mean DIFFERENT things, and collapsing them is a real bug', () => {
    // `undefined` = no Android lease may speak here. `null` = an Android lease that reported no
    // model. Only the second earns the single-attached shortcut in pickHostSideAndroidSerial, so a
    // helper that returned null for both would hand a non-Android lease a phone to answer about.
    expect(leaseForAndroidOps('android', null)).toBeNull();
    expect(leaseForAndroidOps('ios', null)).toBeUndefined();
    expect(leaseForAndroidOps('android', null)).not.toBe(leaseForAndroidOps('ios', null));
  });
});

describe('androidDevices — pickHostSideAndroidSerial (#732)', () => {
  const S22: AndroidDevice = { serial: 'RFCT001', state: 'device', model: 'SM_S901B', name: 'Galaxy S22' };
  const A23: AndroidDevice = { serial: 'RFCT002', state: 'device', model: 'SC_56C', name: 'Galaxy A23 5G' };

  it('⭐ an iOS lease with Androids attached FALLS THROUGH instead of refusing — the #732 bug', () => {
    // THE regression. Inputs are exactly what the router reads: `devicePlatform()` says 'ios' and
    // `deviceHardware()` hands back a ProductType, because it answers for whatever is leased. The
    // gate is INSIDE the function under test, so this covers the fix rather than restating it —
    // before it existed this returned an error naming iPhone18,4 as why no Android qualified.
    const r = pickHostSideAndroidSerial({
      leasePlatform: 'ios', leaseModel: 'iPhone18,4', attached: [S22],
    });
    expect(r).toEqual({ unleased: true });
  });

  it('an iOS lease does not steal the single-attached shortcut either', () => {
    const r = pickHostSideAndroidSerial({ leasePlatform: 'ios', leaseModel: null, attached: [S22] });
    expect(r).toEqual({ unleased: true });
  });

  it('a null/unresolved platform falls through — "not confirmed Android" is never "assume Android"', () => {
    // devicePlatform() swallows its errors and returns null, so null is not evidence of anything.
    const r = pickHostSideAndroidSerial({ leasePlatform: null, leaseModel: 'SC_56C', attached: [S22, A23] });
    expect(r).toEqual({ unleased: true });
  });

  it('an adb lease serial wins outright, and is NOT platform-gated', () => {
    // `target.serial` exists only on the useAdb path, so it is Android by construction. Gating it
    // on devicePlatform() would drop a lease we are certain about because a probe that swallows
    // its own errors said nothing. Pinned with a deliberately hostile platform value.
    const r = pickHostSideAndroidSerial({
      leaseSerial: 'RFCT002', leasePlatform: null, leaseModel: null, attached: [S22, A23],
    });
    expect(r).toEqual({ serial: 'RFCT002' });
  });

  it('a serial-less ANDROID lease still disambiguates by model — the behaviour #732 must preserve', () => {
    const r = pickHostSideAndroidSerial({
      leasePlatform: 'android', leaseModel: 'SC_56C', attached: [S22, A23],
    });
    expect(r).toEqual({ serial: 'RFCT002' });
  });

  it('matches on the friendly NAME as well as the adb model', () => {
    const r = pickHostSideAndroidSerial({
      leasePlatform: 'android', leaseModel: 'Galaxy S22', attached: [S22, A23],
    });
    expect(r).toEqual({ serial: 'RFCT001' });
  });

  it('an Android WiFi lease matching NOTHING attached still refuses, naming every candidate (#149)', () => {
    const r = pickHostSideAndroidSerial({
      leasePlatform: 'android', leaseModel: 'Pixel 8', attached: [S22, A23],
    });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toContain('Pixel 8');
      expect(r.error).toContain('RFCT001');
      expect(r.error).toContain('RFCT002');
    }
  });

  it('an Android lease with NO model and exactly one phone attached takes it', () => {
    const r = pickHostSideAndroidSerial({ leasePlatform: 'android', leaseModel: null, attached: [S22] });
    expect(r).toEqual({ serial: 'RFCT001' });
  });

  it('an Android lease with no model and TWO phones attached refuses rather than guessing', () => {
    const r = pickHostSideAndroidSerial({ leasePlatform: 'android', leaseModel: null, attached: [S22, A23] });
    expect('error' in r).toBe(true);
  });

  it('no lease at all falls through, whatever is attached', () => {
    expect(pickHostSideAndroidSerial({ attached: [] })).toEqual({ unleased: true });
    expect(pickHostSideAndroidSerial({ attached: [S22, A23] })).toEqual({ unleased: true });
  });

  it('an Android lease with nothing attached refuses and says so rather than naming a phantom', () => {
    const r = pickHostSideAndroidSerial({ leasePlatform: 'android', leaseModel: 'SC_56C', attached: [] });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('none');
  });
});
