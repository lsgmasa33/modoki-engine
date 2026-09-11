/**
 * One iOS device, several names — resolved to the ONE name a device claim is keyed by (#1078).
 *
 * `xcrun devicectl … --device <x>` accepts a CoreDevice identifier (a UUID), an ECID, a serial number, a
 * UDID, a device name or a DNS name (`devicectl device info details --help`). Every other iOS tool the
 * claim guard covers — `xcodebuild -destination id=`, `ideviceinstaller -u`, go-ios `--udid` — takes the
 * hardware UDID only, and so does every claim the editor itself takes: the USB lease, the WebDriverAgent
 * launch, the build. A claim keyed by whatever string a command happened to pass therefore split one
 * phone into two keys: a sibling's `ios:<udid>` claim was invisible to `devicectl --device <identifier>`,
 * and this clone's own claim did not cover that command either (the hub hit the second half in #1065).
 *
 * So both edges of the claim guard resolve an iOS id to its UDID first — the READ side (`claim-guard.mjs`,
 * `device run`) and the WRITE side (`device claim`/`release`). The mapping comes from
 * `xcrun devicectl list devices --json-output`, whose rows carry `identifier` and
 * `hardwareProperties.{udid, ecid, serialNumber}` together (checked on a real listing, 2026-09-11).
 *
 * What stays open, on purpose: an iOS 16-or-older phone is a stub in that listing with no UDID, so its
 * other ids cannot be resolved — but devicectl cannot drive it either. A DNS name is not in the listing's
 * hardware fields and is not resolved. The `ip:<host>` vs `ios:<udid>` gap is a different one with no
 * identity source at all — see `deviceClaimsStore.mjs` § "KNOWN GAP".
 *
 * Plain ESM with no dependencies beyond Node, for the same reason `deviceClaimsStore.mjs` is: a
 * `PreToolUse` hook and a bare-`node` CLI import it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A hardware UDID's SHAPE: the legacy 40-character form or the modern `XXXXXXXX-XXXXXXXXXXXXXXXX`.
 *  Shape rather than hex, so a value that already IS a UDID costs no `xcrun` spawn — the repo's non-hex
 *  test placeholders (`00008150-TESTTESTTESTTEST`) included. None of devicectl's other ids has it: an
 *  identifier is an 8-4-4-4-12 UUID, an ECID is decimal, a serial number is about 10-12 characters. */
export const IOS_UDID_SHAPE = /^(?:[0-9A-Za-z]{40}|[0-9A-Za-z]{8}-[0-9A-Za-z]{16})$/;

const str = (v) => (typeof v === 'string' && v ? v : undefined);

/** The identity fields of each row in a `devicectl list devices --json-output` document. PURE and
 *  tolerant: malformed JSON or an unexpected shape yields `[]`, and a row keeps whatever fields it has. */
export function parseDevicectlDevices(json) {
  let parsed;
  try { parsed = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const devices = parsed?.result?.devices;
  if (!Array.isArray(devices)) return [];
  return devices.map((d) => {
    const hw = d?.hardwareProperties ?? {};
    return {
      udid: str(hw.udid),
      identifier: str(d?.identifier),
      // A JSON number in devicectl's output; `--device` takes it in decimal.
      ecid: typeof hw.ecid === 'number' || (typeof hw.ecid === 'string' && hw.ecid) ? String(hw.ecid) : undefined,
      serialNumber: str(hw.serialNumber),
      name: str(d?.deviceProperties?.name),
      productType: str(hw.productType),
    };
  });
}

/** This Mac's devicectl listing, or `null` when it cannot be had (no Xcode, a timeout, a non-zero exit).
 *
 *  `MODOKI_DEVICECTL_JSON_FIXTURE` points it at a canned JSON file instead — the seam the CLI and hook
 *  tests use so they pass on a machine with no Xcode and no phone. It changes where the JSON comes from,
 *  not the rule. A fixture path that does not exist reads as "cannot be had", like a missing `xcrun`. */
export function readDevicectlDevices() {
  const fixture = process.env.MODOKI_DEVICECTL_JSON_FIXTURE;
  if (fixture) {
    try { return parseDevicectlDevices(fs.readFileSync(fixture, 'utf8')); } catch { return null; }
  }
  // `--json-output` must be a real file: devicectl prints its human-readable table to stdout as well.
  const tmp = path.join(os.tmpdir(), `modoki-devicectl-identity-${process.pid}-${Date.now()}.json`);
  try {
    // No pipes: a devicectl grandchild holding one open could keep spawnSync waiting past its timeout, and
    // the claim-guard hook runs this inside every destructive devicectl Bash call.
    const res = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], { timeout: 8000, stdio: 'ignore' });
    if (res.error || res.status !== 0) return null;
    return parseDevicectlDevices(fs.readFileSync(tmp, 'utf8'));
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

/** Resolve any id `devicectl --device` accepts to that device's hardware UDID, or `null` — never a guess.
 *
 *  A UDID-shaped value comes back as-is WITHOUT calling `loadDevices`. Otherwise the listing is matched
 *  field by field: identifier, ECID and serial number case-insensitively, a name exactly. A value that
 *  matches more than one device (two phones given one name) is `null` — devicectl refuses that too. */
export function resolveIosUdid(value, loadDevices = readDevicectlDevices) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  if (IOS_UDID_SHAPE.test(v)) return { udid: v };
  const rows = (loadDevices() ?? []).filter((r) => r.udid);
  const lower = v.toLowerCase();
  for (const field of ['identifier', 'ecid', 'serialNumber', 'name']) {
    const hits = rows.filter((r) => r[field] !== undefined
      && (field === 'name' ? r[field] === v : r[field].toLowerCase() === lower));
    if (hits.length > 1) return null;
    if (hits.length === 1) return { udid: hits[0].udid, via: field, ...(hits[0].name ? { name: hits[0].name } : {}) };
  }
  return null;
}

/** The claim keys an id taken from a COMMAND may be held under. For an `ios:` id that resolves to a
 *  different spelling: its UDID form first (`canonical`), then the raw spelling — a claim someone took
 *  under that spelling before #1078 must still be honored. Any other id is its own only key. */
export function iosClaimKeys(deviceId, loadDevices = readDevicectlDevices) {
  if (typeof deviceId !== 'string' || !deviceId.startsWith('ios:')) return { canonical: deviceId, keys: [deviceId] };
  const resolved = resolveIosUdid(deviceId.slice('ios:'.length), loadDevices);
  if (!resolved || `ios:${resolved.udid}` === deviceId) return { canonical: deviceId, keys: [deviceId] };
  const canonical = `ios:${resolved.udid}`;
  return { canonical, keys: [canonical, deviceId], via: resolved.via };
}

/** Wrap a loader so one process lists devices at most once, however many ids it resolves. */
export function onceLoader(load = readDevicectlDevices) {
  let loaded = false;
  let value = null;
  return () => {
    if (!loaded) { value = load(); loaded = true; }
    return value;
  };
}
