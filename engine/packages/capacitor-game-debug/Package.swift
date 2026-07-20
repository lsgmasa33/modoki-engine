// swift-tools-version: 5.9
import PackageDescription

// Note: On iOS, this plugin is compiled directly into the App target
// (not via SPM) because SPM static linker strips plugin classes that
// have no external SDK dependencies. See MyViewController.swift for
// manual registration. Android uses this package normally via Capacitor.
let package = Package(
    name: "CapacitorGameDebug",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorGameDebug",
            targets: ["GameDebugPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "GameDebugPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/GameDebugPlugin"
        )
    ]
)
