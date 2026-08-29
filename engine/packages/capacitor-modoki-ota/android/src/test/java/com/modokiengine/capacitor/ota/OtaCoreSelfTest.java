package com.modokiengine.capacitor.ota;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Golden-vector parity check for the OTA boot-watchdog state machine — the Java-side twin
 * of OtaCoreTests.swift, both replaying test-vectors/ota-golden-vectors.json.
 *
 * Runs on a plain JVM: `javac *.java && java OtaCoreSelfTest` — no Gradle, no Android SDK,
 * no device/emulator required (a real `./gradlew test` run through the Android Gradle
 * Plugin is still the eventual CI path once this plugin has a full Android project
 * scaffolded around it; this file only needs java.* + MinimalJson, both test-only).
 */
public final class OtaCoreSelfTest {
  private static int failures = 0;

  /** Both vector files, replayed by the same assertions — must match OtaCoreTests.swift's
   *  `vectorFiles` exactly, or the two platforms stop being held to the same spec. */
  private static final String[] VECTOR_FILES = {
    "test-vectors/ota-golden-vectors.json",
    "test-vectors/ota-gate-vectors-phase3.json",
  };

  public static void main(String[] args) throws Exception {
    // Default resolves from the package root (engine/packages/capacitor-modoki-ota), which
    // is the cwd docs/ota-updates.md's documented run command uses. Pass a dir to override.
    Path root = Paths.get(args.length > 0 ? args[0] : ".");
    int total = 0;
    for (String file : VECTOR_FILES) {
      String json = new String(Files.readAllBytes(root.resolve(file)));
      @SuppressWarnings("unchecked")
      Map<String, Object> parsed = (Map<String, Object>) MinimalJson.parse(json);
      checkConstants(file, parsed);
      @SuppressWarnings("unchecked")
      List<Object> scenarios = (List<Object>) parsed.get("scenarios");
      // PER FILE, not over the total: with two vector files, emptying one still left the total
      // positive and both replays reported green — measured, on the first version of this check.
      if (scenarios == null || scenarios.isEmpty()) {
        System.err.println("no scenarios in " + file + " — this self-test would check nothing");
        System.exit(1);
      }
      for (Object rawObj : scenarios) {
        @SuppressWarnings("unchecked")
        Map<String, Object> raw = (Map<String, Object>) rawObj;
        runScenario(raw);
      }
      total += scenarios.size();
    }

    if (failures > 0) {
      System.err.println(failures + " scenario(s) FAILED");
      System.exit(1);
    }
    System.out.println("All " + total + " OTA golden-vector scenarios passed.");
  }

  /** The vector files declare `constants`, and until this was added NOTHING read them: the fixture
   *  could say maxAttempts:4 while both implementations used 3, and all 27 scenarios still passed
   *  (measured, 2026-08-27). Twin of OtaCoreTests.testFixtureConstantsMatchImplementation. */
  private static void checkConstants(String file, Map<String, Object> parsed) {
    Object raw = parsed.get("constants");
    if (!(raw instanceof Map)) return;
    @SuppressWarnings("unchecked")
    Map<String, Object> constants = (Map<String, Object>) raw;
    expectConstant(file, "maxAttempts", constants, OtaCore.MAX_ATTEMPTS);
    expectConstant(file, "requiredConfirms", constants, OtaCore.REQUIRED_CONFIRMS);
  }

  private static void expectConstant(String file, String key, Map<String, Object> constants, int actual) {
    Object v = constants.get(key);
    if (!(v instanceof Number)) return;
    int expected = ((Number) v).intValue();
    if (expected != actual) {
      failures++;
      System.err.println("FAIL " + file + " constants." + key + ": fixture=" + expected + " impl=" + actual);
    }
  }

