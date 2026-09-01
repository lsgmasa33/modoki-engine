package com.modokiengine.capacitor.ota;

import java.util.HashMap;
import java.util.Map;

/**
 * Pure OTA boot-watchdog state machine (docs/ota-updates.md).
 *
 * java.* stdlib only — NO android.* import — so this class is testable on a plain JVM
 * (`javac`/`java`, no Gradle, no Android SDK, no device/emulator). The real plugin
 * (OtaPlugin.java, Android-only) is a thin wrapper that does actual file I/O and calls
 * into this pure logic; this file owns every DECISION, none of the I/O.
 *
 * This MUST behave identically to the Swift port (OtaCore.swift) — both are replayed
 * against the same shared spec: ../../../../../../test-vectors/ota-golden-vectors.json.
 * See OtaCore.swift's header comment for the design rationale (the adversarial-review
 * fixes: two-boot confirm, per-bundle-name maps, safe-fallback-to-embedded everywhere).
 */
public final class OtaCore {
  private OtaCore() {}

  /** See OtaCore.swift: a pending version gets this many attempts before revert — not 1. */
  public static final int MAX_ATTEMPTS = 3;
  /** See OtaCore.swift: promotion requires TWO separate successful boots — not 1. */
  public static final int REQUIRED_CONFIRMS = 2;
  /** See OtaCore.swift: FIFO cap on the per-bundle `rejected` quarantine list. */
  public static final int MAX_REJECTED_PER_BUNDLE = 10;

  public enum TargetKind { EMBEDDED, VERSION }

  /** See OtaCore.swift's OtaLoadFailure doc — same three claims, must behave identically.
   *  FATAL quarantines immediately (#550), TRANSIENT costs one attempt, NOT_EVIDENCE gives
   *  the attempt back and must never quarantine. */
  public enum LoadFailure { FATAL, TRANSIENT, NOT_EVIDENCE }

  public static final class Target {
    public final TargetKind kind;
    public final String name;
    public final String version;

    private Target(TargetKind kind, String name, String version) {
      this.kind = kind;
      this.name = name;
      this.version = version;
    }

    public static Target embedded() { return new Target(TargetKind.EMBEDDED, null, null); }
    public static Target version(String name, String version) { return new Target(TargetKind.VERSION, name, version); }

    @Override
    public boolean equals(Object o) {
      if (!(o instanceof Target)) return false;
      Target t = (Target) o;
      return kind == t.kind && java.util.Objects.equals(name, t.name) && java.util.Objects.equals(version, t.version);
    }

    @Override
    public int hashCode() { return java.util.Objects.hash(kind, name, version); }

    @Override
    public String toString() {
      return kind == TargetKind.EMBEDDED ? "embedded" : "version(" + name + "," + version + ")";
    }
  }

  public static final class State {
    public final Map<String, String> active;
    public final Map<String, String> pending;
    public final Map<String, Integer> bootAttempts;
    public final Map<String, Integer> confirmedBoots;
    /** See OtaCore.swift: versions proven bad by attempt exhaustion; never stage again. */
    public final Map<String, java.util.List<String>> rejected;
    /** See OtaCore.swift's field doc: the app-binary version last seen by
     *  resetForNewBinary. null = fresh install OR a pre-this-feature state.json — both
     *  must NOT trigger a reset. */
    public final String lastSeenBinaryVersion;

    public State() {
      this(new HashMap<>(), new HashMap<>(), new HashMap<>(), new HashMap<>(), new HashMap<>(), null);
    }

    public State(Map<String, String> active, Map<String, String> pending, Map<String, Integer> bootAttempts, Map<String, Integer> confirmedBoots) {
      this(active, pending, bootAttempts, confirmedBoots, new HashMap<>(), null);
    }

    public State(Map<String, String> active, Map<String, String> pending, Map<String, Integer> bootAttempts, Map<String, Integer> confirmedBoots, Map<String, java.util.List<String>> rejected) {
      this(active, pending, bootAttempts, confirmedBoots, rejected, null);
    }

