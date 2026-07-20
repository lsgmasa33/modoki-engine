/** Shared horizontal zoom/pan wiring for the Dopesheet + Curves timelines.
 *
 *  Both views drive the same X-axis viewport: a native `wheel` listener that zooms
 *  toward the cursor and a right-drag pan (SceneView convention). This was copy-pasted
 *  (byte-identical wheel call + vpRef/viewRef/panBase/onPan/beginPan) in both views;
 *  the hook owns it once. CurvesView layers its value(Y)-axis zoom/pan on top via the
 *  optional `onWheelModified` (Ctrl/Cmd+wheel) and `onPanY` extensions. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { resolveView, zoomViewport, panViewport, type TimelineView, type Viewport } from './timelineMath';

type PanStart = (drag: { kind: 'pan' }, clientX: number, clientY: number) => void;

export interface TimelineViewportOptions {
  ref: React.RefObject<HTMLElement | null>;
  viewport: Viewport;
  onViewport: (vp: Viewport) => void;
  width: number;
  duration: number;
  /** Curves-only: handle a Ctrl/Cmd+wheel as a value-axis zoom. Return true if handled
   *  (then the shared X zoom is skipped for that event). */
  onWheelModified?: (e: WheelEvent, rect: DOMRect) => boolean;
  /** Curves-only: apply an extra Y pan (total dyPx from drag start) alongside the X pan. */
  onPanY?: (dyPx: number) => void;
}

export interface TimelineViewportApi {
  /** Concrete view (originX/pxPerSec/viewStart), memoized so it stays stable across
   *  playhead-only re-renders (keeps the drag-hook listeners from re-subscribing). */
  view: TimelineView;
  /** Pass to useTimelineDrag as `onPan`. */
  onPan: (dxPx: number, dyPx: number) => void;
  /** Begin a right-drag pan: snapshots the current left edge (and lets the caller
   *  snapshot its Y base via `beforeStart`), then drives a `pan` drag. */
  beginPan: (startDrag: PanStart, e: React.PointerEvent, beforeStart?: () => void) => void;
}

export function useTimelineViewport(opts: TimelineViewportOptions): TimelineViewportApi {
  const { ref, viewport, onViewport, width, duration, onWheelModified, onPanY } = opts;
  const view = useMemo(() => resolveView(viewport, width, duration), [viewport, width, duration]);

  // Latest values via refs so the native wheel listener attaches once and the pan
  // handler reads current geometry without re-subscribing.
  const vpRef = useRef(viewport); vpRef.current = viewport;
  const viewRef = useRef(view); viewRef.current = view;
  const widthRef = useRef(width); widthRef.current = width;
  const panBaseX = useRef(0);

  const onPan = useCallback((dxPx: number, dyPx: number) => {
    onViewport(panViewport(vpRef.current, panBaseX.current, dxPx, ref.current?.clientWidth ?? widthRef.current, duration));
    onPanY?.(dyPx);
  }, [onViewport, duration, onPanY, ref]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (onWheelModified && (e.ctrlKey || e.metaKey) && onWheelModified(e, r)) return;
      onViewport(zoomViewport(vpRef.current, e.clientX - r.left, e.deltaY, el.clientWidth, duration));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, onViewport, duration, onWheelModified]);

  const beginPan = useCallback((startDrag: PanStart, e: React.PointerEvent, beforeStart?: () => void) => {
    panBaseX.current = viewRef.current.viewStart ?? 0;
    beforeStart?.();
    startDrag({ kind: 'pan' }, e.clientX, e.clientY);
  }, []);

  return { view, onPan, beginPan };
}
