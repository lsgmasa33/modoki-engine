package com.modokiengine.capacitor.ota;

import java.util.HashMap;
import java.util.Map;

/**
 * Pure OTA boot-watchdog state machine (docs/plans/mobile-ota-updates-plan.md, Phase 1).
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

  public enum TargetKind { EMBEDDED, VERSION }

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

    public State() {
      this(new HashMap<>(), new HashMap<>(), new HashMap<>(), new HashMap<>());
    }

    public State(Map<String, String> active, Map<String, String> pending, Map<String, Integer> bootAttempts, Map<String, Integer> confirmedBoots) {
      this.active = active;
      this.pending = pending;
      this.bootAttempts = bootAttempts;
      this.confirmedBoots = confirmedBoots;
    }

    public State copy() {
      return new State(new HashMap<>(active), new HashMap<>(pending), new HashMap<>(bootAttempts), new HashMap<>(confirmedBoots));
    }

    @Override
    public boolean equals(Object o) {
      if (!(o instanceof State)) return false;
      State s = (State) o;
      return active.equals(s.active) && pending.equals(s.pending) && bootAttempts.equals(s.bootAttempts) && confirmedBoots.equals(s.confirmedBoots);
    }

    @Override
    public int hashCode() { return java.util.Objects.hash(active, pending, bootAttempts, confirmedBoots); }

    @Override
    public String toString() {
      return "State{active=" + active + ", pending=" + pending + ", bootAttempts=" + bootAttempts + ", confirmedBoots=" + confirmedBoots + "}";
    }
  }

  public interface FolderExists {
    boolean check(String name, String version);
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
        return revert(s, name, folderExists);
      }
      int attempts = s.bootAttempts.getOrDefault(name, 0);
      if (attempts >= MAX_ATTEMPTS) {
        return revert(s, name, folderExists);
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

  private static BootResult revert(State state, String name, FolderExists folderExists) {
    State s = state.copy();
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

  // ---- Confirm ----

  public static State confirm(State state, String name) {
    if (state == null) return null;
    State s = state.copy();
    String pendingVersion = s.pending.get(name);
    if (pendingVersion == null) return s;
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
