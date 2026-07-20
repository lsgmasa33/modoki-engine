// swift-tools-version: 5.9
import PackageDescription

// Note: iOS LiteRT-LM Swift API is not yet available.
// This plugin provides a stub implementation that rejects all calls.
// Once Google ships the Swift SDK, add the SPM dependency here.
let package = Package(
    name: "CapacitorLitertLm",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorLitertLm",
            targets: ["LitertLmPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "LitertLmPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/LitertLmPlugin"
        )
    ]
)
