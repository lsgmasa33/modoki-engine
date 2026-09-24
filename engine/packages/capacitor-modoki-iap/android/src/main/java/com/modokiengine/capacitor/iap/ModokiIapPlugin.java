package com.modokiengine.capacitor.iap;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Modoki's Google Play Billing bridge (#196).
 *
 * ⚠️ **THE ONE RULE: nothing here consumes or acknowledges a purchase on its own.** The
 * PurchasesUpdatedListener records what arrives and tells JS; it never calls consumeAsync or
 * acknowledgePurchase. Those happen only in finish()/acknowledge(), when JS asks.
 *
 * consumeAsync is destructive — after it, queryPurchasesAsync forgets the purchase entirely, and
 * for a consumable that is the ONLY record that it happened. Calling it before the entitlement is
 * durably recorded loses the player's money permanently. Everything about this file's structure
 * follows from not doing that.
 *
 * Acknowledgement is the non-destructive half and has its own deadline: Google auto-refunds and
 * revokes a purchase not acknowledged within three days, so acknowledge() is safe to call early
 * and the engine deliberately does.
 */
@CapacitorPlugin(name = "ModokiIap")
public class ModokiIapPlugin extends Plugin {

    /**
     * Every callback boundary logs here, on purpose and permanently.
     *
     * Billing is asynchronous end to end — connection, product query, purchase delivery, consume —
     * and when one of those callbacks never fires there is NOTHING to see from JS: the promise
     * simply never settles, and the UI shows a stale value with no error anywhere. That state cost
     * a long debugging session. `adb logcat -s ModokiIap` is the instrument that answers "did the
     * callback fire, and with what response code" directly.
     */
    private static final String TAG = "ModokiIap";

    /** Guards `ensureWebViewListener()` — one registration per plugin instance. A new
     *  Activity builds a new Bridge AND a new plugin instance, so this resets with it,
     *  which is correct: the new Bridge has its own listener list to be added to. */
    private boolean webViewListenerRegistered = false;

    private BillingClient billing;

    /** The call awaiting launchBillingFlow's async result. Play delivers the purchase through the
     *  listener, not the launch call, so the call has to be parked. */
    private volatile PluginCall awaitingPurchase;
    private volatile String awaitingProductId;

    /** How long a parked purchase() may wait AFTER a non-matching purchasesUpdated delivery before
     *  it is released as cancelled (#583).
     *
     *  ⚠️ Armed from the NO-MATCH branch only — never at park time. That distinction is the whole
     *  safety argument, and an earlier draft got it wrong. Arming at park bounds every purchase,
     *  including one whose Play sheet is legitimately still open (adding a card, awaiting
     *  Ask-to-Buy); it then resolves `{transaction:null}`, which settles the JS promise, which
     *  clears Court's `storeInFlight` — and `storeInFlight`'s own doc records that the last
     *  omission in that area was a DOUBLE CHARGE. Measured on an A23 (2026-09-03): the park-time
     *  variant fired with the sheet still on screen. Bounding only the case #583 actually describes
     *  — an OK delivery that arrived without the awaited product — leaves a live sheet alone.
     *
     *  A real purchase completing after this fires is recovered by reconcile(), which the
     *  purchasesUpdated listener drives in-process, not only at next launch. */
    private static final long PARKED_PURCHASE_TIMEOUT_MS = 5 * 60_000L;

    /** ⚠️ THREE different threads touch the parked slot — do not assume single-threading, and do not
     *  believe a comment that names only one (two earlier drafts of this one were wrong).
     *   - The PARK runs on a Play Billing worker: `queryProductDetailsAsync` submits to
     *     `Executors.newFixedThreadPool(availableProcessors())` and invokes the callback directly
     *     with no Handler post, and the park sits inside that callback. NOT main, and NOT
     *     Capacitor's `HandlerThread("CapacitorPlugins")` (`Bridge`'s `handlerThread`, posted to by `callPluginMethod`), which only
     *     carries purchase()'s outer body.
     *   - `onPurchasesUpdated` and the WebViewListener run on MAIN.
     *   - `unpark()` is reached from both.
     *  Hence `volatile` on the two fields for visibility, and `lock` around the compound
     *  check-and-park: an N-way pool means two purchase() calls really can read the slot as free at
     *  the same instant, and the loser would park a call nothing can ever settle — the exact defect
     *  #583 bounds, on the one path a stale-fire guard cannot rescue. */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** The #583 timeout currently armed for `awaitingPurchase`, so unpark() can cancel it. Null
     *  whenever nothing is parked. */
    private Runnable awaitingPurchaseTimeout;

