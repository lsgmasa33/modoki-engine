/** Playable CTA overlay (Phase 5) — the install call-to-action layered over the game in a
 *  playable ad. A persistent "Install" pill (always tappable) plus an end-card (big Install +
 *  Replay) shown when the rewarded time-cap fires or the game dispatches `playable:end`.
 *
 *  Deliberately NOT ECS UI: it must render even if the game world stalls, and it outlives
 *  scene swaps. Inline styles (no external CSS) so it survives single-file inlining. Never
 *  draws a CLOSE button — the ad network overlays its own (an MRAID rule). */

import { useEffect, useState } from 'react';
import { installClick, startTimeCap } from './mraid';
import { isPlayableEnded, resetPlayableEnd } from './playableEnd';

const Z = 2147483000; // above the game canvas + any DOM UI

export interface PlayableOverlayProps {
  /** Store URL the CTA routes to (via `mraid.open`, or `window.open` standalone). */
  clickUrl: string;
  /** Rewarded time-cap seconds after which the end-card shows. Default 30. */
  capSeconds?: number;
  /** Replay handler (default: reload the document). Injectable for tests. */
  onReplay?: () => void;
}

export function PlayableOverlay({ clickUrl, capSeconds = 30, onReplay }: PlayableOverlayProps) {
  // Seed from the latch so an end fired BEFORE this overlay mounted (during the off-screen hold)
  // still shows the end-card immediately, then keep listening for live ends.
  const [ended, setEnded] = useState(isPlayableEnded);

  useEffect(() => {
    const cancel = startTimeCap(capSeconds, () => setEnded(true));
    // The game can end the playable early (win/lose) by dispatching this event.
    const onEnd = () => setEnded(true);
    window.addEventListener('playable:end', onEnd);
    return () => { cancel(); window.removeEventListener('playable:end', onEnd); };
  }, [capSeconds]);

  const install = () => installClick(clickUrl);
  const replay = () => { resetPlayableEnd(); setEnded(false); (onReplay ?? (() => window.location.reload()))(); };

  return (
    <>
      {/* Persistent CTA pill — always visible + tappable. */}
      <button
        type="button"
        aria-label="Install"
        onClick={install}
        style={{
          position: 'fixed', bottom: 'max(16px, env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)',
          zIndex: Z, padding: '12px 28px', border: 'none', borderRadius: 999, cursor: 'pointer',
          font: '700 17px/1 system-ui, sans-serif', color: '#fff', background: '#2e7d32',
          boxShadow: '0 4px 16px rgba(0,0,0,.35)', touchAction: 'manipulation',
        }}
      >
        Install
      </button>

      {ended && (
        <div
          role="dialog"
          aria-label="Play the full game"
          style={{
            position: 'fixed', inset: 0, zIndex: Z + 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 20,
            background: 'rgba(0,0,0,.62)', color: '#fff', font: '700 22px/1.3 system-ui, sans-serif',
          }}
        >
          <div>Enjoyed it?</div>
          <button
            type="button" onClick={install}
            style={{ padding: '16px 48px', border: 'none', borderRadius: 14, cursor: 'pointer',
              font: '800 22px/1 system-ui, sans-serif', color: '#fff', background: '#2e7d32' }}
          >
            Install Now
          </button>
          <button
            type="button" onClick={replay}
            style={{ padding: '10px 28px', border: '2px solid rgba(255,255,255,.7)', borderRadius: 12,
              cursor: 'pointer', font: '600 16px/1 system-ui, sans-serif', color: '#fff', background: 'transparent' }}
          >
            Replay
          </button>
        </div>
      )}
    </>
  );
}
