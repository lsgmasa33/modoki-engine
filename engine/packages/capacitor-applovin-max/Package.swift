// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorApplovinMax",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorApplovinMax",
            targets: ["ApplovinMaxPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // ⚠️ EXACT pins, kept equal to the podspec and to android/build.gradle (#1494). UMP stays on the
        // version @capacitor-community/admob resolves, so a game carrying both during the switch resolves.
        .package(url: "https://github.com/AppLovin/AppLovin-MAX-Swift-Package.git", exact: "13.6.4"),
        .package(url: "https://github.com/googleads/swift-package-manager-google-user-messaging-platform.git", exact: "3.1.0")
    ],
    targets: [
        .target(
            name: "ApplovinMaxPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AppLovinSDK", package: "AppLovin-MAX-Swift-Package"),
                .product(name: "GoogleUserMessagingPlatform", package: "swift-package-manager-google-user-messaging-platform")
            ],
            path: "ios/Sources/ApplovinMaxPlugin")
    ]
)
