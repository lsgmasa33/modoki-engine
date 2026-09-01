package com.modokiengine.capacitor.audio;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android half of `capacitor-modoki-audio` (#548) — a PERMANENT no-op.
 *
 * Audio on Android is 100% WebView (Web Audio); there is no native audio code anywhere in this
 * repo, and Chromium — not this plugin — owns audio focus for whatever is playing in the
 * WebView. There is no `AVAudioSession` equivalent to bridge here, and no plan to add one: this
 * class exists only so the package is structurally complete (`cap sync` needs SOMETHING on both
 * platforms) and the shared `ModokiAudioPlugin` JS contract resolves the same shape everywhere.
 *
 * `configure()` is a no-op success. `shouldSilenceSecondaryAudio()` always answers `false` — this is the
 * honest default, since nothing here has any way to know otherwise — and `secondaryAudioHint` is
 * never emitted.
 */
@CapacitorPlugin(name = "ModokiAudio")
public class ModokiAudioPlugin extends Plugin {

    @PluginMethod
    public void configure(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void shouldSilenceSecondaryAudio(PluginCall call) {
        JSObject r = new JSObject();
        r.put("silence", false);
        call.resolve(r);
    }
}
