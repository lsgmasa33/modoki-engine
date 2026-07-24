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

  func loadVectors() -> [[String: Any]] {
    let thisFile = URL(fileURLWithPath: #filePath)
    let vectorsPath = thisFile
      .deletingLastPathComponent() // OtaCoreTests.swift -> ModokiOtaCoreTests/
      .deletingLastPathComponent() // -> Tests/
      .deletingLastPathComponent() // -> ios/
      .deletingLastPathComponent() // -> package root
      .appendingPathComponent("test-vectors/ota-golden-vectors.json")
    let data = try! Data(contentsOf: vectorsPath)
    let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return obj["scenarios"] as! [[String: Any]]
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

  func stateFromVectorJSON(_ obj: [String: Any]) -> OtaState {
    OtaState(
      active: stringMap(obj, "active"),
      pending: stringMap(obj, "pending"),
      bootAttempts: intMap(obj, "bootAttempts"),
      confirmedBoots: intMap(obj, "confirmedBoots")
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
        let resultState = OtaCore.confirm(state: state, name: bundle)
        assertStateMatches(resultState, expect["state"] as? [String: Any], name)

      default:
        XCTFail("\(name): unknown op \(op)")
      }
    }
  }
}
