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
                call.reject("failed to load products: \(error.localizedDescription)")
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
                call.reject("purchase failed: \(error.localizedDescription)")
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
