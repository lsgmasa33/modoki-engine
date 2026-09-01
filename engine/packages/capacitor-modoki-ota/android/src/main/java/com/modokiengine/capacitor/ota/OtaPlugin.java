package com.modokiengine.capacitor.ota;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import com.getcapacitor.JSArray;
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
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * OTA update Capacitor plugin (docs/ota-updates.md).
 *
 * DEVICE-VERIFIED on a real Samsung (2026-07-24/25): stage → promote → revert →
 * fix-forward, delta staging from both bases, and the `rejected` quarantine path. Written
 * against Capacitor 8's actual Bridge.java source, read directly rather than guessed.
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

  /** Guards every state.json read-MODIFY-write sequence (activate/confirmBoot/
   *  runBootHook). Each individual write is already atomic (tmp file + rename in
   *  writeState below), but that alone doesn't stop a LOST UPDATE: two concurrent
   *  callers can both read the same old state, then both write their own modified
   *  copy — the second write silently clobbers the first's change. OTA Phase 4 made
   *  this a real, not just theoretical, bug: the shell's own confirmBoot and a
   *  sub-game's confirmBoot can now fire close together in the same boot, and one's
   *  confirmedBoots increment was observed lost on a real device (see
   *  docs/plans/mobile-ota-updates-plan.md). A single static monitor serializes every
   *  mutation within this process — the only writer of this file — which is all that's
   *  needed (no cross-process access to guard against). */
  private static final Object STATE_LOCK = new Object();

  @PluginMethod
  public void stageUpdate(PluginCall call) {
    String name = call.getString("name");
    String version = call.getString("version");
    String zipUrl = call.getString("zipUrl");
    String expectedHash = call.getString("expectedZipHash");
    Integer expectedSize = call.getInt("expectedZipSize"); // may be null on an older caller
    if (name == null || version == null || zipUrl == null || expectedHash == null) {
      call.reject("stageUpdate requires name, version, zipUrl, expectedZipHash");
      return;
    }
    final long bytesTotal = expectedSize != null ? expectedSize : 0;

    new Thread(() -> {
      File tmpDir = null;
      try {
        long[] bytesDone = {0};
        byte[] zipBytes = download(zipUrl, n -> {
          bytesDone[0] += n;
          emitProgress(name, version, bytesDone[0], bytesTotal, 0, 1);
        });
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
        emitProgress(name, version, zipBytes.length, Math.max(bytesTotal, zipBytes.length), 1, 1);

        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
      } catch (Exception e) {
        if (tmpDir != null) deleteRecursively(tmpDir);
        call.reject("stageUpdate failed: " + e.getMessage(), e);
      }
    }).start();
  }

  /**
   * Phase 2 delta staging (docs/ota-updates.md) — builds the `version`
   * folder WITHOUT downloading a whole-bundle zip: copies `copy` (unchanged relative
   * paths, byte-for-byte) from `baseVersion`'s already-on-disk folder — OR, when
   * `baseVersion` is the sentinel "embedded", from the app's OWN bundled APK assets.
   * Embedded content is NOT an ordinary filesystem File (unlike an OTA snapshot folder)
   * — it ships packed inside the APK and is only reachable via AssetManager streaming,
   * at the fixed prefix "public/" (Capacitor's own webDir convention, matching
   * Bridge.java's default asset path — see this class's header comment for the OTA
   * snapshot equivalent). Downloads only `download` (new/changed files), each
   * independently SHA-256-verified against its own hash before being written. Same
   * atomicity contract as stageUpdate: builds into a ".tmp" dir, only renamed into place
   * once every copy AND download has succeeded and verified.
   */
  @PluginMethod
  public void stageUpdateDelta(PluginCall call) {
    String name = call.getString("name");
    String version = call.getString("version");
    String baseVersion = call.getString("baseVersion");
    JSArray copyArray = call.getArray("copy");
    JSArray downloadArray = call.getArray("download");
    if (name == null || version == null || baseVersion == null || copyArray == null) {
      call.reject("stageUpdateDelta requires name, version, baseVersion, copy");
      return;
    }

    new Thread(() -> {
      File tmpDir = null;
      try {
        List<String> copyPaths = copyArray.toList();
        final int filesTotal = copyPaths.size() + (downloadArray != null ? downloadArray.length() : 0);
        int[] filesDone = {0};
        long bytesTotalSum = 0;
        if (downloadArray != null) {
          for (int i = 0; i < downloadArray.length(); i++) bytesTotalSum += downloadArray.getJSONObject(i).optLong("size", 0);
        }
        final long bytesTotal = bytesTotalSum; // effectively-final copy for the lambdas below
        long[] bytesDone = {0};
        Log.d(
          "ModokiOta",
          "stageUpdateDelta " + name + "@" + version + " from " + baseVersion +
          ": copy=" + copyPaths.size() + " download=" + (downloadArray != null ? downloadArray.length() : 0)
        );
        boolean fromEmbedded = "embedded".equals(baseVersion);
        File baseDir = fromEmbedded ? null : versionDir(getContext(), name, baseVersion);
        if (!fromEmbedded && !baseDir.isDirectory()) {
          throw new IOException("stageUpdateDelta: base version folder not found: " + baseDir);
        }

        tmpDir = new File(versionsDir(getContext()), ".tmp-" + name + "-" + version + "-" + UUID.randomUUID());
        tmpDir.mkdirs();

        // Copies are already on disk (no network), so they only move filesDone — bytesTotal
        // above deliberately counts ONLY the download[] entries (the ones with a known
        // size), matching the plan's "byte-granularity needs the download loop" scope.
        for (String relPath : copyPaths) {
          File dst = new File(tmpDir, relPath);
          dst.getParentFile().mkdirs();
          if (fromEmbedded) {
            try (
              InputStream in = getContext().getAssets().open("public/" + relPath);
              OutputStream out = new FileOutputStream(dst)
            ) {
              byte[] buf = new byte[64 * 1024];
              int n;
              while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
          } else {
            File src = new File(baseDir, relPath);
            if (!src.isFile()) throw new IOException("delta copy source missing: " + relPath);
            Files.copy(src.toPath(), dst.toPath(), StandardCopyOption.REPLACE_EXISTING);
          }
          filesDone[0]++;
          emitProgress(name, version, bytesDone[0], bytesTotal, filesDone[0], filesTotal);
        }

        if (downloadArray != null) {
          for (int i = 0; i < downloadArray.length(); i++) {
            JSONObject entry = downloadArray.getJSONObject(i);
            String path = entry.getString("path");
            String url = entry.getString("url");
            String expectedHash = entry.getString("hash");
            final long baseDone = bytesDone[0];
            byte[] bytes = download(url, n -> emitProgress(name, version, baseDone + n, bytesTotal, filesDone[0], filesTotal));
            String actualHash = sha256Hex(bytes);
            if (!actualHash.equalsIgnoreCase(expectedHash)) {
              throw new IOException("hash mismatch: " + path + " expected " + expectedHash + ", got " + actualHash);
            }
            File dst = new File(tmpDir, path);
            dst.getParentFile().mkdirs();
            try (FileOutputStream out = new FileOutputStream(dst)) {
              out.write(bytes);
            }
            bytesDone[0] += bytes.length;
            filesDone[0]++;
            emitProgress(name, version, bytesDone[0], bytesTotal, filesDone[0], filesTotal);
          }
        }

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
        call.reject("stageUpdateDelta failed: " + e.getMessage(), e);
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
      synchronized (STATE_LOCK) {
        OtaCore.State state = readState(getContext());
        if (state == null) state = new OtaCore.State();
        state.pending.put(name, version);
        state.bootAttempts.remove(name);
        state.confirmedBoots.remove(name);
        writeState(getContext(), state);
      }
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
      synchronized (STATE_LOCK) {
        // `version` is optional: the SHELL has none to name (its boot hook is the sole
        // authority over what got served), a sub-game always passes one. See OtaCore.confirm.
        OtaCore.State state = OtaCore.confirm(readState(getContext()), name, call.getString("version"));
        writeState(getContext(), state != null ? state : new OtaCore.State());
      }
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

  /**
   * OTA Phase 4 (docs/ota-subgame-modules.md) — every bundle with content actually on
   * disk. ⚠️ DISCOVERY ONLY: `active` is preferred over `pending` here, which is the
   * opposite of what loading needs — use beginBundleLoad to decide what to load (#553).
   * See the TS doc comment in definitions.ts.
   */
  @PluginMethod
  public void listBundles(PluginCall call) {
    try {
      OtaCore.State state = readState(getContext());
      JSArray bundles = new JSArray();
      java.util.Set<String> seen = new java.util.HashSet<>();
      if (state != null) {
        appendStagedBundles(bundles, seen, state.active);
        appendStagedBundles(bundles, seen, state.pending);
      }
      JSObject ret = new JSObject();
      ret.put("bundles", bundles);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("listBundles failed: " + e.getMessage(), e);
    }
  }

  /**
   * #553 — the sub-game counterpart of the shell's native boot hook. Decides which version
   * of `name` to load and COUNTS THE ATTEMPT before the caller loads anything, so a bundle
   * that takes the page down with it still burns an attempt and is eventually reverted.
   *
   * Uses the same OtaCore.boot() the shell does: `pending` is preferred over `active`, so
   * the version that loads is the version a subsequent confirmBoot promotes. listBundles()
   * orders them the other way and MUST NOT decide what to load — that is the #553 defect.
   */
  @PluginMethod
  public void beginBundleLoad(PluginCall call) {
    String name = call.getString("name");
    if (name == null) {
      call.reject("beginBundleLoad requires name");
      return;
    }
    try {
      OtaCore.BootResult result;
      synchronized (STATE_LOCK) {
        result = OtaCore.boot(readState(getContext()), name, subgameFolderExists());
        if (result.state != null) writeState(getContext(), result.state);
      }
      call.resolve(targetToJs(result.target));
    } catch (Exception e) {
      call.reject("beginBundleLoad failed: " + e.getMessage(), e);
    }
  }

  /**
   * #553/#550 — records what a failed load of a SPECIFIC version proves, and returns the
   * version to fall back to this launch. See OtaCore.LoadFailure for why the three
   * dispositions are not interchangeable severities.
   *
   * The returned fallback must never be confirmed by the caller — it is the version being
   * replaced, and crediting a confirm to it is the #553 defect itself.
   */
  @PluginMethod
  public void reportBundleLoadFailure(PluginCall call) {
    String name = call.getString("name");
    String version = call.getString("version");
    String dispositionRaw = call.getString("disposition");
    if (name == null || version == null) {
      call.reject("reportBundleLoadFailure requires name, version");
      return;
    }
    OtaCore.LoadFailure disposition;
    if ("fatal".equals(dispositionRaw)) disposition = OtaCore.LoadFailure.FATAL;
    else if ("transient".equals(dispositionRaw)) disposition = OtaCore.LoadFailure.TRANSIENT;
    else if ("notEvidence".equals(dispositionRaw)) disposition = OtaCore.LoadFailure.NOT_EVIDENCE;
    else {
      call.reject("reportBundleLoadFailure requires disposition of fatal|transient|notEvidence");
      return;
    }
    try {
      OtaCore.BootResult result;
      synchronized (STATE_LOCK) {
        result = OtaCore.loadFailed(readState(getContext()), name, version, disposition, subgameFolderExists());
        if (result.state != null) writeState(getContext(), result.state);
      }
      call.resolve(targetToJs(result.target));
    } catch (Exception e) {
      call.reject("reportBundleLoadFailure failed: " + e.getMessage(), e);
    }
  }

  /**
   * folderExists probe for a SUB-GAME bundle — deliberately NOT the one runBootHook uses.
   *
   * The shell's probe additionally requires index.html, because a shell bundle is what the
   * WebView serves. A sub-game bundle has no index.html at all — it is subgame.json +
   * subgame.js, script-loaded into the shell's already-running page. Reusing the shell's
   * predicate here would make EVERY sub-game look absent, and boot() answers an absent
   * pending folder with an immediate revert: every staged sub-game would be silently thrown
   * away on its first load. Same directory check listBundles uses.
   */
  private OtaCore.FolderExists subgameFolderExists() {
    final Context context = getContext();
    return (n, v) -> versionDir(context, n, v).isDirectory();
  }

  private JSObject targetToJs(OtaCore.Target target) {
    JSObject ret = new JSObject();
    if (target.kind == OtaCore.TargetKind.EMBEDDED) {
      // A sub-game has no embedded copy (it is script-loaded, never in the app binary), so
      // EMBEDDED means "nothing loadable for this name".
      ret.put("target", "none");
      return ret;
    }
    ret.put("target", "version");
    ret.put("name", target.name);
    ret.put("version", target.version);
    ret.put("path", versionDir(getContext(), target.name, target.version).getAbsolutePath());
    return ret;
  }

  private void appendStagedBundles(JSArray bundles, java.util.Set<String> seen, Map<String, String> versions) {
    for (Map.Entry<String, String> entry : versions.entrySet()) {
      String name = entry.getKey();
      String version = entry.getValue();
      if (seen.contains(name)) continue;
      File dir = versionDir(getContext(), name, version);
      if (!dir.isDirectory()) continue;
      JSObject bundle = new JSObject();
      bundle.put("name", name);
      bundle.put("version", version);
      bundle.put("path", dir.getAbsolutePath());
      bundles.put(bundle);
      seen.add(name);
    }
  }

  // ---- Boot hook — call from the game's MainActivity.onCreate() BEFORE super.onCreate(),
  // exactly like MyViewController.instanceDescriptor() on iOS (see OtaPlugin.swift). Not
  // live in games/ota-test's MainActivity.java — the real, shipped shape. ----

  public static void runBootHook(Context context, String name) {
    OtaCore.BootResult result;
    synchronized (STATE_LOCK) {
      OtaCore.State state = readState(context);
      // Detect a genuine Play Store update BEFORE deciding what to boot — see
      // OtaCore.resetForNewBinary's doc comment (OtaCore.swift) for why our own
      // bookkeeping needs this independently of Bridge.java's own isNewBinary() check
      // (which only decides what IT serves, not what OUR state.json still references).
      state = OtaCore.resetForNewBinary(state, currentBinaryVersion(context));
      OtaCore.FolderExists folderExists = (n, v) -> {
        File dir = versionDir(context, n, v);
        return dir.isDirectory() && new File(dir, "index.html").exists();
      };
      result = OtaCore.boot(state, name, folderExists);
      writeState(context, result.state != null ? result.state : new OtaCore.State());
    }

    SharedPreferences.Editor editor = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
    if (result.target.kind == OtaCore.TargetKind.EMBEDDED) {
      editor.remove(PREFS_KEY_SERVER_PATH);
    } else {
      editor.putString(PREFS_KEY_SERVER_PATH, versionDir(context, result.target.name, result.target.version).getAbsolutePath());
    }
    editor.apply();
  }

  /** The app-binary version `resetForNewBinary` compares against — same signal
   *  Bridge.java's own `isNewBinary()` uses (versionCode, not the human-readable
   *  versionName; the build number changes on every submission the marketing version
   *  doesn't have to). Falls back to a fixed sentinel if PackageManager somehow can't
   *  resolve the app's own package (should never happen in a real app) — never throws. */
  @SuppressWarnings("deprecation") // getLongVersionCode() needs API 28; minSdk here is 24
  private static String currentBinaryVersion(Context context) {
    try {
      PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
      return String.valueOf(info.versionCode);
    } catch (PackageManager.NameNotFoundException e) {
      return "unknown";
    }
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
      // non-fsync'd Android backend can't provide (see docs/ota-updates.md's rationale for why
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
      JSONObject rejected = new JSONObject();
      for (Map.Entry<String, java.util.List<String>> e : state.rejected.entrySet()) {
        rejected.put(e.getKey(), new org.json.JSONArray(e.getValue()));
      }
      obj.put("rejected", rejected);
      // Omit the key entirely when null (rather than writing JSON null) — matches how a
      // Phase 1/2-written state.json has no key at all; both read back as null below.
      if (state.lastSeenBinaryVersion != null) obj.put("lastSeenBinaryVersion", state.lastSeenBinaryVersion);
      return obj.toString();
    } catch (JSONException e) {
      throw new RuntimeException(e);
    }
  }

  private static OtaCore.State jsonToState(String json) throws JSONException {
    JSONObject obj = new JSONObject(json);
    String lastSeenBinaryVersion = obj.has("lastSeenBinaryVersion") && !obj.isNull("lastSeenBinaryVersion")
      ? obj.getString("lastSeenBinaryVersion") : null;
    return new OtaCore.State(
      stringMap(obj.optJSONObject("active")),
      stringMap(obj.optJSONObject("pending")),
      intMap(obj.optJSONObject("bootAttempts")),
      intMap(obj.optJSONObject("confirmedBoots")),
      stringListMap(obj.optJSONObject("rejected")),
      lastSeenBinaryVersion
    );
  }

  /** Absent (a state.json written by a Phase 1/2 binary) parses as empty, never throws. */
  private static Map<String, java.util.List<String>> stringListMap(JSONObject obj) throws JSONException {
    Map<String, java.util.List<String>> out = new HashMap<>();
    if (obj == null) return out;
    java.util.Iterator<String> keys = obj.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      org.json.JSONArray arr = obj.optJSONArray(k);
      java.util.List<String> list = new java.util.ArrayList<>();
      if (arr != null) for (int i = 0; i < arr.length(); i++) list.add(arr.getString(i));
      out.put(k, list);
    }
    return out;
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

  // ---- Progress events (Phase 3a — plumbing only, no UI consumes this yet) ----

  /** Emits `otaProgress` for the JS listener added via `ModokiOta.addListener`. Safe to
   *  call from the background staging thread — `Plugin.notifyListeners` marshals to the
   *  bridge internally. `bytesTotal: 0` means "genuinely unknown" (a copy-only delta, or
   *  a caller that didn't pass expectedZipSize) — the JS side must treat that as
   *  indeterminate progress, not "already done". */
  private void emitProgress(String name, String version, long bytesDone, long bytesTotal, int filesDone, int filesTotal) {
    JSObject data = new JSObject();
    data.put("name", name);
    data.put("version", version);
    data.put("bytesDone", bytesDone);
    data.put("bytesTotal", bytesTotal);
    data.put("filesDone", filesDone);
    data.put("filesTotal", filesTotal);
    notifyListeners("otaProgress", data);
  }

  /** Called once per chunk read off the network with the chunk's byte count — NOT a
   *  running total, so callers accumulate their own `bytesDone`. Kept chunk-granular
   *  (the existing 64KB read buffer) rather than time-throttled: OTA bundles are small
   *  enough (single-digit MB) that this is at most a few hundred bridge calls. */
  private interface ProgressCallback {
    void onChunk(int chunkBytes);
  }

  // ---- Download / hash / unzip ----

  private static byte[] download(String urlString, ProgressCallback progress) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) new URL(urlString).openConnection();
    try {
      conn.setRequestMethod("GET");
      conn.setConnectTimeout(30_000);
      conn.setReadTimeout(60_000);
      if (conn.getResponseCode() != 200) throw new IOException("HTTP " + conn.getResponseCode());
      try (InputStream in = conn.getInputStream()) {
        return readAll(in, progress);
      }
    } finally {
      conn.disconnect();
    }
  }

  private static byte[] readAll(InputStream in, ProgressCallback progress) throws IOException {
    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
    byte[] buf = new byte[64 * 1024];
    int n;
    while ((n = in.read(buf)) != -1) {
      out.write(buf, 0, n);
      if (progress != null) progress.onChunk(n);
    }
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
