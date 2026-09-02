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

  /// Lists every real (non-dot-prefixed) version-folder name currently in `snapshotsDir` —
  /// shared across every bundle's `pruneVersions` call in one boot so the directory is only
  /// listed once and reused, not re-listed per bundle.
  static func listSnapshotFolders() -> [String] {
    let entries = (try? FileManager.default.contentsOfDirectory(atPath: snapshotsDir.path)) ?? []
    var onDisk: [String] = []
    for entry in entries where !entry.hasPrefix(".") {
      var isDir: ObjCBool = false
      let path = snapshotsDir.appendingPathComponent(entry).path
      guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { continue }
      onDisk.append(entry)
    }
    return onDisk
  }

  /// Deletes on-disk version folders for `name` that `OtaCore.pruneVersions` says are safe
  /// to reclaim (#563) — everything except the current `active`/`pending` version. The
  /// caller MUST dispatch this off the boot critical path (a background queue) — it walks
  /// and deletes a directory tree, and boot latency must never wait on housekeeping. Never
  /// throws: a prune failure here must not fail boot.
  ///
  /// `onDisk` is EVERY folder in `snapshotsDir` — not just ones prefixed `"\(name)-"` — and
  /// is handed to `OtaCore.pruneVersions`, which owns the (bundle names may contain
  /// hyphens) disambiguation of which bundle each folder belongs to. Splitting on `name`'s
  /// own prefix here would reintroduce exactly the bug that decision was moved into the
  /// pure function to avoid (`ota` pruning could mistake `ota-test-v1` for its own). Passed
  /// in (rather than listed here) so the boot hook can list `snapshotsDir` ONCE and reuse it
  /// across every bundle's prune call in the same boot.
  ///
  /// `keepVersion` is the version `boot()` just chose as THIS launch's target — excluded
  /// (by its FULL folder name) even if `pruneVersions` somehow returned it (defence in
  /// depth; it never should, since `boot()` only ever targets `active`/`pending`, which
  /// `pruneVersions` already protects). Only meaningful for the SHELL's own prune pass — a
  /// sub-game's own active/pending folders are already protected by `pruneVersions` itself,
  /// so callers pass `nil` for every other bundle name.
  static func pruneVersions(name: String, state: OtaState?, keepVersion: String?, onDisk: [String]) {
    let toPrune = OtaCore.pruneVersions(state: state, name: name, onDisk: onDisk)
    let keepFolder = keepVersion.map { versionFolderName(name: name, version: $0) }
    for folder in toPrune where folder != keepFolder {
      try? FileManager.default.removeItem(at: snapshotsDir.appendingPathComponent(folder))
    }
  }

  /// Reclaims a `.tmp-<name>-<version>-<uuid>` folder LEAKED by a process kill mid-stage
  /// (`stageUpdate`/`stageUpdateDelta` build into one of these before the atomic rename —
  /// each attempt uses a fresh UUID, so a killed attempt's tmp tree is otherwise never
  /// revisited by anything). F1: a `.tmp-` dir is reclaimable only when no stage IN THIS
  /// PROCESS currently owns it — checked via `isTmpDirInFlight`, NOT via "the app has just
  /// started, so by construction no stage can be in flight". iOS's boot hook runs once per
  /// app launch (unlike Android's `onCreate`, which can re-enter mid-process), but
  /// `stageUpdate`/`stageUpdateDelta` are async network calls that can still be genuinely
  /// running when this sweep executes on a background queue right after boot, so the same
  /// guard is applied here for parity and because it is the ONLY correct reasoning either
  /// way. A previous PROCESS's leaked tmp dirs are still safe to reclaim unconditionally:
  /// the in-flight set starts empty every process launch, so a dir belonging to an earlier
  /// process can never appear in it. Never throws — housekeeping only, same discipline as
  /// `pruneVersions`.
  static func pruneLeakedTmpFolders() {
    let entries = (try? FileManager.default.contentsOfDirectory(atPath: snapshotsDir.path)) ?? []
    for entry in entries where entry.hasPrefix(".tmp-") {
      if isTmpDirInFlight(entry) { continue } // owned by a stage in THIS process
      try? FileManager.default.removeItem(at: snapshotsDir.appendingPathComponent(entry))
    }
  }

  /// Process-lifetime, lock-guarded set of `.tmp-` staging dir NAMES (last path component —
  /// what `pruneLeakedTmpFolders` iterates) a stage on THIS process is currently writing
  /// into (F1) — same reasoning and lifecycle as Android's `IN_FLIGHT_TMP_DIRS`. Entries are
  /// added immediately BEFORE any write into the dir begins and removed in a `defer` block
  /// that runs regardless of success/verification-failure/error, so an entry is always
  /// removed exactly once staging for that dir is fully done.
  private static var inFlightTmpDirNames = Set<String>()
  private static let inFlightTmpDirsLock = NSLock()

  static func markTmpDirInFlight(_ name: String) {
    inFlightTmpDirsLock.lock()
    defer { inFlightTmpDirsLock.unlock() }
    inFlightTmpDirNames.insert(name)
  }

  static func unmarkTmpDirInFlight(_ name: String) {
    inFlightTmpDirsLock.lock()
    defer { inFlightTmpDirsLock.unlock() }
    inFlightTmpDirNames.remove(name)
  }

  static func isTmpDirInFlight(_ name: String) -> Bool {
    inFlightTmpDirsLock.lock()
    defer { inFlightTmpDirsLock.unlock() }
    return inFlightTmpDirNames.contains(name)
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
    let stateAfterBoot: OtaState?
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
      stateAfterBoot = newState ?? parsedState
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

    // Reclaim superseded version folders — #563. Dispatched to a background queue so it
    // cannot add to boot latency; the target decision above is already final by the time
    // this runs, and OtaPaths.pruneVersions never throws (a prune failure is housekeeping,
    // not a reason to fail boot).
    //
    // Prune for EVERY bundle name the state mentions, not just the shell's own `name`
    // (#563 was only half-delivered — sub-games stage into sibling `<subgame>-<version>`
    // folders through this same client, and pruneVersions correctly refuses to touch a
    // folder owned by a different bundle, so those folders were immortal). The union of
    // active/pending/bootAttempts/confirmedBoots/rejected keys is every bundle this device
    // has ever known about; `name` itself is added in case it isn't already a key (e.g. a
    // fresh device that has never staged anything but the embedded shell). `keepVersion`
    // (this launch's own target) only ever applies to the shell's own prune pass — a
    // sub-game's own active/pending folders are already protected by pruneVersions itself.
    //
    // Note: a store update (`resetForNewBinary`) clears `active`/`pending`, which can leave
    // a sub-game's on-disk folder temporarily unowned by any state entry. That's fine —
    // this self-heals on the NEXT boot once JS re-stages the sub-game and its name
    // reappears in state.
    let keepVersion: String? = { if case let .version(_, v) = target { return v } else { return nil } }()
    // F2: the union-over-every-state-map decision now lives in the pure, vector-tested
    // OtaCore.bundlesToPrune — see its doc comment — rather than being rebuilt inline here
    // where no test reaches it.
    let allBundleNames = OtaCore.bundlesToPrune(state: stateAfterBoot, shellName: name)
    DispatchQueue.global(qos: .utility).async {
      // Listed once and reused across bundles rather than re-listing per bundle.
      let onDisk = OtaPaths.listSnapshotFolders()
      for bundleName in allBundleNames {
        OtaPaths.pruneVersions(name: bundleName, state: stateAfterBoot, keepVersion: bundleName == name ? keepVersion : nil, onDisk: onDisk)
      }
      // Reclaim any `.tmp-` folder no stage in THIS process still owns — see
      // pruneLeakedTmpFolders' doc comment. It is safe wherever it is called, NOT only in
      // the boot hook: an in-flight stage is excluded by IN_FLIGHT_TMP_DIRS, and a previous
      // process's dirs are unreachable because that set starts empty. The earlier
      // "no stage can be in flight this early" reasoning was WRONG (this hook re-runs on
      // Activity recreation on Android) and is what made the sweep able to delete a live
      // staging tree; do not reintroduce it.
      OtaPaths.pruneLeakedTmpFolders()
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
    // #556 legacy-caller tolerance: `files` is REQUIRED by our own TS definitions, but the
    // JS calling us is itself delivered over OTA and can predate this native binary (a
    // device staying on a pre-#556 shell bundle after a native update). Rejecting that
    // caller bricks the device — no update can ever stage, so the boot hook keeps
    // preferring the old OTA content forever, even over a freshly installed new binary.
    // So: absent `files` (parseExpectedFiles returns nil) means "legacy caller" (skip
    // verification, log loudly, proceed exactly as pre-#556 code did); a PRESENT-but-
    // malformed `files` throws and still rejects below — a genuine bad payload.
    let expectedFiles: [String: String]?
    do {
      expectedFiles = try Self.parseExpectedFiles(call)
    } catch {
      call.reject("stageUpdate: malformed files parameter: \(error.localizedDescription)")
      return
    }
    if expectedFiles == nil {
      print("[ModokiOta] stageUpdate called without 'files' — this is a pre-#556 JS bundle, so the staged tree is UNVERIFIED (#556).")
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

      // Hoisted out of the `do` block so the `catch` below can clean it up — matches
      // stageUpdateDelta's catch, which does the same (this was the odd one out: its two
      // siblings, stageUpdateDelta here and Android's stageUpdate, both remove `tmpDir` on
      // failure; this one didn't even have it in scope to do so).
      let tmpDir = OtaPaths.snapshotsDir.appendingPathComponent(".tmp-\(name)-\(version)-\(UUID().uuidString)")
      // F1: mark this tmp dir in-flight BEFORE any write into it begins, so a re-entrant
      // boot-hook sweep (OtaPaths.pruneLeakedTmpFolders) never deletes a tree this stage is
      // still writing into. Unmarked unconditionally once staging is fully done.
      let tmpDirName = tmpDir.lastPathComponent
      OtaPaths.markTmpDirInFlight(tmpDirName)
      defer { OtaPaths.unmarkTmpDirInFlight(tmpDirName) }
      do {
        let entries = try OtaZip.unzip(data)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        for entry in entries {
          let entryPath = tmpDir.appendingPathComponent(entry.path)
          try FileManager.default.createDirectory(at: entryPath.deletingLastPathComponent(), withIntermediateDirectories: true)
          try entry.data.write(to: entryPath)
        }
        // #556: verify the staged tree matches the target manifest's file set/hashes
        // EXACTLY before the atomic rename — the whole-zip hash above only proves the
        // DOWNLOAD was intact, never that what got extracted to disk matches it. Skipped
        // for a legacy (pre-#556) caller — see the `expectedFiles == nil` handling above.
        if let expectedFiles {
          try Self.verifyStagedTree(at: tmpDir, expected: expectedFiles)
        }
        let finalDir = OtaPaths.versionDir(name: name, version: version)
        try? FileManager.default.removeItem(at: finalDir) // a stale partial from an earlier interrupted attempt
        try FileManager.default.moveItem(at: tmpDir, to: finalDir) // atomic on the same volume
        self.emitProgress(name: name, version: version, bytesDone: Int64(data.count), bytesTotal: max(expectedSize, Int64(data.count)), filesDone: 1, filesTotal: 1)
        call.resolve(["ok": true])
      } catch {
        try? FileManager.default.removeItem(at: tmpDir)
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
    // #556 legacy-caller tolerance — see stageUpdate's matching comment above: `files` is
    // REQUIRED by our own TS definitions, but the JS calling us is itself delivered over
    // OTA and can predate this native binary. Absent `files` means "legacy caller" (skip
    // verification, log loudly, proceed exactly as pre-#556 code did); present-but-malformed
    // throws and still rejects below — a genuine bad payload.
    let expectedFiles: [String: String]?
    do {
      expectedFiles = try Self.parseExpectedFiles(call)
    } catch {
      call.reject("stageUpdateDelta: malformed files parameter: \(error.localizedDescription)")
      return
    }
    if expectedFiles == nil {
      print("[ModokiOta] stageUpdateDelta called without 'files' — this is a pre-#556 JS bundle, so the staged tree is UNVERIFIED (#556).")
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
    // F1: mark this tmp dir in-flight BEFORE any write into it begins — see stageUpdate's
    // matching comment above. Unmarked unconditionally once staging is fully done.
    let tmpDirName = tmpDir.lastPathComponent
    OtaPaths.markTmpDirInFlight(tmpDirName)
    defer { OtaPaths.unmarkTmpDirInFlight(tmpDirName) }
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

      // #562: SEQUENTIAL, not fanned out concurrently — matching Android's loop shape.
      // The previous concurrent version launched every download at once and had each
      // completion handler assign a shared `var downloadError` with no synchronisation, a
      // real data race (`progressLock` a few lines above only ever guarded the progress
      // counters, not this). Plugin methods already run off the main thread, so blocking
      // on a semaphore per download here is safe and keeps stage-then-activate ordering
      // simple, matching the synchronous copy loop above.
      for d in downloads {
        let semaphore = DispatchSemaphore(value: 0)
        var resultData: Data?
        var resultResponse: URLResponse?
        var resultError: Error?
        URLSession.shared.dataTask(with: d.url) { data, response, error in
          resultData = data
          resultResponse = response
          resultError = error
          semaphore.signal()
        }.resume()
        semaphore.wait()

        if let resultError { throw resultError }
        guard let data = resultData, let http = resultResponse as? HTTPURLResponse, http.statusCode == 200 else {
          throw NSError(domain: "ModokiOta", code: 2, userInfo: [NSLocalizedDescriptionKey: "download failed: \(d.path)"])
        }
        let actualHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actualHash == d.hash.lowercased() else {
          throw NSError(domain: "ModokiOta", code: 3, userInfo: [NSLocalizedDescriptionKey: "hash mismatch: \(d.path)"])
        }
        let dst = tmpDir.appendingPathComponent(d.path)
        try FileManager.default.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: dst)
        reportFileDone(bytes: Int64(data.count))
      }

      // #556: verify the staged tree matches the target manifest's file set/hashes
      // EXACTLY before the atomic rename — `copy` entries above are taken byte-for-byte
      // off disk and hashed by nobody, and each `download` entry is only verified against
      // its OWN hash, never against what's actually sitting in the tmp dir as a whole.
      // Skipped for a legacy (pre-#556) caller — see the `expectedFiles == nil` handling above.
      if let expectedFiles {
        try Self.verifyStagedTree(at: tmpDir, expected: expectedFiles)
      }

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

  /// Parses the `files` param (#556) — the target manifest's full path→hash map — common
  /// to both `stageUpdate` and `stageUpdateDelta`. `nil` (never an empty-but-present
  /// array) means the field is entirely ABSENT — a legacy pre-#556 caller (see
  /// `stageUpdate`/`stageUpdateDelta`'s `expectedFiles == nil` handling). Throws when the
  /// field IS present but an entry is malformed — that is a genuine bad payload, never
  /// tolerated, and the caller must reject on it.
  private static func parseExpectedFiles(_ call: CAPPluginCall) throws -> [String: String]? {
    guard let filesArray = call.getArray("files") else { return nil }
    var expected: [String: String] = [:]
    for item in filesArray {
      guard let obj = item as? JSObject, let path = obj["path"] as? String, let hash = obj["hash"] as? String else {
        throw NSError(domain: "ModokiOta", code: 5, userInfo: [NSLocalizedDescriptionKey: "malformed entry in files[]"])
      }
      expected[path] = hash
    }
    return expected
  }

  /// Hashes every regular file under `dir`, keyed by its path RELATIVE to `dir` with
  /// forward slashes (the same separator the manifest/`files` param uses on every
  /// platform) — the "actual" half of `OtaCore.verifyStagedFiles`'s whole-tree check.
  private static func hashesForTree(at dir: URL) throws -> [String: String] {
    var result: [String: String] = [:]
    let dirPath = dir.standardizedFileURL.path
    guard let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey]) else { return result }
    for case let fileURL as URL in enumerator {
      let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey])
      guard values.isRegularFile == true else { continue }
      var relPath = fileURL.standardizedFileURL.path
      if relPath.hasPrefix(dirPath) { relPath = String(relPath.dropFirst(dirPath.count)) }
      if relPath.hasPrefix("/") { relPath = String(relPath.dropFirst()) }
      let data = try Data(contentsOf: fileURL)
      result[relPath] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    return result
  }

  /// Verifies the tmp dir's ACTUAL contents against `expected` (#556) — called AFTER every
  /// write into the tmp dir and BEFORE the atomic rename, on both `stageUpdate` and
  /// `stageUpdateDelta`. Throws a descriptive error on any mismatch; the caller is
  /// responsible for cleaning up the tmp dir and never renaming it into place.
  private static func verifyStagedTree(at tmpDir: URL, expected: [String: String]) throws {
    let actual = try hashesForTree(at: tmpDir)
    switch OtaCore.verifyStagedFiles(expected: expected, actual: actual) {
    case .ok:
      return
    case let .missing(path):
      throw NSError(domain: "ModokiOta", code: 4, userInfo: [NSLocalizedDescriptionKey: "stage verification failed: missing file \(path)"])
    case let .unexpected(path):
      throw NSError(domain: "ModokiOta", code: 4, userInfo: [NSLocalizedDescriptionKey: "stage verification failed: unexpected file \(path)"])
    case let .hashMismatch(path, expectedHash, actualHash):
      throw NSError(domain: "ModokiOta", code: 4, userInfo: [NSLocalizedDescriptionKey: "stage verification failed: hash mismatch for \(path) (expected \(expectedHash), got \(actualHash))"])
    }
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
