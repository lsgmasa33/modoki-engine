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
    ]

    private var listener: NWListener?
    private var clientConnection: NWConnection?
    private var serverPort: UInt16 = 9095
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
        startListener(on: preferred, allowFallback: true, call: call)
    }

    /// Bind the TCP server + resolve JS with the ACTUAL port — only once the listener is
    /// `.ready`, never before (a fixed port can't be assumed bound: a lingering previous app
    /// instance holds it → "Address already in use"). On that conflict, retry on an OS-assigned
    /// free port (port 0). No Bonjour advertisement: connection is by MANUAL IP through Modoki's
    /// lease (see docs/debug-tools-mcp.md), so nothing broadcasts on the LAN — this
    /// removes the auto-discovery attack surface that let idle Claude sessions storm the device.
    /// Resolves/rejects the call exactly once (`settled`).
    private func startListener(on port: UInt16, allowFallback: Bool, call: CAPPluginCall) {
        let newListener: NWListener
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let endpoint: NWEndpoint.Port = port == 0 ? .any : (NWEndpoint.Port(rawValue: port) ?? .any)
            newListener = try NWListener(using: params, on: endpoint)
        } catch {
            call.reject("Failed to create listener: \(error)")
            return
        }
        listener = newListener

        var settled = false
        // Capture the listener WEAKLY — it retains this handler, so a strong capture is a reference
        // cycle that leaks the NWListener on the EADDRINUSE fallback path (P4).
        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            guard let self = self, let newListener = newListener else { return }
            switch state {
            case .ready:
                if settled { return }
                settled = true
                let actual = newListener.port?.rawValue ?? port
                self.serverPort = actual
                self.running = true
                print("[GameDebug] TCP server listening on port \(actual)")
                call.resolve(["port": Int(actual)])
            case .failed(let err):
                if settled { return }
                settled = true
                print("[GameDebug] TCP server failed: \(err)")
                self.running = false
                newListener.cancel()
                self.listener = nil
                if allowFallback, case .posix(let code) = err, code == .EADDRINUSE {
                    print("[GameDebug] port \(port) in use (previous instance?) — retrying on an OS-assigned port")
                    self.startListener(on: 0, allowFallback: false, call: call)
                } else {
                    call.reject("TCP server failed: \(err)")
                }
            default:
                break
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

    private static func wifiIPv4() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        var ptr: UnsafeMutablePointer<ifaddrs>? = first
        while let cur = ptr {
            let interface = cur.pointee
            if interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                if name == "en0" { // WiFi on iOS
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
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
        let limit = call.getInt("limit") ?? 50
        let seconds = call.getInt("seconds") ?? 60
        let filter = call.getString("filter")  // optional text filter (case-insensitive)
        let subsystem = call.getString("subsystem")  // optional subsystem filter

        DispatchQueue.global(qos: .userInitiated).async {
            var lines: [String] = []

            if #available(iOS 15.0, *) {
                do {
                    let store = try OSLogStore(scope: .currentProcessIdentifier)
                    let position = store.position(timeIntervalSinceLatestBoot: -Double(seconds))
                    let formatter = ISO8601DateFormatter()
                    let filterLower = filter?.lowercased()

                    // Collect into a ring buffer — avoids .suffix() which iterates everything
                    var ring: [String] = []
                    ring.reserveCapacity(limit)
                    for entry in try store.getEntries(at: position) {
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
                    lines.append("OSLogStore error: \(error.localizedDescription)")
                }
            } else {
                lines.append("Native logs require iOS 15+")
            }

            var result = JSObject()
            result["logs"] = lines
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

    // MARK: - Cleanup

    private func stopAll() {
        connQueue.sync { clientConnection?.cancel(); clientConnection = nil } // owning queue (L4)
        leaseLock.lock()
        leaseGraceItem?.cancel()
        leaseGraceItem = nil
        leaseGuid = nil
        leaseLock.unlock()
        listener?.cancel()
        listener = nil
        running = false
        print("[GameDebug] Server stopped")
    }

    deinit {
        stopAll()
    }
}
