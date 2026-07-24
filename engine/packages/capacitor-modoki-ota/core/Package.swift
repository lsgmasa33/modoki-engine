// swift-tools-version: 5.9
import PackageDescription

// A SEPARATE, standalone package from ../Package.swift — deliberately. ModokiOtaCore is
// Foundation + Compression only (no Capacitor/UIKit), so it's the one part of this
// feature that builds and tests on plain macOS: no Xcode project, no device, no iOS SDK.
// If ModokiOtaCore lived in the SAME manifest as the Capacitor-dependent plugin target,
// `swift test` would try to build EVERY target in the package for the host platform
// (macOS) and fail on `import Capacitor` (no macOS xcframework) even though the test
// target never depends on it — this split is what makes `cd core && swift test` work.
let package = Package(
    name: "ModokiOtaCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ModokiOtaCore", targets: ["ModokiOtaCore"]),
    ],
    targets: [
        .target(name: "ModokiOtaCore", path: "Sources/ModokiOtaCore"),
        .testTarget(name: "ModokiOtaCoreTests", dependencies: ["ModokiOtaCore"], path: "Tests/ModokiOtaCoreTests"),
    ]
)
