// swift-tools-version: 5.9
import PackageDescription

// The Capacitor plugin (Capacitor/CryptoKit — iOS-only). Declared here for package
// resolution/documentation, matching capacitor-game-debug's precedent, but NOT how it's
// actually linked into an app: it's compiled directly into the App target (see
// OtaPlugin.swift's header comment) because SPM's static linker strips plugin classes
// with no external dependency otherwise.
//
// ModokiOtaCore (the pure, macOS-testable logic — see core/Package.swift for why it's a
// SEPARATE manifest) is consumed here as a local package dependency, not duplicated.
let package = Package(
    name: "CapacitorModokiOta",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "ModokiOtaPlugin", targets: ["ModokiOtaPlugin"]),
    ],
    dependencies: [
        .package(path: "core"),
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "ModokiOtaPlugin",
            dependencies: [
                .product(name: "ModokiOtaCore", package: "core"),
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/ModokiOtaPlugin"
        ),
    ]
)
