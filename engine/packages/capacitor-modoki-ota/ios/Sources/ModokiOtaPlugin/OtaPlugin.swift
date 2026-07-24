// OTA update Capacitor plugin (docs/plans/mobile-ota-updates-plan.md, Phase 1).
//
// DEVICE-UNVERIFIED — written against Capacitor 8's actual source (read directly, not
// guessed) but never built/run on a device or in Xcode. Before shipping, verify on a real
// iPhone per the plan doc's Phase 1 gate.
//
// This wraps the pure ModokiOtaCore/OtaZip logic (already verified via `swift test`, no
// device needed) with real file I/O and integrates with Capacitor's OWN existing
// live-update mechanism rather than inventing a parallel one — reading
// CAPBridgeViewController.swift directly turned up load-bearing facts a guess would have
// gotten wrong:
//
//  - Capacitor persists the served content's location as `KeyValueStore.standard["serverBasePath"]`
//    (`Plugins/WebView.swift`'s `persistServerBasePath`), but `instanceDescriptor()`
//    (`CAPBridgeViewController.swift:91-101`) only trusts that string's LAST PATH COMPONENT —
//    it reconstructs the real directory as
//    `<Library>/NoCloud/ionic_built_snapshots/<lastPathComponentOfPersistedValue>`.
//    So OTA bundle folders MUST live there, named by their last component only.
//  - `instanceDescriptor()` is the documented, sanctioned override point for exactly this
//    ("This is called early in the View Controller's lifecycle" — precisely where we need
//    to decide/correct what gets served, BEFORE the WKWebView is created).
//  - Capacitor's own `isNewBinary` check (`CAPBridgeViewController.swift:18-24`, comparing
//    `CFBundleVersion`/`CFBundleShortVersionString` against what it last saw) ALREADY
//    forces a fallback to the embedded bundle after a genuine App Store update, skipping
//    the persisted path entirely — a real safety net we get for free. Our own state.json
//    must independently detect the same condition (see `resetIfNewBinary` below) so our
//    bootAttempts/confirm bookkeeping doesn't reference a snapshot Capacitor has already
//    silently abandoned.
//
// Integration: MyViewController must override `instanceDescriptor()`, calling
// `OtaBootHook.run(name:)` BEFORE `super.instanceDescriptor()` — see the doc comment on
// `OtaBootHook.run` below for the exact snippet.

import Capacitor
import CryptoKit
import Foundation
// NOTE: no `import ModokiOtaCore` — like GameDebugPlugin, this file ships compiled
// DIRECTLY into the consuming app's target (loose pbxproj file references, not SPM;
// see this file's header comment), so OtaCore.swift/OtaZip.swift land in the SAME flat
// module and their types (OtaCore, OtaZip, OtaState, ...) are already visible with no
// import. `import ModokiOtaCore` only makes sense if a consumer ever links this
// package's real SPM product instead — not how any project integrates it today.

/// The one-and-only bundle name Phase 1 drives (the whole app IS the game — see the plan
/// doc; sub-game bundle names are a Phase 4 concern, not exercised here).
public let otaShellBundleName = "shell"

enum OtaPaths {
  static var stateFilePath: URL {
    appSupportDir.appendingPathComponent("modoki-ota-state.json")
  }

  /// Where OTA bundle content lives on iOS — MUST match `ionic_built_snapshots`, the fixed
  /// directory `CAPBridgeViewController.instanceDescriptor()` reconstructs from the
  /// persisted `serverBasePath`'s last path component. Not a free choice.
  static var snapshotsDir: URL {
    let libPath = NSSearchPathForDirectoriesInDomains(.libraryDirectory, .userDomainMask, true)[0]
    return URL(fileURLWithPath: libPath, isDirectory: true)
      .appendingPathComponent("NoCloud")
      .appendingPathComponent("ionic_built_snapshots")
  }

  static func versionFolderName(name: String, version: String) -> String { "\(name)-\(version)" }

  static func versionDir(name: String, version: String) -> URL {
    snapshotsDir.appendingPathComponent(versionFolderName(name: name, version: version))
  }

  private static var appSupportDir: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("modoki-ota")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }
}

/// Called from `MyViewController.instanceDescriptor()` BEFORE `super.instanceDescriptor()`
/// — the documented Capacitor extension point for deciding what gets served, which runs
/// before the WKWebView/bridge exist. Example integration (added when this plugin is
/// wired into a real project — not yet done, see the plan doc):
///
/// ```swift
/// override func instanceDescriptor() -> InstanceDescriptor {
///     OtaBootHook.run(name: otaShellBundleName)
///     return super.instanceDescriptor()
/// }
/// ```
public enum OtaBootHook {
  public static func run(name: String) {
    let stateJSON = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    let folderExists: (String, String) -> Bool = { n, v in
      var isDir: ObjCBool = false
      let exists = FileManager.default.fileExists(atPath: OtaPaths.versionDir(name: n, version: v).path, isDirectory: &isDir)
      return exists && isDir.boolValue
        && FileManager.default.fileExists(atPath: OtaPaths.versionDir(name: n, version: v).appendingPathComponent("index.html").path)
    }

    let (target, newState) = OtaCore.boot(fromJSON: stateJSON, name: name, folderExists: folderExists)
    if let newState { try? OtaCore.serialize(newState).write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8) }

