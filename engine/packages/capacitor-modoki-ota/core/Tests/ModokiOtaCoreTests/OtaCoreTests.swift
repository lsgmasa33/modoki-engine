// Golden-vector parity test for the OTA boot-watchdog state machine.
// Replays test-vectors/ota-golden-vectors.json — the same file the Java port
// (OtaCoreSelfTest.java) replays — so a native divergence between the two platforms
// fails here instead of shipping silently. Runs via `swift test` on plain macOS: no
// Xcode project, no device, no iOS SDK (see Package.swift's ModokiOtaCore target).

import XCTest
@testable import ModokiOtaCore

final class OtaCoreTests: XCTestCase {
  struct Scenario {
    let name: String
    let op: String
    let bundle: String
    let stateJSON: String? // nil = literal JSON null in the vector file; "CORRUPT_JSON_MARKER" mapped to garbage
    let folderExists: [String: Bool]
    let expectTargetKind: String?
    let expectTargetName: String?
    let expectTargetVersion: String?
    let expectStateJSON: [String: Any]? // nil = expect nil state
    let expectStateIsNull: Bool
  }

  /// Both vector files are replayed by the SAME assertions: the Phase 1 golden vectors and
  /// the Phase 3a gate/quarantine vectors. Java (OtaCoreSelfTest) replays the same two.
  static let vectorFiles = [
    "test-vectors/ota-golden-vectors.json",
    "test-vectors/ota-gate-vectors-phase3.json",
    "test-vectors/ota-subgame-vectors-553.json",
  ]

  /// The vector files declare `constants` — and until this was added, NOTHING read them, so the
  /// fixture could say maxAttempts:4 while both implementations used 3 and all 27 scenarios still
  /// passed (measured, 2026-08-27). A contract nothing enforces is a comment with a schema.
  func testFixtureConstantsMatchImplementation() {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    var checked = 0
    for file in Self.vectorFiles {
      let data = try! Data(contentsOf: packageRoot.appendingPathComponent(file))
      let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      guard let constants = obj["constants"] as? [String: Any] else { continue }
      if let v = constants["maxAttempts"] as? Int {
        XCTAssertEqual(v, OtaCore.maxAttempts, "\(file): maxAttempts"); checked += 1
      }
      if let v = constants["requiredConfirms"] as? Int {
        XCTAssertEqual(v, OtaCore.requiredConfirms, "\(file): requiredConfirms"); checked += 1
      }
    }
    XCTAssertGreaterThan(checked, 0, "no `constants` found in any vector file — this test checked nothing")
  }

  func loadVectors() -> [[String: Any]] {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // OtaCoreTests.swift -> ModokiOtaCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> core/
      .deletingLastPathComponent() // -> package root
    var scenarios: [[String: Any]] = []
    for file in Self.vectorFiles {
      let data = try! Data(contentsOf: packageRoot.appendingPathComponent(file))
      let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      scenarios += obj["scenarios"] as! [[String: Any]]
    }
    return scenarios
  }

  /// An emptied or truncated vector file would replay zero scenarios and pass. Asserted PER FILE:
  /// there are two, and emptying one left the combined count positive — so a whole-corpus count
  /// is a check that cannot see the case it was written for. The Java twin does the same.
  func testEveryFixtureHasScenarios() {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    for file in Self.vectorFiles {
      let data = try! Data(contentsOf: packageRoot.appendingPathComponent(file))
      let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
      let scenarios = obj["scenarios"] as? [[String: Any]] ?? []
      XCTAssertGreaterThan(scenarios.count, 0, "\(file): no scenarios — the replay would check nothing")
    }
  }

  func stringMap(_ obj: [String: Any], _ key: String) -> [String: String] {
    (obj[key] as? [String: String]) ?? [:]
  }

  func intMap(_ obj: [String: Any], _ key: String) -> [String: Int] {
    guard let raw = obj[key] as? [String: Any] else { return [:] }
    var out: [String: Int] = [:]
    for (k, v) in raw { out[k] = v as? Int }
    return out
  }

  func stringListMap(_ obj: [String: Any], _ key: String) -> [String: [String]] {
    (obj[key] as? [String: [String]]) ?? [:]
  }

  func stateFromVectorJSON(_ obj: [String: Any]) -> OtaState {
    OtaState(
      active: stringMap(obj, "active"),
      pending: stringMap(obj, "pending"),
      bootAttempts: intMap(obj, "bootAttempts"),
      confirmedBoots: intMap(obj, "confirmedBoots"),
      rejected: stringListMap(obj, "rejected"),
      lastSeenBinaryVersion: obj["lastSeenBinaryVersion"] as? String
    )
  }

