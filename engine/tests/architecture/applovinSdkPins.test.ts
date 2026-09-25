/**
 * capacitor-applovin-max pins the AppLovin SDK in THREE manifests — SPM (`Package.swift`), CocoaPods (the
 * podspec) and Gradle — and they had drifted apart before #1494 (`from: "13.0.0"` resolving 13.6.4, `~> 13.0`,
 * and `13.5.1`), so iOS and Android shipped different SDKs with nothing saying so. Each must be an EXACT pin,
 * and all three the same version; the iOS UMP pin must also agree between SPM and the podspec.
 *
 * What this cannot see: the version that actually SHIPS on Android. `build.gradle`'s value is a default a
 * game's `ext.appLovinSdkVersion` overrides, and Gradle resolves the highest version any dependency asks
 * for (a mediation adapter included) — SPM's `exact:` follows neither. Read the built app for that.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG = resolve(__dirname, '../../packages/capacitor-applovin-max');
const read = (rel: string) => readFileSync(resolve(PKG, rel), 'utf8');

/** Every version each manifest pins, or null where the pin is missing or not exact. */
export function applovinPins(files: { spm: string; podspec: string; gradle: string }) {
  const spmExact = (repo: string) =>
    new RegExp(`${repo}\\.git",\\s*exact:\\s*"([\\d.]+)"`).exec(files.spm)?.[1] ?? null;
  const podExact = (pod: string) =>
    new RegExp(`s\\.dependency\\s+'${pod}',\\s*'([\\d.]+)'`).exec(files.podspec)?.[1] ?? null;
  return {
    sdk: {
      spm: spmExact('AppLovin-MAX-Swift-Package'),
      podspec: podExact('AppLovinSDK'),
      gradle: /appLovinSdkVersion\s*:\s*'([\d.]+)'/.exec(files.gradle)?.[1] ?? null,
    },
    ump: {
      spm: spmExact('swift-package-manager-google-user-messaging-platform'),
      podspec: podExact('GoogleUserMessagingPlatform'),
    },
  };
}

describe('capacitor-applovin-max SDK pins (#1494)', () => {
  const pins = applovinPins({
    spm: read('Package.swift'),
    podspec: read('CapacitorApplovinMax.podspec'),
    gradle: read('android/build.gradle'),
  });

  it('pins the AppLovin SDK exactly, to one version on SPM, the podspec and Gradle', () => {
    expect(pins.sdk.spm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.sdk.podspec).toBe(pins.sdk.spm);
    expect(pins.sdk.gradle).toBe(pins.sdk.spm);
  });

  it('pins Google UMP exactly, to one version on SPM and the podspec', () => {
    expect(pins.ump.spm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.ump.podspec).toBe(pins.ump.spm);
  });

  it('reads a range pin as NOT pinned — the shapes the manifests had before #1494', () => {
    const drifted = applovinPins({
      spm: '.package(url: "https://github.com/AppLovin/AppLovin-MAX-Swift-Package.git", from: "13.0.0")',
      podspec: "s.dependency 'AppLovinSDK', '~> 13.0'",
      gradle: "appLovinSdkVersion = project.hasProperty('appLovinSdkVersion') ? rootProject.ext.appLovinSdkVersion : '13.5.1'",
    });
    expect(drifted.sdk.spm).toBeNull();
    expect(drifted.sdk.podspec).toBeNull();
    expect(drifted.sdk.gradle).toBe('13.5.1');
  });
});
