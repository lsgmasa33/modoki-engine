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
    // ⚠️ `.macOS(.v12)` is METADATA, not a claim this builds on macOS — it cannot (`import
    // Capacitor` has no macOS xcframework). It matches the floor declared by the `core` package
    // this library depends on; without it SPM defaults this library to macOS 10.13 and the build
    // fails with:
    //   the library 'ModokiOtaPlugin' requires macos 10.13, but depends on the product
    //   'ModokiOtaCore' which requires macos 12.0
    // ⚠️ SCOPE, measured — an earlier version of this comment overstated it. SwiftPM validates
    // platform floors only for the platform being BUILT FOR, so this breaks a HOST `swift build` /
    // `swift test` of this package and does NOT affect an iOS build: with the floor removed,
    // `swift build` fails as above while `swift build --triple arm64-apple-ios15.0` reports no
    // platform error. It matters because host tooling is how the core is tested at all (#971).
    platforms: [.iOS(.v15), .macOS(.v12)],
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
