/** Curves view — value graph with editable bezier tangent handles.
 *  Renders one polyline per numeric track (sampled from evalTrack so it matches
 *  playback exactly), draggable keyframe dots (time clamped between neighbors,
 *  value free), and draggable in/out tangent handles (unified unless the key is
 *  "broken"). Right-click a key for tangent presets. Value axis auto-fits. */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ContextMenu, { type ContextMenuItem } from '../../components/ContextMenu';
import TimelinePlayhead from './TimelinePlayhead';
import { registerHandleProvider, type InteractionHandle } from '../../../runtime/rendering/interactionHandles';
import { evalTrack } from '../../../runtime/animation/curveEval';
import { type AnimationTrack, type Keyframe } from '../../../runtime/animation/types';
import type { TangentMode } from '../../../runtime/animation/curveEval';
import {
  RULER_H, TRACK_PAD_LEFT,
  timeToX, xToTime, snapToFrame, clampKeyTime, rulerTicks, visibleSpan, type Viewport, type TimelineView,
} from './timelineMath';
import { useTimelineDrag, type LocalPoint, type MarqueeBox } from './useTimelineDrag';
import { useTimelineViewport } from './useTimelineViewport';
import { deriveTangentFromHandle, handleDataPt, segDtFor } from './tangentMath';
import { keysInBox as keysInBoxGeom } from './marqueeGeom';

const TRACK_COLORS = ['#e0b341', '#4fd1c5', '#f06595', '#74b9ff', '#a29bfe', '#55efc4'];
const PAD_Y = 18;

interface Drag { kind: 'key' | 'in' | 'out' | 'playhead' | 'keys' | 'marquee' | 'pan'; ti?: number; ki?: number; additive?: boolean; x0?: number; y0?: number; }

