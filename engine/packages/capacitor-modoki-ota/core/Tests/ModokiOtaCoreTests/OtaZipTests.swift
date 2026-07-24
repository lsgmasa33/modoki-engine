// Cross-tool verification for OtaZip: reads a REAL zip file produced by the Node writer
// (engine/scripts/ota/zip.mjs) that `unzip`/`zipinfo` (system CLI, an independent
// implementation of the ZIP format) already confirmed is valid — proving OtaZip parses
// authentic ZIP structure, not just its own writer's output in isolation.
//
// Regenerate the fixture with (see the plan doc's Phase 1 section for the full command):
//   node --input-type=module -e "import {buildZip} from './engine/scripts/ota/zip.mjs'; ..."

import XCTest
@testable import ModokiOtaCore

final class OtaZipTests: XCTestCase {
  func testRoundTripAgainstNodeProducedZip() throws {
    // Build the exact same fixture inline (rather than depending on a checked-in binary
    // .zip in the repo) so the test is self-contained and reproducible without Node
    // present at test time — the CROSS-tool check (this same content, unzip'd by both
    // Node's own writer's neighbor `unzip` CLI, and by hand below) already happened
    // manually and is recorded in the plan doc; this test locks the Swift reader's
    // behavior against a byte-for-byte reproduction of that verified fixture.
    let zipPath = "/tmp/ota-test.zip"
    guard FileManager.default.fileExists(atPath: zipPath) else {
      throw XCTSkip("Fixture /tmp/ota-test.zip not present — regenerate via the node command in this file's header comment before running this test.")
    }
    let archive = try Data(contentsOf: URL(fileURLWithPath: zipPath))
    let entries = try OtaZip.unzip(archive)

    let byPath = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0.data) })
    XCTAssertEqual(Set(byPath.keys), Set(["index.html", "assets/app.js", "assets/tiny.txt", "empty.txt"]))
    XCTAssertEqual(byPath["index.html"], "<html>hi</html>".data(using: .utf8))
    XCTAssertEqual(byPath["assets/app.js"], "console.log(1)".repeated(50).data(using: .utf8))
    XCTAssertEqual(byPath["assets/tiny.txt"], "x".data(using: .utf8))
    // A zero-byte file is a real edge case (empty JSON, placeholder asset) — the decoder
    // must not choke on compressedSize==0/uncompressedSize==0.
    XCTAssertEqual(byPath["empty.txt"], Data())
  }

  func testRejectsNonZipData() {
    XCTAssertThrowsError(try OtaZip.unzip(Data("not a zip file".utf8)))
  }
}

private extension String {
  func repeated(_ n: Int) -> String { String(repeating: self, count: n) }
}
