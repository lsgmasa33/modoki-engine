/** App UI-zoom Ctrl/Cmd+wheel forwarder decision — extracted from EditorApp so the branching
 *  (modifier gate, own-a-modified-wheel exclusion, preventDefault, send) is unit-testable without
 *  rendering the whole editor. Electron-only; the caller gates on the bridge's presence. */

export interface ZoomWheelBridge { send(event: string, data: unknown): void; }

/** Forward a Ctrl/Cmd+wheel as a whole-app zoom intent. Returns true iff it was consumed.
 *  A PLAIN wheel is ignored (panels keep their own scroll/dolly). A surface that legitimately
 *  owns Ctrl/Cmd+wheel — the animation Curve Editor's value-axis zoom, marked
 *  `data-modki-wheel-zoom` by useTimelineViewport — is skipped so we don't steal its gesture. */
export function forwardZoomWheel(e: WheelEvent, bridge: ZoomWheelBridge): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.target instanceof Element && e.target.closest('[data-modki-wheel-zoom]')) return false;
  e.preventDefault();
  e.stopPropagation();
  bridge.send('zoom', { deltaY: e.deltaY });
  return true;
}
