// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorAppsflyer",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorAppsflyer",
            targets: ["AppsFlyerPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // ⚠️ AppsFlyer ships THREE SPM repos: -Static, -Dynamic, -Strict. This MUST stay
        // -Static. -Strict is the no-IDFA build (it strips ATT/IDFA support entirely) and
        // would silently defeat the whole purpose of this integration — attribution would
        // work, but never with IDFA. Do not "upgrade" to -Strict.
        .package(url: "https://github.com/AppsFlyerSDK/AppsFlyerFramework-Static.git", from: "7.0.1")
    ],
    targets: [
        .target(
            name: "AppsFlyerPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                // ⚠️ The PRODUCT is "AppsFlyerLib-Static"; the TARGET (and so the module you
                // `import`) is "AppsFlyerLib". They differ, and using the module name here
                // fails resolution with "product 'AppsFlyerLib' ... not found". Verified
                // against the repo's own Package.swift, 2026-08-19.
                .product(name: "AppsFlyerLib-Static", package: "AppsFlyerFramework-Static")
            ],
            path: "ios/Sources/AppsFlyerPlugin")
    ]
)
