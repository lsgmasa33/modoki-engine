package com.modokiengine.capacitor.iap;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

/**
 * Golden-vector parity check for purchase classification — the Java-side twin of
 * IapClassificationTests.swift, both replaying test-vectors/iap-classification-vectors.json (#971).
 *
 * <p>A {@code main()} that exits non-zero on a failed check, so it needs only {@code java.*} plus
 * the test-only MinimalJson and can run under a bare {@code javac}/{@code java} leg — no gradle, no
 * Android SDK, no device. That is possible only because {@link IapCore} imports nothing from
 * {@code com.android.billingclient} or {@code android.*}.
 *
 * <p>⚠️ It drives the SHIPPING {@link IapCore}, not a port of it living in this file. The one part
 * of IapCore's contract this cannot reach is the equality of {@code RESPONSE_USER_CANCELED} with
 * Play's own constant — that needs the billing library, and <b>nothing checks it</b>. A static
 * comparison in {@code ModokiIapPlugin} was tried and removed: javac folds both constants and the
 * shipped initializer was empty. See {@link IapCore#RESPONSE_USER_CANCELED}.
 */
public final class IapCoreSelfTest {

  private static final String VECTOR_FILE = "test-vectors/iap-classification-vectors.json";

  private static int failures = 0;

  private static void check(String what, Object expected, Object actual) {
    if (expected == null ? actual != null : !expected.equals(actual)) {
      System.err.println("FAIL " + what + ": expected <" + expected + "> got <" + actual + ">");
      failures++;
    }
  }

  public static void main(String[] args) throws Exception {
    // Resolves from the package root (engine/packages/capacitor-modoki-iap), which is the cwd
    // test-native.mjs runs this leg in. Pass a dir to override.
    Path root = Paths.get(args.length > 0 ? args[0] : ".");
    Path vectors = root.resolve(VECTOR_FILE);

    // ⚠️ Every assertion below iterates a vector array, so a file that failed to load would make
    // this self-test pass by checking nothing — the #565 shape. Fail loudly instead.
    if (!Files.exists(vectors)) {
      System.err.println("missing vector file " + vectors.toAbsolutePath()
          + " — this self-test would check nothing");
      System.exit(1);
    }

    String json = new String(Files.readAllBytes(vectors));
    @SuppressWarnings("unchecked")
    Map<String, Object> parsed = (Map<String, Object>) MinimalJson.parse(json);
    @SuppressWarnings("unchecked")
    Map<String, Object> android = (Map<String, Object>) parsed.get("android");
    if (android == null) {
      System.err.println("no `android` section in " + VECTOR_FILE);
      System.exit(1);
    }

    // Read the format version, so a bump cannot half-land across the three replays.
    check("vector format version", 1, ((Number) parsed.get("version")).intValue());

    // The shared constants — these are the strings the JS side matches on, so a drift here is a
    // silent cross-platform contract break (#946).
    check("IapCore.CANCEL_REASON", android.get("cancelReason"), IapCore.CANCEL_REASON);
    check("IapCore.REJECT_CODE_PREFIX", android.get("rejectCodePrefix"), IapCore.REJECT_CODE_PREFIX);

    @SuppressWarnings("unchecked")
    List<Object> cases = (List<Object>) android.get("classify");
    if (cases == null || cases.isEmpty()) {
      System.err.println("no android classify vectors in " + VECTOR_FILE
          + " — this self-test would check nothing");
      System.exit(1);
    }

    for (Object rawObj : cases) {
      @SuppressWarnings("unchecked")
      Map<String, Object> v = (Map<String, Object>) rawObj;
      String name = String.valueOf(v.get("name"));
      int code = ((Number) v.get("responseCode")).intValue();

      check("isCancellation(" + name + ")", v.get("cancel"), IapCore.isCancellation(code));

      // `rejectCode` is null for the cancel vector: a cancel RESOLVES with a cancelReason and
      // never reaches rejectWithBilling, so asserting a reject code there would pin a path that
      // does not exist.
      Object expectedReject = v.get("rejectCode");
      if (expectedReject != null) {
        check("rejectCode(" + name + ")", expectedReject, IapCore.rejectCode(code));
      }
    }

    if (failures > 0) {
      System.err.println(failures + " check(s) failed across " + cases.size() + " vector(s)");
      System.exit(1);
    }
    System.out.println("iap-core: " + cases.size() + " android vector(s) OK");
  }
}
