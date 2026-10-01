/**
 * The shipping iOS games carry an app privacy manifest, WIRED into the App target, declaring exactly
 * what no SDK manifest in their package graph declares (#1051).
 *
 * Apple builds an app's privacy report from every `PrivacyInfo.xcprivacy` in the bundle: the app's
 * own plus one per SDK that ships one. So the app declares only the rest. For these games that is:
 *   - **Required-reason APIs:** UserDefaults (`CA92.1`), because `@capacitor/preferences` calls
 *     `UserDefaults.standard` and ships no manifest. Every other required-reason use in the resolved
 *     graph (FileTimestamp, SystemBootTime, more UserDefaults) is declared by the SDK that makes it.
 *   - **Tracking:** only with an ATT "Allow" (#1920/#1921 — guideline 5.1.1(iv), Court 0.1.0's rejection), and
 *     declared PER DATA TYPE with the App Store label's purposes: Device ID, Advertising Data, Product Interaction.
 *     `NSPrivacyTracking` stays false with NO domains key: `true` with no domains is invalid (Apple TN3181), the
 *     app's own code reaches no tracking host, and AppsFlyer declares its own `att.*` hosts.
 *   - **Collected data:** the game's OWN first-party collection, decided by the owner (2026-09-11):
 *     each game's cloud save (User ID, Gameplay Content, Purchase History) — Weaveling's since #1389.
 * Coverage table and sources: `docs/native-and-sdks.md` § "iOS privacy manifest".
 *
 * ⚠️ A declaration the app does not need is still a false statement to Apple, so each check below
 * is EXACT, not "at least".
 *
 * ⚠️ What this cannot see: whether an SDK added later ships its own manifest or uses a required-reason
 * API without one. Adding a native dependency means re-running the check the docs section describes.
 *
 * Gated on `hasInternalGames()`: the public engine snapshot ships no `games/`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, hasInternalGames } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';

/** Game → the first-party `NSPrivacyCollectedDataType`s it declares. The owner's decision, pinned. */
const SHIPPING_IOS: Readonly<Record<string, readonly string[]>> = {
  'games/court': [
    'NSPrivacyCollectedDataTypeGameplayContent',
    'NSPrivacyCollectedDataTypePurchaseHistory',
    'NSPrivacyCollectedDataTypeUserID',
  ],
  // Sign-in, IAP and cloud save landed (#927, #925, #679); the rows were confirmed against its own senders (#1389).
  'games/wordweave': [
    'NSPrivacyCollectedDataTypeGameplayContent',
    'NSPrivacyCollectedDataTypePurchaseHistory',
    'NSPrivacyCollectedDataTypeUserID',
  ],
  // Copied from Weaveling (#1584) and Apiary-shipping; its manifest has claimed this guard since it landed.
  'games/slime-shooter': [
    'NSPrivacyCollectedDataTypeGameplayContent',
    'NSPrivacyCollectedDataTypePurchaseHistory',
    'NSPrivacyCollectedDataTypeUserID',
  ],
};

/**
 * The data each game uses to TRACK, with the player's ATT permission (#1920) — declared because no SDK manifest
 * in the graph declares it as tracking. Same for every game: the ads and attribution stack is the engine's.
 */
const TRACKING: Readonly<Record<string, readonly string[]>> = {
  // The App Store label's own rows and purposes (games/court/legal-drafts/store-forms.md § "App Store — privacy labels").
  NSPrivacyCollectedDataTypeDeviceID: [
    'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
    'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
    'NSPrivacyCollectedDataTypePurposeAnalytics',
  ],
  NSPrivacyCollectedDataTypeAdvertisingData: [
    'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
    'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
    'NSPrivacyCollectedDataTypePurposeAnalytics',
  ],
  NSPrivacyCollectedDataTypeProductInteraction: [
    'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
    'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
    'NSPrivacyCollectedDataTypePurposeAnalytics',
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ],
};

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };
type PlistDict = Record<string, PlistValue>;

/** The XML plist subset a privacy manifest uses: dict, array, key, string, integer, true, false.
 *  Not `plutil`, which is macOS-only while the Windows clone runs this suite, and not the `plist`
 *  package, which is only a transitive dependency here. */
function parsePlist(xml: string): PlistValue {
  const tokens = (xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .match(/<[^>]+>|[^<]+/g) ?? [])
    .filter((t) => t.startsWith('<') || t.trim() !== '');
  let i = 0;
  const take = (): string => {
    if (i >= tokens.length) throw new Error('plist: unexpected end of input');
    return tokens[i++];
  };
  const textUntil = (close: string): string => {
    let s = '';
    while (tokens[i] !== close) {
      const t = take();
      if (t.startsWith('<')) throw new Error(`plist: unexpected ${t} before ${close}`);
      s += t;
    }
    take();
    return s;
  };
  const read = (tag: string): PlistValue => {
    switch (tag) {
      case '<true/>': return true;
      case '<false/>': return false;
      case '<array/>': return [];
      case '<dict/>': return {};
      case '<string>': return textUntil('</string>');
      case '<integer>': return Number(textUntil('</integer>'));
      case '<array>': {
        const out: PlistValue[] = [];
        while (tokens[i] !== '</array>') out.push(read(take()));
        take();
        return out;
      }
      case '<dict>': {
        const out: PlistDict = {};
        while (tokens[i] !== '</dict>') {
          if (take() !== '<key>') throw new Error('plist: a dict entry without a <key>');
          const key = textUntil('</key>');
          out[key] = read(take());
        }
        take();
        return out;
      }
      default: throw new Error(`plist: unsupported tag ${tag}`);
    }
  };
  if (!take().startsWith('<plist')) throw new Error('plist: no <plist> root');
  return read(take());
}

