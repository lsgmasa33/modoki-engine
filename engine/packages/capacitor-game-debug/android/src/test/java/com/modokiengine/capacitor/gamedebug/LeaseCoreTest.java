// Golden-vector parity test for the Android lease port (code-review T5).
//
// Replays test-vectors/lease-golden-vectors.json against a pure LeaseCore and asserts every reply
// matches the shared contract the TS DeviceLeaseAuthority is pinned to
// (engine/tests/plugins/deviceLeaseGoldenVectors.test.ts). Catches a native divergence from the spec.
//
// HOW IT RUNS: `npm run test:native` (engine/scripts/test-native.mjs), an ON-DEMAND gate — `npm run
// verify` is vitest and cannot run gradle. The runner drives android/test-harness, a plain JVM
// gradle project that points its test source set here; the real android module is an AGP library
// that only builds inside a consuming app, and ships no test sources anyway (see that build.gradle).
// #376 wired this; before then the file had never executed once.
//
// SCOPE — read this before trusting a green run. LeaseCore below is a PORT of the spec, not the
// shipping arbiter: GameDebugPlugin.evaluateLease/startLeaseGrace still hold their own lease state
// with a Handler-scheduled grace timer. So this proves the spec is portable to Java and pins the
// contract; it does NOT prove the shipping plugin obeys it. The extraction that would fix that —
// evaluateLease/startLeaseGrace delegating to a pure, clock-injected, timer-free LeaseCore — is a
// behavioural native change needing device verification, deliberately left out of #376.

package com.modokiengine.capacitor.gamedebug;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public class LeaseCoreTest {

    /** Pure, clock-injected lease arbiter — a faithful port of DeviceLeaseAuthority (deviceLease.ts).
     *  No timers: grace is a deadline compared lazily on the next message (matches the TS spec). */
    static final class LeaseCore {
        final long graceMs;
        private String leaseGuid;
        private boolean live;
        private Long graceUntil;

        LeaseCore(long graceMs) { this.graceMs = graceMs; }

        private void expireIfDue(long now) {
            if (leaseGuid != null && !live && graceUntil != null && now >= graceUntil) { leaseGuid = null; graceUntil = null; }
        }

        String connect(String guid, long now) {
            expireIfDue(now);
            if (leaseGuid == null) { leaseGuid = guid; live = true; graceUntil = null; return "ok"; }
            if (leaseGuid.equals(guid)) { boolean resumed = !live; live = true; graceUntil = null; return resumed ? "ok+resumed" : "ok"; }
            return "busy";
        }

        String ping(String guid, long now) {
            expireIfDue(now);
            if (leaseGuid == null) return "no-lease";
            if (!leaseGuid.equals(guid)) return "not-owner";
            live = true; graceUntil = null; return "ok";
        }

        String disconnect(String guid, long now) {
            expireIfDue(now);
            if (leaseGuid == null || !leaseGuid.equals(guid)) return leaseGuid == null ? "no-lease" : "not-owner";
            leaseGuid = null; live = false; graceUntil = null; return "ok";
        }

        void socketDropped(long now) {
            expireIfDue(now);
            if (leaseGuid != null && live) { live = false; graceUntil = now + graceMs; }
        }

        boolean leased(long now) { expireIfDue(now); return leaseGuid != null; }
        boolean isLive(long now) { expireIfDue(now); return live; }
    }

    /** Normalize an expected reply from the fixture to the LeaseCore string form. */
    private static String expected(JSONObject e) {
        if (!e.optBoolean("ok", false)) return e.optString("reason", "?");
        return e.optBoolean("resumed", false) ? "ok+resumed" : "ok";
    }

    /** Locate test-vectors/lease-golden-vectors.json by walking UP from the working directory.
     *  Not a fixed relative path: the working dir depends on which gradle project runs this
     *  (the AGP module, or android/test-harness), and a test that cannot run cannot tell you it
     *  guessed wrong — which is exactly how the iOS twin sat broken. */
    private static Path goldenVectorsPath() {
        Path dir = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("test-vectors/lease-golden-vectors.json");
            if (Files.exists(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new IllegalStateException(
            "test-vectors/lease-golden-vectors.json not found above " + Paths.get("").toAbsolutePath());
    }

    @Test
    public void goldenVectors() throws Exception {
        String json = new String(Files.readAllBytes(goldenVectorsPath()));
        JSONObject fixture = new JSONObject(json);
        LeaseCore core = new LeaseCore(fixture.getLong("graceMs"));
        JSONArray steps = fixture.getJSONArray("steps");
        // The TS twin asserts these; this did not, so an emptied fixture replayed zero steps and
        // reported PASS — measured. This gate is the only one that runs this file.
        assertEquals("fixture graceMs must be positive", true, fixture.getLong("graceMs") > 0);
        assertEquals("fixture has no steps — this test would check nothing", true, steps.length() > 0);

        for (int i = 0; i < steps.length(); i++) {
            JSONObject s = steps.getJSONObject(i);
            String op = s.getString("op");
            long now = s.getLong("now");
            String where = "step " + i + " (" + op + " @" + now + ")";
            switch (op) {
                case "connect":   assertEquals(where, expected(s.getJSONObject("expect")), core.connect(s.getString("guid"), now)); break;
                case "ping":      assertEquals(where, expected(s.getJSONObject("expect")), core.ping(s.getString("guid"), now)); break;
                case "disconnect":assertEquals(where, expected(s.getJSONObject("expect")), core.disconnect(s.getString("guid"), now)); break;
                case "socketDropped": core.socketDropped(now); break;
                case "status":
                    JSONObject ex = s.getJSONObject("expect");
                    assertEquals(where + " leased", ex.getBoolean("leased"), core.leased(now));
                    assertEquals(where + " live", ex.getBoolean("live"), core.isLive(now));
                    break;
                default: throw new IllegalStateException("unknown op " + op);
            }
        }
    }
}
