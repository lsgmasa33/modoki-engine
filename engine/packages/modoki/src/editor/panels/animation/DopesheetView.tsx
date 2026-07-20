/** Dopesheet timeline — SVG ruler + draggable playhead + diamond keyframes per row.
 *  Click a diamond to select it; shift/cmd-click to add to the selection; drag a
 *  rubber-band box over empty row space to marquee-select across tracks. Dragging
 *  any selected diamond moves the whole selection in time (frame-snapped, spacing
 *  preserved). Double-click a diamond to delete it; double-click empty row space to
 *  add a key (value sampled so the pose is unchanged); drag in the ruler to scrub. */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AnimationTrack } from '../../../runtime/animation/types';
import { evalTrackValue } from '../../../runtime/animation/curveEval';
import { registerHandleProvider, type InteractionHandle } from '../../../runtime/rendering/interactionHandles';
import {
  ROW_H, RULER_H,
  timeToX, xToTime, snapToFrame, rulerTicks, visibleSpan, type Viewport, type TimelineView,
} from './timelineMath';
import { useTimelineDrag, type MarqueeBox } from './useTimelineDrag';
import { useTimelineViewport } from './useTimelineViewport';
import { keysInBox as keysInBoxGeom } from './marqueeGeom';
import TimelinePlayhead from './TimelinePlayhead';

type DragState =
  | { kind: 'playhead' }
  | { kind: 'keys' }
  | { kind: 'pan' }
  | { kind: 'marquee'; additive: boolean; x0: number; y0: number };

