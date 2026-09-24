/// Holds the ATT request until the app is ACTIVE (#1510).
///
/// `ATTrackingManager.requestTrackingAuthorization` shows the system prompt ONLY while the app is
/// `UIApplication.State.active`. Asked at any other moment, it returns `.notDetermined` at once and
/// draws nothing, and the caller cannot tell that apart from a real answer. Observed on an iPhone 8
/// (iOS 16.7.16), 2026-09-24: Court launched under `idevicedebug` got `notDetermined` back with no
/// prompt on screen, then started AppsFlyer and MAX unanswered. The prompt surfaced a minute later.
///
/// So the plugin submits the request here with the app state it read, and forwards every
/// `didBecomeActive` notification to `appDidBecomeActive()`. A request made while active runs at once.
/// One made while inactive waits for the next activation, however long that takes. That wait is
/// UNBOUNDED on purpose. It follows the owner's 2026-08-20 ruling on the ATT wait
/// (`games/court/attribution.md`, "waiting is free; timing out is not"): an app that is not active
/// has no player in it to lose events from.
///
/// No UIKit here: the state arrives as a Bool so `swift test` can drive this on the host. Not
/// thread-safe, and it does not need to be. The plugin calls both methods on the main queue, which
/// is also where UIKit posts `didBecomeActive`. That ordering is what makes the read-then-wait
/// race-free: an activation after the read is always delivered after the submit.
public final class AttRequestGate {
    private var pending: [() -> Void] = []

    public init() {}

    /// Runs `request` now if `isActive`, otherwise holds it for the next `appDidBecomeActive()`.
    /// Returns whether it was deferred, so the caller can log it.
    @discardableResult
    public func submit(isActive: Bool, _ request: @escaping () -> Void) -> Bool {
        if isActive {
            request()
            return false
        }
        pending.append(request)
        return true
    }

    /// Runs every held request exactly once. A later activation finds nothing to run.
    public func appDidBecomeActive() {
        let ready = pending
        pending.removeAll()
        for request in ready { request() }
    }

    /// Requests still waiting for an activation.
    public var pendingCount: Int { pending.count }
}
