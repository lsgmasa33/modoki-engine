// swift-tools-version: 5.9
import PackageDescription

// This plugin imports ONLY `AVFoundation`, a SYSTEM framework — which is precisely the
// dependency-free case that got `capacitor-game-debug` stripped by SPM's static linker (see
// its Package.swift header, and docs/native-and-sdks.md:44, which flags "a system framework
// import is enough to keep the class" as UNTESTED). `capacitor-modoki-iap`, whose Package.swift
// this file mirrors, is not a counterexample either — StoreKit is also a system framework, and
// nothing here has confirmed one behaves differently from the other under the static linker.
// This can only be settled by a device build. If the plugin class turns out to be stripped, the
// fallback is the same one `capacitor-game-debug` uses: compile the plugin directly into the App
// target instead of via SPM, with manual registration in `MyViewController.swift` (see that
// package's Package.swift header for the pattern).
let package = Package(
    name: "CapacitorModokiAudio",
    platforms: [.iOS(.v15)],
    products: [
        // ⚠️ The library PRODUCT must be named exactly after the npm package —
        // `capacitor-modoki-audio` → `CapacitorModokiAudio`. Capacitor's generated
        // ios/App Package.swift requires that product by that derived name, so any other
        // name fails resolution with:
        //   product 'CapacitorModokiAudio' required by package 'capapp-spm' … not found
        // The TARGET name is free (`@capacitor/haptics` pairs product CapacitorHaptics with
        // target HapticsPlugin, which is the convention followed here).
        .library(name: "CapacitorModokiAudio", targets: ["ModokiAudioPlugin"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "ModokiAudioPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/ModokiAudioPlugin"
        ),
    ]
)
