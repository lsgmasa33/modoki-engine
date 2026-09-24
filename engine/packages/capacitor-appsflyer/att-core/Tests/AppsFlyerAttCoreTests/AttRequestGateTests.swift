import XCTest
@testable import AppsFlyerAttCore

/// Drives the SHIPPING `AttRequestGate` (#1510). The plugin's own part, reading
/// `UIApplication.applicationState` and forwarding `didBecomeActiveNotification`, needs UIKit and is
/// covered by the device check recorded in `games/court/attribution.md`, not here.
final class AttRequestGateTests: XCTestCase {

    /// An inactive app must not be asked, because iOS would answer `notDetermined` without a prompt.
    func testInactiveRequestWaitsForActivation() {
        let gate = AttRequestGate()
        var asked = 0
        XCTAssertTrue(gate.submit(isActive: false) { asked += 1 })
        XCTAssertEqual(asked, 0, "asked while inactive — iOS returns notDetermined and shows nothing")
        gate.appDidBecomeActive()
        XCTAssertEqual(asked, 1)
    }

    /// The prompt is once-ever, so a second activation must not ask again.
    func testActivationRunsAHeldRequestExactlyOnce() {
        let gate = AttRequestGate()
        var asked = 0
        gate.submit(isActive: false) { asked += 1 }
        gate.appDidBecomeActive()
        gate.appDidBecomeActive()
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(gate.pendingCount, 0)
    }

    /// The common case: a launch that is already active must not wait for an activation that
    /// already happened and will not come again.
    func testActiveRequestRunsAtOnce() {
        let gate = AttRequestGate()
        var asked = 0
        XCTAssertFalse(gate.submit(isActive: true) { asked += 1 })
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(gate.pendingCount, 0)
    }

    /// An activation BEFORE the request arms nothing: the request still reads the state it is given.
    func testEarlierActivationDoesNotPreArm() {
        let gate = AttRequestGate()
        gate.appDidBecomeActive()
        var asked = 0
        gate.submit(isActive: false) { asked += 1 }
        XCTAssertEqual(asked, 0)
        gate.appDidBecomeActive()
        XCTAssertEqual(asked, 1)
    }
}
