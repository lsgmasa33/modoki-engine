/** Playable CTA overlay (Phase 5) — the install call-to-action layered over the game in a
 *  playable ad. An end-card (Install + Replay), shown when the rewarded time-cap fires or the game
 *  dispatches `playable:end`. ⚠️ **There is NO persistent pill, and no other always-on affordance**
 *  (#1139) — the end card is the only route to a click, which is why `capSeconds` is load-bearing
 *  rather than a backstop. See the comment on the render below for why the pill was removed.
 *
 *  Deliberately NOT ECS UI: it must render even if the game world stalls, and it outlives
 *  scene swaps. Inline styles (no external CSS) so it survives single-file inlining. Never
 *  draws a CLOSE button — the ad network overlays its own (an MRAID rule). */

import { useEffect, useState } from 'react';
import { installClick, startTimeCap, onFirstGesture } from './mraid';
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
  /** Bumped by Replay, to re-arm the cap for the fresh play session — see the effect below. */
  const [cycle, setCycle] = useState(0);

  /**
   * The rewarded time cap: armed on VIEWABILITY, and RESTARTED on the first user gesture (owner,
   * 2026-09-13).
   *
   * ⚠️ **Both halves, and each is there for a different viewer.** This effect runs at mount, and
   * `bootPlayable` holds the mount until ready + viewable — so arming here guarantees a call to
   * action for someone who scrolls past and never touches the ad, who would otherwise never see
   * one now that the persistent pill is gone (#1139). Restarting on the first gesture gives anyone
   * who actually engages a full `capSeconds` of play, instead of whatever remained of a timer that
   * had been running while they were deciding whether to tap. An engaged player can therefore see
   * the end card up to ~2x `capSeconds` in, which is the accepted cost of serving both.
   *
   * ⚠️ The gesture latch is `onFirstGesture` from `./mraid`, the same one the audio gate uses —
   * NOT a second private copy of the gesture list. See that function's own note.
   *
   * ⚠️ **Keyed on `cycle`, never on `ended`.** Putting `ended` in the deps would tear down and
   * re-arm the cap at the moment the end card SHOWS, starting a fresh timer underneath it. `cycle`
   * moves only when Replay does.
   */
  useEffect(() => {
    let cancelCap = startTimeCap(capSeconds, () => setEnded(true));
    const cancelGesture = onFirstGesture(() => {
      cancelCap();
      cancelCap = startTimeCap(capSeconds, () => setEnded(true));
    });
    // The game can end the playable early (win/lose) by dispatching this event.
    const onEnd = () => setEnded(true);
    window.addEventListener('playable:end', onEnd);
    return () => { cancelCap(); cancelGesture(); window.removeEventListener('playable:end', onEnd); };
  }, [capSeconds, cycle]);

  const install = () => installClick(clickUrl);
  /**
   * ⚠️ **Replay RE-ARMS the cap, and that is a decision rather than bookkeeping.** Before #1139 the
   * persistent pill meant a replaying player always had a way to install, so a spent cap cost
   * nothing. With the pill gone the end card is the only call to action, and a cap that does not
   * re-arm leaves the rest of the session with none at all — the outcome the owner ruled worst.
   * Bumping `cycle` restarts the effect above, so the replayed session gets its own full timer.
   */
  const replay = () => {
    resetPlayableEnd();
    setEnded(false);
    setCycle((c) => c + 1);
    (onReplay ?? (() => window.location.reload()))();
  };

  return (
    <>
      {/* ⚠️ **NO persistent CTA pill — removed deliberately (#1139, owner 2026-09-13).** There was
          one: a fixed `Install` pill at `bottom: max(16px, env(safe-area-inset-bottom))` with this
          same `Z`. It occupied the bottom 57 CSS px of every playable, which is a DESIGN-space
          reserve away in the game's own layout — so on a short viewport (320x568, or any
          landscape) the pill overhung the reserve and sat on the letter board's bottom row, opaque
          and hit-testable, turning a drag on that row into an exit from the ad.

          The fix chosen was not to publish the pill's footprint for games to clear, but to drop
          the pill: AppLovin's creative specs require MRAID 2.0, `mraid.open()` click-through, no
          store redirect on first tap and muted audio until first interaction, and state that
          AppLovin supplies the close button — **they require no install button, overlay or end
          card at all**, so the persistent pill was our own choice, not a network requirement.
          Install now lives ONLY on the end card below.

          ⚠️ **Which makes the end card the ONLY route to a click.** It is reached by
          `playable:end` or the time cap, so a playable that never fires either is a creative with
          no call to action. `capSeconds` (default 30) is what guarantees it. */}
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
          {/* ⚠️ No `aria-label` — deliberately. One was added here so the smoke gate's existing
              `button[aria-label="Install"]` selector would keep working after the pill went, which
              made the accessible name "Install" while the visible label reads "Install Now": a
              label-in-name mismatch, so a voice-control user saying what they can SEE cannot
              activate the button. The test selects on text content instead; a selector is not a
              reason to give a control a second name. */}
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