  private static void runScenario(Map<String, Object> raw) {
    String name = (String) raw.get("name");
    String op = (String) raw.get("op");
    String bundle = (String) raw.get("bundle");
    @SuppressWarnings("unchecked")
    Map<String, Object> expect = (Map<String, Object>) raw.get("expect");

    Object stateRaw = raw.get("state");
    OtaCore.State state;
    if (stateRaw == null) {
      state = null;
    } else if ("CORRUPT_JSON_MARKER".equals(stateRaw)) {
      // Not a real State — signal "unparseable" by testing OtaCore's own contract that a
      // null State input behaves exactly like corrupt JSON (the native glue is responsible
      // for turning a failed JSON parse into null before calling boot()/confirm() — that
      // parse-failure behaviour itself is asserted directly in OtaCoreTests.swift via
      // OtaCore.parseState; here we only need to confirm the pure functions treat null
      // correctly, which the "fresh_install_no_state" vector already covers identically).
      state = null;
    } else {
      @SuppressWarnings("unchecked")
      Map<String, Object> stateObj = (Map<String, Object>) stateRaw;
      state = stateFromJson(stateObj);
    }

    @SuppressWarnings("unchecked")
    Map<String, Boolean> folderExistsMap = new HashMap<>();
    Object feRaw = raw.get("folderExists");
    if (feRaw != null) {
      @SuppressWarnings("unchecked")
      Map<String, Object> feObj = (Map<String, Object>) feRaw;
      for (Map.Entry<String, Object> e : feObj.entrySet()) folderExistsMap.put(e.getKey(), (Boolean) e.getValue());
    }
    OtaCore.FolderExists folderExists = (n, v) -> Boolean.TRUE.equals(folderExistsMap.get(n + "/" + v));

    if ("boot".equals(op)) {
      OtaCore.BootResult result = OtaCore.boot(state, bundle, folderExists);
      @SuppressWarnings("unchecked")
      Map<String, Object> expectTarget = (Map<String, Object>) expect.get("target");
      String kind = (String) expectTarget.get("kind");
      OtaCore.Target expected = "embedded".equals(kind)
        ? OtaCore.Target.embedded()
        : OtaCore.Target.version((String) expectTarget.get("name"), (String) expectTarget.get("version"));
      check(name, "target", expected, result.target);
      checkState(name, expect.get("state"), result.state);
    } else if ("confirm".equals(op)) {
      OtaCore.State result = OtaCore.confirm(state, bundle);
      checkState(name, expect.get("state"), result);
    } else if ("resetForNewBinary".equals(op)) {
      String currentBinaryVersion = (String) raw.get("currentBinaryVersion");
      OtaCore.State result = OtaCore.resetForNewBinary(state, currentBinaryVersion);
      checkState(name, expect.get("state"), result);
    } else {
      throw new RuntimeException("unknown op " + op);
    }
  }

  @SuppressWarnings("unchecked")
  private static OtaCore.State stateFromJson(Map<String, Object> obj) {
    Map<String, String> active = stringMap((Map<String, Object>) obj.getOrDefault("active", new HashMap<>()));
    Map<String, String> pending = stringMap((Map<String, Object>) obj.getOrDefault("pending", new HashMap<>()));
    Map<String, Integer> bootAttempts = intMap((Map<String, Object>) obj.getOrDefault("bootAttempts", new HashMap<>()));
    Map<String, Integer> confirmedBoots = intMap((Map<String, Object>) obj.getOrDefault("confirmedBoots", new HashMap<>()));
    Map<String, List<String>> rejected = stringListMap((Map<String, Object>) obj.getOrDefault("rejected", new HashMap<>()));
    String lastSeenBinaryVersion = (String) obj.get("lastSeenBinaryVersion");
    return new OtaCore.State(active, pending, bootAttempts, confirmedBoots, rejected, lastSeenBinaryVersion);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, List<String>> stringListMap(Map<String, Object> raw) {
    Map<String, List<String>> out = new HashMap<>();
    for (Map.Entry<String, Object> e : raw.entrySet()) {
      List<String> list = new java.util.ArrayList<>();
      for (Object v : (List<Object>) e.getValue()) list.add((String) v);
      out.put(e.getKey(), list);
    }
    return out;
  }

  private static Map<String, String> stringMap(Map<String, Object> raw) {
    Map<String, String> out = new HashMap<>();
    for (Map.Entry<String, Object> e : raw.entrySet()) out.put(e.getKey(), (String) e.getValue());
    return out;
  }

  private static Map<String, Integer> intMap(Map<String, Object> raw) {
    Map<String, Integer> out = new HashMap<>();
    for (Map.Entry<String, Object> e : raw.entrySet()) out.put(e.getKey(), ((Number) e.getValue()).intValue());
    return out;
  }

  private static void checkState(String scenarioName, Object expectStateRaw, OtaCore.State actual) {
    if (expectStateRaw == null) {
      check(scenarioName, "state", null, actual);
      return;
    }
    @SuppressWarnings("unchecked")
    OtaCore.State expected = stateFromJson((Map<String, Object>) expectStateRaw);
    check(scenarioName, "state", expected, actual);
  }

  private static void check(String scenarioName, String field, Object expected, Object actual) {
    boolean ok = expected == null ? actual == null : expected.equals(actual);
    if (!ok) {
      failures++;
      System.err.println("[" + scenarioName + "] " + field + " mismatch:\n  expected: " + expected + "\n  actual:   " + actual);
    }
  }
}
