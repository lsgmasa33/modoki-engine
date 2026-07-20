// Golden-vector parity test for the iOS lease port (code-review T5).
//
// Replays test-vectors/lease-golden-vectors.json against a pure LeaseCore and asserts every reply
// matches the shared contract that the TS DeviceLeaseAuthority is also pinned to
// (engine/tests/plugins/deviceLeaseGoldenVectors.test.ts). A native divergence from the spec fails
// here instead of silently shipping.
//
// STATUS: this test needs a Swift-package/XCTest target wired for capacitor-game-debug to run (the
// plugin package ships without one today). `LeaseCore` below is the RECOMMENDED extraction target —
// GameDebugPlugin.evaluateLease/startLeaseGrace should delegate to it (a pure, clock-injected,
// timer-free arbiter that mirrors the TS spec's lazy expiry), so this test covers the shipping code
// rather than a copy. Until then it documents + checks the parity contract for the port.

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
        // …/ios/Tests/GameDebugPluginTests/LeaseCoreTests.swift → …/test-vectors/lease-golden-vectors.json
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test-vectors/lease-golden-vectors.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))

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

    private func expectedReply(_ e: Expect) -> LeaseCore.Reply {
        LeaseCore.Reply(ok: e.ok ?? false, reason: e.reason, resumed: e.resumed)
    }
}
