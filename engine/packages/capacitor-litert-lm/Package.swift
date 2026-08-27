// swift-tools-version: 5.9
import PackageDescription

// ⚠️ This comment used to say the iOS side is "a stub that rejects all calls". That is FALSE and
// it misled a reader into documenting it as fact (#368): `ios/Sources/LitertLmPlugin/
// LitertLmPlugin.swift` is a complete ~380-line MediaPipe implementation — it `import
// MediaPipeTasksGenAI`, builds `LlmInference.Options(modelPath:)`, downloads models and streams
// generation. The `call.reject` lines in it are ordinary argument validation.
//
// What is ACTUALLY missing is right here: this manifest declares only `capacitor-swift-pm`, while
// `CapacitorLitertLm.podspec` declares `MediaPipeTasksGenAI` + `MediaPipeTasksGenAIC`. So an SPM
// build of this target cannot resolve `import MediaPipeTasksGenAI` and fails to compile, and the
// podspec is the only iOS path whose dependencies resolve. Add the MediaPipe SPM dependency here
// BEFORE declaring `"ios"` in package.json — `capacitorPlatformDeclarations.test.ts` enforces that
// order, because otherwise `npm run verify` stays green and `cap sync ios` breaks the build.
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
