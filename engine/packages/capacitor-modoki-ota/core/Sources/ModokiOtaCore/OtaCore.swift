// Pure OTA boot-watchdog state machine (docs/ota-updates.md).
//
// Foundation-only — NO Capacitor/UIKit import — so this target builds and tests on plain
// macOS (no iOS SDK, no Xcode project, no device) via `swift test`. The real plugin
// (ModokiOtaPlugin, iOS-only) is a thin wrapper that does actual file I/O and calls into
// this pure logic; this file owns every DECISION, none of the I/O.
//
// Design note: an adversarial review (2026-07-24) of the original one-shot-confirm design
// found it could permanently brick an app (a bundle promoted to `active` after a single
// rendered frame, then confirmed-but-broken forever). This implementation is the fixed
// design: promotion requires TWO separate successful boots (`requiredConfirms`), a missing
// staged/active bundle folder is checked explicitly (never trust a path that isn't there),
// and every fallback path terminates at `.embedded` (the bundle shipped inside the app
// binary itself, which always exists and was already App-Store-reviewed) rather than
// assuming some other path is safe. See the golden vectors this file is tested against:
// ../../../test-vectors/ota-golden-vectors.json (shared with the Java port).

import Foundation

public enum OtaTarget: Equatable {
  case embedded
  case version(name: String, version: String)
}

/// All per-bundle-name maps, so bundles never interfere with each other's boot/confirm
/// bookkeeping (an adversarial-review finding against a flat/scalar design).
public struct OtaState: Equatable {
  public var active: [String: String]
  public var pending: [String: String]
  public var bootAttempts: [String: Int]
  public var confirmedBoots: [String: Int]
  /// Versions this device has PROVEN bad (they exhausted `maxAttempts` without ever
  /// confirming) and must never stage again. Phase 3a — see the adversarial spike in the
  /// plan doc: without this, `revert()` erased all memory of the failure and the very next
  /// launch re-staged the same broken bundle, forever.
  public var rejected: [String: [String]]
  /// The app-binary version (`CFBundleVersion` on iOS, `versionCode` on Android) last seen
  /// by `resetForNewBinary`. `nil` means either a fresh install OR a state.json written by
  /// a pre-this-feature binary that never tracked it — both cases must NOT trigger a reset
  /// (a fresh install has nothing to reset; an upgrading device's existing bookkeeping is
  /// still valid and must not be nuked just because this field was never populated before).
  public var lastSeenBinaryVersion: String?

  public init(
    active: [String: String] = [:],
    pending: [String: String] = [:],
    bootAttempts: [String: Int] = [:],
    confirmedBoots: [String: Int] = [:],
    rejected: [String: [String]] = [:],
    lastSeenBinaryVersion: String? = nil
  ) {
    self.active = active
    self.pending = pending
    self.bootAttempts = bootAttempts
    self.confirmedBoots = confirmedBoots
    self.rejected = rejected
    self.lastSeenBinaryVersion = lastSeenBinaryVersion
  }
}

public enum OtaCore {
  /// A pending version gets exactly this many boot attempts before the watchdog reverts it
  /// — NOT 1: a single failed launch (OS-killed under load, user force-quit a slow first
  /// load) is not proof the bundle is broken (adversarial-review finding).
  public static let maxAttempts = 3
  /// A pending version must reach the app's OWN "fully booted" signal on TWO SEPARATE
  /// launches before being promoted to `active` — not one. A single rendered frame is not
  /// proof against a bundle that crashes later in a gameplay path; this raises the bar
  /// without requiring full runtime crash-loop detection (out of scope for Phase 1 — see
  /// docs/ota-updates.md's "out of scope" note).
  public static let requiredConfirms = 2
  /// FIFO cap on `rejected` entries per bundle — this file is read on every cold boot, so
  /// an unbounded list is a slow leak. Dropping the OLDEST is safe: re-staging an ancient
  /// version requires the CDN to still advertise it, which the publisher controls.
  public static let maxRejectedPerBundle = 10

  // MARK: - JSON parsing (part of the tested contract — a corrupt/missing state file MUST
  // fall back to `.embedded`, never throw, never leave the app pointed at a bad path)

