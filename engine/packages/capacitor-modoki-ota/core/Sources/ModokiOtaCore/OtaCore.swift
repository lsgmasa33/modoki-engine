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

/// What a FAILED load of a specific version proves about that version (#553/#550).
///
/// The shell learns a bundle is bad by exhausting `maxAttempts` — it has no way to ask
/// "was that failure the bundle's fault?", because a shell that fails to boot cannot
/// report anything. A SUB-GAME can: it is script-loaded into an already-running page, so
/// its loader (`engine/app/subgameLoader.ts`) knows exactly which check refused it and
/// can say so. That is the whole reason this type exists — and why the three cases are
/// NOT interchangeable severities but three different claims about the evidence:
///
/// - `.fatal` — the bundle's own published bytes are broken (a missing/unparseable
///   `assets.manifest.json`, an unreadable `subgame.json`, a script that won't load, a
///   module with no `game.id`). The zip was SHA-256-verified at stage time, so re-staging
///   would fetch the identical broken bytes: retrying is pointless and QUARANTINE is
///   correct (owner ruling, 2026-09-01). Without it `checkForUpdate` re-stages the same
///   bundle on EVERY launch — the feed still advertises it and nothing vetoes it — which
///   is an unbounded re-download loop, worse than the bug this fixes.
/// - `.transient` — the failure may not recur (a shared-dependency fetch failed). Costs
///   one attempt, exactly like the shell; three of them still exhaust and quarantine.
/// - `.notEvidence` — ⚠️ the refusal says nothing about the bundle: an `engineApi`
///   mismatch or a `gameId` collision with an already-registered game. These MUST NOT
///   quarantine and MUST NOT cost an attempt. `rejected` deliberately survives
///   `resetForNewBinary`, so quarantining a version mismatch would permanently block a
///   bundle that the NEXT app binary would run perfectly — the failure is about the pair
///   (bundle, host), and only the host is going to change.
public enum OtaLoadFailure: String, Equatable {
  case fatal
  case transient
  case notEvidence
}

/// Result of comparing a staged tree's actual file hashes against the target manifest's
/// expected ones (#556). Pure decision — the plugin does the file-system walk/hashing and
/// hands both maps to `OtaCore.verifyStagedFiles`, then turns a non-`.ok` result into a
/// thrown/rejected error before the atomic rename, exactly the shape as every other
/// decision/I-O split in this file.
///
/// `stageUpdateDelta`'s `copy` entries are taken byte-for-byte off disk and hashed by
/// NOBODY, and `stageUpdate` hashes only the whole zip, never the individual files it
/// writes — so a locally-corrupt base file, or a bit-flip during extraction, was
/// previously invisible until something downstream broke. This closes that hole with a
/// single whole-tree check that covers both staging paths identically.
public enum OtaStageVerifyResult: Equatable {
  case ok
  case missing(path: String)
  case unexpected(path: String)
  case hashMismatch(path: String, expected: String, actual: String)
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
  /// #571 anti-rollback — the highest `release.json` `seq` this device has ever recorded.
  /// A single device-wide counter, NOT per-bundle like every other field here: `seq` is a
  /// property of the release DOCUMENT as a whole (one publish counter shared by every
  /// bundle it lists), not of any one bundle's boot/confirm bookkeeping. `0` (not optional)
  /// because a state.json written by a pre-#571 binary having "never recorded anything" is
  /// indistinguishable from "recorded 0" for this check's purposes — see `recordSeq`.
  public var highestSeenSeq: Int

