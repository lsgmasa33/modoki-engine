/** UIVideoMount — a `VideoPlayer` rendered INSIDE a UI node.
 *
 *  The fourth surface a video can land on (see `docs/video.md`): a `VideoPlayer` on an
 *  entity that is also a UI element plays into that element's box, laid out and stacked
 *  by the UI tree like any other DOM node. That is what makes video usable as SCENERY —
 *  a full-bleed animated backdrop *behind* the game — rather than only as the fullscreen
 *  cutscene `VideoOverlay` puts on top of everything.
 *
 *  Like `VideoOverlay` it ADOPTS the element `videoService` already created and never
 *  makes one: a second element would be a second decoder, a second autoplay negotiation,
 *  and the sound routed onto the bus twice.
 *
 *  ## One element, several hosts
 *
 *  There is exactly ONE element per clip, and the UI tree can be mounted more than once —
 *  the editor renders it into the Game panel AND the Scene panel. So the hosts have to
 *  agree who gets it, or the last one to tick wins by accident: reported as "the video
 *  plays only on Scene view, not on the game view". `claims` below resolves that by
 *  PRIORITY, and the runtime/game surface outranks the editor's authoring viewport —
 *  the running game is the thing you are actually looking at.
 *
 *  It polls for the element rather than being handed one, because the element does not
 *  exist until `videoSystem` reconciles the trait — which happens after this component
 *  first mounts, and again after every Stop→Play (leaving Play disposes every handle).
 *  The poll is one Map lookup per frame. */

import { useEffect, useRef } from 'react';
import { videoElementFor } from './videoSystem';

/** Every mounted host that wants a given entity's element, by priority. A multiset:
 *  two hosts of equal priority both stay registered, and the winner is simply the
 *  highest number present, so an unmount can never leave a stale claim behind. */
const claims = new Map<number, number[]>();

function addClaim(entityId: number, priority: number): void {
  const list = claims.get(entityId);
  if (list) list.push(priority);
  else claims.set(entityId, [priority]);
}

function dropClaim(entityId: number, priority: number): void {
  const list = claims.get(entityId);
  if (!list) return;
  const i = list.indexOf(priority);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) claims.delete(entityId);
}

function topClaim(entityId: number): number {
  const list = claims.get(entityId);
  return list && list.length ? Math.max(...list) : -Infinity;
}

export interface UIVideoMountProps {
  entityId: number;
  /** CSS `object-fit` for the picture inside the node's box — carried over from
   *  `UIElement.imageMode`, so a video backdrop crops exactly like an image one. */
  fit?: string;
  /** Who wins when the same UI tree is mounted twice. Higher takes the element.
   *  Default 1 = the runtime/game surface; the editor's authoring viewport passes 0. */
  priority?: number;
}

export function UIVideoMount({ entityId, fit = 'cover', priority = 1 }: UIVideoMountProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    let adopted: HTMLVideoElement | null = null;
    addClaim(entityId, priority);

    const detach = (): void => {
      if (adopted && adopted.parentNode === host) host.removeChild(adopted);
      adopted = null;
    };

    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const el = videoElementFor(entityId);
      // The handle was torn down (Stop, scene swap, clip cleared) — drop our copy so
      // the next Play adopts the NEW element instead of leaving a dead one in the box.
      if (!el) { if (adopted) detach(); return; }
      // Outranked: leave it to the winner, and give back anything we already hold.
      if (priority < topClaim(entityId)) { if (adopted) detach(); return; }
      // `parentNode` is checked as well as identity so a host that LOST the element to a
      // same-priority peer, then outlived it, takes it back rather than sitting on a
      // stale belief that it still owns an element sitting in someone else's box.
      if (el === adopted && el.parentNode === host) return;
      detach();
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = fit;
      el.style.display = 'block';
      host.appendChild(el);
      adopted = el;
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      dropClaim(entityId, priority);
      // Remove from the DOM but do NOT stop or dispose it — `videoService` owns its
      // lifetime, and tearing it down here would kill a clip that is merely being
      // re-parented (or is still feeding a texture surface).
      detach();
    };
  }, [entityId, fit, priority]);

  // `inset: 0` rather than 100%/100%: the host node may be a flex container with other
  // children (a UI backdrop usually is), and a video that participated in that layout
  // would push them around. It is a background layer, so it is taken out of flow.
  return (
    <div
      ref={hostRef}
      data-modoki-ui-video={entityId}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    />
  );
}
