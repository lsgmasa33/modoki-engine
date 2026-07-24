// Pure OTA boot-watchdog state machine (docs/plans/mobile-ota-updates-plan.md, Phase 1).
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

  public init(
    active: [String: String] = [:],
    pending: [String: String] = [:],
    bootAttempts: [String: Int] = [:],
    confirmedBoots: [String: Int] = [:]
  ) {
    self.active = active
    self.pending = pending
    self.bootAttempts = bootAttempts
    self.confirmedBoots = confirmedBoots
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
  /// the plan doc's explicitly-documented limitation).
  public static let requiredConfirms = 2

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
    return OtaState(
      active: stringMap("active"),
      pending: stringMap("pending"),
      bootAttempts: intMap("bootAttempts"),
      confirmedBoots: intMap("confirmedBoots")
    )
  }

  public static func serialize(_ state: OtaState) -> String {
    let obj: [String: Any] = [
      "active": state.active,
      "pending": state.pending,
      "bootAttempts": state.bootAttempts,
      "confirmedBoots": state.confirmedBoots,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
    return String(data: data, encoding: .utf8) ?? "{}"
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
        return revert(s, name: name, folderExists: folderExists)
      }
      let attempts = s.bootAttempts[name] ?? 0
      guard attempts < maxAttempts else {
        return revert(s, name: name, folderExists: folderExists)
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
    folderExists: (_ name: String, _ version: String) -> Bool
  ) -> (OtaTarget, OtaState?) {
    var s = state
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