  public init(
    active: [String: String] = [:],
    pending: [String: String] = [:],
    bootAttempts: [String: Int] = [:],
    confirmedBoots: [String: Int] = [:],
    rejected: [String: [String]] = [:],
    lastSeenBinaryVersion: String? = nil,
    highestSeenSeq: Int = 0
  ) {
    self.active = active
    self.pending = pending
    self.bootAttempts = bootAttempts
    self.confirmedBoots = confirmedBoots
    self.rejected = rejected
    self.lastSeenBinaryVersion = lastSeenBinaryVersion
    self.highestSeenSeq = highestSeenSeq
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
      lastSeenBinaryVersion: obj["lastSeenBinaryVersion"] as? String,
      // A state.json written by a pre-#571 binary has no key at all — parses as 0, same
      // "absent means never seen anything" contract every other new field here follows.
      highestSeenSeq: (obj["highestSeenSeq"] as? Int) ?? (obj["highestSeenSeq"] as? NSNumber)?.intValue ?? 0
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
      "highestSeenSeq": state.highestSeenSeq,
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
      // `highestSeenSeq` survives a reset for the same reason `rejected` does: it is a fact
      // about which release.json documents this DEVICE has already seen, not a reference to
      // any snapshot a fresh binary invalidates — a new binary has no reason to become
      // willing to accept a release it would otherwise recognize as a replay.
      s = OtaState(rejected: s.rejected, lastSeenBinaryVersion: currentBinaryVersion, highestSeenSeq: s.highestSeenSeq)
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
    if quarantine, let badVersion = s.pending[name] { addRejected(&s, name: name, version: badVersion) }
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

  /// Appends `version` to `name`'s quarantine list, de-duplicated and FIFO-capped.
  ///
  /// ⚠️ Only ever called for a version sitting in `pending`. Quarantine is a statement
  /// about PUBLISHED content, and a version that reached `active` has already loaded
  /// successfully `requiredConfirms` times — so a later failure of an ACTIVE version is
  /// evidence about this DEVICE (its files changed underneath it), not about the bundle,
  /// and re-staging is the correct heal rather than a permanent block. Same reasoning as
  /// `boot()`'s missing-active-folder branch, which clears `active` without quarantining.
  private static func addRejected(_ s: inout OtaState, name: String, version: String) {
    var list = s.rejected[name] ?? []
    if !list.contains(version) { list.append(version) }
    if list.count > maxRejectedPerBundle { list.removeFirst(list.count - maxRejectedPerBundle) }
    s.rejected[name] = list
  }

  // MARK: - Load failure (sub-game bundles — #553/#550)

  /// Applies what a failed load of `version` proves, and returns the version the caller
  /// should fall back to THIS launch (`.embedded` = nothing loadable, don't offer it).
  ///
  /// This is the sub-game counterpart to the shell's boot watchdog. The shell reverts only
  /// via `boot()`, at cold start, on the NEXT launch — fine for something the OS restarts
  /// anyway, useless for a bundle script-loaded into a live page. #553: without this, a
  /// sub-game had no attempt counter, no revert and no quarantine, and a broken version
  /// that reached `active` was retried on every launch forever (device-verified offline on
  /// a Galaxy S22, 2026-09-01).
  ///
  /// ⚠️ The returned fallback MUST NOT be confirmed by the caller. It is the version being
  /// replaced, and crediting a confirm to it is exactly the defect #553 is about.
  public static func loadFailed(
    state: OtaState?,
    name: String,
    version: String,
    disposition: OtaLoadFailure,
    folderExists: (_ name: String, _ version: String) -> Bool
  ) -> (OtaTarget, OtaState?) {
    guard var s = state else { return (.embedded, nil) }

    if s.pending[name] == version {
      switch disposition {
      case .fatal:
        // #550: route straight to the revert rather than burning the remaining attempts.
        // A bundle whose content is broken cannot become un-broken by being launched two
        // more times, exactly as `boot()`'s missing-folder branch argues for a folder that
        // isn't there. Unlike that branch this one DOES quarantine — see OtaLoadFailure.
        return revert(s, name: name, quarantine: true, folderExists: folderExists)
      case .transient:
        break // the attempt `boot()` counted stands; exhaustion still reverts + quarantines
      case .notEvidence:
        // Give the attempt back. `boot()` counts an attempt when it SERVES a version,
        // before anyone knows why it might fail; a host-compatibility refusal must not
        // walk this bundle toward a quarantine it does not deserve.
        let attempts = (s.bootAttempts[name] ?? 0) - 1
        if attempts > 0 { s.bootAttempts[name] = attempts } else { s.bootAttempts.removeValue(forKey: name) }
      }
    } else if s.active[name] == version, disposition != .notEvidence {
      // A promoted version that no longer loads. Drop it — the sub-game is simply not offered
      // — but do NOT quarantine (see addRejected): it loaded fine `requiredConfirms` times, so
      // the failure is about this device and re-staging is the heal. If the re-staged copy
      // fails again it will be `pending`, and the branch above escalates properly from there.
      //
      // ⚠️ `.transient` MUST escalate here as well, and this is not symmetric with the pending
      // branch. `bootAttempts` is a PENDING-ONLY counter, so "transient still costs an attempt
      // and still quarantines after maxAttempts" — true above — is FALSE for an active version:
      // nothing would count, nothing would revert, and a persistently failing active bundle
      // would be refused on every launch forever with no escalation at all. That is the same
      // never-escalates shape this whole mechanism exists to remove. `.notEvidence` still
      // leaves it alone, correctly: an engineApi mismatch or a gameId collision is a fact about
      // the HOST, and dropping `active` would force a pointless re-download of a good bundle.
      s.active.removeValue(forKey: name)
      return (.embedded, s)
    }

    if let activeVersion = s.active[name], activeVersion != version, folderExists(name, activeVersion) {
      return (.version(name: name, version: activeVersion), s)
    }
    return (.embedded, s)
  }

  // MARK: - Confirm

  /// Called once the app reaches its OWN existing "fully booted" signal (this repo's is
  /// `initialized` in App.tsx — `onSceneReady` plus two rendered frames, i.e. genuine
  /// proof the new JS executed and rendered, not just that `index.html` loaded).
  /// A no-op when nothing is pending — a normal boot on an already-active version must
  /// NEVER clear `active` (an earlier design bug this fixes: an unconditional confirm on
  /// every boot would wipe `active` to nil on a normal launch).
  public static func confirm(fromJSON json: String?, name: String, version: String? = nil) -> String {
    serialize(confirm(state: parseState(json), name: name, version: version) ?? OtaState())
  }

  /// `version`, when supplied, must equal the version currently in `pending[name]` or the
  /// confirm is a no-op.
  ///
  /// ⚠️ This argument is the fix for #553. Promotion used to be decoupled from the version
  /// being promoted: `listBundles()` preferred `active` over `pending`, so a sub-game
  /// loaded the OLD version, succeeded, and confirmed — twice — and the NEW version was
  /// promoted to `active` having never once executed. Naming the version makes the
  /// mechanism self-checking instead of resting on an ordering invariant holding forever.
  ///
  /// Optional because the SHELL's caller (`App.tsx`) has no version to name: its boot hook
  /// is the sole native authority over what got served and already prefers `pending`, so
  /// the invariant holds there by construction. A sub-game always passes it.
  public static func confirm(state: OtaState?, name: String, version: String? = nil) -> OtaState? {
    guard var s = state else { return nil }
    guard let pendingVersion = s.pending[name] else { return s }
    if let version, version != pendingVersion { return s }
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

  // MARK: - Anti-rollback (#571)

  /// Monotonically bumps `state.highestSeenSeq` to `max(existing, seq)` — never regresses,
  /// so this is safe to call with a `seq` that isn't actually an increase (a repeat check
  /// against the same, or an older, release.json). `state == nil` (fresh install / corrupt
  /// state.json) starts a fresh `OtaState()` — there is nothing else to preserve, mirroring
  /// every other mutator here (`activate`, `confirm`, ...).
  public static func recordSeq(_ state: OtaState?, seq: Int) -> OtaState {
    var s = state ?? OtaState()
    s.highestSeenSeq = max(s.highestSeenSeq, seq)
    return s
  }

  // MARK: - Stage verification (#556)

  /// Strict set-equality check between `expected` (the target manifest's path→hash map)
  /// and `actual` (what the plugin actually hashed off the staged tmp dir). Hash
  /// comparison is case-insensitive hex; when several problems exist, the ONE reported is
  /// deterministic — paths are sorted lexicographically and the first problem in that
  /// order wins, checking missing/unexpected/mismatch per path in the same pass. Both
  /// this port and the Java twin must pick the same one, or a fixed input could report a
  /// different failure per platform. See ota-stage-verify-vectors.json.
  public static func verifyStagedFiles(expected: [String: String], actual: [String: String]) -> OtaStageVerifyResult {
    let expectedLower = Dictionary(uniqueKeysWithValues: expected.map { ($0.key, $0.value.lowercased()) })
    let actualLower = Dictionary(uniqueKeysWithValues: actual.map { ($0.key, $0.value.lowercased()) })
    let allPaths = Set(expectedLower.keys).union(actualLower.keys).sorted()
    for path in allPaths {
      guard let expectedHash = expectedLower[path] else { return .unexpected(path: path) }
      guard let actualHash = actualLower[path] else { return .missing(path: path) }
      if expectedHash != actualHash { return .hashMismatch(path: path, expected: expectedHash, actual: actualHash) }
    }
    return .ok
  }

  // MARK: - Prune (#563)

  /// Returns the FULL on-disk folder names (drawn from `onDisk`, which lists every version
  /// folder actually present — for EVERY bundle, not just `name`) that are safe to delete
  /// for `name`.
  ///
  /// Folders are flat and named `"<bundleName>-<version>"` (`OtaPaths.versionFolderName` /
  /// the Java twin), and bundle names may themselves contain hyphens — so a folder's owning
  /// bundle CANNOT be recovered by splitting on the first `name + "-"` the I/O layer
  /// happens to be pruning. `ota` pruning against a disk that also holds `ota-test-v1` must
  /// never mistake that folder for its own `test-v1`. This decision — which bundle a folder
  /// belongs to — is made ONCE, here, in the pure function the shared vectors pin, rather
  /// than re-derived (and able to drift) in each I/O half.
  ///
  /// Algorithm: `knownBundles` is every bundle name the state mentions (the keys of
  /// `active`/`pending`/`bootAttempts`/`confirmedBoots`/`rejected`) plus `name` itself —
  /// this covers a folder for a bundle this device once knew about even if `name` isn't in
  /// that particular map. For each on-disk folder, every known bundle whose `"<bundle>-"`
  /// is a prefix of the folder name is a candidate owner; the LONGEST candidate wins (so
  /// `ota-test-v1` resolves to `ota-test`, not `ota`, whenever both are known bundles). A
  /// folder with NO candidate owner belongs to a bundle this device knows nothing about and
  /// is left alone. A folder whose owner isn't `name` is left alone too — it belongs to
  /// another bundle's prune pass. Only once a folder is confirmed to belong to `name` is its
  /// version (the remainder after the owner prefix) compared against `active[name]` /
  /// `pending[name]`.
  ///
  /// `revert()` above only ever falls back to `active[name]`, and to `.embedded` only when
  /// that folder is gone — it never reaches further back than that. So a version sitting
  /// in `rejected`, or any other stale copy, is not reachable by any boot path anymore and
  /// its folder is pure waste. `boot()` also already self-heals a missing active folder
  /// (clears `active`, falls back to embedded, no quarantine), so even a wrong prune here
  /// degrades gracefully rather than bricking anything.
  ///
  /// `state == nil` (unparseable/missing state.json) means every folder's status is
  /// UNKNOWN, not "prunable" — pruning then would be destructive, so this returns empty.
  ///
  /// Sorted so both this port and the Java twin (`OtaCore.pruneVersions`) agree on order
  /// and the shared vectors can assert exactly. See
  /// ../../../test-vectors/ota-prune-vectors.json.
  public static func pruneVersions(state: OtaState?, name: String, onDisk: [String]) -> [String] {
    guard let state else { return [] }

    var knownBundles = Set<String>()
    knownBundles.formUnion(state.active.keys)
    knownBundles.formUnion(state.pending.keys)
    knownBundles.formUnion(state.bootAttempts.keys)
    knownBundles.formUnion(state.confirmedBoots.keys)
    knownBundles.formUnion(state.rejected.keys)
    knownBundles.insert(name)

    let active = state.active[name]
    let pending = state.pending[name]

    var toPrune: [String] = []
    for folder in onDisk {
      let candidates = knownBundles.filter { folder.hasPrefix($0 + "-") }
      guard let owner = candidates.max(by: { $0.count < $1.count }), owner == name else { continue }
      let version = String(folder.dropFirst(owner.count + 1))
      if version != active && version != pending {
        toPrune.append(folder)
      }
    }
    return toPrune.sorted()
  }

  // MARK: - Bundles to prune (#563, pinned separately from pruneVersions itself)

  /// Every bundle name a boot hook must run `pruneVersions` for after a boot — the SORTED
  /// union of the keys of `state.active`/`pending`/`bootAttempts`/`confirmedBoots`/
  /// `rejected`, plus `shellName` itself (always included, even when it appears in none of
  /// those maps — a fresh device that has never staged anything but the embedded shell
  /// still needs its own prune pass so a stale on-disk folder for it is reclaimable).
  /// `state == nil` (fresh install / corrupt state.json) means nothing is known yet —
  /// returns just `[shellName]`.
  ///
  /// Pulled out of the boot-hook glue (`OtaBootHook.run` here / Android's `runBootHook`)
  /// into this pure function so it is replayed by the shared vectors
  /// (ota-bundles-to-prune-vectors.json) instead of living untested in native glue.
  public static func bundlesToPrune(state: OtaState?, shellName: String) -> [String] {
    guard let state else { return [shellName] }
    var names = Set<String>()
    names.formUnion(state.active.keys)
    names.formUnion(state.pending.keys)
    names.formUnion(state.bootAttempts.keys)
    names.formUnion(state.confirmedBoots.keys)
    names.formUnion(state.rejected.keys)
    names.insert(shellName)
    return names.sorted()
  }
}
