import XCTest
import StoreKit
@testable import ModokiIapCore

/// Replays `test-vectors/iap-classification-vectors.json` — the same file `IapCoreSelfTest.java`
/// replays for the Android half, and `iapCancelVocabulary.test.ts` replays for the JS routing half
/// (#971).
///
/// This drives the SHIPPING `IapClassification`, not a port of it. The only mapping that lives in
/// this file is descriptor-name → StoreKit enum VALUE (building the input); the value → string
/// classification under test stays in the core.
@available(iOS 15.0, macOS 12.0, *)
final class IapClassificationTests: XCTestCase {

    static let vectorFile = "test-vectors/iap-classification-vectors.json"

    private func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // IapClassificationTests.swift -> ModokiIapCoreTests/
            .deletingLastPathComponent()  // -> Tests/
            .deletingLastPathComponent()  // -> iap-core/
            .deletingLastPathComponent()  // -> package root
    }

    private func loadVectors() throws -> [String: Any] {
        let url = packageRoot().appendingPathComponent(Self.vectorFile)
        let data = try Data(contentsOf: url)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("vector file is not a JSON object: \(url.path)")
            return [:]
        }
        return obj
    }

    /// ⚠️ The #565-class guard. Every assertion below iterates a vector array, so a file that
    /// failed to load — moved, renamed, or a bad path after a refactor — would make this whole
    /// suite pass by iterating nothing. Fail loudly on an absent or empty file instead.
    func testVectorFileIsPresentAndNonEmpty() throws {
        let url = packageRoot().appendingPathComponent(Self.vectorFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path),
                      "missing vector file \(url.path) — the suite would otherwise pass vacuously")
        let root = try loadVectors()
        // Read the format version, so a bump cannot half-land across the three replays.
        XCTAssertEqual(root["version"] as? Int, 1, "unexpected vector format version")
        let ios = (root["ios"] as? [String: Any])?["classify"] as? [[String: Any]] ?? []
        XCTAssertGreaterThan(ios.count, 10, "iOS classify vectors missing or suspiciously few")
    }

    /// Build the error a vector describes. Descriptor → enum VALUE only; no classification here.
    private func makeError(_ input: [String: Any]) -> Error? {
        let kind = input["kind"] as? String
        switch kind {
        case "storeKitError":
            switch input["case"] as? String {
            case "unknown": return StoreKitError.unknown
            case "userCancelled": return StoreKitError.userCancelled
            case "networkError": return StoreKitError.networkError(URLError(.notConnectedToInternet))
            case "systemError": return StoreKitError.systemError(URLError(.unknown))
            case "notAvailableInStorefront": return StoreKitError.notAvailableInStorefront
            case "notEntitled": return StoreKitError.notEntitled
            default: return nil
            }
        case "purchaseError":
            switch input["case"] as? String {
            case "invalidQuantity": return Product.PurchaseError.invalidQuantity
            case "productUnavailable": return Product.PurchaseError.productUnavailable
            case "purchaseNotAllowed": return Product.PurchaseError.purchaseNotAllowed
            case "ineligibleForOffer": return Product.PurchaseError.ineligibleForOffer
            case "invalidOfferIdentifier": return Product.PurchaseError.invalidOfferIdentifier
            case "invalidOfferPrice": return Product.PurchaseError.invalidOfferPrice
            case "invalidOfferSignature": return Product.PurchaseError.invalidOfferSignature
            case "missingOfferParameters": return Product.PurchaseError.missingOfferParameters
            default: return nil
            }
        case "nsError":
            guard let domain = input["domain"] as? String, let code = input["code"] as? Int else { return nil }
            return NSError(domain: domain, code: code, userInfo: nil)
        default:
            return nil
        }
    }

    func testClassifyAndCancellationMatchTheVectors() throws {
        let root = try loadVectors()
        let vectors = (root["ios"] as? [String: Any])?["classify"] as? [[String: Any]] ?? []
        XCTAssertFalse(vectors.isEmpty, "no iOS vectors loaded")

        var checked = 0
        for v in vectors {
            let name = v["name"] as? String ?? "(unnamed)"
            guard let input = v["input"] as? [String: Any], let error = makeError(input) else {
                XCTFail("vector '\(name)' has an input this test cannot build — add it to makeError")
                continue
            }
            if let expect = v["expect"] as? String {
                XCTAssertEqual(IapClassification.classify(error), expect, "classify mismatch for '\(name)'")
            }
            if let cancel = v["cancel"] as? Bool {
                XCTAssertEqual(IapClassification.isCancellation(error), cancel,
                               "isCancellation mismatch for '\(name)'")
            }
            checked += 1
        }
        XCTAssertEqual(checked, vectors.count, "not every vector was exercised")
    }

    /// The RESULT constant is part of the contract and must not drift from the vectors — it is the
    /// string a journal line uses to say the cancel came from StoreKit returning `.userCancelled`
    /// rather than throwing one (#946).
    func testResultCancelReasonMatchesTheVectors() throws {
        let root = try loadVectors()
        let expected = (root["ios"] as? [String: Any])?["resultCancelReason"] as? String
        XCTAssertEqual(IapClassification.resultCancelReason, expected)
        XCTAssertNotEqual(IapClassification.resultCancelReason, "storekit.userCancelled",
                          "the RESULT cancel and the THROWN cancel must stay distinguishable (#946)")
    }
}
