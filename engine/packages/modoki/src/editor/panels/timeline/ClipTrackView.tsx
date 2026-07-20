/** Timeline track body — SVG ruler + draggable playhead + one lane per track, drawing clip BARS
 *  (animation clips / activation spans) and MARKER diamonds (signal / audio cues) on a shared time
 *  axis. Drag in the ruler to scrub; drag a clip/marker horizontally to retime it (frame-snapped);
 *  wheel to zoom toward the cursor; right-drag to pan. Reuses the Animation editor's timeline
 *  substrate (timeToX/xToTime, useTimelineViewport, useTimelineDrag, TimelinePlayhead) verbatim —
 *  only the glyphs differ (bars/diamonds vs. keyframe dots). */

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { TimelineDef, TrackDef } from '../../../runtime/timeline/types';
import {
  ROW_H, RULER_H, TRACK_PAD_LEFT,
  timeToX, xToTime, snapToFrame, rulerTicks, type Viewport,
} from '../animation/timelineMath';
import { useTimelineDrag } from '../animation/useTimelineDrag';
import { useTimelineViewport } from '../animation/useTimelineViewport';
import TimelinePlayhead from '../animation/TimelinePlayhead';

/** A single retime-drag: which track/item and the grab offset (pointer time − item time). */
interface ItemDrag { kind: 'item'; trackIdx: number; itemIdx: number; grab: number; orig: number; }
type TLDrag = { kind: 'playhead' } | { kind: 'pan' } | ItemDrag;

/** Per-kind lane colors (bar fill + marker fill). */
const COLORS: Record<TrackDef['type'], string> = {
  animation: '#3f6fb0',
  activation: '#4d8a5b',
  signal: '#b08b3f',
  audio: '#8a4d8a',
  control: '#b0553f',
};

/** The visible end of an animation clip block: its own duration, else up to the next block's
 *  start, else a 1s default so a zero-length authored block is still grabbable. */
function animClipEnd(clips: { start: number; duration?: number }[], i: number): number {
  const c = clips[i];
  if (c.duration !== undefined && c.duration > 0) return c.start + c.duration;
  const next = clips[i + 1];
  return next ? next.start : c.start + 1;
}