    /**
     * Release the parked purchase slot for `call` and close its bridge lifecycle.
     *
     * ⚠️ MUST run BEFORE resolve/reject. `MessageHandler.sendResponseMessage` reads
     * `isKeptAlive()` to decide whether to `release()` the call, and copies the same value into
     * the response's `save` field — so clearing the flag afterwards changes nothing.
     *
     * The slot is only cleared if `call` still owns it, so a settle that lost a race cannot wipe
     * a newer purchase's parking. The same check gates cancelling the #583 timeout, for the same
     * reason: a stale call unparking after a NEW purchase() has already taken the slot must not
     * cancel that newer call's timeout.
     *
     * ⚠️ On Android today the keep-alive is INERT rather than a leak, and #514 was filed on the
     * opposite reading — do not re-diagnose it. `Bridge.callPluginMethod` saves a call only if it
     * is kept-alive at the moment the plugin METHOD RETURNS (Bridge.callPluginMethod's isKeptAlive check), and this call
     * is parked several async hops later, so it never reaches `savedCalls`; `native-bridge.js`
     * deletes a promise call's JS callback on settle whatever `save` says. This exists because
     * the lifecycle should be closed where the call is settled — and because the day someone
     * parks synchronously (a ProductDetails cache would do it), the flag stops being inert and
     * every settle path here is already correct.
     */
    private void unpark(PluginCall call) {
        synchronized (lock) {
            // ⚠️ The timer cancel belongs INSIDE this identity check, not above it. A settle that
            // lost a race must not cancel the timer belonging to the NEWER call that now holds the
            // slot — that would restore #583 exactly. Pinned by iapParkedCallRelease.test.ts.
            if (awaitingPurchase == call) {
                if (awaitingPurchaseTimeout != null) {
                    mainHandler.removeCallbacks(awaitingPurchaseTimeout);
                    awaitingPurchaseTimeout = null;
                }
                awaitingPurchase = null;
                awaitingProductId = null;
            }
        }
        call.setKeepAlive(false);
    }

    /**
     * Arm the #583 stranding bound. Called ONLY from the no-match branch of
     * `onPurchasesUpdated` — see {@code PARKED_PURCHASE_TIMEOUT_MS} for why never at park time —
     * and re-armed on each further non-matching delivery, so the window is measured from the last
     * thing we heard rather than from the start of the purchase.
     */
    private void armStrandTimeout(PluginCall call, String productId) {
        if (awaitingPurchaseTimeout != null) mainHandler.removeCallbacks(awaitingPurchaseTimeout);
        awaitingPurchaseTimeout = () -> {
            if (awaitingPurchase != call) return;
            Log.i(TAG, "purchase timeout: no matching purchasesUpdated delivery for "
                + productId + " within " + PARKED_PURCHASE_TIMEOUT_MS
                + "ms of the last non-matching one — releasing as cancelled");
            unpark(call);
            JSObject r = new JSObject();
            r.put("transaction", JSObject.NULL);
            call.resolve(r);
        };
        mainHandler.postDelayed(awaitingPurchaseTimeout, PARKED_PURCHASE_TIMEOUT_MS);
    }