  func assertStateMatches(_ actual: OtaState?, _ expected: [String: Any]?, _ scenarioName: String) {
    if expected == nil {
      XCTAssertNil(actual, "\(scenarioName): expected nil state")
      return
    }
    guard let actual else {
      XCTFail("\(scenarioName): expected non-nil state, got nil")
      return
    }
    let expectedState = stateFromVectorJSON(expected!)
    XCTAssertEqual(actual, expectedState, "\(scenarioName): state mismatch")
  }

  func testGoldenVectors() {
    for raw in loadVectors() {
      let name = raw["name"] as! String
      let op = raw["op"] as! String
      let bundle = raw["bundle"] as! String
      let expect = raw["expect"] as! [String: Any]

      // "state" is either: JSON null (absent key value NSNull), a real object, or the
      // literal string "CORRUPT_JSON_MARKER" (meaning: feed genuinely unparseable text).
      let stateRaw = raw["state"]
      let stateJSONString: String?
      if stateRaw == nil || stateRaw is NSNull {
        stateJSONString = nil
      } else if let marker = stateRaw as? String, marker == "CORRUPT_JSON_MARKER" {
        stateJSONString = "{ this is not valid JSON"
      } else {
        let data = try! JSONSerialization.data(withJSONObject: stateRaw as Any)
        stateJSONString = String(data: data, encoding: .utf8)
      }

      let folderExistsMap = (raw["folderExists"] as? [String: Bool]) ?? [:]
      let folderExists: (String, String) -> Bool = { n, v in folderExistsMap["\(n)/\(v)"] ?? false }

      switch op {
      case "boot":
        let (target, resultState) = OtaCore.boot(fromJSON: stateJSONString, name: bundle, folderExists: folderExists)
        let expectTarget = expect["target"] as! [String: Any]
        let kind = expectTarget["kind"] as! String
        switch kind {
        case "embedded":
          XCTAssertEqual(target, .embedded, "\(name): expected embedded target")
        case "version":
          XCTAssertEqual(
            target,
            .version(name: expectTarget["name"] as! String, version: expectTarget["version"] as! String),
            "\(name): target mismatch"
          )
        default:
          XCTFail("\(name): unknown expect.target.kind \(kind)")
        }
        assertStateMatches(resultState, expect["state"] as? [String: Any], name)

      case "confirm":
        let state = OtaCore.parseState(stateJSONString)
        // `version` is absent in every Phase 1 vector (the shell's unversioned confirm) and
        // present in the #553 ones — the SAME call must serve both, so the back-compat path
        // is exercised by the existing corpus rather than asserted separately.
        let resultState = OtaCore.confirm(state: state, name: bundle, version: raw["version"] as? String)
        assertStateMatches(resultState, expect["state"] as? [String: Any], name)

      case "loadFailed":
        let state = OtaCore.parseState(stateJSONString)
        let dispositionRaw = raw["disposition"] as! String
        guard let disposition = OtaLoadFailure(rawValue: dispositionRaw) else {
          XCTFail("\(name): unknown disposition \(dispositionRaw)"); continue
        }
        let (target, resultState) = OtaCore.loadFailed(
          state: state, name: bundle, version: raw["version"] as! String,
          disposition: disposition, folderExists: folderExists
        )
        let expectTarget = expect["target"] as! [String: Any]
        switch expectTarget["kind"] as! String {
        case "embedded":
          XCTAssertEqual(target, .embedded, "\(name): expected embedded target")
        case "version":
          XCTAssertEqual(
            target,
            .version(name: expectTarget["name"] as! String, version: expectTarget["version"] as! String),
            "\(name): target mismatch"
          )
        default:
          XCTFail("\(name): unknown expect.target.kind")
        }
        assertStateMatches(resultState, expect["state"] as? [String: Any], name)

      case "resetForNewBinary":
        let state = OtaCore.parseState(stateJSONString)
        let currentBinaryVersion = raw["currentBinaryVersion"] as! String
        let resultState = OtaCore.resetForNewBinary(state, currentBinaryVersion: currentBinaryVersion)
        assertStateMatches(resultState, expect["state"] as? [String: Any], name)

      default:
        XCTFail("\(name): unknown op \(op)")
      }
    }
  }

  // MARK: - Stage verification (#556)

  /// Its OWN loader, deliberately separate from `loadVectors()` — the file it reads has a
  /// different shape (`expected`/`actual`/`expect`, no `op`/`bundle`/`state`, no
  /// `constants` block) and is NOT part of `vectorFiles`; see that file's header comment.
  func loadStageVerifyVectors() -> [[String: Any]] {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // OtaCoreTests.swift -> ModokiOtaCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> core/
      .deletingLastPathComponent() // -> package root
    let data = try! Data(contentsOf: packageRoot.appendingPathComponent("test-vectors/ota-stage-verify-vectors.json"))
    let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return obj["scenarios"] as! [[String: Any]]
  }

