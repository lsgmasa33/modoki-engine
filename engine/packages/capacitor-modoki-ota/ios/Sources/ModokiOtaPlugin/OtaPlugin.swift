// OTA update Capacitor plugin (docs/ota-updates.md).
//
// DEVICE-VERIFIED on a real iPhone (2026-07-24/25): stage → promote → revert → fix-forward,
// plus delta staging from both bases. Written against Capacitor 8's actual source, read
// directly rather than guessed. The `rejected` quarantine path is the one part NOT yet
// exercised on iOS — it passes the shared vectors and needed no change here, but see
// docs/ota-updates.md.
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

/// The one-and-only bundle name shipped today (the whole app IS the game — see
/// docs/ota-updates.md; per-sub-game bundle names are a future concern, not exercised here).
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

  /// The app-binary version `resetForNewBinary` compares against — same signal Capacitor's
  /// own `isNewBinary()` uses (`CFBundleVersion`, not the human-readable
  /// `CFBundleShortVersionString`; the build number changes on every submission, the
  /// marketing version doesn't have to). Falls back to a fixed sentinel on the
  /// (unreachable in a real app, but defensive) case the key is absent — never crashes.
  static var currentBinaryVersion: String {
    (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "unknown"
  }

  /// Guards every state.json read-MODIFY-write sequence (`OtaBootHook.run`, `activate`,
  /// `confirmBoot`). Each individual write is already atomic (`atomically: true` — a tmp
  /// file + rename), but that alone doesn't stop a LOST UPDATE: two concurrent callers can
  /// both read the same old state, then both write their own modified copy — the second
  /// write silently clobbers the first's change. OTA Phase 4 made this a real, not just
  /// theoretical, bug: the shell's own `confirmBoot` and a sub-game's `confirmBoot` can now
  /// fire close together in the same boot, and one's `confirmedBoots` increment was
  /// observed lost on a real device (see docs/plans/mobile-ota-updates-plan.md). A single
  /// shared lock serializes every mutation within this process — the only writer of this
  /// file — which is all that's needed (no cross-process access to guard against).
  static let stateLock = NSLock()
}

