package com.modokiengine.capacitor.gamedebug;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

@CapacitorPlugin(name = "GameDebug")
public class GameDebugPlugin extends Plugin {

    private static final String TAG = "GameDebug";
    private static final int DEFAULT_PORT = 9095;

    private ServerSocket serverSocket;
    // volatile + guarded by synchronized(this): the read thread's finally, handleNewClient, and the
    // sendResponse/writeControlReply writers all touch these across threads — without a happens-before
    // edge a reconnecting owner could be spuriously refused or a check-then-write could NPE (L13).
    private volatile Socket clientSocket;
    private volatile OutputStream clientOutput;
    private int serverPort = DEFAULT_PORT;
    private volatile boolean running = false;
    private Thread serverThread;
    private Thread readThread;

    // Device lease — mirrors DeviceLeaseAuthority (engine/plugins/backend/deviceLease.ts).
    // Records the current Modoki owner's (stable) GUID and enforces it: a different guid while
    // owned is refused `busy`; on the owning socket's drop the lease is held for a 5s GRACE window
    // so an auto-reconnect with the same guid resumes it. A fresh app launch starts leaseGuid null.
    private final Object leaseLock = new Object();
    private volatile String leaseGuid = null;
    private final Handler leaseHandler = new Handler(Looper.getMainLooper());
    private Runnable leaseGraceRunnable = null;
    private static final long LEASE_GRACE_MS = 5000;

    /** AndroidManifest {@code <meta-data>} carrying the project's {@code build.debugBuild}.
     *  Written by {@code healAndroidDebugBuildMetaData} (engine/plugins/healNativeConfig.ts) —
     *  the NAME is the contract between the two; keep them in sync. */
    private static final String META_DEBUG_BUILD = "com.modokiengine.gamedebug.DEBUG_BUILD";

