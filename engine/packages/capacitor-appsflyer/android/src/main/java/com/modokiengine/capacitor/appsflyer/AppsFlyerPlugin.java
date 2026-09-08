package com.modokiengine.capacitor.appsflyer;

import android.util.Log;
// ⚠️ SDK v7 MOVED these two out of `com.appsflyer` into `com.appsflyer.share`. That single
// change is what produced 13 compile errors on the v6 source: the unresolved listener made
// every one of its callbacks read as "does not override", and start()'s overload resolution
// failed too. It is a package move, not a redesign — see the v7 notes in attribution.md.
import com.appsflyer.share.AppsFlyerConsent;
import com.google.android.gms.ads.identifier.AdvertisingIdClient;
import com.appsflyer.AppsFlyerLib;
import com.appsflyer.share.AppsFlyerConversionListener;
import com.appsflyer.share.SessionReadyListener;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

@CapacitorPlugin(name = "AppsFlyerCap")
public class AppsFlyerPlugin extends Plugin {

    private static final String TAG = "AppsFlyerCap";

    // The Android SDK delivers conversion data asynchronously via a listener
    // registered at init() time, not a synchronous getter — so getConversionData()
    // returns whatever the listener has captured so far (empty until it fires).
    private final Map<String, Object> lastConversionData = new HashMap<>();

    // ⚠️ PROCESS-scoped guard against start() running twice. A webview reload (or a
    // realm-survived false-alarm recovery, engine/app/realmDeathBackstop.ts) re-runs the JS
    // boot effect in the SAME native process, calling initialize() then start() again —
    // registerSessionReadyListener stacks a NEW listener rather than replacing the old one.
    //
    // ⚠️ RECONCILED ON ANDROID (#654, 2026-09-04) — this guard is INERT for Launch counts, and
    // the evidence that once justified it is refuted AS AN ATTRIBUTION.
    //   #607 recorded, on THIS platform (Galaxy S22, versionCode 6029, PID 21451), a SECOND POST
    //   to launches.appsflyersdk.com ~100 s after the cold-boot one following a resume-reload,
    //   and read that as the reload's second start(). Re-measured on a S22 (versionCode 6290,
    //   SDK v7.0.1.386) with this guard ABSENT from the binary, driving the reload and the resume
    //   as SEPARATE events two minutes apart: the reload's start() posted NO Launch and no POST
    //   at all, while the resume posted one with no start() call involved. The POST #607 saw was
    //   real; the cause assigned to it was wrong — a resume-reload does both at once and its
    //   probe could not separate them.
    // The mechanism: AppsFlyer's Launch is driven by the FOREGROUND TRANSITION
    // (onBecameForeground, which alone is followed by "Starting session readiness evaluation"),
    // not by start(). A webview reload produces no foreground transition, so a second start()
    // lands inside an already-live session with nothing to trigger.
    // So the iOS finding ("a second start is a no-op") GENERALISES here rather than conflicting.
    // ⚠️ Keep the guard anyway: it still prevents a second registerSessionReadyListener, which is
    // cheap. But do NOT keep believing it prevents session inflation — with two listeners
    // registered, the resume still produced exactly ONE Launch.
    // iOS was measured separately (2026-09-05) and agrees on the OUTCOME: unguarded, a second
    // start() there — including one invoked directly rather than through a reload — posts no
    // Launch either. ⚠️ That does NOT establish the no-op is the SDK's own: the iOS plugin, like
    // this one, calls AppsFlyerLib.start() from INSIDE a session-ready listener, so the null
    // result is equally consistent with the listener never firing — which the readiness/foreground
    // coupling noted above makes the likelier of the two. Left unresolved on purpose.
    // Full run: attribution.md § "#607/#654 — the iOS leg measured, and both platforms agree".
    //
    // Plain (non-atomic) static boolean, deliberately: getAdvertisingId() below documents
    // that Capacitor's Bridge serializes every plugin method invocation onto one
    // HandlerThread("CapacitorPlugins"), so two calls to start() never race each other here —
    // synchronized/AtomicBoolean would guard against a concurrency hazard this plugin does
    // not have.
    //
    // ⚠️ Also latches across a stop(stopped:false) opt-back-in — AppsFlyer's documented re-enable
    // flow is stop(false) then a fresh start(), and that start() would hit this guard and do
    // nothing. Nothing calls stop from JS today, so this is a trap for whoever wires opt-out
    // rather than a live bug — clear the flag in stop() when that day comes.
    private static boolean sStarted = false;

    // MARK: - Initialize