    /** Drop anything still posted so a pending #583 timer cannot pin this Activity's Bridge and
     *  WebView in the main looper for the rest of its window. */
    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        mainHandler.removeCallbacksAndMessages(null);
    }

    /**
     * Release a parked purchase() call left behind by a webview reload (#586).
     *
     * A reload gives JS a brand-new realm, and `Bridge.reset()` — called from
     * `BridgeWebViewClient.onPageStarted` right before this listener fires — clears
     * `savedCalls` and every plugin's event listeners. It does NOT touch plugin fields, so
     * `awaitingPurchase` keeps pointing at a call whose realm is gone, and every `purchase()`
     * for that product hits the "already in progress" reject in `purchase` forever after.
     *
     * `Bridge.addWebViewListener` survives every reset — the listener LIST is not cleared by
     * `Bridge.reset()` — so one registration lasts the life of the plugin instance.
     *
     * ⚠️ **Registered here, at park time, and NOT from `load()` — a listener added in `load()` is
     * silently DISCARDED.** `Bridge`'s constructor calls `registerAllPlugins()` (in the `Bridge` constructor),
     * which is what runs `Plugin.load()`; `Bridge.Builder.create()` then calls
     * `bridge.setWebViewListeners(...)` (in `Bridge.Builder.create`) right after, and that setter REPLACES
     * the whole list (`Bridge.setWebViewListeners`) instead of appending to it. So anything `load()` registered is gone
     * before the first navigation, and `BridgeWebViewClient.onPageStarted` — which iterates
     * `bridge.getWebViewListeners()` — walks a list that never contained it.
     *
     * Device-measured on a Galaxy S22 (2026-09-03) with a probe on both sides: `load()` DID run
     * (1ms after "Registering plugin instance: ModokiIap") and the listener WAS added, yet across a
     * real resume-reload — `[resume-reload] reloading after 75s away`, same PID, plugin still
     * serving calls afterwards — `onPageStarted` never reached it. The first version of this fix
     * lived in `load()` and was therefore inert. Do not move it back.
     *
     * Park time is the right seam on both counts: a JS call cannot arrive until the bridge is
     * fully built, so it is provably after that replacement; and the listener has nothing to do
     * until a call is actually parked.
     */
    private void ensureWebViewListener() {
        if (webViewListenerRegistered) return;
        webViewListenerRegistered = true;
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                PluginCall call = awaitingPurchase;
                if (call == null) return;
                String productId = awaitingProductId;
                Log.i(TAG, "onPageStarted: webview reloaded with a purchase parked (" + productId
                    + ") — releasing it");
                // unpark() BEFORE reject: see its own doc for why the order matters.
                unpark(call);
                try {
                    call.reject("the webview reloaded while this purchase was in flight — the "
                        + "purchase itself is unaffected and is recovered by reconcile()");
                } catch (Exception e) {
                    // `call` belongs to the realm that just went away; rejecting into it can
                    // throw. That must not propagate into Capacitor's navigation path.
                    Log.w(TAG, "onPageStarted: rejecting the stale parked call failed", e);
                }
            }
        });
    }

    private final PurchasesUpdatedListener purchasesUpdatedListener = (billingResult, purchases) -> {
        int code = billingResult.getResponseCode();
        Log.i(TAG, "onPurchasesUpdated: code=" + code + " msg=" + billingResult.getDebugMessage()
            + " count=" + (purchases == null ? "null" : String.valueOf(purchases.size()))
            + " parkedCall=" + (awaitingPurchase != null));
        PluginCall call = awaitingPurchase;

        if (IapCore.isCancellation(code)) {
            if (call != null) {
                unpark(call);
                JSObject r = new JSObject();
                r.put("transaction", JSObject.NULL);
                // #946 — say WHICH cancel this was, so the two platforms answer the same question.
                // Android reaches here by a response code rather than a thrown error, so unlike
                // iOS there is no ambiguity to resolve: USER_CANCELED is checked before the generic
                // failure branch and is the only route to a resolved-null cancel. The field is
                // emitted anyway so a journal entry means the same thing on both platforms, and so
                // that a cancel with NO reason attached identifies an older build rather than
                // silently reading as Android.
                r.put("cancelReason", IapCore.CANCEL_REASON);
                call.resolve(r);
            }
            return;
        }

        if (code != BillingClient.BillingResponseCode.OK || purchases == null) {
            if (call != null) {
                unpark(call);
                rejectWithBilling(call, "purchase failed: " + billingResult.getDebugMessage(), billingResult);
            }
            return;
        }

        // NOTE: deliberately NOT consuming or acknowledging here. See the class header.

        // ⚠️ ALWAYS notify JS, EVEN when a call is parked.
        //
        // Google delivers purchases here that no `purchase()` call is waiting for: a PENDING
        // purchase (cash, carrier billing, parental approval, or the license-testing "slow test
        // card") is approved MINUTES LATER, and this listener is the only in-process signal that
        // it happened. Without this event the app cannot notice until its next launch — which is
        // exactly the bug this replaced: the arriving purchase was stored in a private map that
        // nothing read, so a purchase the player had paid for sat invisible until a relaunch.
        JSArray delivered = new JSArray();
        for (Purchase p : purchases) {
            Log.i(TAG, "  delivered: products=" + p.getProducts() + " state=" + p.getPurchaseState()
                + " acked=" + p.isAcknowledged() + " order=" + p.getOrderId());
            delivered.put(serialize(p));
        }
        JSObject event = new JSObject();
        event.put("transactions", delivered);
        // retainUntilConsumed: true — a webview reload (#586) tears down the JS realm and its
        // subscription along with it; with no listener attached, Plugin queues this event in
        // `retainedEventArguments` (which `Bridge.reset()` does not clear) instead of dropping
        // it, and it drains into the next realm's subscribe the moment that subscription is
        // added. It cannot double-deliver: retention only happens when the listener list is
        // empty, so an event that DID have a listener is never retained. And the durable
        // ledger's `isProcessed` gives cross-realm idempotency regardless, so this is what
        // removes the need to reorder the JS subscription in `capacitorStore.ts`.
        notifyListeners("purchasesUpdated", event, true);

        if (call != null) {
            Purchase match = null;
            for (Purchase p : purchases) {
                if (awaitingProductId != null && p.getProducts().contains(awaitingProductId)) {
                    match = p;
                    break;
                }
            }
            // ⚠️ Resolve ONLY on a match. A no-match delivery is not this call's business.
            //
            // This listener is fired for purchases nobody is waiting on — an Ask-to-Buy approved
            // minutes later, a subscription renewal — as the comment above says outright. It used
            // to clear the slot and resolve `transaction: null` regardless, which JS reads as
            // `outcome: 'cancelled'`. So an unrelated delivery landing while a purchase was in
            // flight told the player they had cancelled a purchase they had not, and which was
            // still going to succeed; the UI would re-enable Buy or show a failure, and the real
            // purchase then turned up later via reconcile().
            //
            // Leaving it parked is safe: a genuine cancel arrives as USER_CANCELED above, and a
            // genuine failure as the non-OK branch — both of which do clear the slot.
            if (match != null) {
                unpark(call);
                JSObject r = new JSObject();
                r.put("transaction", serialize(match));
                call.resolve(r);
            } else {
                Log.i(TAG, "  delivery does not contain the awaited product (" + awaitingProductId
                    + ") — leaving the call parked rather than reporting a false cancel");
                // #583: leaving it parked is right, leaving it parked FOREVER is not. Nothing else
                // bounds this: if no later delivery ever matches, the slot stays occupied for the
                // life of the process — the product refuses every purchase() with "already in
                // progress", and in Court `storeInFlight` never clears, which also leaves the
                // `court.purchase` reload blocker reading blocked and silently disables #574's
                // resume-reload. unpark() cancels the timer the moment the call settles any other
                // way.
                armStrandTimeout(call, awaitingProductId);
            }
        }
    };

    // ── Serialization ────────────────────────────────────────────────────────

    private JSObject serialize(Purchase p) {
        JSObject o = new JSObject();
        // orderId is absent for test purchases, so fall back to the token — which is unique per
        // purchase and is what the engine needs as an idempotency key.
        String orderId = p.getOrderId();
        o.put("transactionId", orderId != null && !orderId.isEmpty() ? orderId : p.getPurchaseToken());
        o.put("productId", p.getProducts().isEmpty() ? "" : p.getProducts().get(0));
        o.put("purchaseToken", p.getPurchaseToken());
        o.put("acknowledged", p.isAcknowledged());
        // PENDING means money has NOT moved (cash / carrier billing / parental approval). The
        // engine refuses to grant these; they arrive again once actually paid.
        o.put("pending", p.getPurchaseState() == Purchase.PurchaseState.PENDING);
        return o;
    }

    // ── Connection ───────────────────────────────────────────────────────────

    private interface Ready {
        void run(BillingClient client);
    }

    /** One queued operation waiting for the connection to come up. */
    private static final class Pending {
        final PluginCall call;
        final Ready block;
        Pending(PluginCall call, Ready block) { this.call = call; this.block = block; }
    }

    private final Object lock = new Object();
    /** The calls waiting for setup, and which connection attempt is live. Guarded by `lock`; the
     *  transitions and their policy (reconnect once, then reject) live in
     *  {@link IapCore.ConnectionQueue}, where the android/iap-core leg tests them (#1514). */
    private final IapCore.ConnectionQueue<Pending> queue = new IapCore.ConnectionQueue<>();

    /**
     * Run `block` against a connected client, creating AT MOST ONE BillingClient for the app.
     *
     * ⚠️ **The previous version built a NEW client on every call that arrived before the
     * connection was up**, and that was a real defect, not a tidiness issue. The engine fires four
     * billing calls back to back at boot — isAvailable, products, entitlements, unfinished — so it
     * produced FOUR live BillingClients, each with the same PurchasesUpdatedListener attached and
     * `billing` pointing at whichever was created last. `launchBillingFlow` then ran on one client
     * while deliveries could arrive through another, which is how a purchase completed at Play
     * without the app granting it, only to surface on a later query. Google's own guidance is one
     * client per app, reused.
     *
     * So: callers that arrive mid-connection are QUEUED and drained together, and the same client
     * instance is reconnected rather than replaced. `onBillingSetupFinished` can fire more than
     * once; draining under the lock makes a second fire a harmless no-op instead of a double-run
     * (which would double-launch a purchase flow, or resolve one PluginCall twice — Capacitor
     * throws on that).
     */
    private void withBilling(PluginCall call, Ready block) {
        BillingClient ready = null;
        int gen = -1;
        synchronized (lock) {
            if (billing != null && billing.isReady()) {
                ready = billing;
                Log.i(TAG, "withBilling: client already ready — running immediately");
            } else {
                if (billing == null) {
                    billing = BillingClient
                        .newBuilder(getContext())
                        .setListener(purchasesUpdatedListener)
                        // Required since v6. Declaring one-time products as pending-capable is what
                        // lets a cash/carrier purchase be reported at all rather than silently
                        // dropped.
                        .enablePendingPurchases(
                            PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
                        )
                        .build();
                }
                gen = queue.enqueue(new Pending(call, block));
                if (gen < 0) {
                    Log.i(TAG, "withBilling: connection in flight — queued (" + queue.waitingCount() + " waiting)");
                    return;
                }
                Log.i(TAG, "withBilling: starting connection attempt " + gen + " (" + queue.waitingCount() + " waiting)");
            }
        }
        if (ready != null) {
            final BillingClient client = ready;
            guarded(call, "withBilling", () -> block.run(client));
            return;
        }
        connect(gen);
    }

    /**
     * Start connection attempt `gen` on the ONE client. The state listener carries `gen`, so a
     * callback from an attempt that has since been superseded is ignored by the queue (#1514).
     */
    private void connect(final int gen) {
        try {
            startConnection(gen);
        } catch (RuntimeException e) {
            // `startConnection` calls `Context.bindService` outside any catch (javap,
            // `BillingClientImpl.zzbl`), so a SecurityException escapes it. Left alone, the queue
            // stays `connecting` and every later call waits behind an attempt that never reports —
            // silently, on the RECONNECT path, since Billing swallows a disconnect listener's throw.
            // ⚠️ This SETTLES, it does not RECOVER: Billing set the client to CONNECTING before the
            // bind and resets nothing on the throw, so later calls hit startConnection's "already
            // connecting" branch and are rejected at once, until relaunch. Rebuilding the client here
            // would drop an open sheet's PurchasesUpdatedListener, so a reject is the chosen floor.
            List<Pending> failed;
            synchronized (lock) { failed = queue.onConnectFailed(gen); }
            Log.e(TAG, "startConnection threw (attempt " + gen + ") — rejecting " + failed.size() + " queued call(s)", e);
            BillingResult unavailable = BillingResult.newBuilder()
                .setResponseCode(BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE)
                .setDebugMessage("could not start the billing connection: " + e)
                .build();
            IapCore.drainEach(failed,
                p -> rejectWithBilling(p.call, "billing unavailable: " + unavailable.getDebugMessage(), unavailable),
                (p, t) -> settleOnThrow(p.call, "withBilling reject", t));
        }
    }

    private void startConnection(final int gen) {
        billing.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                List<Pending> batch;
                BillingClient client;
                synchronized (lock) {
                    batch = queue.onSetupFinished(gen);
                    client = billing;
                }
                boolean ok = result.getResponseCode() == BillingClient.BillingResponseCode.OK;
                Log.i(TAG, "onBillingSetupFinished: attempt=" + gen + " code=" + result.getResponseCode()
                    + " msg=" + result.getDebugMessage() + " draining=" + batch.size());
                // Each item isolated: a throw from one block used to end this loop, and — this being
                // a Billing listener — vanish, stranding the rest of the batch (#1514).
                IapCore.drainEach(batch, p -> {
                    if (ok) p.block.run(client);
                    // Structured too, and this is the one that matters most for the shelf: every
                    // method reaches the store through this queue, so `products()` — whose failure
                    // Court reports as `store_products_failed` — has no other reject path (#499).
                    else rejectWithBilling(p.call, "billing unavailable: " + result.getDebugMessage(), result);
                }, (p, e) -> settleOnThrow(p.call, "withBilling drain", e));
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Play drops the connection freely (Store updates, low memory). AFTER setup that is
                // routine and nothing is queued: the next call reconnects the SAME client. MID-setup
                // it used to strand every queued call, because nothing guarantees a setup callback
                // for an attempt that disconnects — so reconnect once, then reject (#1514).
                IapCore.ConnectionQueue.Disconnect<Pending> d;
                synchronized (lock) { d = queue.onDisconnected(gen); }
                switch (d.action) {
                    case IGNORE:
                        Log.w(TAG, "onBillingServiceDisconnected (attempt " + gen + ") — next call will reconnect");
                        break;
                    case RECONNECT:
                        Log.w(TAG, "onBillingServiceDisconnected mid-setup (attempt " + gen
                            + ") — reconnecting once as attempt " + d.generation);
                        connect(d.generation);
                        break;
                    case REJECT:
                        Log.w(TAG, "onBillingServiceDisconnected mid-setup again (attempt " + gen
                            + ") — rejecting " + d.rejected.size() + " queued call(s)");
                        BillingResult disconnected = BillingResult.newBuilder()
                            .setResponseCode(BillingClient.BillingResponseCode.SERVICE_DISCONNECTED)
                            .setDebugMessage("the billing service disconnected twice during setup")
                            .build();
                        IapCore.drainEach(d.rejected,
                            p -> rejectWithBilling(p.call, "billing unavailable: " + disconnected.getDebugMessage(), disconnected),
                            (p, e) -> settleOnThrow(p.call, "withBilling reject", e));
                        break;
                }
            }
        });
    }

    /**
     * Run a Billing callback body so that a throw SETTLES its call instead of vanishing (#1514).
     *
     * ⚠️ Every Billing listener needs this, not just the ones that look risky: Play Billing runs
     * its query/consume/acknowledge listeners inside `ExecutorService.submit`, so a throw is captured
     * in the Future and never surfaces — no crash, no log — and its own 30s timeout is skipped because
     * the future is done. (Setup/disconnect listeners are caught and only logged.)
     * An unguarded throw is a PluginCall that never settles. `nativeSettleEveryPark.test.ts` fails if a
     * listener goes unwrapped.
     *
     * ⚠️ Deliberately NOT used for `purchasesUpdatedListener`: that one runs on MAIN, so a throw
     * there is a crash rather than a hang, and it can hold a MATCHED, PAID delivery — rejecting it
     * would tell a paying player the purchase failed.
     */
    private void guarded(PluginCall call, String where, Runnable body) {
        try {
            body.run();
        } catch (RuntimeException e) {
            settleOnThrow(call, where, e);
        }
    }

    /**
     * Settle `call` after its body threw. `unpark` first: it is identity-checked, so it is a no-op
     * unless `call` is the parked purchase — and a purchase body that throws has not opened a sheet
     * (nothing runs after a successful `launchBillingFlow`, and a throw escaping it means no flow
     * started), so a reject cannot misreport money that moved.
     */
    private void settleOnThrow(PluginCall call, String where, RuntimeException e) {
        Log.e(TAG, where + " threw — rejecting the call rather than leaving it hung (#1514)", e);
        unpark(call);
        try {
            call.reject(where + " failed: " + e);
        } catch (RuntimeException again) {
            Log.w(TAG, where + ": rejecting after the throw failed too", again);
        }
    }

    // ── Methods ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void isAvailable(PluginCall call) {
        withBilling(call, client -> {
            JSObject r = new JSObject();
            r.put("available", client.isReady());
            call.resolve(r);
        });
    }

    /**
     * Reject with a DIAGNOSIS, not just prose (#499).
     *
     * `getDebugMessage()` alone reads the same for a store outage, a lapsed merchant agreement and
     * a developer-error config fault — and on the shelf path it is the only record of which it was.
     *
     * ⚠️ Capacitor does NOT flatten the `data` argument onto the JS Error: the 4-arg
     * `PluginCall.reject` does `errorResult.put("data", data)`, and `native-bridge.js` copies only
     * the payload's top-level keys across. So JS sees `error.code` as an own property and this
     * detail one level down at `error.data.storeError` — which is where `describeStoreError` in
     * the engine reads it. Change the nesting here and that reader goes silently blind.
     */
    private void rejectWithBilling(PluginCall call, String message, BillingResult result) {
        int code = result.getResponseCode();
        JSObject detail = new JSObject();
        detail.put("domain", "BillingResponseCode");
        detail.put("code", code);
        detail.put("description", result.getDebugMessage());
        JSObject data = new JSObject();
        data.put("storeError", detail);
        call.reject(message + " (code " + code + ")", IapCore.rejectCode(code), null, data);
    }

    /** ⚠️ `@PluginMethod` is what puts this in `PluginHandle`'s method index — without it the
     *  method exists but Capacitor cannot dispatch to it, and every JS call fails with
     *  `"ModokiIap.products() is not implemented on android"`. It was missing from this method
     *  alone (every sibling had it) since the plugin's first commit, so Court's shelf could never
     *  price anything on Android and emitted `store_products_failed` on every open. */
    @PluginMethod
    public void products(PluginCall call) {
        List<String> inapp = stringList(call, "inapp");
        List<String> subs = stringList(call, "subs");
        if (inapp.isEmpty() && subs.isEmpty()) {
            JSObject r = new JSObject();
            r.put("products", new JSArray());
            call.resolve(r);
            return;
        }

        withBilling(call, client -> {
            // Android must query one-time products and subscriptions SEPARATELY — a single query
            // cannot mix product types. Two queries, joined once both land. The two listeners run
            // CONCURRENTLY on Billing's pool, so they must not share a list (#1517), and a branch
            // that throws must still settle the call (#1514): that is IapCore.Join.
            final IapCore.Join<JSObject> join = new IapCore.Join<>(
                (inapp.isEmpty() ? 0 : 1) + (subs.isEmpty() ? 0 : 1),
                items -> {
                    JSObject r = new JSObject();
                    r.put("products", toArray(items));
                    call.resolve(r);
                },
                e -> settleOnThrow(call, "products", e)
            );

            if (!inapp.isEmpty()) {
                queryDetails(client, inapp, BillingClient.ProductType.INAPP, join);
            }
            if (!subs.isEmpty()) {
                queryDetails(client, subs, BillingClient.ProductType.SUBS, join);
            }
        });
    }

    private void queryDetails(
        BillingClient client,
        List<String> ids,
        String type,
        IapCore.Join<JSObject> join
    ) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(
                QueryProductDetailsParams.Product
                    .newBuilder()
                    .setProductId(id)
                    .setProductType(type)
                    .build()
            );
        }
        client.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (billingResult, result) -> join.branch(() -> {
                Log.i(TAG, "queryProductDetails(" + type + "): code=" + billingResult.getResponseCode()
                    + " msg=" + billingResult.getDebugMessage()
                    + " found=" + result.getProductDetailsList().size()
                    + " asked=" + ids);
                List<JSObject> mine = new ArrayList<>();
                // An id the store does not know is simply omitted — a typo'd product should
                // degrade to "not for sale", not take down the whole store screen.
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (ProductDetails d : result.getProductDetailsList()) {
                        mine.add(serializeProduct(d));
                    }
                }
                return mine;
            })
        );
    }

    private JSObject serializeProduct(ProductDetails d) {
        JSObject o = new JSObject();
        o.put("id", d.getProductId());
        o.put("title", d.getTitle());
        o.put("description", d.getDescription());

        String price = "";
        ProductDetails.OneTimePurchaseOfferDetails oneTime = d.getOneTimePurchaseOfferDetails();
        if (oneTime != null) {
            price = oneTime.getFormattedPrice();
        } else if (d.getSubscriptionOfferDetails() != null && !d.getSubscriptionOfferDetails().isEmpty()) {
            List<ProductDetails.PricingPhase> phases = d
                .getSubscriptionOfferDetails()
                .get(0)
                .getPricingPhases()
                .getPricingPhaseList();
            if (!phases.isEmpty()) {
                // Phase 0 is what the player pays FIRST — an intro/trial price when one exists.
                // That is the honest number to show beside a Subscribe button.
                price = phases.get(0).getFormattedPrice();
            }
        }
        o.put("displayPrice", price);
        return o;
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        final String productId = call.getString("productId");
        final String kind = call.getString("kind", "consumable");
        if (productId == null) {
            call.reject("productId is required");
            return;
        }
        final String type = "subscription".equals(kind) ? BillingClient.ProductType.SUBS : BillingClient.ProductType.INAPP;

        withBilling(call, client -> {
            List<QueryProductDetailsParams.Product> products = new ArrayList<>();
            products.add(
                QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(type).build()
            );
            client.queryProductDetailsAsync(
                QueryProductDetailsParams.newBuilder().setProductList(products).build(),
                (billingResult, result) -> guarded(call, "purchase", () -> {
                    List<ProductDetails> list = result.getProductDetailsList();
                    // ⚠️ These two are DIFFERENT failures and must not share a message (#499). A
                    // non-OK response means the store did not answer — SERVICE_UNAVAILABLE(2) or
                    // NETWORK_ERROR(12) are the common ones — and calling that "unknown product"
                    // tells the player and the log that a product they can see on the shelf does
                    // not exist, which is the exact misdiagnosis this issue exists to kill. It is
                    // also the worst place for it: this is the PURCHASE path, so unlike
                    // consume/acknowledge the structured payload is actually read.
                    if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        rejectWithBilling(call, "could not look up " + productId + ": "
                            + billingResult.getDebugMessage(), billingResult);
                        return;
                    }
                    // OK but nothing returned: genuinely not offered here. The response code is
                    // OK(0), so attaching it as a classification would be worse than the prose —
                    // it names a success. Matches the iOS arm, which also rejects with prose alone.
                    if (list.isEmpty()) {
                        call.reject("unknown product: " + productId);
                        return;
                    }
                    ProductDetails details = list.get(0);

                    BillingFlowParams.ProductDetailsParams.Builder pdp = BillingFlowParams.ProductDetailsParams
                        .newBuilder()
                        .setProductDetails(details);

                    if (BillingClient.ProductType.SUBS.equals(type)) {
                        // A subscription MUST carry an offer token; without one the flow is
                        // rejected. Prefer the authored plan, else the first available offer.
                        String planId = call.getString("planId");
                        String token = null;
                        if (details.getSubscriptionOfferDetails() != null) {
                            for (ProductDetails.SubscriptionOfferDetails o : details.getSubscriptionOfferDetails()) {
                                if (token == null || (planId != null && planId.equals(o.getBasePlanId()))) {
                                    token = o.getOfferToken();
                                }
                            }
                        }
                        if (token == null) {
                            call.reject("no subscription offer available for " + productId);
                            return;
                        }
                        pdp.setOfferToken(token);
                    }

                    List<BillingFlowParams.ProductDetailsParams> flow = new ArrayList<>();
                    flow.add(pdp.build());
                    // Built BEFORE the park, so a build that throws settles through guarded() with
                    // nothing parked. Likewise the Activity: checked here rather than letting
                    // launchBillingFlow throw on a null one after the slot is taken (#1514).
                    BillingFlowParams flowParams = BillingFlowParams.newBuilder().setProductDetailsParamsList(flow).build();
                    final android.app.Activity activity = getActivity();
                    if (activity == null) {
                        call.reject("no foreground activity to show the purchase sheet on");
                        return;
                    }

                    // Park the call: Play reports the purchase through the listener, not here.
                    // ⚠️ ONE flow at a time. There is a single awaiting slot, so a second
                    // purchase() arriving before the first is delivered used to overwrite it —
                    // and the loser's PluginCall, already setKeepAlive(true), became unreachable
                    // from any field. Nothing could ever resolve or reject it, so its JS promise
                    // hung FOREVER: a double-tapped Buy button left `await purchase(...)` pending
                    // for the life of the process. Play only runs one billing flow anyway, so
                    // refusing is both correct and what the store would do.
                    // Register the reload listener BEFORE the call becomes reachable from it.
                    // See ensureWebViewListener() for why this cannot live in load(). Deliberately
                    // OUTSIDE the monitor below: it calls into the Bridge, and holding `lock`
                    // across a foreign call is how deadlocks get written.
                    ensureWebViewListener();
                    // ⚠️ Check-and-park is ONE atomic step. This runs on a Play Billing pool
                    // thread (see the field comments), so two purchase() calls can reach here at
                    // the same instant; unsynchronised, both would read the slot as free and the
                    // loser would park a setKeepAlive(true) call reachable from nothing — the
                    // "hung FOREVER" failure the comment above describes, which the guard was
                    // added to prevent and which a non-atomic guard does not.
                    synchronized (lock) {
                        if (awaitingPurchase != null) {
                            call.reject("a purchase is already in progress (" + awaitingProductId + ")");
                            return;
                        }
                        awaitingPurchase = call;
                        awaitingProductId = productId;
                    }
                    call.setKeepAlive(true);

                    Log.i(TAG, "launchBillingFlow: product=" + productId + " type=" + type);
                    // A throw from here settles through guarded(), which unparks first: no sheet
                    // opened, so the reject cannot misreport a purchase (#1514).
                    BillingResult launch = client.launchBillingFlow(activity, flowParams);
                    if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        unpark(call);
                        rejectWithBilling(call, "could not open the purchase sheet: " + launch.getDebugMessage(), launch);
                    }
                })
            );
        });
    }

    @PluginMethod
    public void unfinished(PluginCall call) {
        // queryPurchasesAsync returns every purchase NOT yet CONSUMED, answered from Google's record
        // rather than anything local. ⚠️ That is wider than "unfinished" (#1183): an ACKNOWLEDGED
        // non-consumable or active subscription is never consumed, so it comes back on every launch,
        // where iOS never re-delivers a finished transaction. A game's grant hook for one re-runs
        // every launch — see docs/iap.md § 2.
        queryAll(call, false);
    }

    @PluginMethod
    public void entitlements(PluginCall call) {
        queryAll(call, true);
    }

    /** Query both product types and merge. `entitlementsOnly` drops PENDING purchases, which are
     *  not owned by anyone until the money actually moves. */
    private void queryAll(PluginCall call, boolean entitlementsOnly) {
        withBilling(call, client -> {
            // Same join as products(): two concurrent listeners, one once-settling merge (#1514,
            // #1517). A lost element here is an owned entitlement reading as NOT owned.
            final IapCore.Join<JSObject> join = new IapCore.Join<>(
                2,
                items -> {
                    JSObject r = new JSObject();
                    r.put("transactions", toArray(items));
                    call.resolve(r);
                },
                e -> settleOnThrow(call, entitlementsOnly ? "entitlements" : "unfinished", e)
            );
            for (String type : new String[] { BillingClient.ProductType.INAPP, BillingClient.ProductType.SUBS }) {
                client.queryPurchasesAsync(
                    QueryPurchasesParams.newBuilder().setProductType(type).build(),
                    (billingResult, purchases) -> join.branch(() -> {
                        Log.i(TAG, "queryPurchases(" + type + "): code=" + billingResult.getResponseCode()
                            + " count=" + purchases.size() + " entitlementsOnly=" + entitlementsOnly);
                        List<JSObject> mine = new ArrayList<>();
                        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                            for (Purchase p : purchases) {
                                boolean purchased = p.getPurchaseState() == Purchase.PurchaseState.PURCHASED;
                                if (entitlementsOnly && !purchased) continue;
                                mine.add(serialize(p));
                            }
                        }
                        return mine;
                    })
                );
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        final String token = call.getString("purchaseToken");
        final String kind = call.getString("kind", "consumable");
        if (token == null) {
            call.reject("purchaseToken is required on Android");
            return;
        }

        withBilling(call, client -> {
            if ("consumable".equals(kind)) {
                // Destructive: after this the store forgets the purchase entirely. Only reached
                // because JS has confirmed the grant is durable.
                client.consumeAsync(
                    ConsumeParams.newBuilder().setPurchaseToken(token).build(),
                    (billingResult, outToken) -> guarded(call, "consume", () -> {
                        Log.i(TAG, "consumeAsync: code=" + billingResult.getResponseCode()
                            + " msg=" + billingResult.getDebugMessage());
                        // ITEM_NOT_OWNED means it was already consumed — idempotent success, which
                        // the engine's recovery path relies on.
                        int c = billingResult.getResponseCode();
                        if (c == BillingClient.BillingResponseCode.OK || c == BillingClient.BillingResponseCode.ITEM_NOT_OWNED) {
                            call.resolve();
                        } else {
                            rejectWithBilling(call, "consume failed: " + billingResult.getDebugMessage(), billingResult);
                        }
                    })
                );
            } else {
                acknowledgeToken(client, call, token);
            }
        });
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        final String token = call.getString("purchaseToken");
        if (token == null) {
            // iOS sends no token; a shared JS contract means this is reachable with nothing to do.
            call.resolve();
            return;
        }
        withBilling(call, client -> acknowledgeToken(client, call, token));
    }

    private void acknowledgeToken(BillingClient client, PluginCall call, String token) {
        client.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
            billingResult -> guarded(call, "acknowledge", () -> {
                int c = billingResult.getResponseCode();
                Log.i(TAG, "acknowledgePurchase: code=" + c + " msg=" + billingResult.getDebugMessage());
                // Already acknowledged is success — acknowledging twice is expected on a recovery
                // pass and must not surface as an error.
                if (c == BillingClient.BillingResponseCode.OK || c == BillingClient.BillingResponseCode.ITEM_NOT_OWNED) {
                    call.resolve();
                } else {
                    rejectWithBilling(call, "acknowledge failed: " + billingResult.getDebugMessage(), billingResult);
                }
            })
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static JSArray toArray(List<JSObject> items) {
        JSArray a = new JSArray();
        for (JSObject o : items) a.put(o);
        return a;
    }

    private List<String> stringList(PluginCall call, String key) {
        List<String> out = new ArrayList<>();
        JSArray arr = call.getArray(key);
        if (arr == null) return out;
        try {
            for (Object o : arr.toList()) {
                if (o instanceof String) out.add((String) o);
            }
        } catch (Exception ignored) {
            // A malformed array is treated as empty rather than fatal: the caller gets "no
            // products", which is a state the engine already handles.
        }
        return out;
    }
}
