import Capacitor
import AppLovinSDK
import UserMessagingPlatform

@objc(ApplovinMaxPlugin)
public class ApplovinMaxPlugin: CAPPlugin, MAAdViewAdDelegate, MAAdDelegate, MARewardedAdDelegate, MAAdRevenueDelegate, MAAdExpirationDelegate, CAPBridgedPlugin {

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
        CAPPluginMethod(name: "requestConsentInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showConsentForm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPrivacyOptionsForm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHasUserConsent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDoNotSell", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setUserId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVerboseLogging", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMediationDebugger", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isReady", returnType: CAPPluginReturnPromise),
    ]

    private var bannerHost: BannerHostView?
    /// The banner's last load failed, so the next `showBanner` re-loads rather than just resuming refresh.
    private var bannerLoadFailed = false
    private var mrecAd: MAAdView?
    private var interstitialAd: MAInterstitialAd?
    private var rewardedAd: MARewardedAd?
    /// The `load*` call waiting for its ad's `didLoad` / `didFailToLoadAd` — see `settleLoad`.
    private var pendingInterstitialLoad: CAPPluginCall?
    private var pendingRewardedLoad: CAPPluginCall?
    /// `initialize` runs ONCE per app PROCESS: MAX drops the listener of a second initialise issued while the
    /// first is still running (seen in the Android SDK; assumed of iOS, #1507), so every call waits here and
    /// the one completion settles them all. Static because MAX's own init state is per process and this plugin
    /// instance is not guaranteed to be. Main thread only.
    private static var initState = InitState.idle
    private static var pendingInitCalls: [CAPPluginCall] = []
    private enum InitState { case idle, running, done }

    // MARK: - Helpers

    /// A LEADER is what MAX serves through a banner unit on an iPad; to the caller it is the same slot.
    private func formatName(_ format: MAAdFormat) -> String {
        if format == .banner || format == .leader { return "banner" }
        if format == .mrec { return "mrec" }
        if format == .interstitial { return "interstitial" }
        if format == .rewarded { return "rewarded" }
        return "unknown"
    }

    /// `didFailToLoadAd` carries only the unit id, so the format comes from which of OUR instances owns it.
    private func formatName(forAdUnitId id: String) -> String {
        if interstitialAd?.adUnitIdentifier == id { return "interstitial" }
        if rewardedAd?.adUnitIdentifier == id { return "rewarded" }
        if bannerHost?.adView.adUnitIdentifier == id { return "banner" }
        if mrecAd?.adUnitIdentifier == id { return "mrec" }
        return "unknown"
    }

    private func adInfoDict(_ ad: MAAd) -> [String: Any] {
        return [
            "adUnitId": ad.adUnitIdentifier,
            "format": formatName(ad.format),
            "networkName": ad.networkName,
            // MAX reports every network's revenue in US dollars, major units.
            "revenue": ad.revenue,
            "currency": "USD",
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
            guard let container = self.bridge?.viewController?.view else {
                call.reject("No view to attach the banner to")
                return
            }
            if let host = self.bannerHost {
                host.isHidden = false
                if self.bannerLoadFailed {
                    self.bannerLoadFailed = false
                    host.adView.loadAd()
                }
                // Always: a load does not resume a refresh that `hideBanner` or a failure paused.
                host.adView.startAutoRefresh()
            } else {
                let config = MAAdViewConfiguration { builder in
                    builder.adaptiveType = .anchored
                }
                let adView = MAAdView(adUnitIdentifier: adUnitId, configuration: config)
                // Without this, `stopAutoRefresh` does nothing until the first ad has loaded, and a manual
                // `loadAd` after a stop is refused — both of which the hide / re-load-after-failure paths
                // need (AppLovin's documented stop → loadAd → startAutoRefresh sequence). A refresh already
                // in flight when the banner is hidden still completes, and may still report a failure.
                adView.setExtraParameterForKey("allow_pause_auto_refresh_immediately", value: "true")
                adView.delegate = self
                adView.revenueDelegate = self
                let host = BannerHostView(adView: adView)
                host.onLayout = { [weak self] width, height in
                    self?.notifyListeners("bannerLayout", data: ["heightPx": height, "widthPx": width])
                }
                container.addSubview(host)
                // Pinned to the SAFE AREA, not the screen: rotation, an iPad's landscape bounds and a
                // resized window all reach the banner through these constraints (#1316's overlap was a
                // frame computed once from `UIScreen` bounds).
                let guide = container.safeAreaLayoutGuide
                NSLayoutConstraint.activate([
                    host.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
                    host.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
                    position == "top"
                        ? host.topAnchor.constraint(equalTo: guide.topAnchor)
                        : host.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
                ])
                self.bannerHost = host
                self.bannerLoadFailed = false
                adView.loadAd()
            }
            container.layoutIfNeeded()
            call.resolve(["ok": true, "heightPx": self.bannerHost?.laidOutHeight ?? 0])
        }
    }

