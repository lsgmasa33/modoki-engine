// swift-tools-version: 5.9
import PackageDescription

// A STANDALONE test package for the plugin's iOS parity tests — deliberately NOT a `testTarget`
// in the plugin's own Package.swift (#376).
//
// Why here instead of there:
//   - The plugin package is iOS-only (`platforms: [.iOS(.v15)]`) and depends on capacitor-swift-pm,
//     so `swift test` on it cannot run from the command line at all — it would need `xcodebuild`
//     against a simulator destination plus a network fetch of Capacitor, for a test whose only
//     import is XCTest.
//   - `ios/Tests/` is NOT in package.json `files` (shipping it would re-vendor all 21 consuming
//     projects on every test edit — see pluginHashInputs). A `testTarget` in the shipped manifest
//     would therefore point at a path that does not exist in the vendored tarball, which is a
//     manifest ERROR, not a skipped target.
// This package has no dependencies and no platform floor, so `swift test` runs it on the host in
// seconds. Run it via `npm run test:native` (an ON-DEMAND gate — `npm run verify` is vitest and
// cannot run XCTest; see engine/scripts/test-native.mjs).
let package = Package(
    name: "GameDebugPluginTests",
    targets: [
        .testTarget(
            name: "GameDebugPluginTests",
            path: "GameDebugPluginTests"
        )
    ]
)
