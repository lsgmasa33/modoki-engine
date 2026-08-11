// swift-tools-version: 5.9
import PackageDescription

// StoreKit 2 needs iOS 15. Declared here for package resolution/documentation, matching
// capacitor-game-debug and capacitor-modoki-ota; how it is actually linked into an app depends on
// whether SPM's static linker keeps the plugin class (it strips plugin classes with no external
// framework dependency — see those packages for the workaround).
let package = Package(
    name: "CapacitorModokiIap",
    platforms: [.iOS(.v15)],
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
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "ModokiIapPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/ModokiIapPlugin"
        ),
    ]
)
