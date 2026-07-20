// Golden-vector parity test for the Android lease port (code-review T5).
//
// Replays ../test-vectors/lease-golden-vectors.json against a pure LeaseCore and asserts every reply
// matches the shared contract the TS DeviceLeaseAuthority is pinned to
// (engine/tests/plugins/deviceLeaseGoldenVectors.test.ts). Catches a native divergence from the spec.
//
// STATUS: needs the Android module's unit-test source set wired (this file lives under src/test/java)
// plus `testImplementation 'org.json:json:20231013'` (JVM unit tests don't get the android org.json
// stub). LeaseCore below is the RECOMMENDED extraction target — GameDebugPlugin.evaluateLease/
// startLeaseGrace should delegate to it (a pure, clock-injected, timer-free arbiter mirroring the TS
// spec's lazy expiry) so this test covers the shipping code, not a copy.

package com.modokiengine.capacitor.gamedebug;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.file.Files;
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

    @Test
    public void goldenVectors() throws Exception {
        // Android unit tests run with the module dir (android/) as the working dir.
        String json = new String(Files.readAllBytes(Paths.get("../test-vectors/lease-golden-vectors.json")));
        JSONObject fixture = new JSONObject(json);
        LeaseCore core = new LeaseCore(fixture.getLong("graceMs"));
        JSONArray steps = fixture.getJSONArray("steps");

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