function DopesheetView({
  tracks, duration, frameRate, selectedTrack, selectedKeys, viewport, onViewport,
  onScrub, onDeleteKey, onAddKey, onKeyMouseDown, onDragSelectedKeys, onEndKeyDrag, onMarqueeSelect,
}: {
  tracks: AnimationTrack[];
  duration: number;
  frameRate: number;
  selectedTrack: number | null;
  selectedKeys: Set<string>;
  /** Shared horizontal zoom/pan viewport. */
  viewport: Viewport;
  onViewport: (vp: Viewport) => void;
  onScrub: (t: number) => void;
  onDeleteKey: (trackIdx: number, keyIdx: number) => void;
  onAddKey: (trackIdx: number, time: number, value: number) => void;
  /** Pointer-down on a key: updates selection, returns true if >1 key selected. */
  onKeyMouseDown: (trackIdx: number, keyIdx: number, additive: boolean) => boolean;
  /** Drag the selected group so the grabbed key lands at `targetTime` (seconds). */
  onDragSelectedKeys: (targetTime: number) => void;
  onEndKeyDrag: () => void;
  onMarqueeSelect: (ids: string[], additive: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Shared wheel-zoom + right-drag-pan viewport (SceneView convention).
  const { view, onPan, beginPan: beginPanCore } = useTimelineViewport({ ref, viewport, onViewport, width, duration });

  const totalH = RULER_H + tracks.length * ROW_H;

  // Keys whose diamond falls inside a marquee box (local px). Crosses tracks — shared
  // geometry, row-band center (vs the Curves view's value-space center).
  const allTracks = useMemo(() => tracks.map((_t, i) => i), [tracks]);
  const keysInBox = useCallback((b: MarqueeBox): string[] =>
    keysInBoxGeom(tracks, allTracks, b, (ti, ki) => ({
      cx: timeToX(tracks[ti].keys[ki].t, view),
      cy: RULER_H + ti * ROW_H + ROW_H / 2,
    })),
  [tracks, allTracks, view]);

  const { marquee, startDrag, local } = useTimelineDrag<DragState>({
    ref, view, duration, frameRate,
    onScrub, onDragSelectedKeys, onEndKeyDrag,
    keysInBox, onMarqueeSelect, onPan,
  });

  const beginPan = useCallback((e: React.PointerEvent) => beginPanCore(startDrag, e), [beginPanCore, startDrag]);

  const visSpan = visibleSpan(view.pxPerSec, width);

  // ── Enact Phase 2: keyframe handles ── expose each diamond as a viewport-CSS-px
  //    point (same math as the render: timeToX + row-band center + container rect),
  //    so the agent can query + drag a key in time. Live state via a ref (register
  //    once, read current). Handle id keyed by the track's natural path (stable
  //    across reorder), not the ti:ki selection id.
  const dopeHandleRef = useRef<{ tracks: AnimationTrack[]; view: TimelineView }>({ tracks, view });
  dopeHandleRef.current = { tracks, view };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const el = ref.current;
      if (!el) return [];
      const { tracks: trk, view: v } = dopeHandleRef.current;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const out: InteractionHandle[] = [];
      trk.forEach((track, ti) => {
        const trackKey = `${track.path}|${track.trait}.${track.field}`;
        const cy = RULER_H + ti * ROW_H + ROW_H / 2;
        track.keys.forEach((k, ki) => {
          out.push({
            id: `dope:key:${trackKey}:${ki}`,
            kind: 'keyframe',
            editor: 'dopesheet',
            x: rect.left + timeToX(k.t, v),
            y: rect.top + cy,
            label: `${track.trait}.${track.field} t=${k.t.toFixed(3)}`,
            meta: { trackIndex: ti, keyIndex: ki, time: k.t, value: k.v, path: track.path, track: `${track.trait}.${track.field}` },
          });
        });
      });
      return out;
    });
    return unreg;
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', background: '#14141d' }}
      onContextMenu={(e) => e.preventDefault()}>
      <svg width="100%" height="100%" style={{ display: 'block' }}>
        {/* Full-height background below the ruler: empty-space marquee / deselect
            (covers the dead zone under the last track row) + right-drag pan. */}
        <rect x={0} y={RULER_H} width="100%" height="100%" fill="transparent" style={{ cursor: 'crosshair' }}
          onPointerDown={(e) => { if (e.button === 2) { beginPan(e); return; } const p = local(e.clientX, e.clientY); startDrag({ kind: 'marquee', additive: e.shiftKey || e.metaKey, x0: p.x, y0: p.y }, e.clientX, e.clientY); }} />
        {/* Ruler background */}
        <rect x={0} y={0} width="100%" height={RULER_H} fill="#1d1d2b" />
        {/* Ruler ticks + labels */}
        {rulerTicks(duration, view.pxPerSec, 64, view.viewStart, (view.viewStart ?? 0) + visSpan).map((t) => {
          const x = timeToX(t, view);
          return (
            <g key={t}>
              <line x1={x} y1={0} x2={x} y2={totalH} stroke="#262636" />
              <text x={x + 3} y={14} fill="#778" fontSize={10} fontFamily="monospace">{formatTick(t, frameRate)}</text>
            </g>
          );
        })}
        {/* Ruler hit area for scrubbing (right-drag pans) */}
        <rect x={0} y={0} width="100%" height={RULER_H} fill="transparent" style={{ cursor: 'ew-resize' }}
          onPointerDown={(e) => { if (e.button === 2) { beginPan(e); return; } startDrag({ kind: 'playhead' }, e.clientX, e.clientY); }} />

        {/* Track rows */}
        {tracks.map((track, ti) => {
          const y = RULER_H + ti * ROW_H;
          return (
            <g key={`${track.path}|${track.trait}|${track.field}`}>
              <rect x={0} y={y} width="100%" height={ROW_H} fill={selectedTrack === ti ? '#1b2030' : (ti % 2 ? '#16161f' : '#14141d')}
                style={{ cursor: 'crosshair' }}
                onPointerDown={(e) => { if (e.button === 2) { beginPan(e); return; } const p = local(e.clientX, e.clientY); startDrag({ kind: 'marquee', additive: e.shiftKey || e.metaKey, x0: p.x, y0: p.y }, e.clientX, e.clientY); }}
                onDoubleClick={(e) => {
                  const t = Math.max(0, Math.min(duration, snapToFrame(xToTime(local(e.clientX, e.clientY).x, view), frameRate)));
                  // Dopesheet rows have no value axis, so we pass the curve sample at t. This is
                  // only a FALLBACK: AnimationEditor.addKey prefers the bound entity's live value
                  // (`liveTrackValue(tr) ?? value`) so keying after a manual move captures the move
                  // rather than re-posing to the curve. (anim-editors F4 — CurvesView keys yToValue.)
                  onAddKey(ti, t, evalTrackValue(track, t));
                }} />
              <line x1={0} y1={y + ROW_H} x2="100%" y2={y + ROW_H} stroke="#20202c" />
              {track.keys.map((k, ki) => {
                const cx = timeToX(k.t, view);
                const cy = y + ROW_H / 2;
                // Color keys → swatch-tinted; boolean keys → filled (1) / hollow (0); number → amber.
                const fill = track.type === 'color' ? `#${(k.v & 0xffffff).toString(16).padStart(6, '0')}`
                  : track.type === 'boolean' ? (k.v ? '#5ad17a' : 'none')
                  : '#e0b341';
                const isSel = selectedKeys.has(`${ti}:${ki}`);
                return (
                  <path
                    key={ki}
                    d={diamond(cx, cy, isSel ? 6 : 5)}
                    fill={fill}
                    stroke={isSel ? '#fff' : track.type === 'boolean' && !k.v ? '#5ad17a' : '#1a1a1a'}
                    strokeWidth={isSel ? 2 : 1}
                    style={{ cursor: 'ew-resize' }}
                    onPointerDown={(e) => { e.stopPropagation(); if (e.button === 2) { beginPan(e); return; } if (e.button !== 0) return; onKeyMouseDown(ti, ki, e.shiftKey || e.metaKey); startDrag({ kind: 'keys' }, e.clientX, e.clientY); }}
                    onDoubleClick={(e) => { e.stopPropagation(); onDeleteKey(ti, ki); }}
                  />
                );
              })}
            </g>
          );
        })}

        {/* Marquee rectangle */}
        {marquee && (
          <rect
            x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
            fill="rgba(122,162,247,0.15)" stroke="#7aa2f7" strokeWidth={1} strokeDasharray="3 2" pointerEvents="none"
          />
        )}

        {/* Playhead — self-subscribing leaf so it moves 60fps without re-rendering the body. */}
        <TimelinePlayhead view={view} diamond />
      </svg>
    </div>
  );
}

export default memo(DopesheetView);

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

function formatTick(t: number, frameRate: number): string {
  // Show frame numbers when zoomed in enough that sub-second ticks appear.
  if (frameRate > 0 && t * frameRate < 100 && t % 1 !== 0) return `${Math.round(t * frameRate)}f`;
  return `${t}s`;
}