    public State(Map<String, String> active, Map<String, String> pending, Map<String, Integer> bootAttempts, Map<String, Integer> confirmedBoots, Map<String, java.util.List<String>> rejected, String lastSeenBinaryVersion) {
      this.active = active;
      this.pending = pending;
      this.bootAttempts = bootAttempts;
      this.confirmedBoots = confirmedBoots;
      this.rejected = rejected;
      this.lastSeenBinaryVersion = lastSeenBinaryVersion;
    }

    public State copy() {
      Map<String, java.util.List<String>> rejectedCopy = new HashMap<>();
      for (Map.Entry<String, java.util.List<String>> e : rejected.entrySet()) {
        rejectedCopy.put(e.getKey(), new java.util.ArrayList<>(e.getValue()));
      }
      return new State(new HashMap<>(active), new HashMap<>(pending), new HashMap<>(bootAttempts), new HashMap<>(confirmedBoots), rejectedCopy, lastSeenBinaryVersion);
    }

    @Override
    public boolean equals(Object o) {
      if (!(o instanceof State)) return false;
      State s = (State) o;
      return active.equals(s.active) && pending.equals(s.pending) && bootAttempts.equals(s.bootAttempts) && confirmedBoots.equals(s.confirmedBoots) && rejected.equals(s.rejected)
        && java.util.Objects.equals(lastSeenBinaryVersion, s.lastSeenBinaryVersion);
    }

    @Override
    public int hashCode() { return java.util.Objects.hash(active, pending, bootAttempts, confirmedBoots, rejected, lastSeenBinaryVersion); }

    @Override
    public String toString() {
      return "State{active=" + active + ", pending=" + pending + ", bootAttempts=" + bootAttempts + ", confirmedBoots=" + confirmedBoots + ", rejected=" + rejected + ", lastSeenBinaryVersion=" + lastSeenBinaryVersion + "}";
    }
  }

  public interface FolderExists {
    boolean check(String name, String version);
  }

  // ---- New-binary reset ----

  /** See OtaCore.swift's resetForNewBinary doc — same contract, must behave identically. */
  public static State resetForNewBinary(State state, String currentBinaryVersion) {
    if (state == null) return null;
    if (state.lastSeenBinaryVersion != null && !state.lastSeenBinaryVersion.equals(currentBinaryVersion)) {
      return new State(new HashMap<>(), new HashMap<>(), new HashMap<>(), new HashMap<>(), state.rejected, currentBinaryVersion);
    }
    if (state.lastSeenBinaryVersion == null) {
      return new State(state.active, state.pending, state.bootAttempts, state.confirmedBoots, state.rejected, currentBinaryVersion);
    }
    return state;
  }

  // ---- Boot ----

  public static final class BootResult {
    public final Target target;
    public final State state; // null = corrupt/missing state.json, use the embedded bundle

    BootResult(Target target, State state) {
      this.target = target;
      this.state = state;
    }
  }

  public static BootResult boot(State state, String name, FolderExists folderExists) {
    if (state == null) return new BootResult(Target.embedded(), null);
    State s = state.copy();

    String pendingVersion = s.pending.get(name);
    if (pendingVersion != null) {
      if (!folderExists.check(name, pendingVersion)) {
        // Deliberately does NOT quarantine — see OtaCore.swift for why a vanished folder
        // is not proof the bundle is bad (transient disk event; re-staging is the heal).
        return revert(s, name, false, folderExists);
      }
      int attempts = s.bootAttempts.getOrDefault(name, 0);
      if (attempts >= MAX_ATTEMPTS) {
        // Attempt exhaustion IS proof — quarantine so it is never staged again.
        return revert(s, name, true, folderExists);
      }
      s.bootAttempts.put(name, attempts + 1);
      return new BootResult(Target.version(name, pendingVersion), s);
    }

    String activeVersion = s.active.get(name);
    if (activeVersion == null) return new BootResult(Target.embedded(), s);
    if (!folderExists.check(name, activeVersion)) {
      s.active.remove(name);
      return new BootResult(Target.embedded(), s);
    }
    return new BootResult(Target.version(name, activeVersion), s);
  }