function ClipTrackView({
  doc, viewport, onViewport, onScrub, onMoveItem, selectedTrack, onSelectTrack, selectedItem, onSelectItem, onAddItemAt, onDeleteItem,
}: {
  doc: TimelineDef;
  viewport: Viewport;
  onViewport: (vp: Viewport) => void;
  onScrub: (t: number) => void;
  /** Commit a retimed item. The panel interprets `newTime` by track type. */
  onMoveItem: (trackIdx: number, itemIdx: number, newTime: number) => void;
  selectedTrack: number | null;
  onSelectTrack: (i: number) => void;
  /** Item index within the selected track (null = whole-track / none selected). */
  selectedItem: number | null;
  onSelectItem: (trackIdx: number, itemIdx: number) => void;
  /** Double-click an empty lane → add an item at that time (Animation-editor convention). */
  onAddItemAt: (trackIdx: number, time: number) => void;
  /** Double-click an item → delete it (Animation-editor convention). */
  onDeleteItem: (trackIdx: number, itemIdx: number) => void;
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

  const duration = Math.max(0.001, doc.duration);
  const frameRate = doc.frameRate || 30;
  const { view, onPan, beginPan } = useTimelineViewport({ ref, viewport, onViewport, width, duration });
  const totalH = RULER_H + doc.tracks.length * ROW_H;

  const onCustomDrag = useCallback((d: TLDrag, pt: { x: number; y: number }) => {
    if (d.kind !== 'item') return;
    const t = snapToFrame(Math.max(0, xToTime(pt.x, view) - d.grab), frameRate);
    onMoveItem(d.trackIdx, d.itemIdx, Math.min(duration, t));
  }, [view, frameRate, duration, onMoveItem]);

  const { startDrag } = useTimelineDrag<TLDrag>({
    ref, view, duration, frameRate,
    onScrub,
    onDragSelectedKeys: () => {}, onEndKeyDrag: () => {},
    keysInBox: () => [], onMarqueeSelect: () => {},
    onPan, onCustomDrag,
  });

  /** Begin retiming an item: capture the grab offset so the bar/diamond tracks the cursor. */
  const grabItem = useCallback((e: React.PointerEvent, trackIdx: number, itemIdx: number, origTime: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelectItem(trackIdx, itemIdx);
    const r = ref.current?.getBoundingClientRect();
    const localX = e.clientX - (r?.left ?? 0);
    const grab = xToTime(localX, view) - origTime;
    startDrag({ kind: 'item', trackIdx, itemIdx, grab, orig: origTime }, e.clientX, e.clientY);
  }, [view, startDrag, onSelectItem]);

  /** Is the given track/item the selected one? */
  const isSelItem = (ti: number, ii: number) => selectedTrack === ti && selectedItem === ii;

  /** Double-click an empty lane → add an item at the (frame-snapped, clamped) clicked time. */
  const dblAddAt = useCallback((e: React.MouseEvent, ti: number) => {
    const r = ref.current?.getBoundingClientRect();
    const localX = e.clientX - (r?.left ?? 0);
    const t = Math.min(duration, Math.max(0, snapToFrame(xToTime(localX, view), frameRate)));
    onAddItemAt(ti, t);
  }, [view, frameRate, duration, onAddItemAt]);

  /** Double-click an item → delete it (stops the lane's add-on-dblclick). */
  const dblDelete = (e: React.MouseEvent, ti: number, ii: number) => { e.stopPropagation(); onDeleteItem(ti, ii); };

  const diamond = (cx: number, cy: number, r = 5) => `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', background: '#1b1b1f' }}>
      <svg width={width} height={totalH} style={{ display: 'block', userSelect: 'none' }}>
        {/* Full-height bg — empty-space right-drag pans. */}
        <rect x={0} y={0} width={width} height={totalH} fill="transparent"
          onPointerDown={(e) => { if (e.button === 2) beginPan(startDrag, e); }}
          onContextMenu={(e) => e.preventDefault()} />

        {/* Ruler */}
        <rect x={0} y={0} width={width} height={RULER_H} fill="#232329" />
        {rulerTicks(duration, view.pxPerSec, 64, view.viewStart ?? 0, (view.viewStart ?? 0) + (width - TRACK_PAD_LEFT * 2) / view.pxPerSec).map((t) => {
          const x = timeToX(t, view);
          return (
            <g key={t}>
              <line x1={x} y1={RULER_H - 5} x2={x} y2={totalH} stroke="#2f2f37" strokeWidth={1} />
              <text x={x + 3} y={RULER_H - 8} fill="#8a8a96" fontSize={9}>{t}s</text>
            </g>
          );
        })}
        {/* Ruler hit area — scrub / right-drag pan. */}
        <rect data-ui-id="timeline.ruler" x={0} y={0} width={width} height={RULER_H} fill="transparent"
          onPointerDown={(e) => { if (e.button === 2) beginPan(startDrag, e); else startDrag({ kind: 'playhead' }, e.clientX, e.clientY); }}
          onContextMenu={(e) => e.preventDefault()} />

        {/* Track lanes */}
        {doc.tracks.map((track, ti) => {
          const y = RULER_H + ti * ROW_H;
          const cy = y + ROW_H / 2;
          const col = COLORS[track.type];
          const selected = selectedTrack === ti;
          return (
            <g key={track.id || ti}>
              <rect x={0} y={y} width={width} height={ROW_H} fill={ti % 2 ? '#202024' : '#1d1d21'}
                stroke={selected ? '#5b7fc0' : 'none'} strokeWidth={selected ? 1 : 0}
                onPointerDown={(e) => { if (e.button === 2) beginPan(startDrag, e); else onSelectTrack(ti); }}
                onDoubleClick={(e) => dblAddAt(e, ti)}
                onContextMenu={(e) => e.preventDefault()} />

              {track.type === 'animation' && track.clips.map((c, ci) => {
                const x0 = timeToX(c.start, view);
                const x1 = timeToX(animClipEnd(track.clips, ci), view);
                return (
                  <g key={ci} onPointerDown={(e) => grabItem(e, ti, ci, c.start)} onDoubleClick={(e) => dblDelete(e, ti, ci)} style={{ cursor: 'ew-resize' }}>
                    <rect x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={ROW_H - 6} rx={2} fill={col} opacity={isSelItem(ti, ci) ? 1 : 0.85}
                      stroke={isSelItem(ti, ci) ? '#fff' : 'none'} strokeWidth={isSelItem(ti, ci) ? 1.5 : 0} />
                    <text x={x0 + 4} y={cy + 3} fill="#dfe6f2" fontSize={9} pointerEvents="none">{c.clip}</text>
                  </g>
                );
              })}

              {track.type === 'activation' && track.spans.map((s, si) => {
                const x0 = timeToX(s.start, view);
                const x1 = timeToX(s.end, view);
                return (
                  <rect key={si} x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={ROW_H - 6} rx={2} fill={col} opacity={isSelItem(ti, si) ? 1 : 0.85}
                    stroke={isSelItem(ti, si) ? '#fff' : 'none'} strokeWidth={isSelItem(ti, si) ? 1.5 : 0}
                    onPointerDown={(e) => grabItem(e, ti, si, s.start)} onDoubleClick={(e) => dblDelete(e, ti, si)} style={{ cursor: 'ew-resize' }} />
                );
              })}

              {track.type === 'signal' && track.markers.map((m, mi) => (
                <path key={mi} d={diamond(timeToX(m.t, view), cy, isSelItem(ti, mi) ? 6.5 : 5)} fill={col}
                  stroke={isSelItem(ti, mi) ? '#fff' : '#e8d9b0'} strokeWidth={isSelItem(ti, mi) ? 1.75 : 0.75}
                  onPointerDown={(e) => grabItem(e, ti, mi, m.t)} onDoubleClick={(e) => dblDelete(e, ti, mi)} style={{ cursor: 'ew-resize' }} />
              ))}

              {track.type === 'audio' && track.cues.map((c, qi) => (
                <path key={qi} d={diamond(timeToX(c.t, view), cy, isSelItem(ti, qi) ? 6.5 : 5)} fill={col}
                  stroke={isSelItem(ti, qi) ? '#fff' : '#e0b0e0'} strokeWidth={isSelItem(ti, qi) ? 1.75 : 0.75}
                  onPointerDown={(e) => grabItem(e, ti, qi, c.t)} onDoubleClick={(e) => dblDelete(e, ti, qi)} style={{ cursor: 'ew-resize' }} />
              ))}

              {track.type === 'control' && track.clips.map((c, ci) => {
                const x0 = timeToX(c.start, view);
                const x1 = timeToX(c.duration !== undefined ? c.start + c.duration : c.start + 1, view);
                return (
                  <g key={ci} onPointerDown={(e) => grabItem(e, ti, ci, c.start)} onDoubleClick={(e) => dblDelete(e, ti, ci)} style={{ cursor: 'ew-resize' }}>
                    <rect x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={ROW_H - 6} rx={2} fill={col} opacity={isSelItem(ti, ci) ? 1 : 0.85}
                      stroke={isSelItem(ti, ci) ? '#fff' : 'none'} strokeWidth={isSelItem(ti, ci) ? 1.5 : 0} />
                    <text x={x0 + 4} y={cy + 3} fill="#f2ddd6" fontSize={9} pointerEvents="none">{c.subdirector ? '▷ sub' : c.particle ? '✦ particle' : '⧉ prefab'}</text>
                  </g>
                );
              })}
            </g>
          );
        })}

        <TimelinePlayhead view={view} diamond />
      </svg>
    </div>
  );
}

export default memo(ClipTrackView);