function CurvesView({
  tracks, duration, frameRate, selectedTrack, selectedTracks, selectedKeys, viewport, onViewport,
  onScrub, onEditKey, onDeleteKey, onAddKey, onSetTangentMode,
  onKeyMouseDown, onDragSelectedKeys, onEndKeyDrag, onMarqueeSelect,
}: {
  tracks: AnimationTrack[];
  duration: number;
  frameRate: number;
  selectedTrack: number | null;
  /** Multi-track selection — when it contains numeric tracks, exactly those curves show. */
  selectedTracks: Set<number>;
  selectedKeys: Set<string>;
  /** Shared horizontal zoom/pan viewport. */
  viewport: Viewport;
  onViewport: (vp: Viewport) => void;
  onScrub: (t: number) => void;
  onEditKey: (ti: number, ki: number, patch: Partial<Keyframe>) => void;
  onDeleteKey: (ti: number, ki: number) => void;
  onAddKey: (ti: number, t: number, value: number) => void;
  onSetTangentMode: (ti: number, ki: number, mode: TangentMode) => void;
  /** Pointer-down on a key: updates selection, returns true if >1 key selected. */
  onKeyMouseDown: (ti: number, ki: number, additive: boolean) => boolean;
  onDragSelectedKeys: (targetTime: number) => void;
  onEndKeyDrag: () => void;
  onMarqueeSelect: (ids: string[], additive: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 600, h: 220 });
  const [menu, setMenu] = useState<{ x: number; y: number; ti: number; ki: number } | null>(null);
  // Manual value(Y)-axis range — null = auto-fit to visible keys. Set by Ctrl/Cmd+wheel
  // (zoom) and right-drag (pan). Cleared back to auto when the visible track set changes.
  const [valueView, setValueView] = useState<{ min: number; max: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Which tracks to draw: numeric only. If the multi-selection contains numeric
  // tracks, show exactly those (true multi-curve view). Else focus the single
  // selected numeric track, else overlay every numeric track.
  const numericIdx = useMemo(() => tracks.map((t, i) => ({ t, i })).filter((x) => x.t.type === 'number').map((x) => x.i), [tracks]);
  const selectedNumeric = useMemo(() => numericIdx.filter((i) => selectedTracks.has(i)), [numericIdx, selectedTracks]);
  // Memoized so the single-track branch (`[selectedTrack]` — the common key-editing
  // gesture) has a STABLE identity across renders. Otherwise a fresh array every render
  // defeats the curvePaths/fitRange/keysInBox memos and re-subscribes the window pointer
  // listeners (keysInBox is in useTimelineDrag's deps) on every 60fps preview frame. (B1)
  const visible = useMemo(() => (
    selectedNumeric.length > 0
      ? selectedNumeric
      : (selectedTrack != null && numericIdx.includes(selectedTrack) ? [selectedTrack] : numericIdx)
  ), [selectedNumeric, selectedTrack, numericIdx]);
  // The "active" track (draws tangent handles + receives double-click-add) is the
  // primary selection when it's one of the visible curves, else the sole visible one.
  const activeTi = selectedTrack != null && visible.includes(selectedTrack) ? selectedTrack : (visible.length === 1 ? visible[0] : null);

  // Reset the manual value range to auto-fit whenever the visible set changes.
  const visibleKey = visible.join(',');
  useEffect(() => { setValueView(null); }, [visibleKey]);

  // Auto-fit value range across visible keys.
  const fitRange = useMemo<[number, number]>(() => {
    let lo = Infinity, hi = -Infinity;
    for (const ti of visible) for (const k of tracks[ti].keys) { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }, [tracks, visible]);

  // F6: freeze the value-axis for the duration of a key/tangent drag. A free key edit
  // commits a new clip every pointer-move → `fitRange` re-fits → `valueToY` identity
  // churns → `curvePaths` re-tessellates EVERY visible track each frame. Snapshotting the
  // range on drag-start (and restoring auto-fit on drag-end) keeps `valueToY` stable
  // across the drag, so only the per-move clip change drives re-render, not an axis re-fit.
  const [frozenRange, setFrozenRange] = useState<[number, number] | null>(null);
  // Precedence: a drag freeze wins, then the user's manual Y range, then auto-fit.
  const [vMin, vMax] = frozenRange ?? (valueView ? [valueView.min, valueView.max] : fitRange);

  // Value(Y)-axis geometry (independent of the horizontal viewport).
  const areaTop = RULER_H + PAD_Y;
  const areaH = Math.max(10, size.h - RULER_H - PAD_Y * 2);
  // Guard the denominator so a collapsed value range (A5) can't produce NaN/Infinity Y.
  const vSpan = Math.max(vMax - vMin, 1e-9);
  const valueToY = useCallback((v: number) => areaTop + (vMax - v) / vSpan * areaH, [areaTop, areaH, vMax, vSpan]);
  const yToValue = useCallback((y: number) => vMax - (y - areaTop) / areaH * vSpan, [areaTop, areaH, vMax, vSpan]);

  // Latest Y-axis state via refs so the shared viewport hook's Ctrl/Cmd-wheel zoom and
  // right-drag Y pan can read current geometry without re-subscribing.
  const rangeRef = useRef<[number, number]>([vMin, vMax]); rangeRef.current = [vMin, vMax];
  const fitSpanRef = useRef(1); fitSpanRef.current = Math.max(fitRange[1] - fitRange[0], 1e-9); // bounds value zoom-in (A5)
  const areaRef = useRef({ areaTop, areaH }); areaRef.current = { areaTop, areaH };
  const panBaseY = useRef<[number, number]>([vMin, vMax]);

  // Ctrl/Cmd+wheel → value(Y)-axis zoom about the cursor value, min-span clamped (A5).
  const onWheelModified = useCallback((e: WheelEvent, r: DOMRect) => {
    const [mn, mx] = rangeRef.current;
    const { areaTop: at, areaH: ah } = areaRef.current;
    const cursorV = mx - (e.clientY - r.top - at) / ah * (mx - mn);
    const f = e.deltaY < 0 ? 1 / 1.1 : 1.1; // scroll up → zoom in (shrink range)
    let nMin = cursorV - (cursorV - mn) * f;
    let nMax = cursorV + (mx - cursorV) * f;
    const minSpan = fitSpanRef.current * 1e-3;
    if (nMax - nMin < minSpan) { const c = (nMin + nMax) / 2; nMin = c - minSpan / 2; nMax = c + minSpan / 2; }
    setValueView({ min: nMin, max: nMax });
    return true;
  }, []);
  // Right-drag Y pan (paired with the shared X pan by the hook).
  const onPanY = useCallback((dyPx: number) => {
    const [bMin, bMax] = panBaseY.current;
    const dv = dyPx * (bMax - bMin) / areaRef.current.areaH; // drag down → view moves down
    setValueView({ min: bMin + dv, max: bMax + dv });
  }, []);

  const { view, onPan, beginPan: beginPanCore } = useTimelineViewport({
    ref, viewport, onViewport, width: size.w, duration, onWheelModified, onPanY,
  });

  // Phantom segment length for endpoint keys (needs the resolved view). A fraction of the
  // VISIBLE time span so the handle stays on-screen even when pxPerSec is floored at 1.
  const phantomSeg = useMemo(
    () => Math.min(duration, (size.w - TRACK_PAD_LEFT * 2) / view.pxPerSec) * 0.2,
    [duration, size.w, view],
  );

  // ── Drag handling ──
  // Dots inside a marquee box (local px) across visible tracks — shared geometry,
  // value-space center (vs the Dopesheet's row-band center).
  const keysInBox = useCallback((b: MarqueeBox): string[] =>
    keysInBoxGeom(tracks, visible, b, (ti, ki) => {
      const k = tracks[ti].keys[ki];
      return { cx: timeToX(k.t, view), cy: valueToY(k.v) };
    }),
  [tracks, visible, view, valueToY]);

  // View-specific drag kinds Curves adds on top of the shared playhead/keys/marquee:
  // dragging an individual key dot (free time+value) and the in/out tangent handles.
  const onCustomDrag = useCallback((d: Drag, { x, y }: LocalPoint) => {
    if (d.ti === undefined || d.ki === undefined) return;
    const track = tracks[d.ti];
    const k = track.keys[d.ki];
    if (d.kind === 'key') {
      const t = clampKeyTime(track.keys, d.ki, snapToFrame(xToTime(x, view), frameRate), duration);
      onEditKey(d.ti, d.ki, { t, v: yToValue(y) });
      return;
    }
    // Tangent handle: derive slope (+weight) from the handle vector in data space.
    if (d.kind !== 'in' && d.kind !== 'out') return;
    const side = d.kind;
    const dataT = xToTime(x, view);
    const dataV = yToValue(y);
    const segDt = segDtFor(track.keys, d.ki, side, phantomSeg);
    onEditKey(d.ti, d.ki, deriveTangentFromHandle(k, side, dataT, dataV, segDt, !k.broken));
  }, [view, duration, phantomSeg, frameRate, tracks, onEditKey, yToValue]);

  const { marquee, startDrag: beginDrag, local } = useTimelineDrag<Drag>({
    ref, view, duration, frameRate,
    onScrub, onDragSelectedKeys, onEndKeyDrag,
    keysInBox, onMarqueeSelect, onPan, onCustomDrag,
    // Restore auto-fit once the value-mutating drag ends.
    onCustomEnd: () => setFrozenRange(null),
  });
  const startDrag = (d: Drag, e: React.PointerEvent) => {
    e.stopPropagation();
    // Freeze the value-axis for kinds that move a key's value (key dot + tangent handles),
    // so the graph doesn't re-fit + re-tessellate on every pointer-move (F6).
    if (d.kind === 'key' || d.kind === 'in' || d.kind === 'out') setFrozenRange(valueView ? [valueView.min, valueView.max] : fitRange);
    beginDrag(d, e.clientX, e.clientY);
  };
  // Right-drag pan: the hook snapshots the X left-edge; we snapshot the Y range.
  const beginPan = (e: React.PointerEvent) => {
    e.stopPropagation();
    beginPanCore(beginDrag, e, () => { panBaseY.current = rangeRef.current; });
  };

  // Sample each visible track into an SVG path string. Memoized so playhead-only
  // and other unrelated re-renders don't re-sample every curve; recomputes when
  // the keys, view, size, or value-axis change (which is exactly when it must).
  const curvePaths = useMemo(() => {
    const m = new Map<number, string>();
    const step = Math.max(1, Math.floor((size.w - TRACK_PAD_LEFT * 2) / 240)); // ~px between samples
    for (const ti of visible) {
      const track = tracks[ti];
      if (track.keys.length === 0) { m.set(ti, ''); continue; }
      let d = '';
      for (let px = TRACK_PAD_LEFT; px <= size.w - TRACK_PAD_LEFT; px += step) {
        const t = xToTime(px, view);
        const v = evalTrack(track.keys, t);
        d += `${d ? 'L' : 'M'} ${px.toFixed(1)} ${valueToY(v).toFixed(1)} `;
      }
      m.set(ti, d);
    }
    return m;
  }, [visible, tracks, view, size.w, valueToY]);

  // Tangent handle endpoint (screen) for in/out of a key.
  const handlePt = (track: AnimationTrack, ki: number, side: 'in' | 'out') => {
    const p = handleDataPt(track.keys[ki], side, segDtFor(track.keys, ki, side, phantomSeg));
    return { x: timeToX(p.t, view), y: valueToY(p.v) };
  };

  // ── Enact Phase 2: keyframe + tangent-handle handles ── expose each visible key
  //    dot and the active track's in/out tangent handles as viewport-CSS-px points,
  //    reproducing the exact on-screen guards (only `visible` tracks; tangents only
  //    for `activeTi`, hidden where the render hides them). Live state via a ref.
  const curveHandleRef = useRef<{
    tracks: AnimationTrack[]; view: TimelineView; visible: number[]; activeTi: number | null;
    valueToY: (v: number) => number; phantomSeg: number;
  }>({ tracks, view, visible, activeTi, valueToY, phantomSeg });
  curveHandleRef.current = { tracks, view, visible, activeTi, valueToY, phantomSeg };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const el = ref.current;
      if (!el) return [];
      const s = curveHandleRef.current;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const out: InteractionHandle[] = [];
      const tanPt = (track: AnimationTrack, ki: number, side: 'in' | 'out') => {
        const k = track.keys[ki];
        const segDt = side === 'out'
          ? (track.keys[ki + 1]?.t ?? k.t + s.phantomSeg) - k.t
          : k.t - (track.keys[ki - 1]?.t ?? k.t - s.phantomSeg);
        const p = handleDataPt(k, side, segDt);
        return { x: timeToX(p.t, s.view), y: s.valueToY(p.v) };
      };
      for (const ti of s.visible) {
        const track = s.tracks[ti];
        const trackKey = `${track.path}|${track.trait}.${track.field}`;
        track.keys.forEach((k, ki) => {
          out.push({
            id: `curves:key:${trackKey}:${ki}`, kind: 'keyframe', editor: 'curves',
            x: rect.left + timeToX(k.t, s.view), y: rect.top + s.valueToY(k.v),
            label: `${track.trait}.${track.field} t=${k.t.toFixed(3)} v=${k.v}`,
            meta: { trackIndex: ti, keyIndex: ki, time: k.t, value: k.v, path: track.path },
          });
          // Tangent handles: only for the active track, mirroring the render guards.
          if (ti !== s.activeTi) return;
          const stepped = !Number.isFinite(k.outTangent);
          const prevStepped = ki > 0 && !Number.isFinite(track.keys[ki - 1].outTangent);
          if (ki > 0 && Number.isFinite(k.inTangent) && !prevStepped) {
            const p = tanPt(track, ki, 'in');
            out.push({ id: `curves:tan:in:${trackKey}:${ki}`, kind: 'tangent', editor: 'curves', x: rect.left + p.x, y: rect.top + p.y, label: `in-tangent ${track.field} k${ki}`, meta: { trackIndex: ti, keyIndex: ki, side: 'in', path: track.path } });
          }
          if (ki < track.keys.length - 1 && !stepped) {
            const p = tanPt(track, ki, 'out');
            out.push({ id: `curves:tan:out:${trackKey}:${ki}`, kind: 'tangent', editor: 'curves', x: rect.left + p.x, y: rect.top + p.y, label: `out-tangent ${track.field} k${ki}`, meta: { trackIndex: ti, keyIndex: ki, side: 'out', path: track.path } });
          }
        });
      }
      return out;
    });
    return unreg;
  }, []);

  const menuItems: ContextMenuItem[] = menu ? [
    { label: 'Auto (smooth)', onClick: () => onSetTangentMode(menu.ti, menu.ki, 'auto') },
    { label: 'Linear', onClick: () => onSetTangentMode(menu.ti, menu.ki, 'linear') },
    { label: 'Constant (stepped)', onClick: () => onSetTangentMode(menu.ti, menu.ki, 'constant') },
    { label: 'Free (broken)', onClick: () => onSetTangentMode(menu.ti, menu.ki, 'free') },
    { label: '—', separator: true },
    { label: 'Delete key', danger: true, onClick: () => onDeleteKey(menu.ti, menu.ki) },
  ] : [];

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden', background: '#12121a' }}
      onContextMenu={(e) => e.preventDefault()}>
      <svg width="100%" height="100%" style={{ display: 'block' }}
        onDoubleClick={(e) => {
          if (activeTi == null) return;
          const { x, y } = local(e.clientX, e.clientY);
          const t = Math.max(0, Math.min(duration, snapToFrame(xToTime(x, view), frameRate)));
          onAddKey(activeTi, t, yToValue(y));
        }}
      >
        {/* Marquee hit area (below the ruler) — drag empty space to box-select dots;
            right-drag pans (X + Y). */}
        <rect x={0} y={RULER_H} width="100%" height="100%" fill="transparent" style={{ cursor: 'crosshair' }}
          onPointerDown={(e) => { if (e.button === 2) { beginPan(e); return; } const p = local(e.clientX, e.clientY); startDrag({ kind: 'marquee', additive: e.shiftKey || e.metaKey, x0: p.x, y0: p.y }, e); }} />

        {/* Ruler (right-drag pans) */}
        <rect x={0} y={0} width="100%" height={RULER_H} fill="#1d1d2b" />
        <rect x={0} y={0} width="100%" height={RULER_H} fill="transparent" style={{ cursor: 'ew-resize' }}
          onPointerDown={(e) => { if (e.button === 2) { beginPan(e); return; } startDrag({ kind: 'playhead' }, e); }} />
        {rulerTicks(duration, view.pxPerSec, 64, view.viewStart, (view.viewStart ?? 0) + visibleSpan(view.pxPerSec, size.w)).map((t) => {
          const x = timeToX(t, view);
          return <g key={t}><line x1={x} y1={RULER_H} x2={x} y2="100%" stroke="#20202c" /><text x={x + 3} y={14} fill="#667" fontSize={10} fontFamily="monospace">{t}s</text></g>;
        })}

        {/* Value gridlines (min / mid / max) */}
        {[vMax, (vMax + vMin) / 2, vMin].map((v, i) => (
          <g key={i}>
            <line x1={0} y1={valueToY(v)} x2="100%" y2={valueToY(v)} stroke="#1c1c28" />
            <text x={3} y={valueToY(v) - 2} fill="#556" fontSize={9} fontFamily="monospace">{v.toFixed(2)}</text>
          </g>
        ))}

        {/* Curves */}
        {visible.map((ti) => {
          const color = TRACK_COLORS[ti % TRACK_COLORS.length];
          const dim = activeTi != null && ti !== activeTi;
          return <path key={ti} d={curvePaths.get(ti) ?? ''} fill="none" stroke={color} strokeWidth={dim ? 1 : 1.75} opacity={dim ? 0.4 : 1} />;
        })}

        {/* Keyframe dots + tangent handles (handles only for the active track) */}
        {visible.map((ti) => {
          const color = TRACK_COLORS[ti % TRACK_COLORS.length];
          const showHandles = ti === activeTi;
          return (
            <g key={`dots-${ti}`}>
              {tracks[ti].keys.map((k, ki) => {
                const cx = timeToX(k.t, view);
                const cy = valueToY(k.v);
                const stepped = !Number.isFinite(k.outTangent);
                // Handle endpoints only matter for the active track's drawn handles.
                // In-handle: a key's in-tangent only shapes the segment to its LEFT, so
                // hide it when that segment can't reflect it — either this key's
                // in-tangent is non-finite (stepped/constant), or the PREVIOUS key's
                // out-tangent is stepped (the left segment is held constant regardless).
                // Otherwise the handle renders draggable but has no visible curve effect.
                const prevStepped = ki > 0 && !Number.isFinite(tracks[ti].keys[ki - 1].outTangent);
                const inP = showHandles && ki > 0 && Number.isFinite(k.inTangent) && !prevStepped
                  ? handlePt(tracks[ti], ki, 'in') : null;
                const outP = showHandles && ki < tracks[ti].keys.length - 1 && !stepped ? handlePt(tracks[ti], ki, 'out') : null;
                return (
                  <g key={ki}>
                    {inP && (
                      <g>
                        <line x1={cx} y1={cy} x2={inP.x} y2={inP.y} stroke="#7aa2f7" strokeWidth={1} />
                        <rect x={inP.x - 3} y={inP.y - 3} width={6} height={6} fill="#7aa2f7" style={{ cursor: 'move' }} onPointerDown={(e) => { if (e.button !== 0) return; startDrag({ kind: 'in', ti, ki }, e); }} />
                      </g>
                    )}
                    {outP && (
                      <g>
                        <line x1={cx} y1={cy} x2={outP.x} y2={outP.y} stroke="#7aa2f7" strokeWidth={1} />
                        <rect x={outP.x - 3} y={outP.y - 3} width={6} height={6} fill="#7aa2f7" style={{ cursor: 'move' }} onPointerDown={(e) => { if (e.button !== 0) return; startDrag({ kind: 'out', ti, ki }, e); }} />
                      </g>
                    )}
                    {/* Broken keys get a distinct outer diamond so the mode is visible at a glance. */}
                    {k.broken && (
                      <path d={`M ${cx} ${cy - 7} L ${cx + 7} ${cy} L ${cx} ${cy + 7} L ${cx - 7} ${cy} Z`} fill="none" stroke={color} strokeWidth={1} opacity={0.8} pointerEvents="none" />
                    )}
                    <circle
                      cx={cx} cy={cy} r={selectedKeys.has(`${ti}:${ki}`) ? 5.5 : 4} fill={color}
                      stroke={selectedKeys.has(`${ti}:${ki}`) ? '#fff' : '#0a0a12'}
                      strokeWidth={selectedKeys.has(`${ti}:${ki}`) ? 2 : 1}
                      style={{ cursor: 'move' }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return; // right-click → tangent menu (below); pan handled on background
                        // Multi-select drags the group in time; a single selection
                        // keeps the existing free time+value edit.
                        const group = onKeyMouseDown(ti, ki, e.shiftKey || e.metaKey);
                        startDrag(group ? { kind: 'keys' } : { kind: 'key', ti, ki }, e);
                      }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, ti, ki }); }}
                      onDoubleClick={(e) => { e.stopPropagation(); onDeleteKey(ti, ki); }}
                    />
                  </g>
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

        {/* Playhead — self-subscribing leaf (re-renders 60fps without the body). */}
        <TimelinePlayhead view={view} />
      </svg>

      {numericIdx.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, top: RULER_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#556', pointerEvents: 'none' }}>
          No numeric tracks to graph. (Color/boolean tracks show in the Dopesheet.)
        </div>
      )}

      {menu && <ContextMenu items={menuItems} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

export default memo(CurvesView);
