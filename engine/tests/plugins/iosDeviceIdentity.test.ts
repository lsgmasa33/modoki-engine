/** #1078 — `devicectl --device` accepts six kinds of id, and a device claim is keyed by only one: the UDID.
 *  These pin the resolver the claim guard and the device CLI both use. Every id here is invented — this
 *  file ships in the public snapshot (see `scripts/scan-publish-safety.mjs`). */

import { describe, it, expect, vi } from 'vitest';
import { IOS_UDID_SHAPE, parseDevicectlDevices, resolveIosUdid, iosClaimKeys, onceLoader } from '../../scripts/iosDeviceIdentity.mjs';

const UDID = '00008150-TESTTESTTESTTEST';
const IDENTIFIER = 'C0DEC0DE-0000-4000-8000-00000000000A';

/** The shape of a real `devicectl list devices --json-output` row, trimmed to the fields that matter. */
const rows = parseDevicectlDevices(JSON.stringify({
  result: {
    devices: [
      {
        identifier: IDENTIFIER,
        hardwareProperties: { udid: UDID, ecid: 1234567890123456, serialNumber: 'SERIALTESTA', productType: 'iPadTEST,1', platform: 'iOS' },
        deviceProperties: { name: 'Test iPad' },
      },
      { identifier: 'C0DEC0DE-0000-4000-8000-00000000000B', hardwareProperties: { udid: '00008150-TWINATWINATWINAT' }, deviceProperties: { name: 'Twin' } },
      { identifier: 'C0DEC0DE-0000-4000-8000-00000000000C', hardwareProperties: { udid: '00008150-TWINBTWINBTWINBT' }, deviceProperties: { name: 'Twin' } },
      // An iOS 16 phone: CoreDevice lists a stub for it, with an identifier but no UDID.
      { identifier: 'C0DEC0DE-0000-4000-8000-00000000000D', hardwareProperties: { productType: 'iPhoneTEST,1', platform: 'iOS' } },
    ],
  },
}));
const load = () => rows;

describe('parseDevicectlDevices', () => {
  it('keeps the identity fields of each row, with the ECID as the decimal string --device takes', () => {
    expect(rows[0]).toEqual({
      udid: UDID, identifier: IDENTIFIER, ecid: '1234567890123456', serialNumber: 'SERIALTESTA', name: 'Test iPad', productType: 'iPadTEST,1',
    });
    expect(rows[3].udid).toBeUndefined();
  });

  it('survives junk', () => {
    expect(parseDevicectlDevices('not json')).toEqual([]);
    expect(parseDevicectlDevices('{}')).toEqual([]);
  });
});

describe('resolveIosUdid', () => {
  it('returns a UDID-shaped value as-is WITHOUT listing devices', () => {
    const spy = vi.fn(load);
    expect(resolveIosUdid(UDID, spy)).toEqual({ udid: UDID });
    expect(resolveIosUdid('a'.repeat(40), spy)).toEqual({ udid: 'a'.repeat(40) });   // the legacy form
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not mistake a CoreDevice identifier for a UDID — the premise of the whole fix', () => {
    expect(IOS_UDID_SHAPE.test(IDENTIFIER)).toBe(false);
  });

  it('resolves the CoreDevice identifier (any case), the ECID, the serial number and the name', () => {
    expect(resolveIosUdid(IDENTIFIER, load)).toEqual({ udid: UDID, via: 'identifier', name: 'Test iPad' });
    expect(resolveIosUdid(IDENTIFIER.toLowerCase(), load)?.udid).toBe(UDID);
    expect(resolveIosUdid('1234567890123456', load)).toEqual({ udid: UDID, via: 'ecid', name: 'Test iPad' });
    expect(resolveIosUdid('serialtesta', load)?.via).toBe('serialNumber');
    expect(resolveIosUdid('Test iPad', load)?.via).toBe('name');
  });

  it('never guesses: an ambiguous name, a UDID-less stub, an unknown id and a failed listing are all null', () => {
    expect(resolveIosUdid('Twin', load)).toBeNull();
    expect(resolveIosUdid('C0DEC0DE-0000-4000-8000-00000000000D', load)).toBeNull();
    expect(resolveIosUdid('C0DEC0DE-0000-4000-8000-0000000000FF', load)).toBeNull();
    expect(resolveIosUdid('test ipad', load)).toBeNull();   // a name matches exactly
    expect(resolveIosUdid(IDENTIFIER, () => null)).toBeNull();
    expect(resolveIosUdid('', load)).toBeNull();
  });
});

describe('iosClaimKeys', () => {
  it('an identifier is compared under its UDID first, then as written', () => {
    expect(iosClaimKeys(`ios:${IDENTIFIER}`, load)).toEqual({ canonical: `ios:${UDID}`, keys: [`ios:${UDID}`, `ios:${IDENTIFIER}`], via: 'identifier' });
  });

  it('a UDID, an unresolvable id and a non-ios id are each their own only key — and adb never lists iOS devices', () => {
    const spy = vi.fn(load);
    expect(iosClaimKeys(`ios:${UDID}`, spy)).toEqual({ canonical: `ios:${UDID}`, keys: [`ios:${UDID}`] });
    expect(iosClaimKeys('adb:RFTESTSERIAL1', spy)).toEqual({ canonical: 'adb:RFTESTSERIAL1', keys: ['adb:RFTESTSERIAL1'] });
    expect(spy).not.toHaveBeenCalled();
    expect(iosClaimKeys('ios:nothing-like-this', load)).toEqual({ canonical: 'ios:nothing-like-this', keys: ['ios:nothing-like-this'] });
  });
});

describe('onceLoader', () => {
  it('lists at most once per process, a failed listing included', () => {
    const failing = vi.fn(() => null);
    const once = onceLoader(failing);
    expect(once()).toBeNull();
    expect(once()).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