describe('the plist reader this guard rests on', () => {
  it('reads the shapes a privacy manifest uses, and refuses what it does not understand', () => {
    const xml = '<?xml version="1.0"?><!-- note --><plist version="1.0"><dict>'
      + '<key>a</key><true/><key>b</key><array><string>x</string><string></string></array>'
      + '<key>c</key><dict><key>n</key><integer>3</integer></dict><key>d</key><array/></dict></plist>';
    expect(parsePlist(xml)).toEqual({ a: true, b: ['x', ''], c: { n: 3 }, d: [] });
    expect(() => parsePlist('<plist><dict><key>a</key><date>2026</date></dict></plist>')).toThrow(/unsupported/);
  });
});

for (const [game, collected] of Object.entries(SHIPPING_IOS)) {
  describe.skipIf(!hasInternalGames())(`${game}: the iOS app privacy manifest (#1051)`, () => {
    const manifestPath = path.join(REPO_ROOT, game, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy');
    const pbxprojPath = path.join(REPO_ROOT, game, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    const manifest = (): PlistDict => parsePlist(fs.readFileSync(manifestPath, 'utf8')) as PlistDict;

    it('exists and parses as a dict', () => {
      expect(fs.existsSync(manifestPath), `${game} has no ios/App/App/PrivacyInfo.xcprivacy`).toBe(true);
      expect(typeof manifest()).toBe('object');
    });

    it('is a member of the App target\'s Resources build phase, not only a file on disk', () => {
      const src = fs.readFileSync(pbxprojPath, 'utf8');
      const fileRef = src.match(
        /^\s*([0-9A-F]{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;[^\n]*path = PrivacyInfo\.xcprivacy;/m,
      )?.[1];
      expect(fileRef, 'no PBXFileReference for PrivacyInfo.xcprivacy').toBeDefined();
      const buildFile = src.match(new RegExp(
        `^\\s*([0-9A-F]{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${fileRef} `, 'm',
      ))?.[1];
      expect(buildFile, 'no PBXBuildFile pointing at that file reference').toBeDefined();

      const section = src.match(/\/\* Begin PBXResourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXResourcesBuildPhase section \*\//)?.[1] ?? '';
      // One Resources phase in the project, so "in the section" is "in the App target's phase".
      expect(section.match(/isa = PBXResourcesBuildPhase;/g) ?? [], 'expected exactly one Resources phase').toHaveLength(1);
      expect(section, 'the build file is not listed in the Resources phase, so the manifest never reaches the bundle')
        .toContain(`${buildFile} /* PrivacyInfo.xcprivacy in Resources */`);
    });

    it('declares UserDefaults CA92.1 exactly when @capacitor/preferences is a dependency, and no other API', () => {
      const deps = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }).dependencies ?? {};
      const expected = '@capacitor/preferences' in deps
        ? [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] }]
        : [];
      expect(manifest().NSPrivacyAccessedAPITypes).toEqual(expected);
    });

    it('declares no tracking DOMAINS of its own: NSPrivacyTracking false, no NSPrivacyTrackingDomains key (TN3181)', () => {
      // `true` with no domains is an INVALID manifest (Apple TN3181), and listing AppLovin's hosts would block
      // the non-personalized ads on a denial. The tracking the label declares is per data type, next test.
      expect(manifest().NSPrivacyTracking).toBe(false);
      expect(manifest(), 'TN3181: remove the key rather than leave it empty').not.toHaveProperty('NSPrivacyTrackingDomains');
    });

    it('declares exactly the owner\'s first-party rows (not tracking) and the #1920 tracking rows, each as decided', () => {
      // One expected table, no filtering: every declared type must be a row here and every row declared.
      const expected: Record<string, { tracking: boolean; purposes: readonly string[] }> = {
        ...Object.fromEntries(collected.map((type) => [type,
          { tracking: false, purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] }])),
        ...Object.fromEntries(Object.entries(TRACKING).map(([type, purposes]) => [type, { tracking: true, purposes }])),
      };
      const types = manifest().NSPrivacyCollectedDataTypes as PlistDict[];
      expect(types.map((t) => String(t.NSPrivacyCollectedDataType)).sort()).toEqual(Object.keys(expected).sort());
      for (const t of types) {
        const type = String(t.NSPrivacyCollectedDataType);
        expect(t.NSPrivacyCollectedDataTypeLinked, type).toBe(true);
        expect(t.NSPrivacyCollectedDataTypeTracking, type).toBe(expected[type].tracking);
        expect(t.NSPrivacyCollectedDataTypePurposes, type).toEqual(expected[type].purposes);
      }
    });

    it('defaults Firebase\'s three ad consent signals to DENIED in Info.plist, until the ATT answer grants them (#1920)', () => {
      // Not the plist reader above: Info.plist carries shapes it refuses on purpose.
      const info = readScannedSource(path.join(REPO_ROOT, game, 'ios', 'App', 'App', 'Info.plist'),
        { comments: 'include', reason: 'plist XML has no registered stripper; the keys matched are plist values' }).code;
      for (const key of ['AD_STORAGE', 'AD_USER_DATA', 'AD_PERSONALIZATION_SIGNALS']) {
        expect(info, key).toMatch(new RegExp(`<key>GOOGLE_ANALYTICS_DEFAULT_ALLOW_${key}</key>\\s*<false/>`));
      }
      expect(info, 'first-party analytics is not tracking').not.toContain('GOOGLE_ANALYTICS_DEFAULT_ALLOW_ANALYTICS_STORAGE');
    });
  });
}
