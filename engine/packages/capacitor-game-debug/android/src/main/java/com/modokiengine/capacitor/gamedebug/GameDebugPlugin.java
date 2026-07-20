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

    @PluginMethod
    public void startServer(PluginCall call) {
        // Only run in debug builds — no TCP server or network listener in release
        boolean isDebug = (getContext().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!isDebug) {
            call.reject("Debug bridge disabled in release builds");
            return;
        }

        if (running) {
            JSObject result = new JSObject();
            result.put("port", serverPort);
            call.resolve(result);
            return;
        }

        serverPort = call.getInt("port", DEFAULT_PORT);

        serverThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(serverPort);
                serverSocket.setReuseAddress(true);
                running = true;
                Log.i(TAG, "TCP server listening on port " + serverPort);

                while (running) {
                    try {
                        Socket socket = serverSocket.accept();
                        handleNewClient(socket);
                    } catch (Exception e) {
                        if (running) Log.w(TAG, "Accept error: " + e.getMessage());
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Server start failed: " + e.getMessage());
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();

        // No LAN discovery: connection is by MANUAL target through Modoki's lease (adb-forward
        // over USB, or the device IP over WiFi). NSD/Bonjour advertising + the UDP beacon were
        // removed — they broadcast the device on the LAN, which is exactly what let idle Claude
        // sessions auto-grab it. See docs/debug-tools-mcp.md.

        JSObject result = new JSObject();
        result.put("port", serverPort);
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
