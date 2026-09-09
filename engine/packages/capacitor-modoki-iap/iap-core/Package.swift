// swift-tools-version: 5.9
import PackageDescription

// A SEPARATE, standalone package from ../Package.swift — deliberately, and for the same reason
// `capacitor-modoki-ota/core` is: `import Capacitor` has no macOS xcframework, so if this target
// lived in the plugin's manifest, `swift test` would try to build EVERY target for the host and
// fail on that import even though the test target never depends on it.
//
// ⚠️ The exclusion is CAPACITOR, not platform frameworks. StoreKit ships on macOS 12+, so
// ModokiIapCore keeps the real `StoreKitError` / `Product.PurchaseError` switches and the test
// constructs real values — the leg gates the SHIPPING classification rather than a port of it.
let package = Package(
    name: "ModokiIapCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ModokiIapCore", targets: ["ModokiIapCore"]),
    ],
    targets: [
        .target(name: "ModokiIapCore", path: "Sources/ModokiIapCore"),
        .testTarget(name: "ModokiIapCoreTests", dependencies: ["ModokiIapCore"], path: "Tests/ModokiIapCoreTests"),
    ]
)
