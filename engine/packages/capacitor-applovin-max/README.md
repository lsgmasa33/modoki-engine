# capacitor-applovin-max

Capacitor 8 plugin for **AppLovin MAX** ad mediation. Supports banner, MREC, interstitial, and rewarded ads with 12 mediation networks.

## Installation

```bash
npm install capacitor-applovin-max
npx cap sync
```

The core AppLovin SDK is provided via **SPM** (iOS) and **Gradle** (Android). No CocoaPods needed for the SDK itself.

## Mediation Networks

12 networks supported: Amazon, BidMachine, DT Exchange, Facebook, Google AdMob, Google Ad Manager, InMobi, Liftoff/Vungle, Moloco, Smaato, Unity Ads, Verve.

**iOS**: Adapters installed via CocoaPods. A local **stub podspec** (`ios/App/local_pods/AppLovinSDK/`) satisfies adapter dependency on `AppLovinSDK` without duplicating the SPM-provided framework. Requires `s.static_framework = true` on the stub.

**Android**: Adapters installed via Gradle dependencies in `app/build.gradle`. Additional Maven repos required for BidMachine, Smaato, Verve, and Amazon.

## Native Initialization

The SDK must be initialized natively before the WebView loads:

**iOS** — `AppDelegate.swift`:
```swift
import AppLovinSDK

let config = ALSdkInitializationConfiguration(sdkKey: "YOUR_SDK_KEY") { builder in
    builder.mediationProvider = ALMediationProviderMAX
}
ALSdk.shared().initialize(with: config) { _ in }
```

**Android** — `MainActivity.java`:
```java
AppLovinSdk.getInstance(this).initialize(config -> { });
```

## API

```typescript
import { ApplovinMax } from 'capacitor-applovin-max';
```

### SDK Lifecycle

| Method | Description |
|---|---|
| `initialize({ sdkKey })` | Initialize the SDK (usually done natively instead) |
| `isReady()` | Check SDK + ad unit readiness |
| `setUserId({ userId })` | Set user ID for analytics |
| `showMediationDebugger()` | Open the mediation debugger UI |

### Banner Ads

| Method | Description |
|---|---|
| `showBanner({ adUnitId, position? })` | Show banner (`'top'` or `'bottom'`) |
| `hideBanner()` | Hide banner |
| `destroyBanner()` | Destroy banner instance |
| `setBannerBackgroundColor({ color })` | Set background color (hex) |
| `setBannerPlacement({ placement })` | Set placement name for reporting |

### MREC Ads

| Method | Description |
|---|---|
| `showMRec({ adUnitId, position? })` | Show MREC (`'top'`, `'bottom'`, `'center'`) |
| `hideMRec()` | Hide MREC |
| `destroyMRec()` | Destroy MREC instance |

### Interstitial Ads

| Method | Description |
|---|---|
| `loadInterstitial({ adUnitId })` | Pre-load interstitial |
| `showInterstitial({ placement? })` | Show interstitial (returns `{ shown, reason? }`) |
| `setInterstitialExtraParameter({ key, value })` | Set extra parameter |

### Rewarded Ads

| Method | Description |
|---|---|
| `loadRewardedAd({ adUnitId })` | Pre-load rewarded ad |
| `showRewardedAd({ placement? })` | Show rewarded ad (returns `{ shown, reason? }`) |
| `setRewardedExtraParameter({ key, value })` | Set extra parameter |

### Privacy & Consent

| Method | Description |
|---|---|
| `setHasUserConsent({ consent })` | Set GDPR consent |
| `setDoNotSell({ doNotSell })` | Set CCPA do-not-sell |
| `setIsAgeRestrictedUser({ ageRestricted })` | Set COPPA age restriction |

### Events

```typescript
ApplovinMax.addListener('adLoaded', (info) => { });
ApplovinMax.addListener('adLoadFailed', (info) => { });
ApplovinMax.addListener('adDisplayed', (info) => { });
ApplovinMax.addListener('adHidden', (info) => { });
ApplovinMax.addListener('adClicked', (info) => { });
ApplovinMax.addListener('adRevenuePaid', (info) => { });
ApplovinMax.addListener('adRewardEarned', (info) => { });
```

## Platform Requirements

- iOS 15.0+, Xcode 15+
- Android API 21+, JDK 21
- Capacitor 8
