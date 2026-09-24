package com.modokiengine.capacitor.applovinmax;

import android.app.Activity;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.applovin.mediation.MaxAd;
import com.applovin.mediation.MaxAdExpirationListener;
import com.applovin.mediation.MaxAdFormat;
import com.applovin.mediation.MaxAdListener;
import com.applovin.mediation.MaxAdRevenueListener;
import com.applovin.mediation.MaxAdViewAdListener;
import com.applovin.mediation.MaxAdViewConfiguration;
import com.applovin.mediation.MaxError;
import com.applovin.mediation.MaxReward;
import com.applovin.mediation.MaxRewardedAdListener;
import com.applovin.mediation.ads.MaxAdView;
import com.applovin.mediation.ads.MaxInterstitialAd;
import com.applovin.mediation.ads.MaxRewardedAd;
import com.applovin.sdk.AppLovinPrivacySettings;
import com.applovin.sdk.AppLovinSdk;
import com.applovin.sdk.AppLovinSdkInitializationConfiguration;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.ump.ConsentDebugSettings;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.ArrayList;
import java.util.List;

/**
 * ⚠️ Threading: every field below is read and written on the UI thread only. Plugin methods arrive on
 * Capacitor's background thread and hop to it; MAX delivers its callbacks there.
 */
@CapacitorPlugin(name = "ApplovinMax")
public class ApplovinMaxPlugin extends Plugin implements MaxAdViewAdListener, MaxAdListener, MaxRewardedAdListener, MaxAdRevenueListener, MaxAdExpirationListener {

    /** Hosts the banner: pinned to the bottom (or top) of the content view, padded by the system bars. */
    private FrameLayout bannerHost;
    private MaxAdView bannerAd;
    /** The banner's last load failed, so the next `showBanner` re-loads rather than just resuming refresh. */
    private boolean bannerLoadFailed = false;
    /** The size last sent as `bannerLayout`, in dp. */
    private int reportedBannerWidthDp = 0;
    private int reportedBannerHeightDp = 0;
    private MaxAdView mrecAd;
    private MaxInterstitialAd interstitialAd;
    private MaxRewardedAd rewardedAd;
    /** The `load*` call waiting for its ad's `onAdLoaded` / `onAdLoadFailed` — see `settleLoad`. */
    private PluginCall pendingInterstitialLoad;
    private PluginCall pendingRewardedLoad;
    /**
     * `initialize` runs ONCE per app PROCESS: MAX drops the listener of a second initialise issued while the
     * first is still running ("already initialized … Ignoring", #1507), so every call waits here and the one
     * completion settles them all. STATIC because MAX's own init state is per process and this plugin instance
     * is not — a recreated Activity builds a new Bridge (a webview reload does not). Main thread only.
     */
    private static final int INIT_IDLE = 0, INIT_RUNNING = 1, INIT_DONE = 2;
    private static int initState = INIT_IDLE;
    private static final List<PluginCall> pendingInitCalls = new ArrayList<>();

    // MARK: - Helpers

    /** A LEADER is what MAX serves through a banner unit on a tablet; to the caller it is the same slot. */
    private static String formatName(MaxAdFormat format) {
        if (format == MaxAdFormat.BANNER || format == MaxAdFormat.LEADER) return "banner";
        if (format == MaxAdFormat.MREC) return "mrec";
        if (format == MaxAdFormat.INTERSTITIAL) return "interstitial";
        if (format == MaxAdFormat.REWARDED) return "rewarded";
        return "unknown";
    }

    /** `onAdLoadFailed` carries only the unit id, so the format comes from which of OUR instances owns it. */
    private String formatName(String adUnitId) {
        if (interstitialAd != null && adUnitId.equals(interstitialAd.getAdUnitId())) return "interstitial";
        if (rewardedAd != null && adUnitId.equals(rewardedAd.getAdUnitId())) return "rewarded";
        if (bannerAd != null && adUnitId.equals(bannerAd.getAdUnitId())) return "banner";
        if (mrecAd != null && adUnitId.equals(mrecAd.getAdUnitId())) return "mrec";
        return "unknown";
    }

