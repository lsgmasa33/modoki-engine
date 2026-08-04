/** Fullscreen cutscene overlay.
 *
 *  Renders any `VideoPlayer` entity whose `timeMode` is `'presentation'` as a
 *  fullscreen layer above the game. It does NOT create or own a video element — it
 *  ADOPTS the one `videoService` already made (via `videoElementFor`) and appends it
 *  to the DOM. That matters: a second element would be a second decoder, a second
 *  autoplay negotiation, and audio routed twice.
 *
 *  While a cutscene is up the overlay covers everything and swallows pointer input,
 *  so a button underneath cannot be pressed through the movie. The skip affordance is
 *  the deliberate exception.
 *
 *  Mounted once by the app shell, above the UI layer. Renders nothing when no
 *  presentation clip is playing, so it costs a query per frame and no DOM. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { VideoPlayer } from '../traits/VideoPlayer';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { peekCurrentWorld } from '../core/ecs/world';
import { videoElementFor } from './videoSystem';
import { emitVideoSkip } from './VideoEvents';

/** The presentation clip currently showing, if any. */
interface ActiveClip { id: number; guid?: string; clip: string }

/** Poll the world for the active cutscene.
 *
 *  Deliberately NOT `koota/react`'s `useQuery`: that requires a `WorldProvider`, which
 *  the editor's Game panel tree does not have — using it crashed the whole panel into
 *  its error boundary. A poll also keeps this component usable from ANY tree (app
 *  shell or editor) with no provider contract at all.
 *
 *  It re-renders only when the ACTIVE CLIP CHANGES, not per frame: the identity check
 *  below is what stops a fullscreen overlay from re-rendering 60 times a second. */
function useActiveCutscene(): ActiveClip | null {
  const [active, setActive] = useState<ActiveClip | null>(null);
  const lastKey = useRef<string>('');

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // peek, not get: this runs before/after a world swap too, and must not create one.
      const world = peekCurrentWorld();
      let found: ActiveClip | null = null;
      if (world) {
        for (const e of world.query(VideoPlayer)) {
          const vp = e.get(VideoPlayer);
          if (!vp || vp.timeMode !== 'presentation' || !vp.playing) continue;
          // First wins — two fullscreen cutscenes at once is meaningless, so they do
          // not stack.
          found = { id: e.id(), guid: e.get(EntityAttributes)?.guid, clip: vp.clip };
          break;
        }
      }
      const key = found ? `${found.id}:${found.clip}` : '';
      if (key !== lastKey.current) { lastKey.current = key; setActive(found); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return active;
}

export interface VideoOverlayProps {
  /** Show a Skip button. Default true — an unskippable cutscene is a design choice a
   *  game should have to make on purpose, not one it gets by forgetting a prop. */
  skippable?: boolean;
  skipLabel?: string;
}

export function VideoOverlay({ skippable = true, skipLabel = 'Skip' }: VideoOverlayProps) {
  const active = useActiveCutscene();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeId = active?.id ?? null;

  // Adopt the element into the overlay; put it back (detach) when the clip ends.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || activeId == null) return;
    const el = videoElementFor(activeId);
    if (!el) return;
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.objectFit = 'contain';
    el.style.display = 'block';
    host.appendChild(el);
    return () => {
      // Remove from the DOM but do NOT stop or clear it — videoService owns its
      // lifetime, and tearing it down here would kill a clip that is merely being
      // re-parented (or still needed by a texture surface).
      if (el.parentNode === host) host.removeChild(el);
    };
  }, [activeId]);

  const skip = useCallback(() => {
    if (!active) return;
    emitVideoSkip({ entity: active.guid, clip: active.clip });
    // The `playing` flip is what actually stops it; videoSystem reconciles next frame.
    const world = peekCurrentWorld();
    if (!world) return;
    for (const e of world.query(VideoPlayer)) {
      if (e.id() === active.id) { e.set(VideoPlayer, { playing: false }); break; }
    }
  }, [active]);

  // NO keyboard handler here, deliberately. An earlier draft bound Escape directly,
  // which the input-source guard rejected — raw DOM input reads belong in
  // `runtime/input/` sources, not scattered through components. It was also the wrong
  // DESIGN: which key skips a cutscene (or whether ANY key does) is a game's call, not
  // the engine's. A game that wants it binds its key to the `video.skip` action, which
  // does exactly what this button does.
  if (!active) return null;

  return (
    <div
      data-modoki-video-overlay=""
      style={{
        position: 'absolute', inset: 0, zIndex: 40,
        background: '#000', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        // Swallow input: a cutscene covers the game, so a button underneath must not
        // be reachable through it.
        pointerEvents: 'auto',
      }}
      // Clicking the backdrop does nothing on purpose — an accidental tap during a
      // cutscene should not dismiss it. Skipping is an explicit button/Escape.
      onPointerDown={(e) => { e.stopPropagation(); }}
    >
      <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      {skippable && (
        <button
          type="button"
          onClick={skip}
          style={{
            position: 'absolute', right: 24, bottom: 24,
            padding: '8px 18px', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.5)',
            background: 'rgba(0,0,0,0.45)', color: '#fff',
            font: '500 14px system-ui, sans-serif', cursor: 'pointer',
          }}
        >
          {skipLabel}
        </button>
      )}
    </div>
  );
}
