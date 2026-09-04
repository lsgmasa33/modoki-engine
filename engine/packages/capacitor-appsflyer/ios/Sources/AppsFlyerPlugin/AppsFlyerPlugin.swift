import Capacitor
import AppsFlyerLib
import AppTrackingTransparency

@objc(AppsFlyerPlugin)
public class AppsFlyerPlugin: CAPPlugin, CAPBridgedPlugin, AppsFlyerLibDelegate {

    public let identifier = "AppsFlyerPlugin"
    public let jsName = "AppsFlyerCap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCustomerUserId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAppsFlyerUID", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAdvertisingId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConversionData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConsent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestTrackingAuthorization", returnType: CAPPluginReturnPromise),
    ]

    // The SDK delivers conversion data asynchronously via the delegate, not a
    // synchronous getter — getConversionData() returns whatever has been captured
    // so far (empty until onConversionDataSuccess fires).
    private var lastConversionData: [AnyHashable: Any] = [:]

    // ⚠️ PROCESS-scoped guard against start() running twice. A webview reload (or a
    // realm-survived false-alarm recovery, engine/app/realmDeathBackstop.ts) re-runs the JS
    // boot effect in the SAME native process, calling initialize() then start() again —
    // registerSessionReadyListener stacks a NEW listener rather than replacing the old one.
    //
    // ⚠️ WHAT IS MEASURED, AND WHAT IS NOT — read before trusting either direction.
    //   FOR the guard (#607, Galaxy S22, versionCode 6029, ONE process, PID 21451): a
    //   resume-reload produced a SECOND POST to launches.appsflyersdk.com, ~100 s after the
    //   cold-boot one, alongside a second "[AppsFlyer] Initialized for android".
    //   AGAINST it: attribution.md § "CLOSED: the four Launch events are the SDK's own
    //   transport" records the opposite on IOS, from the SDK's own verbose log — "an extra
    //   manual start() produces no new rows, since a second start is a no-op", with
    //   sessioncounter 1 in both payloads, i.e. DAU and sessions NOT inflated.
    // The two have NOT been reconciled: different platforms, different hosts, and the iOS probe
    // was a manual extra start() inside one session rather than one after a realm death. So this
    // guard is deliberately DEFENSIVE — inert if the iOS finding generalises, corrective if it
    // does not. Do not restate either measurement as settled SDK behaviour without a new one.
    //
    // ⚠️ Do NOT describe this as fixing the "4, 4, then 3 Launch events" variation documented on
    // start() below. attribution.md records that count as EXPLAINED (two hosts x two retries =
    // four rows) and the main-thread-race hypothesis for it as TESTED AND REFUTED — dispatching
    // the registration to main "did not change the count". That dispatch was kept because UIKit
    // off the main thread is undefined behaviour, not because it fixed a count.
    //
    // ⚠️ It also latches across a `stop(stopped:false)` opt-back-in: AppsFlyer's documented
    // re-enable flow is `isStopped = false` then a fresh `start()`, and that `start()` would hit
    // this guard and do nothing. Nothing calls `stop` from JS today (`attribution.ts` exposes no
    // wrapper), so this is a trap for whoever wires opt-out, not a live bug — clear the flag in
    // `stop()` when that day comes.
    //
    // Thread-safety, stated rather than assumed: Capacitor dispatches this plugin's methods on its
    // own per-plugin serial queue (the `Queue name: bridge` frame in the Main-Thread-Checker trace
    // quoted on `start()` below), so a non-atomic check-and-set here has no concurrent writer.
    private static var hasStarted = false

    // MARK: - Initialize

    @objc func initialize(_ call: CAPPluginCall) {
        let devKey = call.getString("devKey") ?? ""
        let appleAppId = call.getString("appleAppId") ?? ""
        let isDebug = call.getBool("isDebug") ?? false
        let waitForAttTimeoutSec = call.getDouble("waitForAttTimeoutSec") ?? 60

        // ⚠️ appleAppId is REQUIRED on iOS. Empty is not "degraded" — it CRASHES the host app.
        // Measured on an iPhone 8 (iOS 16.7.16), 2026-08-19: with an empty appId the SDK logs
        // "`appsFlyerDevKey` and `appleAppID` are now read-only properties" (its initialize
        // silently declines to set them), and the later registerSessionReadyListener call
        // throws NSInternalInconsistencyException — "devKey and appleAppID must be set before
        // calling registerSessionReadyListener:" — terminating the app right after the ATT
        // prompt. An earlier comment here called this merely "incomplete"; it is fatal.
        //
        // Refusing here is what keeps it non-fatal: the JS wrapper awaits this call, so a
        // reject means start() is never reached and the game runs on with attribution off.
        guard !appleAppId.isEmpty else {
            call.reject("appleAppId is required on iOS — without it the AppsFlyer SDK throws on start. Set the numeric App Store id in config.ts.")
            return
        }

        let af = AppsFlyerLib.shared()

        // SDK v7 — appsFlyerDevKey and appleAppID are READ-ONLY properties, set through
        // initialize(devKey:appId:). v6 assigned them directly; that no longer compiles.
        af.initialize(devKey: devKey, appId: appleAppId)
        af.isDebug = isDebug
        af.delegate = self

        // ⚠️ NO waitForATTUserAuthorization CALL HERE, AND THAT IS DELIBERATE.
        // v7 deprecated it outright: "The SDK no longer manages ATT timing internally."
        // So the ordering guarantee is now entirely OURS.
        //
        // The hazard is unchanged and LESS forgiving than on v6: start() before ATT
        // resolves means every install and event ships without IDFA on iOS 14+, silently —
        // no error, no crash, a dashboard that fills up blind. On v6 the SDK's own timer
        // absorbed a wrong call order; on v7 nothing does.
        //
        // What protects us is the call order in the CALLING app-service
        // (initialize → requestTrackingAuthorization → start), pinned by a test that fails
        // when the order is swapped. That test is now the ONLY guard, and it lives with each
        // consuming app rather than here — this plugin cannot enforce its own call order.
        //
        // waitForAttTimeoutSec stays in the API for callers pinned to v6, unused here.
        _ = waitForAttTimeoutSec

        call.resolve(["ok": true])
    }

    // MARK: - Start

    @objc func start(_ call: CAPPluginCall) {
        // Checked synchronously, before the dispatch below and before anything else in this
        // method runs — see hasStarted's own comment for why a second call must never reach
        // registerSessionReadyListener a second time.
        guard !AppsFlyerPlugin.hasStarted else {
            call.resolve(["ok": true])
            return
        }
        AppsFlyerPlugin.hasStarted = true

        // v7: the SDK never calls start() itself, and start() should run once it reports
        // readiness (config set, cold/warm-launch deeplink resolution settled behind a
        // bounded timeout so the listener always fires). Registering the listener and
        // starting inside it is the documented shape.
        //
        // ATT is explicitly NOT a readiness condition, which is exactly why the caller must
        // already have collected it before reaching here. See initialize().
        // ⚠️ MAIN QUEUE, and this is a fix rather than a precaution. Capacitor invokes plugin
        // methods on its own `bridge` queue, and `registerSessionReadyListener` reads
        // `-[UIApplication applicationState]` internally — a UIKit call, which off the main thread
        // is undefined behaviour. Xcode's Main Thread Checker caught it on an iPad mini
        // (2026-08-20), reporting the violation with this exact frame:
        //
        //   Main Thread Checker: UI API called on a background thread: -[UIApplication applicationState]
        //   5  -[AppsFlyerLib registerSessionReadyListener:]
        //   6  AppsFlyerPlugin.start(_:)          Queue name: bridge
        //
        // The visible symptom was a VARYING number of `Launch` events per cold start — 4, 4, then
        // 3 across otherwise identical fresh installs — which inflates sessions and DAU by an
        // amount nobody can predict. A race is the only thing that explains a count that changes
        // while the input does not. The SDK's own header also says to register in
        // `didFinishLaunching` and that the block is "always dispatched on the main queue", so
        // main is where the registration was always meant to happen.
        DispatchQueue.main.async {
            AppsFlyerLib.shared().registerSessionReadyListener {
                AppsFlyerLib.shared().start()
            }
        }
        call.resolve(["ok": true])
    }

    // MARK: - Events

    @objc func logEvent(_ call: CAPPluginCall) {
        let eventName = call.getString("eventName") ?? ""
        let eventValues = call.getObject("eventValues") ?? [:]

        // Fire-and-forget. The completion-handler form is a DIFFERENT selector
        // (logEvent(name:values:completionHandler:)), so a trailing closure on this one
        // does not compile.
        AppsFlyerLib.shared().logEvent(eventName, withValues: eventValues)

        call.resolve(["ok": true])
    }

    // MARK: - Customer user id

    @objc func setCustomerUserId(_ call: CAPPluginCall) {
        let userId = call.getString("userId") ?? ""
        AppsFlyerLib.shared().customerUserID = userId
        call.resolve(["ok": true])
    }

    // MARK: - Device id

    @objc func getAppsFlyerUID(_ call: CAPPluginCall) {
        let uid = AppsFlyerLib.shared().getAppsFlyerUID()
        call.resolve(["uid": uid])
    }

    /// The IDFA **as the SDK sees it** — deliberately `AppsFlyerLib`'s own readonly
    /// `advertisingIdentifier` rather than `ASIdentifierManager`.
    ///
    /// Two reasons. It answers the question actually worth asking — *what will AppsFlyer SEND* —
    /// rather than what the OS would hand a fresh caller; and it needs no `AdSupport` import, so
    /// this stays a read of state the app already collects rather than a new capability.
    ///
    /// ⚠️ Empty or all-zero is a NORMAL answer, not a failure: without ATT authorization there is
    /// no IDFA to report. `authorized` is reported separately by `requestTrackingAuthorization`,
    /// so a caller can tell "denied" from "not yet resolved" — which the AppsFlyer raw reports
    /// cannot, since they simply omit the column (measured 2026-08-20).
    ///
    /// Its practical use is registering a TEST DEVICE in the AppsFlyer dashboard, which is keyed
    /// on the IDFA and otherwise needs AppsFlyer's own utility app installed just to read it.
    @objc func getAdvertisingId(_ call: CAPPluginCall) {
        let idfa = AppsFlyerLib.shared().advertisingIdentifier ?? ""
        let zero = "00000000-0000-0000-0000-000000000000"
        call.resolve([
            // `id` + `kind`, not `idfa` — the Android half returns a GAID, and a field named for
            // one platform's identifier forces every caller to branch on the platform to read it.
            "id": idfa,
            "kind": "idfa",
            // Stated rather than left for the caller to pattern-match: all-zero and empty both
            // mean "no IDFA", and they arrive from different layers.
            "available": !idfa.isEmpty && idfa != zero,
            // iOS has no separate limit-ad-tracking flag; ATT authorization IS the gate, and
            // `requestTrackingAuthorization()` reports it. Present so the shape matches Android.
            "limitAdTracking": false,
        ])
    }

    // MARK: - Conversion data

    @objc func getConversionData(_ call: CAPPluginCall) {
        call.resolve(["data": lastConversionData])
    }

    // MARK: - Consent (DMA/GDPR)

    @objc func setConsent(_ call: CAPPluginCall) {
        let hasConsentForDataUsage = call.getBool("hasConsentForDataUsage")
        let hasConsentForAdsPersonalization = call.getBool("hasConsentForAdsPersonalization")

        if hasConsentForDataUsage != nil || hasConsentForAdsPersonalization != nil {
            // v7 takes NSNumber? per field so "unspecified" is representable as nil; the
            // Bool-based initializers are deprecated. nil for a field the caller did not set
            // is meaningfully different from false.
            let consent = AppsFlyerConsent(
                isUserSubjectToGDPR: NSNumber(value: true),
                hasConsentForDataUsage: hasConsentForDataUsage.map { NSNumber(value: $0) },
                hasConsentForAdsPersonalization: hasConsentForAdsPersonalization.map { NSNumber(value: $0) },
                hasConsentForAdStorage: nil
            )
            AppsFlyerLib.shared().setConsentData(consent)
        }

        call.resolve(["ok": true])
    }

    // MARK: - Stop / opt-out

    @objc func stop(_ call: CAPPluginCall) {
        let stopped = call.getBool("stopped") ?? false
        AppsFlyerLib.shared().isStopped = stopped
        call.resolve(["ok": true])
    }

    // MARK: - ATT

    @objc func requestTrackingAuthorization(_ call: CAPPluginCall) {
        if #available(iOS 14, *) {
            ATTrackingManager.requestTrackingAuthorization { status in
                let mapped: String
                switch status {
                case .authorized: mapped = "authorized"
                case .denied: mapped = "denied"
                case .restricted: mapped = "restricted"
                case .notDetermined: mapped = "notDetermined"
                @unknown default: mapped = "notDetermined"
                }
                call.resolve(["status": mapped])
            }
        } else {
            call.resolve(["status": "notSupported"])
        }
    }

    // MARK: - AppsFlyerLibDelegate

    public func onConversionDataSuccess(_ conversionInfo: [AnyHashable: Any]) {
        lastConversionData = conversionInfo
    }

    public func onConversionDataFail(_ error: Error) {
        // Nothing to do — getConversionData() simply keeps returning the last
        // successful payload (or empty, if none has arrived yet).
    }
}