    @PluginMethod
    public void initialize(PluginCall call) {
        String devKey = call.getString("devKey", "");
        boolean isDebug = Boolean.TRUE.equals(call.getBoolean("isDebug", false));

        AppsFlyerLib af = AppsFlyerLib.getInstance();
        af.setDebugLog(isDebug);

        // Android has no ATT/IDFA equivalent, so there is no wait-for-authorization
        // step here — that is iOS-only. See requestTrackingAuthorization().
        af.init(devKey, new AppsFlyerConversionListener() {
            @Override
            public void onConversionDataSuccess(Map<String, Object> data) {
                lastConversionData.clear();
                if (data != null) lastConversionData.putAll(data);
            }

            @Override
            public void onConversionDataFail(String error) {
                Log.w(TAG, "conversion data failed: " + error);
            }

            // ⚠️ v7 DROPPED onAppOpenAttribution / onAttributionFailure from this interface —
            // it is down to the two callbacks above. Those were the legacy deep-link
            // attribution hooks, superseded by Unified Deep Linking. This plugin never
            // consumed them, so removing the overrides loses nothing; a future deep-link
            // feature must use UDL rather than re-adding them.
        }, getContext());

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - Start

    @PluginMethod
    public void start(PluginCall call) {
        // v7 removed start(Context) — only start() and start(AppsFlyerRequestListener) remain.
        // Passing the Context is what produced "incompatible types: Context cannot be
        // converted to AppsFlyerRequestListener": it silently matched the listener overload.
        //
        // ⚠️ registerSessionReadyListener MUST come before start(), on Android exactly as on
        // iOS — v7 unified this across platforms. Calling start() alone COMPILES AND RUNS and
        // simply does not send the install: measured on an S22 2026-08-19, the log carried
        // "[SDK Lifecycle] WARNING: SessionReadyListener is not registered!" and no CONVERSION
        // task ever ran. The only 200 OK in that run was the config fetch from
        // cdn-settings.appsflyersdk.com, which is easy to misread as a healthy postback.
        //
        // ⚠️ sStarted (see its own comment) short-circuits a SECOND call in this process before
        // it reaches registerSessionReadyListener — a repeat call here, minutes apart across a
        // reload, would register a second listener sequentially rather than race the first one.
        if (sStarted) {
            JSObject alreadyStarted = new JSObject();
            alreadyStarted.put("ok", true);
            call.resolve(alreadyStarted);
            return;
        }
        sStarted = true;

        AppsFlyerLib.getInstance().registerSessionReadyListener(new SessionReadyListener() {
            @Override
            public void onSessionReady() {
                AppsFlyerLib.getInstance().start();
            }
        });

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - Events

    @PluginMethod
    public void logEvent(PluginCall call) {
        String eventName = call.getString("eventName", "");
        JSObject eventValues = call.getObject("eventValues");

        Map<String, Object> values = new HashMap<>();
        if (eventValues != null) {
            Iterator<String> keys = eventValues.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                values.put(key, eventValues.opt(key));
            }
        }

        AppsFlyerLib.getInstance().logEvent(getContext(), eventName, values);

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - Customer user id

    @PluginMethod
    public void setCustomerUserId(PluginCall call) {
        String userId = call.getString("userId", "");
        AppsFlyerLib.getInstance().setCustomerUserId(userId);

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - Device id

    @PluginMethod
    public void getAppsFlyerUID(PluginCall call) {
        String uid = AppsFlyerLib.getInstance().getAppsFlyerUID(getContext());
        JSObject result = new JSObject();
        result.put("uid", uid != null ? uid : "");
        call.resolve(result);
    }

    /**
     * The Google Advertising ID (GAID/AAID), read from Play Services.
     *
     * ⚠️ **Not from the AppsFlyer SDK** — it collects the GAID but exposes no getter, which is why
     * this used to reject and send the caller to AppsFlyer's raw-data report instead. Play
     * Services' own `AdvertisingIdClient` is the supported source, and
     * `play-services-ads-identifier` is already a declared dependency of this plugin, so this
     * costs no new artifact.
     *
     * ⚠️ **Runs on its own thread. `getAdvertisingIdInfo` is blocking and throws
     * `IllegalStateException` if called on the main thread** — Capacitor's threading is not
     * something to bet on, and a crash inside a diagnostic accessor would be an absurd way to lose
     * an app.
     *
     * Resolves a sentinel rather than rejecting, matching iOS and every other method in this
     * plugin: `available:false` covers no Play Services, a user who chose "Delete advertising ID"
     * (Android 12+ returns null or all-zeros), and limit-ad-tracking. Those are ordinary states,
     * not errors — and `available` is the flag to branch on, since an all-zero UUID reads as a real
     * id to anything doing a null check.
     */
    @PluginMethod
    public void getAdvertisingId(PluginCall call) {
        new Thread(() -> {
            String id = "";
            boolean limited = false;
            try {
                AdvertisingIdClient.Info info = AdvertisingIdClient.getAdvertisingIdInfo(getContext());
                if (info != null) {
                    id = info.getId() != null ? info.getId() : "";
                    limited = info.isLimitAdTrackingEnabled();
                }
            } catch (Exception e) {
                // No Play Services, a device that has none, or the user deleted the id. Not an
                // error worth failing the call over — `available:false` says it.
                // TAG, not a string literal: `adb logcat -s AppsFlyerCap` is the filter this
                // plugin's own convention implies, and a hardcoded tag hides this line from it —
                // so "GAID always unavailable" would debug as "the exception path never fires".
                Log.i(TAG, "getAdvertisingId unavailable: " + e.getMessage());
            }
            JSObject result = new JSObject();
            result.put("id", id);
            result.put("kind", "gaid");
            result.put("available", !id.isEmpty() && !ZERO_AD_ID.equals(id) && !limited);
            result.put("limitAdTracking", limited);

            // ⚠️ RESOLVE BACK ON CAPACITOR'S OWN THREAD, not this one. `Bridge` posts every plugin
            // call to a single `HandlerThread("CapacitorPlugins")` and every resolve in this
            // codebase has therefore been serialized on it. Resolving from an ad-hoc thread breaks
            // that: the reply travels through `androidx.webkit.JavaScriptReplyProxy`, whose class
            // is annotated `@UiThread`, so a `logEvent` resolving on the plugin thread while this
            // lookup is still waiting on Play Services (tens to hundreds of ms) would put two
            // threads into `postMessage` at once — a window that did not exist before this method.
            // `Bridge.execute` posts to that same handler, so the blocking work stays off the
            // shared thread while the reply goes back through the one door.
            Bridge bridge = getBridge();
            if (bridge != null) bridge.execute(() -> call.resolve(result));
            else call.resolve(result);
        }).start();
    }

    /** Android 12+ hands back this instead of null when the user deletes their advertising id. */
    private static final String ZERO_AD_ID = "00000000-0000-0000-0000-000000000000";

    // MARK: - Conversion data

    @PluginMethod
    public void getConversionData(PluginCall call) {
        JSObject data = new JSObject();
        for (Map.Entry<String, Object> entry : lastConversionData.entrySet()) {
            data.put(entry.getKey(), entry.getValue());
        }
        JSObject result = new JSObject();
        result.put("data", data);
        call.resolve(result);
    }

    // MARK: - Consent (DMA/GDPR)

    @PluginMethod
    public void setConsent(PluginCall call) {
        Boolean hasConsentForDataUsage = call.getBoolean("hasConsentForDataUsage");
        Boolean hasConsentForAdsPersonalization = call.getBoolean("hasConsentForAdsPersonalization");

        // v7 replaced forNonGDPRUser()/forGDPRUser(bool,bool) with a 4-Boolean constructor
        // (isUserSubjectToGDPR, dataUsage, adsPersonalization, adStorage) where null means
        // UNSPECIFIED — which is not the same claim as false.
        //
        // ⚠️ THE GUARD BELOW IS NOT DEFENSIVE PADDING — without it the two platforms disagree.
        // This method previously always called setConsentData, deriving isUserSubjectToGDPR
        // from "did the caller supply any field". So `setConsent({})` — no fields at all —
        // asserted isUserSubjectToGDPR=FALSE on Android, i.e. "this user is not subject to
        // GDPR", a substantive privacy claim manufactured from a call that supplied no
        // information. iOS, for the same input, called nothing and left the SDK's consent
        // state untouched. Same JS, different privacy posture per platform, and wrong in the
        // dangerous direction for a game intending to buy users in the EU.
        if (hasConsentForDataUsage == null && hasConsentForAdsPersonalization == null) {
            JSObject noop = new JSObject();
            noop.put("ok", true);
            call.resolve(noop);
            return;
        }

        AppsFlyerConsent consent = new AppsFlyerConsent(
            Boolean.TRUE,   // matches iOS: setting consent at all implies the GDPR path
            hasConsentForDataUsage,
            hasConsentForAdsPersonalization,
            null
        );
        AppsFlyerLib.getInstance().setConsentData(consent);

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - Stop / opt-out

    @PluginMethod
    public void stop(PluginCall call) {
        Boolean stopped = call.getBoolean("stopped", false);
        AppsFlyerLib.getInstance().stop(Boolean.TRUE.equals(stopped), getContext());

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    // MARK: - ATT (iOS only)

    @PluginMethod
    public void requestTrackingAuthorization(PluginCall call) {
        // Android has no App Tracking Transparency equivalent.
        JSObject result = new JSObject();
        result.put("status", "notSupported");
        call.resolve(result);
    }
}
