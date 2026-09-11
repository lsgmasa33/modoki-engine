import Capacitor
import AppLovinSDK

@objc(ApplovinMaxPlugin)
public class ApplovinMaxPlugin: CAPPlugin, MAAdViewAdDelegate, MAAdDelegate, MARewardedAdDelegate, CAPBridgedPlugin {

    public let identifier = "ApplovinMaxPlugin"
    public let jsName = "ApplovinMax"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "showBanner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideBanner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroyBanner", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBannerBackgroundColor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBannerPlacement", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMRec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hideMRec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroyMRec", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadInterstitial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroyInterstitial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showInterstitial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInterstitialExtraParameter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadRewardedAd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showRewardedAd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRewardedExtraParameter", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHasUserConsent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDoNotSell", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIsAgeRestrictedUser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUserId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVerboseLogging", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTestDeviceAdvertisingIds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMediationDebugger", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isReady", returnType: CAPPluginReturnPromise),
    ]

    private var bannerAd: MAAdView?
    private var mrecAd: MAAdView?
    private var interstitialAd: MAInterstitialAd?
    private var rewardedAd: MARewardedAd?

    // MARK: - Helper

    private func adInfoDict(_ ad: MAAd) -> [String: Any] {
        return [
            "adUnitId": ad.adUnitIdentifier,
            "networkName": ad.networkName,
            "revenue": ad.revenue,
            "revenuePrecision": ad.revenuePrecision,
            "creativeId": ad.creativeIdentifier ?? "",
            "placement": ad.placement ?? ""
        ]
    }

    // MARK: - Banner

    @objc func showBanner(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        let position = call.getString("position") ?? "bottom"
        DispatchQueue.main.async {
            if self.bannerAd == nil {
                self.bannerAd = MAAdView(adUnitIdentifier: adUnitId)
                self.bannerAd?.delegate = self
                let safeBottom = self.bridge?.viewController?.view.safeAreaInsets.bottom ?? 0
                let safeTop = self.bridge?.viewController?.view.safeAreaInsets.top ?? 0
                let h: CGFloat = 50
                let y = position == "top" ? safeTop : UIScreen.main.bounds.height - h - safeBottom
                self.bannerAd?.frame = CGRect(x: 0, y: y, width: UIScreen.main.bounds.width, height: h)
                self.bridge?.viewController?.view.addSubview(self.bannerAd!)
            }
            self.bannerAd?.loadAd()
            self.bannerAd?.isHidden = false
            call.resolve(["ok": true])
        }
    }

    @objc func hideBanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.bannerAd?.isHidden = true
            call.resolve(["ok": true])
        }
    }

    @objc func destroyBanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.bannerAd?.removeFromSuperview()
            self.bannerAd = nil
            call.resolve(["ok": true])
        }
    }

    @objc func setBannerBackgroundColor(_ call: CAPPluginCall) {
        let hex = call.getString("color") ?? "#000000"
        DispatchQueue.main.async {
            self.bannerAd?.backgroundColor = UIColor(hex: hex)
            call.resolve(["ok": true])
        }
    }

    @objc func setBannerPlacement(_ call: CAPPluginCall) {
        let placement = call.getString("placement") ?? ""
        self.bannerAd?.placement = placement
        call.resolve(["ok": true])
    }

    // MARK: - MREC

    @objc func showMRec(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            if self.mrecAd == nil {
                self.mrecAd = MAAdView(adUnitIdentifier: adUnitId, adFormat: .mrec)
                self.mrecAd?.delegate = self
                let w: CGFloat = 300
                let h: CGFloat = 250
                let x = (UIScreen.main.bounds.width - w) / 2
                let y = (UIScreen.main.bounds.height - h) / 2
                self.mrecAd?.frame = CGRect(x: x, y: y, width: w, height: h)
                self.bridge?.viewController?.view.addSubview(self.mrecAd!)
            }
            self.mrecAd?.loadAd()
            self.mrecAd?.isHidden = false
            call.resolve(["ok": true])
        }
    }

    @objc func hideMRec(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.mrecAd?.isHidden = true
            call.resolve(["ok": true])
        }
    }

    @objc func destroyMRec(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.mrecAd?.removeFromSuperview()
            self.mrecAd = nil
            call.resolve(["ok": true])
        }
    }

    // MARK: - Interstitial

    @objc func loadInterstitial(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            // ⚠️ Deliberately NOT nil-ing the previous instance's delegate here. Court's ads.ts
            // calls showInterstitial() then immediately calls loadInterstitial() again to preload
            // the next one — and showInterstitial's promise resolves right after show() is invoked,
            // NOT after the ad is actually dismissed (didHide fires later, once the player closes
            // it). So clearing the delegate here would run while the PREVIOUS instance is still ON
            // SCREEN, detaching its revenue delegate mid-impression and silently dropping that
            // impression's didPayRevenue. If a previous instance ever needs cleaning up, do it
            // through `destroyInterstitial` (used correctly by cleanupAds()) or by moving the
            // preload call to fire from the didHide delegate callback instead — never here.
            // (MAInterstitialAd exposes no explicit destroy() in the vendored SDK — it is a plain
            // object, not a view, and is reclaimed by ARC once nothing retains it.)
            self.interstitialAd = MAInterstitialAd(adUnitIdentifier: adUnitId)
            self.interstitialAd?.delegate = self
            self.interstitialAd?.load()
            call.resolve(["ok": true])
        }
    }

    @objc func destroyInterstitial(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.interstitialAd?.delegate = nil
            self.interstitialAd = nil
            call.resolve(["ok": true])
        }
    }

    @objc func showInterstitial(_ call: CAPPluginCall) {
        let placement = call.getString("placement")
        DispatchQueue.main.async {
            if self.interstitialAd?.isReady ?? false {
                if let p = placement { self.interstitialAd?.show(forPlacement: p) }
                else { self.interstitialAd?.show() }
                call.resolve(["shown": true])
            } else {
                call.resolve(["shown": false, "reason": "not ready"])
            }
        }
    }

    @objc func setInterstitialExtraParameter(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        let value = call.getString("value") ?? ""
        self.interstitialAd?.setExtraParameterForKey(key, value: value)
        call.resolve(["ok": true])
    }

    // MARK: - Rewarded

    @objc func loadRewardedAd(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            self.rewardedAd = MARewardedAd.shared(withAdUnitIdentifier: adUnitId)
            self.rewardedAd?.delegate = self
            self.rewardedAd?.load()
            call.resolve(["ok": true])
        }
    }

    @objc func showRewardedAd(_ call: CAPPluginCall) {
        let placement = call.getString("placement")
        DispatchQueue.main.async {
            if self.rewardedAd?.isReady ?? false {
                if let p = placement { self.rewardedAd?.show(forPlacement: p) }
                else { self.rewardedAd?.show() }
                call.resolve(["shown": true])
            } else {
                call.resolve(["shown": false, "reason": "not ready"])
            }
        }
    }

    @objc func setRewardedExtraParameter(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        let value = call.getString("value") ?? ""
        self.rewardedAd?.setExtraParameterForKey(key, value: value)
        call.resolve(["ok": true])
    }

    // MARK: - Privacy / Consent

    @objc func setHasUserConsent(_ call: CAPPluginCall) {
        let consent = call.getBool("consent") ?? false
        ALPrivacySettings.setHasUserConsent(consent)
        call.resolve(["ok": true])
    }

    @objc func setDoNotSell(_ call: CAPPluginCall) {
        let doNotSell = call.getBool("doNotSell") ?? false
        ALPrivacySettings.setDoNotSell(doNotSell)
        call.resolve(["ok": true])
    }

    @objc func setIsAgeRestrictedUser(_ call: CAPPluginCall) {
        // setIsAgeRestrictedUser removed in AppLovin SDK 13.x — no-op for compatibility
        call.resolve(["ok": true])
    }

    // MARK: - SDK Settings

    @objc func initialize(_ call: CAPPluginCall) {
        let sdkKey = call.getString("sdkKey") ?? ""
        DispatchQueue.main.async {
            let initConfig = ALSdkInitializationConfiguration(sdkKey: sdkKey) { builder in
                builder.mediationProvider = ALMediationProviderMAX
            }
            ALSdk.shared().initialize(with: initConfig) { _ in
                call.resolve(["ok": true])
            }
        }
    }

    @objc func setUserId(_ call: CAPPluginCall) {
        let userId = call.getString("userId") ?? ""
        ALSdk.shared().settings.userIdentifier = userId
        call.resolve(["ok": true])
    }

    @objc func setMuted(_ call: CAPPluginCall) {
        let muted = call.getBool("muted") ?? false
        ALSdk.shared().settings.isMuted = muted
        call.resolve(["ok": true])
    }

    @objc func setVerboseLogging(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        ALSdk.shared().settings.isVerboseLoggingEnabled = enabled
        call.resolve(["ok": true])
    }

    @objc func setTestDeviceAdvertisingIds(_ call: CAPPluginCall) {
        // testDeviceAdvertisingIdentifiers removed in AppLovin SDK 13.x — use dashboard
        call.resolve(["ok": true])
    }

    @objc func showMediationDebugger(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ALSdk.shared().showMediationDebugger()
            call.resolve(["ok": true])
        }
    }

    @objc func isReady(_ call: CAPPluginCall) {
        call.resolve([
            "initialized": ALSdk.shared().isInitialized,
            "interstitialReady": self.interstitialAd?.isReady ?? false,
            "rewardedReady": self.rewardedAd?.isReady ?? false
        ])
    }

    // MARK: - Ad Delegates

    public func didLoad(_ ad: MAAd) {
        notifyListeners("adLoaded", data: adInfoDict(ad))
    }

    public func didFailToLoadAd(forAdUnitIdentifier id: String, withError error: MAError) {
        notifyListeners("adLoadFailed", data: [
            "adUnitId": id,
            "errorCode": error.code.rawValue,
            "errorMessage": error.message
        ])
    }

    public func didDisplay(_ ad: MAAd) {
        notifyListeners("adDisplayed", data: adInfoDict(ad))
    }

    public func didHide(_ ad: MAAd) {
        // Auto-reload
        if ad.format == .interstitial { interstitialAd?.load() }
        if ad.format == .rewarded { rewardedAd?.load() }
        notifyListeners("adHidden", data: adInfoDict(ad))
    }

    public func didClick(_ ad: MAAd) {
        notifyListeners("adClicked", data: adInfoDict(ad))
    }

    public func didFail(toDisplay ad: MAAd, withError error: MAError) {
        notifyListeners("adLoadFailed", data: [
            "adUnitId": ad.adUnitIdentifier,
            "errorCode": error.code.rawValue,
            "errorMessage": error.message
        ])
    }

    public func didExpand(_ ad: MAAd) {}
    public func didCollapse(_ ad: MAAd) {}

    public func didPayRevenue(for ad: MAAd) {
        notifyListeners("adRevenuePaid", data: adInfoDict(ad))
    }

    public func didRewardUser(for ad: MAAd, with reward: MAReward) {
        // retainUntilConsumed: true — a webview reload tears down the JS realm and its
        // subscription along with it; with no listener attached, CAPPlugin queues this event
        // instead of dropping it, and drains it into the next realm's subscribe. It cannot
        // double-deliver: retention only fires when the listener list is empty, so a delivery
        // that DID have a listener is never retained. Same mechanism as ModokiIapPlugin's
        // `purchasesUpdated` (#586) — but this one matters MORE: there is no durable ledger and
        // no reconcile() step behind a reward. If this event is truly dropped (not merely
        // delayed by retention), the player watched the entire rewarded video and receives
        // nothing, with no code path anywhere able to detect or recover it later.
        notifyListeners(
            "adRewardEarned",
            data: [
                "adUnitId": ad.adUnitIdentifier,
                "label": reward.label,
                "amount": reward.amount
            ],
            retainUntilConsumed: true
        )
    }
}

// MARK: - UIColor hex extension
extension UIColor {
    convenience init(hex: String) {
        var hexStr = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if hexStr.hasPrefix("#") { hexStr.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: hexStr).scanHexInt64(&rgb)
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
            green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
            blue: CGFloat(rgb & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
}
