import Foundation
import StoreKit

/// Purchase-error classification — the SHIPPING implementation, extracted from `IapPlugin.swift`
/// so something can actually run it (#971).
///
/// ⚠️ **Why this is a separate package from `../Package.swift`, and what it may import.**
/// The rule is *no Capacitor*, not *no platform frameworks*. `import Capacitor` has no macOS
/// xcframework, so a target that pulls it in cannot be built by `swift test` on the host at all —
/// that is why `capacitor-modoki-ota/core` exists and why this one does. `StoreKit`, by contrast,
/// IS available on macOS 12+, and its `StoreKitError` / `Product.PurchaseError` cases are
/// constructible in a test. So the enum switches below — the part #499 and #946 both got wrong —
/// stay HERE, in the shipping path, rather than being re-typed into a test file. Contrast the
/// `ios/lease-parity` leg, which tests a PORT of its spec living inside the test and is flagged as
/// the weaker model in `engine/scripts/test-native.mjs`'s header.
///
/// Replayed against `test-vectors/iap-classification-vectors.json` by
/// `ModokiIapCoreTests.swift` (here) and, for the Android half of the same contract, by
/// `IapCoreSelfTest.java`.
@available(iOS 15.0, macOS 12.0, *)
public enum IapClassification {

    /// The `cancelReason` for StoreKit RETURNING `.userCancelled` — a purchase result, not a
    /// thrown error.
    ///
    /// ⚠️ Deliberately distinct from `classify`'s `"storekit.userCancelled"`, which is the THROWN
    /// `StoreKitError`. #946 is a purchase the player confirmed being recorded as `cancelled`, and
    /// keeping these two strings apart is what lets a journal line say which of the two happened.
    /// Collapsing them re-creates exactly the ambiguity that ticket exists to resolve.
    public static let resultCancelReason = "storekit.result.userCancelled"

    /// Is this THROWN error a cancel?
    ///
    /// StoreKit reports the ordinary cancel as a `.userCancelled` *result*, handled by the caller —
    /// but it can also THROW one, and the two must land on the same JS outcome. A cancel arriving
    /// as a rejection would be reported as `iap.purchase.failed` and reach `purchase_failed`
    /// analytics, which the design says a cancel must never do (#499).
    ///
    /// `SKError.paymentCancelled` is checked too: the StoreKit 1 error still surfaces through the
    /// StoreKit 2 API when the underlying purchase is serviced by the older stack.
    public static func isCancellation(_ error: Error) -> Bool {
        if let skError = error as? StoreKitError, case .userCancelled = skError { return true }
        let ns = error as NSError
        return ns.domain == SKErrorDomain && ns.code == SKError.Code.paymentCancelled.rawValue
    }

    /// A stable, machine-readable classification for the journal — the thing `localizedDescription`
    /// cannot give. `"Request Canceled"` reads identically for a real cancel, an account/sandbox
    /// problem in `ASDErrorDomain`/`AMSErrorDomain`, and a network failure; these do not.
    ///
    /// ⚠️ The `default` arm is `"<domain>:<code>"` and that is load-bearing, not a fallback nobody
    /// hits: the `ASDErrorDomain`/`AMSErrorDomain` faults from #946 reach exactly this arm, and
    /// they are the ones that read as a cancel to the user while not being one.
    /// ⚠️ **Two live cases fall into `@unknown default` today, and compiling this file is the only
    /// thing that can tell you** — which nothing in this repo did before #971. Against the current
    /// SDK the compiler reports `switch must be exhaustive`, missing `StoreKitError.unsupported`
    /// and `Product.PurchaseError.paymentMethodBindingConfigurationRequired`. Both therefore
    /// classify as `"storekit.unhandled"` / `"purchase.unhandled"` rather than by name.
    ///
    /// They are deliberately NOT added here: naming a case that a slightly older Xcode's SDK does
    /// not declare would break the build for anyone on it, and `@unknown default` exists precisely
    /// to absorb that. Adding them is a decision about the minimum toolchain, not a drive-by fix.
    /// The point on record is that the gap is now VISIBLE — it was not before.
    public static func classify(_ error: Error) -> String {
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
}
