package com.modokiengine.capacitor.system;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;

import org.json.JSONException;
import org.json.JSONObject;

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
            // ⚠️ The outer try does NOT cover these listener bodies — they run later, on the main
            // thread, where an uncaught throw (launchReviewFlow on an Activity destroyed since) is
            // an app CRASH, and the call would never settle anyway (#1514). So the body resolves
            // false on a throw, the same answer as every other failure here. (The inner listener
            // only reads `isSuccessful()`, which cannot throw.)
            manager.requestReviewFlow().addOnCompleteListener(task -> {
                try {
                    if (!task.isSuccessful()) {
                        resolveRequested(call, false);
                        return;
                    }
                    ReviewInfo info = task.getResult();
                    manager.launchReviewFlow(activity, info)
                        .addOnCompleteListener(flow -> resolveRequested(call, flow.isSuccessful()));
                } catch (Exception e) {
                    resolveRequested(call, false);
                }
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

    // ── Haptic effects (#2103) ───────────────────────────────────────────────────────────────
    // @capacitor/haptics sends every preset as timed amplitude steps, which a motor renders as a
    // buzz. These two methods reach the vibrator's own predefined effects and primitives instead.
    // The names are the JS contract; which preset maps to which is authored on the engine side.

    private static final String[] HAPTIC_EFFECT_NAMES = { "CLICK", "DOUBLE_CLICK", "TICK", "HEAVY_CLICK" };
    private static final int[] HAPTIC_EFFECT_IDS = {
        VibrationEffect.EFFECT_CLICK, VibrationEffect.EFFECT_DOUBLE_CLICK,
        VibrationEffect.EFFECT_TICK, VibrationEffect.EFFECT_HEAVY_CLICK,
    };
    private static final String[] HAPTIC_PRIMITIVE_NAMES = {
        "CLICK", "THUD", "SPIN", "QUICK_RISE", "SLOW_RISE", "QUICK_FALL", "TICK", "LOW_TICK",
    };
    private static final int[] HAPTIC_PRIMITIVE_IDS = {
        VibrationEffect.Composition.PRIMITIVE_CLICK, VibrationEffect.Composition.PRIMITIVE_THUD,
        VibrationEffect.Composition.PRIMITIVE_SPIN, VibrationEffect.Composition.PRIMITIVE_QUICK_RISE,
        VibrationEffect.Composition.PRIMITIVE_SLOW_RISE, VibrationEffect.Composition.PRIMITIVE_QUICK_FALL,
        VibrationEffect.Composition.PRIMITIVE_TICK, VibrationEffect.Composition.PRIMITIVE_LOW_TICK,
    };

    private static int indexOf(String[] names, String name) {
        for (int i = 0; i < names.length; i++) {
            if (names[i].equals(name)) return i;
        }
        return -1;
    }

    // Null below Android 12: every native project is minSdk 31, but this library's own default is
    // lower, and the primitive constants above need 31.
    private Vibrator hapticVibrator() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        VibratorManager manager = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
        Vibrator vibrator = manager == null ? null : manager.getDefaultVibrator();
        return vibrator != null && vibrator.hasVibrator() ? vibrator : null;
    }

    @PluginMethod
    public void hapticCapabilities(PluginCall call) {
        JSArray effects = new JSArray();
        JSArray primitives = new JSArray();
        try {
            Vibrator vibrator = hapticVibrator();
            if (vibrator != null) {
                // Only a definite YES counts: UNKNOWN means the HAL could not say, and Android
                // then plays a generic fallback, which is the buzz this exists to avoid.
                int[] effectSupport = vibrator.areEffectsSupported(HAPTIC_EFFECT_IDS);
                for (int i = 0; i < effectSupport.length; i++) {
                    if (effectSupport[i] == Vibrator.VIBRATION_EFFECT_SUPPORT_YES) effects.put(HAPTIC_EFFECT_NAMES[i]);
                }
                boolean[] primitiveSupport = vibrator.arePrimitivesSupported(HAPTIC_PRIMITIVE_IDS);
                for (int i = 0; i < primitiveSupport.length; i++) {
                    if (primitiveSupport[i]) primitives.put(HAPTIC_PRIMITIVE_NAMES[i]);
                }
            }
        } catch (RuntimeException e) {
            // Report what was collected; an empty answer keeps the caller on its own path.
        }
        JSObject ret = new JSObject();
        ret.put("effects", effects);
        ret.put("primitives", primitives);
        call.resolve(ret);
    }

    @PluginMethod
    public void playHapticEffect(PluginCall call) {
        boolean played = false;
        try {
            Vibrator vibrator = hapticVibrator();
            VibrationEffect effect = vibrator == null ? null : buildHapticEffect(call, vibrator);
            if (effect != null) {
                boolean media = "media".equals(call.getString("usage", "touch"));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    int usage = media ? VibrationAttributes.USAGE_MEDIA : VibrationAttributes.USAGE_TOUCH;
                    vibrator.vibrate(effect, new VibrationAttributes.Builder().setUsage(usage).build());
                } else {
                    // Android 12: no VibrationAttributes overload, so the usage rides audio
                    // attributes. Sonification becomes the touch usage; what the media one becomes
                    // there is unverified (measured only on Android 14).
                    int usage = media ? AudioAttributes.USAGE_MEDIA : AudioAttributes.USAGE_ASSISTANCE_SONIFICATION;
                    vibrator.vibrate(effect, new AudioAttributes.Builder().setUsage(usage).build());
                }
                played = true;
            }
        } catch (JSONException | RuntimeException e) {
            // Malformed options or a refused vibrate: not played, and the caller falls back.
        }
        JSObject ret = new JSObject();
        ret.put("played", played);
        call.resolve(ret);
    }

    // Null when the request names something unknown or something this vibrator does not report as
    // supported. Checked here as well as by the caller: this is the last point before Android
    // would substitute its generic fallback.
    private VibrationEffect buildHapticEffect(PluginCall call, Vibrator vibrator) throws JSONException {
        String effectName = call.getString("effect");
        if (effectName != null) {
            int i = indexOf(HAPTIC_EFFECT_NAMES, effectName);
            if (i < 0) return null;
            int[] support = vibrator.areEffectsSupported(HAPTIC_EFFECT_IDS[i]);
            if (support[0] != Vibrator.VIBRATION_EFFECT_SUPPORT_YES) return null;
            return VibrationEffect.createPredefined(HAPTIC_EFFECT_IDS[i]);
        }
        JSArray primitives = call.getArray("primitives");
        if (primitives == null || primitives.length() == 0) return null;
        VibrationEffect.Composition composition = VibrationEffect.startComposition();
        for (int n = 0; n < primitives.length(); n++) {
            JSONObject primitive = primitives.getJSONObject(n);
            int i = indexOf(HAPTIC_PRIMITIVE_NAMES, primitive.optString("id"));
            if (i < 0 || !vibrator.areAllPrimitivesSupported(HAPTIC_PRIMITIVE_IDS[i])) return null;
            float scale = (float) Math.max(0, Math.min(1, primitive.optDouble("scale", 1)));
            int delayMs = Math.max(0, primitive.optInt("delayMs", 0));
            composition.addPrimitive(HAPTIC_PRIMITIVE_IDS[i], scale, delayMs);
        }
        return composition.compose();
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
