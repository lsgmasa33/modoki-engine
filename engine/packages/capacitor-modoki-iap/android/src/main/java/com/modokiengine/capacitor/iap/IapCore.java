package com.modokiengine.capacitor.iap;

/**
 * Purchase-classification core — the Android half of the contract in
 * {@code test-vectors/iap-classification-vectors.json} (#971).
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
}
