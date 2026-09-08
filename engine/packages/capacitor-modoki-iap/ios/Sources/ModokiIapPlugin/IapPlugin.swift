import Foundation
import Capacitor
import StoreKit
import os

/// os_log channel for the purchase timing probes (#580). Appears in Xcode's console with no
/// filtering, and is readable off a device with `device_native_logs subsystem:'com.modoki.iap'`
/// — `GameDebugPlugin.getNativeLogs` reads the same store.
private let iapLog = Logger(subsystem: "com.modoki.iap", category: "purchase")

/// Segment timings for ONE `purchase()` call (#580).
///
/// ⚠️ **Why this exists, and why it is not debug clutter to delete:** #580 measured every purchase
/// on the iPhone 8 taking 20-40 REAL seconds to settle, and stayed open for want of an answer to
/// "which await owned the wait". From JS the whole call is one opaque silence — a slow App Store
/// fetch, a slow confirmation sheet and slow local verification are indistinguishable from the
/// outside, which is exactly why the journal measurement in #580 could not root-cause anything.
///
/// Four marks partition that silence:
///
/// | mark | closes | reads as |
/// |---|---|---|
/// | `sched` | `purchase()` entry → the `Task` body actually running | main-actor / CPU starvation — #580's own wakeup-storm hypothesis, previously untestable |
/// | `A` | → `Product.products(for:)` returned | a network round-trip, and it happens BEFORE Apple's sheet is raised |
/// | `B` | → `product.purchase()` returned | StoreKit's sheet — **includes the human reading and tapping it** |
/// | `C` | → `verified()` returned | local signature check, no network |
///
/// ⚠️ **Every exit path is marked, including the throw and both early rejects.** A MISSING line
/// must be readable as "never got there" and never as "that path was not instrumented" — an
/// unmarked branch would make the probe unable to detect its own positive case.
///
/// `.notice`, not `.info`/`.debug`, so the lines survive into the log store and show in Xcode
/// unfiltered. A purchase is a rare, human-paced event, so a handful of lines costs nothing; this
/// is deliberately not a per-frame probe.
///
/// Monotonic `DispatchTime`, never `Date()`: an NTP correction landing mid-purchase must not be
/// able to invent or erase a stall.
///
/// `@unchecked Sendable` is a HANDOFF, not shared state: the probe is constructed on the caller's
/// queue and then touched only from inside the one `Task` it was handed to, whose body is serial
/// even across its awaits. Nothing else ever holds a reference. The package builds in Swift 5
/// language mode (`swift-tools-version: 5.9`, no strict-concurrency flags), so this is belt and
/// braces against the App target compiling it under stricter settings — not a silenced race.
private final class PurchaseProbe: @unchecked Sendable {
    private let productId: String
    private let started: DispatchTime
    private var mark: DispatchTime

    init(_ productId: String) {
        self.productId = productId
        let now = DispatchTime.now()
        self.started = now
        self.mark = now
        PurchaseProbe.emit("[iap] \(productId) start")
    }

    /// ⚠️ **Emitted TWICE on purpose, and the duplication is the point** — measured on the iPhone 8,
    /// 2026-09-08, after the first run of these probes produced numbers nothing could read:
    ///
    /// - `Logger` (os_log) reaches Xcode's console and `OSLogStore`. But `device_native_logs
    ///   source:'app'` reads `OSLogStore` from inside the process, and on an iPhone 8 that scan
    ///   **exceeds the 5 s device timeout at every window size, including 20 s unfiltered** — so
    ///   over MCP, on the oldest supported handset, os_log is unreadable in practice.
    /// - `idevicesyslog` does not carry an app's own os_log at all (measured: 14 `App[]` lines in a
    ///   6-minute capture, every one from the launcher shim, and the plugin's own NSLog absent).
    ///
    /// `print` goes to stdout, which `idevicedebug run` captures to a file — the ONLY route that
    /// works headlessly on this device. Neither channel alone is enough, so both are written.
    private static func emit(_ line: String) {
        print(line)
        iapLog.notice("\(line, privacy: .public)")
    }

    /// Close one segment: its own cost, and the running total since `purchase()` was entered.
    /// Re-arms the mark, so segments partition the wait rather than overlapping it.
    func segment(_ name: String, _ outcome: String) {
        let now = DispatchTime.now()
        let line = String(
            format: "[iap] %@ %@ %@ in %.0f ms (total %.0f ms)",
            productId, name, outcome,
            PurchaseProbe.ms(mark, now), PurchaseProbe.ms(started, now)
        )
        mark = now
        PurchaseProbe.emit(line)
    }

    private static func ms(_ from: DispatchTime, _ to: DispatchTime) -> Double {
        Double(to.uptimeNanoseconds &- from.uptimeNanoseconds) / 1_000_000
    }
}

