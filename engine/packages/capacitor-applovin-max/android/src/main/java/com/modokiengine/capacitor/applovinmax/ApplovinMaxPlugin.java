package com.modokiengine.capacitor.applovinmax;

import android.app.Activity;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.applovin.mediation.MaxAd;
import com.applovin.mediation.MaxAdFormat;
import com.applovin.mediation.MaxAdListener;
import com.applovin.mediation.MaxAdRevenueListener;
import com.applovin.mediation.MaxAdViewAdListener;
import com.applovin.mediation.MaxError;
import com.applovin.mediation.MaxReward;
import com.applovin.mediation.MaxRewardedAdListener;
import com.applovin.mediation.ads.MaxAdView;
import com.applovin.mediation.ads.MaxInterstitialAd;
import com.applovin.mediation.ads.MaxRewardedAd;
import com.applovin.sdk.AppLovinPrivacySettings;
import com.applovin.sdk.AppLovinSdk;
import com.applovin.sdk.AppLovinSdkInitializationConfiguration;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "ApplovinMax")
public class ApplovinMaxPlugin extends Plugin implements MaxAdViewAdListener, MaxAdListener, MaxRewardedAdListener, MaxAdRevenueListener {

    private MaxAdView bannerAd;
    private MaxAdView mrecAd;
    private MaxInterstitialAd interstitialAd;
    private MaxRewardedAd rewardedAd;

    private JSObject adInfoToJson(MaxAd ad) {
        JSObject obj = new JSObject();
        obj.put("adUnitId", ad.getAdUnitId());
        obj.put("networkName", ad.getNetworkName());
        obj.put("revenue", ad.getRevenue());
        obj.put("revenuePrecision", ad.getRevenuePrecision());
        obj.put("creativeId", ad.getCreativeId() != null ? ad.getCreativeId() : "");
        obj.put("placement", ad.getPlacement() != null ? ad.getPlacement() : "");
        return obj;
    }

    // MARK: - Banner