    @objc func hideBanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let host = self.bannerHost {
                host.isHidden = true
                host.adView.stopAutoRefresh()
            }
            call.resolve(["ok": true])
        }
    }

    @objc func destroyBanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let host = self.bannerHost {
                host.adView.delegate = nil
                host.adView.revenueDelegate = nil
                host.onLayout = nil
                host.removeFromSuperview()
            }
            self.bannerHost = nil
            self.bannerLoadFailed = false
            call.resolve(["ok": true])
        }
    }

    @objc func setBannerBackgroundColor(_ call: CAPPluginCall) {
        let hex = call.getString("color") ?? "#000000"
        DispatchQueue.main.async {
            self.bannerHost?.adView.backgroundColor = UIColor(hex: hex)
            call.resolve(["ok": true])
        }
    }

    @objc func setBannerPlacement(_ call: CAPPluginCall) {
        let placement = call.getString("placement") ?? ""
        DispatchQueue.main.async {
            self.bannerHost?.adView.placement = placement
            call.resolve(["ok": true])
        }
    }

    // MARK: - MREC

    @objc func showMRec(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            if self.mrecAd == nil {
                self.mrecAd = MAAdView(adUnitIdentifier: adUnitId, adFormat: .mrec)
                self.mrecAd?.delegate = self
                self.mrecAd?.revenueDelegate = self
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

    // MARK: - Fullscreen loads

    /// Settle a pending `load*` call. A load RESOLVES on `didLoad` and REJECTS on `didFailToLoadAd`, so the
    /// caller awaits the ad itself instead of racing its own listener against the call.
    private func settleLoad(_ format: String, error: MAError? = nil, rejection: (message: String, code: String)? = nil) {
        let call: CAPPluginCall?
        if format == "interstitial" {
            call = pendingInterstitialLoad
            pendingInterstitialLoad = nil
        } else if format == "rewarded" {
            call = pendingRewardedLoad
            pendingRewardedLoad = nil
        } else {
            return
        }
        guard let call = call else { return }
        if let error = error {
            call.reject(error.message, String(error.code.rawValue))
        } else if let rejection = rejection {
            call.reject(rejection.message, rejection.code)
        } else {
            call.resolve(["ok": true])
        }
    }

    // MARK: - Interstitial

    @objc func loadInterstitial(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            self.settleLoad("interstitial", rejection: ("a newer loadInterstitial replaced this one", "superseded"))
            // MAX IGNORES a load while its ad is on screen — no callback at all — so the call would never
            // settle. Reachable: the lifecycle's show timeout can schedule a preload while a late-presenting
            // ad is still up. Refuse it; the caller's back-off retries.
            if self.interstitialAd?.adUnitIdentifier == adUnitId, self.interstitialAd?.isShowing == true {
                call.reject("the interstitial is on screen; load again after it is dismissed", "showing")
                return
            }
            // One instance per unit id, re-used for every load — MAX's own pattern.
            if self.interstitialAd?.adUnitIdentifier != adUnitId {
                self.interstitialAd?.delegate = nil
                self.interstitialAd?.revenueDelegate = nil
                self.interstitialAd?.expirationDelegate = nil
                self.interstitialAd = MAInterstitialAd(adUnitIdentifier: adUnitId)
                self.interstitialAd?.delegate = self
                // ⚠️ Revenue is its OWN delegate. Without this line `didPayRevenue` never fires on iOS.
                self.interstitialAd?.revenueDelegate = self
                // A SUCCESSFUL expiry reload is reported only here, never as `didLoad` — see `didReloadExpiredAd`.
                self.interstitialAd?.expirationDelegate = self
            }
            // Already loaded: settle now. What MAX does with a load on top of a loaded ad is not documented.
            if self.interstitialAd?.isReady == true {
                call.resolve(["ok": true])
                return
            }
            self.pendingInterstitialLoad = call
            self.interstitialAd?.load()
        }
    }

    @objc func destroyInterstitial(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.settleLoad("interstitial", rejection: ("the interstitial was destroyed", "destroyed"))
            self.interstitialAd?.delegate = nil
            self.interstitialAd?.revenueDelegate = nil
            self.interstitialAd?.expirationDelegate = nil
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
        DispatchQueue.main.async {
            self.interstitialAd?.setExtraParameterForKey(key, value: value)
            call.resolve(["ok": true])
        }
    }

    // MARK: - Rewarded

    @objc func loadRewardedAd(_ call: CAPPluginCall) {
        let adUnitId = call.getString("adUnitId") ?? ""
        DispatchQueue.main.async {
            self.settleLoad("rewarded", rejection: ("a newer loadRewardedAd replaced this one", "superseded"))
            // See loadInterstitial: MAX ignores a load while its ad is on screen, and the call would hang.
            if self.rewardedAd?.adUnitIdentifier == adUnitId, self.rewardedAd?.isShowing == true {
                call.reject("the rewarded ad is on screen; load again after it is dismissed", "showing")
                return
            }
            self.rewardedAd = MARewardedAd.shared(withAdUnitIdentifier: adUnitId)
            self.rewardedAd?.delegate = self
            self.rewardedAd?.revenueDelegate = self
            self.rewardedAd?.expirationDelegate = self
            // See loadInterstitial.
            if self.rewardedAd?.isReady == true {
                call.resolve(["ok": true])
                return
            }
            self.pendingRewardedLoad = call
            self.rewardedAd?.load()
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
        DispatchQueue.main.async {
            self.rewardedAd?.setExtraParameterForKey(key, value: value)
            call.resolve(["ok": true])
        }
    }

    // MARK: - Consent (Google UMP)

    private func consentStatusString(_ status: ConsentStatus) -> String {
        switch status {
        case .required: return "REQUIRED"
        case .notRequired: return "NOT_REQUIRED"
        case .obtained: return "OBTAINED"
        default: return "UNKNOWN"
        }
    }

    private func consentInfo(includeFormAvailability: Bool) -> [String: Any] {
        let info = ConsentInformation.shared
        var result: [String: Any] = [
            "status": consentStatusString(info.consentStatus),
            "canRequestAds": info.canRequestAds,
            "privacyOptionsRequired": info.privacyOptionsRequirementStatus == .required
        ]
        if includeFormAvailability { result["isConsentFormAvailable"] = info.formStatus == .available }
        return result
    }

    @objc func requestConsentInfo(_ call: CAPPluginCall) {
        let parameters = RequestParameters()
        let debugSettings = DebugSettings()
        // UMP's raw values: 1 = EEA, 2 = not EEA. Anything else leaves the real geography in charge.
        switch call.getString("debugGeography") {
        case "eea": debugSettings.geography = DebugGeography(rawValue: 1) ?? .disabled
        case "not_eea": debugSettings.geography = DebugGeography(rawValue: 2) ?? .disabled
        default: debugSettings.geography = .disabled
        }
        debugSettings.testDeviceIdentifiers = call.getArray("testDeviceIdentifiers", String.self) ?? []
        parameters.debugSettings = debugSettings
        parameters.isTaggedForUnderAgeOfConsent = call.getBool("tagForUnderAgeOfConsent") ?? false
        DispatchQueue.main.async {
            ConsentInformation.shared.requestConsentInfoUpdate(with: parameters) { error in
                if let error = error {
                    call.reject("Request consent info failed: \(error.localizedDescription)")
                } else {
                    call.resolve(self.consentInfo(includeFormAvailability: true))
                }
            }
        }
    }

    @objc func showConsentForm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("No view controller to present the consent form from")
                return
            }
            guard ConsentInformation.shared.formStatus == .available else {
                call.reject("Consent form not available")
                return
            }
            Task { @MainActor in
                do {
                    try await ConsentForm.loadAndPresentIfRequired(from: vc)
                    call.resolve(self.consentInfo(includeFormAvailability: false))
                } catch {
                    call.reject("Consent form failed: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc func showPrivacyOptionsForm(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("No view controller to present the privacy options form from")
                return
            }
            Task { @MainActor in
                do {
                    try await ConsentForm.presentPrivacyOptionsForm(from: vc)
                    call.resolve()
                } catch {
                    call.reject("Privacy options form failed: \(error.localizedDescription)")
                }
            }
        }
    }

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

    // MARK: - SDK Settings

    @objc func initialize(_ call: CAPPluginCall) {
        let sdkKey = call.getString("sdkKey") ?? ""
        let testDevices = call.getArray("testDeviceAdvertisingIds", String.self) ?? []
        DispatchQueue.main.async {
            // A later call's sdkKey and test devices are ignored, as MAX itself ignores them after the first.
            if ApplovinMaxPlugin.initState == .done || ALSdk.shared().isInitialized {
                ApplovinMaxPlugin.initState = .done
                call.resolve(["ok": true])
                return
            }
            ApplovinMaxPlugin.pendingInitCalls.append(call)
            if ApplovinMaxPlugin.initState == .running { return }
            ApplovinMaxPlugin.initState = .running
            let initConfig = ALSdkInitializationConfiguration(sdkKey: sdkKey) { builder in
                builder.mediationProvider = ALMediationProviderMAX
                // SDK 13 takes test devices only here — there is no setter after init.
                builder.testDeviceAdvertisingIdentifiers = testDevices
            }
            ALSdk.shared().initialize(with: initConfig) { _ in
                DispatchQueue.main.async {
                    ApplovinMaxPlugin.initState = .done
                    let calls = ApplovinMaxPlugin.pendingInitCalls
                    ApplovinMaxPlugin.pendingInitCalls = []
                    for waiting in calls { waiting.resolve(["ok": true]) }
                }
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

    @objc func showMediationDebugger(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            ALSdk.shared().showMediationDebugger()
            call.resolve(["ok": true])
        }
    }

    @objc func isReady(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "initialized": ALSdk.shared().isInitialized,
                "interstitialReady": self.interstitialAd?.isReady ?? false,
                "rewardedReady": self.rewardedAd?.isReady ?? false
            ])
        }
    }

    // MARK: - Ad Delegates

    public func didLoad(_ ad: MAAd) {
        let format = formatName(ad.format)
        if format == "banner" { bannerLoadFailed = false }
        settleLoad(format)
        notifyListeners("adLoaded", data: adInfoDict(ad))
    }

    public func didFailToLoadAd(forAdUnitIdentifier id: String, withError error: MAError) {
        let format = formatName(forAdUnitId: id)
        if format == "banner", let host = bannerHost {
            // Take the view down, as AdMob's SDK does on a failure: the lifecycle now believes no banner is
            // up (`bannerFailed`), so a view left behind could never be hidden by it — and an empty host
            // over the webview would swallow every tap in the strip. The next `showBanner` re-loads.
            bannerLoadFailed = true
            host.isHidden = true
            host.adView.stopAutoRefresh()
        }
        settleLoad(format, error: error)
        notifyListeners("adLoadFailed", data: [
            "adUnitId": id,
            "format": format,
            "errorCode": error.code.rawValue,
            "errorMessage": error.message
        ])
    }

    public func didDisplay(_ ad: MAAd) {
        notifyListeners("adDisplayed", data: adInfoDict(ad))
    }

    // No reload here: the caller owns when to load the next ad (it preloads on dismissal, with its own
    // back-off), and a second owner would double every load.
    public func didHide(_ ad: MAAd) {
        notifyListeners("adHidden", data: adInfoDict(ad))
    }

    public func didClick(_ ad: MAAd) {
        notifyListeners("adClicked", data: adInfoDict(ad))
    }

    public func didFail(toDisplay ad: MAAd, withError error: MAError) {
        notifyListeners("adDisplayFailed", data: [
            "adUnitId": ad.adUnitIdentifier,
            "format": formatName(ad.format),
            "errorCode": error.code.rawValue,
            "errorMessage": error.message
        ])
    }

    /// MAX reloads an expired fullscreen ad by itself and reports a SUCCESSFUL reload only here — `didLoad` is
    /// not invoked (`MAAdExpirationDelegate.h`). The rest is read from the Android SDK 13.6.4 and assumed of
    /// iOS: the ad stays READY during the reload, a load issued then is dropped without a callback, and a
    /// FAILED reload arrives as the ordinary `didFailToLoadAd`. Without this the parked call never settles (#1507).
    public func didReloadExpiredAd(_ expiredAd: MAAd, withNewAd newAd: MAAd) {
        settleLoad(formatName(newAd.format))
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

/// Hosts the banner's `MAAdView` and sizes it. The host is pinned to the safe area's side edges by the
/// plugin; its height is the ad format's ANCHORED ADAPTIVE height for the width it was actually given, so
/// it follows every width change (rotation, an iPad window) instead of a size fixed at creation.
final class BannerHostView: UIView {
    let adView: MAAdView
    /// Called with (width, height) whenever the laid-out size changes — never for an unchanged size.
    var onLayout: ((CGFloat, CGFloat) -> Void)?
    private var heightConstraint: NSLayoutConstraint!
    private var reported = CGSize.zero

    /// The height last reported, 0 before the first layout with a real width.
    var laidOutHeight: CGFloat { reported.height }

    init(adView: MAAdView) {
        self.adView = adView
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        adView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(adView)
        // 50 until the first layout gives a width to size against.
        heightConstraint = heightAnchor.constraint(equalToConstant: 50)
        NSLayoutConstraint.activate([
            adView.leadingAnchor.constraint(equalTo: leadingAnchor),
            adView.trailingAnchor.constraint(equalTo: trailingAnchor),
            adView.topAnchor.constraint(equalTo: topAnchor),
            adView.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightConstraint,
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("BannerHostView is created in code only")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        guard width > 0 else { return }
        // `adFormat` is a weak property, so Swift sees an optional; only a banner unit is hosted here.
        let height = (adView.adFormat ?? .banner).adaptiveSize(forWidth: width).height
        if heightConstraint.constant != height {
            heightConstraint.constant = height
            setNeedsLayout()
        }
        let size = CGSize(width: width, height: height)
        if size != reported {
            reported = size
            onLayout?(width, height)
        }
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
