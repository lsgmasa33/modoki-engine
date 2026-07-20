/** Shared pointer-drag plumbing for the Dopesheet + Curves timeline views.
 *
 *  Both views drive a playhead scrub, a multi-key group drag, and a rubber-band
 *  marquee through the exact same window-listener-gated-on-`dragRef` pattern, the
 *  same client→local point conversion, and the same marquee box state. The only
 *  per-view differences are (a) the marquee hit-test (rows vs value space) and (b)
 *  any extra drag kinds a view adds on top (Curves drags individual keys + tangent
 *  handles). This hook owns the common machinery and parameterizes those two.
 *
 *  The listeners stay attached for the component's life and act only while a drag
 *  is live (`dragRef` set). Attaching them inside the `startDrag` render would miss
 *  a drag that begins on the playhead at its current time — `onScrub` writes the
 *  same value, so no re-render fires to run the effect. Gating on `dragRef` avoids
 *  that. See the original DopesheetView/CurvesView comments this consolidates. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { snapToFrame, xToTime, type TimelineView } from './timelineMath';

export interface LocalPoint { x: number; y: number }
export interface MarqueeBox { x0: number; y0: number; x1: number; y1: number }

/** The common drag kinds both views share. A view may add its own kinds (e.g.
 *  Curves' `key`/`in`/`out`); those carry a `custom: true` discriminator and are
 *  routed back to the view via `onCustomDrag`/`onCustomEnd`. */
export type CommonDragKind = 'playhead' | 'keys' | 'marquee' | 'pan';

interface BaseDrag {
  kind: string;
  /** Marquee anchor (local px) — only present for `kind: 'marquee'`. */
  x0?: number;
  y0?: number;
  additive?: boolean;
}

export interface UseTimelineDragOptions<D extends BaseDrag> {
  /** The scrollable timeline container — its bounding rect is the local origin. */
  ref: React.RefObject<HTMLElement | null>;
  view: TimelineView;
  duration: number;
  frameRate: number;
  onScrub: (t: number) => void;
  onDragSelectedKeys: (targetTime: number) => void;
  onEndKeyDrag: () => void;
  /** Hit-test a marquee box → key ids ("ti:ki"). Per-view (rows vs value space). */
  keysInBox: (box: MarqueeBox) => string[];
  onMarqueeSelect: (ids: string[], additive: boolean) => void;
  /** Right-drag pan: called with the TOTAL pixel delta from the drag start (so the
   *  view can pan from a captured base viewport). Both axes are provided; the X view
   *  ignores dyPx. Only fires for `kind: 'pan'` drags. */
  onPan?: (dxPx: number, dyPx: number) => void;
  /** Handle a view-specific drag kind (anything not playhead/keys/marquee), e.g.
   *  Curves' key/tangent drags. Receives the live drag + the local pointer point. */
  onCustomDrag?: (drag: D, pt: LocalPoint) => void;
  /** Optional end-of-drag handler for view-specific kinds (Curves needs none —
   *  its key/tangent edits commit per-move — but kept for symmetry). */
  onCustomEnd?: (drag: D, pt: LocalPoint) => void;
}

export interface UseTimelineDrag<D extends BaseDrag> {
  /** The current marquee rectangle while a marquee drag is active, else null. */
  marquee: MarqueeBox | null;
  /** Begin a drag at the given client coords (applies the first frame immediately). */
  startDrag: (drag: D, clientX: number, clientY: number) => void;
  /** Convert client coords → coords local to `ref`. */
  local: (clientX: number, clientY: number) => LocalPoint;
}

/** Returns true for the three kinds this hook handles directly. */
function isCommonKind(kind: string): kind is CommonDragKind {
  return kind === 'playhead' || kind === 'keys' || kind === 'marquee';
}

export function useTimelineDrag<D extends BaseDrag>(
  opts: UseTimelineDragOptions<D>,
): UseTimelineDrag<D> {
  const {
    ref, view, duration, frameRate,
    onScrub, onDragSelectedKeys, onEndKeyDrag,
    keysInBox, onMarqueeSelect, onPan, onCustomDrag, onCustomEnd,
  } = opts;

  const dragRef = useRef<D | null>(null);
  // Client coords captured at the start of a `pan` drag, so onPan reports a total
  // delta from the anchor (the view pans from a base viewport it snapshotted).
  const panAnchor = useRef<{ cx: number; cy: number }>({ cx: 0, cy: 0 });
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);

  const local = useCallback((clientX: number, clientY: number): LocalPoint => {
    const r = ref.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }, [ref]);

  const applyDrag = useCallback((clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') { onPan?.(clientX - panAnchor.current.cx, clientY - panAnchor.current.cy); return; }
    const pt = local(clientX, clientY);
    if (d.kind === 'playhead') {
      onScrub(Math.max(0, Math.min(duration, snapToFrame(xToTime(pt.x, view), frameRate))));
    } else if (d.kind === 'keys') {
      onDragSelectedKeys(xToTime(pt.x, view));
    } else if (d.kind === 'marquee') {
      setMarquee({ x0: d.x0!, y0: d.y0!, x1: pt.x, y1: pt.y });
    } else {
      onCustomDrag?.(d, pt);
    }
  }, [local, view, duration, frameRate, onScrub, onDragSelectedKeys, onPan, onCustomDrag]);

  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragRef.current) applyDrag(e.clientX, e.clientY); };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const pt = local(e.clientX, e.clientY);
      if (d.kind === 'keys') onEndKeyDrag();
      else if (d.kind === 'marquee') {
        onMarqueeSelect(keysInBox({ x0: d.x0!, y0: d.y0!, x1: pt.x, y1: pt.y }), !!d.additive);
        setMarquee(null);
      } else if (!isCommonKind(d.kind)) onCustomEnd?.(d, pt);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [applyDrag, onEndKeyDrag, onMarqueeSelect, keysInBox, local, onCustomEnd]);

  const startDrag = useCallback((d: D, clientX: number, clientY: number) => {
    dragRef.current = d;
    if (d.kind === 'pan') panAnchor.current = { cx: clientX, cy: clientY };
    // Apply the first frame immediately ONLY for kinds where pointer-DOWN is itself
    // meaningful and non-mutating: 'playhead' (click-to-scrub) and 'marquee' (show the
    // box at the anchor). For 'keys'/'pan' and view-specific mutating kinds ('key',
    // 'in', 'out'), wait for real movement — otherwise a plain SELECT-click on a
    // keyframe commits a zero-move edit: it pushes a junk 'movekeys' undo entry, dirties
    // the clip (spurious autosave), and snap-retimes off-grid (e.g. Spine-imported) keys
    // to the nearest frame on a mere click. See useTimelineDrag.test 'select-click'.
    if (d.kind === 'playhead' || d.kind === 'marquee') applyDrag(clientX, clientY);
  }, [applyDrag]);

  return { marquee, startDrag, local };
}
