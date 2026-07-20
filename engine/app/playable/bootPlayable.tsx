/** Playable boot (Phase 5) — the entry the app calls in a `VITE_PLAYABLE` build. Holds AUDIO until
 *  the ad is BOTH viewable AND the user has interacted (so it never auto-plays on load / off-screen —
 *  both are network rejection reasons) and mounts the CTA overlay once the ad is on-screen. NOTE: the
 *  game world + render loop are NOT paused off-screen — main.tsx mounts <App/> unconditionally and its
 *  rAF pipeline starts immediately; only audio (and the overlay mount) is gated. Imported ONLY behind
 *  `__MODOKI_PLAYABLE__` in main.tsx, so it (and the MRAID/overlay code) DCEs out of every normal build.
 *
 *  The store URL is baked as `__MODOKI_PLAYABLE_CLICK_URL__` (from build.playableClickUrl). */

import { createRoot } from 'react-dom/client';
import { setAudioMuted, isAudioMuted } from '@modoki/engine/runtime';
import { whenReady, whenViewable, onViewableChange } from './mraid';
import { armPlayableEndLatch } from './playableEnd';
import { PlayableOverlay } from './PlayableOverlay';

export async function bootPlayable(clickUrl: string): Promise<void> {
  // Read-only audio-mute probe for the browser smoke (smoke-playable.mjs) to assert "muted on load,
  // unmuted after tap". Playable-only surface (this whole module DCEs out of a normal build).
  (globalThis as Record<string, unknown>).__playableAudioMuted = isAudioMuted;

  // Latch `playable:end` from the very start: the game runs (muted) during the off-screen hold and
  // can reach win/lose before the overlay mounts, so catch that event now or the end-card is lost
  // until the time cap. The overlay reads the latch on mount.
  armPlayableEndLatch();

  // Audio is audible ONLY when the ad is BOTH viewable AND the user has interacted at least once —
  // so it NEVER auto-plays on load. Off-screen audio is a network rejection reason, and the browser's
  // own autoplay policy is NOT a reliable "wait for a tap" gate (a raw file:// open or a lenient
  // webview can start the AudioContext with no gesture), so we hold the master mute explicitly until
  // both conditions hold. Master mute persists across AudioContext (re)creation, so it also gags the
  // autoplay `music` AudioSource. Playable-only (bootPlayable is behind __MODOKI_PLAYABLE__).
  let viewable = false;
  let interacted = false;
  const applyMute = () => setAudioMuted(!(viewable && interacted));
  setAudioMuted(true);
  // Ongoing viewability sync (re-mutes if the ad scrolls back off-screen mid-play). No-op standalone.
  onViewableChange((v) => { viewable = v; applyMute(); });
  // First real user gesture → interacted (also what App.tsx uses to resume the AudioContext).
  const GESTURES = ['pointerdown', 'touchstart', 'keydown'] as const;
  const onFirstGesture = () => {
    interacted = true;
    applyMute();
    for (const ev of GESTURES) window.removeEventListener(ev, onFirstGesture);
  };
  for (const ev of GESTURES) window.addEventListener(ev, onFirstGesture);

  // Hold until the ad container says it's ready + on-screen. Both resolve immediately when
  // standalone (our preview / a plain browser), so the artifact is still runnable. On success mark
  // viewable + re-evaluate; a rejecting gate simply leaves audio muted (never viewable) — still
  // mounts the CTA below.
  try {
    await whenReady();
    await whenViewable();
    viewable = true;
    applyMute();
  } catch { /* container error — audio stays gated (muted); overlay still mounts */ }

  // ISOLATE the game's stacking context. The engine layers its renderers with z-index (the 2D
  // Canvas host is `position:absolute; z-index:2`, UI above it). `#root` is not positioned, so
  // WITHOUT isolation those inner z-indexes leak into the <body> stacking context and paint OVER
  // anything the ad container appends to <body> at z-index:auto — namely AppLovin's close/info
  // chrome AND its "You have successfully clicked" confirmation banner (verified in AppLovin's
  // preview: the banner is a z-index:auto <span> on document.body, so our z-index:2 canvas hid it
  // even though the CTA's `mraid.open` fired correctly). `isolation:isolate` gives #root its own
  // stacking context, collapsing the whole game to ONE z-auto <body> layer that sits UNDER the
  // container's chrome — so the container's UI (and the click confirmation) is finally visible.
  document.getElementById('root')?.style.setProperty('isolation', 'isolate');

  // Mount the overlay in its OWN root appended to <body> — above #root, unaffected by a
  // scene swap or a stalled game world. Isolate it for the SAME reason: the CTA pill / end-card
  // use a very high z-index to sit above the game, and that must stay CONTAINED so it can't cover
  // the container's chrome. Isolated, the host is one z-auto <body> layer — above the game via DOM
  // order, below the container's chrome and its later-appended confirmation banner.
  let host = document.getElementById('playable-overlay');
  if (!host) {
    host = document.createElement('div');
    host.id = 'playable-overlay';
    document.body.appendChild(host);
  }
  host.style.isolation = 'isolate';
  createRoot(host).render(<PlayableOverlay clickUrl={clickUrl} />);
}