/// Called from `MyViewController.instanceDescriptor()` BEFORE `super.instanceDescriptor()`
/// — the documented Capacitor extension point for deciding what gets served, which runs
/// before the WKWebView/bridge exist. Integration (live in `games/ota-test`'s
/// MyViewController.swift — this is the real, shipped shape, not a sketch):
///
/// ```swift
/// override func instanceDescriptor() -> InstanceDescriptor {
///     OtaBootHook.run(name: otaShellBundleName)
///     return super.instanceDescriptor()
/// }
/// ```
public enum OtaBootHook {
  public static func run(name: String) {
    OtaPaths.stateLock.lock()
    let target: OtaTarget
    do {
      defer { OtaPaths.stateLock.unlock() }
      let stateJSON = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
      let folderExists: (String, String) -> Bool = { n, v in
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: OtaPaths.versionDir(name: n, version: v).path, isDirectory: &isDir)
        return exists && isDir.boolValue
          && FileManager.default.fileExists(atPath: OtaPaths.versionDir(name: n, version: v).appendingPathComponent("index.html").path)
      }

      // Detect a genuine App/Play Store update BEFORE deciding what to boot — see
      // OtaCore.resetForNewBinary's doc comment for why our own bookkeeping needs this
      // independently of Capacitor's own isNewBinary() (which only decides what IT serves).
      let parsedState = OtaCore.resetForNewBinary(OtaCore.parseState(stateJSON), currentBinaryVersion: OtaPaths.currentBinaryVersion)
      let (bootTarget, newState) = OtaCore.boot(state: parsedState, name: name, folderExists: folderExists)
      if let newState { try? OtaCore.serialize(newState).write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8) }
      target = bootTarget
    }

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
    CAPPluginMethod(name: "stageUpdateDelta", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "confirmBoot", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listBundles", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "beginBundleLoad", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "reportBundleLoadFailure", returnType: CAPPluginReturnPromise),
  ]

  /// Emits `otaProgress` (Phase 3a — plumbing only, no UI consumes this yet). Safe to
  /// call from any queue — `CAPPlugin.notifyListeners` marshals to the bridge itself.
  /// `bytesTotal: 0` means "genuinely unknown"; the JS side must treat that as
  /// indeterminate, not "already done".
  private func emitProgress(name: String, version: String, bytesDone: Int64, bytesTotal: Int64, filesDone: Int, filesTotal: Int) {
    notifyListeners("otaProgress", data: [
      "name": name, "version": version,
      "bytesDone": bytesDone, "bytesTotal": bytesTotal,
      "filesDone": filesDone, "filesTotal": filesTotal,
    ])
  }

  /// Downloads a bundle zip directly (URLSession — bypasses the JS bridge for the
  /// payload bytes entirely, the reason this needs to be native at all: marshalling
  /// thousands of small files through the bridge as base64 is prohibitively slow),
  /// verifies its SHA-256 against the manifest-provided hash, and unzips it into a
  /// `.tmp` staging folder that's only atomically renamed into its final
  /// `ionic_built_snapshots/<name>-<version>/` location once the whole zip has been
  /// verified AND fully extracted — so a kill mid-download/mid-unzip can never leave a
  /// half-written folder where `boot()`'s `folderExists` check would find it.
  ///
  /// Progress: rather than switching to a delegate-based `downloadTask` (a bigger
  /// refactor), a `dataTask`'s returned `URLSessionTask` already exposes
  /// `countOfBytesReceived`/`countOfBytesExpectedToReceive` — a short-interval timer
  /// polls those for real byte-level `otaProgress` ticks with a minimal diff.
  @objc func stageUpdate(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version"),
          let zipUrlString = call.getString("zipUrl"), let zipUrl = URL(string: zipUrlString),
          let expectedHash = call.getString("expectedZipHash") else {
      call.reject("stageUpdate requires name, version, zipUrl, expectedZipHash")
      return
    }
    let expectedSize = Int64(call.getInt("expectedZipSize") ?? 0)

    var progressTimer: DispatchSourceTimer?
    let task = URLSession.shared.dataTask(with: zipUrl) { [weak self] data, response, error in
      progressTimer?.cancel()
      guard let self else { return }
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
        self.emitProgress(name: name, version: version, bytesDone: Int64(data.count), bytesTotal: max(expectedSize, Int64(data.count)), filesDone: 1, filesTotal: 1)
        call.resolve(["ok": true])
      } catch {
        call.reject("stage failed: \(error.localizedDescription)")
      }
    }

    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    timer.schedule(deadline: .now(), repeating: .milliseconds(200))
    timer.setEventHandler { [weak self, weak task] in
      guard let self, let task, task.state == .running else { return }
      let total = task.countOfBytesExpectedToReceive > 0 ? task.countOfBytesExpectedToReceive : expectedSize
      self.emitProgress(name: name, version: version, bytesDone: task.countOfBytesReceived, bytesTotal: total, filesDone: 0, filesTotal: 1)
    }
    progressTimer = timer
    timer.resume()
    task.resume()
  }

  /// Phase 2 delta staging (docs/ota-updates.md) — builds the `version`
  /// folder WITHOUT downloading a whole-bundle zip: copies `copy` (unchanged relative
  /// paths, byte-for-byte) from `baseVersion`'s already-on-disk folder — OR, when
  /// `baseVersion == "embedded"`, from the app's OWN bundled webDir
  /// (`Bundle.main.resourceURL/public`, Capacitor's actual default `appLocation` per
  /// `CAPInstanceDescriptor.m` — read from source, not guessed, same discipline as the
  /// `ionic_built_snapshots` path above) — and downloads only `download` (new/changed
  /// files), each independently SHA-256-verified against its own hash before being
  /// written. Same atomicity contract as `stageUpdate`: builds into a `.tmp` dir, only
  /// renamed into place once every copy AND download has succeeded and verified.
  @objc func stageUpdateDelta(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version"),
          let baseVersion = call.getString("baseVersion"),
          let copyPaths = call.getArray("copy", String.self) else {
      call.reject("stageUpdateDelta requires name, version, baseVersion, copy")
      return
    }
    struct DeltaDownload { let path: String; let url: URL; let hash: String; let size: Int64 }
    var downloads: [DeltaDownload] = []
    for item in call.getArray("download") ?? [] {
      guard let obj = item as? JSObject,
            let path = obj["path"] as? String,
            let urlString = obj["url"] as? String, let url = URL(string: urlString),
            let hash = obj["hash"] as? String else {
        call.reject("stageUpdateDelta: malformed entry in download[]")
        return
      }
      let size = (obj["size"] as? NSNumber)?.int64Value ?? 0
      downloads.append(DeltaDownload(path: path, url: url, hash: hash, size: size))
    }
    print("[ModokiOta] stageUpdateDelta \(name)@\(version) from \(baseVersion): copy=\(copyPaths.count) download=\(downloads.count)")

    // Progress (Phase 3a — plumbing only, no UI consumes this yet). filesTotal/bytesTotal
    // are known upfront; copies only move filesDone (no network, byte total unknown —
    // same "byte-granularity is download-only" scope as the Android port).
    // `progressLock` serializes filesDone/bytesDone across the concurrent download
    // completion handlers below (each fires on its own URLSession callback thread).
    let filesTotal = copyPaths.count + downloads.count
    let bytesTotal = downloads.reduce(Int64(0)) { $0 + $1.size }
    var filesDone = 0
    var bytesDone: Int64 = 0
    let progressLock = NSLock()
    func reportFileDone(bytes: Int64) {
      progressLock.lock()
      filesDone += 1
      bytesDone += bytes
      let (fd, bd) = (filesDone, bytesDone)
      progressLock.unlock()
      emitProgress(name: name, version: version, bytesDone: bd, bytesTotal: bytesTotal, filesDone: fd, filesTotal: filesTotal)
    }

    let sourceDir = baseVersion == "embedded"
      ? (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("public")
      : OtaPaths.versionDir(name: name, version: baseVersion)
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: sourceDir.path, isDirectory: &isDir), isDir.boolValue else {
      call.reject("stageUpdateDelta: base version folder not found: \(sourceDir.path)")
      return
    }

    let tmpDir = OtaPaths.snapshotsDir.appendingPathComponent(".tmp-\(name)-\(version)-\(UUID().uuidString)")
    do {
      try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

      for relPath in copyPaths {
        let src = sourceDir.appendingPathComponent(relPath)
        guard FileManager.default.fileExists(atPath: src.path) else {
          throw NSError(domain: "ModokiOta", code: 1, userInfo: [NSLocalizedDescriptionKey: "delta copy source missing: \(relPath)"])
        }
        let dst = tmpDir.appendingPathComponent(relPath)
        try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: src, to: dst)
        reportFileDone(bytes: 0) // copies don't count toward bytesTotal — see comment above
      }

      // Plugin methods already run off the main thread, so a blocking DispatchGroup here
      // (rather than nesting async completion handlers) is safe and keeps the
      // stage-then-activate ordering simple, matching the synchronous copy loop above.
      let group = DispatchGroup()
      var downloadError: Error?
      for d in downloads {
        group.enter()
        URLSession.shared.dataTask(with: d.url) { data, response, error in
          defer { group.leave() }
          if let error { downloadError = error; return }
          guard let data, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            downloadError = NSError(domain: "ModokiOta", code: 2, userInfo: [NSLocalizedDescriptionKey: "download failed: \(d.path)"])
            return
          }
          let actualHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
          guard actualHash == d.hash.lowercased() else {
            downloadError = NSError(domain: "ModokiOta", code: 3, userInfo: [NSLocalizedDescriptionKey: "hash mismatch: \(d.path)"])
            return
          }
          do {
            let dst = tmpDir.appendingPathComponent(d.path)
            try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: dst)
            reportFileDone(bytes: Int64(data.count))
          } catch {
            downloadError = error
          }
        }.resume()
      }
      group.wait()
      if let downloadError { throw downloadError }

      let finalDir = OtaPaths.versionDir(name: name, version: version)
      try? FileManager.default.removeItem(at: finalDir) // a stale partial from an earlier interrupted attempt
      try FileManager.default.moveItem(at: tmpDir, to: finalDir) // atomic on the same volume
      call.resolve(["ok": true])
    } catch {
      try? FileManager.default.removeItem(at: tmpDir)
      call.reject("stageUpdateDelta failed: \(error.localizedDescription)")
    }
  }

  /// Marks `version` as the pending version for `name` in state.json. Does NOT touch
  /// `KeyValueStore`/serverBasePath immediately — Phase 1 is "apply next launch" by
  /// design (see docs/ota-updates.md); `OtaBootHook.run` is the sole authority over what gets
  /// served, and it re-derives that from state.json on every single launch regardless,
  /// so there is exactly one source of truth instead of two that could disagree.
  @objc func activate(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version") else {
      call.reject("activate requires name, version"); return
    }
    OtaPaths.stateLock.lock()
    defer { OtaPaths.stateLock.unlock() }
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
    OtaPaths.stateLock.lock()
    defer { OtaPaths.stateLock.unlock() }
    let json = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    // `version` is optional: the SHELL has none to name (its boot hook is the sole
    // authority over what got served), a sub-game always passes one. See OtaCore.confirm.
    let resultJSON = OtaCore.confirm(fromJSON: json, name: name, version: call.getString("version"))
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

  /// `folderExists` probe for a SUB-GAME bundle — deliberately NOT the one `OtaBootHook.run`
  /// uses.
  ///
  /// ⚠️ The shell's probe additionally requires `index.html`, because a shell bundle is what
  /// the WebView serves. A sub-game bundle has no `index.html` at all — it is `subgame.json`
  /// + `subgame.js`, script-loaded into the shell's already-running page. Reusing the shell's
  /// predicate here would make EVERY sub-game look absent, and `boot()` answers an absent
  /// pending folder with an immediate revert: every staged sub-game would be silently thrown
  /// away on its first load. Same directory check `listBundles` uses.
  private static func versionFolderExists(_ name: String, _ version: String) -> Bool {
    var isDir: ObjCBool = false
    let dir = OtaPaths.versionDir(name: name, version: version)
    return FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue
  }

  private func resolveTarget(_ target: OtaTarget) -> [String: Any] {
    switch target {
    case .embedded:
      // For a SUB-GAME there is no embedded copy — a sub-game is script-loaded, never
      // shipped in the app binary — so `.embedded` means "nothing loadable for this name".
      return ["target": "none"]
    case let .version(name, version):
      return ["target": "version", "name": name, "version": version,
              "path": OtaPaths.versionDir(name: name, version: version).path]
    }
  }

  /// #553 — the sub-game counterpart of the shell's native boot hook. Decides which version
  /// of `name` to load and COUNTS THE ATTEMPT before the caller loads anything, so a bundle
  /// that takes the page down with it still burns an attempt and is eventually reverted.
  ///
  /// ⚠️ Uses the very same `OtaCore.boot()` the shell does, which is the point: `pending` is
  /// preferred over `active`, so the version that loads is the version a subsequent
  /// `confirmBoot` promotes. `listBundles()` orders them the other way round and MUST NOT be
  /// used to decide what to load — that inversion is exactly the #553 defect.
  @objc func beginBundleLoad(_ call: CAPPluginCall) {
    guard let name = call.getString("name") else { call.reject("beginBundleLoad requires name"); return }
    OtaPaths.stateLock.lock()
    defer { OtaPaths.stateLock.unlock() }
    let json = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    let (target, newState) = OtaCore.boot(fromJSON: json, name: name, folderExists: Self.versionFolderExists)
    if let newState {
      try? OtaCore.serialize(newState).write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8)
    }
    call.resolve(resolveTarget(target))
  }

  /// #553/#550 — records what a failed load of a SPECIFIC version proves, and returns the
  /// version to fall back to this launch. `disposition` is one of `fatal` / `transient` /
  /// `notEvidence`; see OtaCore's `OtaLoadFailure` for why they are not interchangeable.
  ///
  /// ⚠️ The returned fallback must never be confirmed by the caller — it is the version being
  /// replaced, and crediting a confirm to it is the #553 defect itself.
  @objc func reportBundleLoadFailure(_ call: CAPPluginCall) {
    guard let name = call.getString("name"), let version = call.getString("version") else {
      call.reject("reportBundleLoadFailure requires name, version"); return
    }
    guard let disposition = OtaLoadFailure(rawValue: call.getString("disposition") ?? "") else {
      call.reject("reportBundleLoadFailure requires disposition of fatal|transient|notEvidence"); return
    }
    OtaPaths.stateLock.lock()
    defer { OtaPaths.stateLock.unlock() }
    let json = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    let (target, newState) = OtaCore.loadFailed(
      state: OtaCore.parseState(json), name: name, version: version,
      disposition: disposition, folderExists: Self.versionFolderExists
    )
    if let newState {
      try? OtaCore.serialize(newState).write(to: OtaPaths.stateFilePath, atomically: true, encoding: .utf8)
    }
    call.resolve(resolveTarget(target))
  }

  /// OTA Phase 4 (docs/ota-subgame-modules.md) — every bundle with content actually on
  /// disk. ⚠️ DISCOVERY ONLY: `active` is preferred over `pending` here, which is the
  /// opposite of what loading needs — use `beginBundleLoad` to decide what to load (#553).
  /// See the TS doc comment in definitions.ts.
  @objc func listBundles(_ call: CAPPluginCall) {
    let json = try? String(contentsOf: OtaPaths.stateFilePath, encoding: .utf8)
    guard let state = OtaCore.parseState(json) else { call.resolve(["bundles": []]); return }
    var seen = Set<String>()
    var result: [[String: Any]] = []
    func appendIfStaged(_ name: String, _ version: String) {
      guard !seen.contains(name) else { return }
      let dir = OtaPaths.versionDir(name: name, version: version)
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { return }
      result.append(["name": name, "version": version, "path": dir.path])
      seen.insert(name)
    }
    for (name, version) in state.active { appendIfStaged(name, version) }
    for (name, version) in state.pending { appendIfStaged(name, version) }
    call.resolve(["bundles": result])
  }
}
