import Foundation
import Capacitor
import StoreKit

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
                self.notifyListeners("purchasesUpdated", data: ["transactions": [self.serialize(t)]])
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
        Task {
            do {
                // StoreKit returns an EMPTY LIST rather than an error when it cannot offer a
                // product, and gives no reason. "unknown product" was therefore a misleading
                // message: the id is usually correct and something else is wrong. Name the real
                // candidates here, because this string is all a developer gets.
                guard let product = try await Product.products(for: [productId]).first else {
                    call.reject("the App Store returned no product for \"\(productId)\". The id is "
                        + "often correct and something else is wrong — check, in order: the Paid "
                        + "Applications Agreement is Active (with tax + banking complete); the "
                        + "product is at least \"Ready to Submit\" rather than \"Missing "
                        + "Metadata\"; it belongs to the App Store Connect record for this exact "
                        + "bundle id under this signing team; and that it has had time to "
                        + "propagate (new products can take hours).")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    guard let transaction = verified(verification) else {
                        call.reject("purchase failed verification")
                        return
                    }
                    // NOT finished here. The engine finishes only once the grant is durable.
                    call.resolve(["transaction": serialize(transaction)])
                case .userCancelled:
                    // A normal outcome, never an error.
                    call.resolve(["transaction": NSNull()])
                case .pending:
                    // Ask-to-Buy awaiting a guardian: no transaction exists yet. It arrives later
                    // as a re-delivery that unfinished() reports. Distinguished from a cancel so
                    // the UI does not tell the player their purchase failed.
                    call.resolve(["transaction": NSNull(), "pending": true])
                @unknown default:
                    call.reject("unknown purchase result")
                }
            } catch {
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