    private JSObject adInfoToJson(MaxAd ad) {
        JSObject obj = new JSObject();
        obj.put("adUnitId", ad.getAdUnitId());
        obj.put("format", formatName(ad.getFormat()));
        obj.put("networkName", ad.getNetworkName());
        // MAX reports every network's revenue in US dollars, major units.
        obj.put("revenue", ad.getRevenue());
        obj.put("currency", "USD");
        obj.put("revenuePrecision", ad.getRevenuePrecision());
        obj.put("creativeId", ad.getCreativeId() != null ? ad.getCreativeId() : "");
        obj.put("placement", ad.getPlacement() != null ? ad.getPlacement() : "");
        return obj;
    }

    private static List<String> stringList(PluginCall call, String key) {
        List<String> out = new ArrayList<>();
        JSArray array = call.getArray(key);
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, null);
            if (value != null) out.add(value);
        }
        return out;
    }

    // MARK: - Banner

    /** The anchored adaptive height, in dp, for a banner `widthPx` wide. */
    private int bannerHeightDpFor(int widthPx) {
        float density = getContext().getResources().getDisplayMetrics().density;
        int widthDp = Math.round(widthPx / density);
        if (widthDp <= 0 || bannerAd == null) return 0;
        return bannerAd.getAdFormat().getAdaptiveSize(widthDp, getContext()).getHeight();
    }

    /**
     * Size the ad view to the adaptive height for the width the host actually has, and report the size
     * when it changed. Called on every host layout, so rotation and a resized window reach the banner.
     */
    private void applyBannerSize() {
        if (bannerHost == null || bannerAd == null) return;
        int widthPx = bannerHost.getWidth() - bannerHost.getPaddingLeft() - bannerHost.getPaddingRight();
        int heightDp = bannerHeightDpFor(widthPx);
        if (heightDp <= 0) return;
        float density = getContext().getResources().getDisplayMetrics().density;
        int heightPx = Math.round(heightDp * density);
        ViewGroup.LayoutParams lp = bannerAd.getLayoutParams();
        if (lp != null && lp.height != heightPx) {
            lp.height = heightPx;
            bannerAd.setLayoutParams(lp);
        }
        int widthDp = Math.round(widthPx / density);
        if (widthDp != reportedBannerWidthDp || heightDp != reportedBannerHeightDp) {
            reportedBannerWidthDp = widthDp;
            reportedBannerHeightDp = heightDp;
            JSObject data = new JSObject();
            data.put("heightPx", heightDp);
            data.put("widthPx", widthDp);
            notifyListeners("bannerLayout", data);
        }
    }

    @PluginMethod
    public void showBanner(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        String position = call.getString("position", "bottom");
        Activity activity = getActivity();

        activity.runOnUiThread(() -> {
            if (bannerAd != null) {
                bannerHost.setVisibility(View.VISIBLE);
                if (bannerLoadFailed) {
                    bannerLoadFailed = false;
                    bannerAd.loadAd();
                }
                // Always: a load does not resume a refresh that `hideBanner` or a failure paused.
                bannerAd.startAutoRefresh();
            } else {
                boolean top = "top".equals(position);
                ViewGroup content = activity.findViewById(android.R.id.content);

                bannerAd = new MaxAdView(
                    adUnitId,
                    MaxAdViewConfiguration.builder().setAdaptiveType(MaxAdViewConfiguration.AdaptiveType.ANCHORED).build()
                );
                // Without this, `stopAutoRefresh` does nothing until the first ad has loaded, and a manual
                // `loadAd` after a stop is refused — both of which the hide / re-load-after-failure paths
                // need (AppLovin's documented stop → loadAd → startAutoRefresh sequence). A refresh already
                // in flight when the banner is hidden still completes, and may still report a failure.
                bannerAd.setExtraParameter("allow_pause_auto_refresh_immediately", "true");
                bannerAd.setListener(this);
                bannerAd.setRevenueListener(this);

                bannerHost = new FrameLayout(activity);
                FrameLayout.LayoutParams hostParams = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                hostParams.gravity = top ? Gravity.TOP : Gravity.BOTTOM;
                bannerHost.setLayoutParams(hostParams);

                // The first height, from the content view's current width, so the resolve below carries a
                // real value; `applyBannerSize` corrects it on the host's own layout.
                int initialHeightPx = Math.round(
                    bannerHeightDpFor(content.getWidth()) * activity.getResources().getDisplayMetrics().density);
                bannerAd.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, initialHeightPx > 0 ? initialHeightPx : ViewGroup.LayoutParams.WRAP_CONTENT));
                bannerHost.addView(bannerAd);

                // Edge-to-edge (Android 15+ always): the window draws under the system bars, so the host
                // pads itself by them. On an older, inset window these insets arrive already consumed
                // (0), so the same code is a no-op there.
                ViewCompat.setOnApplyWindowInsetsListener(bannerHost, (v, insets) -> {
                    Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                    v.setPadding(bars.left, top ? bars.top : 0, bars.right, top ? 0 : bars.bottom);
                    // New side insets narrow the banner without changing the host's own width.
                    v.post(this::applyBannerSize);
                    return insets;
                });
                // A size change from inside a layout pass is applied on the next frame, not re-entrantly.
                bannerHost.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
                    if (r - l != or - ol) v.post(this::applyBannerSize);
                });

                content.addView(bannerHost);
                ViewCompat.requestApplyInsets(bannerHost);
                bannerLoadFailed = false;
                bannerAd.loadAd();
            }
            JSObject result = ok();
            int heightDp = reportedBannerHeightDp;
            if (heightDp <= 0 && bannerAd != null && bannerAd.getLayoutParams() != null && bannerAd.getLayoutParams().height > 0) {
                heightDp = Math.round(bannerAd.getLayoutParams().height / activity.getResources().getDisplayMetrics().density);
            }
            result.put("heightPx", heightDp);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void hideBanner(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) {
                bannerHost.setVisibility(View.GONE);
                bannerAd.stopAutoRefresh();
            }
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void destroyBanner(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) {
                bannerAd.setListener(null);
                bannerAd.setRevenueListener(null);
                bannerAd.destroy();
                ViewGroup parent = (ViewGroup) bannerHost.getParent();
                if (parent != null) parent.removeView(bannerHost);
            }
            bannerAd = null;
            bannerHost = null;
            bannerLoadFailed = false;
            reportedBannerWidthDp = 0;
            reportedBannerHeightDp = 0;
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void setBannerBackgroundColor(PluginCall call) {
        String color = call.getString("color", "#000000");
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) {
                try { bannerAd.setBackgroundColor(Color.parseColor(color)); } catch (Exception ignored) {}
            }
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void setBannerPlacement(PluginCall call) {
        String placement = call.getString("placement", "");
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) bannerAd.setPlacement(placement);
            call.resolve(ok());
        });
    }

    // MARK: - MREC

    @PluginMethod
    public void showMRec(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        Activity activity = getActivity();

        activity.runOnUiThread(() -> {
            if (mrecAd == null) {
                mrecAd = new MaxAdView(adUnitId, MaxAdFormat.MREC, activity);
                mrecAd.setListener(this);
                mrecAd.setRevenueListener(this);

                float density = activity.getResources().getDisplayMetrics().density;
                int w = (int) (300 * density);
                int h = (int) (250 * density);
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(w, h);
                params.gravity = Gravity.CENTER;
                mrecAd.setLayoutParams(params);

                ViewGroup rootView = activity.findViewById(android.R.id.content);
                rootView.addView(mrecAd);
            }
            mrecAd.loadAd();
            mrecAd.setVisibility(View.VISIBLE);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void hideMRec(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (mrecAd != null) mrecAd.setVisibility(View.GONE);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void destroyMRec(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (mrecAd != null) {
                mrecAd.destroy();
                ViewGroup parent = (ViewGroup) mrecAd.getParent();
                if (parent != null) parent.removeView(mrecAd);
                mrecAd = null;
            }
            call.resolve(ok());
        });
    }

    // MARK: - Fullscreen loads

    /**
     * Settle a pending `load*` call. A load RESOLVES on `onAdLoaded` and REJECTS on `onAdLoadFailed`, so the
     * caller awaits the ad itself instead of racing its own listener against the call.
     */
    private void settleLoad(String format, MaxError error, String rejectMessage, String rejectCode) {
        PluginCall call;
        if ("interstitial".equals(format)) {
            call = pendingInterstitialLoad;
            pendingInterstitialLoad = null;
        } else if ("rewarded".equals(format)) {
            call = pendingRewardedLoad;
            pendingRewardedLoad = null;
        } else {
            return;
        }
        if (call == null) return;
        if (error != null) call.reject(error.getMessage(), String.valueOf(error.getCode()));
        else if (rejectMessage != null) call.reject(rejectMessage, rejectCode);
        else call.resolve(ok());
    }

    // MARK: - Interstitial

    @PluginMethod
    public void loadInterstitial(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        getActivity().runOnUiThread(() -> {
            settleLoad("interstitial", null, "a newer loadInterstitial replaced this one", "superseded");
            // MAX IGNORES a load while its ad is on screen — no callback at all — so the call would never
            // settle. Reachable: the lifecycle's show timeout can schedule a preload while a late-presenting
            // ad is still up. Refuse it; the caller's back-off retries.
            if (interstitialAd != null && adUnitId.equals(interstitialAd.getAdUnitId()) && interstitialAd.isShowing()) {
                call.reject("the interstitial is on screen; load again after it is dismissed", "showing");
                return;
            }
            // One instance per unit id, re-used for every load — MAX's own pattern.
            if (interstitialAd == null || !adUnitId.equals(interstitialAd.getAdUnitId())) {
                if (interstitialAd != null) interstitialAd.destroy();
                interstitialAd = new MaxInterstitialAd(adUnitId, getActivity());
                interstitialAd.setListener(this);
                interstitialAd.setRevenueListener(this);
                // A SUCCESSFUL expiry reload is reported only here, never as `onAdLoaded` — see `onExpiredAdReloaded`.
                interstitialAd.setExpirationListener(this);
            }
            // Already loaded: settle now (MAX would re-send `onAdLoaded` for the cached ad; this does not rely on it).
            if (interstitialAd.isReady()) {
                call.resolve(ok());
                return;
            }
            pendingInterstitialLoad = call;
            interstitialAd.loadAd();
        });
    }

    @PluginMethod
    public void destroyInterstitial(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            settleLoad("interstitial", null, "the interstitial was destroyed", "destroyed");
            if (interstitialAd != null) {
                interstitialAd.destroy();
                interstitialAd = null;
            }
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void showInterstitial(PluginCall call) {
        String placement = call.getString("placement");
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            if (interstitialAd != null && interstitialAd.isReady()) {
                if (placement != null) interstitialAd.showAd(placement, getActivity());
                else interstitialAd.showAd(getActivity());
                result.put("shown", true);
            } else {
                result.put("shown", false);
                result.put("reason", "not ready");
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setInterstitialExtraParameter(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        getActivity().runOnUiThread(() -> {
            if (interstitialAd != null) interstitialAd.setExtraParameter(key, value);
            call.resolve(ok());
        });
    }

    // MARK: - Rewarded

    @PluginMethod
    public void loadRewardedAd(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        getActivity().runOnUiThread(() -> {
            settleLoad("rewarded", null, "a newer loadRewardedAd replaced this one", "superseded");
            // See loadInterstitial: MAX ignores a load while its ad is on screen, and the call would hang.
            if (rewardedAd != null && adUnitId.equals(rewardedAd.getAdUnitId()) && rewardedAd.isShowing()) {
                call.reject("the rewarded ad is on screen; load again after it is dismissed", "showing");
                return;
            }
            rewardedAd = MaxRewardedAd.getInstance(adUnitId, getActivity());
            rewardedAd.setListener(this);
            rewardedAd.setRevenueListener(this);
            rewardedAd.setExpirationListener(this);
            // See loadInterstitial.
            if (rewardedAd.isReady()) {
                call.resolve(ok());
                return;
            }
            pendingRewardedLoad = call;
            rewardedAd.loadAd();
        });
    }

    @PluginMethod
    public void showRewardedAd(PluginCall call) {
        String placement = call.getString("placement");
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            if (rewardedAd != null && rewardedAd.isReady()) {
                if (placement != null) rewardedAd.showAd(placement, getActivity());
                else rewardedAd.showAd(getActivity());
                result.put("shown", true);
            } else {
                result.put("shown", false);
                result.put("reason", "not ready");
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setRewardedExtraParameter(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        getActivity().runOnUiThread(() -> {
            if (rewardedAd != null) rewardedAd.setExtraParameter(key, value);
            call.resolve(ok());
        });
    }

    // MARK: - Consent (Google UMP)

    private static String consentStatusString(int status) {
        switch (status) {
            case ConsentInformation.ConsentStatus.REQUIRED: return "REQUIRED";
            case ConsentInformation.ConsentStatus.NOT_REQUIRED: return "NOT_REQUIRED";
            case ConsentInformation.ConsentStatus.OBTAINED: return "OBTAINED";
            default: return "UNKNOWN";
        }
    }

    private JSObject consentInfo(boolean includeFormAvailability) {
        ConsentInformation info = UserMessagingPlatform.getConsentInformation(getContext());
        JSObject result = new JSObject();
        result.put("status", consentStatusString(info.getConsentStatus()));
        result.put("canRequestAds", info.canRequestAds());
        result.put("privacyOptionsRequired",
            info.getPrivacyOptionsRequirementStatus() == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED);
        if (includeFormAvailability) result.put("isConsentFormAvailable", info.isConsentFormAvailable());
        return result;
    }

    @PluginMethod
    public void requestConsentInfo(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity to request consent info from");
            return;
        }
        ConsentDebugSettings.Builder debug = new ConsentDebugSettings.Builder(getContext());
        for (String id : stringList(call, "testDeviceIdentifiers")) debug.addTestDeviceHashedId(id);
        // UMP's values: 1 = EEA, 2 = not EEA. Anything else leaves the real geography in charge.
        String geography = call.getString("debugGeography");
        if ("eea".equals(geography)) debug.setDebugGeography(1);
        else if ("not_eea".equals(geography)) debug.setDebugGeography(2);
        ConsentRequestParameters params = new ConsentRequestParameters.Builder()
            .setConsentDebugSettings(debug.build())
            .setTagForUnderAgeOfConsent(Boolean.TRUE.equals(call.getBoolean("tagForUnderAgeOfConsent", false)))
            .build();
        activity.runOnUiThread(() ->
            UserMessagingPlatform.getConsentInformation(getContext()).requestConsentInfoUpdate(
                activity,
                params,
                () -> call.resolve(consentInfo(true)),
                formError -> call.reject("Request consent info failed: " + formError.getMessage())
            )
        );
    }

    @PluginMethod
    public void showConsentForm(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity to show the consent form from");
            return;
        }
        if (!UserMessagingPlatform.getConsentInformation(getContext()).isConsentFormAvailable()) {
            call.reject("Consent form not available");
            return;
        }
        activity.runOnUiThread(() ->
            UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                if (formError != null) call.reject("Consent form failed: " + formError.getMessage());
                else call.resolve(consentInfo(false));
            })
        );
    }

    @PluginMethod
    public void showPrivacyOptionsForm(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity to show the privacy options form from");
            return;
        }
        activity.runOnUiThread(() ->
            UserMessagingPlatform.showPrivacyOptionsForm(activity, formError -> {
                if (formError != null) call.reject("Privacy options form failed: " + formError.getMessage());
                else call.resolve();
            })
        );
    }

    @PluginMethod
    public void setHasUserConsent(PluginCall call) {
        Boolean consent = call.getBoolean("consent", false);
        AppLovinPrivacySettings.setHasUserConsent(consent, getContext());
        call.resolve(ok());
    }

    @PluginMethod
    public void setDoNotSell(PluginCall call) {
        Boolean doNotSell = call.getBoolean("doNotSell", false);
        AppLovinPrivacySettings.setDoNotSell(doNotSell, getContext());
        call.resolve(ok());
    }

    // MARK: - SDK Settings

    @PluginMethod
    public void initialize(PluginCall call) {
        String sdkKey = call.getString("sdkKey", "");
        List<String> testDevices = stringList(call, "testDeviceAdvertisingIds");
        getActivity().runOnUiThread(() -> {
            AppLovinSdk sdk = AppLovinSdk.getInstance(getContext());
            // A later call's sdkKey and test devices are ignored, as MAX itself ignores them after the first.
            if (initState == INIT_DONE || sdk.isInitialized()) {
                initState = INIT_DONE;
                call.resolve(ok());
                return;
            }
            pendingInitCalls.add(call);
            if (initState == INIT_RUNNING) return;
            initState = INIT_RUNNING;
            AppLovinSdkInitializationConfiguration initConfig =
                AppLovinSdkInitializationConfiguration.builder(sdkKey, getContext())
                    .setMediationProvider("max")
                    // SDK 13 takes test devices only here — there is no setter after init.
                    .setTestDeviceAdvertisingIds(testDevices)
                    .build();
            // The main looper rather than the starting Activity's handler: the fields are process-wide, not that Activity's.
            sdk.initialize(initConfig, config -> new Handler(Looper.getMainLooper()).post(() -> {
                initState = INIT_DONE;
                List<PluginCall> calls = new ArrayList<>(pendingInitCalls);
                pendingInitCalls.clear();
                for (PluginCall waiting : calls) waiting.resolve(ok());
            }));
        });
    }

    @PluginMethod
    public void setUserId(PluginCall call) {
        String userId = call.getString("userId", "");
        AppLovinSdk.getInstance(getContext()).getSettings().setUserIdentifier(userId);
        call.resolve(ok());
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        Boolean muted = call.getBoolean("muted", false);
        AppLovinSdk.getInstance(getContext()).getSettings().setMuted(muted);
        call.resolve(ok());
    }

    @PluginMethod
    public void setVerboseLogging(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled", false);
        AppLovinSdk.getInstance(getContext()).getSettings().setVerboseLogging(enabled);
        call.resolve(ok());
    }

    @PluginMethod
    public void showMediationDebugger(PluginCall call) {
        AppLovinSdk.getInstance(getContext()).showMediationDebugger();
        call.resolve(ok());
    }

    @PluginMethod
    public void isReady(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("initialized", AppLovinSdk.getInstance(getContext()).isInitialized());
            result.put("interstitialReady", interstitialAd != null && interstitialAd.isReady());
            result.put("rewardedReady", rewardedAd != null && rewardedAd.isReady());
            call.resolve(result);
        });
    }

    // MARK: - Ad Callbacks

    @Override public void onAdLoaded(MaxAd ad) {
        String format = formatName(ad.getFormat());
        if ("banner".equals(format)) bannerLoadFailed = false;
        settleLoad(format, null, null, null);
        notifyListeners("adLoaded", adInfoToJson(ad));
    }
    @Override public void onAdLoadFailed(String adUnitId, MaxError error) {
        String format = formatName(adUnitId);
        if ("banner".equals(format) && bannerAd != null) {
            // Take the view down, as AdMob's SDK does on a failure: the lifecycle now believes no banner is
            // up (`bannerFailed`), so a view left behind could never be hidden by it. The next `showBanner`
            // re-loads.
            bannerLoadFailed = true;
            bannerHost.setVisibility(View.GONE);
            bannerAd.stopAutoRefresh();
        }
        settleLoad(format, error, null, null);
        JSObject data = new JSObject();
        data.put("adUnitId", adUnitId);
        data.put("format", format);
        data.put("errorCode", error.getCode());
        data.put("errorMessage", error.getMessage());
        notifyListeners("adLoadFailed", data);
    }
    @Override public void onAdDisplayed(MaxAd ad) { notifyListeners("adDisplayed", adInfoToJson(ad)); }
    // No reload here: the caller owns when to load the next ad (it preloads on dismissal, with its own
    // back-off), and a second owner would double every load.
    @Override public void onAdHidden(MaxAd ad) { notifyListeners("adHidden", adInfoToJson(ad)); }
    @Override public void onAdClicked(MaxAd ad) { notifyListeners("adClicked", adInfoToJson(ad)); }
    @Override public void onAdDisplayFailed(MaxAd ad, MaxError error) {
        JSObject data = new JSObject();
        data.put("adUnitId", ad.getAdUnitId());
        data.put("format", formatName(ad.getFormat()));
        data.put("errorCode", error.getCode());
        data.put("errorMessage", error.getMessage());
        notifyListeners("adDisplayFailed", data);
    }
    /**
     * MAX reloads an expired fullscreen ad by itself, staying READY throughout, and reports a SUCCESSFUL reload
     * only here — not as `onAdLoaded` (SDK 13.6.4 `MaxFullscreenAdImpl`). A load issued during that reload is
     * dropped without a callback ("An ad is already loaded"), so without this the parked call would never
     * settle (#1507). A FAILED reload arrives as the ordinary `onAdLoadFailed`.
     */
    @Override public void onExpiredAdReloaded(MaxAd expiredAd, MaxAd newAd) {
        settleLoad(formatName(newAd.getFormat()), null, null, null);
    }
    @Override public void onAdExpanded(MaxAd ad) {}
    @Override public void onAdCollapsed(MaxAd ad) {}
    @Override public void onAdRevenuePaid(MaxAd ad) { notifyListeners("adRevenuePaid", adInfoToJson(ad)); }
    @Override public void onUserRewarded(MaxAd ad, MaxReward reward) {
        JSObject data = new JSObject();
        data.put("adUnitId", ad.getAdUnitId());
        data.put("label", reward.getLabel());
        data.put("amount", reward.getAmount());
        // retainUntilConsumed: true — a webview reload tears down the JS realm and its
        // subscription along with it; with no listener attached, Plugin queues this event in
        // `retainedEventArguments` (which `Bridge.reset()` does not clear) instead of dropping
        // it, and it drains into the next realm's subscribe the moment that subscription is
        // added. It cannot double-deliver: retention only happens when the listener list is
        // empty, so an event that DID have a listener is never retained. Same mechanism as
        // ModokiIapPlugin's `purchasesUpdated` (#586) — but this one matters MORE: there is no
        // durable ledger and no reconcile() step behind a reward. If this event is truly dropped
        // (not merely delayed by retention), the player watched the entire rewarded video and
        // receives nothing, with no code path anywhere able to detect or recover it later.
        notifyListeners("adRewardEarned", data, true);
    }

    private JSObject ok() {
        JSObject r = new JSObject();
        r.put("ok", true);
        return r;
    }
}
