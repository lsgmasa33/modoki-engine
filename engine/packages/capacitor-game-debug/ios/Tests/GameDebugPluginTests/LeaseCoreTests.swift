// Golden-vector parity test for the iOS lease port (code-review T5).
//
// Replays test-vectors/lease-golden-vectors.json against a pure LeaseCore and asserts every reply
// matches the shared contract that the TS DeviceLeaseAuthority is also pinned to
// (engine/tests/plugins/deviceLeaseGoldenVectors.test.ts). A native divergence from the spec fails
// here instead of silently shipping.
//
// HOW IT RUNS: `npm run test:native` (engine/scripts/test-native.mjs), an ON-DEMAND gate — `npm run
// verify` is vitest and cannot run XCTest. The runner is `swift test --package-path ios/Tests`,
// driven by the standalone ios/Tests/Package.swift; the plugin's own Package.swift deliberately
// declares no testTarget (the reasons are in that file). #376 wired this; before then the file had
// never executed once — and the fixture path below was off by one directory, which is exactly what
// an unrunnable test cannot tell you.
//
// SCOPE — read this before trusting a green run. `LeaseCore` below is a PORT of the spec, not the
// shipping arbiter: GameDebugPlugin.evaluateLease/startLeaseGrace still hold their own lease state
// with a DispatchWorkItem grace timer. So this proves the spec is portable to Swift and pins the
// contract; it does NOT prove the shipping plugin obeys it. Making it do so is the extraction this
// comment has always recommended — evaluateLease/startLeaseGrace delegating to a pure,
// clock-injected, timer-free LeaseCore mirroring the TS spec's lazy expiry — and that is a
// behavioural native change needing device verification, deliberately left out of #376.

import XCTest

/// Pure, clock-injected lease arbiter — a faithful port of DeviceLeaseAuthority (deviceLease.ts).
/// No timers: grace is a deadline compared lazily on the next message (matches the TS spec).
struct LeaseCore {
    struct Reply: Equatable { let ok: Bool; let reason: String?; let resumed: Bool? }

    let graceMs: Int
    private var leaseGuid: String?
    private var live = false
    private var graceUntil: Int?

    init(graceMs: Int) { self.graceMs = graceMs }

    private mutating func expireIfDue(_ now: Int) {
        if leaseGuid != nil, !live, let gu = graceUntil, now >= gu { leaseGuid = nil; graceUntil = nil }
    }

    mutating func connect(_ guid: String, _ now: Int) -> Reply {
        expireIfDue(now)
        if leaseGuid == nil { leaseGuid = guid; live = true; graceUntil = nil; return Reply(ok: true, reason: nil, resumed: nil) }
        if leaseGuid == guid { let resumed = !live; live = true; graceUntil = nil; return Reply(ok: true, reason: nil, resumed: resumed) }
        return Reply(ok: false, reason: "busy", resumed: nil)
    }

    mutating func ping(_ guid: String, _ now: Int) -> Reply {
        expireIfDue(now)
        if leaseGuid == nil { return Reply(ok: false, reason: "no-lease", resumed: nil) }
        if leaseGuid != guid { return Reply(ok: false, reason: "not-owner", resumed: nil) }
        live = true; graceUntil = nil; return Reply(ok: true, reason: nil, resumed: nil)
    }

    mutating func disconnect(_ guid: String, _ now: Int) -> Reply {
        expireIfDue(now)
        if leaseGuid != guid { return Reply(ok: false, reason: leaseGuid == nil ? "no-lease" : "not-owner", resumed: nil) }
        leaseGuid = nil; live = false; graceUntil = nil; return Reply(ok: true, reason: nil, resumed: nil)
    }

    mutating func socketDropped(_ now: Int) {
        expireIfDue(now)
        if leaseGuid != nil, live { live = false; graceUntil = now + graceMs }
    }

    mutating func status(_ now: Int) -> (leased: Bool, live: Bool) {
        expireIfDue(now); return (leaseGuid != nil, live)
    }
}

final class LeaseCoreTests: XCTestCase {
    private struct Step: Decodable {
        let op: String
        let guid: String?
        let now: Int
        let expect: Expect?
    }
    private struct Expect: Decodable {
        let ok: Bool?; let reason: String?; let resumed: Bool?; let leased: Bool?; let live: Bool?
    }
    private struct Fixture: Decodable { let graceMs: Int; let steps: [Step] }

    func testGoldenVectors() throws {
        let url = try Self.goldenVectorsURL()
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))

        // The TS twin (deviceLeaseGoldenVectors.test.ts) asserts these; these two did not, so an
        // emptied or truncated fixture replayed zero steps and reported PASS — measured. The gate
        // these live in is the ONLY one that runs them, so a fixture nobody validates is the whole
        // check.
        XCTAssertGreaterThan(fixture.graceMs, 0, "fixture graceMs must be positive")
        XCTAssertGreaterThan(fixture.steps.count, 0, "fixture has no steps — this test would check nothing")

        var core = LeaseCore(graceMs: fixture.graceMs)
        for (i, s) in fixture.steps.enumerated() {
            let where_ = "step \(i) (\(s.op) \(s.guid ?? "") @\(s.now))"
            switch s.op {
            case "connect":
                XCTAssertEqual(core.connect(s.guid!, s.now), expectedReply(s.expect!), where_)
            case "ping":
                XCTAssertEqual(core.ping(s.guid!, s.now), expectedReply(s.expect!), where_)
            case "disconnect":
                XCTAssertEqual(core.disconnect(s.guid!, s.now), expectedReply(s.expect!), where_)
            case "socketDropped":
                core.socketDropped(s.now)
            case "status":
                let st = core.status(s.now)
                XCTAssertEqual(st.leased, s.expect!.leased, where_)
                XCTAssertEqual(st.live, s.expect!.live, where_)
            default:
                XCTFail("unknown op \(s.op)")
            }
        }
    }

    /// Locate test-vectors/lease-golden-vectors.json by walking UP from this source file.
    /// Not a fixed number of `deletingLastPathComponent()` calls: that is what silently broke here
    /// (it stripped three components and landed in ios/), and an unrunnable test cannot report it.
    private static func goldenVectorsURL() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("test-vectors/lease-golden-vectors.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        throw NSError(domain: "LeaseCoreTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "test-vectors/lease-golden-vectors.json not found above \(#filePath)",
        ])
    }

    private func expectedReply(_ e: Expect) -> LeaseCore.Reply {
        LeaseCore.Reply(ok: e.ok ?? false, reason: e.reason, resumed: e.resumed)
    }
}
