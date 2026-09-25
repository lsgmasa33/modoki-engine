import Capacitor
import Network
import UIKit
import OSLog

@objc(GameDebugPlugin)
public class GameDebugPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "GameDebugPlugin"
    public let jsName = "GameDebug"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendResponse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureScreen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNativeLogs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceIp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceHardware", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "triggerFault", returnType: CAPPluginReturnPromise),
    ]

    private var listener: NWListener?
    private var clientConnection: NWConnection?
    private var serverPort: UInt16 = 9095
    /// True when the listener ended up on an OS-assigned port instead of 9095 — i.e. no host can
    /// reach it without being told the number (#283).
    private var onFallbackPort = false
    /// One retry announcement per start attempt — the retry re-enters `startListener`, so an
    /// unguarded log would print once per attempt across the whole window.
    private var retryAnnounced = false
    /// How long to retry the PREFERRED port before accepting an OS-assigned one (#283).
    /// Small on purpose — see the Java constant: on Android the outgoing app's release never
    /// arrives while we retry, it lands after the loop gives up, and the delay scales with the
    /// window, so no value wins that race. Host-side port discovery is the fix. iOS has not been
    /// observed losing this race at all (its handover releases before the incoming app binds), so
    /// this is parity rather than an iOS measurement.
    private static let bindRetryWindowMs = 1000
    private static let bindRetryIntervalMs = 150
    private var running = false
    private var receiveBuffer = Data()

    /// Serial queue that OWNS `clientConnection` + `receiveBuffer`. Every NWConnection callback runs
    /// on it (connections are `start(queue:)`-ed here and the listener's newConnectionHandler hops on),
    /// so those two fields are effectively single-threaded — no lock needed on the hot receive path.
    /// Bridge-thread readers (getStatus / sendResponse / stopAll) hop on with `sync`. This replaces the
    /// prior unsynchronized cross-queue access that raced ARC/`Data` under overlapping connect+drop (L4).
    private let connQueue = DispatchQueue(label: "com.modokiengine.gamedebug.conn")

    // MARK: - Device lease (Modoki-owned connection ownership)
    // Mirrors DeviceLeaseAuthority (engine/plugins/backend/deviceLease.ts — the canonical spec).
    // The GUID is Modoki-generated and stable across game relaunches; the device just records the
    // current owner and enforces it. On the owning socket's drop we hold the lease for a 5s GRACE
    // window so an auto-reconnect with the SAME guid resumes it (a competitor's different guid is
    // refused `busy`). A fresh app launch starts with leaseGuid == nil — the relaunch "reset".
    private let leaseLock = NSLock()
    private var leaseGuid: String?
    private var leaseGraceItem: DispatchWorkItem?
    /// Bumped every time a grace timer is (re)started or cancelled. A dispatched grace item that was
    /// already past its deadline and blocked on `leaseLock` compares its captured generation against
    /// this before freeing the lease — so a `connect`/`ping` that re-took the lease in the meantime
    /// wins the race instead of having its fresh guid nulled (L3). Cheaper + cycle-free vs capturing
    /// the work item in its own body.
    private var leaseGraceGen: Int = 0
    private static let leaseGraceSeconds: TimeInterval = 5.0

    // MARK: - Plugin Methods

    @objc func startServer(_ call: CAPPluginCall) {
        if running {
            call.resolve(["port": Int(serverPort)])
            return
        }
        let preferred = UInt16(call.getInt("port") ?? 9095)
        retryAnnounced = false
        let deadline = Date().addingTimeInterval(Double(Self.bindRetryWindowMs) / 1000.0)
        let settle = beginStart(call)
        armStartDeadline(settle)
        startListener(on: preferred, allowFallback: true, retryUntil: deadline, settle: settle)
    }

    // MARK: - Start settling (#1514)

    /// One `startServer` call, settled EXACTLY ONCE across every retry and fallback (#1514).
    ///
    /// ⚠️ The call used to be settled only from `.ready` / `.failed` in the state handler, with a
    /// `settled` flag that was PER ATTEMPT (every retry made a new one) and unsynchronised (the handler
    /// runs on a concurrent global queue, the retry from `asyncAfter`). `.waiting` and `.cancelled` hit
    /// `default: break`, and a released listener hit a silent `guard … else { return }` — so a start
    /// could simply never answer. JS awaits it with a `busy` latch (`createPortLifecycleHandler`), so
    /// one unanswered start left the device bridge dead until relaunch.
    private final class StartSettle {
        let generation: Int
        private let lock = NSLock()
        private var call: CAPPluginCall?
        private var lastState = "setup"

        init(call: CAPPluginCall, generation: Int) {
            self.call = call
            self.generation = generation
        }

        var isSettled: Bool { lock.lock(); defer { lock.unlock() }; return call == nil }

        func note(_ state: String) { lock.lock(); lastState = state; lock.unlock() }

        /// The call, if nobody has settled it yet — and nobody can after this returns it.
        func take() -> CAPPluginCall? {
            lock.lock(); defer { lock.unlock() }
            let c = call
            call = nil
            return c
        }

        /// Reject if still unsettled. Returns whether this was the settle.
        @discardableResult
        func reject(_ message: String) -> Bool {
            lock.lock()
            let c = call
            call = nil
            let state = lastState
            lock.unlock()
            guard let c = c else { return false }
            c.reject("\(message) (last listener state: \(state))")
            return true
        }
    }

    /// Bumped by `stopAll`, so a retry, fallback or deadline belonging to a start that was stopped
    /// mid-flight knows it is stale instead of re-binding after the stop. Guarded by `startLock`.
    private var startGeneration = 0
    private var pendingStart: StartSettle?
    private let startLock = NSLock()
    /// How long one `startServer` may go without `.ready` or a terminal failure before it gives up.
    /// A bind is normally ready in well under a second, and the EADDRINUSE retry window is
    /// `bindRetryWindowMs`; this bounds the states that promise nothing — `.waiting`, and anything
    /// `@unknown` — so the JS call always answers. A mechanism bound, not a tuning knob.
    private static let startDeadlineSeconds: Double = 10

    private func beginStart(_ call: CAPPluginCall) -> StartSettle {
        startLock.lock(); defer { startLock.unlock() }
        let settle = StartSettle(call: call, generation: startGeneration)
        pendingStart = settle
        return settle
    }

    private func isCurrent(_ settle: StartSettle) -> Bool {
        startLock.lock(); defer { startLock.unlock() }
        return settle.generation == startGeneration
    }

    private func armStartDeadline(_ settle: StartSettle) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.startDeadlineSeconds) { [weak self] in
            if settle.isSettled { return }
            print("[GameDebug] TCP server not ready after \(Self.startDeadlineSeconds)s — giving up this start")
            // Reject FIRST, so the `.cancelled` our cancel provokes finds the start already answered.
            guard settle.reject("TCP server was not ready within \(Int(Self.startDeadlineSeconds))s") else { return }
            // Then cancel our own listener: JS has been told this start failed, and a listener that
            // turned ready afterwards would hold the port against the start JS retries with.
            if let self = self, self.isCurrent(settle), !self.running {
                self.listener?.cancel()
                self.listener = nil
            }
        }
    }

    /// Bind the TCP server + resolve JS with the ACTUAL port — only once the listener is
    /// `.ready`, never before (a fixed port can't be assumed bound: a lingering previous app
    /// instance holds it → "Address already in use"). On that conflict it RETRIES the same port
    /// until `retryUntil`, and only then falls back to an OS-assigned free port (port 0).
    ///
    /// The fallback is a last resort, not a first response (#283): a host connects on the default
    /// port, so an app that quietly lands elsewhere is unreachable by every `device_*` tool for
    /// its whole lifetime — nothing ever comes back to reclaim the port once it frees up. Retrying
    /// across the handover window makes "the foreground app is on 9095" true once the handover
    /// settles, instead of decided by which process bound first.
    ///
    /// No Bonjour advertisement: connection is by MANUAL IP through Modoki's
    /// lease (see docs/debug-tools-mcp.md), so nothing broadcasts on the LAN — this
    /// removes the auto-discovery attack surface that let idle Claude sessions storm the device.
    ///
    /// Settles through `settle`, which every retry and fallback shares, so the JS call answers
    /// exactly once however many listeners this start goes through (#1514).
    private func startListener(on port: UInt16, allowFallback: Bool, retryUntil: Date, settle: StartSettle) {
        let newListener: NWListener
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let endpoint: NWEndpoint.Port = port == 0 ? .any : (NWEndpoint.Port(rawValue: port) ?? .any)
            newListener = try NWListener(using: params, on: endpoint)
        } catch {
            settle.reject("Failed to create listener: \(error)")
            return
        }
        listener = newListener
        // Set before every cancel THIS handler issues itself, so the `.cancelled` that follows it is
        // not read as an outside stop. The EADDRINUSE retry cancels the failed listener and then
        // binds a new one; without this flag that cancel would reject the start mid-retry. Written
        // and read only from this listener's own state handler, whose calls NWListener serialises.
        var retiredByUs = false

        // Capture the listener WEAKLY — it retains this handler, so a strong capture is a reference
        // cycle that leaks the NWListener on the EADDRINUSE fallback path (P4). ⚠️ Settling must NOT
        // depend on those weak refs: they are nil exactly when `stopAll` released the listener
        // mid-start, which is a case that must still answer. Only `.ready` needs them, for the port.
        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            settle.note("\(state)")
            switch state {
            case .ready:
                guard let self = self, let newListener = newListener, self.isCurrent(settle) else {
                    newListener?.cancel()
                    settle.reject("TCP server was stopped before it became ready")
                    return
                }
                guard let call = settle.take() else {
                    // Already answered — the deadline gave up on this start. Do not hold the port
                    // against the start JS will retry with.
                    retiredByUs = true
                    newListener.cancel()
                    if self.listener === newListener { self.listener = nil }
                    return
                }
                let actual = newListener.port?.rawValue ?? port
                self.serverPort = actual
                // Keyed on `allowFallback`, not on `actual != 9095` — only the port-0 retry passes
                // false, so this means "we did not get the port we asked for". A caller that
                // REQUESTS a non-default port and gets it is a success, not a fallback (#283).
                self.onFallbackPort = !allowFallback
                self.running = true
                print("[GameDebug] TCP server listening on port \(actual)")
                call.resolve(["port": Int(actual), "fallbackPort": self.onFallbackPort])
            case .failed(let err):
                retiredByUs = true
                newListener?.cancel()
                if settle.isSettled { return }
                print("[GameDebug] TCP server failed: \(err)")
                guard let self = self else {
                    settle.reject("TCP server failed: \(err)")
                    return
                }
                self.running = false
                if self.listener === newListener { self.listener = nil }
                if allowFallback, case .posix(let code) = err, code == .EADDRINUSE {
                    if Date() < retryUntil {
                        // Announce the WAIT, not just its outcome — the Android side gained this
                        // line only after a live test showed the port handover left no trace
                        // anyone would grep for (#283). Logged once, on the first retry.
                        if !self.retryAnnounced {
                            self.retryAnnounced = true
                            print("[GameDebug] port \(port) busy — retrying for up to \(Self.bindRetryWindowMs)ms")
                        }
                        // Same port, after a beat — the previous owner is most likely mid-release.
                        // Async rather than a sleep: this runs on the listener's state-update
                        // handler, and blocking it would stall the very callback the retry needs.
                        let delay = DispatchTimeInterval.milliseconds(Self.bindRetryIntervalMs)
                        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + delay) { [weak self] in
                            // A stop during the retry window must not be undone by the retry.
                            guard let self = self, self.isCurrent(settle) else {
                                settle.reject("TCP server was stopped during the port retry")
                                return
                            }
                            self.startListener(on: port, allowFallback: true, retryUntil: retryUntil, settle: settle)
                        }
                        return
                    }
                    print("[GameDebug] port \(port) still in use after \(Self.bindRetryWindowMs)ms — falling back to an OS-assigned port. Pass the port explicitly to device_connect.")
                    self.startListener(on: 0, allowFallback: false, retryUntil: retryUntil, settle: settle)
                } else {
                    settle.reject("TCP server failed: \(err)")
                }
            case .cancelled:
                // Our own cancel (a failed attempt being retried, or a start already answered): not
                // an ending. Anything else — `stopAll` already answers directly, but a cancel from
                // anywhere else must not leave the start hanging.
                if retiredByUs { return }
                settle.reject("TCP server listener was cancelled before it became ready")
            case .waiting(let err):
                // May still turn `.ready` (the network or a permission can come back), so this does
                // not settle — `armStartDeadline` bounds how long it may take.
                print("[GameDebug] TCP server waiting: \(err)")
            case .setup:
                break
            @unknown default:
                // A state this SDK does not know. Not settled here; the start deadline bounds it.
                print("[GameDebug] TCP server in an unknown listener state: \(state)")
            }
        }

        newListener.newConnectionHandler = { [weak self] connection in
            // Serialize connection setup + all clientConnection/receiveBuffer access onto connQueue (L4).
            self?.connQueue.async { self?.handleNewConnection(connection) }
        }
        newListener.start(queue: .global(qos: .userInitiated))
    }

    @objc func stopServer(_ call: CAPPluginCall) {
        stopAll()
        call.resolve(["ok": true])
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let connected = connQueue.sync { clientConnection?.state == .ready } // read on the owning queue (L4)
        call.resolve([
            "running": running,
            "clientConnected": connected,
            "port": Int(serverPort),
            "fallbackPort": onFallbackPort,
        ])
    }

    @objc func sendResponse(_ call: CAPPluginCall) {
        // Read the connection on its owning queue; `send` itself is thread-safe off-queue (L4).
        let conn = connQueue.sync { () -> NWConnection? in
            guard let c = clientConnection, c.state == .ready else { return nil }
            return c
        }
        guard let conn = conn else {
            call.reject("No client connected")
            return
        }

        let id = call.getString("id") ?? ""
        var response: [String: Any] = ["id": id]
        if let result = call.getString("result") {
            response["result"] = result
        }
        if let error = call.getString("error") {
            response["error"] = error
        }

        do {
            var data = try JSONSerialization.data(withJSONObject: response)
            data.append(0x0A) // newline delimiter
            conn.send(content: data, completion: .contentProcessed { error in
                if let error = error {
                    call.reject("Send failed: \(error)")
                } else {
                    call.resolve(["ok": true])
                }
            })
        } catch {
            call.reject("JSON serialization failed: \(error)")
        }
    }

    /// The device's WiFi (en0) IPv4 address — shown in the in-game debug menu so the user can
    /// type it into Modoki's Connect field. Empty string if WiFi isn't up.
    @objc func getDeviceIp(_ call: CAPPluginCall) {
        call.resolve(["ip": GameDebugPlugin.wifiIPv4() ?? ""])
    }

    /// WHICH PHONE this lease is holding (#146), so the host can tie a WebDriverAgent launch to it
    /// instead of guessing from what is plugged into the Mac.
    ///
    /// `model` is `hw.machine` — the product type, `iPhone18,4` — chosen because it is the one
    /// string the HOST also sees: `xcrun devicectl` reports it byte-identical as
    /// `hardwareProperties.productType`, so the two can be compared. A UDID cannot: iOS forbids an
    /// app reading the hardware UDID, and `identifierForVendor` appears in no `xcrun` listing.
    /// `UIDevice.model` is NOT usable either — it answers a generic `"iPhone"`.
    ///
    /// This lives HERE rather than in `@capacitor/device` deliberately. #146 only matters while a
    /// device holds a lease, and holding one requires this plugin — whereas `@capacitor/device` is
    /// optional and no Modoki project installs it, which made the first version of that fix inert
    /// on every real device (it read `Capacitor.Plugins.Device`, always undefined, so the host
    /// always fell back to guessing). A fact needed by the lease belongs in the lease's own plugin.
    ///
    /// Never fabricates: an unreadable value is the empty string, which the host reads as "unknown"
    /// and treats as unverified — never as a mismatch.
    @objc func getDeviceHardware(_ call: CAPPluginCall) {
        call.resolve([
            "model": GameDebugPlugin.hardwareModel(),
            "osVersion": UIDevice.current.systemVersion,
        ])
    }

    /// `hw.machine` via sysctl — the same source Capacitor's Device plugin uses. Two calls: the
    /// first sizes the buffer, the second fills it.
    private static func hardwareModel() -> String {
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var machine = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &machine, &size, nil, 0) == 0 else { return "" }
        return String(cString: machine)
    }

    private static func wifiIPv4() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            let interface = cur.pointee
            // `getifaddrs(3)` may hand back an interface with NO address — normal for `awdl0`, an
            // unconfigured tunnel, or a downed cellular link. Swift imports `ifa_addr` as an
            // IMPLICITLY-UNWRAPPED optional, so `.pointee` on it compiles cleanly and TRAPS at
            // runtime on such an entry. This loop inspects every interface before deciding which
            // one it wants, so one address-less entry anywhere in the list would crash
            // `getDeviceIp()` — which the in-game debug menu's Device tab calls.
            //
            // ⚠️ Advance the cursor BEFORE continuing. `ptr` moves on the LAST line of this body,
            // so a bare `guard ... else { continue }` never advances and the `while` spins
            // forever — trading a crash for an unkillable hang, on exactly the interface list
            // that triggered it.
            guard let addr = interface.ifa_addr else { ptr = interface.ifa_next; continue }
            if addr.pointee.sa_family == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                if name == "en0" { // WiFi on iOS
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(addr, socklen_t(addr.pointee.sa_len),
                                &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
                    address = String(cString: hostname)
                }
            }
            ptr = interface.ifa_next
        }
        return address
    }

    // MARK: - Lease handling

    /// Handle a control message natively (never relayed to JS). Returns the reply dict to send.
    private func evaluateLease(method: String, guid: String) -> [String: Any] {
        leaseLock.lock()
        defer { leaseLock.unlock() }
        switch method {
        case "connect":
            cancelGraceLocked()
            if leaseGuid == nil { leaseGuid = guid; return ["ok": true] }
            if leaseGuid == guid { return ["ok": true, "resumed": true] } // owner reattaching
            return ["ok": false, "reason": "busy"] // another Modoki owns it
        case "ping":
            if leaseGuid == nil { return ["ok": false, "reason": "no-lease"] }
            if leaseGuid == guid { cancelGraceLocked(); return ["ok": true] }
            return ["ok": false, "reason": "not-owner"]
        case "disconnect":
            if leaseGuid == guid { leaseGuid = nil; cancelGraceLocked(); return ["ok": true] }
            return ["ok": false, "reason": leaseGuid == nil ? "no-lease" : "not-owner"]
        default:
            return ["ok": false, "reason": "not-owner"]
        }
    }

    /// Owner socket dropped: hold the lease for the grace window, then free it if no reconnect.
    private func startLeaseGrace() {
        leaseLock.lock()
        defer { leaseLock.unlock() }
        guard leaseGuid != nil else { return }
        cancelGraceLocked()
        let gen = leaseGraceGen
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.leaseLock.lock()
            defer { self.leaseLock.unlock() }
            // If a connect/ping ran cancelGraceLocked() while this item was blocked on the lock, the
            // generation moved on and the owner re-took the lease — don't free the fresh guid (L3).
            guard gen == self.leaseGraceGen else { return }
            self.leaseGuid = nil
            self.leaseGraceItem = nil
            print("[GameDebug] lease grace expired — device freed")
        }
        leaseGraceItem = item
        DispatchQueue.global().asyncAfter(deadline: .now() + GameDebugPlugin.leaseGraceSeconds, execute: item)
    }

    /// Cancel a pending grace timer. MUST be called with leaseLock held.
    private func cancelGraceLocked() {
        leaseGraceItem?.cancel()
        leaseGraceItem = nil
        leaseGraceGen &+= 1 // invalidate a grace item already dispatched + blocked on leaseLock (L3)
    }

    /// Write a `{id, result}` control reply directly on the client socket.
    private func sendControlReply(id: String, result: [String: Any]) {
        guard let conn = clientConnection, conn.state == .ready else { return }
        let response: [String: Any] = ["id": id, "result": result]
        guard var data = try? JSONSerialization.data(withJSONObject: response) else { return }
        data.append(0x0A)
        conn.send(content: data, completion: .contentProcessed { _ in })
    }

    // MARK: - Native Screenshot

    @objc func captureScreen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows })
                .first(where: { $0.isKeyWindow }) else {
                call.reject("No key window found")
                return
            }

            let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
            let image = renderer.image { ctx in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }

            let nativeWidth = Int(window.bounds.width * window.screen.scale)
            let nativeHeight = Int(window.bounds.height * window.screen.scale)

            // Resize to max 600px wide. Force renderer scale = 1 so the newSize (in points) is the
            // ACTUAL pixel size — otherwise UIGraphicsImageRenderer defaults to the screen scale and
            // the JPEG + reported dims are ~3× the intended cap on a 3x device (L12).
            let maxWidth: CGFloat = 600
            var outputImage = image
            if CGFloat(nativeWidth) > maxWidth {
                let scale = maxWidth / CGFloat(nativeWidth)
                let newSize = CGSize(width: maxWidth, height: CGFloat(nativeHeight) * scale)
                let format = UIGraphicsImageRendererFormat.default()
                format.scale = 1
                let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
                outputImage = renderer.image { _ in
                    image.draw(in: CGRect(origin: .zero, size: newSize))
                }
            }

            guard let jpegData = outputImage.jpegData(compressionQuality: 0.7) else {
                call.reject("JPEG compression failed")
                return
            }

            let base64 = "data:image/jpeg;base64," + jpegData.base64EncodedString()
            let outputWidth = Int(outputImage.size.width * outputImage.scale)
            let outputHeight = Int(outputImage.size.height * outputImage.scale)

            call.resolve([
                "image": base64,
                "imageWidth": outputWidth,
                "imageHeight": outputHeight,
                "screenWidth": nativeWidth,
                "screenHeight": nativeHeight,
            ])
        }
    }

    // MARK: - Native Logs (os_log via OSLogStore)

    @objc func getNativeLogs(_ call: CAPPluginCall) {
        // At least 1: the ring below calls removeFirst() once it is full, which on an empty array
        // is a precondition failure — `limit:0` killed the app under test (#1558 review). The MCP
        // refuses limit < 1 too; this is the floor for any other caller.
        let limit = max(1, call.getInt("limit") ?? 50)
        let seconds = call.getInt("seconds") ?? 60
        let filter = call.getString("filter")  // optional text filter (case-insensitive)
        let subsystem = call.getString("subsystem")  // optional subsystem filter

        DispatchQueue.global(qos: .userInitiated).async {
            var lines: [String] = []
            // A failed read is reported in `error`, never as a log line: the MCP decoder (#648)
            // turns `{logs:[], error}` into a refusal, while a line reading "OSLogStore error: …"
            // was indistinguishable from log content (#1558 review).
            var readError: String? = nil

            if #available(iOS 15.0, *) {
                do {
                    let store = try OSLogStore(scope: .currentProcessIdentifier)
                    // The window is a DATE PREDICATE, not just a position (#1558). This was
                    // `position(timeIntervalSinceLatestBoot: -seconds)` — N seconds BEFORE BOOT —
                    // and a position alone does not bound getEntries anyway: measured on macOS's
                    // OSLogStore, both a boot-relative and a date position returned all 20,000 of
                    // the process's entries (4.8 s), while the predicate returned only the window
                    // (1.4 s). So `seconds` did nothing, and the scan grew with app uptime until it
                    // outran the 5 s device-request budget.
                    let since = Date(timeIntervalSinceNow: -Double(seconds))
                    let position = store.position(date: since)
                    let inWindow = NSPredicate(format: "date >= %@", since as NSDate)
                    let formatter = ISO8601DateFormatter()
                    let filterLower = filter?.lowercased()

                    // Collect into a ring buffer — avoids .suffix() which iterates everything
                    var ring: [String] = []
                    ring.reserveCapacity(limit)
                    for entry in try store.getEntries(at: position, matching: inWindow) {
                        guard let logEntry = entry as? OSLogEntryLog else { continue }

                        // Subsystem filter
                        if let sub = subsystem, !logEntry.subsystem.localizedCaseInsensitiveContains(sub) {
                            continue
                        }

                        let levelStr: String
                        switch logEntry.level {
                        case .debug: levelStr = "D"
                        case .info: levelStr = "I"
                        case .notice: levelStr = "N"
                        case .error: levelStr = "E"
                        case .fault: levelStr = "F"
                        default: levelStr = "?"
                        }
                        let line = "\(formatter.string(from: logEntry.date)) [\(levelStr)] \(logEntry.subsystem): \(logEntry.composedMessage)"

                        // Text filter
                        if let f = filterLower, !line.lowercased().contains(f) {
                            continue
                        }

                        if ring.count < limit {
                            ring.append(line)
                        } else {
                            ring.removeFirst()
                            ring.append(line)
                        }
                    }
                    lines = ring
                } catch {
                    readError = "OSLogStore error: \(error.localizedDescription)"
                }
            } else {
                readError = "Native logs require iOS 15+"
            }

            var result = JSObject()
            result["logs"] = lines
            if let readError { result["error"] = readError }
            call.resolve(result)
        }
    }

    // MARK: - TCP Connection Handling

    private func handleNewConnection(_ connection: NWConnection) {
        // SINGLE-CLIENT bridge: keep the CURRENT connected client and cleanly refuse a
        // competing one. The old "latest wins" (cancel the active client on every new
        // connection) caused a reconnect STORM when more than one game-debug MCP client
        // existed — e.g. several Claude sessions on one machine, each an MCP server
        // discovering the device: each new connection cancelled the active one, so all
        // of them reconnected in a tight loop and no request ever completed. Now the
        // first client holds the bridge; extras are dropped without disturbing it. A
        // genuinely-gone client frees the slot (its connection goes .cancelled/.failed
        // below → clientConnection = nil), so a restarted client can take over.
        if let existing = clientConnection, existing.state == .ready {
            print("[GameDebug] refusing extra client \(connection.endpoint.debugDescription) — one already connected")
            connection.cancel()
            return
        }
        if let old = clientConnection {
            old.cancel() // stale/not-yet-ready — replace it
        }

        clientConnection = connection
        receiveBuffer = Data()

        let remote = connection.endpoint.debugDescription
        print("[GameDebug] Client connected: \(remote)")

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                DispatchQueue.main.async {
                    self?.notifyListeners("connectionChanged", data: [
                        "connected": true,
                        "remoteAddress": remote,
                    ])
                }
                self?.receiveData(connection)
            case .failed, .cancelled:
                print("[GameDebug] Client disconnected")
                DispatchQueue.main.async {
                    self?.notifyListeners("connectionChanged", data: [
                        "connected": false,
                    ])
                }
                // Only clear if THIS connection is still the active one — a refused
                // extra connection cancelling must not null out the held client.
                if self?.clientConnection === connection {
                    self?.clientConnection = nil
                    // Hold the lease through the grace window so an auto-reconnect with the same
                    // guid resumes it (a game relaunch / WiFi blip), rather than freeing instantly.
                    self?.startLeaseGrace()
                }
            default:
                break
            }
        }

        connection.start(queue: connQueue) // all callbacks (state + receive) serialize on connQueue (L4)
    }

    private func receiveData(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, isComplete, error in
            guard let self = self else { return }

            if let data = content {
                self.receiveBuffer.append(data)
                // Defensive framing: a peer that never sends a newline would otherwise grow the buffer
                // without bound (OOM). Cap it and drop the connection (P3).
                if self.receiveBuffer.count > 8 * 1024 * 1024 && !self.receiveBuffer.contains(0x0A) {
                    print("[GameDebug] receive buffer exceeded cap with no frame — dropping connection")
                    connection.cancel()
                    return
                }
                self.processBuffer()
            }

            if isComplete || error != nil {
                connection.cancel()
                return
            }

            // Continue receiving
            self.receiveData(connection)
        }
    }

    private func processBuffer() {
        // Split by newline — each line is a JSON message
        while let newlineIndex = receiveBuffer.firstIndex(of: 0x0A) {
            let messageData = receiveBuffer[receiveBuffer.startIndex..<newlineIndex]
            receiveBuffer = Data(receiveBuffer[receiveBuffer.index(after: newlineIndex)...])

            guard let json = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any],
                  let id = json["id"] as? String,
                  let method = json["method"] as? String else {
                continue
            }

            // Lease control messages are handled NATIVELY (the socket is the ownership gate) and
            // never relayed to JS — connect/ping/disconnect arbitrate which Modoki owns the device.
            if method == "connect" || method == "ping" || method == "disconnect" {
                let guid = (json["params"] as? [String: Any])?["guid"] as? String ?? ""
                let reply = evaluateLease(method: method, guid: guid)
                sendControlReply(id: id, result: reply)
                continue
            }

            // Serialize params back to JSON string for JS
            let params: String
            if let p = json["params"] {
                params = (try? String(data: JSONSerialization.data(withJSONObject: p), encoding: .utf8)) ?? "{}"
            } else {
                params = "{}"
            }

            DispatchQueue.main.async {
                self.notifyListeners("request", data: [
                    "id": id,
                    "method": method,
                    "params": params,
                ])
            }
        }
    }

    // MARK: - Fault triggers (#278)

    /// `Info.plist` key carrying the project's `build.debugBuild` — the iOS mirror of Android's
    /// `com.modokiengine.gamedebug.DEBUG_BUILD` manifest meta-data. Written by
    /// `healIosDebugBuildInfoPlist` (engine/plugins/healNativeConfig.ts); the NAME is the contract
    /// between the two, so keep them in sync.
    private static let debugBuildPlistKey = "ModokiDebugBuild"

    /// Is `build.debugBuild` on for this app?
    ///
    /// Absent key → FALSE. Fail closed, exactly as Android does: a project that has not been
    /// reopened since this landed loses the fault triggers rather than shipping a reachable way to
    /// kill the app, and the reject message says how to turn them back on.
    ///
    /// ⚠️ This gate is deliberately NOT applied to `startServer` in the same change. That method
    /// has been ungated on iOS since it was written, so failing it closed would take the debug
    /// bridge away from every project at once, on a heal nobody has run yet. Retrofitting it is a
    /// separate decision with a separate rollout — see #278.
    private func isDebugBuildEnabled() -> Bool {
        return Bundle.main.object(forInfoDictionaryKey: GameDebugPlugin.debugBuildPlistKey) as? Bool ?? false
    }

    /// Small delay between resolving the JS call and raising the fault, so the resolve marshals
    /// back across the bridge before the process dies. Best effort, not a guarantee.
    private static let faultDelaySeconds: TimeInterval = 0.25

    /// Raise a deliberate native fault so the crash pipeline can be proven (#278).
    ///
    /// iOS supports `crash` ONLY. `anr` and `uncaught` are rejected rather than approximated:
    /// iOS has no ANR — the watchdog (0x8badf00d) kills only during launch/suspend transitions,
    /// not steady-state foreground, and Crashlytics does not report hangs at all. An approximation
    /// here would produce a probe that appears to test something and tests nothing.
    @objc func triggerFault(_ call: CAPPluginCall) {
        guard isDebugBuildEnabled() else {
            call.reject("Fault triggers disabled: build.debugBuild is off for this project "
                        + "(Project Settings → Developer → \"Debug build\"). Rebuild after enabling it.")
            return
        }

        let kind = call.getString("kind") ?? ""
        switch kind {
        case "crash":
            NSLog("[GameDebug] triggerFault: dereferencing a bad pointer on purpose (#278)")
            call.resolve(["ok": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + GameDebugPlugin.faultDelaySeconds) {
                // A real EXC_BAD_ACCESS — the segfault shape — rather than `fatalError()`, which
                // traps as SIGILL and reports as a different kind of fault.
                let bad = UnsafeMutablePointer<Int>(bitPattern: 0x1)!
                bad.pointee = 0
            }
        case "anr", "uncaught":
            call.reject("Fault kind \"\(kind)\" is Android-only. iOS has no ANR (the watchdog fires "
                        + "on launch/suspend transitions, not a foreground hang) and Crashlytics does not "
                        + "report hangs — MetricKit MXHangDiagnostic is the oracle for those. Use \"crash\".")
        default:
            call.reject("Unknown fault kind \"\(kind)\" — iOS supports: crash.")
        }
    }

    // MARK: - Cleanup

    private func stopAll() {
        connQueue.sync { clientConnection?.cancel(); clientConnection = nil } // owning queue (L4)
        leaseLock.lock()
        leaseGraceItem?.cancel()
        leaseGraceItem = nil
        leaseGuid = nil
        leaseLock.unlock()
        // A start still in flight is over: bump the generation so its retry/fallback/deadline stands
        // down, and answer its call now rather than trusting `.cancelled` to reach it (#1514).
        startLock.lock()
        startGeneration += 1
        let pending = pendingStart
        pendingStart = nil
        startLock.unlock()
        pending?.reject("TCP server was stopped before it became ready")
        listener?.cancel()
        listener = nil
        running = false
        // Cleared with the listener it describes — a stale `true` would have `getStatus` report a
        // fallback port on a server that is not running (#283).
        onFallbackPort = false
        print("[GameDebug] Server stopped")
    }

    deinit {
        stopAll()
    }
}