    switch target {
    case .embedded:
      // Never write an empty/garbage serverBasePath — CAPBridgeViewController already
      // treats an absent/empty persisted value as "use the embedded bundle" (see its
      // `!persistedPath.isEmpty` guard), so simply not touching KeyValueStore is correct.
      // If a PRIOR launch left a bad value there, clear it explicitly so it can't linger.
      KeyValueStore.standard["serverBasePath"] = nil as String?
    case let .version(n, v):
      KeyValueStore.standard["serverBasePath"] = OtaPaths.versionFolderName(name: n, version: v)
    }
  }
}

@objc(ModokiOtaPlugin)
public class ModokiOtaPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "ModokiOtaPlugin"
  public let jsName = "ModokiOta"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "stageUpdate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "confirmBoot", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
  ]

  /// Downloads a bundle zip directly (URLSession — bypasses the JS bridge for the
  /// payload bytes entirely, the reason this needs to be native at all: marshalling
  /// thousands of small files through the bridge as base64 is prohibitively slow),
  /// verifies its SHA-256 against the manifest-provided hash, and unzips it into a
  /// `.tmp` staging folder that's only atomically renamed into its final
  /// `ionic_built_snapshots/<name>-<version>/` location once the whole zip has been
  /// verified AND fully extracted — so a kill mid-download/mid-unzip can never leave a
  /// half-written folder where `boot()`'s `folderExists` check would find it.
  @objc func stageUpdate(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version"),
          let zipUrlString = call.getString("zipUrl"), let zipUrl = URL(string: zipUrlString),
          let expectedHash = call.getString("expectedZipHash") else {
      call.reject("stageUpdate requires name, version, zipUrl, expectedZipHash")
      return
    }

    URLSession.shared.dataTask(with: zipUrl) { data, response, error in
      if let error { call.reject("download failed: \(error.localizedDescription)"); return }
      guard let data, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
        call.reject("download failed: bad response"); return
      }

      let actualHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard actualHash == expectedHash.lowercased() else {
        call.reject("hash mismatch: expected \(expectedHash), got \(actualHash)"); return
      }

      do {
        let entries = try OtaZip.unzip(data)
        let tmpDir = OtaPaths.snapshotsDir.appendingPathComponent(".tmp-\(name)-\(version)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        for entry in entries {
          let entryPath = tmpDir.appendingPathComponent(entry.path)
          try FileManager.default.createDirectory(at: entryPath.deletingLastPathComponent(), withIntermediateDirectories: true)
          try entry.data.write(to: entryPath)
        }
        let finalDir = OtaPaths.versionDir(name: name, version: version)
        try? FileManager.default.removeItem(at: finalDir) // a stale partial from an earlier interrupted attempt
        try FileManager.default.moveItem(at: tmpDir, to: finalDir) // atomic on the same volume
        call.resolve(["ok": true])
      } catch {
        call.reject("stage failed: \(error.localizedDescription)")
      }
    }.resume()
  }

  /// Marks `version` as the pending version for `name` in state.json. Does NOT touch
  /// `KeyValueStore`/serverBasePath immediately — Phase 1 is "apply next launch" by
  /// design (see the plan doc); `OtaBootHook.run` is the sole authority over what gets
  /// served, and it re-derives that from state.json on every single launch regardless,
  /// so there is exactly one source of truth instead of two that could disagree.
  @objc func activate(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version") else {
      call.reject("activate requires name, version"); return
    }
    var state = OtaCore.parseState(try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)) ?? OtaState()
    state.pending[name] = version
    state.bootAttempts.removeValue(forKey: name)
    state.confirmedBoots.removeValue(forKey: name)
    do {
      try OtaCore.serialize(state).write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8)
      call.resolve(["ok": true])
    } catch {
      call.reject("activate failed: \(error.localizedDescription)")
    }
  }

  /// Called once JS reaches its OWN "fully booted" signal (App.tsx's `initialized`).
  @objc func confirmBoot(_ call: CAPPluginCall) {
    guard let name = call.getString("name") else { call.reject("confirmBoot requires name"); return }
    let json = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    let resultJSON = OtaCore.confirm(fromJSON: json, name: name)
    do {
      try resultJSON.write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8)
      call.resolve(["ok": true])
    } catch {
      call.reject("confirmBoot failed: \(error.localizedDescription)")
    }
  }

  /// Debug/inspection only — surfaces the raw state.json to JS (e.g. a debug-menu tab).
  @objc func getState(_ call: CAPPluginCall) {
    let json = (try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)) ?? "null"
    call.resolve(["stateJSON": json])
  }
}
