package com.modokiengine.capacitor.ota;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * OTA update Capacitor plugin (docs/plans/mobile-ota-updates-plan.md, Phase 1).
 *
 * DEVICE-UNVERIFIED — written against Capacitor 8's actual Bridge.java source (read
 * directly, not guessed) but never built/run on a device or emulator. Verify on a real
 * Android device per the plan doc's Phase 1 gate before shipping.
 *
 * Integrates with Capacitor's OWN existing live-update mechanism (SharedPreferences file
 * "CapWebViewSettings", key "serverBasePath", read in Bridge.loadWebView() — see
 * Bridge.java:293-304 — gated on `!isDeployDisabled() && !isNewBinary()`, the same
 * "skip stale OTA content right after a real Play Store update" safety net iOS has).
 * Unlike iOS, Android's persisted value is a FULL absolute path (verified with
 * `new File(path).exists()`), not a fixed-base-dir + last-path-component convention — so
 * bundle version folders can live anywhere under the app's files dir, unlike iOS.
 *
 * Unzip uses java.util.zip (standard JDK — no custom ZIP-format parser needed here, unlike
 * iOS where Compression framework only does raw deflate, not the ZIP container format).
 */
@CapacitorPlugin(name = "ModokiOta")
public class OtaPlugin extends Plugin {
  /** The one-and-only bundle name Phase 1 drives — see OtaPlugin.swift's counterpart doc. */
  public static final String SHELL_BUNDLE_NAME = "shell";

  private static final String PREFS_NAME = "CapWebViewSettings"; // Capacitor's own prefs file
  private static final String PREFS_KEY_SERVER_PATH = "serverBasePath"; // Capacitor's own key

  @PluginMethod
  public void stageUpdate(PluginCall call) {
    String name = call.getString("name");
    String version = call.getString("version");
    String zipUrl = call.getString("zipUrl");
    String expectedHash = call.getString("expectedZipHash");
    if (name == null || version == null || zipUrl == null || expectedHash == null) {
      call.reject("stageUpdate requires name, version, zipUrl, expectedZipHash");
      return;
    }

    new Thread(() -> {
      File tmpDir = null;
      try {
        byte[] zipBytes = download(zipUrl);
        String actualHash = sha256Hex(zipBytes);
        if (!actualHash.equalsIgnoreCase(expectedHash)) {
          call.reject("hash mismatch: expected " + expectedHash + ", got " + actualHash);
          return;
        }

        tmpDir = new File(versionsDir(getContext()), ".tmp-" + name + "-" + version + "-" + UUID.randomUUID());
        unzipInto(zipBytes, tmpDir);

        File finalDir = versionDir(getContext(), name, version);
        deleteRecursively(finalDir); // a stale partial from an earlier interrupted attempt
        if (!tmpDir.renameTo(finalDir)) { // atomic on the same volume (both under versionsDir)
          throw new IOException("rename to final version dir failed");
        }

        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
      } catch (Exception e) {
        if (tmpDir != null) deleteRecursively(tmpDir);
        call.reject("stageUpdate failed: " + e.getMessage(), e);
      }
    }).start();
  }

  @PluginMethod
  public void activate(PluginCall call) {
    String name = call.getString("name");
    String version = call.getString("version");
    if (name == null || version == null) {
      call.reject("activate requires name, version");
      return;
    }
    try {
      OtaCore.State state = readState(getContext());
      if (state == null) state = new OtaCore.State();
      state.pending.put(name, version);
      state.bootAttempts.remove(name);
      state.confirmedBoots.remove(name);
      writeState(getContext(), state);
      JSObject ret = new JSObject();
      ret.put("ok", true);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("activate failed: " + e.getMessage(), e);
    }
  }

  @PluginMethod
  public void confirmBoot(PluginCall call) {
    String name = call.getString("name");
    if (name == null) {
      call.reject("confirmBoot requires name");
      return;
    }
    try {
      OtaCore.State state = OtaCore.confirm(readState(getContext()), name);
      writeState(getContext(), state != null ? state : new OtaCore.State());
      JSObject ret = new JSObject();
      ret.put("ok", true);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("confirmBoot failed: " + e.getMessage(), e);
    }
  }

  @PluginMethod
  public void getState(PluginCall call) {
    try {
      JSObject ret = new JSObject();
      ret.put("stateJSON", stateToJson(readState(getContext())));
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("getState failed: " + e.getMessage(), e);
    }
  }

  // ---- Boot hook — call from the game's MainActivity.onCreate() BEFORE super.onCreate(),
  // exactly like MyViewController.instanceDescriptor() on iOS (see OtaPlugin.swift). Not
  // yet wired into any actual MainActivity.java — see the plan doc's Phase 1 status. ----

  public static void runBootHook(Context context, String name) {
    OtaCore.State state = readState(context);
    OtaCore.FolderExists folderExists = (n, v) -> {
      File dir = versionDir(context, n, v);
      return dir.isDirectory() && new File(dir, "index.html").exists();
    };
    OtaCore.BootResult result = OtaCore.boot(state, name, folderExists);
    writeState(context, result.state != null ? result.state : new OtaCore.State());

    SharedPreferences.Editor editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
    if (result.target.kind == OtaCore.TargetKind.EMBEDDED) {
      editor.remove(PREFS_KEY_SERVER_PATH);
    } else {
      editor.putString(PREFS_KEY_SERVER_PATH, versionDir(context, result.target.name, result.target.version).getAbsolutePath());
    }
    editor.apply();
  }

