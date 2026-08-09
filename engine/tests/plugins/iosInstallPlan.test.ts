/** The iOS device build's one decision: may it run, and how does it install?
 *
 *  REGRESSION: the preflight used to require BOTH `iosDeviceId` and `iosDevicectlId`, so an
 *  iOS-16 device — which has no devicectl id in existence, `devicectl` being CoreDevice-only
 *  (iOS 17+) — was refused before `xcodebuild` was ever invoked. The build it refused
 *  succeeds: measured on an iPhone 8 / iOS 16.7.16. The `xcode-handoff` cases below are that
 *  bug; each of them returned `{ok: false}` before the fix.
 */
import { describe, it, expect } from 'vitest';
import { planIosInstall } from '../../plugins/vite-asset-scanner';

describe('planIosInstall', () => {
  it('refuses only when iosDeviceId is missing — that is what -destination needs', () => {
    expect(planIosInstall({ iosDeviceId: '', iosDevicectlId: '' }))
      .toEqual({ ok: false, missing: 'iosDeviceId' });
    // Having a devicectl id does NOT substitute: xcodebuild cannot accept it (it is a
    // different GUID from the hardware UDID — see wdaLauncher.parseIosDevices).
    expect(planIosInstall({ iosDeviceId: '', iosDevicectlId: 'FACEFEED-0000-0000' }))
      .toEqual({ ok: false, missing: 'iosDeviceId' });
  });

  it('allows the build with NO devicectl id, handing off to Xcode (the iOS-16 case)', () => {
    expect(planIosInstall({ iosDeviceId: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', iosDevicectlId: '' }))
      .toEqual({ ok: true, mode: 'xcode-handoff' });
  });

  it('uses devicectl when both ids are present', () => {
    // ⚠️ `DEADBEEF-0123456789ABCDEF` is the CANONICAL PLACEHOLDER from
    // `scripts/scan-publish-safety.mjs` (`PLACEHOLDER_UDIDS`) — never a real device's UDID, even in
    // a test. `planIosInstall` only checks that the field is non-blank, so a real id buys the test
    // nothing and costs it the OSS snapshot: the publish-safety scan treats a real UDID as a
    // BLOCKING finding (#103 — it leaks the owner's hardware and aims a stranger's install at it).
    // This file carried one and killed the `main` snapshot for two days, and with it the free
    // public CI that runs ubuntu + windows + the whole e2e suite. Keep the shape, not the device.
    //
    // ⚠️ BOTH fields are that class — `iosDevicectlId` too, which this file got wrong for longer.
    // It carried a real devicectl identifier straight THROUGH the #103 sweep (15e8e032, "stop
    // shipping the owner's real device ids"), because no guard can see it: a devicectl id is a
    // plain UUID, indistinguishable by shape from every asset GUID, so no SHAPE rule can exist —
    // and the one leg that grepped for it by value was itself broken, looking for a repo-root
    // `project.user.json` when the editor writes `games/<id>/project.user.json`. Both are fixed:
    // that leg is repointed, and `KNOWN_DEVICE_IDS` in scan-publish-safety.mjs now matches this
    // class by exact value (safe there — `scripts/` never ships). See
    // docs/engine-oss-publishing.md § "Device ids".
    expect(planIosInstall({
      iosDeviceId: 'DEADBEEF-0123456789ABCDEF',
      iosDevicectlId: 'FACEFEED-0000-0000-0000-000000000000',
    })).toEqual({ ok: true, mode: 'devicectl' });
  });

  it('treats a whitespace-only id as absent, not as a usable value', () => {
    // A field typed into Project Settings and cleared can leave a stray space; the old
    // truthiness check would have taken it as a real id and emitted `--device ' '`.
    expect(planIosInstall({ iosDeviceId: '   ', iosDevicectlId: 'x' }))
      .toEqual({ ok: false, missing: 'iosDeviceId' });
    expect(planIosInstall({ iosDeviceId: 'udid', iosDevicectlId: '   ' }))
      .toEqual({ ok: true, mode: 'xcode-handoff' });
  });
});
