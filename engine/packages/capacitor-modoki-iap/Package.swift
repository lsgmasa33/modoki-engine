// swift-tools-version: 5.9
import PackageDescription

// StoreKit 2 needs iOS 15. Declared here for package resolution/documentation, matching
// capacitor-game-debug and capacitor-modoki-ota; how it is actually linked into an app depends on
// whether SPM's static linker keeps the plugin class (it strips plugin classes with no external
// framework dependency — see those packages for the workaround).
let package = Package(
    name: "CapacitorModokiIap",
    // ⚠️ `.macOS(.v12)` is METADATA, not a claim this builds on macOS — it cannot (`import
    // Capacitor` has no macOS xcframework). It is required because this library depends on
    // ModokiIapCore, which declares macOS 12 so `swift test` can run there; without a matching
    // floor SPM defaults this library to macOS 10.13 and refuses to resolve with:
    //   the library 'ModokiIapPlugin' requires macos 10.13, but depends on the product
    //   'ModokiIapCore' which requires macos 12.0
    // ⚠️ SCOPE, measured — an earlier version of this comment overstated it. SwiftPM validates
    // platform floors only for the platform being BUILT FOR, so this breaks a HOST `swift build` /
    // `swift test` of this package and does NOT affect an iOS build: with the floor removed,
    // `swift build` fails as above while `swift build --triple arm64-apple-ios15.0` reports no
    // platform error. It matters because host tooling is how the core is tested at all (#971).
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        // ⚠️ The library PRODUCT must be named exactly after the npm package —
        // `capacitor-modoki-iap` → `CapacitorModokiIap`. Capacitor's generated
        // ios/App Package.swift requires that product by that derived name, so any other
        // name fails resolution with:
        //   product 'CapacitorModokiIap' required by package 'capapp-spm' … not found
        // The TARGET name is free (`@capacitor/haptics` pairs product CapacitorHaptics with
        // target HapticsPlugin, which is the convention followed here).
        .library(name: "CapacitorModokiIap", targets: ["ModokiIapPlugin"]),
    ],
    dependencies: [
        // The extracted classification core (#971). Mirrors capacitor-modoki-ota's split: a nested
        // standalone package so `swift test` can run it on the host, which `import Capacitor`
        // makes impossible for THIS target. `iap-core/Sources/` and `iap-core/Package.swift` must
        // stay in package.json's `files` or the tarball ships a manifest pointing at nothing —
        // enforced since #971 by capacitorPlatformDeclarations.test.ts, so this is a pointer to a
        // guard rather than a request that the next author remember.
        // ⚠️ The directory is `iap-core/`, NOT `core/`: SwiftPM derives a path-dependency's IDENTITY
        // from the directory basename, so a second plugin nesting its own `core/` in the same app
        // graph collides — `capacitor-modoki-ota` already uses `core/`. The collision surfaces as
        // `product 'ModokiIapCore' ... not found in package 'core'`, which names the wrong thing
        // entirely. Renaming later means renaming inside published tarballs.
        .package(path: "iap-core"),
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "ModokiIapPlugin",
            dependencies: [
                .product(name: "ModokiIapCore", package: "iap-core"),
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/ModokiIapPlugin"
        ),
    ]
)
