package com.modokiengine.capacitor.system;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;

@CapacitorPlugin(name = "ModokiSystem")
public class ModokiSystemPlugin extends Plugin {

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        String target = call.getString("target", "app");
        Context context = getContext();
        String packageName = context.getPackageName();

        // An app-settings URI cannot express either page: both are ACTION intents, which is why
        // this is native at all rather than a link the WebView hands to the system.
        Intent details = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null));
        Intent intent = details;
        if ("notifications".equals(target) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, packageName);
        }

        JSObject ret = new JSObject();
        ret.put("opened", start(intent) || (intent != details && start(details)));
        call.resolve(ret);
    }

    // A web page in the default browser (#1196). https only: a VIEW intent would also resolve
    // `intent:`, `tel:` or another app's custom scheme, which an authored link must never reach.
    // No <queries> entry is needed — startActivity is called directly and a device with no
    // browser surfaces as ActivityNotFoundException, which start() turns into false.
    @PluginMethod
    public void openUrl(PluginCall call) {
        String raw = call.getString("url");
        Uri uri = raw == null ? null : Uri.parse(raw);
        boolean openable = uri != null
            && "https".equalsIgnoreCase(uri.getScheme())
            && uri.getHost() != null
            && !uri.getHost().isEmpty();

        JSObject ret = new JSObject();
        ret.put("opened", openable && start(new Intent(Intent.ACTION_VIEW, uri)));
        call.resolve(ret);
    }

    // Plain text on the system clipboard (#1398) — a player ID the player pastes into a support
    // email. Native because a WebView clipboard write needs the tap's user activation, which an
    // engine-dispatched action cannot promise. Android 13+ shows its own "Copied" confirmation.
    @PluginMethod
    public void copyText(PluginCall call) {
        String text = call.getString("text");
        JSObject ret = new JSObject();
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (text == null || text.isEmpty() || clipboard == null) {
            ret.put("copied", false);
            call.resolve(ret);
            return;
        }
        try {
            clipboard.setPrimaryClip(ClipData.newPlainText("text", text));
            ret.put("copied", true);
        } catch (RuntimeException e) {
            // A background app or a restricted profile can refuse the write.
            ret.put("copied", false);
        }
        call.resolve(ret);
    }

    // The Play In-App Review flow (#939). Two async steps: request the ReviewInfo, then launch it.
    // `requested` means only that Play accepted the launch — it never reports whether a dialog was
    // shown or a review written, and it silently does nothing once its own quota is spent. Any
    // failure (no Play services, a sideloaded build, an internal Play error) resolves false rather
    // than rejecting, so the caller needs no platform branch.
    @PluginMethod
    public void requestReview(PluginCall call) {
        final android.app.Activity activity = getActivity();
        if (activity == null) {
            resolveRequested(call, false);
            return;
        }
        try {
            final ReviewManager manager = ReviewManagerFactory.create(getContext());
            manager.requestReviewFlow().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) {
                    resolveRequested(call, false);
                    return;
                }
                ReviewInfo info = task.getResult();
                manager.launchReviewFlow(activity, info)
                    .addOnCompleteListener(flow -> resolveRequested(call, flow.isSuccessful()));
            });
        } catch (Exception e) {
            resolveRequested(call, false);
        }
    }

    private void resolveRequested(PluginCall call, boolean requested) {
        JSObject ret = new JSObject();
        ret.put("requested", requested);
        call.resolve(ret);
    }

    private boolean start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    // The backup-excluded key-value store is iOS-only (#1271): on Android the whole app's backup is
    // off (#1267), so PlayerPrefs stays on SharedPreferences and the engine never calls these. They
    // exist so the plugin's JS contract dispatches somewhere on every platform, and say why they fail.
    private static final String KV_IOS_ONLY =
        "The backup-excluded store is iOS-only; Android keeps PlayerPrefs in SharedPreferences with backup off.";

    @PluginMethod
    public void kvGetAll(PluginCall call) {
        call.unavailable(KV_IOS_ONLY);
    }

    @PluginMethod
    public void kvSet(PluginCall call) {
        call.unavailable(KV_IOS_ONLY);
    }

    @PluginMethod
    public void kvRemove(PluginCall call) {
        call.unavailable(KV_IOS_ONLY);
    }

    @PluginMethod
    public void kvInfo(PluginCall call) {
        call.unavailable(KV_IOS_ONLY);
    }
}
