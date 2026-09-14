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

    private boolean start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }
}
