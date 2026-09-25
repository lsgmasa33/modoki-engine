package com.modokiengine.capacitor.iap;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Purchase-classification core — the Android half of the contract in
 * {@code test-vectors/iap-classification-vectors.json} (#971) — plus the pure state machines that
 * make every parked call settle (#1514): {@link Join}, {@link ConnectionQueue}, {@link #drainEach}.
 *
 * <p>⚠️ <b>Dependency-free ON PURPOSE.</b> Nothing here imports {@code com.android.billingclient}
 * or anything from {@code android.*}, which is the only reason the {@code android/iap-core} leg can
 * be a bare {@code javac}/{@code java} run instead of a gradle harness — the same trick
 * {@code OtaCore.java} uses. Add one Android import and that leg becomes unrunnable.
 *
 * <p>Its iOS twin is {@code ModokiIapCore.IapClassification}; both are replayed against the same
 * vector file so the two platforms answer the same question the same way (#946).
 */
public final class IapCore {

    private IapCore() {}

    /**
     * Mirrors {@code BillingClient.BillingResponseCode.USER_CANCELED}.
     *
     * <p>⚠️ This is a DUPLICATE of a Play Billing constant, held here only because importing the
     * billing library would make this class untestable off-device. <b>Nothing verifies the two are
     * equal.</b> A {@code static} comparison against {@code BillingResponseCode.USER_CANCELED} was
     * tried and removed: both sides are compile-time constants, so javac folds the comparison away
     * entirely — the shipped {@code <clinit>} was a bare {@code return}, a guard that could not
     * fire. (Had it fired it would have thrown from a static initializer during plugin
     * registration, failing app LAUNCH for every user — worse than the mislabelled analytics event
     * it guarded.)
     *
     * <p>What is actually covered: a hand-edit of this value is caught by the {@code
     * android/iap-core} leg, which is the realistic drift. An upstream renumbering is caught by
     * nothing here — accepted, because this is a wire-protocol constant that has never moved.
     */
    public static final int RESPONSE_USER_CANCELED = 1;

    /** The {@code cancelReason} a Play cancel carries. iOS's twin is {@code storekit.result.userCancelled}. */
    public static final String CANCEL_REASON = "play.userCanceled";

    /** Prefix for the {@code PluginCall.reject} code on a non-cancel billing failure. */
    public static final String REJECT_CODE_PREFIX = "billing.";

    /**
     * Is this Play response code the user cancelling?
     *
     * <p>Unlike iOS there is no ambiguity to resolve — Android reports the cancel as a response
     * code rather than a thrown error, so there is no {@code ASDErrorDomain}-style fault that reads
     * as a cancel without being one. The vectors still pin every neighbouring code as NOT a cancel,
     * because that is the property a careless {@code >=}/{@code !=} edit would break.
     */
    public static boolean isCancellation(int responseCode) {
        return responseCode == RESPONSE_USER_CANCELED;
    }

    /** The stable {@code error.code} JS sees for a billing failure. */
    public static String rejectCode(int responseCode) {
        return REJECT_CODE_PREFIX + responseCode;
    }

    // ── Settling every park (#1514) ─────────────────────────────────────────
    //
    // ⚠️ Why these exist at all: Play Billing runs its query/consume/acknowledge listeners inside
    // `ExecutorService.submit` (javap on Billing 9.0.0, `BillingClientImpl.zzN`). A throw from one
    // is captured in the Future and never surfaces — no crash, no logcat line — and Billing's own
    // 30s timeout checks `!future.isDone()`, which a throw has made false. (The setup/disconnect
    // listeners are caught and only logged — louder, and just as unsettled.) So a
    // listener that throws, or a queue that a lifecycle event forgets, is a PluginCall that never
    // settles and a JS promise that hangs for the life of the process. Both of the shapes below
    // exist so that "settles exactly once, on every path" is a property of one tested class rather
    // than of each call site's care.

    /**
     * Run every item of a drained batch, isolating each one (#1514).
     *
     * <p>A throw from one item's block used to escape the drain loop, and because the loop runs
     * inside a Billing listener that throw was swallowed — the rest of the batch, already removed
     * from the queue, never ran and never settled. Each item's throw now goes to {@code onThrow}
     * (which settles that item's call) and the loop carries on.
     */
    public static <P> void drainEach(List<P> batch, Consumer<P> run, BiConsumer<P, RuntimeException> onThrow) {
        for (P p : batch) {
            try {
                run.accept(p);
            } catch (RuntimeException e) {
                onThrow.accept(p, e);
            }
        }
    }

    /**
     * An N-way join that settles EXACTLY ONCE (#1514, #1517).
     *
     * <p>Android has to query one-time products and subscriptions separately, so `products()`,
     * `entitlements()` and `unfinished()` each fan out to two Billing queries whose listeners run
     * CONCURRENTLY on Billing's thread pool. The previous join had both listeners `put` into one
     * shared, unsynchronised `JSONArray` (an element could be silently lost — an owned entitlement
     * reading as not owned — #1517) and counted down an `AtomicInteger` that a throwing branch never
     * reached (the call hung — #1514).
     *
     * <p>Here each branch hands over its OWN list, merged under the join's lock, and a branch that
     * throws settles the whole join as a failure. Whichever settles first wins; everything after is
     * ignored, so a late branch cannot resolve a call that a failed branch already rejected.
     * Callbacks run OUTSIDE the lock — they call into the bridge.
     */
    public static final class Join<T> {
        private final Object lock = new Object();
        private final List<T> items = new ArrayList<>();
        private final Consumer<List<T>> onDone;
        private final Consumer<RuntimeException> onFail;
        private int remaining;
        private boolean settled;

        public Join(int branches, Consumer<List<T>> onDone, Consumer<RuntimeException> onFail) {
            if (branches < 1) throw new IllegalArgumentException("a join needs at least one branch");
            this.remaining = branches;
            this.onDone = onDone;
            this.onFail = onFail;
        }

        /**
         * Run one branch. {@code body} computes that branch's items; a throw from it fails the join.
         * This is the ONLY entry point on purpose — a branch cannot arrive without going through the
         * catch, so there is no "forgot to guard this listener" variant to write.
         */
        public void branch(Supplier<List<T>> body) {
            List<T> mine;
            try {
                mine = body.get();
            } catch (RuntimeException e) {
                fail(e);
                return;
            }
            List<T> done = null;
            synchronized (lock) {
                if (settled) return;
                if (mine != null) items.addAll(mine);
                if (--remaining == 0) {
                    settled = true;
                    done = new ArrayList<>(items);
                }
            }
            if (done != null) onDone.accept(done);
        }

        private void fail(RuntimeException e) {
            synchronized (lock) {
                if (settled) return;
                settled = true;
            }
            onFail.accept(e);
        }
    }

    /**
     * The Billing connection's queue of calls waiting for setup, as a pure state machine (#1514).
     *
     * <p>Callers MUST hold their own lock around every method — this class does no locking, so the
     * plugin can keep one monitor for this and the parked-purchase slot. Every transition returns
     * what the caller must DO, and the caller does it outside the lock.
     *
     * <p>⚠️ The defect this replaces: {@code onBillingServiceDisconnected} only cleared
     * {@code connecting}. Nothing guarantees an {@code onBillingSetupFinished} for an attempt
     * that disconnects mid-setup (javap: {@code zzbw.onServiceDisconnected} resets the client to
     * DISCONNECTED and calls only our disconnect listener; a setup callable already launched may
     * still report late, which the generation check below absorbs), so the queued calls — at boot that is
     * isAvailable, products, entitlements, unfinished — waited until some LATER call happened to
     * start a new connection, and forever if none did.
     *
     * <p>Policy: a disconnect mid-setup <b>reconnects once</b> (a transient blip at boot should not
     * lock a paying player out of their entitlements); a second disconnect in the same attempt
     * <b>rejects everything queued</b>. A queued call never reached Play, so rejecting it cannot
     * misreport a purchase outcome.
     *
     * <p>Every connection attempt carries a {@code generation}, and a callback from an older one is
     * ignored: after a reconnect two state listeners exist, and a stale one must not drain or reject
     * the new attempt's queue.
     */
    public static final class ConnectionQueue<P> {
        private final List<P> waiting = new ArrayList<>();
        private boolean connecting = false;
        private boolean retried = false;
        private int generation = 0;

        /** What {@link #onDisconnected} tells the caller to do. */
        public enum Action { IGNORE, RECONNECT, REJECT }

        public static final class Disconnect<P> {
            public final Action action;
            /** For RECONNECT: the generation the new state listener must carry. */
            public final int generation;
            /** For REJECT: the calls to reject. Empty otherwise. */
            public final List<P> rejected;

            Disconnect(Action action, int generation, List<P> rejected) {
                this.action = action;
                this.generation = generation;
                this.rejected = rejected;
            }
        }

        /**
         * Queue a call that found the client not ready.
         *
         * @return the generation to start a connection for, or {@code -1} when one is already in
         *     flight and this call simply waits for it.
         */
        public int enqueue(P pending) {
            waiting.add(pending);
            if (connecting) return -1;
            connecting = true;
            retried = false;
            return ++generation;
        }

        /**
         * Setup finished (OK or not) for {@code gen}.
         *
         * @return the calls to drain — run them on OK, reject them otherwise — or an empty list for
         *     a stale or duplicate callback. `onBillingSetupFinished` can fire more than once; the
         *     second fire finds nothing to drain.
         */
        public List<P> onSetupFinished(int gen) {
            if (gen != generation || !connecting) return new ArrayList<>();
            connecting = false;
            List<P> batch = new ArrayList<>(waiting);
            waiting.clear();
            return batch;
        }

        /** The service disconnected, for the connection attempt {@code gen}. */
        public Disconnect<P> onDisconnected(int gen) {
            // A disconnect after setup finished (the routine case: a Play Store update, low memory)
            // has nothing queued — the next call reconnects the same client, as before.
            if (gen != generation || !connecting) {
                return new Disconnect<>(Action.IGNORE, generation, new ArrayList<>());
            }
            if (!retried) {
                // `connecting` stays true across the retry, so a call arriving now queues behind it
                // instead of starting a second connection that could drain the queue twice.
                retried = true;
                return new Disconnect<>(Action.RECONNECT, ++generation, new ArrayList<>());
            }
            connecting = false;
            List<P> batch = new ArrayList<>(waiting);
            waiting.clear();
            return new Disconnect<>(Action.REJECT, generation, batch);
        }

        /**
         * Starting attempt {@code gen} THREW (#1514 close-out review). `startConnection` calls
         * `Context.bindService` outside any catch (javap, `BillingClientImpl.zzbl`), so a
         * `SecurityException` escapes it — and without this the queue stays `connecting` with the
         * call waiting, so every later call queues behind an attempt that will never report.
         *
         * <p>⚠️ This makes the calls SETTLE, not recover: Billing leaves its client CONNECTING after
         * such a throw, so the fresh attempt the next call starts is refused by Billing at once
         * (and rejected). A reject instead of a hang is the property here.
         *
         * @return the calls to reject; empty for a stale attempt.
         */
        public List<P> onConnectFailed(int gen) {
            if (gen != generation || !connecting) return new ArrayList<>();
            connecting = false;
            List<P> batch = new ArrayList<>(waiting);
            waiting.clear();
            return batch;
        }

        /** Package-visible view, for the plugin's logs and the self-test. */
        int waitingCount() { return waiting.size(); }
        boolean isConnecting() { return connecting; }
    }
}
