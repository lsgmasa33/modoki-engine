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
/// ⚠️ **Only a request that would PROMPT is held (#1532).** Once the player has answered, iOS returns
/// the stored status without drawing anything, whatever the app state, so there is nothing to protect.
/// Holding it anyway is what #1532 observed once (iPad, 2026-09-24): after a resume-reload (a WebView
/// reload inside a live process), the reloaded realm's ads and AppsFlyer start stayed stuck until the
/// next app switch. The mechanism is INFERRED, not observed: the request was parked because the app was
/// not active when it asked (in that run WebDriverAgent had taken the foreground), and it waited for an
/// activation. Ads and AppsFlyer both wait on this answer, so a parked answer stalls both.
///
/// The status arrives as `ATTrackingManager.trackingAuthorizationStatus.rawValue`, not the enum. The
/// enum does exist on macOS (11+), unlike UIKit, but this package declares only `.iOS(.v15)`, so its
/// host build targets a macOS below 11 and the enum would need availability annotations throughout.
/// The raw value keeps the gate annotation-free; the tests pin it against Apple's enum. `needsPrompt(attStatusRaw:)`
/// is the ONE place that maps it, so the tests reach the mapping instead of a Bool the plugin computed.
///
/// No UIKit here: the state arrives as a Bool so `swift test` can drive this on the host. Not
/// thread-safe, and it does not need to be. The plugin calls both methods on the main queue, which
/// is also where UIKit posts `didBecomeActive`. That ordering is what makes the read-then-wait
/// race-free: an activation after the read is always delivered after the submit.
public final class AttRequestGate {
    /// What `submit` did with a request.
    public enum Outcome: Equatable {
        /// The app was active: asked at once (this may prompt).
        case ran
        /// Not active, but the player has already answered: asked at once, since nothing will draw (#1532).
        case ranAnswered
        /// Not active and unanswered: held for the next `appDidBecomeActive()` (#1510).
        case held
    }

    /// `ATTrackingManager.AuthorizationStatus.notDetermined.rawValue` — Apple's enum is `notDetermined = 0`,
    /// `restricted = 1`, `denied = 2`, `authorized = 3`. Mirrored here so the mapping is host-testable.
    public static let notDeterminedRawValue: UInt = 0

    /// Whether a request with this status can show the prompt. Only an unanswered status can; any other
    /// value (including one a future iOS adds) returns the stored answer without UI.
    public static func needsPrompt(attStatusRaw: UInt) -> Bool {
        attStatusRaw == notDeterminedRawValue
    }

    private var pending: [() -> Void] = []

    public init() {}

    /// Runs `request` now if `isActive`, or if it cannot prompt (the player has already answered).
    /// Otherwise holds it for the next `appDidBecomeActive()`. Returns what it did, so the caller can log it.
    @discardableResult
    public func submit(isActive: Bool, attStatusRaw: UInt, _ request: @escaping () -> Void) -> Outcome {
        if isActive {
            request()
            return .ran
        }
        if !Self.needsPrompt(attStatusRaw: attStatusRaw) {
            request()
            return .ranAnswered
        }
        pending.append(request)
        return .held
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