  public static func parseState(_ json: String?) -> OtaState? {
    guard let json, !json.isEmpty, let data = json.data(using: .utf8) else { return nil }
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    func stringMap(_ key: String) -> [String: String] {
      (obj[key] as? [String: String]) ?? [:]
    }
    func intMap(_ key: String) -> [String: Int] {
      guard let raw = obj[key] as? [String: Any] else { return [:] }
      var out: [String: Int] = [:]
      for (k, v) in raw {
        if let n = v as? Int { out[k] = n } else if let n = v as? NSNumber { out[k] = n.intValue }
      }
      return out
    }
    // A state.json written by a Phase 1/2 binary has no `rejected` key at all — it must
    // parse as an empty map, never nil-crash (same contract as every other field).
    func stringListMap(_ key: String) -> [String: [String]] {
      (obj[key] as? [String: [String]]) ?? [:]
    }
    return OtaState(
      active: stringMap("active"),
      pending: stringMap("pending"),
      bootAttempts: intMap("bootAttempts"),
      confirmedBoots: intMap("confirmedBoots"),
      rejected: stringListMap("rejected"),
      lastSeenBinaryVersion: obj["lastSeenBinaryVersion"] as? String
    )
  }

  public static func serialize(_ state: OtaState) -> String {
    let obj: [String: Any] = [
      "active": state.active,
      "pending": state.pending,
      "bootAttempts": state.bootAttempts,
      "confirmedBoots": state.confirmedBoots,
      "rejected": state.rejected,
      "lastSeenBinaryVersion": state.lastSeenBinaryVersion ?? NSNull(),
    ]
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
  }

  // MARK: - New-binary reset

  /// Called once per boot, BEFORE `boot(state:...)`, with the app's own current binary
  /// version. A genuine App Store/Play Store update already makes Capacitor's own
  /// `isNewBinary()` fall back to the embedded bundle for what it SERVES (see
  /// OtaPlugin.swift's header) — but that's a separate mechanism from OUR bookkeeping, and
  /// without this, `active`/`pending`/`bootAttempts`/`confirmedBoots` would keep referencing
  /// a snapshot Capacitor has already silently abandoned. A fresh binary always ships its
  /// own latest embedded code/assets, so there is nothing meaningful left to resume —
  /// wiping the live bookkeeping is correct, not just a heal.
  ///
  /// `rejected` (the quarantine list) is deliberately PRESERVED across a reset: it's a
  /// bare list of version strings already proven bad, not a reference to any snapshot on
  /// disk — a fresh binary has no reason to be willing to re-stage a version that already
  /// failed 3 times under a previous binary.
  ///
  /// A `nil` `lastSeenBinaryVersion` (fresh install, OR a state.json written by a binary
  /// that predates this field) is NOT treated as "new binary, reset" — it only stamps the
  /// current version and leaves everything else untouched. Only a genuine, previously-
  /// recorded VALUE that differs triggers a reset; an unknown baseline must never nuke a
  /// device's real, still-valid state.
  public static func resetForNewBinary(_ state: OtaState?, currentBinaryVersion: String) -> OtaState? {
    guard var s = state else { return nil } // nothing to reset — boot() already treats nil as fresh/embedded
    if let lastSeen = s.lastSeenBinaryVersion, lastSeen != currentBinaryVersion {
      s = OtaState(rejected: s.rejected, lastSeenBinaryVersion: currentBinaryVersion)
    } else if s.lastSeenBinaryVersion == nil {
      s.lastSeenBinaryVersion = currentBinaryVersion
    }
    return s
  }

  // MARK: - Boot

  /// Convenience entry point taking the raw (possibly nil/corrupt) state.json contents —
  /// this is what the native boot hook actually calls, so "corrupt JSON is safe" is
  /// exercised by the same tested code path, not left as an assumption in untested glue.
  public static func boot(
    fromJSON json: String?,
    name: String,
    folderExists: (_ name: String, _ version: String) -> Bool
  ) -> (OtaTarget, OtaState?) {
    boot(state: parseState(json), name: name, folderExists: folderExists)
  }

