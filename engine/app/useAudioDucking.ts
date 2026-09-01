/** useAudioDucking — silences OUR music while another app's audio is playing (#548).
 *
 *  Its own module, and a SIBLING of `useAudioResumeRearm` rather than an extension of it, for two
 *  reasons: the re-arm is device-verified and load-bearing for #489, so ducking's failure modes
 *  must not be able to reach it; and this contract can then be pinned by a test without rendering
 *  the app shell (`App` is not exported and drags in routing + the lazy editor chunk).
 *
 *  What the OS gives us, and why BOTH halves are needed:
 *   - `secondaryAudioHint` — Apple's purpose-built `silenceSecondaryAudioHintNotification`, which
 *     fires `.begin` when another app starts primary audio and `.end` when it stops. It reports
 *     TRANSITIONS only, so on its own it cannot tell us the state we launched into.
 *   - `shouldSilenceSecondaryAudio()` — the snapshot that fills exactly that gap. Taken on mount,
 *     and again on every foreground, because the answer changes while we are backgrounded and no
 *     hint is delivered for a transition we slept through. It reads
 *     `secondaryAudioShouldBeSilencedHint`, the notification's documented companion, so both
 *     halves answer the same question (`isOtherAudioPlaying` is broader — see the plugin).
 *
 *  The decision itself lives in `shouldDuckMusic` (a pure module) — this hook only observes. */

import { useEffect } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import projectConfig from 'virtual:modoki-project-config';
import { setAudioMusicDucked, shouldDuckMusic } from '@modoki/engine/runtime';
import type { ModokiAudioPlugin } from 'capacitor-modoki-audio';

/** Resolved on FIRST USE, never at module scope — a top-level `registerPlugin(...)` is an
 *  import-time side effect, and merely importing this module would then touch Capacitor. Same
 *  reasoning (and the same scar) as `runtime/iap/capacitorStore.ts`. */
let plugin: ModokiAudioPlugin | null = null;
function audioSession(): ModokiAudioPlugin {
  if (!plugin) plugin = registerPlugin<ModokiAudioPlugin>('ModokiAudio');
  return plugin;
}

export function useAudioDucking() {
  useEffect(() => {
    // Web/editor: there is no AVAudioSession to observe, and the plugin's web stub would only
    // ever report `false`. Returning early keeps the browser path free of dead listeners.
    if (!Capacitor.isNativePlatform()) return;

    let cancelled = false; // cleanup may run before an async addListener resolves
    let otherAudioPlaying = false;
    let isForeground = true;
    /** Bumped by every snapshot AND every hint. A snapshot is async across the native bridge, so a
     *  hint can land while one is still in flight — and the hint is the FRESHER fact. Without this,
     *  the stale snapshot resolves last and wins: music un-ducks while Apple Music is playing, and
     *  stays wrong until the next hint or foreground. Found in review. */
    let snapshotGen = 0;
    const apply = () => {
      setAudioMusicDucked(shouldDuckMusic({ otherAudioPlaying, isForeground }));
    };

    const session = audioSession();
    // Category comes from project.config.json so a game can author it; the plugin also sets a
    // sane default in load(), so a rejected configure() degrades rather than leaving no category.
    void session
      .configure({ category: projectConfig.capacitor.audioSessionCategory })
      .catch(() => { /* keep the native default — never break boot over a mix policy */ });

    const snapshot = () => {
      const gen = ++snapshotGen;
      return session
        .shouldSilenceSecondaryAudio()
        .then(({ silence }) => {
          // Drop a result a hint (or a newer snapshot) has already superseded — see snapshotGen.
          if (cancelled || gen !== snapshotGen) return;
          otherAudioPlaying = silence;
          apply();
        })
        .catch(() => { /* an unavailable session is not a reason to brick audio */ });
    };
    void snapshot();

    let hintListener: { remove: () => void } | undefined;
    let appListener: { remove: () => void } | undefined;

    void session.addListener('secondaryAudioHint', ({ silence }) => {
      if (cancelled) return;
      snapshotGen++; // this is now the freshest fact — invalidate any in-flight snapshot
      otherAudioPlaying = silence;
      apply();
    }).then((h) => { if (cancelled) h.remove(); else hintListener = h; })
      // A missing/unimplemented plugin rejects here. Without this catch it becomes an
      // unhandledrejection, which globalErrors.ts reports to Crashlytics — one non-fatal per
      // launch. A plugin that is not there is a routine path, not an exceptional one (`ota.ts`
      // treats it the same way).
      .catch(() => { /* no session bridge — ducking is simply unavailable */ });

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (cancelled) return;
      isForeground = isActive;
      apply();
      // Re-observe on resume: a hint delivered while we were backgrounded is one we never saw,
      // so the snapshot — not the last hint — is the authority on the state we woke into.
      if (isActive) void snapshot();
    }).then((h) => { if (cancelled) h.remove(); else appListener = h; })
      .catch(() => { /* see above — a failed listener registration must not reach Crashlytics */ });

    return () => {
      cancelled = true;
      hintListener?.remove();
      appListener?.remove();
      // Never leave the music ducked behind us — the duck node persists across graph
      // recreation, so a torn-down hook that skipped this would silence music permanently.
      setAudioMusicDucked(false);
    };
  }, []);
}
