/** Resolve the live <canvas> element(s) that render a Canvas2D host entity.
 *
 *  Disambiguates the editor's DUAL rendering: the editor draws the same host in BOTH the GameView
 *  AND the SceneView's UI preview, so `[data-entity-id="<id>"] canvas` matches TWO canvases with
 *  different on-screen geometry. A game that maps raw `window` pointer events into its own design
 *  space must pick the canvas actually UNDER the pointer, not `querySelector`'s first match (which
 *  would map every tap through the wrong rect). In a shipped game / playable ad there is exactly
 *  one such canvas, so both helpers collapse to the obvious answer there. */

/** Every connected host canvas for `hostId` (entity id, as tagged by the UIRenderer's
 *  `data-entity-id`). Empty in a headless/SSR context or before the host has mounted. */
export function hostCanvases(hostId: number): HTMLCanvasElement[] {
  if (typeof document === 'undefined' || !hostId) return [];
  return [...document.querySelectorAll(`[data-entity-id="${hostId}"] canvas`)]
    .filter((el): el is HTMLCanvasElement => el instanceof HTMLCanvasElement && el.isConnected);
}

/** The host canvas under the given client point, or null when the point isn't over one (a HUD tap,
 *  or a click in another editor panel). The editor's two canvases live in separate panels, so their
 *  rects never overlap and containment uniquely picks the right one. */
export function hostCanvasUnder(hostId: number, clientX: number, clientY: number): HTMLCanvasElement | null {
  for (const c of hostCanvases(hostId)) {
    const r = c.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return c;
  }
  return null;
}