/**
 * Modoki's StoreKit 2 bridge (#196).
 *
 * ⚠️ **THE ONE RULE: this file calls `transaction.finish()` in exactly ONE place — the `finish()`
 * method, when JS asks.** Nowhere else. No `Transaction.updates` listener that finishes, no
 * tidy-up on launch, no finishing inside `purchase()`.
 *
 * That restraint IS the feature. StoreKit re-delivers an unfinished transaction on every launch,
 * forever, and that re-delivery is the only thing that makes a purchase interrupted by a crash or
 * a force-close recoverable. Finishing early throws the player's money away, silently and
 * permanently. The plugin this replaces (`@capgo/capacitor-native-purchases`) finishes
 * unconditionally inside its updates listener *before* notifying JS, which is precisely the bug
 * this package exists to not have.
 *
 * If you are adding a method here and reach for `.finish()`, stop and re-read the above.
 */
@objc(ModokiIapPlugin)
public class ModokiIapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ModokiIapPlugin"
    public let jsName = "ModokiIap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "entitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise)
    ]

    /// Watches for transactions that arrive with no `purchase()` call waiting — StoreKit delivers
    /// an Ask-to-Buy approval, a subscription renewal, or a re-delivery this way, minutes or days
    /// after the fact.
    ///
    /// ⚠️ **It NOTIFIES ONLY. It never calls `finish()`** — that is the whole difference between
    /// this plugin and `@capgo/capacitor-native-purchases`, whose equivalent listener finishes
    /// unconditionally before telling JS and so destroys the re-delivery that makes a crash
    /// survivable. JS decides when to finish, after the grant is durable.
    private var updatesTask: Task<Void, Never>?

    public override func load() {
        updatesTask = Task { [weak self] in
            for await result in StoreKit.Transaction.updates {
                guard let self, let t = self.verified(result) else { continue }
                // retainUntilConsumed: true — a webview reload tears down the JS realm and its
                // subscription along with it (#586); with no listener attached, CAPPlugin queues
                // this event instead of dropping it, and drains it into the next realm's
                // subscribe. It cannot double-deliver: retention only fires when the listener
                // list is empty, so a delivery that DID have a listener is never retained. And a
                // durable ledger keyed on `isProcessed` gives cross-realm idempotency regardless,
                // so a queued-then-redelivered event is harmless even if this were somehow wrong.
                self.notifyListeners(
                    "purchasesUpdated",
                    data: ["transactions": [self.serialize(t)]],
                    retainUntilConsumed: true
                )
            }
        }
    }

    deinit { updatesTask?.cancel() }

    // MARK: - Serialization

    /// One transaction as the JS contract expects it. `purchaseToken` is Android-only and is
    /// deliberately absent here; iOS finishes by `transactionId` alone.
    private func serialize(_ t: StoreKit.Transaction) -> [String: Any] {
        var out: [String: Any] = [
            "transactionId": String(t.id),
            "productId": t.productID
        ]
        // A revoked (refunded / family-sharing-removed) transaction must never read as owned.
        // currentEntitlements already excludes them, but unfinished() can still surface one.
        if t.revocationDate != nil {
            out["revoked"] = true
        }
        return out
    }

    /// Unwrap StoreKit's verification. An UNVERIFIED transaction is dropped, not passed on:
    /// its signature failed the OS's own check, and the engine's local-verification model rests on
    /// the platform having already vouched for what it is handed.
    private func verified(_ result: VerificationResult<StoreKit.Transaction>) -> StoreKit.Transaction? {
        switch result {
        case .verified(let t): return t
        case .unverified: return nil
        }
    }

    // MARK: - Error reporting

    /// Is this thrown error a cancel?
    ///
    /// StoreKit reports the ordinary cancel as a `.userCancelled` *result*, handled above — but it
    /// can also THROW one, and the two must land on the same JS outcome. A cancel that arrives as
    /// a rejection would be reported as `iap.purchase.failed` and reach `purchase_failed`
    /// analytics, which the design says a cancel must never do (#499).
    ///
    /// `SKError.paymentCancelled` is checked too: the StoreKit 1 error still surfaces through the
    /// StoreKit 2 API when the underlying purchase is serviced by the older stack.
    private func isCancellation(_ error: Error) -> Bool {
        if let skError = error as? StoreKitError, case .userCancelled = skError { return true }
        let ns = error as NSError
        return ns.domain == SKErrorDomain && ns.code == SKError.Code.paymentCancelled.rawValue
    }

    /// A stable, machine-readable classification for the journal — the thing `localizedDescription`
    /// cannot give. `"Request Canceled"` reads identically for a real cancel, an account/sandbox
    /// problem in `ASDErrorDomain`/`AMSErrorDomain`, and a network failure; these do not.
    private func classify(_ error: Error) -> String {
        if let skError = error as? StoreKitError {
            switch skError {
            case .unknown: return "storekit.unknown"
            case .userCancelled: return "storekit.userCancelled"
            case .networkError: return "storekit.networkError"
            case .systemError: return "storekit.systemError"
            case .notAvailableInStorefront: return "storekit.notAvailableInStorefront"
            case .notEntitled: return "storekit.notEntitled"
            @unknown default: return "storekit.unhandled"
            }
        }
        if let purchaseError = error as? Product.PurchaseError {
            switch purchaseError {
            case .invalidQuantity: return "purchase.invalidQuantity"
            case .productUnavailable: return "purchase.productUnavailable"
            case .purchaseNotAllowed: return "purchase.purchaseNotAllowed"
            case .ineligibleForOffer: return "purchase.ineligibleForOffer"
            case .invalidOfferIdentifier: return "purchase.invalidOfferIdentifier"
            case .invalidOfferPrice: return "purchase.invalidOfferPrice"
            case .invalidOfferSignature: return "purchase.invalidOfferSignature"
            case .missingOfferParameters: return "purchase.missingOfferParameters"
            @unknown default: return "purchase.unhandled"
            }
        }
        let ns = error as NSError
        return "\(ns.domain):\(ns.code)"
    }

    /// The diagnostic payload the catch-all used to throw away: domain, code, and the chain of
    /// underlying errors. **This is what makes the next occurrence self-diagnosing** instead of
    /// needing a device session to reproduce (#499).
    ///
    /// ⚠️ A `StoreKitError` bridged to `NSError` keeps NEITHER the `URLError` of `.networkError`
    /// nor the error inside `.systemError` — Swift's synthesized bridge drops the associated value
    /// and `NSUnderlyingErrorKey` is empty. The `ASDErrorDomain`/`AMSErrorDomain` code that names
    /// the actual account or sandbox fault lives there and nowhere else, so unwrap the enum
    /// explicitly before falling back to `userInfo`.
    private func errorDetail(_ error: Error, depth: Int = 0) -> [String: Any] {
        let ns = error as NSError
        var out: [String: Any] = [
            "domain": ns.domain,
            "code": ns.code,
            "description": ns.localizedDescription
        ]
        if let reason = ns.localizedFailureReason, !reason.isEmpty {
            out["failureReason"] = reason
        }
        // Bounded: an underlying chain is normally 1-2 deep, and the payload is serialized as JSON
        // into a journal line, not a crash report.
        guard depth < 3 else { return out }

        var nested: Error?
        if let skError = error as? StoreKitError {
            switch skError {
            case .networkError(let urlError): nested = urlError
            case .systemError(let underlying): nested = underlying
            default: break
            }
        }
        if nested == nil { nested = ns.userInfo[NSUnderlyingErrorKey] as? Error }
        if let nested {
            out["underlying"] = errorDetail(nested, depth: depth + 1)
        }
        return out
    }

    // MARK: - Methods

    @objc func isAvailable(_ call: CAPPluginCall) {
        // AppStore.canMakePayments is false under parental restrictions / a managed device.
        call.resolve(["available": AppStore.canMakePayments])
    }

    @objc func products(_ call: CAPPluginCall) {
        // iOS does not separate one-time products from subscriptions when fetching, so the two
        // lists the contract carries (for Android's sake) are simply merged here.
        let ids = (call.getArray("inapp", String.self) ?? []) + (call.getArray("subs", String.self) ?? [])
        Task {
            do {
                let fetched = try await Product.products(for: Set(ids))
                let payload = fetched.map { p -> [String: Any] in
                    [
                        "id": p.id,
                        // displayPrice is already localized AND currency-formatted. Never build
                        // this string ourselves — Apple rejects hardcoded/derived prices.
                        "displayPrice": p.displayPrice,
                        "title": p.displayName,
                        "description": p.description
                    ]
                }
                call.resolve(["products": payload])
            } catch {
                // Same treatment as `purchase()`'s catch, and for the same reason (#499): an empty
                // shelf reads identically whether the device is offline, the Paid Applications
                // Agreement lapsed, or the account is in a bad sandbox state — and the shelf is
                // where a player notices first. The domain/code is what tells them apart.
                call.reject(
                    "failed to load products: \(error.localizedDescription)",
                    classify(error),
                    error,
                    ["storeError": errorDetail(error)]
                )
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("productId is required")
            return
        }
        // #580: started BEFORE the Task, so the `sched` mark below measures how long the Task took
        // to actually begin running. Under the CPU starvation #580 hypothesised, that delay is the
        // symptom — and it is invisible from inside the Task body.
        let probe = PurchaseProbe(productId)
        Task {
            probe.segment("sched", "task-entered")
            do {
                // StoreKit returns an EMPTY LIST rather than an error when it cannot offer a
                // product, and gives no reason. "unknown product" was therefore a misleading
                // message: the id is usually correct and something else is wrong. Name the real
                // candidates here, because this string is all a developer gets.
                guard let product = try await Product.products(for: [productId]).first else {
                    probe.segment("A", "products-empty")
                    call.reject("the App Store returned no product for \"\(productId)\". The id is "
                        + "often correct and something else is wrong — check, in order: the Paid "
                        + "Applications Agreement is Active (with tax + banking complete); the "
                        + "product is at least \"Ready to Submit\" rather than \"Missing "
                        + "Metadata\"; it belongs to the App Store Connect record for this exact "
                        + "bundle id under this signing team; and that it has had time to "
                        + "propagate (new products can take hours).")
                    return
                }
                probe.segment("A", "products-ok")
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    probe.segment("B", "success")
                    guard let transaction = verified(verification) else {
                        probe.segment("C", "verify-failed")
                        call.reject("purchase failed verification")
                        return
                    }
                    probe.segment("C", "verify-ok")
                    // NOT finished here. The engine finishes only once the grant is durable.
                    call.resolve(["transaction": serialize(transaction)])
                case .userCancelled:
                    probe.segment("B", "userCancelled")
                    // A normal outcome, never an error.
                    call.resolve(["transaction": NSNull()])
                case .pending:
                    // Ask-to-Buy awaiting a guardian: no transaction exists yet. It arrives later
                    // as a re-delivery that unfinished() reports. Distinguished from a cancel so
                    // the UI does not tell the player their purchase failed.
                    probe.segment("B", "pending")
                    call.resolve(["transaction": NSNull(), "pending": true])
                @unknown default:
                    probe.segment("B", "unknown-result")
                    call.reject("unknown purchase result")
                }
            } catch {
                // #580: `classify` rather than `localizedDescription` here, for the reason the
                // reject below already gives — a user cancel and an ASD/AMS account fault both
                // read as "Request Canceled", so the timing line could not say which one stalled.
                probe.segment("throw", "threw:\(classify(error))")
                // A THROWN cancel is still a cancel. Falling through to the generic arm would
                // report it as a failure — including to `purchase_failed` analytics, which the
                // design says a cancel must never reach (#499).
                if isCancellation(error) {
                    call.resolve(["transaction": NSNull()])
                    return
                }
                // Carry the domain, code and underlying chain through, because
                // `localizedDescription` alone does not distinguish a real failure from a cancel:
                // an ASD/AMS account or sandbox fault reports the same `"Request Canceled"` string
                // a user cancel does, and the owner-reported failure of #499 was unnameable for
                // exactly this reason.
                call.reject(
                    "purchase failed: \(error.localizedDescription)",
                    classify(error),
                    error,
                    ["storeError": errorDetail(error)]
                )
            }
        }
    }

    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            var out: [[String: Any]] = []
            // THE recovery source. Everything StoreKit still expects us to finish — including
            // transactions from a session that was killed mid-purchase.
            for await result in StoreKit.Transaction.unfinished {
                if let t = verified(result) {
                    out.append(serialize(t))
                }
            }
            call.resolve(["transactions": out])
        }
    }

    @objc func entitlements(_ call: CAPPluginCall) {
        Task {
            var out: [[String: Any]] = []
            // currentEntitlements is the platform's own answer to "what does this user own RIGHT
            // NOW" — expired subscriptions, refunds and revocations are already excluded. That is
            // what lets the engine verify entitlement without a server.
            for await result in StoreKit.Transaction.currentEntitlements {
                if let t = verified(result) {
                    out.append(serialize(t))
                }
            }
            call.resolve(["transactions": out])
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let transactionId = call.getString("transactionId") else {
            call.reject("transactionId is required")
            return
        }
        Task {
            // Idempotent by construction: if it is not in `unfinished` it was already finished, and
            // resolving quietly is correct — the engine's recovery path re-finishes on purpose.
            for await result in StoreKit.Transaction.unfinished {
                if let t = verified(result), String(t.id) == transactionId {
                    await t.finish()   // ← the ONLY finish() in this file
                    call.resolve()
                    return
                }
            }
            call.resolve()
        }
    }

    @objc func acknowledge(_ call: CAPPluginCall) {
        // No-op on iOS: there is no acknowledgement step, and no refund deadline for an unfinished
        // transaction. Present so the JS contract is one shape on both platforms.
        call.resolve()
    }
}
