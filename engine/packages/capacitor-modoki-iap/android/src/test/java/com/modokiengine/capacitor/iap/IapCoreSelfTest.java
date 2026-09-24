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

    int settleChecks = checkSettleEveryPark();

    if (failures > 0) {
      System.err.println(failures + " check(s) failed across " + cases.size() + " vector(s) and "
          + settleChecks + " settle scenario(s)");
      System.exit(1);
    }
    System.out.println("iap-core: " + cases.size() + " android vector(s) OK, "
        + settleChecks + " settle scenario(s) OK");
  }

  // ── #1514 / #1517: every parked call settles ────────────────────────────

  /** Runs every settle scenario; returns how many ran, so the summary line proves they did. */
  private static int checkSettleEveryPark() throws Exception {
    int n = 0;

    // 1. A disconnect mid-setup reconnects once, and the retry's setup drains EVERYTHING — including
    //    a call that arrived during the retry. Before #1514 the queue simply sat there.
    {
      IapCore.ConnectionQueue<String> q = new IapCore.ConnectionQueue<>();
      int g1 = q.enqueue("isAvailable");
      check("1: first enqueue starts a connection", 1, g1);
      check("1: second enqueue waits", -1, q.enqueue("products"));
      IapCore.ConnectionQueue.Disconnect<String> d = q.onDisconnected(g1);
      check("1: first mid-setup disconnect reconnects", IapCore.ConnectionQueue.Action.RECONNECT, d.action);
      check("1: nothing rejected on the reconnect", 0, d.rejected.size());
      check("1: still connecting across the retry", true, q.isConnecting());
      check("1: a call during the retry waits, not a second connection", -1, q.enqueue("entitlements"));
      check("1: the retry's setup drains all three", 3, q.onSetupFinished(d.generation).size());
      check("1: queue empty after drain", 0, q.waitingCount());
      n++;
    }

    // 2. A second disconnect in the same attempt rejects everything queued, and the next call
    //    starts a fresh attempt (with a fresh retry allowance).
    {
      IapCore.ConnectionQueue<String> q = new IapCore.ConnectionQueue<>();
      int g1 = q.enqueue("a");
      q.enqueue("b");
      int g2 = q.onDisconnected(g1).generation;
      IapCore.ConnectionQueue.Disconnect<String> d = q.onDisconnected(g2);
      check("2: second disconnect rejects", IapCore.ConnectionQueue.Action.REJECT, d.action);
      check("2: rejects both queued calls", 2, d.rejected.size());
      check("2: no longer connecting", false, q.isConnecting());
      int g3 = q.enqueue("c");
      check("2: next call starts a new attempt", true, g3 > g2);
      check("2: the new attempt may reconnect again",
          IapCore.ConnectionQueue.Action.RECONNECT, q.onDisconnected(g3).action);
      n++;
    }

    // 3. Callbacks from a stale attempt are ignored — after a reconnect two state listeners exist.
    {
      IapCore.ConnectionQueue<String> q = new IapCore.ConnectionQueue<>();
      int g1 = q.enqueue("a");
      q.onDisconnected(g1); // → reconnect under g1 + 1
      check("3: stale setup drains nothing", 0, q.onSetupFinished(g1).size());
      check("3: stale setup leaves the queue", 1, q.waitingCount());
      check("3: stale disconnect is ignored", IapCore.ConnectionQueue.Action.IGNORE, q.onDisconnected(g1).action);
      check("3: still connecting", true, q.isConnecting());
      n++;
    }

    // 4. The routine case is unchanged: a disconnect AFTER setup has nothing queued and does
    //    nothing; a duplicate setup callback drains nothing.
    {
      IapCore.ConnectionQueue<String> q = new IapCore.ConnectionQueue<>();
      int g1 = q.enqueue("a");
      check("4: setup drains", 1, q.onSetupFinished(g1).size());
      check("4: duplicate setup drains nothing", 0, q.onSetupFinished(g1).size());
      check("4: post-setup disconnect is ignored", IapCore.ConnectionQueue.Action.IGNORE, q.onDisconnected(g1).action);
      check("4: next call starts a new attempt", g1 + 1, q.enqueue("b"));
      n++;
    }

    // 4b. A connection attempt that THREW (bindService's SecurityException escapes startConnection)
    //     hands back its queue and stops connecting, so the next call starts a fresh attempt instead
    //     of queueing forever behind one that will never report. (On a real client Billing refuses
    //     that attempt at once — it stays CONNECTING — so the call is rejected, not recovered. The
    //     property pinned here is that nothing waits forever.)
    {
      IapCore.ConnectionQueue<String> q = new IapCore.ConnectionQueue<>();
      int g1 = q.enqueue("a");
      q.enqueue("b");
      check("4b: a failed start hands back both queued calls", 2, q.onConnectFailed(g1).size());
      check("4b: no longer connecting", false, q.isConnecting());
      check("4b: the next call starts a fresh attempt", g1 + 1, q.enqueue("c"));
      check("4b: a stale failed start hands back nothing", 0, q.onConnectFailed(g1).size());
      check("4b: and leaves the live attempt alone", true, q.isConnecting());
      n++;
    }

    // 5. One throwing item does not strand the rest of the drained batch.
    {
      List<String> ran = new java.util.ArrayList<>();
      List<String> threw = new java.util.ArrayList<>();
      IapCore.drainEach(java.util.Arrays.asList("a", "boom", "c"),
          p -> { if (p.equals("boom")) throw new IllegalStateException("x"); ran.add(p); },
          (p, e) -> threw.add(p));
      check("5: the items after a throw still run", java.util.Arrays.asList("a", "c"), ran);
      check("5: the throwing item is reported for settling", java.util.Arrays.asList("boom"), threw);
      n++;
    }

    // 6. A join merges every branch and settles once.
    {
      int[] done = {0};
      List<String> got = new java.util.ArrayList<>();
      IapCore.Join<String> j = new IapCore.Join<>(2, l -> { done[0]++; got.addAll(l); }, e -> done[0] += 100);
      j.branch(() -> java.util.Arrays.asList("inapp1", "inapp2"));
      check("6: not settled after one branch", 0, done[0]);
      j.branch(() -> java.util.Arrays.asList("sub1"));
      check("6: settled once", 1, done[0]);
      check("6: every item merged", 3, got.size());
      n++;
    }

    // 7. A throwing branch fails the join, and the other branch arriving afterwards is ignored —
    //    no resolve after the reject. Before #1514 a throwing branch never counted down: a hang.
    {
      int[] resolved = {0};
      int[] failed = {0};
      IapCore.Join<String> j = new IapCore.Join<>(2, l -> resolved[0]++, e -> failed[0]++);
      j.branch(() -> { throw new ArrayIndexOutOfBoundsException("grow race"); });
      j.branch(() -> java.util.Arrays.asList("sub1"));
      check("7: a throwing branch fails the join", 1, failed[0]);
      check("7: no resolve after the failure", 0, resolved[0]);
      // Both branches throwing is the case that could double-settle: two rejects of one call.
      int[] failedTwice = {0};
      IapCore.Join<String> both = new IapCore.Join<>(2, l -> resolved[0]++, e -> failedTwice[0]++);
      both.branch(() -> { throw new IllegalStateException("inapp"); });
      both.branch(() -> { throw new IllegalStateException("subs"); });
      check("7: two failing branches reject exactly once", 1, failedTwice[0]);
      n++;
    }

    // 8. #1517: two branches arriving CONCURRENTLY lose nothing. Billing runs the INAPP and SUBS
    //    listeners on two pool threads; the old shared JSONArray could drop an element. Many rounds,
    //    because the race is a window, not a certainty.
    {
      final int rounds = 300;
      final int perBranch = 2000;
      int bad = 0;
      java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
      try {
        for (int r = 0; r < rounds; r++) {
          final java.util.concurrent.atomic.AtomicInteger size = new java.util.concurrent.atomic.AtomicInteger(-1);
          final java.util.concurrent.CountDownLatch settled = new java.util.concurrent.CountDownLatch(1);
          final java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
          final IapCore.Join<Integer> j = new IapCore.Join<>(2,
              l -> { size.set(l.size()); settled.countDown(); },
              e -> settled.countDown());
          for (int b = 0; b < 2; b++) {
            pool.submit(() -> {
              go.await();
              List<Integer> mine = new java.util.ArrayList<>();
              for (int i = 0; i < perBranch; i++) mine.add(i);
              j.branch(() -> mine);
              return null;
            });
          }
          go.countDown();
          if (!settled.await(10, java.util.concurrent.TimeUnit.SECONDS) || size.get() != 2 * perBranch) bad++;
        }
      } finally {
        pool.shutdownNow();
      }
      check("8: concurrent branches lose nothing and always settle (bad rounds)", 0, bad);
      n++;
    }

    return n;
  }
}
