import XCTest
import AppTrackingTransparency
@testable import AppsFlyerAttCore

/// Drives the SHIPPING `AttRequestGate` (#1510, #1532). The plugin's own part, reading
/// `UIApplication.applicationState` and forwarding `didBecomeActiveNotification`, needs UIKit and is
/// covered by the device check recorded in `games/court/attribution.md`, not here.
final class AttRequestGateTests: XCTestCase {
    /// Apple's `ATTrackingManager.AuthorizationStatus` raw values.
    private let notDetermined: UInt = 0
    private let restricted: UInt = 1
    private let denied: UInt = 2
    private let authorized: UInt = 3

    /// An inactive app must not be asked, because iOS would answer `notDetermined` without a prompt.
    func testInactiveRequestWaitsForActivation() {
        let gate = AttRequestGate()
        var asked = 0
        XCTAssertEqual(gate.submit(isActive: false, attStatusRaw: notDetermined) { asked += 1 }, .held)
        XCTAssertEqual(asked, 0, "asked while inactive — iOS returns notDetermined and shows nothing")
        gate.appDidBecomeActive()
        XCTAssertEqual(asked, 1)
    }

    /// The prompt is once-ever, so a second activation must not ask again.
    func testActivationRunsAHeldRequestExactlyOnce() {
        let gate = AttRequestGate()
        var asked = 0
        XCTAssertEqual(gate.submit(isActive: false, attStatusRaw: notDetermined) { asked += 1 }, .held)
        XCTAssertEqual(asked, 0)
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
        XCTAssertEqual(gate.submit(isActive: true, attStatusRaw: notDetermined) { asked += 1 }, .ran)
        XCTAssertEqual(asked, 1)
        XCTAssertEqual(gate.pendingCount, 0)
    }

    /// An activation BEFORE the request arms nothing: the request still reads the state it is given.
    func testEarlierActivationDoesNotPreArm() {
        let gate = AttRequestGate()
        gate.appDidBecomeActive()
        var asked = 0
        gate.submit(isActive: false, attStatusRaw: notDetermined) { asked += 1 }
        XCTAssertEqual(asked, 0)
        gate.appDidBecomeActive()
        XCTAssertEqual(asked, 1)
    }

    /// #1532: once the player has answered there is no prompt to protect, so an inactive app is asked
    /// at once, for every answered status. iOS returns the stored status without drawing anything.
    func testAnsweredRequestRunsAtOnceWhileInactive() {
        for status in [restricted, denied, authorized] {
            let gate = AttRequestGate()
            var asked = 0
            XCTAssertEqual(gate.submit(isActive: false, attStatusRaw: status) { asked += 1 }, .ranAnswered,
                           "status \(status) was held — nothing will draw, so nothing needs waiting for")
            XCTAssertEqual(asked, 1)
            XCTAssertEqual(gate.pendingCount, 0)
        }
    }

    /// #1532's inferred shape: a WebView reload inside a live process asks AFTER the process's activation
    /// has been delivered, while reading a non-active state (the stall was observed; this cause is inferred). With the status answered it must not wait for
    /// an activation that may not come while the player stays in the app.
    func testAnsweredRequestAfterDeliveredActivationDoesNotStrand() {
        let gate = AttRequestGate()
        gate.appDidBecomeActive()
        var asked = 0
        gate.submit(isActive: false, attStatusRaw: authorized) { asked += 1 }
        XCTAssertEqual(asked, 1, "stranded: the realm's answer waits for an activation that already happened")
    }

    /// The mapping itself: only `notDetermined` can prompt. A flipped comparison or a hard-coded answer
    /// in the mapping goes red here rather than on a device.
    func testOnlyNotDeterminedNeedsAPrompt() {
        XCTAssertEqual(AttRequestGate.notDeterminedRawValue, notDetermined)
        XCTAssertTrue(AttRequestGate.needsPrompt(attStatusRaw: notDetermined))
        for status in [restricted, denied, authorized, 99] {
            XCTAssertFalse(AttRequestGate.needsPrompt(attStatusRaw: status), "status \(status) cannot prompt")
        }
    }
    /// The raw values this suite (and the gate's `notDeterminedRawValue`) assume ARE Apple's: the ATT
    /// framework exists on the macOS test host (11+), so the enum itself is the reference, not a
    /// hand-typed copy.
    func testRawValuesMatchApplesEnum() throws {
        guard #available(macOS 11, *) else { throw XCTSkip("AppTrackingTransparency needs macOS 11") }
        XCTAssertEqual(AttRequestGate.notDeterminedRawValue, ATTrackingManager.AuthorizationStatus.notDetermined.rawValue)
        XCTAssertEqual(restricted, ATTrackingManager.AuthorizationStatus.restricted.rawValue)
        XCTAssertEqual(denied, ATTrackingManager.AuthorizationStatus.denied.rawValue)
        XCTAssertEqual(authorized, ATTrackingManager.AuthorizationStatus.authorized.rawValue)
    }
}