  func testStageVerifyVectors() {
    let scenarios = loadStageVerifyVectors()
    XCTAssertGreaterThan(scenarios.count, 0, "ota-stage-verify-vectors.json: no scenarios — this test would check nothing")
    for raw in scenarios {
      let name = raw["name"] as! String
      let expected = stringMap(raw, "expected")
      let actual = stringMap(raw, "actual")
      let expect = raw["expect"] as! [String: Any]
      let result = OtaCore.verifyStagedFiles(expected: expected, actual: actual)
      switch expect["kind"] as! String {
      case "ok":
        XCTAssertEqual(result, .ok, "\(name)")
      case "missing":
        XCTAssertEqual(result, .missing(path: expect["path"] as! String), "\(name)")
      case "unexpected":
        XCTAssertEqual(result, .unexpected(path: expect["path"] as! String), "\(name)")
      case "hashMismatch":
        XCTAssertEqual(
          result,
          .hashMismatch(path: expect["path"] as! String, expected: expect["expectedHash"] as! String, actual: expect["actualHash"] as! String),
          "\(name)"
        )
      default:
        XCTFail("\(name): unknown expect.kind \(expect["kind"] ?? "nil")")
      }
    }
  }

  // MARK: - Prune (#563)

  /// Its OWN loader, deliberately separate from `loadVectors()` — the file it reads has a
  /// different shape (`state`/`bundle`/`onDisk`/`expect.prune`, no `op`, no `constants`
  /// block) and is NOT part of `vectorFiles`; see that file's header comment.
  func loadPruneVectors() -> [[String: Any]] {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // OtaCoreTests.swift -> ModokiOtaCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> core/
      .deletingLastPathComponent() // -> package root
    let data = try! Data(contentsOf: packageRoot.appendingPathComponent("test-vectors/ota-prune-vectors.json"))
    let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return obj["scenarios"] as! [[String: Any]]
  }

  func testPruneVectors() {
    let scenarios = loadPruneVectors()
    XCTAssertGreaterThan(scenarios.count, 0, "ota-prune-vectors.json: no scenarios — this test would check nothing")
    for raw in scenarios {
      let name = raw["name"] as! String
      let bundle = raw["bundle"] as! String
      let onDisk = raw["onDisk"] as! [String]
      let expect = raw["expect"] as! [String: Any]
      let expectedPrune = expect["prune"] as! [String]

      let stateRaw = raw["state"]
      let state: OtaState?
      if stateRaw == nil || stateRaw is NSNull {
        state = nil
      } else {
        state = stateFromVectorJSON(stateRaw as! [String: Any])
      }

      let result = OtaCore.pruneVersions(state: state, name: bundle, onDisk: onDisk)
      XCTAssertEqual(result, expectedPrune, "\(name): prune mismatch")
    }
  }

  // MARK: - Bundles to prune (F2)

  /// Its OWN loader, deliberately separate from `loadVectors()` — the file it reads has a
  /// different shape (`state`/`shellName`/`expect.bundlesToPrune`, no `op`, no `constants`
  /// block) and is NOT part of `vectorFiles`; see that file's header comment.
  func loadBundlesToPruneVectors() -> [[String: Any]] {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // OtaCoreTests.swift -> ModokiOtaCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> core/
      .deletingLastPathComponent() // -> package root
    let data = try! Data(contentsOf: packageRoot.appendingPathComponent("test-vectors/ota-bundles-to-prune-vectors.json"))
    let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return obj["scenarios"] as! [[String: Any]]
  }

  func testBundlesToPruneVectors() {
    let scenarios = loadBundlesToPruneVectors()
    XCTAssertGreaterThan(scenarios.count, 0, "ota-bundles-to-prune-vectors.json: no scenarios — this test would check nothing")
    for raw in scenarios {
      let name = raw["name"] as! String
      let shellName = raw["shellName"] as! String
      let expect = raw["expect"] as! [String: Any]
      let expected = expect["bundlesToPrune"] as! [String]

      let stateRaw = raw["state"]
      let state: OtaState?
      if stateRaw == nil || stateRaw is NSNull {
        state = nil
      } else {
        state = stateFromVectorJSON(stateRaw as! [String: Any])
      }

      let result = OtaCore.bundlesToPrune(state: state, shellName: shellName)
      XCTAssertEqual(result, expected, "\(name): bundlesToPrune mismatch")
    }
  }
}