  public static func boot(
    state: OtaState?,
    name: String,
    folderExists: (_ name: String, _ version: String) -> Bool
  ) -> (OtaTarget, OtaState?) {
    guard var s = state else { return (.embedded, nil) } // fresh install / corrupt state.json

    if let pendingVersion = s.pending[name] {
      guard folderExists(name, pendingVersion) else {
        // The staged bundle is missing/corrupted on disk. This is NOT "one more failed
        // attempt" — a bundle that isn't even THERE can never boot no matter how many
        // tries remain, so revert immediately rather than burning attempts waiting.
        //
        // Deliberately does NOT quarantine (Phase 3a): a vanished folder is not proof the
        // bundle is bad — the OS may have cleared it under disk pressure, or a partial
        // stage was cleaned up. Re-staging is the correct heal here, and quarantining
        // would permanently block a perfectly good version over a transient disk event.
        return revert(s, name: name, quarantine: false, folderExists: folderExists)
      }
      let attempts = s.bootAttempts[name] ?? 0
      guard attempts < maxAttempts else {
        // Attempt exhaustion IS proof: this bundle failed to reach the app's own
        // fully-booted signal on `maxAttempts` separate launches. Quarantine it so
        // checkForUpdate never stages it again on this device.
        return revert(s, name: name, quarantine: true, folderExists: folderExists)
      }
      s.bootAttempts[name] = attempts + 1
      return (.version(name: name, version: pendingVersion), s)
    }

    guard let activeVersion = s.active[name] else { return (.embedded, s) }
    guard folderExists(name, activeVersion) else {
      // Self-heal: an active pointer to a folder that no longer exists (disk damage,
      // manual cleanup bug) must never be retried forever — clear it and fall back.
      s.active.removeValue(forKey: name)
      return (.embedded, s)
    }
    return (.version(name: name, version: activeVersion), s)
  }

  private static func revert(
    _ state: OtaState,
    name: String,
    quarantine: Bool,
    folderExists: (_ name: String, _ version: String) -> Bool
  ) -> (OtaTarget, OtaState?) {
    var s = state
    if quarantine, let badVersion = s.pending[name] {
      var list = s.rejected[name] ?? []
      if !list.contains(badVersion) { list.append(badVersion) }
      if list.count > maxRejectedPerBundle { list.removeFirst(list.count - maxRejectedPerBundle) }
      s.rejected[name] = list
    }
    s.pending.removeValue(forKey: name)
    s.bootAttempts.removeValue(forKey: name)
    s.confirmedBoots.removeValue(forKey: name)
    if let activeVersion = s.active[name], folderExists(name, activeVersion) {
      return (.version(name: name, version: activeVersion), s)
    }
    // The fallback target itself is gone too — the ultimate safety net is the bundle
    // shipped inside the app binary, which by definition always exists.
    s.active.removeValue(forKey: name)
    return (.embedded, s)
  }

  // MARK: - Confirm

  /// Called once the app reaches its OWN existing "fully booted" signal (this repo's is
  /// `initialized` in App.tsx — `onSceneReady` plus two rendered frames, i.e. genuine
  /// proof the new JS executed and rendered, not just that `index.html` loaded).
  /// A no-op when nothing is pending — a normal boot on an already-active version must
  /// NEVER clear `active` (an earlier design bug this fixes: an unconditional confirm on
  /// every boot would wipe `active` to nil on a normal launch).
  public static func confirm(fromJSON json: String?, name: String) -> String {
    serialize(confirm(state: parseState(json), name: name) ?? OtaState())
  }

  public static func confirm(state: OtaState?, name: String) -> OtaState? {
    guard var s = state else { return nil }
    guard let pendingVersion = s.pending[name] else { return s }
    let confirms = (s.confirmedBoots[name] ?? 0) + 1
    if confirms >= requiredConfirms {
      s.active[name] = pendingVersion
      s.pending.removeValue(forKey: name)
      s.bootAttempts.removeValue(forKey: name)
      s.confirmedBoots.removeValue(forKey: name)
    } else {
      s.confirmedBoots[name] = confirms
    }
    return s
  }
}
