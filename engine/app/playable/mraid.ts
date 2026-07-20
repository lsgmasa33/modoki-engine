/** MRAID v2 shim — the playable-ad container contract (Phase 5). See
 *  docs/playable-export.md.
 *
 *  An ad network (AppLovin, ironSource, …) injects a global `window.mraid` and hosts the
 *  playable in a webview. The creative MUST: wait for the container to be READY before
 *  doing anything heavy, hold audio/gameplay until the ad is VIEWABLE (on-screen), route
 *  the install/CTA tap through `mraid.open(storeUrl)` (never `window.open`/`location` — the
 *  network needs the click event), cap a rewarded playable at ~30 s, and NOT draw its own
 *  close button (the network overlays one).
 *
 *  This module is the single, testable seam for those rules. It degrades gracefully to
 *  STANDALONE (no `window.mraid` — dev, our own preview, the Chrome smoke test): ready
 *  resolves immediately, viewable is true, and `installClick` falls back to `window.open`
 *  so the artifact is still exercisable outside an ad container. */

/** The slice of the MRAID v2 API we depend on (the SDK injects the full object). */
interface Mraid {
  getState(): 'loading' | 'default' | 'expanded' | 'resized' | 'hidden';
  isViewable(): boolean;
  addEventListener(event: 'ready' | 'viewableChange' | 'error' | 'stateChange', listener: (...args: unknown[]) => void): void;
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
  open(url: string): void;
}

function getMraid(): Mraid | null {
  const m = (globalThis as { mraid?: Mraid }).mraid;
  return m && typeof m.getState === 'function' ? m : null;
}

/** True when hosted inside a real MRAID ad container (vs standalone preview/dev). */
export function isInAdContainer(): boolean {
  return getMraid() !== null;
}

/** Resolves when the ad container is READY to run the creative. Immediate when standalone
 *  or already-ready; otherwise waits for the single `ready` event. Idempotent-safe. */
export function whenReady(): Promise<void> {
  const mraid = getMraid();
  if (!mraid || mraid.getState() !== 'loading') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onReady = () => { mraid.removeEventListener('ready', onReady); resolve(); };
    mraid.addEventListener('ready', onReady);
  });
}

/** Resolves when the ad is VIEWABLE (on-screen) — the gate for starting audio/gameplay so
 *  nothing plays while the ad is off-screen (a network rejection reason). Immediate when
 *  standalone or already viewable. */
export function whenViewable(): Promise<void> {
  const mraid = getMraid();
  if (!mraid || mraid.isViewable()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onChange = (...args: unknown[]) => {
      if (args[0] === true || mraid.isViewable()) { mraid.removeEventListener('viewableChange', onChange); resolve(); }
    };
    mraid.addEventListener('viewableChange', onChange);
  });
}

/** Subscribe to viewability changes for the WHOLE session (unlike `whenViewable`, which resolves
 *  once). Used to keep audio muted whenever the ad is off-screen — a playable that plays sound
 *  off-screen is a network rejection reason. Returns an unsubscribe fn. Standalone (no
 *  `window.mraid`) has no viewport events, so this is a no-op returning a no-op canceller — the
 *  caller's own explicit unmute governs the preview. */
export function onViewableChange(cb: (viewable: boolean) => void): () => void {
  const mraid = getMraid();
  if (!mraid) return () => {};
  const handler = (...args: unknown[]) => cb(args[0] === true || mraid.isViewable());
  mraid.addEventListener('viewableChange', handler);
  return () => mraid.removeEventListener('viewableChange', handler);
}

/** Route the install / CTA tap. In an ad container this MUST be `mraid.open` (the network
 *  records the click + shows the store). Standalone falls back to `window.open` so the CTA
 *  is still testable. Returns whether it went through the MRAID path. */
export function installClick(storeUrl: string): boolean {
  // No configured store URL (build.playableClickUrl unset) → do nothing rather than
  // open a blank tab / call mraid.open(''). The CTA still shows; it's just inert until set.
  if (!storeUrl) { console.warn('[playable] CTA tapped but build.playableClickUrl is empty — no clickthrough.'); return false; }
  const mraid = getMraid();
  if (mraid) { mraid.open(storeUrl); return true; }
  if (typeof globalThis.open === 'function') globalThis.open(storeUrl, '_blank');
  return false;
}

/** Rewarded-playable time cap. Fires `onExpire` after `seconds` (default 30 — the common
 *  rewarded ceiling). Returns a canceller (call it when the game ends first). A no-op-safe
 *  wrapper so callers don't juggle timer ids. */
export function startTimeCap(seconds: number, onExpire: () => void): () => void {
  const id = setTimeout(onExpire, Math.max(0, seconds) * 1000);
  return () => clearTimeout(id);
}