  // ---- File layout ----

  private static File versionsDir(Context context) {
    File dir = new File(context.getFilesDir(), "modoki-ota/versions");
    dir.mkdirs();
    return dir;
  }

  private static File versionDir(Context context, String name, String version) {
    return new File(versionsDir(context), name + "-" + version);
  }

  private static File stateFile(Context context) {
    File dir = new File(context.getFilesDir(), "modoki-ota");
    dir.mkdirs(); // first-launch: nothing has created this dir yet — writeState's
    // FileOutputStream on the ".tmp" sibling throws FileNotFoundException (ENOENT)
    // without it (caught on a real device, not on the plain-JVM golden-vector harness,
    // which never touches a real filesystem path like this).
    return new File(dir, "state.json");
  }

  // ---- State I/O (org.json — part of the Android platform SDK; the CROSS-PLATFORM,
  // testable-on-plain-JVM logic lives in OtaCore.java + the golden vectors, not here) ----

  private static OtaCore.State readState(Context context) {
    File f = stateFile(context);
    if (!f.exists()) return null;
    try {
      String json = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
      return jsonToState(json);
    } catch (Exception e) {
      return null; // corrupt/unreadable state.json is treated exactly like "no state" — see OtaCore
    }
  }

  private static void writeState(Context context, OtaCore.State state) {
    File f = stateFile(context);
    File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
    try (FileOutputStream out = new FileOutputStream(tmp)) {
      out.write(stateToJson(state).getBytes(StandardCharsets.UTF_8));
      out.getFD().sync(); // durable — this is exactly the write PlayerPrefs' debounced,
      // non-fsync'd Android backend can't provide (see the plan doc's rationale for why
      // OTA state is NOT stored in PlayerPrefs).
    } catch (IOException e) {
      throw new RuntimeException(e);
    }
    if (!tmp.renameTo(f)) throw new RuntimeException("state.json rename failed");
  }

  private static String stateToJson(OtaCore.State state) {
    try {
      JSONObject obj = new JSONObject();
      obj.put("active", new JSONObject(state.active));
      obj.put("pending", new JSONObject(state.pending));
      obj.put("bootAttempts", new JSONObject(state.bootAttempts));
      obj.put("confirmedBoots", new JSONObject(state.confirmedBoots));
      return obj.toString();
    } catch (JSONException e) {
      throw new RuntimeException(e);
    }
  }

  private static OtaCore.State jsonToState(String json) throws JSONException {
    JSONObject obj = new JSONObject(json);
    return new OtaCore.State(
      stringMap(obj.optJSONObject("active")),
      stringMap(obj.optJSONObject("pending")),
      intMap(obj.optJSONObject("bootAttempts")),
      intMap(obj.optJSONObject("confirmedBoots"))
    );
  }

  private static Map<String, String> stringMap(JSONObject obj) throws JSONException {
    Map<String, String> out = new HashMap<>();
    if (obj == null) return out;
    java.util.Iterator<String> keys = obj.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      out.put(k, obj.getString(k));
    }
    return out;
  }

  private static Map<String, Integer> intMap(JSONObject obj) throws JSONException {
    Map<String, Integer> out = new HashMap<>();
    if (obj == null) return out;
    java.util.Iterator<String> keys = obj.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      out.put(k, obj.getInt(k));
    }
    return out;
  }

  // ---- Download / hash / unzip ----

  private static byte[] download(String urlString) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) new URL(urlString).openConnection();
    try {
      conn.setRequestMethod("GET");
      conn.setConnectTimeout(30_000);
      conn.setReadTimeout(60_000);
      if (conn.getResponseCode() != 200) throw new IOException("HTTP " + conn.getResponseCode());
      try (InputStream in = conn.getInputStream()) {
        return readAll(in);
      }
    } finally {
      conn.disconnect();
    }
  }

  private static byte[] readAll(InputStream in) throws IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buf = new byte[64 * 1024];
    int n;
    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
    return out.toByteArray();
  }

  private static String sha256Hex(byte[] data) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
    StringBuilder sb = new StringBuilder(digest.length * 2);
    for (byte b : digest) sb.append(String.format("%02x", b));
    return sb.toString();
  }

  private static void unzipInto(byte[] zipBytes, File destDir) throws IOException {
    destDir.mkdirs();
    try (ZipInputStream zis = new ZipInputStream(new java.io.ByteArrayInputStream(zipBytes))) {
      ZipEntry entry;
      while ((entry = zis.getNextEntry()) != null) {
        File outFile = new File(destDir, entry.getName());
        // Zip-slip guard: an entry name must never escape destDir via "../" traversal.
        // ota-publish.mjs never emits such a path, but this content still travels over
        // the network, so defend against it here rather than trusting the source.
        if (!outFile.getCanonicalPath().startsWith(destDir.getCanonicalPath() + File.separator)) {
          throw new IOException("zip entry escapes destination: " + entry.getName());
        }
        outFile.getParentFile().mkdirs();
        try (OutputStream out = new FileOutputStream(outFile)) {
          byte[] buf = new byte[64 * 1024];
          int n;
          while ((n = zis.read(buf)) != -1) out.write(buf, 0, n);
        }
        zis.closeEntry();
      }
    }
  }

  private static void deleteRecursively(File f) {
    if (f == null || !f.exists()) return;
    File[] children = f.listFiles();
    if (children != null) for (File c : children) deleteRecursively(c);
    f.delete();
  }
}
