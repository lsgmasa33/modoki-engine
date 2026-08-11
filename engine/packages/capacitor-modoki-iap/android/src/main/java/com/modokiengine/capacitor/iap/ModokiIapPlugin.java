package com.modokiengine.capacitor.iap;

import android.util.Log;

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
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

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

    private BillingClient billing;

    /** The call awaiting launchBillingFlow's async result. Play delivers the purchase through the
     *  listener, not the launch call, so the call has to be parked. */
    private PluginCall awaitingPurchase;
    private String awaitingProductId;

    private final PurchasesUpdatedListener purchasesUpdatedListener = (billingResult, purchases) -> {
        int code = billingResult.getResponseCode();
        Log.i(TAG, "onPurchasesUpdated: code=" + code + " msg=" + billingResult.getDebugMessage()
            + " count=" + (purchases == null ? "null" : String.valueOf(purchases.size()))
            + " parkedCall=" + (awaitingPurchase != null));
        PluginCall call = awaitingPurchase;

        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            if (call != null) {
                awaitingPurchase = null;
                JSObject r = new JSObject();
                r.put("transaction", JSObject.NULL);
                call.resolve(r);
            }
            return;
        }

        if (code != BillingClient.BillingResponseCode.OK || purchases == null) {
            if (call != null) {
                awaitingPurchase = null;
                call.reject("purchase failed: " + billingResult.getDebugMessage() + " (code " + code + ")");
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
        notifyListeners("purchasesUpdated", event);

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
                awaitingPurchase = null;
                awaitingProductId = null;
                JSObject r = new JSObject();
                r.put("transaction", serialize(match));
                call.resolve(r);
            } else {
                Log.i(TAG, "  delivery does not contain the awaited product (" + awaitingProductId
                    + ") — leaving the call parked rather than reporting a false cancel");
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
    private boolean connecting = false;
    private final List<Pending> waiting = new ArrayList<>();

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
        synchronized (lock) {
            if (billing != null && billing.isReady()) {
                ready = billing;
                Log.i(TAG, "withBilling: client already ready — running immediately");
            } else {
                waiting.add(new Pending(call, block));
                if (connecting) {
                    Log.i(TAG, "withBilling: connection in flight — queued (" + waiting.size() + " waiting)");
                    return;
                }
                connecting = true;
                Log.i(TAG, "withBilling: starting connection (" + waiting.size() + " waiting)");
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
            }
        }
        if (ready != null) { block.run(ready); return; }

        billing.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                List<Pending> batch;
                BillingClient client;
                synchronized (lock) {
                    connecting = false;
                    batch = new ArrayList<>(waiting);
                    waiting.clear();
                    client = billing;
                }
                boolean ok = result.getResponseCode() == BillingClient.BillingResponseCode.OK;
                Log.i(TAG, "onBillingSetupFinished: code=" + result.getResponseCode()
                    + " msg=" + result.getDebugMessage() + " draining=" + batch.size());
                for (Pending p : batch) {
                    if (ok) p.block.run(client);
                    else p.call.reject("billing unavailable: " + result.getDebugMessage());
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Play drops the connection freely (Store updates, low memory). Clear the flag so
                // the next call reconnects the SAME client; do not retry here, which would race
                // with that call and could drain the queue twice.
                Log.w(TAG, "onBillingServiceDisconnected — next call will reconnect");
                synchronized (lock) { connecting = false; }
            }
        });
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
            final JSArray out = new JSArray();
            // Android must query one-time products and subscriptions SEPARATELY — a single query
            // cannot mix product types. Two queries, joined once both land.
            final AtomicInteger remaining = new AtomicInteger((inapp.isEmpty() ? 0 : 1) + (subs.isEmpty() ? 0 : 1));

            if (!inapp.isEmpty()) {
                queryDetails(client, inapp, BillingClient.ProductType.INAPP, out, remaining, call);
            }
            if (!subs.isEmpty()) {
                queryDetails(client, subs, BillingClient.ProductType.SUBS, out, remaining, call);
            }
        });
    }

    private void queryDetails(
        BillingClient client,
        List<String> ids,
        String type,
        JSArray out,
        AtomicInteger remaining,
        PluginCall call
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
            (billingResult, result) -> {
                Log.i(TAG, "queryProductDetails(" + type + "): code=" + billingResult.getResponseCode()
                    + " msg=" + billingResult.getDebugMessage()
                    + " found=" + result.getProductDetailsList().size()
                    + " asked=" + ids + " remaining=" + (remaining.get() - 1));
                // An id the store does not know is simply omitted — a typo'd product should
                // degrade to "not for sale", not take down the whole store screen.
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    for (ProductDetails d : result.getProductDetailsList()) {
                        out.put(serializeProduct(d));
                    }
                }
                if (remaining.decrementAndGet() == 0) {
                    JSObject r = new JSObject();
                    r.put("products", out);
                    call.resolve(r);
                }
            }
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
                (billingResult, result) -> {
                    List<ProductDetails> list = result.getProductDetailsList();
                    if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK || list.isEmpty()) {
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

                    // Park the call: Play reports the purchase through the listener, not here.
                    // ⚠️ ONE flow at a time. There is a single awaiting slot, so a second
                    // purchase() arriving before the first is delivered used to overwrite it —
                    // and the loser's PluginCall, already setKeepAlive(true), became unreachable
                    // from any field. Nothing could ever resolve or reject it, so its JS promise
                    // hung FOREVER: a double-tapped Buy button left `await purchase(...)` pending
                    // for the life of the process. Play only runs one billing flow anyway, so
                    // refusing is both correct and what the store would do.
                    if (awaitingPurchase != null) {
                        call.reject("a purchase is already in progress (" + awaitingProductId + ")");
                        return;
                    }
                    awaitingPurchase = call;
                    awaitingProductId = productId;
                    call.setKeepAlive(true);

                    Log.i(TAG, "launchBillingFlow: product=" + productId + " type=" + type);
                    BillingResult launch = client.launchBillingFlow(
                        getActivity(),
                        BillingFlowParams.newBuilder().setProductDetailsParamsList(flow).build()
                    );
                    if (launch.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                        awaitingPurchase = null;
                        call.reject("could not open the purchase sheet: " + launch.getDebugMessage());
                    }
                }
            );
        });
    }

    @PluginMethod
    public void unfinished(PluginCall call) {
        // queryPurchasesAsync returns only purchases NOT yet consumed/acknowledged — which is
        // exactly "unfinished", and is answered from Google's record rather than anything local.
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
            final JSArray out = new JSArray();
            final AtomicInteger remaining = new AtomicInteger(2);
            for (String type : new String[] { BillingClient.ProductType.INAPP, BillingClient.ProductType.SUBS }) {
                client.queryPurchasesAsync(
                    QueryPurchasesParams.newBuilder().setProductType(type).build(),
                    (billingResult, purchases) -> {
                        Log.i(TAG, "queryPurchases(" + type + "): code=" + billingResult.getResponseCode()
                            + " count=" + purchases.size() + " entitlementsOnly=" + entitlementsOnly);
                        if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                            for (Purchase p : purchases) {
                                boolean purchased = p.getPurchaseState() == Purchase.PurchaseState.PURCHASED;
                                if (entitlementsOnly && !purchased) continue;
                                out.put(serialize(p));
                            }
                        }
                        if (remaining.decrementAndGet() == 0) {
                            JSObject r = new JSObject();
                            r.put("transactions", out);
                            call.resolve(r);
                        }
                    }
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
                    (billingResult, outToken) -> {
                        Log.i(TAG, "consumeAsync: code=" + billingResult.getResponseCode()
                            + " msg=" + billingResult.getDebugMessage());
                        // ITEM_NOT_OWNED means it was already consumed — idempotent success, which
                        // the engine's recovery path relies on.
                        int c = billingResult.getResponseCode();
                        if (c == BillingClient.BillingResponseCode.OK || c == BillingClient.BillingResponseCode.ITEM_NOT_OWNED) {
                            call.resolve();
                        } else {
                            call.reject("consume failed: " + billingResult.getDebugMessage());
                        }
                    }
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
            billingResult -> {
                int c = billingResult.getResponseCode();
                Log.i(TAG, "acknowledgePurchase: code=" + c + " msg=" + billingResult.getDebugMessage());
                // Already acknowledged is success — acknowledging twice is expected on a recovery
                // pass and must not surface as an error.
                if (c == BillingClient.BillingResponseCode.OK || c == BillingClient.BillingResponseCode.ITEM_NOT_OWNED) {
                    call.resolve();
                } else {
                    call.reject("acknowledge failed: " + billingResult.getDebugMessage());
                }
            }
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

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
