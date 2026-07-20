# Build & deploy

How a Modoki game goes from source to a running app — web compile, per-game Capacitor
native, and on-device install. `CLAUDE.md` keeps the everyday commands (`npm run dev`,
`MODOKI_PROJECT=… npm run build`, the test/verify gate) and points here for the full
native pipeline and the device build recipes.

Related: [native-and-sdks.md](./native-and-sdks.md) (SPM plugins, SDKs, per-game signing),
[electron-signing-optimization.md](./plans/electron-signing-optimization.md) (desktop-editor
codesign speed).

## One project = one game (#29)

Post-#29 the repo root is **not** a buildable game — it's the engine + Electron editor.
Every `games/<id>` is a fully self-contained Capacitor app with its **own** `ios/`,
`android/`, and `capacitor.config.json`. A bare `npm run build` with no `MODOKI_PROJECT`
fails fast by design.

**`MODOKI_PROJECT=games/<id>`** steers three things in lockstep:
- **Output** → `games/<id>/dist` (`vite.config.ts` `buildProjectRoot`).
- **Identity** → the project's `project.config.json` (`appId`/`appName`).
- **Capacitor** → `webDir` = `games/<id>/dist` (`games/<id>/capacitor.config.json`).

Only the **web compile** (`npm run build`) runs from the repo root (shared vite/engine,
steered by `MODOKI_PROJECT`). `cap sync` and the native build run **from the project dir**,
because its config + native folders live there.

## Creating a new game — use the scaffolder, never hand-craft

```bash
node engine/scripts/scaffold-project.mjs games/<id> "Project Name"
```
This is the same template + token contract the editor's **File → New Project** uses
(`engine/electron/newProject.ts`). It copies `engine/templates/starter`, substitutes identity
tokens, and mints fresh scene GUIDs → a complete, runnable hello-world project (`game.ts` ·
`project.config.json` · `runtime/config.ts` · `runtime/setup.ts` ·
`runtime/assets/scenes/main.json`). **Do NOT hand-write `game.ts` / config / scene JSON** —
you'll miss the GUID/manifest/config wiring.

## Per-clone dependency bootstrap

The engine plugins and each game's Capacitor plugins ship their JS only in a **gitignored
`dist/`**. After `git clone` or any pull that touches a `package.json`/lockfile, a plain
`npm install` does the full setup: the root `postinstall` chains `build:plugins` (engine
native plugins → `dist/`) **and** `engine/scripts/bootstrap-game-deps.mjs`, which for every
`games/<id>` that is a workspace root runs its own `npm install` + `build:plugins`. A missing
`dist/` is what makes `npm test` / the editor fail with `Failed to resolve import
"capacitor-<x>"`. See the Two Clones section of `CLAUDE.md`.

## Native scaffolding: auto on first build

A game with no `ios/`/`android/` yet is **auto-scaffolded on the first native build** —
`/api/build` runs the same pipeline as **Build → Add iOS/Android Target…**: deps +
`capacitor.config.json` + vendor plugins → `npm install` → web build → `npx cap add` → heal.
It then continues into the build, pausing first only if the scaffold surfaces a warning you
must act on (e.g. missing Firebase config). The explicit **Add … Target** menu items do just
the scaffold. Manual CLI equivalent: `cd games/<id> && npx cap add ios|android`.

`healNativeConfig` (`engine/plugins/healNativeConfig.ts`) runs on project open **and** at the
start of every iOS/Android build — it syncs the project's `build.appleTeamId` into the iOS
project's `DEVELOPMENT_TEAM` (so a Team ID edited after `cap add` still lands) and repairs
other drift. `add-native-target` (`engine/plugins/addNativeTarget.ts`) and the vendor plugin
wire in per-game native plugins. Restart the editor after pulling build-pipeline changes — the
Vite plugin loads once at dev-server start.

## Committing native folders (SOURCE only)

Each game's `ios/` + `android/` are tracked (pbxproj, gradle scripts, `res/`, `Info.plist`,
`Package.swift`, the vendored `plugins/*.tgz`) — 3d-test + 2d-physics-demo are the references.
Build junk is kept out by two layers: Capacitor's own generated `games/<id>/ios/.gitignore` +
`android/.gitignore`, **plus** centralized `games/*/` rules in the repo-root `.gitignore`
(Pods/, `App/build/`, `android/**/build/`, `.gradle/`, `.cxx/`, xcuserdata, Capacitor-regenerated
config copies…). The belt-and-suspenders root rules exist because the OLD anchored `ios/…` +
`android/…` lines are pre-#29 repo-root paths that don't match `games/<id>/…`. After scaffolding
a new game's native, sanity-check:
```bash
git ls-files 'games/*/ios/**' 'games/*/android/**' | git check-ignore --stdin
# must print nothing — no tracked source should be ignored
```

