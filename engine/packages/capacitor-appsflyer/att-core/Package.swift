// swift-tools-version: 5.9
import PackageDescription

// A SEPARATE, standalone package from ../Package.swift, for the reason capacitor-modoki-iap's
// `iap-core` is one: `import Capacitor` has no macOS xcframework, so a target living in the plugin's
// manifest cannot be `swift test`ed on the host. `npm run test:native` runs this (#1510).
//
// ⚠️ The directory is `att-core/`, not `core/`: SwiftPM names a path dependency after its directory
// basename, and `capacitor-modoki-ota` already nests a `core/` in the same app graph.
let package = Package(
    name: "AppsFlyerAttCore",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "AppsFlyerAttCore", targets: ["AppsFlyerAttCore"]),
    ],
    targets: [
        .target(name: "AppsFlyerAttCore", path: "Sources/AppsFlyerAttCore"),
        .testTarget(name: "AppsFlyerAttCoreTests", dependencies: ["AppsFlyerAttCore"], path: "Tests/AppsFlyerAttCoreTests"),
    ]
)