    @PluginMethod
    public void showBanner(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        String position = call.getString("position", "bottom");
        Activity activity = getActivity();

        activity.runOnUiThread(() -> {
            if (bannerAd == null) {
                bannerAd = new MaxAdView(adUnitId, activity);
                bannerAd.setListener(this);
                bannerAd.setRevenueListener(this);

                int heightPx = (int) (50 * activity.getResources().getDisplayMetrics().density);
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, heightPx);
                params.gravity = "top".equals(position) ? Gravity.TOP : Gravity.BOTTOM;
                bannerAd.setLayoutParams(params);

                ViewGroup rootView = activity.findViewById(android.R.id.content);
                rootView.addView(bannerAd);
            }
            bannerAd.loadAd();
            bannerAd.setVisibility(View.VISIBLE);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void hideBanner(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) bannerAd.setVisibility(View.GONE);
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void destroyBanner(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (bannerAd != null) {
                bannerAd.destroy();
                ViewGroup parent = (ViewGroup) bannerAd.getParent();
                if (parent != null) parent.removeView(bannerAd);
                bannerAd = null;
            }
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
        if (bannerAd != null) bannerAd.setPlacement(placement);
        call.resolve(ok());
    }

    // MARK: - MREC

    @PluginMethod
    public void showMRec(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        Activity activity = getActivity();

        activity.runOnUiThread(() -> {
            if (mrecAd == null) {
                mrecAd = new MaxAdView(adUnitId, com.applovin.mediation.MaxAdFormat.MREC, activity);
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

    // MARK: - Interstitial

    @PluginMethod
    public void loadInterstitial(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        getActivity().runOnUiThread(() -> {
            // ⚠️ Deliberately NOT destroying the previous instance here. Court's ads.ts calls
            // showInterstitial() then immediately calls loadInterstitial() again to preload the
            // next one — and showInterstitial's promise resolves right after showAd() is invoked,
            // NOT after the ad is actually dismissed (onAdHidden fires later, once the player closes
            // it). So a destroy-before-reassign here runs while the PREVIOUS instance is still ON
            // SCREEN, tearing down its revenue listener (setRevenueListener below) mid-impression and
            // silently dropping that impression's onAdRevenuePaid. If a previous instance ever needs
            // destroying, do it through `destroyInterstitial` (used correctly by cleanupAds()) or by
            // moving the preload call to fire from the onAdHidden callback instead — never here.
            interstitialAd = new MaxInterstitialAd(adUnitId, getActivity());
            interstitialAd.setListener(this);
            interstitialAd.setRevenueListener(this);
            interstitialAd.loadAd();
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void destroyInterstitial(PluginCall call) {
        getActivity().runOnUiThread(() -> {
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
                if (placement != null) interstitialAd.showAd(placement);
                else interstitialAd.showAd();
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
        if (interstitialAd != null) interstitialAd.setExtraParameter(key, value);
        call.resolve(ok());
    }

    // MARK: - Rewarded

    @PluginMethod
    public void loadRewardedAd(PluginCall call) {
        String adUnitId = call.getString("adUnitId", "");
        getActivity().runOnUiThread(() -> {
            rewardedAd = MaxRewardedAd.getInstance(adUnitId, getActivity());
            rewardedAd.setListener(this);
            rewardedAd.setRevenueListener(this);
            rewardedAd.loadAd();
            call.resolve(ok());
        });
    }

    @PluginMethod
    public void showRewardedAd(PluginCall call) {
        String placement = call.getString("placement");
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            if (rewardedAd != null && rewardedAd.isReady()) {
                if (placement != null) rewardedAd.showAd(placement);
                else rewardedAd.showAd();
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
        if (rewardedAd != null) rewardedAd.setExtraParameter(key, value);
        call.resolve(ok());
    }

    // MARK: - Privacy

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

    @PluginMethod
    public void setIsAgeRestrictedUser(PluginCall call) {
        // setIsAgeRestrictedUser removed in AppLovin SDK 13.x — no-op for compatibility
        call.resolve(ok());
    }

    // MARK: - SDK Settings

    @PluginMethod
    public void initialize(PluginCall call) {
        String sdkKey = call.getString("sdkKey", "");
        AppLovinSdkInitializationConfiguration initConfig =
            AppLovinSdkInitializationConfiguration.builder(sdkKey, getContext())
                .setMediationProvider("max")
                .build();
        AppLovinSdk.getInstance(getContext()).initialize(initConfig, config -> {
            call.resolve(ok());
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
    public void setTestDeviceAdvertisingIds(PluginCall call) {
        // setTestDeviceAdvertisingIds removed in AppLovin SDK 13.x
        // Use MAX dashboard for test device configuration instead
        call.resolve(ok());
    }

    @PluginMethod
    public void showMediationDebugger(PluginCall call) {
        AppLovinSdk.getInstance(getContext()).showMediationDebugger();
        call.resolve(ok());
    }

    @PluginMethod
    public void isReady(PluginCall call) {
        JSObject result = new JSObject();
        result.put("initialized", AppLovinSdk.getInstance(getContext()).isInitialized());
        result.put("interstitialReady", interstitialAd != null && interstitialAd.isReady());
        result.put("rewardedReady", rewardedAd != null && rewardedAd.isReady());
        call.resolve(result);
    }

    // MARK: - Ad Callbacks

    @Override public void onAdLoaded(MaxAd ad) { notifyListeners("adLoaded", adInfoToJson(ad)); }
    @Override public void onAdLoadFailed(String adUnitId, MaxError error) {
        JSObject data = new JSObject();
        data.put("adUnitId", adUnitId);
        data.put("errorCode", error.getCode());
        data.put("errorMessage", error.getMessage());
        notifyListeners("adLoadFailed", data);
    }
    @Override public void onAdDisplayed(MaxAd ad) { notifyListeners("adDisplayed", adInfoToJson(ad)); }
    @Override public void onAdHidden(MaxAd ad) {
        if (ad.getFormat() == com.applovin.mediation.MaxAdFormat.INTERSTITIAL && interstitialAd != null) interstitialAd.loadAd();
        if (ad.getFormat() == com.applovin.mediation.MaxAdFormat.REWARDED && rewardedAd != null) rewardedAd.loadAd();
        notifyListeners("adHidden", adInfoToJson(ad));
    }
    @Override public void onAdClicked(MaxAd ad) { notifyListeners("adClicked", adInfoToJson(ad)); }
    @Override public void onAdDisplayFailed(MaxAd ad, MaxError error) {
        JSObject data = new JSObject();
        data.put("adUnitId", ad.getAdUnitId());
        data.put("errorCode", error.getCode());
        data.put("errorMessage", error.getMessage());
        notifyListeners("adLoadFailed", data);
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