    /** Is the debug bridge enabled for this app? Reads {@code build.debugBuild} out of the
     *  manifest, NOT the APK's debuggable flag (#112).
     *
     *  It used to be {@code FLAG_DEBUGGABLE} — i.e. the Gradle build type — which made the build
     *  type a second, competing answer to "is this a debug build". A project with
     *  {@code debugBuild: true} assembled as a release variant shipped the JS bridge with a
     *  plugin that refused to start, and the only explanation was a reject string blaming
     *  "release builds". {@code build.debugBuild} is now the one answer; the build type means
     *  optimization and shrinking.
     *
     *  Absent meta-data → FALSE. Fail closed: a project not reopened since #112 (so never
     *  healed) loses the bridge rather than silently keeping a TCP server that can eval
     *  arbitrary JS. The reject message says exactly how to turn it back on. */
    private boolean isDebugBuildEnabled() {
        try {
            android.content.pm.ApplicationInfo ai = getContext().getPackageManager().getApplicationInfo(
                    getContext().getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            return ai.metaData != null && ai.metaData.getBoolean(META_DEBUG_BUILD, false);
        } catch (Exception e) {
            Log.w(TAG, "could not read " + META_DEBUG_BUILD + " — treating as disabled", e);
            return false;
        }
    }

    @PluginMethod
    public void startServer(PluginCall call) {
        // One gate, one flag: build.debugBuild. NOT the APK's debuggable flag — see above.
        if (!isDebugBuildEnabled()) {
            call.reject("Debug bridge disabled: build.debugBuild is off for this project "
                    + "(Project Settings → Developer → \"Debug build\"). Rebuild after enabling it.");
            return;
        }

        if (running) {
            JSObject result = new JSObject();
            result.put("port", serverPort);
            call.resolve(result);
            return;
        }

        int preferred = call.getInt("port", DEFAULT_PORT);

        // No LAN discovery: connection is by MANUAL target through Modoki's lease (adb-forward
        // over USB, or the device IP over WiFi). NSD/Bonjour advertising + the UDP beacon were
        // removed — they broadcast the device on the LAN, which is exactly what let idle Claude
        // sessions auto-grab it. See docs/debug-tools-mcp.md.
        startListener(preferred, true, call);
    }

    /** Bind the TCP server + resolve JS with the ACTUAL port — only once the bind outcome is
     *  known, never before (a fixed port can't be assumed bound: a lingering previous app
     *  instance holds it -> `BindException: EADDRINUSE`). On that conflict, retry on an
     *  OS-assigned free port (port 0), mirroring `GameDebugPlugin.swift`'s `startListener`. Unlike
     *  iOS's async `NWListener`, `new ServerSocket(...)` binds synchronously, so there is no
     *  listener-state callback to wait for — the try/catch below IS the bind outcome, and
     *  `call.resolve`/`call.reject` only fires once it is known. (Capacitor invokes plugin methods
     *  off the main thread, so this synchronous bind cannot trip `NetworkOnMainThreadException` —
     *  the accept LOOP still runs on its own daemon thread since it blocks indefinitely.) */
    private void startListener(int port, boolean allowFallback, PluginCall call) {
        ServerSocket socket;
        try {
            // SO_REUSEADDR must be set BEFORE the bind, so the socket is created UNBOUND and bound
            // explicitly. `new ServerSocket(port)` binds in the constructor, which made the old
            // `setReuseAddress(true)` on the next line a silent no-op (Java ignores it post-bind).
            //
            // That was harmless while the server only started once per process — SO_REUSEADDR does
            // not let two LIVE listeners share a port, so it never affected the #88 collision. It
            // became load-bearing when the bridge started releasing the port on pause and
            // re-binding on resume (#95): a just-closed listener leaves the port in TIME_WAIT, and
            // without SO_REUSEADDR the re-bind fails, falls back to an OS-assigned port, and
            // recreates the very unreachability that change exists to remove.
            socket = new ServerSocket();
            socket.setReuseAddress(true);
            socket.bind(new java.net.InetSocketAddress(port));
        } catch (java.net.BindException e) {
            if (allowFallback) {
                Log.w(TAG, "port " + port + " in use (previous instance?) — retrying on an OS-assigned port");
                startListener(0, false, call);
                return;
            }
            Log.e(TAG, "Server start failed: " + e.getMessage());
            call.reject("TCP server failed: " + e.getMessage(), e);
            return;
        } catch (Exception e) {
            Log.e(TAG, "Server start failed: " + e.getMessage());
            call.reject("Failed to create server socket: " + e.getMessage(), e);
            return;
        }

        serverSocket = socket;
        int actualPort = socket.getLocalPort();
        serverPort = actualPort;
        running = true;
        Log.i(TAG, "TCP server listening on port " + actualPort);

        serverThread = new Thread(() -> {
            while (running) {
                try {
                    Socket client = serverSocket.accept();
                    handleNewClient(client);
                } catch (Exception e) {
                    if (running) Log.w(TAG, "Accept error: " + e.getMessage());
                }
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();

        JSObject result = new JSObject();
        result.put("port", actualPort);
        call.resolve(result);
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        stopAll();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", running);
        result.put("clientConnected", clientSocket != null && clientSocket.isConnected() && !clientSocket.isClosed());
        result.put("port", serverPort);
        call.resolve(result);
    }

    @PluginMethod
    public void sendResponse(PluginCall call) {
        String id = call.getString("id", "");
        String resultStr = call.getString("result");
        String error = call.getString("error");

        try {
            JSONObject response = new JSONObject();
            response.put("id", id);
            if (resultStr != null) response.put("result", resultStr);
            if (error != null) response.put("error", error);

            byte[] data = (response.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            // Re-check clientOutput INSIDE the lock: the read thread's finally can null it between an
            // outside-lock check and the write, turning a clean "No client connected" into an NPE
            // surfaced as "Send failed" (L13).
            boolean sent = false;
            synchronized (this) {
                if (clientOutput != null) {
                    clientOutput.write(data);
                    clientOutput.flush();
                    sent = true;
                }
            }
            if (!sent) {
                call.reject("No client connected");
                return;
            }

            JSObject ok = new JSObject();
            ok.put("ok", true);
            call.resolve(ok);
        } catch (Exception e) {
            call.reject("Send failed: " + e.getMessage());
        }
    }

    // --- Device IP (for the in-game debug menu) ---

    @PluginMethod
    public void getDeviceIp(PluginCall call) {
        String ip = getWifiIpv4();
        JSObject result = new JSObject();
        result.put("ip", ip != null ? ip : "");
        call.resolve(result);
    }

    /**
     * WHICH DEVICE this lease is holding (#146). The iOS twin is what the feature exists for —
     * there the model is compared against `xcrun devicectl`'s productType so a WebDriverAgent
     * launch cannot start on the wrong phone. Android has no such launch, so this is reported for
     * PARITY (docs/mcp-tool-conventions.md §9): device_status names the hardware on both platforms,
     * and a capability present on one surface but not the other is a finding, not a default.
     *
     * `Build.MODEL` is the marketing model ("SC-56C"), which is what an Android host tool sees in
     * `adb shell getprop ro.product.model` — the analogous host-comparable string. Never null:
     * the empty string reads as "unknown" on the host and is treated as unverified.
     */
    @PluginMethod
    public void getDeviceHardware(PluginCall call) {
        JSObject result = new JSObject();
        result.put("model", android.os.Build.MODEL != null ? android.os.Build.MODEL : "");
        result.put("osVersion", android.os.Build.VERSION.RELEASE != null ? android.os.Build.VERSION.RELEASE : "");
        call.resolve(result);
    }

    private String getWifiIpv4() {
        try {
            String fallback = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                boolean isWifi = ni.getName().startsWith("wlan");
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String ip = addr.getHostAddress();
                        if (isWifi) return ip;          // prefer WiFi (wlan0)
                        if (fallback == null) fallback = ip;
                    }
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    // --- Device lease ---

    /** Evaluate a control message natively. Never relayed to JS — the socket is the ownership gate. */
    private JSONObject evaluateLease(String method, String guid) throws org.json.JSONException {
        JSONObject r = new JSONObject();
        synchronized (leaseLock) {
            if ("connect".equals(method)) {
                cancelGraceLocked();
                if (leaseGuid == null) { leaseGuid = guid; r.put("ok", true); }
                else if (leaseGuid.equals(guid)) { r.put("ok", true); r.put("resumed", true); }
                else { r.put("ok", false); r.put("reason", "busy"); }
            } else if ("ping".equals(method)) {
                if (leaseGuid == null) { r.put("ok", false); r.put("reason", "no-lease"); }
                else if (leaseGuid.equals(guid)) { cancelGraceLocked(); r.put("ok", true); }
                else { r.put("ok", false); r.put("reason", "not-owner"); }
            } else if ("disconnect".equals(method)) {
                if (leaseGuid != null && leaseGuid.equals(guid)) { leaseGuid = null; cancelGraceLocked(); r.put("ok", true); }
                else { r.put("ok", false); r.put("reason", leaseGuid == null ? "no-lease" : "not-owner"); }
            } else {
                r.put("ok", false); r.put("reason", "not-owner");
            }
        }
        return r;
    }

    /** Owner socket dropped: hold the lease for the grace window, then free it if no reconnect. */
    private void startLeaseGrace() {
        synchronized (leaseLock) {
            if (leaseGuid == null) return;
            cancelGraceLocked();
            leaseGraceRunnable = () -> {
                synchronized (leaseLock) { leaseGuid = null; leaseGraceRunnable = null; }
                Log.i(TAG, "lease grace expired — device freed");
            };
            leaseHandler.postDelayed(leaseGraceRunnable, LEASE_GRACE_MS);
        }
    }

    /** Cancel a pending grace timer. MUST be called while holding leaseLock. */
    private void cancelGraceLocked() {
        if (leaseGraceRunnable != null) { leaseHandler.removeCallbacks(leaseGraceRunnable); leaseGraceRunnable = null; }
    }

    private void writeControlReply(String id, JSONObject result) {
        try {
            JSONObject response = new JSONObject();
            response.put("id", id);
            response.put("result", result);
            byte[] data = (response.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (this) {
                if (clientOutput == null) return; // re-check under the lock (L13)
                clientOutput.write(data);
                clientOutput.flush();
            }
        } catch (Exception e) {
            Log.w(TAG, "control reply failed: " + e.getMessage());
        }
    }

    // --- Native Screenshot ---

    @PluginMethod
    public void captureScreen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                View rootView = getActivity().getWindow().getDecorView().getRootView();
                Bitmap bitmap = Bitmap.createBitmap(rootView.getWidth(), rootView.getHeight(), Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
                rootView.draw(canvas);
                resolveWithBitmap(call, bitmap);
            } catch (Exception e) {
                call.reject("Screenshot failed: " + e.getMessage());
            }
        });
    }

    private void resolveWithBitmap(PluginCall call, Bitmap bitmap) {
        try {
            int nativeWidth = bitmap.getWidth();
            int nativeHeight = bitmap.getHeight();

            // Resize to max 600px wide
            int maxWidth = 600;
            float scale = 1.0f;
            if (nativeWidth > maxWidth) {
                scale = (float) maxWidth / nativeWidth;
                int newW = maxWidth;
                int newH = (int) (nativeHeight * scale);
                Bitmap scaled = Bitmap.createScaledBitmap(bitmap, newW, newH, true);
                if (scaled != bitmap) bitmap.recycle(); // free the full-res source (~10MB) instead of leaving it for GC (P5)
                bitmap = scaled;
            }

            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 70, baos);
            String base64 = "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);

            JSObject result = new JSObject();
            result.put("image", base64);
            result.put("imageWidth", bitmap.getWidth());
            result.put("imageHeight", bitmap.getHeight());
            result.put("screenWidth", nativeWidth);
            result.put("screenHeight", nativeHeight);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Bitmap encode failed: " + e.getMessage());
        }
    }

    // --- Native Logs ---

    @PluginMethod
    public void getNativeLogs(PluginCall call) {
        int limit = call.getInt("limit", 50);
        int seconds = call.getInt("seconds", 60);
        String filter = call.getString("filter");  // optional text filter (case-insensitive)
        int pid = android.os.Process.myPid();
        String filterLower = filter != null ? filter.toLowerCase() : null;

        new Thread(() -> {
            try {
                // Read logcat for this process, limited to recent time window
                Process process = Runtime.getRuntime().exec(new String[]{
                    "logcat", "-d", "-v", "time", "--pid=" + pid, "-t", String.valueOf(seconds)
                });
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));

                java.util.List<String> lines = new java.util.ArrayList<>();
                String line;
                while ((line = reader.readLine()) != null) {
                    // Apply text filter
                    if (filterLower != null && !line.toLowerCase().contains(filterLower)) {
                        continue;
                    }
                    lines.add(line);
                }
                reader.close();

                // Return last N lines
                int start = Math.max(0, lines.size() - limit);
                org.json.JSONArray arr = new org.json.JSONArray();
                for (int i = start; i < lines.size(); i++) {
                    arr.put(lines.get(i));
                }

                JSObject result = new JSObject();
                result.put("logs", arr);
                call.resolve(result);
            } catch (Exception e) {
                JSObject result = new JSObject();
                result.put("logs", new org.json.JSONArray());
                result.put("error", e.getMessage());
                call.resolve(result);
            }
        }).start();
    }

    // --- TCP Client Handling ---

    private void handleNewClient(Socket socket) {
        String remote = socket.getInetAddress().getHostAddress();

        // FIRST-WINS (matches iOS): keep the connected client and refuse a competing one, instead
        // of the old last-wins (close old, accept new) which KICKED the owner's socket and — with
        // the lease's auto-reconnect — caused a reconnect storm between two contending Modokis.
        // `clientOutput` is the live-client flag: the read thread's finally nulls it on drop, so a
        // reconnecting owner (or a new client after the owner left) is accepted then.
        synchronized (this) {
            if (clientOutput != null) {
                Log.i(TAG, "refusing extra client " + remote + " — one already connected");
                try { socket.close(); } catch (Exception ignored) {}
                return;
            }
            try {
                clientOutput = socket.getOutputStream();
            } catch (Exception e) {
                Log.e(TAG, "Failed to get output stream: " + e.getMessage());
                try { socket.close(); } catch (Exception ignored) {}
                return;
            }
            clientSocket = socket;
        }
        Log.i(TAG, "Client connected: " + remote);

        // Notify JS
        JSObject data = new JSObject();
        data.put("connected", true);
        data.put("remoteAddress", remote);
        notifyListeners("connectionChanged", data);

        // Start reading
        readThread = new Thread(() -> {
            try {
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while ((line = reader.readLine()) != null) {
                    processMessage(line);
                }
            } catch (Exception e) {
                if (running) Log.i(TAG, "Client disconnected: " + e.getMessage());
            } finally {
                // Clear under the same lock as handleNewClient, and ONLY if this socket is still the
                // active client — a slow read thread ending after a new client was already accepted
                // must not null the newer client's stream (L13; mirrors iOS `clientConnection === connection`).
                synchronized (this) {
                    if (clientSocket == socket) { clientOutput = null; clientSocket = null; }
                }
                // Hold the lease through the grace window so an auto-reconnect with the same guid
                // resumes it (game relaunch / WiFi blip) rather than freeing instantly.
                startLeaseGrace();
                JSObject disc = new JSObject();
                disc.put("connected", false);
                notifyListeners("connectionChanged", disc);
            }
        });
        readThread.setDaemon(true);
        readThread.start();
    }

    private void processMessage(String line) {
        try {
            JSONObject json = new JSONObject(line);
            String id = json.getString("id");
            String method = json.getString("method");

            // Lease control messages are answered NATIVELY (never relayed to JS).
            if ("connect".equals(method) || "ping".equals(method) || "disconnect".equals(method)) {
                String guid = json.has("params") ? json.getJSONObject("params").optString("guid", "") : "";
                writeControlReply(id, evaluateLease(method, guid));
                return;
            }

            String params = json.has("params") ? json.getJSONObject("params").toString() : "{}";

            JSObject data = new JSObject();
            data.put("id", id);
            data.put("method", method);
            data.put("params", params);
            notifyListeners("request", data);
        } catch (Exception e) {
            Log.w(TAG, "Invalid message: " + e.getMessage());
        }
    }

    // --- Fault triggers (#278) ---

    /** How long `anr` blocks the main looper.
     *
     *  Sized by what makes the ANR REPORTABLE, not by what makes the system notice it. Measured on
     *  an S22 (2026-08-20): the system declared the ANR ~11 s in either way, but a 15 s block ended
     *  on its own, the app recovered, no {@code ApplicationExitInfo} record was written, and
     *  Crashlytics — with {@code collect_anrs: true} — had nothing to collect. The report only
     *  exists if the PROCESS DIES of the ANR, which needs the "Close app" button in the system
     *  dialog. 45 s leaves that dialog on screen long enough to press; pressing it kills the
     *  process immediately, so the rest of the block costs nothing. */
    private static final long DEFAULT_ANR_BLOCK_MS = 45000;

    /** Small delay between resolving the JS call and raising the fault. The resolve has to marshal
     *  back across the bridge before the process dies, or the caller sees a promise that neither
     *  settles nor errors and cannot tell "refused" from "worked". It is a best effort, not a
     *  guarantee — see the note on {@code triggerFault} in definitions.ts. */
    private static final long FAULT_DELAY_MS = 250;

    private final Handler faultHandler = new Handler(Looper.getMainLooper());

    /** Raise a deliberate native fault so the crash pipeline can be proven (#278).
     *
     *  Behind the SAME {@code build.debugBuild} gate as the debug bridge, for the same reason: this
     *  kills the app on demand, and a release build must not carry a reachable way to do that.
     *
     *  Each kind is a DIFFERENT route into the crash reporter, which is the whole point — a signal
     *  crash, an uncaught Java exception and an ANR are three separate pipelines, and proving one
     *  says nothing about the other two. */
    @PluginMethod
    public void triggerFault(PluginCall call) {
        if (!isDebugBuildEnabled()) {
            call.reject("Fault triggers disabled: build.debugBuild is off for this project "
                    + "(Project Settings → Developer → \"Debug build\"). Rebuild after enabling it.");
            return;
        }

        String kind = call.getString("kind", "");
        switch (kind) {
            case "crash": {
                Log.w(TAG, "triggerFault: raising SIGSEGV on purpose (#278)");
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
                // A signal kills the process wherever it is raised, so the thread does not matter
                // here — `faultHandler` is the main looper, like every other kind. The delay, not
                // the thread, is the load-bearing part: it lets the resolve above marshal back
                // across the bridge first.
                faultHandler.postDelayed(
                        () -> android.os.Process.sendSignal(android.os.Process.myPid(), 11), FAULT_DELAY_MS);
                return;
            }
            case "uncaught": {
                Log.w(TAG, "triggerFault: throwing an uncaught RuntimeException on the UI thread (#278)");
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
                faultHandler.postDelayed(() -> {
                    throw new RuntimeException("[modoki] deliberate fault probe: uncaught RuntimeException (#278)");
                }, FAULT_DELAY_MS);
                return;
            }
            case "anr": {
                final long blockMs = call.getInt("blockMs", (int) DEFAULT_ANR_BLOCK_MS);
                Log.w(TAG, "triggerFault: blocking the main looper for " + blockMs + "ms (#278) — "
                        + "TAP THE SCREEN to raise it, then choose \"Close app\" — a block that ends on its own is never reported");
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
                faultHandler.postDelayed(() -> {
                    // The real main looper, not the WebView renderer's thread — that renderer lives in
                    // a separate sandboxed process, which is why blocking JS raises nothing at all.
                    long until = android.os.SystemClock.uptimeMillis() + blockMs;
                    while (android.os.SystemClock.uptimeMillis() < until) {
                        try {
                            Thread.sleep(50);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            return;
                        }
                    }
                    Log.w(TAG, "triggerFault: main-looper block finished (#278)");
                }, FAULT_DELAY_MS);
                return;
            }
            default:
                call.reject("Unknown fault kind \"" + kind + "\" — expected one of: crash, anr, uncaught.");
        }
    }

    // --- Cleanup ---

    private void stopAll() {
        running = false;
        if (clientSocket != null) { try { clientSocket.close(); } catch (Exception ignored) {} clientSocket = null; }
        if (serverSocket != null) { try { serverSocket.close(); } catch (Exception ignored) {} serverSocket = null; }
        clientOutput = null;
        synchronized (leaseLock) { cancelGraceLocked(); leaseGuid = null; }
        Log.i(TAG, "Server stopped");
    }

    @Override
    protected void handleOnDestroy() {
        stopAll();
    }
}
