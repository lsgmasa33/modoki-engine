package com.modokiengine.capacitor.system;

import android.content.ActivityNotFoundException;
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