  private static BootResult revert(State state, String name, boolean quarantine, FolderExists folderExists) {
    State s = state.copy();
    String badVersion = s.pending.get(name);
    if (quarantine && badVersion != null) addRejected(s, name, badVersion);
    s.pending.remove(name);
    s.bootAttempts.remove(name);
    s.confirmedBoots.remove(name);
    String activeVersion = s.active.get(name);
    if (activeVersion != null && folderExists.check(name, activeVersion)) {
      return new BootResult(Target.version(name, activeVersion), s);
    }
    s.active.remove(name);
    return new BootResult(Target.embedded(), s);
  }

  /** See OtaCore.swift's addRejected doc — only ever called for a PENDING version. */
  private static void addRejected(State s, String name, String version) {
    java.util.List<String> list = s.rejected.get(name);
    if (list == null) list = new java.util.ArrayList<>();
    if (!list.contains(version)) list.add(version);
    while (list.size() > MAX_REJECTED_PER_BUNDLE) list.remove(0);
    s.rejected.put(name, list);
  }

  // ---- Load failure (sub-game bundles — #553/#550) ----

  /** See OtaCore.swift's loadFailed doc — same contract, must behave identically.
   *  Returns the version to fall back to THIS launch; the caller must NOT confirm it. */
  public static BootResult loadFailed(State state, String name, String version, LoadFailure disposition, FolderExists folderExists) {
    if (state == null) return new BootResult(Target.embedded(), null);
    State s = state.copy();

    if (version != null && version.equals(s.pending.get(name))) {
      if (disposition == LoadFailure.FATAL) {
        return revert(s, name, true, folderExists);
      } else if (disposition == LoadFailure.NOT_EVIDENCE) {
        int attempts = s.bootAttempts.getOrDefault(name, 0) - 1;
        if (attempts > 0) s.bootAttempts.put(name, attempts); else s.bootAttempts.remove(name);
      }
      // TRANSIENT: the attempt boot() counted stands; exhaustion still reverts + quarantines.
    } else if (version != null && version.equals(s.active.get(name)) && disposition != LoadFailure.NOT_EVIDENCE) {
      // Promoted-then-broken. Drop it, but never quarantine — see addRejected. TRANSIENT must
      // escalate here too: bootAttempts is a PENDING-only counter, so the "costs an attempt,
      // quarantines after maxAttempts" argument does not hold for an active version, and
      // without this it would be refused every launch forever. See OtaCore.swift.
      s.active.remove(name);
      return new BootResult(Target.embedded(), s);
    }

    String activeVersion = s.active.get(name);
    if (activeVersion != null && !activeVersion.equals(version) && folderExists.check(name, activeVersion)) {
      return new BootResult(Target.version(name, activeVersion), s);
    }
    return new BootResult(Target.embedded(), s);
  }

  // ---- Confirm ----

  public static State confirm(State state, String name) {
    return confirm(state, name, null);
  }

  /** See OtaCore.swift's confirm(state:name:version:) doc — `version`, when non-null, must
   *  equal `pending[name]` or the confirm is a no-op. This is the #553 fix. */
  public static State confirm(State state, String name, String version) {
    if (state == null) return null;
    State s = state.copy();
    String pendingVersion = s.pending.get(name);
    if (pendingVersion == null) return s;
    if (version != null && !version.equals(pendingVersion)) return s;
    int confirms = s.confirmedBoots.getOrDefault(name, 0) + 1;
    if (confirms >= REQUIRED_CONFIRMS) {
      s.active.put(name, pendingVersion);
      s.pending.remove(name);
      s.bootAttempts.remove(name);
      s.confirmedBoots.remove(name);
    } else {
      s.confirmedBoots.put(name, confirms);
    }
    return s;
  }
}
