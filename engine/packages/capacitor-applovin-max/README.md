# capacitor-applovin-max

Capacitor 8 plugin for **AppLovin MAX**: banner (anchored adaptive), MREC, interstitial and rewarded ads,
plus Google UMP consent. Built to be driven by the Modoki engine's SDK-neutral ad lifecycle
(`runtime/core/adLifecycle.ts`) through a game's `AdSdk` adapter.

The call-by-call contract is **`src/definitions.ts`** — read it rather than a list here. The reasoning
behind it (consent, load settling, banner layout, revenue units) is in the engine's
`docs/native-and-sdks.md` § `capacitor-applovin-max`.

## Installation

The AppLovin SDK and Google UMP come from **SPM** (iOS) and **Gradle** (Android). iOS pins them exactly
(`Package.swift`, `CapacitorApplovinMax.podspec`); `android/build.gradle` declares the same version as a
DEFAULT, which an app's `ext.appLovinSdkVersion` — or Gradle picking the highest version any dependency
asks for — can override. In the Modoki repo the
plugin reaches a game as a vendored tarball, declared in the game ROOT `package.json` only.

## Initialise from JS, after consent — never natively

Do **not** initialise MAX in `AppDelegate` / `MainActivity`: that requests ads before the player has
answered the consent form. The order is:

```typescript
import { ApplovinMax } from 'capacitor-applovin-max';

// 1. After the ATT prompt has settled (the game's attribution SDK owns it).
let consent = await ApplovinMax.requestConsentInfo();
if (consent.status === 'REQUIRED' && consent.isConsentFormAvailable) consent = await ApplovinMax.showConsentForm();
// 2. Only when UMP allows it.
if (consent.canRequestAds) await ApplovinMax.initialize({ sdkKey, testDeviceAdvertisingIds: [] });
// 3. Offer Settings → Privacy choices only when UMP says the player needs one:
if (consent.privacyOptionsRequired) await ApplovinMax.showPrivacyOptionsForm();
```

UMP needs the AdMob app id in the app (`GADApplicationIdentifier` in Info.plist; the
`com.google.android.gms.ads.APPLICATION_ID` meta-data on Android) and a consent message published in the
AdMob console that lists AppLovin among its ad partners.

## Ads

```typescript
await ApplovinMax.loadInterstitial({ adUnitId });   // resolves when LOADED, rejects when it failed
await ApplovinMax.showInterstitial({ placement });   // { shown: false } when nothing is ready; else adDisplayed / adDisplayFailed / adHidden follow
const { heightPx } = await ApplovinMax.showBanner({ adUnitId });   // more sizes arrive as `bannerLayout`
```

⚠️ **A blank `adUnitId` crashes the app** on the native main thread. Gate every call that takes one.

Events: `adLoaded`, `adLoadFailed`, `adDisplayed`, `adDisplayFailed`, `adHidden`, `adClicked`,
`adRevenuePaid` (revenue in USD, major units), `adRewardEarned` (retained across a webview reload),
`bannerLayout`. Every ad event carries `format`.

## Mediation

This plugin is single-network MAX today. Adding mediated networks (adapters via CocoaPods with a local
`AppLovinSDK` stub podspec on iOS, Gradle on Android) is documented in the engine's
`docs/native-and-sdks.md` § "AppLovin MAX Mediation".