## The canonical path: build from the editor

Open the project, then **Build → iOS Device / Android Device / Web**. `/api/build` runs the
steps below with the right cwd per step (web compile at repo root, native at the project dir) and
consumes the SSE pipeline to completion. This is the validated path; the CLI recipes below are the
manual equivalent.

The editor build path **resolves (and, in a packaged editor, downloads) its toolchain
automatically** — Node, the JDK 21, and the Android SDK — and preflight-gates a build on the tools
it needs, pointing you at **Build → Build Support…** to install anything missing. It exports
`JAVA_HOME`/`ANDROID_HOME` from that shared, version-strict detection, so you don't set them by hand
the way the manual CLI recipes below do. Full detail: [editor-toolchain.md](./editor-toolchain.md).

## CLI recipes

The examples use `games/<id>`; substitute the project and its appId. Note the **project-dir cwd**
for `cap`/`xcodebuild`/`gradle`. A game's concrete bundle id, Apple Team ID, and device IDs live in
its own `games/<id>/CLAUDE.md`.

### Web
```bash
MODOKI_PROJECT=games/<id> npm run build   # TypeScript check + Vite build → games/<id>/dist
```

### iOS Simulator
```bash
MODOKI_PROJECT=games/<id> npm run build
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'id=<SIM_UDID>' build
xcrun simctl boot <SIM_UDID>
xcrun simctl install booted <path-to-App.app>
xcrun simctl launch booted <appId>
```

### iOS Device
```bash
MODOKI_PROJECT=games/<id> npm run build
(cd games/<id> && npx cap sync ios)
xcodebuild -project games/<id>/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<DEVICE_UDID>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <DEVICE_ID> \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <DEVICE_ID> <appId>
```
First device install requires trusting the developer profile: Settings → General →
VPN & Device Management → Trust.

### Android Device
```bash
MODOKI_PROJECT=games/<id> npm run build
(cd games/<id> && npx cap sync android)
JAVA_HOME=$(/usr/libexec/java_home -v 21) games/<id>/android/gradlew -p games/<id>/android assembleDebug
adb install games/<id>/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n <appId>/.MainActivity
```

## iOS build notes

- **`.xcodeproj` vs `.xcworkspace` depends on the game's deps.** A Firebase-only / SPM-only game
  (3d-test) has NO CocoaPods → build with `-project …/App.xcodeproj`. A game that pulls CocoaPods
  mediation adapters (AppLovin MAX, etc.) gets an `App.xcworkspace` from `pod install` → build with
  `-workspace …/App.xcworkspace` instead.
- **Use `-allowProvisioningUpdates`** for device builds (auto-signing). `DEVELOPMENT_TEAM` must be
  the Team ID of an account signed into Xcode — see per-game signing in
  [native-and-sdks.md](./native-and-sdks.md).
- First build is slow — SPM downloads all SDK frameworks.
- If SPM fails with "already exists in file system", clear the cache:
  `rm -rf ~/Library/Caches/org.swift.swiftpm/artifacts/*`.
- Use exact device IDs in `-destination` (not names — they can be ambiguous).
- dSYMs auto-upload to Firebase Crashlytics via a build-phase script.
- Firebase DebugView: add `-FIRAnalyticsDebugEnabled` to the Xcode scheme arguments.

## Android build notes

- Requires **JDK 21** (Capacitor 8 / AGP). Set `JAVA_HOME=$(/usr/libexec/java_home -v 21)` before
  Gradle commands.
- Stock Gradle heap is `-Xmx1536m`; raise it (e.g. `-Xmx4096m`) only when a game bundles the 12
  AppLovin mediation adapters — none do yet.
- Device must show as `device` (not `unauthorized`) in `adb devices`.

**AppLovin SDK 13.x API notes** (only relevant to a game that bundles mediation):
`MaxAdFormat` replaces `AppLovinAdSize` for ad-format comparisons; `setUserIdentifier` moved to
`AppLovinSdk.getSettings()`; `setIsAgeRestrictedUser` / `setTestDeviceAdvertisingIds` removed (use
the dashboard); Adjust SDK v5 sets purchase time via `AdjustPlayStoreSubscription.setPurchaseTime(long)`.
