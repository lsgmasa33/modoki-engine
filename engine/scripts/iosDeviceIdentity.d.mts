/** Types for `iosDeviceIdentity.mjs` — resolving any id `devicectl --device` accepts to a UDID (#1078). */

export declare const IOS_UDID_SHAPE: RegExp;

export interface DevicectlDeviceRow {
  udid?: string;
  identifier?: string;
  /** Decimal, as `--device` takes it. */
  ecid?: string;
  serialNumber?: string;
  name?: string;
  productType?: string;
}

export type DevicectlLoader = () => DevicectlDeviceRow[] | null;

export interface ResolvedIosUdid {
  udid: string;
  /** Which field matched; absent when the value was already UDID-shaped. */
  via?: 'identifier' | 'ecid' | 'serialNumber' | 'name';
  name?: string;
}

export declare function parseDevicectlDevices(json: unknown): DevicectlDeviceRow[];
export declare function readDevicectlDevices(): DevicectlDeviceRow[] | null;
export declare function resolveIosUdid(value: string, loadDevices?: DevicectlLoader): ResolvedIosUdid | null;
export declare function iosClaimKeys(
  deviceId: string,
  loadDevices?: DevicectlLoader,
): { canonical: string; keys: string[]; via?: ResolvedIosUdid['via'] };
export declare function onceLoader(load?: DevicectlLoader): DevicectlLoader;
